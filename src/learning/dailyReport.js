import { boolSetting } from '../db/settings.js';
import { sendTelegram } from '../telegram/send.js';
import { pnlSummaryText } from './summary.js';
import { db } from '../db/connection.js';
import { activeWatchlistCount } from '../db/watchlist.js';

// Schedule daily report at given local hour/minute (WIB = UTC+7).
export function startDailyReportScheduler({ hourWib = 7, minute = 0 } = {}) {
  if (!boolSetting('enable_daily_report', true)) return;
  const tick = async () => {
    const now = new Date();
    const wibOffsetMs = 7 * 60 * 60 * 1000;
    const wibNow = new Date(now.getTime() + wibOffsetMs);
    if (wibNow.getUTCHours() === hourWib && wibNow.getUTCMinutes() === minute) {
      try { await sendDailyReport(); } catch (err) { console.log(`[daily] ${err.message}`); }
    }
  };
  // Check once a minute.
  setInterval(tick, 60_000);
}

export async function sendDailyReport() {
  const summary = await pnlSummaryText('24h');
  const watchlistAdded = db.prepare(`
    SELECT COUNT(*) as c FROM watchlist_events WHERE kind = 'added' AND at_ms >= ?
  `).get(Date.now() - 24 * 3600 * 1000).c;
  const watchlistRemoved = db.prepare(`
    SELECT COUNT(*) as c FROM watchlist_events WHERE kind = 'removed' AND at_ms >= ?
  `).get(Date.now() - 24 * 3600 * 1000).c;
  const llmCounts = db.prepare(`
    SELECT verdict, COUNT(*) as c FROM llm_decisions
    WHERE created_at_ms >= ? GROUP BY verdict
  `).all(Date.now() - 24 * 3600 * 1000);
  const llmLine = llmCounts.length
    ? llmCounts.map(r => `${r.verdict}=${r.c}`).join(' · ')
    : '(none)';

  const probeRows = db.prepare(`
    SELECT probe_state, COUNT(*) as c FROM positions
    WHERE opened_at_ms >= ? AND probe_state IS NOT NULL
    GROUP BY probe_state
  `).all(Date.now() - 24 * 3600 * 1000);
  const probeLine = probeRows.length
    ? probeRows.map(r => `${r.probe_state}=${r.c}`).join(' · ')
    : '(none)';

  const text = [
    summary,
    '',
    '📋 <b>Activity</b>',
    `Watchlist now: <b>${activeWatchlistCount()}</b>`,
    `Watchlist 24h: added ${watchlistAdded} · removed ${watchlistRemoved}`,
    `LLM 24h: ${llmLine}`,
    `Probe 24h: ${probeLine}`,
  ].join('\n');
  await sendTelegram(text);
}
