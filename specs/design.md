# Apex — Design Specification

**Project:** Apex Trenching Bot
**Version:** 1.0
**Status:** Pending review
**Date:** 2026-05-25
**Companion doc:** `requirements.md` v1.1

---

## 1. Architecture Overview

### 1.1 Module Map

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ index.js  → src/app.js  → bootstrap                                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
┌──────────────┐          ┌──────────────┐          ┌──────────────────┐
│ Signal Layer │          │ Telegram I/O │          │  DB (SQLite)     │
│ signals/     │          │ telegram/    │          │  db/             │
│ charonServer │          │              │          │  + migrations    │
└──────┬───────┘          └──────────────┘          └────────┬─────────┘
       │                                                      │
       ▼                                                      ▲
┌──────────────────┐  rejected ┌────────────┐                 │
│ Screening Stage  ├──────────►│ blacklist  │                 │
│ screening/       │           │  store     │                 │
│  metricsGate     │           └────────────┘                 │
│  llmNarrative    │                                          │
└──────┬───────────┘                                          │
       │ accepted                                             │
       ▼                                                      │
┌──────────────────┐                                          │
│ Watchlist        │── 30s monitor cycle ─────►┌──────────┐   │
│ watchlist/       │                           │ chart/   │   │
│  manager         │                           │  gmgn    │   │
│  monitor         │                           │  jupiter │   │
│  trendDetector   │                           │  ind.    │   │
└──────┬───────────┘                           └──────────┘   │
       │ entry signal trigger                                 │
       ▼                                                      │
┌──────────────────┐                                          │
│ Entry Engine     │                                          │
│ entry/           │                                          │
│  signalA (TA)    │                                          │
│  signalB (mom.)  │                                          │
│  orchestrator    │                                          │
└──────┬───────────┘                                          │
       │ probe / add-on / exit                                │
       ▼                                                      │
┌──────────────────┐                                          │
│ Execution        │── routes ──►┌──────────────┐             │
│ execution/       │             │ liveExecutor │             │
│  probe           │             │ Jupiter Ultra│             │
│  exits           │             └──────────────┘             │
│  positions (10s) │                                          │
└──────────────────┘                                          │
                                                              │
       ┌────────── decisions / events ───────────────────────►┘
```

### 1.2 Runtime Loops

| Loop | Period | Owner | What it does |
|---|---|---|---|
| Signal poll | 30s | `signals/charonServer` | Poll Charon API, dedup, push to screening |
| Watchlist monitor | 30s | `watchlist/monitor` | Update price/TA per token, check trend & entry signals |
| Position monitor | 10s | `execution/positions` | Update PnL, evaluate probe state, exits |
| LLM revalidation | 10m per token | `screening/llmNarrative` | Re-rate watchlisted tokens, mark stale narratives |
| Watchlist status push | 5m | `telegram/send` | Send watchlist summary to Telegram |
| Daily report | 07:00 WIB | `learning/dailyReport` | Send PnL + activity report |
| Lessons (weekly) | Sun 08:00 WIB | `learning/lessons` | Generate lessons from past 7d positions |

### 1.3 Data Flow Stages

1. **Signal** → `candidates` row (status=`new`)
2. **Metrics gate** → if pass, status=`screened`; else status=`filtered`
3. **LLM narrative** → if WATCH, status=`watchlisted`; else status=`rejected`
4. **Watchlist tick** → updates `watchlist` row + writes `watchlist_ticks` (TA snapshot)
5. **Entry signal** → `positions` row (status=`probe_open`)
6. **Probe outcome** → `positions.probe_state` ∈ {`confirmed`,`failed`,`inconclusive`}
7. **Add-on / exits** → `positions.status` ∈ {`open`,`closed`}, `exit_reason` set

---

## 2. Database Schema

SQLite via `better-sqlite3`. WAL mode. All timestamps `INTEGER ms`. JSON payloads stored as TEXT.

### 2.1 New tables

```sql
-- Watchlist roster (one row per active mint)
CREATE TABLE watchlist (
  mint                    TEXT PRIMARY KEY,
  candidate_id            INTEGER NOT NULL,
  symbol                  TEXT,
  added_at_ms             INTEGER NOT NULL,
  last_tick_at_ms         INTEGER,
  last_revalidated_at_ms  INTEGER,
  status                  TEXT NOT NULL DEFAULT 'active', -- active|removed
  removed_at_ms           INTEGER,
  removal_reason          TEXT, -- trend_reversal|llm_revalidation_pass|evicted|manual|exit_cooldown_expired
  -- LLM rating (refreshed on revalidation)
  narrative_score         INTEGER,           -- 0-100
  viral_potential         INTEGER,           -- 0-100
  llm_verdict             TEXT,              -- WATCH|PASS|REJECT
  llm_reason              TEXT,
  -- Live state (refreshed every 30s)
  current_price_native    REAL,
  current_mcap_usd        REAL,
  ath_price_native        REAL,
  ath_at_ms               INTEGER,
  trend_status            TEXT,              -- uptrend|neutral|downtrend|reversing
  trend_score             REAL,              -- 0-100
  vol_5m_usd              REAL,
  vol_1h_avg_usd          REAL,
  ema20                   REAL,
  ema50                   REAL,
  stoch_k                 REAL,
  stoch_d                 REAL,
  candle_tf               TEXT,              -- 30s|1m|5m
  -- Re-entry control
  cooldown_until_ms       INTEGER,
  last_position_id        INTEGER,
  snapshot_json           TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_watchlist_status ON watchlist(status);
CREATE INDEX idx_watchlist_added ON watchlist(added_at_ms);

-- Per-tick snapshots (for charting + audit; rolling pruned)
CREATE TABLE watchlist_ticks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  mint                TEXT NOT NULL,
  at_ms               INTEGER NOT NULL,
  price_native        REAL,
  mcap_usd            REAL,
  vol_5m_usd          REAL,
  ema20               REAL,
  ema50               REAL,
  stoch_k             REAL,
  stoch_d             REAL,
  trend_score         REAL,
  trend_status        TEXT,
  candle_tf           TEXT,
  ind_json            TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_ticks_mint_at ON watchlist_ticks(mint, at_ms);

-- Watchlist event log
CREATE TABLE watchlist_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mint          TEXT NOT NULL,
  at_ms         INTEGER NOT NULL,
  kind          TEXT NOT NULL,    -- added|revalidated|trend_change|evicted|removed|reentry_armed
  reason        TEXT,
  payload_json  TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_wl_events_mint_at ON watchlist_events(mint, at_ms);

-- Per-position event log (probe transitions, partial exits, trail arms)
CREATE TABLE position_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id   INTEGER NOT NULL,
  at_ms         INTEGER NOT NULL,
  kind          TEXT NOT NULL,    -- probe_open|probe_confirmed|probe_failed|probe_inconclusive
                                  -- |addon_filled|partial_tp|trail_armed|trail_exit|sl_exit|trend_exit
  pnl_pct       REAL,
  price_native  REAL,
  mcap_usd      REAL,
  payload_json  TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_pos_events_pid ON position_events(position_id, at_ms);

-- Manual blacklist (block from re-entering watchlist)
CREATE TABLE blacklist (
  mint        TEXT PRIMARY KEY,
  added_at_ms INTEGER NOT NULL,
  reason      TEXT
);

-- Chart cache (TTL eviction in code; row replaces on key collision)
CREATE TABLE chart_cache (
  cache_key      TEXT PRIMARY KEY,    -- mint:tf
  fetched_at_ms  INTEGER NOT NULL,
  ttl_ms         INTEGER NOT NULL,
  source         TEXT NOT NULL,       -- gmgn|jupiter
  candles_json   TEXT NOT NULL
);
```

### 2.2 Reused tables (extended)

`candidates`, `signal_events`, `llm_decisions`, `decision_logs`, `learning_runs`,
`learning_lessons`, `settings`, `saved_wallets` — schema identical to `charon-v2`.

`positions` (renamed from `dry_run_positions`) — extend with:

```sql
-- additive ALTER (migration script; safe across runs)
ALTER TABLE positions ADD COLUMN strategy_id      TEXT DEFAULT 'apex_obicle';
ALTER TABLE positions ADD COLUMN entry_signal     TEXT;        -- 'A'|'B'
ALTER TABLE positions ADD COLUMN entry_tf         TEXT;        -- '30s'|'1m'|'5m'
ALTER TABLE positions ADD COLUMN probe_state      TEXT;        -- open|confirmed|failed|inconclusive
ALTER TABLE positions ADD COLUMN probe_size_sol   REAL;
ALTER TABLE positions ADD COLUMN addon_size_sol   REAL DEFAULT 0;
ALTER TABLE positions ADD COLUMN addon_at_ms      INTEGER;
ALTER TABLE positions ADD COLUMN partial_tp_done  INTEGER DEFAULT 0;
ALTER TABLE positions ADD COLUMN trailing_armed   INTEGER DEFAULT 0;
ALTER TABLE positions ADD COLUMN cooldown_until_ms INTEGER;
ALTER TABLE positions ADD COLUMN watchlist_mint   TEXT;        -- foreign key (logical) to watchlist.mint
```

### 2.3 Strategy management (multi-strategy capable)

The `strategies` table is identical in spirit to charon-v2: it can hold many rows,
each row is a JSON config, and exactly one is `enabled=1` at a time. We ship exactly
**one** seeded strategy in v3.0.0 (`apex_obicle`), but the runtime is multi-strategy
capable so future strategies can be added via SQL or `/stratset` without code changes.

Operator surface (carried over from v2):

| Command | What it does |
|---|---|
| `/strategy` | show currently-active strategy + key knobs |
| `/strategies` | list all rows with `enabled` flag |
| `/stratset <key> <value>` | mutate `config_json[key]` for active strategy (hot-reloaded next loop tick) |
| `/stratswitch <id>` | flip `enabled` flag — disable current, enable target |
| `/stratclone <new_id>` | clone active strategy into a new row for tweaking |

Implementation contract:

- `db/settings.activeStrategy()` returns the merged strategy object (id + config).
- All loops (`watchlist/monitor`, `screening/metricsGate`, `entry/*`, `execution/*`)
  call `activeStrategy()` at the START of each cycle — never cache across ticks.
- `/stratset` writes the new value back to SQLite immediately; next loop picks it up.
- Multi-strategy concurrent execution is NOT in scope for v3.0.0 (one active at a
  time), but the schema is ready if we want it later.

```js
// seed row (config_json shown abridged)
{
  id: 'apex_obicle',
  name: 'Apex Obicle',
  enabled: 1,
  config_json: {
    // Position sizing
    position_size_sol: 0.1,
    probe_size_pct: 25,
    max_open_positions: 10,
    // Metrics gate
    max_mcap_usd: 100000,
    token_age_min_ms: 0,
    token_age_max_ms: 3600000,            // 1h
    min_holders: 50,
    max_top10_holder_percent: 65,
    fee_to_mcap_min_ratio: 0.0001,
    require_mint_authority_revoked: true,
    // LLM
    use_llm: true,
    llm_min_narrative_score: 50,
    llm_revalidate_interval_ms: 600000,   // 10m
    // Watchlist
    watchlist_max: 25,
    watchlist_monitor_ms: 30000,
    watchlist_low_volume_threshold_usd: 1000, // 5m
    // Trend
    trend_uptrend_min_score: 60,
    trend_reversal_max_score: 35,
    // Entry Signal A — Obicle TA
    sigA_ema_period: 20,
    sigA_ema_touch_pct: 0.5,              // within 0.5% above EMA
    sigA_stoch_oversold: 20,
    sigA_two_candle_above: true,
    // Entry Signal B — Momentum reversal
    sigB_vol_spike_multiplier: 3,
    sigB_vol_spike_zscore: 2,
    sigB_vol_lookback_candles: 12,        // 12 × 5min = 1h
    sigB_ath_dip_min_pct: -50,
    sigB_ath_dip_max_pct: -80,
    // Probe state machine
    probe_confirm_min_pnl_pct: 3,
    probe_fail_max_pnl_pct: -7,
    probe_max_age_ms: 240000,             // 4m
    // Exit
    sl_pct: -25,
    stoch_overbought: 80,
    partial_tp_sell_pct: 40,
    trailing_pct: 30,
    reentry_cooldown_ms: 300000,          // 5m
  }
}
```

---

## 3. Module Contracts

> Contracts written as TypeScript-style signatures for clarity; implementation is plain ES modules.

### 3.1 `signals/charonServer.js`

```ts
fetchSignals(): Promise<SignalEnvelope[]>
setCandidateHandler(fn: (envelope: SignalEnvelope) => Promise<void>): void
```

`SignalEnvelope = { source, mint, signature, payload, fetchedAtMs }`. Identical to `charon-v2/signals/serverClient.js`; copy with only the import paths and brand strings adapted.

### 3.2 `screening/metricsGate.js`

```ts
// Pure function. No I/O — reads enrichment from candidate.
gateCandidate(candidate, strat): {
  passed: boolean,
  failures: string[],
  riskFlags: string[],
}
```

Order of checks (return early on first failure):

1. `mint authority revoked` (Helius) — if missing, soft-fail (`riskFlags`), do not reject.
2. `token age` (`signals.ageMs` between min/max).
3. `mcap` (gmgn primary, jupiter fallback).
4. `holders min` (gmgn `holder_count`).
5. `top10 holder %` (jupiter holders distribution).
6. `fee/mcap ratio ≥ 0.0001`.
7. `holder risk reject score < 0.90` (re-uses `filters/holderRisk.js` from v2).

### 3.3 `screening/llmNarrative.js`

```ts
screenNarrative(candidate, strat): Promise<NarrativeVerdict>
revalidate(watchlistRow, strat): Promise<NarrativeVerdict>

NarrativeVerdict = {
  verdict: 'WATCH' | 'PASS' | 'REJECT',
  narrative_score: number,    // 0-100
  viral_potential: number,    // 0-100
  narrative_summary: string,
  risks: string[],
  reason: string,
  raw: any,                   // full LLM response for audit
}
```

**Prompt:** see §6 below.

**Failure handling:** on timeout / parse error, return `{ verdict: 'WATCH', narrative_score: 0, ..., reason: 'llm_unverified' }` and emit Telegram alert. The watchlist manager flags this row as `llm_unverified=1` so the user can review.

### 3.4 `watchlist/manager.js`

```ts
addToWatchlist(candidate, verdict): WatchlistRow
removeFromWatchlist(mint, reason): void
listActive(): WatchlistRow[]
isWatchlisted(mint): boolean
maybeEvictForNew(candidate, verdict): { admitted: boolean, evicted?: string }
markCooldown(mint, ms): void
```

**Eviction algorithm** (when `listActive().length >= watchlist_max`):

```
candidates_for_eviction = active rows ordered by:
  1. trend_status == 'downtrend' OR trend_status == 'reversing'
  2. vol_5m_usd < watchlist_low_volume_threshold_usd
  3. last_revalidated llm_verdict == 'PASS'
  4. narrative_score ASC
  5. added_at_ms ASC (oldest first within same score)

if top candidate score is "weaker" than incoming:
  evict it; admit new
else:
  reject incoming (status='evicted_at_intake', logged to watchlist_events)
```

"Weaker than incoming" defined: incoming `narrative_score > existing_min - 10` AND incoming was just freshly screened.

### 3.5 `watchlist/monitor.js`

Loop body (every 30s):

```
for mint in listActive():
  tf = pickTimeframe(tokenAgeMs)
  candles = fetchCandles(mint, tf, 80)         // GMGN primary
  ind = computeIndicators(candles)             // EMA20, EMA50, StochRSI(14,3,3), ATR
  trend = scoreTrend(candles, ind, vol)
  update watchlist row + insert watchlist_ticks
  if trend.status == 'downtrend' && trend_score <= reversal_max_score:
       removeFromWatchlist(mint, 'trend_reversal')
       continue
  if cooldown_until_ms > now: continue
  evalA = evaluateSignalA(candles, ind, strat)
  evalB = evaluateSignalB(candles, ind, vol, ath, strat)
  if evalA.entry || evalB.entry:
       triggerEntry(mint, evalA.entry ? 'A' : 'B', candidate)
parallel: at most 5 concurrent fetches (chart API throttle)
```

### 3.6 `watchlist/trendDetector.js`

See §4.1 — algorithm spec.

### 3.7 `chart/*.js`

```ts
// adaptiveTimeframe.js
pickTimeframe(tokenAgeMs): '30s' | '1m' | '5m'

// gmgnChart.js
fetchGmgnCandles(mint, tf, count): Promise<Candle[]>
// Maps Apex tf strings to GMGN intervals: '30s' → '1s' interval × 30 aggregated, or '1m'.
// Returns Candle = { t, o, h, l, c, v }

// jupiterChart.js
fetchJupiterCandles(mint, tf, count): Promise<Candle[]>
// Fallback. Jupiter supports 1_SECOND/5_MINUTE/etc; map best-fit.

// indicators.js (vendored from v2 filters/technicalAnalysis.js, no I/O)
ema(values, period)
rsi(values, period=14)
stochRsi(values, period=14, smoothK=3, smoothD=3)
atr(candles, period=14)
zscore(values)             // (last - mean) / stddev
```

### 3.8 `entry/signalA.js`, `entry/signalB.js`

```ts
evaluateSignalA(candles, ind, strat): {
  entry: boolean,
  reasons: string[],   // human-readable check trace
  metrics: { lastEma, lastK, prevK, lastClose, prevClose, twoCandleConfirm },
}

evaluateSignalB(candles, ind, vol, ath, strat): {
  entry: boolean,
  reasons: string[],
  metrics: { volRatio, volZ, athDipPct, recoveryFromTrough },
}
```

See §4.3 (A) and §4.4 (B).

### 3.9 `execution/probe.js`

```ts
openProbe(mint, candidate, signalKind): Promise<positionId>
// Buys probe_size_pct of position_size_sol via execution/router.

evaluateProbe(positionId): Promise<'pending'|'confirmed'|'failed'|'inconclusive'>
// Called by execution/positions monitor every 10s for probe_state == 'open'.

executeAddon(positionId): Promise<void>
// Buys remaining (100 - probe_size_pct)% of position_size_sol.
```

### 3.10 `execution/exits.js`

```ts
evaluateExit(position, marketSnapshot, ind): {
  action: 'hold' | 'partial_tp' | 'trail_exit' | 'sl_exit' | 'trend_exit',
  sellPct: number,    // 40 for partial_tp, 100 for full exits
  reason: string,
}
```

Order of evaluation (first hit wins):

```
if pnl_pct <= sl_pct                         → sl_exit (100%)
if trailing_armed && drawdown_from_peak >= trailing_pct
                                             → trail_exit (100%)
if !partial_tp_done && stoch_k > 80 && pnl_pct > 0
                                             → partial_tp (40%); arms trailing
if trend_status == 'reversing' && pnl_pct > 0
                                             → trend_exit (100%)   // only if in profit
else                                         → hold
```

### 3.11 `execution/positions.js`

Driver loop (every 10s). Reuses existing v2 pattern:

1. Refresh price/mcap (gmgn → jupiter fallback)
2. For probes pending: call `evaluateProbe`
3. For open positions: call `evaluateExit`
4. Call `execution/router` for fills; mutate position row + insert `position_events`
5. On exit: set `cooldown_until_ms = now + reentry_cooldown_ms` on watchlist row

### 3.12 `execution/router.js`, `liveExecutor.js`

Carry over from v2 unchanged except:
- Brand strings (`charon-v2` → `apex`)
- Slippage default raised to 500 bps for probe orders (smaller size, OK to pay).

### 3.13 `db/*` modules

Thin wrappers. New modules:

```
db/connection.js     # init + migrations + seed apex_obicle
db/watchlist.js      # CRUD on watchlist + ticks + events
db/positions.js      # CRUD + probe state + position_events
db/blacklist.js      # add/remove/check
db/chartCache.js     # get/put with TTL
db/decisions.js      # llm_decisions + decision_logs (carry-over)
db/settings.js       # carry-over (key/value + activeStrategy())
db/candidates.js     # carry-over
db/intents.js        # carry-over (confirm-mode)
```

Carry-over modules require only string rebrand; no logic change.

---

## 4. Algorithm Specs

### 4.1 Trend Detector (research-backed options)

We need a robust uptrend/downtrend classifier that avoids both lag and whipsaw on
30s/1m candles. Three options, with tradeoffs:

#### Option A — Simple stack (lowest latency)

```
ema_slope_5  = (ema20[last] - ema20[last-5]) / ema20[last-5]
hh_hl        = last 3 candle highs strictly increasing AND lows strictly increasing
vol_uptick   = vol_5m > 1.0 × vol_1h_avg

uptrend       = ema_slope_5 > 0 AND hh_hl AND vol_uptick
downtrend     = ema_slope_5 < 0 AND lh_ll
trend_score   = 100 if uptrend, 0 if downtrend, 50 otherwise
```

Pros: fast, simple. Cons: binary, noisy on choppy candles.

#### Option B — EMA stack + price (medium robustness)

```
uptrend       = ema20 > ema50 AND price > ema20 AND vol_z > 0
downtrend     = ema20 < ema50 AND price < ema20
trend_score   = sigmoid weighted by ema gap + price-EMA distance
```

Pros: lag-free near reversals, robust on noisy data. Cons: needs 50 candles min;
EMA50 unavailable for very fresh tokens.

#### Option C — Combined weighted score (recommended) ⭐

```
score = 0
+ 25 if ema20 > ema50            (or +12 if ema50 not available and price > ema20)
+ 20 if ema_slope_5 > 0
+ 15 if last 3 candle closes form HH (close[i] > close[i-1])
+ 15 if last 3 candle lows form HL  (low[i] > low[i-1])
+ 15 if vol_5m > vol_1h_avg
+ 10 if vol_z > 0   // vs 12-candle 5m volume

trend_status =
  'uptrend'    if score >= 60
  'reversing'  if 35 < score < 60
  'downtrend'  if score <= 35
```

Pros: degrades gracefully when sub-signals are missing, single threshold for both
admission and exit, easy to tune. Cons: weights are heuristic — first 30 days of
production data should refine via correlation with realized outcomes.

**Decision:** ship Option C as default. Make weights configurable via strategy config
(`trend_weights_json` if user wants to tune later). Settings `trend_uptrend_min_score`
and `trend_reversal_max_score` directly drive watchlist removal.

### 4.2 Adaptive Timeframe

```
pickTimeframe(tokenAgeMs):
  if tokenAgeMs < 6h          → '30s'
  else if tokenAgeMs < 48h    → '1m'
  else                        → '5m'
```

Source preference: GMGN primary (supports 1s/30s aggregation),
Jupiter fallback for 1m and above.

`fetchCandles(mint, tf, count)` flow:

```
1. cacheKey = `${mint}:${tf}`; if chart_cache hit (< ttl) → return
   ttl = 15s for 30s, 30s for 1m, 60s for 5m
2. try gmgn → cache + return
3. on gmgn 429 / 5xx → try jupiter (best-fit tf mapping)
4. on both fail → return [] (caller handles)
```

GMGN throttle: per-key token bucket, 1 call / 5s. Calls beyond rate get queued
(max wait 10s), else dropped with a `chart_throttled` log line.

### 4.3 Entry Signal A — Obicle TA

Trigger when ALL conditions hold on the most recent closed candle:

1. **EMA touch:** `low[last] <= ema20[last] * 1.005` (price wicked into or below EMA20)
2. **Stoch RSI bottom:** `stoch_k[last] < 20` AND `stoch_k[last] > stoch_k[last-1]` (turning up)
3. **Two-candle close above EMA:** `close[last] > ema20[last] AND close[last-1] > ema20[last-1]`

Only counts on closed candles. Rolling candle is ignored to avoid premature triggers.

### 4.4 Entry Signal B — Momentum Reversal

#### 4.4.1 Volume spike (combined gate)

Lookback: last 12 closed 5m candles (1h window). Use 5m candles even when monitoring
on 30s/1m for volume stats — small candles too noisy.

```
vol_avg = mean(vol_5m_array[0..11])
vol_std = stddev(vol_5m_array[0..11])
vol_ratio = vol_5m_array[12] / vol_avg            # current vs avg
vol_z     = (vol_5m_array[12] - vol_avg) / vol_std

spike = vol_ratio >= 3 AND vol_z >= 2
```

Optional refinement (logged but not gating in v1): `buy_share = (buys_5m / total_5m)`;
require `buy_share >= 0.55` if available from GMGN feed. Not all sources expose buy share, so default off.

#### 4.4.2 ATH dip + recovery (adaptive)

```
ath_price            = max close over watchlist lifetime (tracked in watchlist row)
ath_age_ms           = now - ath_at_ms
trough_price         = min close since ath
trough_age_ms        = now - trough_at_ms
ath_dip_pct          = (trough_price - ath_price) / ath_price * 100      # negative
recovery_from_trough = (current - trough_price) / trough_price * 100     # positive
```

Adaptive threshold for valid dip — scale with realized 1h volatility:

```
volatility_score = clamp( atr14_5m / mean(close_5m, 12), 0, 0.4 ) / 0.4  # → 0..1
required_dip_min = -50  - 30 * volatility_score                          # → -50..-80
```

Higher recent volatility ⇒ deeper dip required to qualify.

Trigger when:

```
ath_dip_pct <= required_dip_min                  AND
ath_dip_pct >= -85                               AND       # not full rug
recovery_from_trough >= 8                        AND       # bounce confirmed
volume spike fired in current 5m candle          AND
ath_age_ms <= 6h                                            # discard stale ATHs
```

### 4.5 Probe State Machine

```
                        ┌──────────────┐
  signal A or B  ───►   │  probe_open  │
                        └──────┬───────┘
                               │ every 10s (positions monitor)
            ┌──────────────────┼──────────────────┐
            ▼                  ▼                  ▼
   pnl >= +3% AND          pnl <= -7%        4m elapsed
   confirm checks           in 4m            (else)
            │                  │                  │
            ▼                  ▼                  ▼
   ┌─────────────────┐  ┌──────────────┐  ┌────────────────────┐
   │ probe_confirmed │  │ probe_failed │  │ probe_inconclusive │
   └────────┬────────┘  └──────┬───────┘  └─────────┬──────────┘
            │                  │                    │
   add-on 75% of size   close 100% (small loss)  hold probe-only
            │                  │             (no add-on, normal exits)
            ▼                  ▼                    ▼
        positions.status = open / closed
```

#### 4.5.1 Confirmation criteria (research alternatives)

Default:

```
pnl_pct >= probe_confirm_min_pnl_pct (3%) within probe_max_age_ms (4m)
```

Alternative criteria (kept as additive guards; strategy-config flags to enable):

| Flag | Check | Why |
|---|---|---|
| `probe_require_volume_holding` | `vol_5m >= 0.5 × vol_at_entry` | Avoid confirming on volume cliff |
| `probe_require_ema_bullish` | `ema_slope_5 > 0` | Avoid confirming during reversal |
| `probe_require_no_overbought` | `stoch_k < 70` | Avoid topping into euphoria |
| `probe_require_above_entry_ema` | `current > ema20_at_entry` | Skip dead-cat bounces |

**Recommended ship:** all four flags ON by default. Tradeoff: lower confirmation rate
but higher quality. If post-deployment data shows confirmation < 30%, relax to
volume-holding only. Each flag is a hot-tuneable strategy setting.

### 4.6 Watchlist Eviction (already in §3.4)

— see module contract. The eviction order encodes user-stated priority:

```
1. trend reversed / downtrend
2. low volume (< $1K in last 5m)
3. LLM revalidation said PASS
4. lowest narrative_score
5. oldest in watchlist
```

### 4.7 LLM Revalidation

Every 10 minutes per watchlist row, send to LLM with current trend_status and updated
candidate snapshot. If verdict flips to `PASS`, evict. If still `WATCH` or `REJECT`,
update narrative_score; on REJECT also blacklist.

---

## 5. Pipeline Flow (end-to-end)

```
                                   ┌──────────────────────────┐
                                   │ Charon API (30s poll)    │
                                   └──────────────┬───────────┘
                                                  │
                                                  ▼
                                  ┌────────────────────────────┐
                                  │ candidates table (status=  │
                                  │ new) — dedup window 10m    │
                                  └──────────────┬─────────────┘
                                                 │
                                                 ▼
                            enrichment: gmgn, jupiter, holders, twitter, authority
                                                 │
                                                 ▼
                                ┌──────────────────────────────┐
                                │ metricsGate.gateCandidate    │
                                │ pass? → status='screened'    │
                                │ fail? → status='filtered'    │
                                └──────────────┬───────────────┘
                                               │ pass
                                               ▼
                                ┌──────────────────────────────┐
                                │ llmNarrative.screenNarrative │
                                │ → WATCH/PASS/REJECT          │
                                └──────────────┬───────────────┘
                                               │ WATCH
                                               ▼
                                ┌──────────────────────────────┐
                                │ watchlist.maybeEvictForNew   │
                                │ + watchlist insert           │
                                └──────────────┬───────────────┘
                                               │
            ┌──────────────────────────────────┴───────────────────────────────┐
            │                                                                  │
            ▼ (every 30s in monitor)                                           ▼ (every 10m)
   ┌──────────────────────┐                                          ┌─────────────────────┐
   │ chart fetch + ind    │                                          │ llmNarrative.       │
   │ trendDetector.score  │                                          │ revalidate          │
   │ evalA + evalB        │                                          │ → flip PASS? evict  │
   └──────────┬───────────┘                                          └─────────────────────┘
              │ entry signal
              ▼
   ┌──────────────────────┐
   │ probe.openProbe(25%) │
   └──────────┬───────────┘
              │ (every 10s)
              ▼
   ┌──────────────────────┐    confirmed    ┌───────────────────────┐
   │ probe.evaluateProbe  ├────────────────►│ probe.executeAddon    │
   └──────────┬───────────┘                 └───────────────────────┘
              │ failed/incon
              ▼
   ┌──────────────────────┐    every 10s   ┌───────────────────────┐
   │ exits.evaluateExit   │◄──────────────►│ Position monitoring   │
   └──────────────────────┘                 └───────────────────────┘
```

---

## 6. LLM Prompt Template (final)

Adapted from `charon-main/src/pipeline/llm.js` (the original `compactCandidateForLlm`
+ `decideCandidateBatch`). New schema: `verdict | narrative_score | viral_potential | risks`.

### 6.1 System message

```
You are Apex, a Solana memecoin narrative analyst.
Return strict JSON only — no prose, no code fences, no commentary.

You evaluate ONE freshly graduated Solana memecoin at a time and judge whether its
NARRATIVE merits adding it to the watchlist for technical-entry monitoring.

Use these dimensions:
1. Twitter narrative quality — coherence of story, account quality (followers,
   account age, prior posts), engagement (likes, RTs, replies, views).
2. Viral potential — does the meme/story have a hook that crypto twitter will
   amplify (cultural moment, AI/political/celeb tie-in, community angle)?
3. Sanity check — flags missed by metrics: copy-cat narrative, suspicious
   coordinated launches, sniper / bundler concentration patterns.

Verdict semantics:
- WATCH = narrative is strong enough to monitor for TA entry. Default for
  anything mid-quality and above.
- PASS  = narrative is uninteresting but not malicious; skip without blacklisting.
- REJECT = narrative looks scammy, copy-paste, or otherwise unsafe; blacklist this mint.

Score scales: narrative_score and viral_potential are 0-100, your conviction (NOT
probability). Calibrate so an average graduated meme scores ~40 and a clearly
breakout-worthy story scores 75+.

Chart data is ATH/range context. Do not penalize a token only because 24h change
is huge — that is normal for new graduations.
```

### 6.2 User payload

```json
{
  "task": "Decide WATCH / PASS / REJECT for one candidate.",
  "recent_lessons": ["..."],
  "output_schema": {
    "verdict": "WATCH|PASS|REJECT",
    "narrative_score": "integer 0-100",
    "viral_potential": "integer 0-100",
    "narrative_summary": "short string (<=200 chars)",
    "risks": ["array of short risk tags"],
    "reason": "one-sentence rationale"
  },
  "candidate": {
    "mint": "...",
    "token": { "symbol": "...", "name": "...", "twitter": "..." },
    "signals": { "route": "...", "ageMs": ... },
    "metrics": {
      "marketCapUsd": ...,
      "priceUsd": ...,
      "liquidityUsd": ...,
      "holderCount": ...
    },
    "trending": { "volume": ..., "swaps": ..., "smart_degen_count": ... },
    "holders": { "top10HolderPercent": ..., "maxHolderPercent": ..., "savedWalletCount": ... },
    "chart": {
      "currentNative": ...,
      "rangeHighNative": ...,
      "distanceFromAthPercent": ...,
      "topBlastRisk": ...
    },
    "twitterNarrative": {
      "tweetText": "...",
      "authorFollowers": ...,
      "authorAccountAgeDays": ...,
      "engagement": { "likes": ..., "retweets": ..., "replies": ..., "views": ... }
    },
    "filters": { "passed": true, "riskFlags": [...] }
  }
}
```

### 6.3 Parsing & guards

```
parsed = strictJsonFromText(content)
verdict = uppercase(parsed.verdict ∈ {WATCH,PASS,REJECT}) — default WATCH on parse fail
narrative_score = clamp(int(parsed.narrative_score), 0, 100) — default 0
viral_potential = clamp(int(parsed.viral_potential), 0, 100) — default 0
risks = (Array.isArray(parsed.risks) ? parsed.risks : []).map(String).slice(0, 8)
reason = String(parsed.reason || '').slice(0, 1000)
```

### 6.4 Provider config

```
ENABLE_LLM=true
LLM_BASE_URL=https://api.minimax.io/v1   # default; OpenAI-compatible
LLM_MODEL=MiniMax-M2.7                    # adjustable to DeepSeek V4 Pro etc.
LLM_API_KEY=<key>
LLM_TIMEOUT_MS=60000
```

---

## 7. Environment Variables

`.env.example` (final):

```dotenv
# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_TOPIC_ID=

# Charon signal server (paid, signal source ONLY)
SIGNAL_SERVER_URL=https://api.thecharon.xyz/api
SIGNAL_SERVER_KEY=
SIGNAL_POLL_MS=30000

# Helius (RPC + token authority check)
HELIUS_API_KEY=

# GMGN — primary chart + token info
GMGN_API_KEY=
GMGN_REQUEST_DELAY_MS=5000
GMGN_MAX_RETRIES=2

# Jupiter — fallback chart + execution
JUPITER_API_KEY=
JUPITER_SWAP_BASE_URL=https://api.jup.ag/swap/v2
JUPITER_SLIPPAGE_BPS=300

# Wallet (live mode only)
SOLANA_PRIVATE_KEY=
LIVE_MIN_SOL_RESERVE=0.05

# LLM
ENABLE_LLM=true
LLM_BASE_URL=https://api.minimax.io/v1
LLM_API_KEY=
LLM_MODEL=MiniMax-M2.7
LLM_TIMEOUT_MS=60000

# DB & runtime
DB_PATH=./apex.sqlite
TRADING_MODE=dry_run
POSITION_CHECK_MS=10000
WATCHLIST_MONITOR_MS=30000
WATCHLIST_REVALIDATE_MS=600000
WATCHLIST_STATUS_PUSH_MS=300000
ENABLE_DAILY_REPORT=true
```

---

## 8. Project Structure (final, deploy-ready)

```
apex/
├── .env.example
├── .gitignore                      # ignores .env, node_modules, *.sqlite, logs/
├── README.md
├── DEPLOY.md                       # VPS upload procedure
├── CHANGELOG.md
├── package.json                    # name: "apex", v3.0.0
├── package-lock.json               # committed; generated on first npm install
├── ecosystem.config.cjs            # PM2; process name 'apex'
├── index.js                        # entrypoint
├── specs/
│   ├── requirements.md
│   └── design.md
├── scripts/
│   ├── smoke-test.js
│   └── init-test.js
├── src/
│   ├── app.js
│   ├── config.js
│   ├── utils.js
│   ├── format.js
│   ├── liveExecutor.js
│   ├── signals/
│   │   └── charonServer.js
│   ├── screening/
│   │   ├── metricsGate.js
│   │   ├── llmNarrative.js
│   │   └── llmPrompts.js
│   ├── watchlist/
│   │   ├── manager.js
│   │   ├── monitor.js
│   │   └── trendDetector.js
│   ├── chart/
│   │   ├── gmgnChart.js
│   │   ├── jupiterChart.js
│   │   ├── adaptiveTimeframe.js
│   │   └── indicators.js
│   ├── entry/
│   │   ├── signalA.js
│   │   ├── signalB.js
│   │   └── orchestrator.js
│   ├── execution/
│   │   ├── probe.js
│   │   ├── exits.js
│   │   ├── router.js
│   │   └── positions.js
│   ├── enrichment/
│   │   ├── gmgn.js
│   │   ├── jupiter.js
│   │   ├── tokenAuthority.js
│   │   ├── twitter.js
│   │   └── wallets.js
│   ├── filters/
│   │   ├── holderRisk.js
│   │   └── washTrade.js
│   ├── telegram/
│   │   ├── bot.js
│   │   ├── commands.js
│   │   ├── menus.js
│   │   ├── format.js
│   │   ├── send.js
│   │   ├── callbacks.js
│   │   └── input.js
│   ├── learning/
│   │   ├── dailyReport.js
│   │   ├── lessons.js
│   │   ├── summary.js
│   │   └── report.js
│   └── db/
│       ├── connection.js
│       ├── settings.js
│       ├── candidates.js
│       ├── watchlist.js
│       ├── chartCache.js
│       ├── blacklist.js
│       ├── positions.js
│       ├── trades.js
│       ├── decisions.js
│       └── intents.js
└── logs/                           # populated by PM2 only — empty in repo (.gitkeep)
```

### 8.1 What is NOT shipped (explicit exclusion list)

`.gitignore` covers, but to be explicit — do NOT zip these into the VPS upload:

- `node_modules/` (Windows native binaries break on Linux — this bit us on charon-v2)
- `*.sqlite`, `*.sqlite-journal`, `*.sqlite-wal`, `*.sqlite-shm`
- `.env` (never; only `.env.example`)
- `logs/*.log`
- `.DS_Store`, `Thumbs.db`, `desktop.ini`
- Any folder from the workspace OUTSIDE `apex/` (`charon-main/`, `charon-v2/`, `TRENCHING BOT/`, `*.zip`)
- IDE folders (`.vscode/`, `.idea/`)

The zip uploaded to VPS contains ONLY the tree shown in §8.

---

## 9. Migration Plan (charon-v2 → Apex)

Apex is a **fresh deployment** — not an in-place upgrade — so migration is shallow.
charon-v2 keeps running until Apex passes 7d acceptance, then is stopped.

### 9.1 Code reuse (copy + rebrand only)

These v2 files are functionally fine; copy and change strings only:

| v2 file | apex destination | Change |
|---|---|---|
| `src/utils.js` | `src/utils.js` | nil |
| `src/format.js` | `src/format.js` | brand strings |
| `src/liveExecutor.js` | `src/liveExecutor.js` | brand strings |
| `src/enrichment/gmgn.js` | `src/enrichment/gmgn.js` | nil |
| `src/enrichment/jupiter.js` | `src/enrichment/jupiter.js` | nil |
| `src/enrichment/tokenAuthority.js` | same | nil |
| `src/enrichment/twitter.js` | same | nil |
| `src/enrichment/wallets.js` | same | nil |
| `src/filters/holderRisk.js` | `src/filters/holderRisk.js` | nil |
| `src/filters/washTrade.js` | `src/filters/washTrade.js` | nil |
| `src/filters/technicalAnalysis.js` | split → `src/chart/indicators.js` (math) + dropped (network) | math only; chart fetch moves to `chart/gmgnChart.js` |
| `src/signals/serverClient.js` | `src/signals/charonServer.js` | rename + brand |
| `src/telegram/*` | `src/telegram/*` | brand + new commands |
| `src/learning/*` | `src/learning/*` | brand + watchlist metrics in dailyReport |
| `src/db/settings.js` | same | nil |
| `src/db/candidates.js` | same | nil |
| `src/db/intents.js` | same | nil |
| `ecosystem.config.cjs` | same | name → 'apex'; logs path |
| `package.json` | same | name → 'apex' |
| `index.js` | same | brand strings |

Anything **not** in this table is rewritten from scratch (watchlist, entry, probe,
exits, screening, charts, trendDetector).

### 9.2 Data migration

**No live data migrated.** Apex starts with a fresh `apex.sqlite`. charon-v2 history
remains in `charon.sqlite` for retrospective analysis. This is intentional — schemas
are different enough that a copy would be lossy.

### 9.3 Coexistence on VPS

During cutover (~7 days), both bots run side-by-side under PM2:

```
pm2 list
┌────┬───────────┬─────────┬──────────┐
│ id │ name      │ status  │ cwd      │
├────┼───────────┼─────────┼──────────┤
│  0 │ charon    │ online  │ /home/apex/charon │   ← legacy charon-v2
│  1 │ apex      │ online  │ /home/apex/apex   │   ← new
└────┴───────────┴─────────┴──────────┘
```

Different `.env` files, different DB filenames, different Telegram chat IDs (or topic
IDs in same chat) so notifications don't intermix.

After acceptance, `pm2 stop charon && pm2 delete charon`. Keep the directory & db on
disk for 30 days, then archive.

---

## 10. Deployment Plan (VPS upload-ready)

Goal: a single zip that drops onto Tencent OpenCloudOS 9.4 at `/home/apex/apex` and
starts cleanly. No Windows artifacts, no `node_modules`, no DBs.

### 10.1 Pre-deploy checklist (local Windows)

```
0. cd c:\Project\Apex\apex
1. npm install                # generates package-lock.json (commit it)
2. node --check src/app.js    # all files syntactically valid
3. npm run check              # batch check via package.json script
4. npm run smoke              # offline smoke (no network)
5. Verify .env is git-ignored. .env.example is committed.
6. Verify .gitignore excludes node_modules, *.sqlite, logs/*.log
```

### 10.2 Build the deploy zip

```cmd
:: from c:\Project\Apex\apex
powershell -Command "Compress-Archive -Path index.js,package.json,package-lock.json,ecosystem.config.cjs,.env.example,README.md,DEPLOY.md,CHANGELOG.md,scripts,src,specs -DestinationPath ..\apex-deploy.zip -Force"
```

The zip MUST NOT contain: `node_modules`, `.env`, `*.sqlite*`, `logs/`, IDE folders.

### 10.3 VPS bootstrap (run as `apex` user via ssh)

```bash
# 1. Upload + extract
mkdir -p /home/apex/apex
cd /home/apex/apex
unzip /tmp/apex-deploy.zip
cp .env.example .env
nano .env                    # fill keys

# 2. Install Linux-native node_modules (NEVER copy from Windows)
rm -rf node_modules
npm install --omit=dev

# 3. Smoke check
node --check src/app.js
node scripts/smoke-test.js   # offline; passes without external calls

# 4. PM2
mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 save
# pm2 startup output → run sudo command shown to enable boot autostart

# 5. Verify
pm2 list                     # 'apex' should be online
pm2 logs apex --lines 50     # should show '[bot] Apex started'
```

### 10.4 PM2 config

`ecosystem.config.cjs`:

```js
module.exports = {
  apps: [{
    name: 'apex',
    script: 'index.js',
    cwd: __dirname,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: { NODE_ENV: 'production' },
    min_uptime: '30s',
    max_restarts: 10,
    restart_delay: 5000,
    error_file: './logs/apex.error.log',
    out_file: './logs/apex.out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    kill_timeout: 5000,
    listen_timeout: 8000,
    shutdown_with_message: true,
  }],
};
```

### 10.5 Backup & log rotation

Keep the v2 cron pattern (proven on this VPS):

```
# /etc/cron.d/apex-backup
0 3 * * * apex /usr/bin/sqlite3 /home/apex/apex/apex.sqlite ".backup /home/apex/apex/backups/apex-$(date +\%F).sqlite" && find /home/apex/apex/backups -name 'apex-*.sqlite' -mtime +14 -delete
```

PM2 logrotate (already installed on VPS):

```
pm2 install pm2-logrotate              # already done globally
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
```

### 10.6 Rollback

If acceptance fails:

```
pm2 stop apex
pm2 delete apex
# charon (v2) is still running, traffic continues unchanged
```

DB and code remain on disk for forensics.

---

## 11. Verification & Acceptance Hooks

### 11.1 `npm run check`

Static syntax check on every source file:

```json
{
  "scripts": {
    "check": "node --check index.js && node --check src/app.js && node --check src/config.js && node --check src/utils.js && node --check src/liveExecutor.js && node --check src/signals/charonServer.js && node --check src/screening/metricsGate.js && node --check src/screening/llmNarrative.js && node --check src/watchlist/manager.js && node --check src/watchlist/monitor.js && node --check src/watchlist/trendDetector.js && node --check src/chart/gmgnChart.js && node --check src/chart/jupiterChart.js && node --check src/chart/adaptiveTimeframe.js && node --check src/chart/indicators.js && node --check src/entry/signalA.js && node --check src/entry/signalB.js && node --check src/execution/probe.js && node --check src/execution/exits.js && node --check src/execution/positions.js && node --check src/execution/router.js && node --check src/db/connection.js && node --check src/db/watchlist.js && node --check src/db/positions.js"
  }
}
```

### 11.2 Smoke test (`scripts/smoke-test.js`)

Offline assertions:
1. DB initializes cleanly
2. `metricsGate.gateCandidate` rejects an obvious bad candidate fixture
3. `metricsGate.gateCandidate` accepts a healthy fixture
4. `chart/indicators` produces valid EMA / Stoch RSI on a known input series
5. `watchlist/trendDetector` returns expected status for synthetic candle sets
6. `entry/signalA.evaluateSignalA` fires on a constructed bullish reversal
7. `entry/signalB.evaluateSignalB` fires on synthetic volume spike
8. `probe.evaluateProbe` returns confirmed/failed/inconclusive for fixture inputs

Exit code non-zero on any assertion failure. Used pre-deploy.

### 11.3 Init test (`scripts/init-test.js`)

Spins up DB at `apex.test-init.sqlite`, runs all CREATE TABLE + ALTER TABLE
migrations, asserts schema matches. Cleans up on success.

---

## 12. Open Decisions Captured

| # | Decision | Resolution |
|---|---|---|
| 1 | Trend detector | **Option C — combined weighted score (default)** |
| 2 | Watchlist eviction order | as in §3.4 (matches user spec) |
| 3 | ATH dip threshold | **adaptive `-50..-80` via volatility scaling** (§4.4.2) |
| 4 | Volume spike | **3× avg AND z ≥ 2 over 12×5m lookback** (§4.4.1) |
| 5 | LLM prompt | **§6** (adapted from charon `compactCandidateForLlm`) |
| 6 | Adaptive TF source | **GMGN primary, Jupiter fallback** |
| 7 | Probe confirmation | **+3% in 4m + all 4 alt-criteria flags ON** (§4.5.1) |

---

## 13. Approval Gate

**Pending sign-off:**
- [ ] §2 DB schema (new tables + position alters)
- [ ] §3 module contracts
- [ ] §4 algorithm specs (trend detector C, signal A, signal B, probe SM)
- [ ] §6 LLM prompt
- [ ] §8 project structure
- [ ] §9 migration plan (no data migration)
- [ ] §10 deployment plan (zip excludes node_modules, *.sqlite, .env, logs)

**Next step after approval:** Implementation phase. Build order:

1. DB layer (`db/*` + `connection.js` migrations) → smoke
2. Chart layer (`chart/*`) + reuse `indicators` math from v2
3. Screening layer (`screening/metricsGate`, `screening/llmNarrative`)
4. Watchlist (`watchlist/manager`, `monitor`, `trendDetector`)
5. Entry (`entry/signalA`, `signalB`, `orchestrator`)
6. Execution (`execution/probe`, `exits`, `positions`)
7. Telegram commands + daily report
8. End-to-end smoke + 24h dry-run on VPS
