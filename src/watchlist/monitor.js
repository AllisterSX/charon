// Watchlist monitor (FR-4.3). Runs every 30s.
// For each active watchlist row:
//   1. Pick adaptive timeframe based on token age
//   2. Fetch candles (GMGN primary → Jupiter fallback)
//   3. Compute indicators (EMA20/50, Stoch RSI)
//   4. Score trend; remove if downtrend
//   5. Evaluate Signal A and Signal B; trigger entry if either fires
//   6. Update watchlist row + insert tick row

import {
  listActiveWatchlist,
  updateWatchlistTick,
  insertWatchlistTick,
  logWatchlistEvent,
  setWatchlistRevalidation,
} from '../db/watchlist.js';
import { latestCandidateByMint } from '../db/candidates.js';
import { fetchCandlesAdaptive } from '../chart/jupiterChart.js';
import { pickTimeframe } from '../chart/adaptiveTimeframe.js';
import { ema, stochRsi } from '../chart/indicators.js';
import { scoreTrend } from './trendDetector.js';
import { evaluateSignalA } from '../entry/signalA.js';
import { evaluateSignalB } from '../entry/signalB.js';
import { activeStrategy } from '../db/settings.js';
import { isInCooldown, removeFromWatchlist, blacklistAndRemove } from './manager.js';
import { revalidateNarrative } from '../screening/llmNarrative.js';
import { recordLlmDecision } from '../db/decisions.js';
import { now, mean } from '../utils.js';
import { onEntrySignal } from '../entry/orchestrator.js';

// Concurrency cap on chart fetches per cycle (avoid hammering GMGN).
const FETCH_CONCURRENCY = 5;

export async function monitorWatchlist() {
  const strat = activeStrategy();
  const rows = listActiveWatchlist();
  if (!rows.length) return;

  const queue = [...rows];
  const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, () => worker(queue, strat));
  await Promise.all(workers);
}

async function worker(queue, strat) {
  while (queue.length) {
    const row = queue.shift();
    if (!row) break;
    try {
      await processRow(row, strat);
    } catch (err) {
      console.log(`[watchlist] ${row.mint?.slice(0, 8)}... error: ${err.message}`);
    }
  }
}

async function processRow(row, strat) {
  const mint = row.mint;
  const tokenAgeMs = computeTokenAge(row);
  const tf = pickTimeframe(tokenAgeMs);
  const { candles, source } = await fetchCandlesAdaptive(mint, tf, 80);
  if (!candles || candles.length < 25) {
    updateWatchlistTick(mint, { candle_tf: tf });
    return;
  }

  const closes = candles.map(c => Number(c.c));
  const lows   = candles.map(c => Number(c.l));
  const highs  = candles.map(c => Number(c.h));
  const vols   = candles.map(c => Number(c.v || 0));
  const last = closes.length - 1;
  const price = closes[last];

  const ema20Arr = ema(closes, 20);
  const ema50Arr = ema(closes, 50);
  const sr = stochRsi(closes, 14, 3, 3);
  const lastEma20 = ema20Arr?.[last] ?? null;
  const lastEma50 = ema50Arr?.[last] ?? null;
  const lastK = sr?.k?.[last] ?? null;
  const lastD = sr?.d?.[last] ?? null;

  const trend = scoreTrend(candles);
  const lookback = Math.min(12, vols.length - 1);
  const trailingVols = vols.slice(last - lookback, last);
  const vol5m = vols[last];
  const vol1hAvg = mean(trailingVols);

  const ath = computeAth(row, candles);
  const trough = computeTrough(row, candles, ath);

  // ── Persist tick ─────────────────────────────────────────────────────────
  insertWatchlistTick(mint, {
    price,
    mcap: row.current_mcap_usd,            // mcap refreshed by signal handler / future hook
    vol_5m_usd: vol5m,
    ema20: lastEma20,
    ema50: lastEma50,
    stoch_k: lastK,
    stoch_d: lastD,
    trend_score: trend.score,
    trend_status: trend.status,
    candle_tf: tf,
    source,
  });
  updateWatchlistTick(mint, {
    current_price_native: price,
    ema20: lastEma20,
    ema50: lastEma50,
    stoch_k: lastK,
    stoch_d: lastD,
    trend_status: trend.status,
    trend_score: trend.score,
    vol_5m_usd: vol5m,
    vol_1h_avg_usd: vol1hAvg,
    candle_tf: tf,
    ath_price_native: ath.price,
    ath_at_ms: ath.at,
    trough_price_native: trough.price,
    trough_at_ms: trough.at,
  });

  // ── Trend-based eviction ────────────────────────────────────────────────
  if (trend.status === 'downtrend') {
    removeFromWatchlist(mint, 'trend_reversal', { score: trend.score });
    return;
  }

  // ── Periodic LLM revalidation ───────────────────────────────────────────
  await maybeRevalidateLlm(row, mint);
  if (isInCooldown(mint)) return;

  // ── Entry signal evaluation ─────────────────────────────────────────────
  if (strat.sigA_enabled !== false) {
    const a = evaluateSignalA({ candles, ema20Arr, sr, strat });
    if (a.entry) {
      logWatchlistEvent(mint, 'entry_signal', 'signal_A', a);
      await onEntrySignal({ mint, signal: 'A', tf, evaluation: a, candles });
      return;
    }
  }
  if (strat.sigB_enabled !== false) {
    const b = evaluateSignalB({
      candles, vols, ath, trough, strat,
    });
    if (b.entry) {
      logWatchlistEvent(mint, 'entry_signal', 'signal_B', b);
      await onEntrySignal({ mint, signal: 'B', tf, evaluation: b, candles });
      return;
    }
  }
}

function computeTokenAge(row) {
  // We track tokenAge via the originating candidate.signals.ageMs at admission.
  // For long-lived watchlist rows, age is approximated as (now - addedAt) + originalAge.
  const addedAt = Number(row.added_at_ms || 0);
  const originalAge = Number(row.original_age_ms || 0);
  return Math.max(0, originalAge + (now() - addedAt));
}

function computeAth(row, candles) {
  const prevAth = Number(row.ath_price_native || 0);
  const prevAthAt = Number(row.ath_at_ms || 0);
  let athPrice = prevAth;
  let athAt = prevAthAt;
  for (const c of candles) {
    const high = Number(c.h);
    const ts = Number(c.t);
    if (Number.isFinite(high) && high > athPrice) {
      athPrice = high;
      athAt = ts > 0 ? ts : now();
    }
  }
  return { price: athPrice, at: athAt };
}

function computeTrough(row, candles, ath) {
  // Trough = lowest low recorded after the ATH.
  const prevTrough = Number(row.trough_price_native || 0);
  const prevTroughAt = Number(row.trough_at_ms || 0);
  let troughPrice = prevTrough || Infinity;
  let troughAt = prevTroughAt;
  for (const c of candles) {
    const low = Number(c.l);
    const ts = Number(c.t);
    if (!Number.isFinite(low) || low <= 0) continue;
    if (ts < ath.at) continue;     // only consider lows after ATH
    if (low < troughPrice) {
      troughPrice = low;
      troughAt = ts > 0 ? ts : now();
    }
  }
  if (!Number.isFinite(troughPrice) || troughPrice === Infinity) {
    return { price: null, at: null };
  }
  return { price: troughPrice, at: troughAt };
}

async function maybeRevalidateLlm(row, mint) {
  const strat = activeStrategy();
  if (!strat.use_llm) return;
  const interval = Number(strat.llm_revalidate_interval_ms || 600_000);
  const last = Number(row.last_revalidated_at_ms || 0);
  if (now() - last < interval) return;

  const candidateRow = latestCandidateByMint(mint);
  if (!candidateRow?.candidate) return;

  const verdict = await revalidateNarrative(candidateRow.candidate, strat);
  setWatchlistRevalidation(mint, verdict);
  recordLlmDecision({
    candidateId: candidateRow.id, mint, kind: 'revalidate', verdict,
  });
  logWatchlistEvent(mint, 'revalidated', verdict.reason, {
    score: verdict.narrative_score, verdict: verdict.verdict,
  });

  if (verdict.verdict === 'REJECT') {
    blacklistAndRemove(mint, verdict.reason || 'llm_reject_on_revalidate');
  } else if (verdict.verdict === 'PASS') {
    removeFromWatchlist(mint, 'llm_revalidation_pass', { reason: verdict.reason });
  }
}
