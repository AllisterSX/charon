import { gmgnFetch, gmgnBackoffActive, setGmgnBackoff } from '../enrichment/gmgn.js';
import { tfToGmgn } from './adaptiveTimeframe.js';
import { now } from '../utils.js';

// GMGN K-line endpoint (Solana):
//   /v1/token/kline/sol/<token_address>?resolution=<interval>&limit=<n>
// Response schape (observed): { data: { list: [{ time, open, high, low, close, volume }, ...] } }
// We normalize candles to { t, o, h, l, c, v }.

function normalizeGmgnKlineRow(row) {
  if (!row) return null;
  const t = Number(row.time ?? row.t ?? row.timestamp ?? 0);
  const o = Number(row.open ?? row.o);
  const h = Number(row.high ?? row.h);
  const l = Number(row.low ?? row.l);
  const c = Number(row.close ?? row.c);
  const v = Number(row.volume ?? row.v ?? 0);
  if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) return null;
  return { t, o, h, l, c, v };
}

export async function fetchGmgnCandles(mint, tf, count = 80) {
  if (gmgnBackoffActive('chart')) {
    return { candles: [], source: 'gmgn', error: 'gmgn_chart_backoff' };
  }
  try {
    const interval = tfToGmgn(tf);
    const payload = await gmgnFetch(`/v1/token/kline/sol/${mint}`, {
      params: { resolution: interval, limit: count },
    });
    const rows = payload?.data?.list || payload?.data?.candles || payload?.data || [];
    if (!Array.isArray(rows)) {
      return { candles: [], source: 'gmgn', error: 'unexpected_payload_shape' };
    }
    const candles = rows.map(normalizeGmgnKlineRow).filter(Boolean);
    candles.sort((a, b) => Number(a.t) - Number(b.t));
    return { candles, source: 'gmgn', fetchedAtMs: now() };
  } catch (err) {
    setGmgnBackoff('chart', err);
    console.log(`[gmgn-chart] ${mint.slice(0, 8)}... ${tf} ${err.response?.status || ''} ${err.message}`);
    return { candles: [], source: 'gmgn', error: err.message };
  }
}
