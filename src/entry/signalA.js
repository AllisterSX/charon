// Entry Signal A — Obicle TA (per design §4.3).
// All on closed candles. Three checks — all required:
//   1. EMA touch: low[last] <= ema20[last] * (1 + touch_pct/100)
//   2. Stoch RSI bottom: K < oversold AND K > prev K (turning up)
//   3. Two-candle close above EMA: close[last] > ema20[last] AND close[last-1] > ema20[last-1]

export function evaluateSignalA({ candles, ema20Arr, sr, strat }) {
  if (!Array.isArray(candles) || candles.length < 25) {
    return { entry: false, reasons: ['insufficient_candles'], metrics: {} };
  }
  if (!ema20Arr || !sr) {
    return { entry: false, reasons: ['indicator_unavailable'], metrics: {} };
  }
  const closes = candles.map(c => Number(c.c));
  const lows   = candles.map(c => Number(c.l));
  const last = closes.length - 1;

  const lastEma20  = ema20Arr[last];
  const prevEma20  = ema20Arr[last - 1];
  const lastClose  = closes[last];
  const prevClose  = closes[last - 1];
  const lastLow    = lows[last];
  const lastK      = sr.k?.[last];
  const prevK      = sr.k?.[last - 1];

  const touchPct = Number(strat.sigA_ema_touch_pct ?? 0.5) / 100;
  const oversold = Number(strat.sigA_stoch_oversold ?? 20);

  const checks = {
    ema_touch:
      Number.isFinite(lastEma20) && Number.isFinite(lastLow)
      && lastLow <= lastEma20 * (1 + touchPct),
    stoch_bottom:
      Number.isFinite(lastK) && Number.isFinite(prevK)
      && lastK < oversold && lastK > prevK,
    two_candle_above_ema:
      Number.isFinite(lastEma20) && Number.isFinite(prevEma20)
      && lastClose > lastEma20 && prevClose > prevEma20,
  };

  const reasons = Object.entries(checks).map(([k, v]) => `${k}=${v}`);
  const entry = checks.ema_touch && checks.stoch_bottom && checks.two_candle_above_ema;

  return {
    entry,
    reasons,
    metrics: {
      lastEma20,
      lastK,
      prevK,
      lastClose,
      prevClose,
      lastLow,
      touchPct,
      oversold,
    },
  };
}
