// Probe state machine (FR-7, design §4.5).
//   open → confirmed (+pnl ≥ 3% in 4m AND alt-criteria) → add-on 75%
//        → failed    (-pnl ≤ -7% in 4m) → close 100%
//        → inconclusive (4m elapsed, neither hit) → hold probe-only

import {
  insertPosition, updatePosition, logPositionEvent, recordTrade,
  positionById,
} from '../db/positions.js';
import { firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn, now } from '../utils.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset } from '../enrichment/jupiter.js';
import { executeBuy } from './router.js';
import { sendPositionOpen, sendPositionEvent } from '../telegram/send.js';
import { activeStrategy } from '../db/settings.js';

// Open the probe. Buys probe_size_pct % of position_size_sol.
export async function openProbe({ candidate, candidateId, watchlistRow, signal, tf, evaluation, candles, strat }) {
  const mint = candidate.token?.mint || watchlistRow?.mint;
  const symbol = candidate.token?.symbol || watchlistRow?.symbol || null;

  // Refresh price/mcap immediately at execution time.
  const refreshed = await refreshMarket(mint, candidate);
  const sizeSol = Number(strat.position_size_sol || 0.1);
  const probePct = Number(strat.probe_size_pct || 25);
  const probeSize = +(sizeSol * probePct / 100).toFixed(6);

  const buy = await executeBuy({
    mint,
    sizeSol: probeSize,
    entryPrice: refreshed.priceUsd,
  });

  const positionId = insertPosition({
    candidateId, mint, symbol,
    strategyId: strat.id || 'apex_obicle',
    executionMode: buy.mode,
    entrySignal: signal,
    entryTf: tf,
    sizeSol,                // PLANNED full size; addon completes the rest
    probeSizeSol: probeSize,
    entryPrice: refreshed.priceUsd,
    entryMcap: refreshed.marketCapUsd,
    tokenAmountEst: buy.tokenAmountEst,
    tokenAmountRaw: buy.tokenAmountRaw,
    entrySignature: buy.signature,
    tpPercent: null,
    slPercent: Number(strat.sl_pct || -25),
    trailingEnabled: true,
    trailingPercent: Number(strat.trailing_pct || 30),
    watchlistMint: mint,
    snapshot: {
      signal, tf,
      evaluation: { reasons: evaluation?.reasons, metrics: evaluation?.metrics },
      candleCount: candles?.length || 0,
    },
  });

  recordTrade({
    positionId,
    mint,
    side: 'buy',
    sizeSol: probeSize,
    price: refreshed.priceUsd,
    mcap: refreshed.marketCapUsd,
    tokenAmountEst: buy.tokenAmountEst,
    reason: `probe_open:${signal}`,
    signature: buy.signature,
    executionMode: buy.mode,
    payload: { signal, tf, evaluation: evaluation?.metrics },
  });
  logPositionEvent(positionId, 'probe_open', {
    pnl_pct: 0,
    price_native: refreshed.priceUsd,
    mcap_usd: refreshed.marketCapUsd,
    signal, tf,
  });

  await sendPositionOpen(positionId).catch(() => {});
  return positionId;
}

// Called from execution/positions monitor while probe_state == 'open'.
export async function evaluateProbe(position, marketSnapshot, ind) {
  const strat = activeStrategy();
  const minConfirm = Number(strat.probe_confirm_min_pnl_pct ?? 3);
  const maxFail    = Number(strat.probe_fail_max_pnl_pct ?? -7);
  const maxAge     = Number(strat.probe_max_age_ms ?? 240000);
  const ageMs = now() - Number(position.opened_at_ms || now());

  const pnl = pnlPctFromMarket(position, marketSnapshot);

  if (pnl <= maxFail) {
    return { decision: 'failed', pnl, reason: `pnl ${pnl.toFixed(2)} <= ${maxFail}` };
  }

  if (pnl >= minConfirm) {
    const guards = evaluateProbeGuards(strat, position, marketSnapshot, ind);
    if (!guards.allPassed) {
      return { decision: 'pending', pnl, reason: `confirm_pnl_hit_but_guards_failed:${guards.failed.join(',')}` };
    }
    return { decision: 'confirmed', pnl, reason: `pnl ${pnl.toFixed(2)} >= ${minConfirm}, guards passed` };
  }

  if (ageMs >= maxAge) {
    return { decision: 'inconclusive', pnl, reason: `probe_age ${Math.round(ageMs/1000)}s >= ${Math.round(maxAge/1000)}s` };
  }
  return { decision: 'pending', pnl, reason: `awaiting_confirm_or_fail` };
}

function evaluateProbeGuards(strat, position, marketSnapshot, ind) {
  const failed = [];
  if (strat.probe_require_volume_holding) {
    const volNow = Number(ind?.vol_5m_usd || 0);
    const volEntry = Number(position.snapshot?.vol_5m_at_entry || 0);
    if (volEntry > 0 && volNow < volEntry * 0.5) failed.push('volume_drop');
  }
  if (strat.probe_require_ema_bullish) {
    const slope = Number(ind?.ema_slope_5 ?? 0);
    if (slope <= 0) failed.push('ema_slope_not_positive');
  }
  if (strat.probe_require_no_overbought) {
    const k = Number(ind?.stoch_k ?? 0);
    if (k > 70) failed.push('overbought');
  }
  if (strat.probe_require_above_entry_ema) {
    const cur = Number(marketSnapshot?.priceUsd || 0);
    const entryEma = Number(position.snapshot?.entry_ema20 || 0);
    if (entryEma > 0 && cur < entryEma) failed.push('below_entry_ema');
  }
  return { allPassed: failed.length === 0, failed };
}

// Once confirmed, buy the remaining (100 - probe_size_pct)%.
export async function executeAddon(positionId) {
  const position = positionById(positionId);
  if (!position) return;
  const refreshed = await refreshMarket(position.mint);
  const totalSize = Number(position.size_sol || 0);
  const probeSize = Number(position.probe_size_sol || 0);
  const addonSize = +(totalSize - probeSize).toFixed(6);
  if (addonSize <= 0) return;

  const buy = await executeBuy({
    mint: position.mint,
    sizeSol: addonSize,
    entryPrice: refreshed.priceUsd,
  });

  // Aggregate token_amount_est across probe + addon.
  const aggToken = (Number(position.token_amount_est) || 0) + (Number(buy.tokenAmountEst) || 0);

  updatePosition(positionId, {
    addon_size_sol: addonSize,
    addon_at_ms: now(),
    probe_state: 'confirmed',
    status: 'open',
    token_amount_est: aggToken || null,
  });
  recordTrade({
    positionId,
    mint: position.mint,
    side: 'buy',
    sizeSol: addonSize,
    price: refreshed.priceUsd,
    mcap: refreshed.marketCapUsd,
    tokenAmountEst: buy.tokenAmountEst,
    reason: 'addon',
    signature: buy.signature,
    executionMode: buy.mode,
    payload: { addonSize },
  });
  logPositionEvent(positionId, 'addon_filled', {
    pnl_pct: pnlPctFromMarket(position, refreshed),
    price_native: refreshed.priceUsd,
    mcap_usd: refreshed.marketCapUsd,
    addonSize,
  });
  await sendPositionEvent(positionId, '🟢 Probe confirmed — add-on filled').catch(() => {});
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function refreshMarket(mint, fallbackCandidate = null) {
  const gmgn = await fetchGmgnTokenInfo(mint, false).catch(() => null);
  const asset = await fetchJupiterAsset(mint, { useCache: false }).catch(() => null);
  const priceUsd = firstPositiveNumber(
    tokenPriceFromGmgn(gmgn),
    asset?.usdPrice,
    fallbackCandidate?.metrics?.priceUsd,
  );
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    fallbackCandidate?.metrics?.marketCapUsd,
  );
  return { priceUsd, marketCapUsd, refreshedAtMs: now() };
}

export function pnlPctFromMarket(position, marketSnapshot) {
  const entry = Number(position.entry_mcap || position.entry_price || 0);
  const cur = Number(marketSnapshot?.marketCapUsd || marketSnapshot?.priceUsd || 0);
  if (entry <= 0 || cur <= 0) return 0;
  return (cur / entry - 1) * 100;
}

function activeStrategyOrFallback(_id) {
  return activeStrategy();
}
