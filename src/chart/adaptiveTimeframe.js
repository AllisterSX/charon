import { activeStrategy } from '../db/settings.js';

// pickTimeframe(tokenAgeMs) → '30s' | '1m' | '5m'
// Defaults: <6h → 30s; <48h → 1m; else 5m. Tunable per-strategy.
export function pickTimeframe(tokenAgeMs) {
  const strat = activeStrategy();
  const age30sMax = Number(strat.tf_age_30s_max_ms ?? 6 * 3600 * 1000);
  const age1mMax  = Number(strat.tf_age_1m_max_ms  ?? 48 * 3600 * 1000);
  const age = Number(tokenAgeMs);
  if (!Number.isFinite(age) || age <= 0) return '5m';
  if (age < age30sMax) return '30s';
  if (age < age1mMax)  return '1m';
  return '5m';
}

export function tfTtlMs(tf) {
  if (tf === '30s') return 15_000;
  if (tf === '1m')  return 30_000;
  return 60_000;
}

// Map Apex tf string to Jupiter chart interval.
// Jupiter chart supports: 1_SECOND, 15_SECOND, 30_SECOND, 1_MINUTE, 5_MINUTE, 15_MINUTE, 30_MINUTE, 1_HOUR, 4_HOUR, 1_DAY
export function tfToJupiter(tf) {
  if (tf === '30s') return '30_SECOND';
  if (tf === '1m')  return '1_MINUTE';
  return '5_MINUTE';
}
