// Watchlist manager (FR-4). Add/remove/evict logic + cooldown control.
// Eviction priority (per requirements §6.2 + design §3.4):
//   1. trend_status downtrend or reversing
//   2. vol_5m_usd < watchlist_low_volume_threshold_usd
//   3. last LLM revalidation == PASS
//   4. lowest narrative_score
//   5. oldest in watchlist (added_at_ms ASC)

import {
  insertWatchlistRow,
  listActiveWatchlist,
  activeWatchlistCount,
  markWatchlistRemoved,
  logWatchlistEvent,
  getWatchlistRow,
  setWatchlistCooldown,
} from '../db/watchlist.js';
import { isBlacklisted, addBlacklist } from '../db/blacklist.js';
import { activeStrategy } from '../db/settings.js';
import { now } from '../utils.js';
import { sendWatchlistAdmit, sendWatchlistRemove } from '../telegram/send.js';

export function isWatchlisted(mint) {
  const row = getWatchlistRow(mint);
  return Boolean(row && row.status === 'active');
}

// Try to admit a fresh candidate that already passed the LLM screen.
// Returns { admitted, evicted? } — admitted=false means watchlist is full and
// the incoming candidate isn't strong enough to displace anyone.
export function admitOrEvict(candidateId, candidate, verdict) {
  const mint = candidate.token.mint;
  if (isBlacklisted(mint)) {
    return { admitted: false, reason: 'blacklisted' };
  }

  const strat = activeStrategy();
  const max = Number(strat.watchlist_max ?? 25);
  const current = activeWatchlistCount();

  if (current < max) {
    insertWatchlistRow({ candidateId, candidate, verdict });
    logWatchlistEvent(mint, 'added', verdict?.reason || '', { score: verdict?.narrative_score });
    const newRow = getWatchlistRow(mint);
    if (newRow) sendWatchlistAdmit(newRow, verdict).catch(() => {});
    return { admitted: true };
  }

  // Watchlist full — try eviction.
  const evictTarget = pickEvictionTarget(strat);
  if (!evictTarget) {
    logWatchlistEvent(mint, 'admission_denied', 'watchlist_full_no_evict', { incomingScore: verdict?.narrative_score });
    return { admitted: false, reason: 'watchlist_full' };
  }

  // Compare strength: incoming admitted only if score > existing min - 10.
  // (Section 3.4 of design.md.)
  const existingScore = Number(evictTarget.narrative_score || 0);
  const incomingScore = Number(verdict?.narrative_score || 0);
  if (incomingScore <= existingScore - 10) {
    logWatchlistEvent(mint, 'admission_denied', 'incoming_weaker_than_evict_target', {
      incomingScore, existingScore, evictMint: evictTarget.mint,
    });
    return { admitted: false, reason: 'incoming_weaker' };
  }

  // Evict the weakest, admit incoming.
  removeFromWatchlist(evictTarget.mint, 'evicted_for_stronger_candidate', { incomingMint: mint, incomingScore });
  insertWatchlistRow({ candidateId, candidate, verdict });
  logWatchlistEvent(mint, 'added', verdict?.reason || '', {
    score: verdict?.narrative_score,
    displaced: evictTarget.mint,
  });
  const newRow = getWatchlistRow(mint);
  if (newRow) sendWatchlistAdmit(newRow, verdict).catch(() => {});
  return { admitted: true, evicted: evictTarget.mint };
}

function pickEvictionTarget(_strat) {
  const rows = listActiveWatchlist();
  if (!rows.length) return null;

  // Compute eviction-priority key per row, then pick the row with the highest
  // priority (largest tuple wins).
  // Tuple shape: (1 if downtrend/reversing else 0, 1 if low vol, 1 if PASS, -score, oldest_age_ms)
  const lowVolThreshold = Number(activeStrategy().watchlist_low_volume_threshold_usd ?? 1000);
  const at = now();
  const ranked = rows.map(row => {
    const trendBad = (row.trend_status === 'downtrend' || row.trend_status === 'reversing') ? 1 : 0;
    const lowVol = (Number(row.vol_5m_usd || 0) < lowVolThreshold) ? 1 : 0;
    const passVerdict = (String(row.llm_verdict || '').toUpperCase() === 'PASS') ? 1 : 0;
    return {
      row,
      key: [
        trendBad,
        lowVol,
        passVerdict,
        -Number(row.narrative_score || 0),    // lower score → higher priority for eviction
        at - Number(row.added_at_ms || 0),    // older first
      ],
    };
  });
  ranked.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) {
      if (a.key[i] !== b.key[i]) return b.key[i] - a.key[i]; // bigger wins
    }
    return 0;
  });
  return ranked[0].row;
}

export function removeFromWatchlist(mint, reason, payload = {}) {
  if (!isWatchlisted(mint)) return false;
  const row = getWatchlistRow(mint);
  const symbol = row?.symbol || null;
  markWatchlistRemoved(mint, reason);
  logWatchlistEvent(mint, 'removed', reason, payload);
  sendWatchlistRemove(mint, symbol, reason).catch(() => {});
  return true;
}

export function blacklistAndRemove(mint, reason) {
  addBlacklist(mint, reason);
  removeFromWatchlist(mint, `blacklist:${reason}`);
}

export function armCooldown(mint, ms, lastPositionId = null) {
  setWatchlistCooldown(mint, now() + Number(ms || 0), lastPositionId);
  logWatchlistEvent(mint, 'reentry_armed', `cooldown_ms=${ms}`, { lastPositionId });
}

export function isInCooldown(mint) {
  const row = getWatchlistRow(mint);
  if (!row || !row.cooldown_until_ms) return false;
  return now() < Number(row.cooldown_until_ms);
}
