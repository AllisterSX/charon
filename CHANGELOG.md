# Apex Changelog

## 3.0.0 — 2026-05-25

Initial release. Built from scratch atop the charon-v2 architecture with:

- Pipeline: signal → metricsGate → llmNarrative → watchlist → trend monitor → entry signal → probe → confirmed → add-on → managed exit.
- Watchlist (capacity 25) with eviction by trend reversal, low volume, LLM PASS verdict, narrative score, age.
- Two independent entry signals (A: Obicle TA, B: momentum reversal).
- Adaptive chart timeframe (<6h → 30s, <48h → 1m, else 5m). GMGN primary, Jupiter fallback.
- Probe entry state machine with 4 confirmation guards (volume holding, EMA bullish, no overbought, above entry EMA).
- Exit policy: SL -25%, partial TP at Stoch RSI K>80 (sell 40%), trailing 30% from peak after partial.
- Re-entry allowed after 5m cooldown.
- Multi-strategy capable schema. Single shipped strategy: `apex_obicle`. Operators can switch / clone / mutate via Telegram.
- LLM narrative screen + 10-minute revalidation. PASS evicts, REJECT blacklists.
- Daily report at 07:00 WIB.

### Reused (rebrand only) from charon-v2

`utils.js`, `format.js`, `liveExecutor.js`, `enrichment/{gmgn,jupiter,tokenAuthority,twitter,wallets}`, `filters/{holderRisk,washTrade}`, signal poller pattern.

### Rewritten in Apex

`watchlist/`, `entry/`, `execution/{probe,exits,positions}`, `chart/`, `screening/`, `db/connection.js` (new schema), `pipeline/screen.js`.
