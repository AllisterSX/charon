// Entry orchestrator — when a watchlist entry signal fires, this module
// decides whether to open a probe (FR-7) and forwards to execution.

import { activeStrategy } from '../db/settings.js';
import { latestCandidateByMint } from '../db/candidates.js';
import { getWatchlistRow } from '../db/watchlist.js';
import { openPositionCount, lastPositionForMint } from '../db/positions.js';
import { isInCooldown } from '../watchlist/manager.js';
import { logDecision } from '../db/decisions.js';
import { openProbe } from '../execution/probe.js';
import { now } from '../utils.js';

export async function onEntrySignal({ mint, signal, tf, evaluation, candles }) {
  const strat = activeStrategy();
  const watchlistRow = getWatchlistRow(mint);
  if (!watchlistRow || watchlistRow.status !== 'active') return null;
  if (isInCooldown(mint)) {
    logDecision({ mint, strategyId: strat.id, action: 'entry_skip', reason: 'cooldown_active', payload: { signal } });
    return null;
  }

  // Concurrency cap on open positions.
  const max = Number(strat.max_open_positions ?? 10);
  const open = openPositionCount();
  if (open >= max) {
    logDecision({ mint, strategyId: strat.id, action: 'entry_skip', reason: 'max_open_positions', payload: { signal, open, max } });
    return null;
  }

  // Avoid duplicate open position on same mint.
  const last = lastPositionForMint(mint);
  if (last && ['open', 'probe_open', 'probe_confirmed', 'probe_inconclusive'].includes(last.status)) {
    logDecision({ mint, strategyId: strat.id, action: 'entry_skip', reason: 'open_position_exists', payload: { positionId: last.id } });
    return null;
  }

  const candidateRow = latestCandidateByMint(mint);
  const candidate = candidateRow?.candidate || { token: { mint } };

  const positionId = await openProbe({
    candidate,
    candidateId: candidateRow?.id || null,
    watchlistRow,
    signal,
    tf,
    evaluation,
    candles,
    strat,
  });
  logDecision({
    mint, strategyId: strat.id,
    action: 'probe_opened',
    payload: { positionId, signal, tf, evaluationMetrics: evaluation?.metrics, openedAt: now() },
  });
  return positionId;
}
