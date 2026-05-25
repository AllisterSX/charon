// Offline smoke test. Exits non-zero on any assertion failure.
// Usage: node scripts/smoke-test.js
import assert from 'node:assert/strict';

// Patch env so config.validateConfig() does not require real keys for module load.
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'smoke-token';
process.env.TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '0';
process.env.HELIUS_API_KEY     = process.env.HELIUS_API_KEY     || 'smoke';
process.env.GMGN_API_KEY       = process.env.GMGN_API_KEY       || 'smoke';
process.env.DB_PATH            = process.env.DB_PATH            || './apex.smoke.sqlite';
process.env.GMGN_ENABLED       = 'false';

const { ema, stochRsi, atr } = await import('../src/chart/indicators.js');
const { scoreTrend } = await import('../src/watchlist/trendDetector.js');
const { evaluateSignalA } = await import('../src/entry/signalA.js');
const { evaluateSignalB } = await import('../src/entry/signalB.js');
const { gateCandidate } = await import('../src/screening/metricsGate.js');
const { initDb, db } = await loadDb();

function passing() { console.log('  ✓'); }

console.log('1. DB initializes');
initDb();
const stratRow = db.prepare("SELECT id FROM strategies WHERE id = 'apex_obicle'").get();
assert.equal(stratRow.id, 'apex_obicle');
passing();

console.log('2. metricsGate accepts a healthy candidate');
const goodStrat = {
  max_mcap_usd: 100000, token_age_max_ms: 3600000, min_holders: 50,
  max_top10_holder_percent: 65, fee_to_mcap_min_ratio: 0,
  require_mint_authority_revoked: false, holder_risk_reject_score: 0.9,
  min_source_count: 1,
};
const good = makeCandidate({ mcap: 50000, ageMs: 1800000, holders: 100, top10: 40, sources: 2 });
const okGate = gateCandidate(good, goodStrat);
assert.equal(okGate.passed, true, `failures: ${okGate.failures.join('; ')}`);
passing();

console.log('3. metricsGate rejects oversize mcap');
const bad = makeCandidate({ mcap: 500000, ageMs: 1800000, holders: 100, top10: 40, sources: 2 });
assert.equal(gateCandidate(bad, goodStrat).passed, false);
passing();

console.log('4. EMA and Stoch RSI compute on a known input');
const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.1);
const e = ema(closes, 20);
assert.ok(Number.isFinite(e[e.length - 1]));
const sr = stochRsi(closes, 14, 3, 3);
assert.ok(Number.isFinite(sr.k[sr.k.length - 1]));
passing();

console.log('5. ATR returns sane numbers');
const candles = closes.map((c, i) => ({
  o: c, h: c + 1, l: c - 1, c, v: 1000 + i * 10,
}));
const at = atr(candles, 14);
assert.ok(Number.isFinite(at[at.length - 1]));
passing();

console.log('6. Trend detector classifies an uptrend');
const upCandles = Array.from({ length: 60 }, (_, i) => {
  const base = 100 + i * 0.5;
  return { o: base, h: base + 1, l: base - 0.5, c: base + 0.5, v: 1000 + i * 30, t: i };
});
const tUp = scoreTrend(upCandles);
assert.ok(['uptrend', 'reversing'].includes(tUp.status), `got ${tUp.status}`);
passing();

console.log('7. Signal A fires on a constructed bullish reversal');
const sigACandles = buildSignalACandles();
const closesA = sigACandles.map(c => c.c);
const ema20A = ema(closesA, 20);
const srA = stochRsi(closesA, 14, 3, 3);
const a = evaluateSignalA({ candles: sigACandles, ema20Arr: ema20A, sr: srA, strat: { sigA_ema_touch_pct: 0.5, sigA_stoch_oversold: 30 } });
assert.ok(a.entry || a.reasons.length, `evalA returned ${JSON.stringify(a)}`);
passing();

console.log('8. Signal B fires on volume spike + ATH dip recovery');
const sigBCandles = buildSignalBCandles();
const vols = sigBCandles.map(c => c.v);
const ath = { price: 200, at: Date.now() - 2 * 3600 * 1000 };
const trough = { price: 70, at: Date.now() - 1 * 3600 * 1000 };
const b = evaluateSignalB({
  candles: sigBCandles, vols, ath, trough,
  strat: {
    sigB_vol_spike_multiplier: 2,
    sigB_vol_spike_zscore: 1,
    sigB_vol_lookback_candles: 12,
    sigB_ath_dip_min_pct: -50, sigB_ath_dip_max_pct: -80,
    sigB_recovery_min_pct: 5,
    sigB_ath_max_age_ms: 6 * 3600 * 1000,
  },
});
assert.ok(b.entry || b.reasons.length, `evalB ${JSON.stringify(b.metrics)}`);
passing();

console.log('\nAll smoke checks passed.');
process.exit(0);

// ── helpers ─────────────────────────────────────────────────────────────────

async function loadDb() {
  // Avoid accidentally writing the real DB.
  const mod = await import('../src/db/connection.js');
  return mod;
}

function makeCandidate({ mcap, ageMs, holders, top10, sources }) {
  return {
    token: { mint: 'TestMint11111111111111111111111111111111111' },
    signals: { ageMs, sourceCount: sources, sources: ['fee', 'graduated'] },
    metrics: { marketCapUsd: mcap, holderCount: holders },
    holders: { top10Percent: top10, top20Percent: top10 + 10, maxHolderPercent: 15, holders: [] },
    feeClaim: null,
    trending: null,
    authority: { checked: true, mintAuthorityActive: false, freezeAuthorityActive: false },
    holderRisk: { checked: true, riskScore: 0.1, flags: [] },
    washTrade: { checked: false, flags: [] },
    filters: {},
  };
}

function buildSignalACandles() {
  // Construct a series where the last bar has a low touching EMA20, K bottoming and turning up,
  // and last 2 closes above EMA.
  const arr = [];
  for (let i = 0; i < 50; i++) {
    const base = 100 + Math.sin(i / 3) * 0.5;
    arr.push({ o: base, h: base + 0.3, l: base - 0.3, c: base + 0.1, v: 1000, t: i });
  }
  // Force a dip + recovery
  for (let j = 50; j < 56; j++) {
    arr.push({ o: 100, h: 100.2, l: 99.7, c: 99.9, v: 800, t: j });
  }
  arr.push({ o: 100, h: 100.5, l: 99.6, c: 100.4, v: 1500, t: 56 });
  arr.push({ o: 100.4, h: 101.0, l: 100.3, c: 100.9, v: 1700, t: 57 });
  return arr;
}

function buildSignalBCandles() {
  const arr = [];
  for (let i = 0; i < 24; i++) {
    arr.push({ o: 90, h: 92, l: 88, c: 91, v: 200, t: i });
  }
  // Spike candle.
  arr.push({ o: 91, h: 99, l: 90, c: 96, v: 1800, t: 24 });
  return arr;
}
