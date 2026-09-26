// api/scan.js
// Multi-chain memecoin screener — 100% data dari GMGN OpenAPI resmi
// (https://docs.gmgn.ai/index/gmgn-agent-api), auth mode "Exist" (X-APIKEY +
// timestamp + client_id, tanpa private key — cukup untuk semua endpoint read-only
// yang dipakai di sini).
//
// Alur:
// 1. POST /v1/trenches -> kandidat token baru (new_creation / near_completion) per chain,
//    dengan server-side filter preset "strict" (rug_ratio, bundler_rate, insider_ratio,
//    smart_degen_count, min volume) - ini yang paling dekat dengan filosofi framework:
//    "jangan lihat chart dulu, cek siapa yang beli & seberapa bersih on-chain-nya".
// 2. Untuk kandidat teratas, GET /v1/token/security -> data resmi top10 holder, honeypot,
//    lock LP, tax (dipetakan sesuai docs, lihat komentar di scoreToken()).
// 3. Scoring 0-100 dari kombinasi data trenches + security.
//
// GMGN_API_KEY diambil dari environment variable di Vercel (Settings -> Environment
// Variables), JANGAN taruh langsung di kode ini.

const crypto = require("crypto");

const GMGN_HOST = "https://openapi.gmgn.ai";

// Sama seperti signer.ts resmi: exist-auth cukup timestamp (unix seconds) + client_id (uuid)
function buildAuthQuery() {
  return {
    timestamp: Math.floor(Date.now() / 1000),
    client_id: crypto.randomUUID(),
  };
}

function buildUrl(path, query) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) v.forEach((item) => params.append(k, item));
    else params.set(k, String(v));
  }
  return `${GMGN_HOST}${path}?${params.toString()}`;
}

async function gmgnGet(path, query, apiKey) {
  const { timestamp, client_id } = buildAuthQuery();
  const url = buildUrl(path, { ...query, timestamp, client_id });
  const res = await fetch(url, {
    headers: { "X-APIKEY": apiKey, "Content-Type": "application/json" },
  });
  const json = await res.json().catch(() => null);
  if (!json || json.code !== 0) {
    return { error: json?.message || json?.error || `HTTP ${res.status}`, data: null };
  }
  return { error: null, data: json.data };
}

async function gmgnPost(path, query, body, apiKey) {
  const { timestamp, client_id } = buildAuthQuery();
  const url = buildUrl(path, { ...query, timestamp, client_id });
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-APIKEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!json || json.code !== 0) {
    return { error: json?.message || json?.error || `HTTP ${res.status}`, data: null };
  }
  return { error: null, data: json.data };
}

// quote_address_type per chain, disalin dari CLI resmi (bagian dari body /v1/trenches)
const TRENCHES_QUOTE_ADDRESS_TYPES = {
  sol: [4, 5, 3, 1, 13, 0],
  bsc: [6, 7, 1, 16, 8, 3, 9, 10, 2, 17, 18, 0],
  base: [11, 3, 12, 13, 0],
  eth: [20, 11, 8, 3, 12, 1, 0],
  robinhood: [11, 20, 24, 12, 0],
};

// ---------- 1. Kandidat token baru/near-completion per chain via /v1/trenches ----------
async function fetchTrenches(chain, apiKey, limit = 15) {
  const quoteTypes = TRENCHES_QUOTE_ADDRESS_TYPES[chain] || [];
  const section = {
    filters: ["offchain", "onchain"],
    launchpad_platform_v2: true,
    limit,
    // preset "strict" resmi dari gmgn-cli: rug_ratio & bundler & insider rendah,
    // ada minimal smart-money holder, ada volume minimal (bukan token mati total)
    max_rug_ratio: 0.3,
    max_bundler_rate: 0.3,
    max_insider_ratio: 0.3,
    min_volume_24h: 500,
  };
  if (quoteTypes.length) section.quote_address_type = quoteTypes;

  const body = {
    version: "v2",
    new_creation: { ...section },
    near_completion: { ...section },
  };

  const { data, error } = await gmgnPost("/v1/trenches", { chain }, body, apiKey);
  if (error || !data) return { tokens: [], error };

  // Response dikelompokkan per kategori (new_creation / near_completion), masing2 array token.
  // Kalau bentuknya beda dari dugaan ini, kode di bawah tetap coba fallback ke array datar.
  const tokens = [];
  if (Array.isArray(data)) {
    tokens.push(...data);
  } else {
    for (const key of ["new_creation", "near_completion"]) {
      const arr = data[key]?.list || data[key]?.tokens || data[key];
      if (Array.isArray(arr)) tokens.push(...arr.map((t) => ({ ...t, _category: key })));
    }
  }
  return { tokens: tokens.map((t) => ({ ...t, chain })), error: null };
}

// ---------- 2. Due diligence resmi via /v1/token/security utk kandidat teratas ----------
async function fetchTokenSecurity(chain, address, apiKey) {
  const { data, error } = await gmgnGet(
    "/v1/token/security",
    { chain, address },
    apiKey
  );
  if (error) return null;
  return data;
}

// ---------- 3. /v1/token/info — logo asli + wallet_tags_stat (bundler/fresh/smart/whale wallets) ----------
async function fetchTokenInfo(chain, address, apiKey) {
  const { data, error } = await gmgnGet("/v1/token/info", { chain, address }, apiKey);
  if (error) return null;
  return data;
}

function num(v, fallback = null) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}
function round1(n) {
  return typeof n === "number" && !isNaN(n) ? Math.round(n * 10) / 10 : n;
}

// ---------- Scoring 0-100, 4 kriteria x 25 poin, berbasis field resmi GMGN ----------
// Ambang batas mengikuti dokumentasi resmi gmgn-cli (skills/gmgn-token-buy/references/thresholds.md):
// top_10_holder_rate > 50% = warning, holder_count < 200 = warning,
// buy/sell tax > 10% = hard fail, honeypot = hard fail.
function scoreToken({ trench, security, tokenInfo }) {
  const breakdown = {};
  const flags = [];

  // 0) Identitas visual — logo asli dari GMGN (fallback: null -> frontend pakai monogram)
  const logo = tokenInfo?.logo || tokenInfo?.dev?.ath_token_info?.avatar || null;
  breakdown.logo = logo;

  // 1) Distribusi holder — dari /v1/trenches (top_holder_rate) & dikonfirmasi /v1/token/security (top_10_holder_rate)
  const topHolderRate =
    num(security?.top_10_holder_rate) ?? num(trench?.top_holder_rate);
  let holderScore = 12.5;
  if (topHolderRate !== null) {
    holderScore = Math.max(0, 25 * (1 - Math.min(topHolderRate, 1) / 0.5));
    if (topHolderRate > 0.5) flags.push(`Top10 holder ${(topHolderRate * 100).toFixed(1)}% (>50%)`);
  }
  breakdown.topHolderRate = topHolderRate;
  breakdown.holderScore = round1(holderScore);

  const holderCount = num(tokenInfo?.holder_count) ?? num(trench?.holder_count);
  if (holderCount !== null && holderCount < 200) {
    flags.push(`Holder cuma ${holderCount} (<200)`);
  }
  breakdown.holderCount = holderCount;

  // 1b) Wallet diversity — "50 pembeli sungguhan" vs "500 tx dari 10 wallet ter-bundle".
  // wallet_tags_stat memberi JUMLAH wallet (bukan persen) - dibagi holder_count sendiri.
  // fresh_wallet_rate & smart/whale wallets dari /v1/token/info (stat.*), bundler dari wallet_tags_stat.
  const bundlerWallets = num(tokenInfo?.wallet_tags_stat?.bundler_wallets);
  const freshWalletRate = num(tokenInfo?.stat?.fresh_wallet_rate);
  const smartWallets = num(tokenInfo?.wallet_tags_stat?.smart_wallets);
  const whaleWallets = num(tokenInfo?.wallet_tags_stat?.whale_wallets);
  const bundledWalletPct =
    bundlerWallets !== null && holderCount ? bundlerWallets / holderCount : null;
  breakdown.walletDiversity = {
    uniqueHolders: holderCount,
    bundledWallets: bundlerWallets,
    bundledWalletPct,
    freshWalletRate,
    smartWallets,
    whaleWallets,
  };
  if (bundledWalletPct !== null && bundledWalletPct > 0.05) {
    flags.push(`Bundler wallet ${bundlerWallets}/${holderCount} (${(bundledWalletPct * 100).toFixed(1)}%)`);
  }
  if (freshWalletRate !== null && freshWalletRate > 0.3) {
    flags.push(`Fresh wallet ${(freshWalletRate * 100).toFixed(1)}% (>30%)`);
  }

  // 2) Aktivitas beli/jual bersih & jumlah swap 24h — dari /v1/trenches
  const netBuy24h = num(trench?.net_buy_24h, 0);
  const swaps24h = num(trench?.swaps_24h, 0);
  const buys24h = num(trench?.buys_24h);
  const sells24h = num(trench?.sells_24h);
  let flowScore = 0;
  if (swaps24h > 0) {
    flowScore = Math.min(15, (swaps24h / 200) * 15); // 200+ swap/24h = full 15
  }
  if (netBuy24h > 0) flowScore += 10; // net buy positif = tekanan beli lebih besar dari jual
  flowScore = Math.min(25, flowScore);
  breakdown.netBuy24hUsd = round1(netBuy24h);
  breakdown.swaps24h = swaps24h;
  breakdown.buySellCount24h = buys24h !== null && sells24h !== null ? `${buys24h}/${sells24h}` : null;
  breakdown.flowScore = round1(flowScore);

  // 3) Sinyal smart money / momentum organik — dari /v1/trenches + smart/whale wallet count (token/info)
  const smartDegenCount = num(trench?.smart_degen_count, 0);
  const renownedCount = num(trench?.renowned_count, 0);
  let momentumScore = Math.min(
    25,
    smartDegenCount * 8 + renownedCount * 5 + (smartWallets ? Math.min(5, smartWallets) : 0)
  );
  breakdown.smartDegenCount = smartDegenCount;
  breakdown.renownedCount = renownedCount;
  breakdown.momentumScore = round1(momentumScore);

  // 4) Keamanan kontrak — rug_ratio/insider (trenches) + bundler wallet (token/info, fallback trenches) + honeypot/tax/lock (security)
  let safetyScore = 25;
  const rugRatio = num(trench?.rug_ratio);
  const effectiveBundlerRate = bundledWalletPct ?? num(trench?.bundler_rate);
  const insiderRate = num(trench?.insider_rate) ?? num(trench?.insider_ratio);
  if (rugRatio !== null) safetyScore -= rugRatio * 15;
  if (effectiveBundlerRate !== null && effectiveBundlerRate > 0.05) {
    safetyScore -= 5; // flag "Bundler wallet" sudah ditulis di atas, tidak dobel di sini
  }
  if (insiderRate !== null && insiderRate > 0.15) {
    safetyScore -= 5;
    flags.push(`Insider rate ${(insiderRate * 100).toFixed(1)}%`);
  }

  if (security) {
    const isHoneypot =
      security.is_honeypot === "1" || security.is_honeypot === 1 || security.honeypot === 1;
    const buyTax = num(security.buy_tax);
    const sellTax = num(security.sell_tax);
    if (isHoneypot) {
      safetyScore = 0;
      flags.push("HONEYPOT TERDETEKSI");
    } else {
      if ((buyTax !== null && buyTax > 0.1) || (sellTax !== null && sellTax > 0.1)) {
        safetyScore -= 10;
        flags.push(`Tax tinggi (buy ${((buyTax || 0) * 100).toFixed(1)}%, sell ${((sellTax || 0) * 100).toFixed(1)}%)`);
      }
      const lockPercent = num(security.lock_summary?.lock_percent ?? security.lock_percent);
      const hasBlackhole = security.lock_detail?.some((d) => d.is_blackhole);
      if (!hasBlackhole && lockPercent !== null && lockPercent < 0.5) {
        safetyScore -= 8;
        flags.push(`LP locked cuma ${(lockPercent * 100).toFixed(1)}%`);
      }
    }
  }
  safetyScore = Math.max(0, Math.min(25, safetyScore));
  breakdown.rugRatio = rugRatio;
  breakdown.bundlerRate = effectiveBundlerRate;
  breakdown.insiderRate = insiderRate;
  breakdown.safetyScore = round1(safetyScore);
  breakdown.flags = flags;

  const total = round1(holderScore + flowScore + momentumScore + safetyScore);
  return { total, breakdown };
}

const DEFAULT_CHAINS = ["sol", "bsc", "base", "eth"];
const SECURITY_LOOKUP_PER_CHAIN = 6; // batasi due-diligence lanjutan biar hemat kuota/rate limit

module.exports = async (req, res) => {
  try {
    const apiKey = req.headers["x-gmgn-key"] || process.env.GMGN_API_KEY;
    if (!apiKey) {
      return res.status(400).json({
        error: "GMGN_API_KEY belum di-set. Tambahkan di Vercel: Settings -> Environment Variables.",
      });
    }

    const minScore = parseFloat(req.query.minScore || "0");
    const chainParam = req.query.chain;
    const chains = chainParam ? [chainParam] : DEFAULT_CHAINS;

    const results = [];
    const warnings = [];

    for (const chain of chains) {
      const { tokens, error } = await fetchTrenches(chain, apiKey);
      if (error) {
        warnings.push(`${chain}: ${error}`);
        continue;
      }

      // urutkan awal by swaps_24h supaya due-diligence lanjutan (token/security)
      // difokuskan ke kandidat paling aktif dulu, bukan buang kuota ke token sepi
      tokens.sort((a, b) => (num(b?.swaps_24h, 0) - num(a?.swaps_24h, 0)));

      for (const trench of tokens.slice(0, SECURITY_LOOKUP_PER_CHAIN)) {
        const address = trench.address || trench.token_address;
        if (!address) continue;

        const security = await fetchTokenSecurity(chain, address, apiKey);
        const tokenInfo = await fetchTokenInfo(chain, address, apiKey);
        const { total, breakdown } = scoreToken({ trench, security, tokenInfo });
        if (total < minScore) continue;

        results.push({
          chain,
          tokenAddress: address,
          name: trench.name,
          symbol: trench.symbol,
          logo: breakdown.logo,
          marketcapUsd: num(trench.marketcap ?? trench.usd_market_cap),
          liquidityUsd: num(trench.liquidity),
          gmgnUrl: `https://gmgn.ai/${chain}/token/${address}`,
          score: total,
          breakdown,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    res.status(200).json({ count: results.length, tokens: results, warnings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
