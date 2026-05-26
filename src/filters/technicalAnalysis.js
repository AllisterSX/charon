// Technical analysis — Phase 5
// EMA(20) + Stoch RSI(14) computed locally from Jupiter chart candles.
// Used by `obicle_confirmed` and `migration_play` strategies for entry confirmation.
//
// Obicle entry rule:
//   - Price near EMA20 (touch or slightly below)
//   - Stoch RSI bottoming (%K < oversold threshold AND turning up)
//   - 2-candle close above key level (continuation pattern)
//
// Reference: Obicle PDF guide (DEGEN BASIC TRADING by Obicle).
// Inputs: candle array dari Jupiter `fetchJupiterChartContext()`.

import axios from 'axios';
import { JSON_HEADERS } from '../config.js';
import { now } from '../utils.js';

// ── Indicator math ───────────────────────────────────────────────────────

export function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  // Seed with SMA over first `period` values
  let emaVal = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = new Array(period - 1).fill(null);
  out.push(emaVal);
  for (let i = period; i < values.length; i++) {
    emaVal = values[i] * k + emaVal * (1 - k);
    out.push(emaVal);
  }
  return out;
}

export function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length < period + 1) return null;
  const gains = [];
  const losses = [];
  for (let i = 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  // Wilder's smoothing
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = new Array(period).fill(null);
  for (let i = period; i < gains.length + 1; i++) {
    if (i > period) {
      avgGain = (avgGain * (period - 1) + gains[i - 1]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i - 1]) / period;
    }
    if (avgLoss === 0) {
      out.push(100);
    } else {
      const rs = avgGain / avgLoss;
      out.push(100 - 100 / (1 + rs));
    }
  }
  return out;
}

export function stochRsi(values, period = 14, smoothK = 3, smoothD = 3) {
  const r = rsi(values, period);
  if (!r) return null;
  // Compute raw stoch over rolling period
  const stoch = new Array(period * 2 - 1).fill(null);
  for (let i = period * 2 - 1; i < r.length; i++) {
    const window = r.slice(i - period + 1, i + 1).filter(v => v != null);
    if (window.length < period) { stoch.push(null); continue; }
    const min = Math.min(...window);
    const max = Math.max(...window);
    if (max === min) { stoch.push(50); continue; }
    stoch.push(((r[i] - min) / (max - min)) * 100);
  }
  // Smooth %K
  const k = [];
  for (let i = 0; i < stoch.length; i++) {
    if (i < smoothK - 1 || stoch[i] == null) { k.push(null); continue; }
    const win = stoch.slice(i - smoothK + 1, i + 1).filter(v => v != null);
    if (win.length < smoothK) { k.push(null); continue; }
    k.push(win.reduce((a, b) => a + b, 0) / smoothK);
  }
  // Smooth %D
  const d = [];
  for (let i = 0; i < k.length; i++) {
    if (i < smoothD - 1 || k[i] == null) { d.push(null); continue; }
    const win = k.slice(i - smoothD + 1, i + 1).filter(v => v != null);
    if (win.length < smoothD) { d.push(null); continue; }
    d.push(win.reduce((a, b) => a + b, 0) / smoothD);
  }
  return { k, d };
}

// ── Adaptive timeframe selection ─────────────────────────────────────────
// Obicle's rule: <4h → 15s/1m, 4-48h → 1m/5m, >48h → 15m.
// Jupiter chart API supports: 1_SECOND (limited), 5_MINUTE, 15_MINUTE, 30_MINUTE, 1_HOUR, 4_HOUR, 1_DAY.
// We use 5_MINUTE for everything <48h (Jupiter doesn't expose 1m at scale), 15_MINUTE for older.

export function pickTimeframe(tokenAgeMs) {
  if (!Number.isFinite(tokenAgeMs) || tokenAgeMs <= 0) return '5_MINUTE';
  if (tokenAgeMs < 4 * 3600 * 1000) return '5_MINUTE';
  if (tokenAgeMs < 48 * 3600 * 1000) return '5_MINUTE';
  return '15_MINUTE';
}

// ── Jupiter candle fetch ────────────────────────────────────────────────

export async function fetchCandles(mint, interval = '5_MINUTE', candles = 60) {
  try {
    const url = new URL(`https://datapi.jup.ag/v2/charts/${mint}`);
    url.searchParams.set('interval', interval);
    url.searchParams.set('to', String(now()));
    url.searchParams.set('candles', String(candles));
    url.searchParams.set('type', 'price');
    url.searchParams.set('quote', 'native');
    const res = await axios.get(url.toString(), { timeout: 10_000, headers: JSON_HEADERS });
    return Array.isArray(res.data?.candles) ? res.data.candles : [];
  } catch (err) {
    console.log(`[ta] candles ${mint.slice(0, 8)}... ${interval} ${err.message}`);
    return [];
  }
}

// ── Entry signal evaluation ─────────────────────────────────────────────

// evaluateStochRsiSignal — reusable: returns current K/D and zone flags.
// Used by both entry gate (K < oversold) and exit monitor (K > overbought).
export async function evaluateStochRsiSignal(mint, {
  interval = '5_MINUTE',
  lookback = 80,
  rsiPeriod = 14,
  smoothK = 3,
  smoothD = 3,
  oversold = 20,
  overbought = 80,
} = {}) {
  const candles = await fetchCandles(mint, interval, lookback);
  const minCandles = rsiPeriod * 2 + smoothK + smoothD;
  if (candles.length < minCandles) {
    return { checked: false, reason: `insufficient candles (${candles.length}/${minCandles})`, interval };
  }

  const closes = candles.map(c => Number(c.close));
  const stoch = stochRsi(closes, rsiPeriod, smoothK, smoothD);
  if (!stoch) {
    return { checked: false, reason: 'stochRsi compute failed', interval };
  }

  const last = closes.length - 1;
  const lastK = stoch.k[last];
  const lastD = stoch.d[last];
  const prevK = stoch.k[last - 1];
  const prevD = stoch.d[last - 1];

  if (!Number.isFinite(lastK) || !Number.isFinite(lastD)) {
    return { checked: false, reason: 'stochRsi values are null at last candle', interval };
  }

  const isOversold = lastK < oversold;
  const isOverbought = lastK > overbought;
  const turningUp = Number.isFinite(prevK) && lastK > prevK;
  const turningDown = Number.isFinite(prevK) && lastK < prevK;
  const bullishCross = Number.isFinite(prevK) && Number.isFinite(prevD) && prevK <= prevD && lastK > lastD;
  const bearishCross = Number.isFinite(prevK) && Number.isFinite(prevD) && prevK >= prevD && lastK < lastD;

  return {
    checked: true,
    interval,
    candles: candles.length,
    k: lastK,
    d: lastD,
    prevK,
    prevD,
    isOversold,
    isOverbought,
    turningUp,
    turningDown,
    bullishCross,
    bearishCross,
    // Entry signal: K < oversold AND turning up (momentum reversal)
    entrySignal: isOversold && turningUp,
    // Exit signal: K > overbought (momentum exhaustion)
    exitSignal: isOverbought,
  };
}

export async function evaluateTaEntry(candidate, { interval = null, lookback = 60, emaPeriod = 20, rsiPeriod = 14, oversold = 25 } = {}) {
  const tokenAgeMs = Number(candidate.signals?.ageMs ?? 0);
  const tf = interval || pickTimeframe(tokenAgeMs);
  const candles = await fetchCandles(candidate.token.mint, tf, lookback);
  if (candles.length < emaPeriod + rsiPeriod) {
    return { checked: false, reason: `insufficient candles (${candles.length})`, tf };
  }

  const closes = candles.map(c => Number(c.close));
  const lows = candles.map(c => Number(c.low));
  const opens = candles.map(c => Number(c.open));

  const emaSeries = ema(closes, emaPeriod);
  const stoch = stochRsi(closes, rsiPeriod);
  if (!emaSeries || !stoch) {
    return { checked: false, reason: 'indicator compute failed', tf };
  }

  const last = closes.length - 1;
  const lastEma = emaSeries[last];
  const prevEma = emaSeries[last - 1];
  const lastK = stoch.k[last];
  const lastD = stoch.d[last];
  const prevK = stoch.k[last - 1];
  const prevClose = closes[last - 1];
  const lastClose = closes[last];
  const lastLow = lows[last];

  // Conditions
  const priceTouchedEma = Number.isFinite(lastEma) && Number.isFinite(lastLow) && lastLow <= lastEma * 1.005;
  const stochOversold = Number.isFinite(lastK) && lastK < oversold;
  const stochTurningUp = Number.isFinite(lastK) && Number.isFinite(prevK) && lastK > prevK;
  const stochBullishCross = Number.isFinite(lastK) && Number.isFinite(lastD) && Number.isFinite(prevK) && prevK <= stoch.d[last - 1] && lastK > lastD;
  const twoCandleConfirm = Number.isFinite(lastEma)
    && Number.isFinite(prevEma)
    && lastClose > lastEma
    && prevClose > prevEma;

  const entryConditions = [
    { name: 'price_near_ema', met: priceTouchedEma },
    { name: 'stoch_oversold', met: stochOversold },
    { name: 'stoch_turning_up', met: stochTurningUp },
    { name: 'stoch_bullish_cross', met: stochBullishCross },
    { name: 'two_candle_close_above_ema', met: twoCandleConfirm },
  ];
  const metCount = entryConditions.filter(c => c.met).length;

  // Obicle's setup needs: EMA touch + Stoch RSI bottoming/cross.
  // Confirmation requires the 2-candle close (continuation pattern).
  const minRequiredScore = 3; // 3/5 = entry signal
  const entrySignal = metCount >= minRequiredScore;

  return {
    checked: true,
    tf,
    candles: candles.length,
    indicators: {
      ema: lastEma,
      stochK: lastK,
      stochD: lastD,
      lastClose,
    },
    conditions: entryConditions,
    metCount,
    entrySignal,
  };
}
