import { escapeHtml, fmtPct, fmtSol, fmtUsd, fmtMs, short, gmgnLink, txLink } from '../format.js';

export function watchlistRowSummary(row) {
  const lines = [
    `<b>${escapeHtml(row.symbol || short(row.mint))}</b> · score ${row.narrative_score ?? '?'} · trend ${escapeHtml(row.trend_status || '?')}`,
    `<a href="${gmgnLink(row.mint)}">${short(row.mint)}</a>`,
    [
      `mcap ${fmtUsd(row.current_mcap_usd)}`,
      `vol5m ${fmtUsd(row.vol_5m_usd)}`,
      `K ${row.stoch_k != null ? Number(row.stoch_k).toFixed(0) : '?'}`,
      `tf ${escapeHtml(row.candle_tf || '?')}`,
    ].join(' · '),
    row.cooldown_until_ms && row.cooldown_until_ms > Date.now()
      ? `cooldown ${fmtMs(row.cooldown_until_ms - Date.now())}`
      : null,
  ].filter(Boolean);
  return lines.join('\n');
}

export function watchlistSummary(rows) {
  if (!rows.length) return '👁 <b>Watchlist</b>\n\n(empty)';
  return [
    `👁 <b>Watchlist</b> (${rows.length})`,
    '',
    ...rows.map(r => `• ${watchlistRowSummary(r)}`),
  ].join('\n');
}

export function formatPosition(position) {
  const pnl = position.pnl_percent != null
    ? Number(position.pnl_percent)
    : position.entry_mcap && position.high_water_mcap
      ? (Number(position.high_water_mcap) / Number(position.entry_mcap) - 1) * 100
      : 0;
  return [
    `📍 <b>${escapeHtml(position.symbol || short(position.mint))}</b> #${position.id}`,
    `Token: <a href="${gmgnLink(position.mint)}">${short(position.mint)}</a>`,
    `Status: <b>${escapeHtml(position.status)}</b> · Mode: <b>${escapeHtml(position.execution_mode || 'dry_run')}</b> · Strategy: <b>${escapeHtml(position.strategy_id || 'apex_obicle')}</b>`,
    position.entry_signal ? `Entry signal: <b>${escapeHtml(position.entry_signal)}</b> · TF: ${escapeHtml(position.entry_tf || '?')}` : null,
    position.probe_state ? `Probe: <b>${escapeHtml(position.probe_state)}</b>` : null,
    position.entry_signature ? `Entry TX: <a href="${txLink(position.entry_signature)}">${short(position.entry_signature)}</a>` : null,
    `Entry mcap: ${fmtUsd(position.entry_mcap)} · High: ${fmtUsd(position.high_water_mcap)}`,
    `Size: ${fmtSol(position.size_sol)} SOL (probe ${fmtSol(position.probe_size_sol)} + addon ${fmtSol(position.addon_size_sol || 0)}) · PnL: ${fmtPct(pnl)}`,
    `SL: ${fmtPct(position.sl_percent)} · Trail: ${position.trailing_enabled ? `${fmtPct(position.trailing_percent)}` : 'off'}${Number(position.trailing_armed) ? ' (armed)' : ''}${Number(position.partial_tp_done) ? ' · partial-TP done' : ''}`,
    position.exit_reason ? `Exit: <b>${escapeHtml(position.exit_reason)}</b> at ${fmtUsd(position.exit_mcap)} (${fmtPct(position.pnl_percent)})` : null,
    position.exit_signature ? `Exit TX: <a href="${txLink(position.exit_signature)}">${short(position.exit_signature)}</a>` : null,
  ].filter(Boolean).join('\n');
}
