import { db } from './connection.js';

export function setting(key, fallback = '') {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}
export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}
export function boolSetting(key, fallback = false) {
  const value = setting(key, fallback ? 'true' : 'false');
  return value === 'true' || value === '1' || value === 'yes';
}
export function numSetting(key, fallback = 0) {
  const value = Number(setting(key, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

const strategyCache = { id: null, config: null, at: 0 };
const STRATEGY_CACHE_TTL_MS = 5000;

export function activeStrategy() {
  if (strategyCache.config && Date.now() - strategyCache.at < STRATEGY_CACHE_TTL_MS) return strategyCache.config;
  const row = db.prepare('SELECT * FROM strategies WHERE enabled = 1 LIMIT 1').get();
  if (!row) return defaultStrategy();
  const config = { id: row.id, name: row.name, ...JSON.parse(row.config_json) };
  strategyCache.id = row.id;
  strategyCache.config = config;
  strategyCache.at = Date.now();
  return config;
}
export function clearStrategyCache() {
  strategyCache.config = null;
  strategyCache.at = 0;
}

export function strategyById(id) {
  const row = db.prepare('SELECT * FROM strategies WHERE id = ?').get(id);
  if (!row) return null;
  return { id: row.id, name: row.name, enabled: Boolean(row.enabled), ...JSON.parse(row.config_json) };
}
export function allStrategies() {
  return db.prepare('SELECT * FROM strategies ORDER BY id').all().map(row => ({
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    ...JSON.parse(row.config_json),
  }));
}
export function setActiveStrategy(id) {
  db.prepare('UPDATE strategies SET enabled = 0').run();
  const result = db.prepare('UPDATE strategies SET enabled = 1 WHERE id = ?').run(id);
  clearStrategyCache();
  return result.changes > 0;
}
export function updateStrategyConfig(id, config) {
  db.prepare('UPDATE strategies SET config_json = ? WHERE id = ?').run(JSON.stringify(config), id);
  clearStrategyCache();
}
export function cloneStrategy(sourceId, newId, newName = null) {
  const src = db.prepare('SELECT * FROM strategies WHERE id = ?').get(sourceId);
  if (!src) return null;
  const exists = db.prepare('SELECT 1 FROM strategies WHERE id = ?').get(newId);
  if (exists) return false;
  db.prepare(
    'INSERT INTO strategies (id, name, enabled, config_json, created_at_ms) VALUES (?, ?, 0, ?, ?)',
  ).run(newId, newName || `${src.name} (copy)`, src.config_json, Date.now());
  return true;
}
export function deleteStrategy(id) {
  const row = db.prepare('SELECT enabled FROM strategies WHERE id = ?').get(id);
  if (!row) return false;
  if (row.enabled) return false; // can't delete the active strategy
  db.prepare('DELETE FROM strategies WHERE id = ?').run(id);
  clearStrategyCache();
  return true;
}

function defaultStrategy() {
  // Sensible fallback if no strategies row exists yet (shouldn't happen after initDb).
  return {
    id: 'apex_obicle',
    name: 'Apex Obicle',
    position_size_sol: 0.1,
    probe_size_pct: 25,
    max_open_positions: 10,
    max_mcap_usd: 100000,
    token_age_max_ms: 3600000,
    min_holders: 50,
    max_top10_holder_percent: 65,
    fee_to_mcap_min_ratio: 0.0001,
    require_mint_authority_revoked: true,
    holder_risk_reject_score: 0.90,
    min_source_count: 2,
    use_llm: true,
    llm_min_narrative_score: 50,
    llm_revalidate_interval_ms: 600000,
    watchlist_max: 25,
    watchlist_monitor_ms: 30000,
    watchlist_low_volume_threshold_usd: 1000,
    trend_uptrend_min_score: 60,
    trend_reversal_max_score: 35,
    sigA_enabled: true,
    sigB_enabled: true,
    sigA_ema_period: 20,
    sigA_ema_touch_pct: 0.5,
    sigA_stoch_oversold: 20,
    sigB_vol_spike_multiplier: 3,
    sigB_vol_spike_zscore: 2,
    sigB_vol_lookback_candles: 12,
    sigB_ath_dip_min_pct: -50,
    sigB_ath_dip_max_pct: -80,
    sigB_recovery_min_pct: 8,
    sigB_ath_max_age_ms: 6 * 3600 * 1000,
    probe_confirm_min_pnl_pct: 3,
    probe_fail_max_pnl_pct: -7,
    probe_max_age_ms: 240000,
    probe_require_volume_holding: true,
    probe_require_ema_bullish: true,
    probe_require_no_overbought: true,
    probe_require_above_entry_ema: true,
    sl_pct: -25,
    stoch_overbought: 80,
    partial_tp_sell_pct: 40,
    trailing_pct: 30,
    reentry_cooldown_ms: 300000,
    tf_age_30s_max_ms: 6 * 3600 * 1000,
    tf_age_1m_max_ms: 48 * 3600 * 1000,
  };
}
