# Charon-v2 Changelog

Each phase ends with `npm run check` passing.

## Phase 0 — Fork & rebrand (DONE)

- [x] Fork tree dari `charon-main/charon-main/` (no node_modules, no sqlite, no .env).
- [x] Rename: `APP_NAME = Charon-v2`, `DB_PATH = ./charon-v2.sqlite`, `package.name = charon-v2`.
- [x] `.env` di-prepopulate dengan API keys: SIGNAL_SERVER_KEY, GMGN_API_KEY, HELIUS_API_KEY.
- [x] `TRADING_MODE=dry_run` default (no wallet required).
- [x] `npm install` (267 packages, no breaking deprecations).
- [x] `npm run check` pass.
- [x] Smoke test (`scripts/smoke-test.js`) 4/4 pass: Helius RPC alive, GMGN auth OK, Charon server alive (324 signals tracked), /signals returns 4-source agregasi.

## Phase 1 — Dual-source signal layer (SKIPPED — folded into phase 6)

Rationale: charon server sudah agregasi 4 source (axiom + pump_graduated + jupiter_trending + fee_claim) untuk semua post-graduation token. Kita drop pre-graduation sniper berdasarkan riset (Pine Analytics: 87% deployer-funded sniper win rate). `graduation_pump` strategy bisa trigger pakai server signal yang baru muncul dengan `bondingComplete: true`. GMGN smart-money / KOL endpoint pindah ke phase 6 untuk strategi tier-2 `smart_money_follow`.

## Phase 2 — Defensive filter layers (DONE)

Berdasarkan ponyin plan + MemeTrans/Mobula/Pine research.

- [x] `src/enrichment/tokenAuthority.js` — read SPL Token / Token-2022 mint+freeze authority via Solana RPC.
- [x] `src/filters/holderRisk.js` — top1/top10/top20 concentration + cluster band detection + tagged bundler %.
- [x] `src/filters/washTrade.js` — buy:sell ratio sanity, balanced wash detection, organic score.
- [x] `src/filters/networkCongestion.js` — Helius `getPriorityFeeEstimate` cached 30s, returns level/action/sizeMultiplier.
- [x] Wired into `pipeline/candidateBuilder.js` filter pipeline + `execution/positions.js` refresh stage.
- [x] Settings hot-toggleable via SQLite + env: `enable_token_authority_guard`, `reject_active_mint_authority`, `enable_network_congestion_guard`, `holder_risk_reject_score`.

## Phase 3 — Strategy `obicle_confirmed` (DONE)

Default tier-1 strategy. Replaces v1 sniper/dip_buy/smart_money/degen seeds.

- [x] Seeded 3 tier-1 strategies di `db/connection.js`: `obicle_confirmed` (default), `graduation_pump`, `migration_play`.
- [x] Filter rules: age 1h-24h, mcap 150K-5M, fee/mcap ≥1:10K (Obicle), holders ≥200, top10 ≤30%, dev ≤5%, bundled ≤20%.
- [x] New filter fields supported: `token_age_min_ms`, `fee_to_mcap_min_ratio`, `max_top10_holder_percent`, `max_dev_holder_percent`, `max_bundled_pct`, `min_age_after_ath_ms`.
- [x] `serverClient.js` strategy gate uses both `token_age_min_ms` and `token_age_max_ms`.
- [x] `ageMs` propagated through signals → buildCandidate → filterCandidate.
- [x] `/strategy` Telegram command updated to accept new ids.
- [x] `db/settings.js` fallback default now `obicle_confirmed`.
- [x] Init smoke test (`scripts/init-test.js`) confirms 3 strategies seed correctly.

## Phase 4 — Strategi `graduation_pump` + `migration_play` (DONE — folded into Phase 3)

Both strategies seeded alongside `obicle_confirmed` in Phase 3. No new module needed; filter rules covered by Phase 2+3 additions.

## Phase 5 — TA local compute (DONE)

EMA(20) + Stoch RSI(14) lokal dari Jupiter chart API.

- [x] `src/filters/technicalAnalysis.js` — pure-JS EMA + RSI + Stoch RSI implementation, fetches Jupiter candles, picks adaptive timeframe (5m for <48h, 15m otherwise).
- [x] `evaluateTaEntry()` returns `entrySignal` boolean based on 5 conditions (need ≥3): price near EMA, stoch oversold, stoch turning up, stoch bullish cross, 2-candle close above EMA.
- [x] Two-stage integration: candidate-build seeds `pending_execution_refresh`; refresh stage (post-LLM) computes real values. Saves Jupiter API calls on rejected candidates.
- [x] `filterCandidate()` enforces TA only post-refresh, lets pre-refresh candidates pass to LLM.

## Phase 6 — VPS-ready polish (DONE)

- [x] `index.js` — graceful shutdown handlers (SIGINT, SIGTERM, uncaughtException).
- [x] `ecosystem.config.cjs` — PM2 ecosystem with autorestart, memory cap, log rotation hints, kill_timeout.
- [x] `DEPLOY.md` — VPS deployment guide (Ubuntu/Debian/OpenCloudOS).
- [x] `src/learning/dailyReport.js` — daily TG summary at 07:00 WIB (configurable).
- [x] `package.json` `check` expanded to validate all 16 critical files.
- [x] `npm run smoke` (4/4 passed: Helius, GMGN, charon server health + signals).
- [x] `npm run init-test` (3 strategies seeded, obicle_confirmed active).
- [x] Live startup smoke test confirmed pipeline working: incoming signal from charon server → enrichment → filter cascade rejects WATERFALL token correctly via Phase 2+3 rules.
