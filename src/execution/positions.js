// Position monitor (FR-9). Runs every POSITION_CHECK_MS (default 10s).
// For each open / probe_open / probe_confirmed / probe_inconclusive position:
//   1. Refresh market price/mcap (Jupiter primary, GMGN token info fallback)
//   2. Refresh local indicators from cached chart (no extra fetch — uses watchlist tick)
//   3. If probe_open → evaluateProbe → confirmed (addon) / failed (close) / inconclusive (degrade)
//   4. If open      → evaluateExit  → SL / partial_tp / trail_exit / trend_exit / hold

import {
  openPositions, updatePosition, recordTrade, logPositionEvent, positionById,
} from '../db/positions.js';
import { activeStrategy } from '../db/settings.js';
import { evaluateProbe, executeAddon, pnlPctFromMarket } from './probe.js';
import { evaluateExit, pnlPct } from './exits.js';
import { executeSell } from './router.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset } from '../enrichment/jupiter.js';
import { firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn, now, safeJson } from '../utils.js';
import { getWatchlistRow, setWatchlistCooldown } from '../db/watchlist.js';
import { sendPositionExit, sendPositionEvent } from '../telegram/send.js';
import { db } from '../db/connection.js';

export async function monitorPositions() {
  const positions = openPositions();
  if (!positions.length) return;
  const strat = activeStrategy();
  for (const position of positions) {
    try { await processPosition(position, strat); }
    catch (err) { console.log(`[positions] #${position.id} error: ${err.message}`); }
  }
}

async function processPosition(position, strat) {
  const market = await refreshMarket(position.mint);
  if (!Number.isFinite(market.marketCapUsd) && !Number.isFinite(market.priceUsd)) {
    return; // no quote — try next tick
  }

  // Update high-water marks.
  const curMcap = Number(market.marketCapUsd || 0);
  const curPrice = Number(market.priceUsd || 0);
  const highMcap = Math.max(Number(position.high_water_mcap || 0), curMcap);
  const highPrice = Math.max(Number(position.high_water_price || 0), curPrice);
  if (highMcap !== Number(position.high_water_mcap || 0) || highPrice !== Number(position.high_water_price || 0)) {
    updatePosition(position.id, { high_water_mcap: highMcap || null, high_water_price: highPrice || null });
    position.high_water_mcap = highMcap;
    position.high_water_price = highPrice;
  }

  // Pull last watchlist indicators (computed by watchlist/monitor).
  const ind = readLastIndicators(position.mint);

  // ── Probe state ──────────────────────────────────────────────────────────
  if (position.status === 'probe_open' && position.probe_state === 'open') {
    const decision = await evaluateProbe(position, market, ind);
    logPositionEvent(position.id, `probe_eval:${decision.decision}`, {
      pnl_pct: decision.pnl,
      price_native: curPrice,
      mcap_usd: curMcap,
      reason: decision.reason,
    });
    if (decision.decision === 'confirmed') {
      await executeAddon(position.id);
      return;
    }
    if (decision.decision === 'failed') {
      await closePosition(position, market, ind, {
        reason: 'PROBE_FAILED',
        sellPct: 100,
      });
      return;
    }
    if (decision.decision === 'inconclusive') {
      // Stay in probe-only size, monitor with normal exits.
      updatePosition(position.id, { status: 'probe_inconclusive', probe_state: 'inconclusive' });
      return;
    }
    return;
  }

  // ── Open / probe_inconclusive — full exit logic ──────────────────────────
  const exit = evaluateExit({ position, marketSnapshot: market, ind, strat });
  if (exit.action === 'hold') return;

  if (exit.action === 'partial_tp') {
    const tokenAmountRaw = position.token_amount_raw || null;
    const sell = await executeSell({ mint: position.mint, tokenAmountRaw, sellFraction: exit.sellPct / 100 });
    recordTrade({
      positionId: position.id, mint: position.mint, side: 'sell',
      sizeSol: null, price: curPrice, mcap: curMcap, tokenAmountEst: null,
      reason: `partial_tp:${exit.reason}`, signature: sell.signature, executionMode: sell.mode,
      payload: { exit, sellPct: exit.sellPct },
    });
    updatePosition(position.id, { partial_tp_done: 1, trailing_armed: 1 });
    logPositionEvent(position.id, 'partial_tp', {
      pnl_pct: exit.pnl, price_native: curPrice, mcap_usd: curMcap, reason: exit.reason,
    });
    await sendPositionEvent(position.id, `🟡 Partial TP ${exit.sellPct}% — ${exit.reason}`).catch(() => {});
    return;
  }

  // Full exit
  await closePosition(position, market, ind, {
    reason: exit.action.toUpperCase(),
    sellPct: 100,
    detail: exit.reason,
  });
}

async function closePosition(position, market, _ind, { reason, sellPct = 100, detail = '' }) {
  const sell = await executeSell({
    mint: position.mint,
    tokenAmountRaw: position.token_amount_raw || null,
    sellFraction: sellPct / 100,
  });
  const pnl = pnlPct(position, market);
  const exitMcap = Number(market?.marketCapUsd || 0);
  const exitPrice = Number(market?.priceUsd || 0);
  const pnlSol = (Number(position.size_sol) * pnl) / 100;

  updatePosition(position.id, {
    status: 'closed',
    closed_at_ms: now(),
    exit_price: exitPrice || null,
    exit_mcap: exitMcap || null,
    exit_reason: reason,
    pnl_percent: pnl,
    pnl_sol: pnlSol,
    exit_signature: sell.signature || null,
  });
  recordTrade({
    positionId: position.id, mint: position.mint, side: 'sell',
    sizeSol: null, price: exitPrice, mcap: exitMcap, tokenAmountEst: null,
    reason: detail || reason,
    signature: sell.signature, executionMode: sell.mode,
    payload: { reason, detail },
  });
  logPositionEvent(position.id, `closed:${reason}`, {
    pnl_pct: pnl, price_native: exitPrice, mcap_usd: exitMcap, detail,
  });

  // Re-entry cooldown on the watchlist mint.
  const wlMint = position.watchlist_mint || position.mint;
  if (wlMint && getWatchlistRow(wlMint)) {
    const strat = activeStrategy();
    setWatchlistCooldown(wlMint, now() + Number(strat.reentry_cooldown_ms || 300_000), position.id);
  }
  await sendPositionExit(positionById(position.id) || { ...position, status: 'closed', exitReason: reason, pnl_percent: pnl }).catch(() => {});
}

async function refreshMarket(mint) {
  const gmgn = await fetchGmgnTokenInfo(mint, false).catch(() => null);
  const asset = await fetchJupiterAsset(mint, { useCache: false }).catch(() => null);
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn), asset?.mcap, asset?.fdv,
  );
  return { priceUsd, marketCapUsd, refreshedAtMs: now() };
}

function readLastIndicators(mint) {
  // Latest watchlist tick has trend_status, stoch_k, ema20, vol_5m_usd, etc.
  const row = db.prepare('SELECT * FROM watchlist_ticks WHERE mint = ? ORDER BY id DESC LIMIT 1').get(mint);
  if (!row) return {};
  const ind = safeJson(row.ind_json, {});
  return {
    trend_status: row.trend_status,
    stoch_k: row.stoch_k,
    ema20: row.ema20,
    ema_slope_5: ind?.ema_slope_5,
    vol_5m_usd: row.vol_5m_usd,
  };
}
