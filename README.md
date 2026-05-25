# Apex

Solana memecoin trenching bot. Pipeline: **screen → watchlist → confirmed entry → managed exit**.

## How it works

1. **Signal discovery** — polls Charon signal server every 30s for multi-source token signals.
2. **Metrics gate** — hard-rejects tokens that fail mcap/age/holders/authority/fee checks.
3. **LLM narrative screen** — evaluates Twitter narrative + viral potential. Verdict: WATCH (admit) / PASS (skip) / REJECT (blacklist).
4. **Watchlist** (max 25) — monitors each token every 30s with adaptive-TF chart data from Jupiter (30s/1m/5m). Evicts on trend reversal, low volume, or stale narrative.
5. **Entry signals** (independent, OR logic):
   - **Signal A (Obicle TA):** EMA20 touch + Stoch RSI K<20 turning up + 2-candle close above EMA.
   - **Signal B (Momentum reversal):** 3× volume spike (z≥2) + ATH dip recovery (-50 to -80% adaptive).
6. **Probe entry** — buys 25% of position size. Confirms at +3% in 4m (with 4 guards), then adds remaining 75%.
7. **Exit** — SL -25% · Stoch RSI K>80 → sell 40% & arm trailing 30% · trend reversal exits in profit.

## Data sources

| Source | Purpose |
|---|---|
| Charon signal server | Token discovery (paid feed) |
| Jupiter chart API | Candle data — 30s, 1m, 5m (sole chart source) |
| Jupiter datapi | Asset info, holders, price |
| GMGN OpenAPI | Token info enrichment (price, mcap, fees, socials) |
| Helius RPC | SPL mint/freeze authority check |
| fxTwitter | Tweet narrative + engagement metrics |
| MiniMax / DeepSeek | LLM narrative screening |
| Jupiter Ultra v2 | Trade execution (live mode) |

## Quick start

```bash
cp .env.example .env      # fill in keys
npm install               # native better-sqlite3 builds for your platform
npm run check             # syntax check all modules
npm run smoke             # offline assertions (8 checks)
npm start                 # or: pm2 start ecosystem.config.cjs
```

## Strategy management

Multi-strategy capable. One active at a time. Shipped: `apex_obicle`.

```
/strategy              — show active config
/strategies            — list all
/stratswitch <id>      — switch active
/stratset <key> <val>  — hot-mutate config (no restart)
/stratclone <id> [name] — copy active → new (disabled)
/stratdelete <id>      — delete non-active
```

## Telegram commands

```
/menu · /watchlist · /positions · /pnl [24h|7d|30d]
/watchlistremove <mint> · /blacklist <mint> [reason] · /blacklistremove <mint>
/mode dry_run|confirm|live · /help
```

## Architecture

```
Charon signal server (30s)
        │
        ▼
Metrics gate → LLM narrative → Watchlist (max 25)
                                    │
                                    │ 30s monitor (Jupiter 30s/1m/5m)
                                    ▼
                             Trend detector (score 0-100)
                             Signal A / Signal B
                                    │
                                    ▼
                           Probe entry (25%)
                                    │
                      confirmed → add-on (75%)
                                    │
                           Position monitor (10s)
                      partial TP · trailing · SL
```

## Project layout

```
apex/
├── index.js
├── src/
│   ├── app.js  config.js  utils.js  format.js  liveExecutor.js
│   ├── signals/     charonServer.js
│   ├── screening/   metricsGate.js  llmNarrative.js  llmPrompts.js
│   ├── pipeline/    screen.js
│   ├── watchlist/   manager.js  monitor.js  trendDetector.js
│   ├── chart/       jupiterChart.js  adaptiveTimeframe.js  indicators.js
│   ├── entry/       signalA.js  signalB.js  orchestrator.js
│   ├── execution/   probe.js  exits.js  positions.js  router.js
│   ├── enrichment/  gmgn.js  jupiter.js  tokenAuthority.js  twitter.js  wallets.js
│   ├── filters/     holderRisk.js  washTrade.js
│   ├── telegram/    bot.js  commands.js  callbacks.js  send.js  format.js  menus.js  input.js
│   ├── learning/    dailyReport.js  summary.js
│   └── db/          connection.js  settings.js  candidates.js  watchlist.js  positions.js
│                    blacklist.js  chartCache.js  decisions.js  intents.js  trades.js
├── scripts/         smoke-test.js  init-test.js
├── specs/           requirements.md  design.md
└── ecosystem.config.cjs
```

## Deploy

See `DEPLOY.md` for full VPS deployment procedure.

Key points:
- **Never** copy `node_modules` from Windows → always `npm install --omit=dev` on Linux.
- Deploy zip contains source only (no node_modules, no .env, no sqlite, no logs).
- PM2 process name: `apex`. Coexists with `charon` (v2) during cutover.
