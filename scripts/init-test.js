// Init-test: spin up DB at apex.test-init.sqlite, run migrations, assert schema, clean up.
import fs from 'node:fs';
import path from 'node:path';

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'init-token';
process.env.TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '0';
process.env.HELIUS_API_KEY     = process.env.HELIUS_API_KEY     || 'init';
process.env.GMGN_API_KEY       = process.env.GMGN_API_KEY       || 'init';
process.env.GMGN_ENABLED       = 'false';
const dbPath = './apex.test-init.sqlite';
process.env.DB_PATH = dbPath;

if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
['-journal', '-wal', '-shm'].forEach(suffix => {
  const p = `${dbPath}${suffix}`;
  if (fs.existsSync(p)) fs.unlinkSync(p);
});

const { initDb, db } = await import('../src/db/connection.js');
initDb();

const expectedTables = [
  'settings', 'saved_wallets', 'strategies',
  'candidates', 'signal_events',
  'llm_decisions', 'decision_logs',
  'watchlist', 'watchlist_ticks', 'watchlist_events',
  'positions', 'position_events', 'trades', 'trade_intents',
  'blacklist', 'chart_cache',
  'alerts', 'learning_runs', 'learning_lessons',
];
const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
for (const t of expectedTables) {
  if (!existing.includes(t)) {
    console.error(`Missing table: ${t}`);
    process.exit(1);
  }
}

const strat = db.prepare("SELECT * FROM strategies WHERE id = 'apex_obicle'").get();
if (!strat || !strat.enabled) {
  console.error('Strategy apex_obicle missing or not enabled');
  process.exit(1);
}

console.log(`OK — schema has ${existing.length} tables, apex_obicle seeded and enabled.`);
db.close();

['', '-journal', '-wal', '-shm'].forEach(suffix => {
  const p = `${dbPath}${suffix}`;
  if (fs.existsSync(p)) fs.unlinkSync(p);
});

process.exit(0);
