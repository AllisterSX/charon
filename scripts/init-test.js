// Init smoke test — verifies SQLite schema + strategy seed works without starting full bot.
// Run after fresh install before going to TG setup.

import 'dotenv/config';
import fs from 'node:fs';

const DB_PATH = process.env.DB_PATH || './charon-v2.sqlite';

// Wipe any existing test DB so we test fresh init.
const testDbPath = './charon-v2.test-init.sqlite';
process.env.DB_PATH = testDbPath;
try { fs.rmSync(testDbPath); } catch {}
try { fs.rmSync(testDbPath + '-shm'); } catch {}
try { fs.rmSync(testDbPath + '-wal'); } catch {}

const { initDb } = await import('../src/db/connection.js');
const { allStrategies, activeStrategy } = await import('../src/db/settings.js');

initDb();
const strategies = allStrategies();
const active = activeStrategy();

console.log(`--- charon-v2 init smoke test ---`);
console.log(`DB: ${testDbPath}`);
console.log(`Strategies seeded: ${strategies.length}`);
for (const s of strategies) {
  console.log(`  ${s.enabled ? '*' : ' '} ${s.id.padEnd(20)} ${s.name}`);
}
console.log(`Active: ${active.id} (entry_mode=${active.entry_mode}, mcap=${active.min_mcap_usd}-${active.max_mcap_usd}, age=${active.token_age_min_ms || 0}-${active.token_age_max_ms || '∞'}ms)`);

// Cleanup
try { fs.rmSync(testDbPath); } catch {}
try { fs.rmSync(testDbPath + '-shm'); } catch {}
try { fs.rmSync(testDbPath + '-wal'); } catch {}

const expectedIds = ['obicle_confirmed', 'graduation_pump', 'migration_play', 'degen_micro'];
const actualIds = strategies.map(s => s.id);
const missing = expectedIds.filter(id => !actualIds.includes(id));
if (missing.length || active.id !== 'obicle_confirmed') {
  console.error(`FAIL: missing ${missing.join(',') || 'none'}; active should be obicle_confirmed but is ${active.id}`);
  process.exit(1);
}
console.log('OK: all 3 tier-1 strategies seeded, obicle_confirmed active by default.');
