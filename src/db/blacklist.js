import { db } from './connection.js';
import { now } from '../utils.js';

export function addBlacklist(mint, reason = '') {
  db.prepare(`
    INSERT INTO blacklist (mint, added_at_ms, reason) VALUES (?, ?, ?)
    ON CONFLICT(mint) DO UPDATE SET reason = excluded.reason
  `).run(mint, now(), String(reason || '').slice(0, 500));
}

export function removeBlacklist(mint) {
  const result = db.prepare('DELETE FROM blacklist WHERE mint = ?').run(mint);
  return result.changes > 0;
}

export function isBlacklisted(mint) {
  return Boolean(db.prepare('SELECT 1 FROM blacklist WHERE mint = ?').get(mint));
}

export function listBlacklist(limit = 100) {
  return db.prepare('SELECT * FROM blacklist ORDER BY added_at_ms DESC LIMIT ?').all(Number(limit));
}
