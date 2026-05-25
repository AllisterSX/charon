// Pure indicator math — no I/O. Inputs are arrays of numbers (closes / etc).
// Vendored from charon-v2 src/filters/technicalAnalysis.js, augmented with ATR.

import { mean, stddev } from '../utils.js';

export function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
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
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = new Array(period).fill(null);
  for (let i = period; i < gains.length + 1; i++) {
    if (i > period) {
      avgGain = (avgGain * (period - 1) + gains[i - 1]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i - 1]) / period;
    }
    if (avgLoss === 0) out.push(100);
    else {
      const rs = avgGain / avgLoss;
      out.push(100 - 100 / (1 + rs));
    }
  }
  return out;
}

export function stochRsi(values, period = 14, smoothK = 3, smoothD = 3) {
  const r = rsi(values, period);
  if (!r) return null;
  const stoch = new Array(period * 2 - 1).fill(null);
  for (let i = period * 2 - 1; i < r.length; i++) {
    const window = r.slice(i - period + 1, i + 1).filter(v => v != null);
    if (window.length < period) { stoch.push(null); continue; }
    const min = Math.min(...window);
    const max = Math.max(...window);
    if (max === min) { stoch.push(50); continue; }
    stoch.push(((r[i] - min) / (max - min)) * 100);
  }
  const k = [];
  for (let i = 0; i < stoch.length; i++) {
    if (i < smoothK - 1 || stoch[i] == null) { k.push(null); continue; }
    const win = stoch.slice(i - smoothK + 1, i + 1).filter(v => v != null);
    if (win.length < smoothK) { k.push(null); continue; }
    k.push(win.reduce((a, b) => a + b, 0) / smoothK);
  }
  const d = [];
  for (let i = 0; i < k.length; i++) {
    if (i < smoothD - 1 || k[i] == null) { d.push(null); continue; }
    const win = k.slice(i - smoothD + 1, i + 1).filter(v => v != null);
    if (win.length < smoothD) { d.push(null); continue; }
    d.push(win.reduce((a, b) => a + b, 0) / smoothD);
  }
  return { k, d };
}

export function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const high = Number(candles[i].h ?? candles[i].high);
    const low = Number(candles[i].l ?? candles[i].low);
    const prevClose = Number(candles[i - 1].c ?? candles[i - 1].close);
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(prevClose)) {
      tr.push(0);
      continue;
    }
    tr.push(Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    ));
  }
  // Wilder's smoothing
  let av = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = new Array(period).fill(null);
  out.push(av);
  for (let i = period; i < tr.length; i++) {
    av = (av * (period - 1) + tr[i]) / period;
    out.push(av);
  }
  return out;
}

export function zscoreOf(arr, value) {
  const xs = arr.filter(x => Number.isFinite(x));
  if (xs.length < 2) return 0;
  const sd = stddev(xs);
  if (!sd) return 0;
  return (value - mean(xs)) / sd;
}

// Convenience wrappers
export { mean, stddev };
