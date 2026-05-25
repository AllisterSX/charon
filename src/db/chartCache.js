import { db } from './connection.js';
import { now, safeJson, json } from '../utils.js';

export function getChartCache(cacheKey) {
  const row = db.prepare('SELECT * FROM chart_cache WHERE cache_key = ?').get(cacheKey);
  if (!row) return null;
  if (now() - Number(row.fetched_at_ms) > Number(row.ttl_ms)) return null;
  const candles = safeJson(row.candles_json, null);
  if (!Array.isArray(candles)) return null;
  return { candles, source: row.source, fetchedAtMs: row.fetched_at_ms };
}

export function putChartCache(cacheKey, candles, source, ttlMs) {
  db.prepare(`
    INSERT INTO chart_cache (cache_key, fetched_at_ms, ttl_ms, source, candles_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      fetched_at_ms = excluded.fetched_at_ms,
      ttl_ms = excluded.ttl_ms,
      source = excluded.source,
      candles_json = excluded.candles_json
  `).run(cacheKey, now(), Number(ttlMs), source, json(candles));
}

export function pruneChartCache(retentionMs = 24 * 3600 * 1000) {
  db.prepare('DELETE FROM chart_cache WHERE fetched_at_ms < ?').run(now() - retentionMs);
}
