import { db } from './connection.js';
import { now, json, safeJson } from '../utils.js';

export function recordLlmDecision({ candidateId, mint, kind, verdict }) {
  const result = db.prepare(`
    INSERT INTO llm_decisions (candidate_id, mint, created_at_ms, kind, verdict, narrative_score, viral_potential, reason, narrative_summary, risks_json, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidateId || null, mint, now(),
    kind || 'screen',
    String(verdict?.verdict || 'WATCH'),
    Number(verdict?.narrative_score ?? 0),
    Number(verdict?.viral_potential ?? 0),
    String(verdict?.reason || '').slice(0, 1000),
    String(verdict?.narrative_summary || '').slice(0, 500),
    json(verdict?.risks || []),
    json(verdict?.raw || verdict || {}),
  );
  return Number(result.lastInsertRowid);
}

export function logDecision({ candidateId, mint, strategyId, action, verdict, reason, payload }) {
  db.prepare(`
    INSERT INTO decision_logs (at_ms, candidate_id, mint, strategy_id, action, verdict, reason, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    now(),
    candidateId || null, mint || null, strategyId || null,
    String(action || ''),
    verdict ? String(verdict) : null,
    reason ? String(reason).slice(0, 500) : null,
    json(payload || {}),
  );
}

export function recentLlmDecisions(mint, limit = 5) {
  return db.prepare('SELECT * FROM llm_decisions WHERE mint = ? ORDER BY id DESC LIMIT ?')
    .all(mint, Number(limit))
    .map(row => ({ ...row, risks: safeJson(row.risks_json, []), raw: safeJson(row.raw_json, {}) }));
}
