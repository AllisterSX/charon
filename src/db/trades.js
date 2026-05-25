import { db } from './connection.js';
import { safeJson } from '../utils.js';

export function tradesByPosition(positionId) {
  return db.prepare('SELECT * FROM trades WHERE position_id = ? ORDER BY at_ms ASC')
    .all(Number(positionId))
    .map(row => ({ ...row, payload: safeJson(row.payload_json, {}) }));
}

export function recentTrades(limit = 50) {
  return db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT ?').all(Number(limit));
}
