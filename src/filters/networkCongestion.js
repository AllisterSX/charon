// Network congestion guard — Phase 2 defensive layer (ponyin phase 4).
// Pakai Helius getPriorityFeeEstimate untuk tahu apakah network lagi ramai.
// Fast-launch / sniper-style strategy harus skip atau size-down saat congestion ekstrem.
//
// Reference:
//   - Helius getPriorityFeeEstimate: https://docs.helius.dev/solana-apis/priority-fee-api
//   - Returns recommended micro-lamports per compute unit at the requested percentile.

import axios from 'axios';
import { SOLANA_RPC_URL, JSON_HEADERS, PUMP_PROGRAM, PUMP_AMM } from '../config.js';
import { now } from '../utils.js';

let cached = { at: 0, data: null };
const CACHE_TTL_MS = 30 * 1000;

export async function fetchNetworkCongestion({ useCache = true } = {}) {
  if (useCache && cached.data && now() - cached.at < CACHE_TTL_MS) return cached.data;

  try {
    const res = await axios.post(SOLANA_RPC_URL, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getPriorityFeeEstimate',
      params: [{
        accountKeys: [PUMP_PROGRAM, PUMP_AMM],
        options: { includeAllPriorityFeeLevels: true, lookbackSlots: 150 },
      }],
    }, { timeout: 5000, headers: { ...JSON_HEADERS, 'content-type': 'application/json' } });

    const levels = res.data?.result?.priorityFeeLevels;
    if (!levels) {
      const data = { checked: false, error: 'no priorityFeeLevels in response' };
      cached = { at: now(), data };
      return data;
    }

    const high = Number(levels.high || 0);
    const veryHigh = Number(levels.veryHigh || 0);
    const unsafeMax = Number(levels.unsafeMax || veryHigh);

    // Heuristic: classify network state.
    // These thresholds are based on observed Helius numbers during normal vs storm conditions.
    let level = 'normal';
    let action = 'proceed';
    let sizeMultiplier = 1.0;
    if (high >= 200_000) {
      level = 'extreme';
      action = 'skip_fresh_launch';
      sizeMultiplier = 0.5;
    } else if (high >= 100_000) {
      level = 'high';
      action = 'reduce_size';
      sizeMultiplier = 0.75;
    } else if (high >= 50_000) {
      level = 'elevated';
      action = 'proceed';
      sizeMultiplier = 0.9;
    }

    const data = {
      checked: true,
      level,
      action,
      sizeMultiplier,
      microLamports: { high, veryHigh, unsafeMax },
      fetchedAtMs: now(),
    };
    cached = { at: now(), data };
    return data;
  } catch (err) {
    const status = err.response?.status || '';
    console.log(`[congestion] ${status} ${err.message}`);
    const data = { checked: false, error: err.message };
    cached = { at: now() - CACHE_TTL_MS + 10_000, data };
    return data;
  }
}
