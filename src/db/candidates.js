import { db } from './connection.js';
import { now, safeJson, json } from '../utils.js';

export function candidateSignalKey(candidate, signature = null) {
  if (signature) return `${signature}:${candidate.token.mint}`;
  const route = candidate.signals?.route || 'signal';
  const bucket = Math.floor(Number(candidate.createdAtMs || now()) / (5 * 60 * 1000));
  return `${route}:${candidate.token.mint}:${bucket}`;
}

export function upsertCandidate(candidate, signature) {
  const signalKey = candidateSignalKey(candidate, signature);
  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM candidates WHERE signal_key = ?').get(signalKey);
    const status = candidate.filters?.passed ? 'screened' : 'filtered';
    if (existing) {
      db.prepare(`
        UPDATE candidates
        SET status = ?, updated_at_ms = ?, candidate_json = ?, filter_result_json = ?
        WHERE id = ?
      `).run(status, now(), json(candidate), json(candidate.filters || {}), existing.id);
      return existing.id;
    }
    const result = db.prepare(`
      INSERT INTO candidates (mint, status, created_at_ms, updated_at_ms, signature, signal_key, candidate_json, filter_result_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidate.token.mint,
      status,
      now(),
      now(),
      signature,
      signalKey,
      json(candidate),
      json(candidate.filters || {}),
    );
    return Number(result.lastInsertRowid);
  })();
}

export function updateCandidateStatus(candidateId, status) {
  db.prepare('UPDATE candidates SET status = ?, updated_at_ms = ? WHERE id = ?').run(status, now(), candidateId);
}

export function updateCandidateSnapshot(candidateId, candidate, status = null) {
  db.prepare(`
    UPDATE candidates
    SET status = COALESCE(?, status), updated_at_ms = ?, candidate_json = ?, filter_result_json = ?
    WHERE id = ?
  `).run(status, now(), json(candidate), json(candidate.filters || {}), candidateId);
}

export function candidateById(id) {
  const row = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
  return row ? { ...row, candidate: safeJson(row.candidate_json, {}) } : null;
}
export function latestCandidateByMint(mint) {
  const row = db.prepare('SELECT * FROM candidates WHERE mint = ? ORDER BY id DESC LIMIT 1').get(mint);
  return row ? { ...row, candidate: safeJson(row.candidate_json, {}) } : null;
}
