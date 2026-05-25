// Entry Signal B — Momentum reversal (design §4.4).
// 1) Volume spike: vol[last] / mean(prev N) >= multiplier AND z-score >= zMin
// 2) ATH dip + recovery: ath_dip_pct between adaptive [-50, -80] (volatility-scaled)
//    AND not full rug (>= -85), AND recovery_from_trough_pct >= recovery_min
//    AND ATH age < ath_max_age_ms

import { atr } from '../chart/indicators.js';
import { mean, stddev, clamp, now } from '../utils.js';

export function evaluateSignalB({ candles, vols, ath, trough, strat }) {
  if (!Array.isArray(candles) || candles.length < 25) {
    return { entry: false, reasons: ['insufficient_candles'], metrics: {} };
  }
  const closes = candles.map(c => Number(c.c));
  const last = closes.length - 1;
  const current = closes[last];

  const lookback = Math.max(2, Math.min(Number(strat.sigB_vol_lookback_candles ?? 12), vols.length - 1));
  const trailing = vols.slice(last - lookback, last);
  const meanV = mean(trailing);
  const sd = stddev(trailing);
  const ratio = meanV > 0 ? vols[last] / meanV : 0;
  const z = sd > 0 ? (vols[last] - meanV) / sd : 0;
  const multMin = Number(strat.sigB_vol_spike_multiplier ?? 3);
  const zMin = Number(strat.sigB_vol_spike_zscore ?? 2);
  const volumeSpike = ratio >= multMin && z >= zMin;

  // Adaptive ATH dip threshold: -50 to -80 scaled by volatility.
  const atrArr = atr(candles, 14);
  const lastAtr = atrArr?.[last] ?? null;
  const meanClose = mean(closes.slice(-12));
  const volNorm = lastAtr && meanClose ? clamp(lastAtr / meanClose, 0, 0.4) / 0.4 : 0;
  const dipMin = Number(strat.sigB_ath_dip_min_pct ?? -50);   // base threshold (-50%)
  const dipMax = Number(strat.sigB_ath_dip_max_pct ?? -80);   // hard floor of meaningful dip
  // requiredDipMin is most-negative value: -50 - 30*volNorm → -50..-80
  const requiredDipMin = dipMin - 30 * volNorm;
  const recoveryMin = Number(strat.sigB_recovery_min_pct ?? 8);
  const ageMax = Number(strat.sigB_ath_max_age_ms ?? 6 * 3600 * 1000);

  const athPrice = Number(ath?.price || 0);
  const troughPrice = Number(trough?.price || 0);
  const athDipPct = athPrice > 0 && troughPrice > 0 ? ((troughPrice - athPrice) / athPrice) * 100 : null;
  const recoveryFromTroughPct = troughPrice > 0 ? ((current - troughPrice) / troughPrice) * 100 : null;
  const athAgeMs = ath?.at ? now() - Number(ath.at) : null;

  const checks = {
    volume_spike: volumeSpike,
    ath_dip_qualifies: athDipPct != null && athDipPct <= requiredDipMin && athDipPct >= -85,
    recovery_confirmed: recoveryFromTroughPct != null && recoveryFromTroughPct >= recoveryMin,
    ath_fresh: athAgeMs != null && athAgeMs <= ageMax,
  };
  const reasons = Object.entries(checks).map(([k, v]) => `${k}=${v}`);
  const entry = checks.volume_spike && checks.ath_dip_qualifies && checks.recovery_confirmed && checks.ath_fresh;

  return {
    entry,
    reasons,
    metrics: {
      volRatio: ratio,
      volZ: z,
      requiredDipMin,
      athDipPct,
      recoveryFromTroughPct,
      athAgeMs,
      lastAtr,
      volNorm,
      dipMin,
      dipMax,
      recoveryMin,
    },
  };
}
