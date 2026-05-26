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
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      sent_at_ms INTEGER NOT NULL,
      telegram_message_id INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      candidate_ids_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      symbol TEXT,
      status TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER,
      size_sol REAL NOT NULL,
      entry_price REAL,
      entry_mcap REAL,
      token_amount_est REAL,
      high_water_price REAL,
      high_water_mcap REAL,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      trailing_armed INTEGER NOT NULL DEFAULT 0,
      exit_price REAL,
      exit_mcap REAL,
      exit_reason TEXT,
      pnl_percent REAL,
      pnl_sol REAL,
      llm_decision_id INTEGER,
      execution_mode TEXT DEFAULT 'dry_run',
      entry_signature TEXT,
      exit_signature TEXT,
      token_amount_raw TEXT,
      snapshot_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      side TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      price REAL,
      mcap REAL,
      size_sol REAL,
      token_amount_est REAL,
      reason TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tp_sl_rules (
      position_id INTEGER PRIMARY KEY,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trade_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      side TEXT NOT NULL,
      size_sol REAL NOT NULL,
      confidence REAL,
      reason TEXT,
      llm_decision_id INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decision_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_ms INTEGER NOT NULL,
      batch_id INTEGER,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      mode TEXT NOT NULL,
      action TEXT NOT NULL,
      verdict TEXT,
      confidence REAL,
      reason TEXT,
      guardrails_json TEXT NOT NULL,
      token_json TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      batch_json TEXT NOT NULL,
      execution_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS price_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      target_price_usd REAL,
      target_mcap_usd REAL,
      target_ath_distance_percent REAL,
      candidate_json TEXT NOT NULL,
      signals_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at_ms INTEGER NOT NULL,
      triggered_at_ms INTEGER,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_status ON price_alerts(status, expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_candidates_mint ON candidates(mint);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON dry_run_positions(status);
    CREATE INDEX IF NOT EXISTS idx_trade_intents_status ON trade_intents(status);
    CREATE INDEX IF NOT EXISTS idx_decision_logs_mint ON decision_logs(selected_mint);
    CREATE INDEX IF NOT EXISTS idx_signal_events_mint ON signal_events(mint);
    CREATE INDEX IF NOT EXISTS idx_learning_lessons_status ON learning_lessons(status, created_at_ms);
  `);
  ensureColumn('candidates', 'signal_key', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_signal_key ON candidates(signal_key) WHERE signal_key IS NOT NULL');
  ensureColumn('dry_run_positions', 'execution_mode', "TEXT DEFAULT 'dry_run'");
  ensureColumn('dry_run_positions', 'entry_signature', 'TEXT');
  ensureColumn('dry_run_positions', 'exit_signature', 'TEXT');
  ensureColumn('dry_run_positions', 'token_amount_raw', 'TEXT');
  ensureColumn('dry_run_positions', 'strategy_id', "TEXT DEFAULT 'obicle_confirmed'");
  ensureColumn('dry_run_positions', 'partial_tp_done', 'INTEGER DEFAULT 0');
  ensureColumn('decision_logs', 'strategy_id', 'TEXT');
  // Probe system columns
  ensureColumn('dry_run_positions', 'probe_state', 'TEXT');           // null|open|confirmed|failed|inconclusive
  ensureColumn('dry_run_positions', 'probe_size_sol', 'REAL');
  ensureColumn('dry_run_positions', 'addon_size_sol', 'REAL DEFAULT 0');
  ensureColumn('dry_run_positions', 'addon_at_ms', 'INTEGER');

  const defaults = {
    agent_enabled: 'true',
    trading_mode: process.env.TRADING_MODE || 'dry_run',
    llm_candidate_pick_count: process.env.LLM_CANDIDATE_PICK_COUNT || '10',
    llm_candidate_max_age_ms: process.env.LLM_CANDIDATE_MAX_AGE_MS || String(10 * 60 * 1000),
    llm_min_confidence: '75',
    max_open_positions: process.env.MAX_OPEN_POSITIONS || '3',
    dry_run_buy_sol: '0.1',
    default_tp_percent: '50',
    default_sl_percent: '-25',
    default_trailing_enabled: 'true',
    default_trailing_percent: '20',
    min_fee_claim_sol: process.env.MIN_FEE_CLAIM_SOL || '2',
    min_mcap_usd: '0',
    max_mcap_usd: '0',
    min_gmgn_total_fee_sol: '0',
    min_graduated_volume_usd: '0',
    max_top20_holder_percent: '100',
    min_saved_wallet_holders: '0',
    gmgn_request_delay_ms: process.env.GMGN_REQUEST_DELAY_MS || '2500',
    gmgn_max_retries: process.env.GMGN_MAX_RETRIES || '2',
    trending_enabled: process.env.TRENDING_ENABLED || 'true',
    trending_source: process.env.TRENDING_SOURCE || 'jupiter',
    trending_allow_degen: process.env.TRENDING_ALLOW_DEGEN || 'false',
    trending_interval: process.env.TRENDING_INTERVAL || '5m',
    trending_limit: process.env.TRENDING_LIMIT || '100',
    trending_order_by: process.env.TRENDING_ORDER_BY || 'volume',
    trending_min_volume_usd: process.env.TRENDING_MIN_VOLUME_USD || '0',
    trending_min_swaps: process.env.TRENDING_MIN_SWAPS || '0',
    trending_max_rug_ratio: process.env.TRENDING_MAX_RUG_RATIO || '0.3',
    trending_max_bundler_rate: process.env.TRENDING_MAX_BUNDLER_RATE || '0.5',
    // Phase 2 defensive layer toggles
    enable_token_authority_guard: process.env.ENABLE_TOKEN_AUTHORITY_GUARD || 'true',
    reject_active_mint_authority: process.env.REJECT_ACTIVE_MINT_AUTHORITY || 'true',
    enable_network_congestion_guard: process.env.ENABLE_NETWORK_CONGESTION_GUARD || 'true',
    holder_risk_reject_score: process.env.HOLDER_RISK_REJECT_SCORE || '0.75',
    enable_daily_report: process.env.ENABLE_DAILY_REPORT || 'true',
  };
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(defaults)) insert.run(key, value);

  // Seed default strategies (INSERT OR IGNORE — won't overwrite existing rows).
  // After seeding, ensure exactly one strategy is enabled: obicle_confirmed.
  // This handles the case where an old DB has v1 strategies with different enabled states.
  const stratInsert = db.prepare('INSERT OR IGNORE INTO strategies (id, name, enabled, config_json, created_at_ms) VALUES (?, ?, ?, ?, ?)');
  const ts = Date.now();

  // Obicle confirmed (default) — based on Obicle PDF + ponyin + MemeTrans research.
  // Wait for post-graduation insider unwind, take confirmed entries on TA signals.
  // Mid-cap focus, partial TP, trailing stop after first take.
  stratInsert.run('obicle_confirmed', 'Obicle Confirmed', 1, JSON.stringify({
    entry_mode: 'ta_confirmed',           // wait for EMA touch + Stoch RSI bottom (phase 5)
    min_source_count: 2,                  // ≥2 of {axiom, fee_claim, jupiter_trending, pump_graduated}
    require_fee_claim: false,
    token_age_min_ms: 3600000,            // 1h minimum (Obicle anti-snipe + post-insider-unwind)
    token_age_max_ms: 86400000,           // 24h max
    min_mcap_usd: 150000,                 // Obicle threshold
    max_mcap_usd: 5000000,                // mid-cap cap
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    fee_to_mcap_min_ratio: 0.0001,        // Obicle 1:10K SOL-fee:USD-mcap ratio (15 SOL per 150K MC)
    min_holders: 200,                     // MemeTrans baseline
    max_top20_holder_percent: 60,
    max_top10_holder_percent: 30,         // Mobula green flag
    max_dev_holder_percent: 5,
    max_bundled_pct: 20,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 5000,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.2,
    trending_max_bundler_rate: 0.3,
    position_size_sol: 0.1,               // Obicle 10% of 1 SOL wallet
    max_open_positions: 3,
    tp_percent: 60,
    sl_percent: -20,
    trailing_enabled: true,
    trailing_percent: 15,
    partial_tp: true,
    partial_tp_at_percent: 40,
    partial_tp_sell_percent: 50,
    max_hold_ms: 14400000,                // 4h
    use_llm: true,
    llm_min_confidence: 65,
  }), ts);

  // Graduation pump — fast scalp on freshly-graduated tokens (or near-bonded).
  // Replaces v1 sniper. Tight risk, tight stops, no LLM (latency).
  stratInsert.run('graduation_pump', 'Graduation Pump', 0, JSON.stringify({
    entry_mode: 'immediate',
    min_source_count: 2,
    require_fee_claim: false,
    token_age_min_ms: 60000,              // 1 minute min (avoid same-block sniper window)
    token_age_max_ms: 900000,             // 15 minute max (Trench Review filter)
    min_mcap_usd: 30000,                  // post-graduation typical
    max_mcap_usd: 200000,                 // before late
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    fee_to_mcap_min_ratio: 0,             // skip on fast-scalp; rely on holder/wash filters
    min_holders: 75,                      // Trench Review threshold
    max_top20_holder_percent: 70,
    max_top10_holder_percent: 40,
    max_dev_holder_percent: 8,
    max_bundled_pct: 25,                  // MemeTrans 21% wash baseline + buffer
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 30000,       // Trench Review threshold
    trending_min_swaps: 200,
    trending_max_rug_ratio: 0.3,
    trending_max_bundler_rate: 0.4,
    position_size_sol: 0.05,              // half of obicle (riskier class)
    max_open_positions: 3,
    tp_percent: 60,
    sl_percent: -15,
    trailing_enabled: true,
    trailing_percent: 10,
    partial_tp: true,
    partial_tp_at_percent: 25,
    partial_tp_sell_percent: 70,
    max_hold_ms: 1800000,                 // 30 minute max hold (sniper-class)
    use_llm: false,                       // rule-based, latency sensitive
    llm_min_confidence: 0,
  }), ts);

  // Migration play — wait for ATH dump cooldown, enter on volume recovery.
  // Replaces v1 dip_buy with research-tuned defaults.
  stratInsert.run('migration_play', 'Migration Play', 0, JSON.stringify({
    entry_mode: 'wait_for_dip',
    min_source_count: 2,
    require_fee_claim: false,
    token_age_min_ms: 7200000,            // 2h min (post-initial-pump cooldown)
    token_age_max_ms: 0,                  // no upper bound; managed by ATH age
    min_mcap_usd: 50000,                  // survived initial dump
    max_mcap_usd: 1000000,
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    fee_to_mcap_min_ratio: 0.00005,       // half of obicle, more lenient post-cooldown
    min_holders: 250,
    max_top20_holder_percent: 55,
    max_top10_holder_percent: 30,
    max_dev_holder_percent: 5,
    max_bundled_pct: 20,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: -50,            // wait 50% drop from ATH
    min_age_after_ath_ms: 1800000,        // 30min after ATH (avoid falling knife)
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 3000,        // showing buyers returning
    trending_min_swaps: 50,
    trending_max_rug_ratio: 0.2,
    trending_max_bundler_rate: 0.3,
    position_size_sol: 0.08,
    max_open_positions: 3,
    tp_percent: 75,
    sl_percent: -22,
    trailing_enabled: true,
    trailing_percent: 12,
    partial_tp: true,
    partial_tp_at_percent: 35,
    partial_tp_sell_percent: 50,
    max_hold_ms: 28800000,                // 8h
    use_llm: true,
    llm_min_confidence: 65,
  }), ts);

  // Degen Micro — high-frequency micro-cap plays in the 10K-100K mcap range.
  //
  // Research basis:
  //   - MemeTrans paper (Georgia Tech): 84% of graduated tokens are high-risk.
  //     Compensate with small position size (0.05 SOL) and fast exits.
  //   - Pine Analytics: sniper bots exit within 5 minutes. Wait 5 min before entry
  //     to avoid buying into sniper exit pressure.
  //   - Axiom Pulse "Golden Hour" filter (Trench Review): age 5-60min, vol >$10K,
  //     holders >50, transactions >100 = momentum confirmed.
  //   - DegenProtection exit rule: sell 50% at 2x (100% profit), hold 50% as
  //     moonbag for 5x-10x cycle.
  //   - Holder concentration relaxed vs obicle_confirmed: micro-cap reality is
  //     top10 often 40-60%. Compensate with smaller size + faster exit.
  //   - LLM ON: use_llm=true with lower confidence threshold (55%) because
  //     micro-cap signals are noisier — LLM acts as final sanity check.
  //   - No fee/mcap ratio check: micro-cap tokens rarely have meaningful fee data.
  //   - Network congestion guard still active: skip fresh-launch class when extreme.
  stratInsert.run('degen_micro', 'Degen Micro', 0, JSON.stringify({
    entry_mode: 'stoch_rsi',              // entry when Stoch RSI K < 20 (oversold + turning up)
    stoch_rsi_oversold: 20,               // entry threshold (K < 20)
    stoch_rsi_overbought: 80,             // exit threshold (K > 80, only in profit)
    min_source_count: 2,
    require_fee_claim: false,
    token_age_min_ms: 300000,             // 5 min min — let sniper bots exit first
    token_age_max_ms: 3600000,            // 60 min max — sweet spot pre-community-discovery
    min_mcap_usd: 8000,                   // lowered from 10K (28% reject was too high)
    max_mcap_usd: 120000,                 // raised from 100K (edge case: LLM pick mcap rises slightly)
    min_fee_claim_sol: 0,
    min_gmgn_total_fee_sol: 0,
    fee_to_mcap_min_ratio: 0,             // skip — micro-cap rarely has fee data
    min_holders: 50,                      // Axiom Pulse threshold
    max_top20_holder_percent: 75,         // relaxed — micro-cap reality (label = max single holder)
    max_top10_holder_percent: 65,         // relaxed from 60% (44% reject rate in audit)
    max_dev_holder_percent: 10,           // still enforce dev cap
    max_bundled_pct: 30,                  // relaxed from 20%
    holder_risk_reject_score: 0.90,       // per-strategy override (global is 0.75)
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    min_graduated_volume_usd: 0,
    trending_min_volume_usd: 3000,        // lowered from 10K (76% reject was too aggressive)
    trending_min_swaps: 100,              // only enforced when swaps data is available
    trending_max_rug_ratio: 0.4,          // more tolerant than obicle
    trending_max_bundler_rate: 0.5,       // more tolerant
    position_size_sol: 0.05,              // small — 84% of micro-caps are high-risk
    max_open_positions: 5,                // allow more concurrent micro-cap plays
    tp_percent: 100,                      // 2x = 100% profit → trigger partial TP
    sl_percent: -20,                      // tight SL — micro-cap dumps fast
    trailing_enabled: true,
    trailing_percent: 15,                 // trail after partial TP
    partial_tp: true,
    partial_tp_at_percent: 100,           // sell 50% at 2x
    partial_tp_sell_percent: 50,          // keep 50% as moonbag
    max_hold_ms: 2700000,                 // 45 min max hold
    use_llm: true,
    llm_min_confidence: 55,              // lower threshold — micro-cap is noisier
    // Probe system
    probe_enabled: true,
    probe_size_pct: 25,                   // buy 25% first
    probe_confirm_min_pnl_pct: 5,         // +5% to confirm
    probe_fail_max_pnl_pct: -10,          // -10% to fail
    probe_max_age_ms: 300000,             // 5 min window
  }), ts);
}

export function ensureColumn(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
