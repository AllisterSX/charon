// GMGN chart stub.
// GMGN OpenAPI does NOT expose a K-line/candle endpoint (confirmed 404 on all
// plausible paths as of 2026-05-25). This file is kept as a placeholder in case
// GMGN adds chart data in the future. All chart data comes from Jupiter.

export async function fetchGmgnCandles(_mint, _tf, _count = 80) {
  return { candles: [], source: 'gmgn', error: 'gmgn_kline_not_available' };
}
