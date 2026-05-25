import { db } from '../db/connection.js';
import { parseWindowMs, formatWindow } from '../utils.js';
import { fmtSol, fmtPct } from '../format.js';
import { escapeHtml } from '../format.js';

export function pnlWindow(windowMs) {
  const cutoff = Date.now() - Number(windowMs);
  const closed = db.prepare(`
    SELECT * FROM positions
    WHERE status = 'closed' AND closed_at_ms >= ?
    ORDER BY closed_at_ms ASC
  `).all(cutoff);
  const opened = db.prepare(`
    SELECT COUNT(*) as c FROM positions WHERE opened_at_ms >= ?
  `).get(cutoff).c;
  const open = db.prepare(`
    SELECT COUNT(*) as c FROM positions WHERE status IN ('open','probe_open','probe_confirmed','probe_inconclusive')
  `).get().c;

  const wins = closed.filter(p => Number(p.pnl_percent) > 0).length;
  const losses = closed.length - wins;
  const totalPnlSol = closed.reduce((acc, p) => acc + Number(p.pnl_sol || 0), 0);
  const grossWin = closed.filter(p => Number(p.pnl_sol || 0) > 0).reduce((a, p) => a + Number(p.pnl_sol || 0), 0);
  const grossLoss = Math.abs(closed.filter(p => Number(p.pnl_sol || 0) < 0).reduce((a, p) => a + Number(p.pnl_sol || 0), 0));
  const avgPnlPct = closed.length ? closed.reduce((a, p) => a + Number(p.pnl_percent || 0), 0) / closed.length : 0;
  const winRate = closed.length ? (wins / closed.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const best = closed.reduce((b, p) => (!b || Number(p.pnl_percent) > Number(b.pnl_percent) ? p : b), null);
  const worst = closed.reduce((b, p) => (!b || Number(p.pnl_percent) < Number(b.pnl_percent) ? p : b), null);

  const exitReasons = {};
  for (const p of closed) {
    const r = p.exit_reason || 'UNKNOWN';
    exitReasons[r] = (exitReasons[r] || 0) + 1;
  }
  const signalCount = { A: 0, B: 0, '?': 0 };
  for (const p of closed) {
    const k = p.entry_signal || '?';
    signalCount[k] = (signalCount[k] || 0) + 1;
  }

  return {
    windowMs,
    closedCount: closed.length, openedCount: opened, openCount: open,
    wins, losses, winRate,
    totalPnlSol, grossWin, grossLoss, profitFactor,
    avgPnlPct,
    best, worst,
    exitReasons,
    signalCount,
  };
}

export async function pnlSummaryText(windowSpec = '24h') {
  const windowMs = parseWindowMs(windowSpec);
  const s = pnlWindow(windowMs);
  const lines = [
    `📊 <b>PnL — last ${formatWindow(windowMs)}</b>`,
    '',
    `Closed: <b>${s.closedCount}</b> · Opened: <b>${s.openedCount}</b> · Open: <b>${s.openCount}</b>`,
    `Win rate: <b>${fmtPct(s.winRate)}</b> (${s.wins}W / ${s.losses}L)`,
    `Net PnL: <b>${fmtSol(s.totalPnlSol)} SOL</b> · Profit factor: <b>${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'}</b>`,
    `Avg PnL%: <b>${fmtPct(s.avgPnlPct)}</b>`,
    s.best ? `Best: ${fmtPct(s.best.pnl_percent)} (${escapeHtml(s.best.symbol || s.best.mint?.slice(0, 6))})` : null,
    s.worst ? `Worst: ${fmtPct(s.worst.pnl_percent)} (${escapeHtml(s.worst.symbol || s.worst.mint?.slice(0, 6))})` : null,
    '',
    'Exit reasons:',
    ...Object.entries(s.exitReasons).map(([k, v]) => `  • ${escapeHtml(k)}: ${v}`),
    '',
    `Entry signals: A=${s.signalCount.A || 0} · B=${s.signalCount.B || 0} · ?=${s.signalCount['?'] || 0}`,
  ].filter(Boolean);
  return lines.join('\n');
}
