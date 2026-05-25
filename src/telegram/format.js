import { escapeHtml, fmtPct, fmtSol, fmtUsd, fmtMs, short, gmgnLink, txLink } from '../format.js';

// ── Watchlist ────────────────────────────────────────────────────────────────

export function watchlistRowSummary(row) {
  const trendEmoji = {
    uptrend: '📈', reversing: '↗️', downtrend: '📉', neutral: '➡️',
  }[row.trend_status] || '❓';

  const lines = [
    `${trendEmoji} <b>${escapeHtml(row.symbol || short(row.mint))}</b>  score <b>${row.narrative_score ?? '?'}</b>  K <b>${row.stoch_k != null ? Number(row.stoch_k).toFixed(0) : '?'}</b>`,
    `<a href="${gmgnLink(row.mint)}">${short(row.mint)}</a>  mcap ${fmtUsd(row.current_mcap_usd)}  vol5m ${fmtUsd(row.vol_5m_usd)}  tf ${escapeHtml(row.candle_tf || '?')}`,
    row.llm_verdict && row.llm_verdict !== 'WATCH'
      ? `LLM: ${escapeHtml(row.llm_verdict)}` : null,
    row.cooldown_until_ms && row.cooldown_until_ms > Date.now()
      ? `⏳ cooldown ${fmtMs(row.cooldown_until_ms - Date.now())}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

export function watchlistSummary(rows) {
  if (!rows.length) return null;   // caller decides whether to send empty
  const uptrend  = rows.filter(r => r.trend_status === 'uptrend').length;
  const reversal = rows.filter(r => r.trend_status === 'reversing').length;
  const neutral  = rows.filter(r => !r.trend_status || r.trend_status === 'neutral').length;
  return [
    `👁 <b>Watchlist</b> (${rows.length})  📈${uptrend} ↗️${reversal} ➡️${neutral}`,
    '',
    ...rows.map(r => watchlistRowSummary(r)),
  ].join('\n');
}

export function watchlistAdmitNotif(row, verdict) {
  return [
    `👁 <b>Watchlist +1</b>  ${escapeHtml(row.symbol || short(row.mint))}`,
    `<a href="${gmgnLink(row.mint)}">${short(row.mint)}</a>`,
    `Narrative score: <b>${verdict?.narrative_score ?? '?'}</b>  Viral: <b>${verdict?.viral_potential ?? '?'}</b>`,
    verdict?.narrative_summary ? `"${escapeHtml(String(verdict.narrative_summary).slice(0, 200))}"` : null,
    verdict?.risks?.length ? `Risks: ${verdict.risks.slice(0, 3).map(escapeHtml).join(', ')}` : null,
  ].filter(Boolean).join('\n');
}

export function watchlistRemoveNotif(mint, symbol, reason) {
  const reasonLabel = {
    trend_reversal: '📉 Trend reversed',
    llm_revalidation_pass: '🔄 Narrative stale (LLM PASS)',
    evicted_for_stronger_candidate: '🔀 Evicted for stronger token',
    manual: '🗑 Manual remove',
    blacklist: '🚫 Blacklisted',
  }[reason] || `🗑 ${escapeHtml(reason || 'removed')}`;
  return `👁 <b>Watchlist -1</b>  ${escapeHtml(symbol || short(mint))}\n${reasonLabel}`;
}

// ── Positions ────────────────────────────────────────────────────────────────

export function formatPosition(position) {
  const pnl = position.pnl_percent != null
    ? Number(position.pnl_percent)
    : position.entry_mcap && position.high_water_mcap
      ? (Number(position.high_water_mcap) / Number(position.entry_mcap) - 1) * 100
      : 0;
  const pnlEmoji = pnl > 0 ? '🟢' : pnl < 0 ? '🔴' : '⚪';
  const probeLabel = {
    open: '🔍 probe open',
    confirmed: '✅ confirmed',
    failed: '❌ failed',
    inconclusive: '⚠️ inconclusive',
  }[position.probe_state] || null;

  return [
    `${pnlEmoji} <b>${escapeHtml(position.symbol || short(position.mint))}</b> #${position.id}`,
    `<a href="${gmgnLink(position.mint)}">${short(position.mint)}</a>  ${escapeHtml(position.execution_mode || 'dry_run')}  ${escapeHtml(position.strategy_id || 'apex_obicle')}`,
    [
      position.entry_signal ? `Signal <b>${escapeHtml(position.entry_signal)}</b>` : null,
      position.entry_tf ? `TF ${escapeHtml(position.entry_tf)}` : null,
      probeLabel,
    ].filter(Boolean).join('  ') || null,
    position.entry_signature ? `Entry TX: <a href="${txLink(position.entry_signature)}">${short(position.entry_signature)}</a>` : null,
    `Entry mcap: ${fmtUsd(position.entry_mcap)}  High: ${fmtUsd(position.high_water_mcap)}`,
    `Size: ${fmtSol(position.size_sol)} SOL  (probe ${fmtSol(position.probe_size_sol)} + addon ${fmtSol(position.addon_size_sol || 0)})  PnL: <b>${fmtPct(pnl)}</b>`,
    `SL ${fmtPct(position.sl_percent)}  Trail ${position.trailing_enabled ? fmtPct(position.trailing_percent) : 'off'}${Number(position.trailing_armed) ? ' 🔒' : ''}${Number(position.partial_tp_done) ? '  partial-TP ✓' : ''}`,
    position.exit_reason
      ? `Exit: <b>${escapeHtml(position.exit_reason)}</b>  ${fmtUsd(position.exit_mcap)}  <b>${fmtPct(position.pnl_percent)}</b>` : null,
    position.exit_signature ? `Exit TX: <a href="${txLink(position.exit_signature)}">${short(position.exit_signature)}</a>` : null,
  ].filter(Boolean).join('\n');
}
