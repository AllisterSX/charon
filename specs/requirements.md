# Apex — Requirements Specification

**Project:** Apex Trenching Bot
**Version:** 1.1 (revised)
**Status:** Pending review
**Date:** 2026-05-22

---

## 1. Overview

**Apex** adalah Solana memecoin trenching bot yang dibangun ulang dari nol dengan filosofi: **screen → watchlist → confirmed entry → managed exit**.

Apex hanya pakai **Charon signal server** sebagai discovery layer (paid signal feed dari `api.thecharon.xyz`). Selain itu, semua infrastruktur dibuat baru: filter pipeline, watchlist manager, technical analysis engine, probe entry state machine, exit logic, dan Telegram interface.

Strategi utama dan satu-satunya: **Obicle Trenching** — tunggu post-graduation insider unwind, ambil entry lewat technical analysis yang terkonfirmasi atau momentum reversal, exit lewat Stoch RSI overbought + trailing stop.

### 1.1 Core Philosophy

```
Charon Server ──► Metrics Gate ──► LLM Narrative ──► Watchlist (max 25)
                                                          │
                                                          ▼
                                                  Trend Monitor (30s)
                                                          │
                                  ┌───────────────────────┼───────────────────────┐
                                  ▼                       ▼                       ▼
                          Signal A: Obicle TA    Signal B: Momentum     Trend reversed?
                          (EMA + StochRSI +      (Volume spike +         → remove from
                           2-candle close)        ATH dip recovery)         watchlist
                                  │                       │
                                  └───────────┬───────────┘
                                              ▼
                                       Probe Entry (25%)
                                              │
                                  ┌───────────┴───────────┐
                                  ▼                       ▼
                          Confirmed (+3% in 4m)    Failed (-7% in 4m)
                                  │                       │
                                  ▼                       ▼
                          Add-on (75% rest)        Exit small loss
                                  │
                                  ▼
                          Position open + monitored
                                  │
                  ┌───────────────┼───────────────┐
                  ▼               ▼               ▼
          Stoch RSI > 80    SL -25%         Trend reversed
          (sell 40%)        (full exit)     (manual review)
                  │
                  ▼
          Trailing 30% from peak
                  │
                  ▼
          Full exit on trail trigger
```

### 1.2 Goals

- **Higher win rate** dengan TA-confirmed entry (target >35% vs v2 28%)
- **Better risk/reward** lewat probe entry (limit damage saat entry salah)
- **Narrative quality filter** lewat LLM (skip token tanpa story yang viable)
- **Trend awareness** — tidak hold token yang trend-nya berbalik
- **Re-entry capable** — kalau setup valid lagi, boleh masuk lagi

### 1.3 Non-goals

- Tidak implement pre-graduation sniper
- Tidak implement multi-strategy concurrent (fokus 1 strategi)
- Tidak ganti bahasa (tetap Node.js/ESM)
- Tidak ganti deployment target (tetap VPS Tencent OpenCloudOS)
- Tidak implement web UI (Telegram only)
- Tidak migrate signal source — tetap pakai Charon server (bukan Axiom direct, bukan GMGN trending direct)

---

## 2. Functional Requirements

### FR-1: Signal Discovery

**FR-1.1** Apex MUST poll Charon signal server (`https://api.thecharon.xyz/api/signals`) setiap 30 detik.

**FR-1.2** Apex MUST authenticate dengan `x-api-key` header dari .env.

**FR-1.3** Apex MUST support 4 source signals dari server: `axiom_trending`, `jupiter_trending`, `pump_graduated`, `fee_claim`. Filter `minSources=2` di query param.

**FR-1.4** Apex MUST dedup signal yang sama dalam window 10 menit untuk menghindari double-processing.

**FR-1.5** Apex MUST log semua signal yang masuk ke tabel `signal_events` dengan source dan payload-nya.

### FR-2: Metrics Screening (Hard Gate)

**FR-2.1** Apex MUST reject candidate kalau salah satu kondisi tidak terpenuhi:
- Market cap > $100,000
- Token age > 1 jam
- Holder count threshold (TBD di Design — research yang reasonable)
- Mint authority sudah revoked (anti-rug guard)
- Top 10 holder concentration di bawah threshold (TBD di Design)

**FR-2.2** Apex MUST verify fee/mcap ratio: total fee paid (SOL) / market cap (USD) ≥ 0.0001 (Obicle 1:10K rule).

**FR-2.3** Apex MUST log alasan reject untuk setiap candidate yang gagal screening.

**FR-2.4** Threshold MUST configurable via Telegram `/stratset` command tanpa restart bot.

### FR-3: LLM Narrative Screening

**FR-3.1** Setelah lolos metrics gate, Apex MUST kirim candidate ke LLM untuk narrative evaluation.

**FR-3.2** LLM MUST evaluate 3 dimensi:
- **Twitter narrative quality**: text + engagement metrics (likes, RTs, replies, views, follower count author)
- **Viral potential**: apakah narrative bisa spread di crypto twitter? Apakah punya hook (meme, AI, political, cultural reference)?
- **Sanity check**: red flags yang kelewat oleh metrics filter (copy-cat narrative, dev wallet patterns, sniper/bundler concentration)

**FR-3.3** LLM MUST return verdict: `WATCH` (masuk watchlist), `PASS` (skip), atau `REJECT` (skip permanen — token dianggap scam atau low quality).

**FR-3.4** LLM provider MUST adjustable via env variable `LLM_BASE_URL`, `LLM_MODEL`. Default: MiniMax M2.7. Future: DeepSeek V4 Pro.

**FR-3.5** Apex MUST handle LLM timeout (60s default) dan error dengan fallback: kalau LLM gagal, candidate masuk watchlist dengan flag `llm_unverified` + Telegram alert untuk manual review.

**FR-3.6** Prompt template MUST adapt dari charon's `compactCandidateForLlm()` tapi dengan output schema baru (verdict + reasoning + narrative_score 0-100 + viral_potential 0-100 + risks list).

### FR-4: Watchlist Management

**FR-4.1** Apex MUST maintain watchlist dengan kapasitas maksimum **25 token concurrent**.

**FR-4.2** Saat watchlist penuh, eviction strategy (priority order):
1. **Eliminate koin yang volume trade rendah** dalam window terakhir (5-10 menit)
2. **Eliminate koin yang narrative sudah tidak relevan** (di-revalidate via LLM tiap N menit, kalau LLM bilang `PASS` → evict)
3. **Always prioritize fresh coin** kalau ada yang baru lolos screening
4. **Tetap pertahankan koin dengan narasi kuat dan price action solid** (high LLM narrative_score + uptrend confirmed)

**FR-4.3** Apex MUST monitor setiap token di watchlist setiap **30 detik**.

**FR-4.4** Setiap monitoring cycle MUST update:
- Current price + market cap
- Trend status (uptrend / downtrend / neutral / reversing)
- Distance dari ATH (peak yang ter-track sejak masuk watchlist)
- Volume 5m terakhir + comparison dengan 1h average
- Stoch RSI K/D current values
- EMA(20) value + slope

**FR-4.5** Apex MUST remove token dari watchlist saat **trend berubah dari uptrend ke downtrend** (algoritma di Design phase: kombinasi EMA slope + HH/LL pattern + volume trend).

**FR-4.6** Apex MUST kirim Telegram notif untuk:
- Token masuk watchlist (dengan reason dari LLM + narrative score)
- Status update setiap **5 menit** (summary list watchlist + current trend status semua token)
- Token di-remove dari watchlist (dengan alasan: trend reversal / evicted / LLM revalidation failed)
- Entry signal trigger (Signal A atau B + spec details)
- Probe state changes (open → confirmed/failed → add-on complete)
- Exit (partial TP / full exit / SL)

### FR-5: Entry Signal Detection

**FR-5.1** Apex MUST evaluate **2 entry signals secara independen (OR logic)** untuk setiap token di watchlist. Kalau salah satu terpenuhi → trigger entry.

**Signal A — Obicle TA:**
- Price near EMA(20) — touch atau slightly below (within 0.5%)
- Stoch RSI K < 20 (oversold) AND turning up (K > prev K)
- 2-candle close above EMA (continuation pattern confirmation)

**Signal B — Momentum Reversal:**
- Buy volume spike (research-backed: 3x average AND Z-score > 2σ)
- Price recovery dari ATH dip (token sebelumnya dump -50% sampai -80% dari ATH, sekarang volume spike + price reversal)

**FR-5.2** Apex MUST log entry signal type (A atau B) di position record untuk learning.

**FR-5.3** Re-entry: token yang baru exit boleh trigger entry lagi setelah cooldown **5 menit** AND metrics + trend masih valid.

### FR-6: Adaptive Timeframe

**FR-6.1** Apex MUST pilih chart timeframe berdasarkan umur token:
- Token age **< 6 jam** → **30 detik chart**
- Token age **> 6 jam** → **1 menit atau 5 menit chart** (default 1m, fallback 5m kalau 1m tidak tersedia)

**FR-6.2** Apex MUST gunakan **GMGN chart API** sebagai primary data source untuk TF kecil (30s/1m). GMGN API key sudah tersedia.

**FR-6.3** Apex MAY fallback ke Jupiter chart API kalau GMGN rate-limited atau down.

**FR-6.4** Chart data MUST cached dengan TTL 10-30 detik untuk hindari rate limit.

**FR-6.5** Apex MUST handle GMGN rate limit (1 call per 5 detik per key) dengan throttling + queue.

### FR-7: Probe Entry State Machine

**FR-7.1** Saat entry signal trigger, Apex MUST buy **25% dari planned position size** sebagai probe.

**FR-7.2** Probe state machine:
```
[probe_open] ──── PnL > +3% in 4m ────► [probe_confirmed] ──► add-on 75%
     │
     └─────────── PnL < -7% in 4m ────► [probe_failed] ────► exit small loss
     │
     └─────────── 4m elapsed (PnL between -7% and +3%) ────► [probe_inconclusive] ──► hold small (no add-on)
```

**FR-7.3** Add-on MUST execute lewat Jupiter Ultra (atomic swap, retry on slippage failure).

**FR-7.4** Apex MUST log probe state transitions di tabel `position_events`.

**FR-7.5** Probe confirmation criteria (default values, configurable via stratset):
- `probe_confirm_min_pnl_pct`: 3
- `probe_fail_max_pnl_pct`: -7
- `probe_max_age_minutes`: 4
- `probe_size_pct`: 25 (% of planned full size)

**FR-7.6** Design phase MUST research alternative criteria (volume holding, RSI not overbought, EMA still bullish) sebagai opsi untuk improve confirmation accuracy.

### FR-8: Exit Strategy

**FR-8.1** Apex MUST monitor open position setiap **10 detik**.

**FR-8.2** **Partial TP** (Stoch RSI overbought):
- Trigger: Stoch RSI K > 80 AND PnL > 0
- Action: Sell **40%** dari position size, mark `partial_tp_done`
- Sisa **60%** tetap open dengan trailing stop

**FR-8.3** **Trailing stop** (after partial TP):
- Activated setelah partial TP done
- Trail percent: **30%** dari peak high water mark
- Trigger exit: kalau price drop ≥30% dari peak

**FR-8.4** **Stop loss** (hard):
- Trigger: PnL ≤ **-25%**
- Action: Full exit (semua sisa position)

**FR-8.5** **Tidak ada max hold time** — token bisa di-hold sampai exit signal valid (per user spec).

**FR-8.6** Re-entry boleh setelah exit dengan syarat:
- Cooldown minimum **5 menit** setelah exit (anti-thrashing)
- Trend masih uptrend (token harus kembali masuk watchlist via re-screening)
- Entry signal A atau B trigger lagi
- Metrics screening masih lolos (mcap, age, fee/mcap, holders, dll)

### FR-9: Position Management

**FR-9.1** Default position size: **0.1 SOL** per trade (dry-run, configurable via strategy config).

**FR-9.2** Maximum concurrent positions: **10**.

**FR-9.3** Tidak ada daily loss limit.

**FR-9.4** Apex MUST simpan history posisi di `positions` table (extend dari charon-v2 schema dengan probe state fields).

### FR-10: Telegram Interface

**FR-10.1** Apex MUST support core commands:
- `/menu` — main menu inline keyboard
- `/strategy` — show current strategy config
- `/stratset <key> <value>` — update strategy config (hot reload)
- `/positions` — list open + recent positions
- `/pnl [window]` — PnL report (default 24h, support 7d/30d)
- `/learn [window]` — generate operational lessons
- `/lessons` — show active lessons

**FR-10.2** Apex MUST tambah commands baru:
- `/watchlist` — show current watchlist dengan trend status per token
- `/watchlistadd <mint>` — manual add token (skip screening)
- `/watchlistremove <mint>` — manual remove token
- `/probe <position_id>` — show probe state details
- `/blacklist <mint>` — block token dari masuk watchlist permanen
- `/blacklistremove <mint>` — unblock

**FR-10.3** Apex MUST kirim daily report jam **07:00 WIB** dengan metrics:
- Positions opened/closed
- Win rate
- Net PnL SOL
- Best/worst trades
- Watchlist activity (added/removed/expired)
- Probe success rate
- Entry signal A vs B distribution
- LLM decision distribution (WATCH/PASS/REJECT)

### FR-11: Trading Modes

**FR-11.1** Apex MUST support 3 modes: `dry_run`, `confirm`, `live`.

**FR-11.2** Default mode: `dry_run`.

**FR-11.3** Live execution MUST pakai **Jupiter Ultra v2** (`/order` + `/execute`).

**FR-11.4** `confirm` mode: kirim approve/reject inline button via Telegram, bot tunggu user input sebelum execute.

**FR-11.5** Live mode MUST validate wallet balance ≥ position size + min reserve (0.05 SOL) sebelum execute.

---

## 3. Non-functional Requirements

### NFR-1: Performance

| Operation | Target |
|---|---|
| Signal poll cycle | 30 detik |
| Watchlist monitoring | 30 detik per token (parallel batched) |
| Position monitoring | 10 detik |
| LLM screening latency | max 60 detik (timeout fallback) |
| Chart data fetch | cached 10-30 detik, max 100 calls/minute |
| GMGN API | throttle 1 call per 5 detik per key |

### NFR-2: Reliability

- Apex MUST survive restart tanpa kehilangan state (watchlist + positions persisted di SQLite)
- Apex MUST recover dari API failures tanpa crash (3-failure threshold sebelum alert via TG)
- PM2 MUST auto-restart on crash dengan max_memory_restart 500MB
- Watchlist state MUST consistent setelah restart (re-validate trend status untuk semua token)

### NFR-3: Observability

- Setiap decision (screen, watchlist add/remove, entry signal, probe state, exit) MUST logged ke decision_logs
- Telegram alert untuk: bot start, watchlist updates, entry/exit, daily report, errors >3 consecutive
- Log file rotation via PM2 logrotate (10MB, 14 days retention)

### NFR-4: Security

- API keys MUST stored di .env, tidak di-commit ke git
- Wallet private key MUST stored di .env (filesystem-level encryption via VPS)
- Live mode MUST require explicit `TRADING_MODE=live` (default `dry_run`)

### NFR-5: Maintainability

- Codebase MUST modular: `signals/`, `screening/`, `watchlist/`, `entry/`, `execution/`, `telegram/`, `learning/`
- Database schema migrations MUST backward compatible (ALTER TABLE additive only)
- Strategy config MUST hot-reloadable via SQLite (no restart untuk threshold tweaks)
- Build verification: `npm run check` MUST validate semua source files via `node --check`

---

## 4. Out of Scope

- Multi-chain support (Solana only)
- Multi-wallet management (1 wallet per bot instance)
- Web UI / dashboard (Telegram only)
- Backtest engine (live dry-run only)
- Custom LLM fine-tuning (commercial APIs only)
- Discord / Slack notifications (Telegram only)

---

## 5. Acceptance Criteria

### Functional Acceptance

1. ✅ Signal poll dari Charon server berjalan stabil tanpa 401/error berulang
2. ✅ Metrics screening reject ~70% candidates, ~30% lolos ke LLM
3. ✅ LLM screening reject 50%+ dari yang lolos metrics, sisanya masuk watchlist
4. ✅ Watchlist size rata-rata 10-20 token concurrent
5. ✅ Watchlist removal triggered saat trend reversal terdeteksi
6. ✅ Entry signal A dan B keduanya bisa trigger entry
7. ✅ Probe entry state machine berfungsi (open → confirmed/failed/inconclusive)
8. ✅ Probe confirmed rate > 50%
9. ✅ Partial TP triggered saat Stoch RSI K > 80 dengan PnL > 0
10. ✅ Trailing 30% triggered setelah partial TP done
11. ✅ Re-entry boleh setelah cooldown 5 menit + metrics valid
12. ✅ Telegram notif lengkap (watchlist add/remove/update, entry/exit, daily report)
13. ✅ Bot survive 7 hari tanpa manual intervention

### Performance KPI (post-deployment, 7-day window)

| Metric | Target | v2 Baseline |
|---|---|---|
| Win rate | > 35% | 28.33% |
| Profit factor | > 1.5 | 1.316 |
| Avg hold time | 30-90 menit | 21m 20s |
| Max drawdown | < 30% | unknown |
| Probe failed rate | < 50% | n/a (new) |
| LLM decision latency | < 30s p95 | n/a |
| False positive rate (entry → SL within 5m) | < 30% | ~62% (37 SL / 60 trades) |

---

## 6. Open Questions Resolved (with research-backed options di Design Phase)

User menyerahkan keputusan ke gw untuk research dan kasih opsi di Design phase:

1. **Trend detection algorithm** — kombinasi EMA slope + HH/LL + volume trend. Design phase akan kasih opsi spesifik:
   - Option A: EMA slope (5-period) > 0 + last 3 candles HH/HL + volume 5m > 1h avg
   - Option B: EMA(20) > EMA(50) + price > EMA(20) + volume z-score > 0
   - Option C: Combined weighted score 0-100, threshold trend status

2. **Watchlist eviction priority order** (sesuai user spec):
   1. Volume trade rendah dalam 5-10 menit
   2. Narrative tidak relevan (LLM revalidation `PASS`)
   3. Always prioritize fresh coin
   4. Pertahankan high narrative_score + uptrend solid

3. **ATH dip threshold untuk Signal B**: -50% sampai -80% adaptive. Algoritma adaptif: makin volatile token, makin dalam dip yang valid (research di Design).

4. **Volume spike threshold**: 3x average AND Z-score > 2σ. Design phase akan kasih formula konkret + lookback window.

5. **LLM prompt template** — adapt dari `charon-main/src/pipeline/llm.js` `compactCandidateForLlm()` + `decideCandidateBatch()`. Schema baru:
   ```json
   {
     "verdict": "WATCH|PASS|REJECT",
     "narrative_score": "0-100",
     "viral_potential": "0-100",
     "narrative_summary": "short string",
     "risks": ["short strings"],
     "reason": "decision rationale"
   }
   ```

6. **Adaptive TF**: langsung pakai GMGN chart API untuk 30s/1m TF (per user spec). Jupiter sebagai fallback only kalau GMGN down.

7. **Probe confirmation criteria**: research di Design phase. Default starting point: `pnl > +3% in 4m`. Alternative criteria yang akan diteliti:
   - Volume sustained (5m volume tetap > 50% dari volume 5m saat entry)
   - RSI not overbought (Stoch RSI K < 70 saat probe checkpoint)
   - EMA slope still positive
   - Price above entry EMA value

---

## 7. Dependencies

### External APIs

- **Charon signal server** (existing, paid key — `bb1eba81...`)
- **GMGN OpenAPI** (existing, key `gmgn_6b200e8...`)
- **Jupiter Ultra v2** (existing) — execution
- **Jupiter chart API** (existing) — fallback chart
- **Helius RPC** (existing, free tier OK) — token authority check
- **fxtwitter API** (existing, no key) — tweet narrative
- **LLM provider** (MiniMax M2.7 default, DeepSeek V4 Pro future)
- **Telegram Bot API** (existing)

### Code Reuse from charon-v2 (pattern reference, not direct copy)

- SQLite + better-sqlite3
- Telegram bot framework (node-telegram-bot-api)
- Signal poller architecture
- LLM client pattern
- PM2 ecosystem config
- Daily report generator

### New Components (build from scratch in Apex)

- Watchlist manager (add/remove/evict logic + 30s monitor loop)
- Trend detector (EMA slope + HH/LL + volume trend algorithm)
- Chart data fetcher (GMGN primary + Jupiter fallback, adaptive TF)
- Probe state machine (open → confirmed/failed/inconclusive → add-on)
- Entry signal detector (Signal A + Signal B)
- LLM narrative screener (new prompt + schema + revalidation)
- Stoch RSI exit + 30% trailing logic
- Position re-entry with cooldown + metrics revalidation

### Project Structure (proposed for Design phase)

```
apex/
├── index.js                           # entrypoint + graceful shutdown
├── package.json                       # name: "apex", v3.0.0-dev
├── ecosystem.config.cjs               # PM2 config
├── .env.example
├── README.md
├── DEPLOY.md
├── CHANGELOG.md
├── specs/
│   ├── requirements.md                # this file
│   └── design.md                      # next phase
├── scripts/
│   ├── smoke-test.js
│   └── init-test.js
├── src/
│   ├── app.js                         # bootstrap
│   ├── config.js                      # env config
│   ├── utils.js                       # shared helpers
│   ├── format.js                      # display helpers
│   ├── liveExecutor.js                # Jupiter Ultra v2 wrapper
│   │
│   ├── signals/
│   │   └── charonServer.js            # Charon signal server poller
│   │
│   ├── screening/
│   │   ├── metricsGate.js             # FR-2 hard gates
│   │   ├── llmNarrative.js            # FR-3 LLM screening
│   │   └── llmPrompts.js              # prompt templates
│   │
│   ├── watchlist/
│   │   ├── manager.js                 # FR-4 watchlist CRUD + eviction
│   │   ├── monitor.js                 # FR-4.3 30s monitoring loop
│   │   └── trendDetector.js           # FR-4.5 trend reversal algorithm
│   │
│   ├── chart/
│   │   ├── gmgnChart.js               # primary chart API
│   │   ├── jupiterChart.js            # fallback chart API
│   │   ├── adaptiveTimeframe.js       # FR-6 TF selection logic
│   │   └── indicators.js              # EMA, RSI, Stoch RSI math
│   │
│   ├── entry/
│   │   ├── signalA.js                 # FR-5 Obicle TA detector
│   │   ├── signalB.js                 # FR-5 momentum reversal detector
│   │   └── orchestrator.js            # entry signal orchestrator
│   │
│   ├── execution/
│   │   ├── probe.js                   # FR-7 probe state machine
│   │   ├── exits.js                   # FR-8 exit logic (partial TP, trailing, SL)
│   │   ├── router.js                  # buy/sell routing via Jupiter Ultra
│   │   └── positions.js               # FR-9 position monitor (10s)
│   │
│   ├── enrichment/
│   │   ├── tokenAuthority.js          # SPL token mint/freeze authority
│   │   ├── twitter.js                 # fxtwitter narrative fetcher
│   │   └── holders.js                 # Jupiter holder distribution
│   │
│   ├── telegram/
│   │   ├── bot.js
│   │   ├── commands.js                # FR-10 commands
│   │   ├── menus.js
│   │   ├── format.js
│   │   ├── send.js
│   │   ├── callbacks.js
│   │   └── input.js
│   │
│   ├── learning/
│   │   ├── dailyReport.js             # FR-10.3 07:00 WIB
│   │   ├── lessons.js                 # weekly learning loop
│   │   └── summary.js                 # PnL aggregator
│   │
│   └── db/
│       ├── connection.js              # SQLite init + schema
│       ├── settings.js                # global settings + active strategy
│       ├── candidates.js              # signal candidates
│       ├── watchlist.js               # NEW: watchlist tokens
│       ├── positions.js               # positions
│       ├── decisions.js               # LLM decisions
│       ├── trades.js                  # buy/sell ledger
│       └── intents.js                 # confirm-mode trade intents
```

---

## 8. Approval

**Pending sign-off:**
- [ ] FR-1 to FR-11 (functional requirements)
- [ ] NFR-1 to NFR-5 (non-functional requirements)
- [ ] Acceptance criteria + KPIs
- [ ] Project structure (proposed)
- [ ] Open questions resolution path (Design phase will provide options)

**Next step setelah approval:** Design Phase document — arsitektur teknis lengkap dengan:
- Database schema definitions (CREATE TABLE)
- API contracts antar modul
- Algorithm specs (trend detector, entry signals, probe state machine)
- LLM prompt templates final
- PM2 / VPS deployment plan
- Migration plan (dari charon-v2 → Apex)
