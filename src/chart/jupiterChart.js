import axios from 'axios';
import { JSON_HEADERS } from '../config.js';
import { now } from '../utils.js';
import { tfToJupiter, tfTtlMs } from './adaptiveTimeframe.js';
import { getChartCache, putChartCache } from '../db/chartCache.js';

// Jupiter datapi candles: GET https://datapi.jup.ag/v2/charts/<mint>
//   ?interval=<I>&candles=<n>&type=price&quote=native&to=<ms>
// Supported intervals: 1_SECOND, 15_SECOND, 30_SECOND, 1_MINUTE, 5_MINUTE, etc.
// Response: { candles: [{ time, open, high, low, close, volume }, ...] }

function normalizeJupiterCandle(row) {
  if (!row) return null;
  const t = Number(row.time ?? row.t ?? 0);
  const o = Number(row.open);
  const h = Number(row.high);
  const l = Number(row.low);
  const c = Number(row.close);
  const v = Number(row.volume ?? 0);
  if (!Number.isFinite(o) || !Number.isFinite(c)) return null;
  return { t, o, h, l, c, v };
}

export async function fetchJupiterCandles(mint, tf, count = 80) {
  try {
    const interval = tfToJupiter(tf);
    const url = new URL(`https://datapi.jup.ag/v2/charts/${mint}`);
    url.searchParams.set('interval', interval);
    url.searchParams.set('to', String(now()));
    url.searchParams.set('candles', String(count));
    url.searchParams.set('type', 'price');
    url.searchParams.set('quote', 'native');
    const res = await axios.get(url.toString(), { timeout: 10_000, headers: JSON_HEADERS });
    const rows = Array.isArray(res.data?.candles) ? res.data.candles : [];
    const candles = rows.map(normalizeJupiterCandle).filter(Boolean);
    candles.sort((a, b) => Number(a.t) - Number(b.t));
    return { candles, source: 'jupiter', fetchedAtMs: now() };
  } catch (err) {
    console.log(`[chart] ${mint.slice(0, 8)}... ${tf} ${err.response?.status || ''} ${err.message}`);
    return { candles: [], source: 'jupiter', error: err.message };
  }
}

// Primary chart fetch with cache. Jupiter is the sole chart source.
// GMGN OpenAPI does not expose a K-line endpoint (confirmed 404 on all paths).
export async function fetchCandlesAdaptive(mint, tf, count = 80) {
  const cacheKey = `${mint}:${tf}`;
  const cached = getChartCache(cacheKey);
  if (cached && cached.candles.length >= Math.min(count, 30)) return cached;

  const ttl = tfTtlMs(tf);
  const result = await fetchJupiterCandles(mint, tf, count);
  if (result.candles.length > 0) putChartCache(cacheKey, result.candles, result.source, ttl);
  return result;
}
