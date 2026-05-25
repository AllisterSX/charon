# Apex

Solana memecoin trenching bot. Pipeline: **screen → watchlist → confirmed entry → managed exit**.

- Discovery: Charon signal server (paid feed) — discovery only.
- Screening: metrics gate (FR-2) + LLM narrative screen (FR-3).
- Watchlist: max 25 tokens, 30s monitor, 10m LLM revalidation, eviction by trend/volume/narrative.
- Entry: two independent signals.
  - **Signal A (Obicle TA):** EMA20 touch + Stoch RSI bottom + 2-candle close above EMA.
  - **Signal B (Momentum reversal):** 3× volume spike (z ≥ 2) + ATH dip recovery (-50 to -80% adaptive).
- Probe entry: 25% of size, confirm at +3% / 4m, add-on 75% only if guards pass.
- Exit: SL -25%, Stoch RSI K>80 → sell 40% & arm trailing 30%, trend reversal exits in profit.
- Position size: 0.1 SOL · max 10 concurrent · 5m re-entry cooldown · no max hold time.
- Multi-strategy capable: one strategy active at a time, switch / clone / mutate via Telegram.

## Quick start

```bash
cp .env.example .env      # fill in keys
npm install               # native better-sqlite3 builds for your platform
npm run check             # syntax check all modules
npm run smoke             # offline assertions
npm start                 # or: pm2 start ecosystem.config.cjs
```

## Telegram commands

- `/menu` · `/strategy` · `/strategies` · `/watchlist` · `/positions` · `/pnl [24h|7d|30d]`
- `/stratswitch <id>` · `/stratset <key> <value>` · `/stratclone <newId> [name]` · `/stratdelete <id>`
- `/blacklist <mint> [reason]` · `/blacklistremove <mint>` · `/blacklists`
- `/watchlistremove <mint>` · `/mode dry_run|confirm|live`

## Architecture

```
Charon signal server
        │ 30s poll
        ▼
Metrics gate ──► LLM narrative ──► Watchlist (max 25)
                                     │
                                     │ 30s monitor
                                     ▼
                              Trend detector
                              Signal A / B
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
│   ├── app.js
│   ├── config.js  utils.js  format.js  liveExecutor.js
│   ├── signals/    charonServer.js
│   ├── screening/  metricsGate.js  llmNarrative.js  llmPrompts.js
│   ├── pipeline/   screen.js
│   ├── watchlist/  manager.js  monitor.js  trendDetector.js
│   ├── chart/      gmgnChart.js  jupiterChart.js  adaptiveTimeframe.js  indicators.js
│   ├── entry/      signalA.js  signalB.js  orchestrator.js
│   ├── execution/  probe.js  exits.js  positions.js  router.js
│   ├── enrichment/ gmgn.js  jupiter.js  tokenAuthority.js  twitter.js  wallets.js
│   ├── filters/    holderRisk.js  washTrade.js
│   ├── telegram/   bot.js  commands.js  callbacks.js  send.js  format.js  menus.js  input.js
│   ├── learning/   dailyReport.js  summary.js
│   └── db/         connection.js  settings.js  candidates.js  watchlist.js  positions.js
│                   blacklist.js  chartCache.js  decisions.js  intents.js  trades.js
└── specs/          requirements.md  design.md
```

See `DEPLOY.md` for VPS deployment.
