import axios from 'axios';
import { WSOL_MINT, JSON_HEADERS } from '../config.js';
import { now } from '../utils.js';

const jupiterAssetCache = new Map();
let jupiterAssetBackoffUntil = 0;

export function jupiterAssetBackoffActive() {
  return now() < jupiterAssetBackoffUntil;
}
export function setJupiterAssetBackoff(err) {
  if (err.response?.status !== 429) return;
  const resetHeader = Number(err.response?.headers?.['x-ratelimit-reset'] || 0);
  const resetMs = resetHeader > 1_000_000_000_000 ? resetHeader : resetHeader * 1000;
  jupiterAssetBackoffUntil = resetMs > now() ? resetMs : now() + 30_000;
  console.log(`[asset] backing off until ${new Date(jupiterAssetBackoffUntil).toISOString()} (429)`);
}

export async function fetchJupiterAsset(mint, { useCache = true, ttlMs = 20_000 } = {}) {
  const cached = jupiterAssetCache.get(mint);
  if (useCache && cached && now() - cached.at < ttlMs) return cached.data;
  if (jupiterAssetBackoffActive()) return cached?.data || null;
  try {
    const url = new URL('https://datapi.jup.ag/v1/assets/search');
    url.searchParams.set('query', mint);
    const res = await axios.get(url.toString(), { timeout: 10_000, headers: JSON_HEADERS });
    const rows = Array.isArray(res.data) ? res.data : [];
    const data = rows.find(row => row?.id === mint) || rows[0] || null;
    jupiterAssetCache.set(mint, { at: now(), data });
    return data;
  } catch (err) {
    setJupiterAssetBackoff(err);
    if (err.response?.status !== 429) console.log(`[asset] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    return cached?.data || null;
  }
}

export async function fetchSolUsdPrice() {
  try {
    const res = await axios.get(`https://lite-api.jup.ag/price/v3?ids=${WSOL_MINT}`, {
      timeout: 5000,
      headers: JSON_HEADERS,
    });
    const price = Number(res.data?.[WSOL_MINT]?.usdPrice);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch (err) {
    console.log(`[sol-price] ${err.response?.status || ''} ${err.message}`);
    return null;
  }
}

export async function estimateTokenAmountFromSol(sizeSol, entryPrice) {
  if (!Number.isFinite(Number(entryPrice)) || Number(entryPrice) <= 0) return null;
  const solUsd = await fetchSolUsdPrice();
  if (!Number.isFinite(Number(solUsd)) || Number(solUsd) <= 0) return null;
  return Number(sizeSol) * solUsd / Number(entryPrice);
}

export async function fetchJupiterHolders(mint) {
  try {
    const res = await axios.get(`https://datapi.jup.ag/v1/holders/${mint}`, {
      timeout: 10_000,
      headers: JSON_HEADERS,
    });
    const holders = Array.isArray(res.data?.holders) ? res.data.holders : [];
    const total = holders.reduce((sum, h) => sum + Number(h.amount || 0), 0);
    const mapped = holders.map((holder, index) => {
      const pct = total > 0 ? Number(holder.amount || 0) / total * 100 : null;
      return {
        address: holder.address,
        rank: index + 1,
        amount: Number(holder.amount || 0),
        percent: pct,
        tags: (holder.tags || []).map(tag => tag.name || tag.id).filter(Boolean),
      };
    });
    const top10 = mapped.slice(0, 10);
    const top20 = mapped.slice(0, 20);
    return {
      count: holders.length,
      holders: mapped,
      top10,
      top20,
      top10Percent: top10.reduce((sum, h) => sum + Number(h.percent || 0), 0),
      top20Percent: top20.reduce((sum, h) => sum + Number(h.percent || 0), 0),
      maxHolderPercent: Math.max(0, ...top20.map(h => Number(h.percent || 0))),
    };
  } catch (err) {
    console.log(`[holders] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    return { count: 0, holders: [], top10: [], top20: [], top10Percent: null, top20Percent: null, maxHolderPercent: null };
  }
}
