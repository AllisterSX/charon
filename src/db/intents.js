import { db } from './connection.js';
import { now, json, safeJson } from '../utils.js';

export function createIntent({ candidateId, mint, mode, side, sizeSol, reason, payload }) {
  const ts = now();
  const result = db.prepare(`
    INSERT INTO trade_intents (candidate_id, mint, mode, status, created_at_ms, updated_at_ms, side, size_sol, reason, payload_json)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
  `).run(
    candidateId || null, mint,
    String(mode || 'confirm'),
    ts, ts,
    String(side || 'buy'),
    Number(sizeSol),
    reason ? String(reason).slice(0, 500) : null,
    json(payload || {}),
  );
  return Number(result.lastInsertRowid);
}

export function intentById(id) {
  const row = db.prepare('SELECT * FROM trade_intents WHERE id = ?').get(Number(id));
  return row ? { ...row, payload: safeJson(row.payload_json, {}) } : null;
}

export function updateIntentStatus(id, status, payload = null) {
  const fields = ['status = ?', 'updated_at_ms = ?'];
  const params = [status, now()];
  if (payload) {
    fields.push('payload_json = ?');
    params.push(json(payload));
  }
  params.push(Number(id));
  db.prepare(`UPDATE trade_intents SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}
