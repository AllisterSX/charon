// Test GMGN trending fetch — see what data fields are available.
// Usage: GMGN_API_KEY=xxx node scripts/test-gmgn-trending.js

import { randomUUID } from 'node:crypto';

const KEY = process.env.GMGN_API_KEY;
if (!KEY) { console.error('Set GMGN_API_KEY env var'); process.exit(1); }

const url = new URL('https://openapi.gmgn.ai/v1/market/rank');
const params = {
  chain: 'sol',
  interval: '5m',
  limit: '10',
  order_by: 'volume',
  direction: 'desc',
  timestamp: Math.floor(Date.now() / 1000),
  client_id: randomUUID(),
};
for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

const res = await fetch(url, { headers: { 'X-APIKEY': KEY, 'Content-Type': 'application/json' } });
const data = await res.json();

const rows = data?.data?.rank || data?.data?.data?.rank || [];
console.log(`Status: ${res.status}, Rows: ${rows.length}\n`);

if (!rows.length) {
  console.log('Raw response:', JSON.stringify(data).slice(0, 500));
  process.exit(1);
}

// Print all fields of first row to see what's available
console.log('=== FIRST ROW (all fields) ===');
console.log(JSON.stringify(rows[0], null, 2));

console.log('\n=== TOP 10 SUMMARY ===');
console.log('Symbol | MCap | Vol5m | Holders | TotalFee | Top10% | Bundler% | Age | Mint');
console.log('-'.repeat(120));
for (const r of rows) {
  const symbol = (r.symbol || r.name || '?').padEnd(12);
  const mcap = `$${(Number(r.market_cap || r.mcap || 0) / 1000).toFixed(0)}K`.padEnd(10);
  const vol = `$${(Number(r.volume || 0) / 1000).toFixed(1)}K`.padEnd(10);
  const holders = String(r.holder_count || r.holders || '?').padEnd(8);
  const fee = `${Number(r.total_fee || 0).toFixed(1)} SOL`.padEnd(12);
  const top10 = r.top_10_holder_rate != null ? `${(Number(r.top_10_holder_rate) * 100).toFixed(1)}%` : '?';
  const bundler = r.bundler_rate != null ? `${(Number(r.bundler_rate) * 100).toFixed(1)}%` : (r.bot_ratio != null ? `${(Number(r.bot_ratio) * 100).toFixed(1)}%` : '?');
  const age = r.creation_timestamp ? `${Math.round((Date.now()/1000 - Number(r.creation_timestamp)) / 3600)}h` : '?';
  const mint = (r.address || r.mint || '').slice(0, 8);
  console.log(`${symbol} ${mcap} ${vol} ${holders} ${fee} ${top10.padEnd(8)} ${bundler.padEnd(8)} ${age.padEnd(6)} ${mint}`);
}

console.log('\n=== KEY FIELDS CHECK ===');
const first = rows[0];
const fields = [
  'address', 'symbol', 'name', 'market_cap', 'mcap', 'volume', 'volume_5m',
  'holder_count', 'holders', 'total_fee', 'top_10_holder_rate', 'bundler_rate',
  'bot_ratio', 'creation_timestamp', 'created_at', 'liquidity', 'swaps', 'buys', 'sells',
  'is_wash_trading', 'rug_ratio', 'smart_degen_count', 'organic_score', 'hot_level',
  'launchpad', 'open_timestamp', 'price', 'renounced_mint', 'renounced_freeze_account',
];
for (const f of fields) {
  const val = first[f];
  console.log(`  ${f.padEnd(25)} = ${val !== undefined ? JSON.stringify(val) : '(missing)'}`);
}
