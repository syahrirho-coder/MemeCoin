# Memecoin Scanner — Multi-chain On-Chain Screener (GMGN OpenAPI)

Screener token memecoin multi-chain (Solana, BSC, Base, Ethereum, dst) berbasis
data resmi **GMGN OpenAPI** (https://docs.gmgn.ai/index/gmgn-agent-api), auth mode
"Exist" (X-APIKEY + timestamp + client_id — cukup API key, tidak butuh private key
karena semua endpoint yang dipakai read-only).

## Alur kerja

1. **`POST /v1/trenches`** — ambil kandidat token baru listing / mendekati completion,
   per chain, dengan server-side filter preset "strict" ala `gmgn-cli`
   (`max_rug_ratio`, `max_bundler_rate`, `max_insider_ratio`, `min_volume_24h`).
2. **`GET /v1/token/security`** + **`GET /v1/token/info`** — due-diligence resmi untuk kandidat
   paling aktif (top 6 per chain by swap count) — top10 holder rate, honeypot, buy/sell tax, LP lock
   (dari `security`), plus logo asli, `wallet_tags_stat` (bundler/fresh/smart/whale wallet count),
   `holder_count` (dari `info`).
3. Scoring 0-100 dari kombinasi ketiga sumber (breakdown lengkap: holder concentration, wallet
   diversity — "berapa pembeli sungguhan vs berapa wallet ter-bundle" — net buy 24h, smart money/KOL
   count, safety/rug score).

Field & ambang batas mengikuti dokumentasi resmi paket `gmgn-skills` yang kamu upload
(`skills/gmgn-token-buy/references/fields.md` & `thresholds.md`), misalnya:
top10 holder > 50% = warning, holder < 200 = warning, buy/sell tax > 10% = fail keras,
honeypot = fail keras.

## Cara deploy ke Vercel

1. Push folder ini ke repo GitHub → import di Vercel (atau drag-drop di dashboard),
   tidak perlu build command.
2. **Wajib**: di Vercel → Project Settings → Environment Variables, tambahkan:
   - `GMGN_API_KEY` = API key GMGN kamu (jangan taruh langsung di kode/commit ke git)
3. Redeploy setelah env var ditambahkan.

## Catatan penting / yang perlu kamu verifikasi setelah deploy

- **Bentuk response `/v1/trenches` belum 100% aku pastikan** — aku susun dari source
  code CLI resmi (`src/commands/market.ts`, `src/client/OpenApiClient.ts`) dan daftar
  field filter/sort (`min_holder_count`, `top_holder_rate`, `rug_ratio`,
  `smart_degen_count`, dst), tapi aku tidak punya akses jaringan untuk test-call
  langsung ke API-nya. Kalau setelah deploy hasil scan kosong terus / field selalu
  "N/A", kemungkinan besar nama field di response asli sedikit beda dari dugaan —
  kirim aku contoh raw JSON response (`console.log(JSON.stringify(data))` di
  `fetchTrenches`, cek log-nya di Vercel dashboard), nanti aku sesuaikan.
- Rate limit GMGN: 20 request/detik (leaky bucket). Kode ini membatasi due-diligence
  lanjutan ke 6 kandidat teratas per chain supaya aman.
- `GMGN_PRIVATE_KEY` TIDAK dibutuhkan untuk scanner ini (hanya dibutuhkan untuk
  endpoint trading/swap, bukan untuk baca data).
- Narasi & kualitas media sosial (2 poin dari framework 6-poin) tetap manual checklist
  di UI — itu subjektif, tidak diautomasi.

## Yang TIDAK dilakukan tool ini

- Tidak mengeksekusi transaksi apa pun (read-only).
- Tidak menjamin token akan naik — ini filter red-flag, bukan prediksi harga.
