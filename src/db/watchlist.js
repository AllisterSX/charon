import { db } from './connection.js';
import { now, json, safeJson } from '../utils.js';

export function getWatchlistRow(mint) {
  const row = db.prepare('SELECT * FROM watchlist WHERE mint = ?').get(mint);
  return row || null;
}
export function isActiveWatchlist(mint) {
  const row = db.prepare('SELECT status FROM watchlist WHERE mint = ?').get(mint);
  return row?.status === 'active';
}
export function listActiveWatchlist() {
  return db.prepare('SELECT * FROM watchlist WHERE status = ? ORDER BY added_at_ms ASC').all('active');
}
export function activeWatchlistCount() {
  return db.prepare('SELECT COUNT(*) as c FROM watchlist WHERE status = ?').get('active').c;
}

export function insertWatchlistRow({ candidateId, candidate, verdict }) {
  const mint = candidate.token.mint;
  const symbol = candidate.token?.symbol || candidate.token?.name || null;
  const stmt = db.prepare(`
    INSERT INTO watchlist (
      mint, candidate_id, symbol, added_at_ms, status,
      narrative_score, viral_potential, llm_verdict, llm_reason, llm_unverified,
      last_revalidated_at_ms, snapshot_json
    )
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mint) DO UPDATE SET
      candidate_id = excluded.candidate_id,
      symbol = COALESCE(excluded.symbol, watchlist.symbol),
      added_at_ms = excluded.added_at_ms,
      status = 'active',
      removed_at_ms = NULL,
      removal_reason = NULL,
      narrative_score = excluded.narrative_score,
      viral_potential = excluded.viral_potential,
      llm_verdict = excluded.llm_verdict,
      llm_reason = excluded.llm_reason,
      llm_unverified = excluded.llm_unverified,
      last_revalidated_at_ms = excluded.last_revalidated_at_ms,
      snapshot_json = excluded.snapshot_json
  `);
  stmt.run(
    mint, candidateId, symbol, now(),
    Number(verdict?.narrative_score ?? 0),
    Number(verdict?.viral_potential ?? 0),
    String(verdict?.verdict || 'WATCH'),
    String(verdict?.reason || '').slice(0, 1000),
    verdict?.unverified ? 1 : 0,
    now(),
    json({ verdict }),
  );
}

export function updateWatchlistTick(mint, snapshot) {
  const fields = [];
  const params = [];
  for (const [k, v] of Object.entries(snapshot)) {
    if (v === undefined) continue;
    fields.push(`${k} = ?`);
    params.push(v);
  }
  if (!fields.length) return;
  fields.push('last_tick_at_ms = ?');
  params.push(now());
  params.push(mint);
  db.prepare(`UPDATE watchlist SET ${fields.join(', ')} WHERE mint = ?`).run(...params);
}

export function insertWatchlistTick(mint, ind) {
  db.prepare(`
    INSERT INTO watchlist_ticks (
      mint, at_ms, price_native, mcap_usd, vol_5m_usd,
      ema20, ema50, stoch_k, stoch_d, trend_score, trend_status, candle_tf, ind_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    mint, now(),
    ind.price ?? null, ind.mcap ?? null, ind.vol_5m_usd ?? null,
    ind.ema20 ?? null, ind.ema50 ?? null,
    ind.stoch_k ?? null, ind.stoch_d ?? null,
    ind.trend_score ?? null, ind.trend_status ?? null, ind.candle_tf ?? null,
    json({ ema_slope_5: ind.ema_slope_5 ?? null, source: ind.source ?? null }),
  );
}

export function logWatchlistEvent(mint, kind, reason, payload = {}) {
  db.prepare(`
    INSERT INTO watchlist_events (mint, at_ms, kind, reason, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(mint, now(), kind, reason || null, json(payload));
}

export function markWatchlistRemoved(mint, reason) {
  db.prepare(`
    UPDATE watchlist
    SET status = 'removed', removed_at_ms = ?, removal_reason = ?
    WHERE mint = ?
  `).run(now(), String(reason || '').slice(0, 200), mint);
}

export function setWatchlistCooldown(mint, untilMs, lastPositionId = null) {
  db.prepare(`
    UPDATE watchlist
    SET cooldown_until_ms = ?, last_position_id = COALESCE(?, last_position_id)
    WHERE mint = ?
  `).run(untilMs, lastPositionId, mint);
}

export function setWatchlistRevalidation(mint, verdict) {
  db.prepare(`
    UPDATE watchlist
    SET last_revalidated_at_ms = ?, narrative_score = ?, viral_potential = ?, llm_verdict = ?, llm_reason = ?
    WHERE mint = ?
  `).run(
    now(),
    Number(verdict?.narrative_score ?? 0),
    Number(verdict?.viral_potential ?? 0),
    String(verdict?.verdict || 'WATCH'),
    String(verdict?.reason || '').slice(0, 1000),
    mint,
  );
}

export function pruneWatchlistTicks(retentionMs = 7 * 24 * 3600 * 1000) {
  db.prepare('DELETE FROM watchlist_ticks WHERE at_ms < ?').run(now() - retentionMs);
}

export function watchlistRowSnapshot(mint) {
  const row = getWatchlistRow(mint);
  if (!row) return null;
  return { ...row, snapshot: safeJson(row.snapshot_json, {}) };
}
