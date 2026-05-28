import { db } from './connection.js';
import { now, json } from '../utils.js';
import { numSetting, boolSetting, setting, activeStrategy } from './settings.js';

export function openPositions() {
  return db.prepare('SELECT * FROM dry_run_positions WHERE status = ? ORDER BY opened_at_ms DESC').all('open');
}

export function openPositionCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?').get('open').count;
}

export function canOpenMorePositions() {
  const strat = activeStrategy();
  const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
  if (max <= 0) return true;
  return openPositionCount() < max;
}

export function tradingMode() {
  const mode = setting('trading_mode', 'dry_run');
  return ['dry_run', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';
}

export function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

export function createDryRunPosition(candidateId, candidate, decision, reason = 'llm_buy') {
  const strat = activeStrategy();
  const sizeSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  // Always use strategy config — ignore LLM suggested TP/SL
  const tp = Number(strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return existing.id;

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      strat.id,
      json({ candidate, decision, reason, strategy: strat.id }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return positionId;
  })();
}

// Probe entry: buy only probe_size_pct% of position. Status = 'open', probe_state = 'open'.
export function createProbePosition(candidateId, candidate, decision, reason = 'probe_entry') {
  const strat = activeStrategy();
  const fullSize = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  const probePct = Number(strat.probe_size_pct ?? 25);
  const probeSize = +(fullSize * probePct / 100).toFixed(6);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    // Prevent duplicate: any position on this mint that's open OR opened in last 5 min
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions
      WHERE mint = ? AND (status = 'open' OR opened_at_ms > ?)
      LIMIT 1
    `).get(candidate.token.mint, now() - 300000);
    if (existing) return existing.id;

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, strategy_id,
        probe_state, probe_size_sol, addon_size_sol, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'open', ?, 0, ?)
    `).run(
      candidateId, candidate.token.mint, candidate.token.symbol, now(),
      probeSize, entryPrice, entryMcap, null, entryPrice, entryMcap,
      tp, sl, trailingEnabled, trailingPercent,
      decision.id || null, strat.id, probeSize,
      json({ candidate, decision, reason, strategy: strat.id, fullSize, probePct }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, probeSize, null, `probe_open:${reason}`, json({ candidateId, decision, probePct }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    console.log(`[probe] opened #${positionId} ${candidate.token.symbol || candidate.token.mint.slice(0, 8)} probe ${probeSize} SOL (${probePct}% of ${fullSize})`);
    return positionId;
  })();
}

// Add-on after probe confirmed: buy remaining (100 - probe_size_pct)%.
// For live positions, executes actual Jupiter swap.
export async function executeProbeAddon(positionId) {
  const position = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
  if (!position || position.probe_state !== 'confirmed') return;
  const strat = activeStrategy();
  const fullSize = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  const probeSize = Number(position.probe_size_sol || position.size_sol);
  const addonSize = +(fullSize - probeSize).toFixed(6);
  if (addonSize <= 0) return;

  if (position.execution_mode === 'live') {
    // Live addon: execute Jupiter swap
    try {
      const { executeJupiterSwap, fetchLiveTokenBalance } = await import('../liveExecutor.js');
      const { WSOL_MINT } = await import('../config.js');
      const addonLamports = Math.floor(addonSize * 1_000_000_000);
      const swap = await executeJupiterSwap({
        inputMint: WSOL_MINT,
        outputMint: position.mint,
        amount: addonLamports,
      });
      const newTokenAmount = await fetchLiveTokenBalance(position.mint) || null;
      const newTotalSize = +(probeSize + addonSize).toFixed(6);
      db.prepare(`
        UPDATE dry_run_positions
        SET size_sol = ?, addon_size_sol = ?, addon_at_ms = ?, token_amount_raw = COALESCE(?, token_amount_raw)
        WHERE id = ?
      `).run(newTotalSize, addonSize, now(), newTokenAmount, positionId);
      db.prepare(`
        INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
        VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, 'probe_addon_live', ?)
      `).run(positionId, position.mint, now(), position.high_water_price, position.high_water_mcap, addonSize, null, json({ probeSize, addonSize, fullSize, swap: { signature: swap.signature } }));
      console.log(`[probe] live addon #${positionId} +${addonSize} SOL (total ${newTotalSize}) tx=${swap.signature?.slice(0, 8)}`);
    } catch (err) {
      console.log(`[probe] live addon #${positionId} FAILED: ${err.message}`);
      // Still mark as confirmed even if addon fails — position stays at probe size
    }
  } else {
    // Dry-run addon: just update DB
    const newTotalSize = +(probeSize + addonSize).toFixed(6);
    db.prepare(`
      UPDATE dry_run_positions SET size_sol = ?, addon_size_sol = ?, addon_at_ms = ? WHERE id = ?
    `).run(newTotalSize, addonSize, now(), positionId);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, 'probe_addon', ?)
    `).run(positionId, position.mint, now(), position.high_water_price, position.high_water_mcap, addonSize, null, json({ probeSize, addonSize, fullSize }));
    console.log(`[probe] addon #${positionId} +${addonSize} SOL (total ${newTotalSize})`);
  }
}

export function createLivePosition(candidateId, candidate, decision, swap, reason = 'live_buy') {
  const strat = activeStrategy();
  const sizeSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  // Always use strategy config — ignore LLM suggested TP/SL
  const tp = Number(strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return existing.id;

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id,
        execution_mode, entry_signature, token_amount_raw, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'live', ?, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      swap.signature,
      swap.outputAmount || null,
      strat.id,
      json({ candidate, decision, reason, swap, strategy: strat.id }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision, swap }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return positionId;
  })();
}
