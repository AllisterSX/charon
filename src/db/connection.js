import Database from 'better-sqlite3';
import { DB_PATH } from '../config.js';

export const db = new Database(DB_PATH);

export function initDb() {
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saved_wallets (
      label TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      signature TEXT,
      signal_key TEXT,
      candidate_json TEXT NOT NULL,
      filter_result_json TEXT NOT NULL,
      UNIQUE(signature, mint)
    );
    CREATE INDEX IF NOT EXISTS idx_candidates_mint ON candidates(mint);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_signal_key ON candidates(signal_key) WHERE signal_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS signal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_signal_events_mint ON signal_events(mint);

    CREATE TABLE IF NOT EXISTS llm_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'screen',
      verdict TEXT NOT NULL,
      narrative_score INTEGER,
      viral_potential INTEGER,
      reason TEXT,
      narrative_summary TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_llm_decisions_mint ON llm_decisions(mint, created_at_ms);

    CREATE TABLE IF NOT EXISTS decision_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_ms INTEGER NOT NULL,
      candidate_id INTEGER,
      mint TEXT,
      strategy_id TEXT,
      action TEXT NOT NULL,
      verdict TEXT,
      reason TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_decision_logs_mint ON decision_logs(mint, at_ms);

    CREATE TABLE IF NOT EXISTS watchlist (
      mint                    TEXT PRIMARY KEY,
      candidate_id            INTEGER NOT NULL,
      symbol                  TEXT,
      added_at_ms             INTEGER NOT NULL,
      last_tick_at_ms         INTEGER,
      last_revalidated_at_ms  INTEGER,
      status                  TEXT NOT NULL DEFAULT 'active',
      removed_at_ms           INTEGER,
      removal_reason          TEXT,
      narrative_score         INTEGER,
      viral_potential         INTEGER,
      llm_verdict             TEXT,
      llm_reason              TEXT,
      llm_unverified          INTEGER NOT NULL DEFAULT 0,
      current_price_native    REAL,
      current_mcap_usd        REAL,
      ath_price_native        REAL,
      ath_at_ms               INTEGER,
      trough_price_native     REAL,
      trough_at_ms            INTEGER,
      trend_status            TEXT,
      trend_score             REAL,
      vol_5m_usd              REAL,
      vol_1h_avg_usd          REAL,
      ema20                   REAL,
      ema50                   REAL,
      stoch_k                 REAL,
      stoch_d                 REAL,
      candle_tf               TEXT,
      cooldown_until_ms       INTEGER,
      last_position_id        INTEGER,
      snapshot_json           TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_watchlist_status ON watchlist(status);
    CREATE INDEX IF NOT EXISTS idx_watchlist_added ON watchlist(added_at_ms);

    CREATE TABLE IF NOT EXISTS watchlist_ticks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      mint          TEXT NOT NULL,
      at_ms         INTEGER NOT NULL,
      price_native  REAL,
      mcap_usd      REAL,
      vol_5m_usd    REAL,
      ema20         REAL,
      ema50         REAL,
      stoch_k       REAL,
      stoch_d       REAL,
      trend_score   REAL,
      trend_status  TEXT,
      candle_tf     TEXT,
      ind_json      TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_ticks_mint_at ON watchlist_ticks(mint, at_ms);

    CREATE TABLE IF NOT EXISTS watchlist_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      mint          TEXT NOT NULL,
      at_ms         INTEGER NOT NULL,
      kind          TEXT NOT NULL,
      reason        TEXT,
      payload_json  TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_wl_events_mint_at ON watchlist_events(mint, at_ms);

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      symbol TEXT,
      strategy_id TEXT NOT NULL DEFAULT 'apex_obicle',
      status TEXT NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'dry_run',
      entry_signal TEXT,            -- 'A' | 'B'
      entry_tf TEXT,                -- '30s' | '1m' | '5m'
      opened_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER,
      size_sol REAL NOT NULL,
      probe_size_sol REAL,
      addon_size_sol REAL DEFAULT 0,
      addon_at_ms INTEGER,
      probe_state TEXT,             -- open | confirmed | failed | inconclusive
      entry_price REAL,
      entry_mcap REAL,
      token_amount_est REAL,
      token_amount_raw TEXT,
      entry_signature TEXT,
      exit_signature TEXT,
      high_water_price REAL,
      high_water_mcap REAL,
      tp_percent REAL,
      sl_percent REAL,
      trailing_enabled INTEGER NOT NULL DEFAULT 1,
      trailing_percent REAL,
      trailing_armed INTEGER NOT NULL DEFAULT 0,
      partial_tp_done INTEGER NOT NULL DEFAULT 0,
      cooldown_until_ms INTEGER,
      watchlist_mint TEXT,
      llm_decision_id INTEGER,
      exit_price REAL,
      exit_mcap REAL,
      exit_reason TEXT,
      pnl_percent REAL,
      pnl_sol REAL,
      snapshot_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_positions_mint ON positions(mint);
    CREATE INDEX IF NOT EXISTS idx_positions_strategy ON positions(strategy_id);

    CREATE TABLE IF NOT EXISTS position_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id   INTEGER NOT NULL,
      at_ms         INTEGER NOT NULL,
      kind          TEXT NOT NULL,
      pnl_pct       REAL,
      price_native  REAL,
      mcap_usd      REAL,
      payload_json  TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_pos_events_pid ON position_events(position_id, at_ms);

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      side TEXT NOT NULL,            -- buy | sell
      at_ms INTEGER NOT NULL,
      price REAL,
      mcap REAL,
      size_sol REAL,
      token_amount_est REAL,
      reason TEXT,
      signature TEXT,
      execution_mode TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trades_pos ON trades(position_id, at_ms);

    CREATE TABLE IF NOT EXISTS trade_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      side TEXT NOT NULL,
      size_sol REAL NOT NULL,
      reason TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trade_intents_status ON trade_intents(status);

    CREATE TABLE IF NOT EXISTS blacklist (
      mint        TEXT PRIMARY KEY,
      added_at_ms INTEGER NOT NULL,
      reason      TEXT
    );

    CREATE TABLE IF NOT EXISTS chart_cache (
      cache_key      TEXT PRIMARY KEY,
      fetched_at_ms  INTEGER NOT NULL,
      ttl_ms         INTEGER NOT NULL,
      source         TEXT NOT NULL,
      candles_json   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT,
      kind TEXT NOT NULL,
      sent_at_ms INTEGER NOT NULL,
      telegram_message_id INTEGER,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS learning_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      window_ms INTEGER NOT NULL,
      summary_json TEXT NOT NULL,
      lessons_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      lesson TEXT NOT NULL,
      evidence_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_learning_lessons_status ON learning_lessons(status, created_at_ms);
  `);

  seedSettings();
  seedStrategies();
}

function seedSettings() {
  const defaults = {
    agent_enabled: 'true',
    trading_mode: process.env.TRADING_MODE || 'dry_run',
    llm_min_narrative_score: '50',
    max_open_positions: process.env.MAX_OPEN_POSITIONS || '10',
    position_size_sol: '0.1',
    enable_token_authority_guard: 'true',
    reject_active_mint_authority: 'true',
    holder_risk_reject_score: '0.90',
    enable_daily_report: process.env.ENABLE_DAILY_REPORT || 'true',
    gmgn_request_delay_ms: process.env.GMGN_REQUEST_DELAY_MS || '5000',
    gmgn_max_retries: process.env.GMGN_MAX_RETRIES || '2',
  };
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(defaults)) insert.run(key, value);
}

function seedStrategies() {
  const stratInsert = db.prepare(
    'INSERT OR IGNORE INTO strategies (id, name, enabled, config_json, created_at_ms) VALUES (?, ?, ?, ?, ?)',
  );
  const ts = Date.now();

  // Single shipped strategy. The strategies table is multi-strategy capable —
  // operators can clone/edit via /stratclone and /stratset, but only one is
  // enabled at a time. Switching is done via /stratswitch <id>.
  stratInsert.run('apex_obicle', 'Apex Obicle', 1, JSON.stringify({
    // Position sizing
    position_size_sol: 0.1,
    probe_size_pct: 25,
    max_open_positions: 10,

    // Metrics gate (FR-2)
    max_mcap_usd: 100000,
    min_mcap_usd: 0,
    token_age_min_ms: 0,
    token_age_max_ms: 3600000,                  // 1h
    min_holders: 50,
    max_top10_holder_percent: 65,
    fee_to_mcap_min_ratio: 0.0001,
    require_mint_authority_revoked: true,
    holder_risk_reject_score: 0.90,
    min_source_count: 2,
    require_fee_claim: false,

    // LLM (FR-3)
    use_llm: true,
    llm_min_narrative_score: 50,
    llm_revalidate_interval_ms: 600000,         // 10m

    // Watchlist (FR-4)
    watchlist_max: 25,
    watchlist_monitor_ms: 30000,
    watchlist_low_volume_threshold_usd: 1000,   // 5m
    watchlist_status_push_ms: 300000,           // 5m

    // Trend (FR-4.5, §4.1 Option C)
    trend_uptrend_min_score: 60,
    trend_reversal_max_score: 35,
    trend_weights: {
      ema_stack: 25,
      ema_slope: 20,
      higher_highs: 15,
      higher_lows: 15,
      vol_uptick: 15,
      vol_z: 10,
    },

    // Entry Signal A — Obicle TA (FR-5.1, §4.3)
    sigA_enabled: true,
    sigA_ema_period: 20,
    sigA_ema_touch_pct: 0.5,
    sigA_stoch_oversold: 20,
    sigA_two_candle_above: true,

    // Entry Signal B — Momentum reversal (FR-5.1, §4.4)
    sigB_enabled: true,
    sigB_vol_spike_multiplier: 3,
    sigB_vol_spike_zscore: 2,
    sigB_vol_lookback_candles: 12,              // 12 × 5m
    sigB_ath_dip_min_pct: -50,
    sigB_ath_dip_max_pct: -80,
    sigB_recovery_min_pct: 8,
    sigB_ath_max_age_ms: 6 * 3600 * 1000,

    // Probe state machine (FR-7, §4.5)
    probe_confirm_min_pnl_pct: 3,
    probe_fail_max_pnl_pct: -7,
    probe_max_age_ms: 240000,                   // 4m
    probe_require_volume_holding: true,
    probe_require_ema_bullish: true,
    probe_require_no_overbought: true,
    probe_require_above_entry_ema: true,

    // Exit (FR-8)
    sl_pct: -25,
    stoch_overbought: 80,
    partial_tp_sell_pct: 40,
    trailing_pct: 30,
    reentry_cooldown_ms: 300000,                // 5m

    // Adaptive TF (FR-6)
    tf_age_30s_max_ms: 6 * 3600 * 1000,         // <6h → 30s
    tf_age_1m_max_ms: 48 * 3600 * 1000,         // <48h → 1m, else 5m
  }), ts);
}

export function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
