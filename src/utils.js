export function now() { return Date.now(); }

export function safeJson(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}
export function json(value) { return JSON.stringify(value ?? null); }
export function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

export function stripThinking(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim();
}
export function strictJsonFromText(text) {
  const clean = stripThinking(text);
  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = fenced || clean.match(/\{[\s\S]*\}/)?.[0] || clean;
  return JSON.parse(raw);
}

export function pruneSeen(map, ttlMs) {
  const at = now();
  for (const [key, ts] of map) if (at - ts > ttlMs) map.delete(key);
}

export function firstPositiveNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export function clamp(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

export function lamToSol(lamports) {
  return Number(lamports) / 1_000_000_000;
}

export function marketCapFromGmgn(info) {
  const direct = Number(info?.market_cap ?? info?.mcap);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const price = Number(info?.price);
  const supply = Number(info?.circulating_supply ?? info?.total_supply);
  return Number.isFinite(price) && Number.isFinite(supply) ? price * supply : null;
}
export function tokenPriceFromGmgn(info) {
  const price = Number(info?.price);
  return Number.isFinite(price) ? price : null;
}

export function parseNumericInput(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[$,%\s,_]/g, '');
  if (raw === 'off' || raw === 'none' || raw === 'disable') return 0;
  const m = raw.match(/^(-?\d+(?:\.\d+)?)([kmb])?$/);
  if (!m) return null;
  const mult = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };
  const parsed = Number(m[1]) * (mult[m[2]] || 1);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseWindowMs(value = '12h') {
  const raw = String(value || '12h').trim().toLowerCase();
  const m = raw.match(/^(\d+(?:\.\d+)?)(m|h|d)?$/);
  if (!m) return 12 * 60 * 60 * 1000;
  const amount = Number(m[1]);
  const unit = m[2] || 'h';
  const mult = { m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };
  return Math.max(5 * 60_000, Math.min(30 * 24 * 60 * 60_000, amount * mult[unit]));
}
export function formatWindow(ms) {
  if (ms % (24 * 60 * 60_000) === 0) return `${ms / (24 * 60 * 60_000)}d`;
  if (ms % (60 * 60_000) === 0) return `${ms / (60 * 60_000)}h`;
  return `${Math.round(ms / 60_000)}m`;
}

export function makeFailureTracker(name, alertFn, threshold = 3) {
  let count = 0;
  return async (fn) => {
    try { await fn(); count = 0; }
    catch (err) {
      count++;
      console.log(`[${name}] ${err.message}`);
      if (count >= threshold) {
        alertFn(`⚠️ <b>${name}</b> failed ${count}x in a row: ${err.message}`).catch(() => {});
        count = 0;
      }
    }
  };
}

// Math helpers used by indicators / trend detector
export function mean(arr) {
  const xs = arr.filter(x => Number.isFinite(x));
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
export function stddev(arr) {
  const xs = arr.filter(x => Number.isFinite(x));
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}
export function zscore(arr, value) {
  const sd = stddev(arr);
  if (!sd) return 0;
  return (value - mean(arr)) / sd;
}
