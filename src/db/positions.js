import { db } from './connection.js';
import { now, json, safeJson } from '../utils.js';

export function tradingMode() {
  const value = db.prepare("SELECT value FROM settings WHERE key = 'trading_mode'").get()?.value;
  return value || 'dry_run';
}

export function openPositions() {
  return db.prepare("SELECT * FROM positions WHERE status IN ('open','probe_open','probe_confirmed','probe_inconclusive') ORDER BY id DESC").all();
}
export function openPositionCount() {
  return db.prepare("SELECT COUNT(*) as c FROM positions WHERE status IN ('open','probe_open','probe_confirmed','probe_inconclusive')").get().c;
}
export function positionById(id) {
  return db.prepare('SELECT * FROM positions WHERE id = ?').get(Number(id)) || null;
}
export function allPositions(limit = 25) {
  return db.prepare('SELECT * FROM positions ORDER BY id DESC LIMIT ?').all(Number(limit));
}
export function positionsByMint(mint, limit = 10) {
  return db.prepare('SELECT * FROM positions WHERE mint = ? ORDER BY id DESC LIMIT ?').all(mint, Number(limit));
}
export function lastPositionForMint(mint) {
  return db.prepare('SELECT * FROM positions WHERE mint = ? ORDER BY id DESC LIMIT 1').get(mint) || null;
}

export function insertPosition({
  candidateId, mint, symbol, strategyId,
  executionMode, entrySignal, entryTf,
  sizeSol, probeSizeSol, entryPrice, entryMcap,
  tokenAmountEst, tokenAmountRaw, entrySignature,
  tpPercent, slPercent, trailingEnabled, trailingPercent,
  watchlistMint, llmDecisionId, snapshot,
}) {
  const ts = now();
  const result = db.prepare(`
    INSERT INTO positions (
      candidate_id, mint, symbol, strategy_id, status, execution_mode,
      entry_signal, entry_tf, opened_at_ms, size_sol, probe_size_sol, probe_state,
      entry_price, entry_mcap, token_amount_est, token_amount_raw, entry_signature,
      high_water_price, high_water_mcap, tp_percent, sl_percent,
      trailing_enabled, trailing_percent, trailing_armed, partial_tp_done,
      watchlist_mint, llm_decision_id, snapshot_json
    ) VALUES (
      ?, ?, ?, ?, 'probe_open', ?,
      ?, ?, ?, ?, ?, 'open',
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, 0, 0,
      ?, ?, ?
    )
  `).run(
    candidateId || null, mint, symbol || null, strategyId || 'apex_obicle', executionMode || 'dry_run',
    entrySignal || null, entryTf || null, ts, Number(sizeSol), Number(probeSizeSol),
    entryPrice ?? null, entryMcap ?? null, tokenAmountEst ?? null, tokenAmountRaw || null, entrySignature || null,
    entryPrice ?? null, entryMcap ?? null, tpPercent ?? null, slPercent ?? null,
    trailingEnabled ? 1 : 0, trailingPercent ?? null,
    watchlistMint || null, llmDecisionId || null, json(snapshot || {}),
  );
  return Number(result.lastInsertRowid);
}

export function updatePosition(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = ?`);
  const values = keys.map(k => fields[k]);
  values.push(id);
  db.prepare(`UPDATE positions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function logPositionEvent(positionId, kind, snapshot = {}) {
  db.prepare(`
    INSERT INTO position_events (position_id, at_ms, kind, pnl_pct, price_native, mcap_usd, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    positionId, now(), kind,
    snapshot.pnl_pct ?? null, snapshot.price_native ?? null, snapshot.mcap_usd ?? null,
    json(snapshot),
  );
}

export function recordTrade({ positionId, mint, side, sizeSol, price, mcap, tokenAmountEst, reason, signature, executionMode, payload }) {
  db.prepare(`
    INSERT INTO trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, signature, execution_mode, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    positionId, mint, side, now(),
    price ?? null, mcap ?? null, sizeSol ?? null, tokenAmountEst ?? null,
    reason || null, signature || null, executionMode || null, json(payload || {}),
  );
}

export function positionEvents(positionId, limit = 50) {
  return db.prepare('SELECT * FROM position_events WHERE position_id = ? ORDER BY at_ms ASC LIMIT ?').all(positionId, Number(limit));
}

export function withSnapshot(row) {
  if (!row) return null;
  return { ...row, snapshot: safeJson(row.snapshot_json, {}) };
}
