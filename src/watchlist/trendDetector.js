// Trend detector — Option C (combined weighted score) per design §4.1.
// Returns { status: 'uptrend'|'neutral'|'reversing'|'downtrend', score, components }.

import { ema } from '../chart/indicators.js';
import { mean, stddev, zscore } from '../utils.js';
import { activeStrategy } from '../db/settings.js';

export function scoreTrend(candles, options = {}) {
  if (!Array.isArray(candles) || candles.length < 25) {
    return { status: 'unknown', score: null, reason: 'insufficient_candles', components: {} };
  }

  const strat = activeStrategy();
  const weights = {
    ema_stack: 25,
    ema_slope: 20,
    higher_highs: 15,
    higher_lows: 15,
    vol_uptick: 15,
    vol_z: 10,
    ...(strat.trend_weights || {}),
    ...(options.weights || {}),
  };
  const upMin = Number(strat.trend_uptrend_min_score ?? 60);
  const downMax = Number(strat.trend_reversal_max_score ?? 35);

  const closes = candles.map(c => Number(c.c));
  const highs  = candles.map(c => Number(c.h));
  const lows   = candles.map(c => Number(c.l));
  const vols   = candles.map(c => Number(c.v || 0));
  const last   = closes.length - 1;

  const ema20 = ema(closes, 20);
  const ema50Arr = ema(closes, 50);
  const lastEma20 = ema20?.[last];
  const lastEma50 = ema50Arr?.[last];
  const ema20Slope5 = (Number.isFinite(lastEma20) && Number.isFinite(ema20?.[last - 5]))
    ? (lastEma20 - ema20[last - 5]) / Math.abs(ema20[last - 5] || 1)
    : 0;

  let score = 0;
  const components = {};

  // EMA stack
  if (Number.isFinite(lastEma50) && Number.isFinite(lastEma20)) {
    if (lastEma20 > lastEma50) { score += weights.ema_stack; components.ema_stack = true; }
    else { components.ema_stack = false; }
  } else if (Number.isFinite(lastEma20) && closes[last] > lastEma20) {
    score += weights.ema_stack / 2;     // partial credit when EMA50 unavailable
    components.ema_stack = 'partial';
  } else {
    components.ema_stack = false;
  }

  // EMA slope
  if (ema20Slope5 > 0) { score += weights.ema_slope; components.ema_slope = true; }
  else { components.ema_slope = false; }

  // Higher highs (last 3 closes form HH)
  if (closes[last] > closes[last - 1] && closes[last - 1] > closes[last - 2]) {
    score += weights.higher_highs; components.higher_highs = true;
  } else { components.higher_highs = false; }

  // Higher lows (last 3 candle lows form HL)
  if (lows[last] > lows[last - 1] && lows[last - 1] > lows[last - 2]) {
    score += weights.higher_lows; components.higher_lows = true;
  } else { components.higher_lows = false; }

  // Volume uptick: last 5m candle vol vs trailing 12-candle mean
  const lookback = Math.min(12, vols.length - 1);
  const trailingVols = vols.slice(last - lookback, last);
  const meanVol = mean(trailingVols);
  if (vols[last] > meanVol) { score += weights.vol_uptick; components.vol_uptick = true; }
  else { components.vol_uptick = false; }

  // Vol z-score
  const sd = stddev(trailingVols);
  const z = sd > 0 ? (vols[last] - meanVol) / sd : 0;
  if (z > 0) { score += weights.vol_z; components.vol_z_pos = true; }
  else { components.vol_z_pos = false; }

  let status = 'neutral';
  if (score >= upMin) status = 'uptrend';
  else if (score <= downMax) status = 'downtrend';
  else status = 'reversing';

  return {
    status,
    score: Math.round(score),
    components,
    indicators: {
      ema20: lastEma20,
      ema50: lastEma50,
      ema20_slope_5: ema20Slope5,
      vol_z: z,
      mean_vol: meanVol,
    },
    upMin,
    downMax,
  };
}
