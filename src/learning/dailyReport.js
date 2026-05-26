// Daily Telegram report (ponyin add-on)
// Schedules summary at configured cron. Default: 07:00 Asia/Jakarta.
// Uses charon's existing summarizeLearningWindow() + active lessons.

import { TELEGRAM_CHAT_ID } from '../config.js';
import { sendTelegram } from '../telegram/send.js';
import { summarizeLearningWindow } from './summary.js';
import { db } from '../db/connection.js';
import { fmtPct, fmtSol, escapeHtml } from '../format.js';
import { numSetting, setting, boolSetting, activeStrategy } from '../db/settings.js';
import { openPositionCount } from '../db/positions.js';

function activeLessonsTop(limit = 3) {
  return db.prepare(`
    SELECT lesson FROM learning_lessons
    WHERE status = 'active' ORDER BY id DESC LIMIT ?
  `).all(limit).map(r => r.lesson);
}

export function buildDailyReport(windowMs) {
  const summary = summarizeLearningWindow(windowMs);
  const strat = activeStrategy();
  const lessons = activeLessonsTop(3);
  const bestRoute = summary.positions.byRoute?.[0];

  const lines = [
    '📊 <b>Charon-v2 Daily Report</b>',
    '',
    `Strategy: <b>${escapeHtml(strat.id)}</b> · Mode: <b>${escapeHtml(setting('trading_mode', 'dry_run'))}</b>`,
    `Window: last ${Math.round(windowMs / 3600000)}h`,
    '',
    '<b>Performance</b>',
    `• Closed: ${summary.positions.closed}/${summary.positions.opened}`,
    `• Win rate: ${fmtPct(summary.positions.winRate)}`,
    `• Avg PnL: ${fmtPct(summary.positions.avgPnlPercent)}`,
    `• Total: ${fmtSol(summary.positions.totalPnlSol)} SOL`,
    `• Open now: ${openPositionCount()}/${strat.max_open_positions || numSetting('max_open_positions', 3)}`,
  ];

  if (bestRoute && bestRoute.count > 0) {
    lines.push('', `Best route: <b>${escapeHtml(bestRoute.route)}</b> avg ${fmtPct(bestRoute.avgPnlPercent)} (${bestRoute.count} trades)`);
  }

  if (lessons.length) {
    lines.push('', '<b>Top lessons</b>');
    lessons.forEach((l, i) => lines.push(`${i + 1}. ${escapeHtml(l).slice(0, 200)}`));
  }

  return lines.join('\n');
}

// Simple cron-like scheduler — runs every minute, fires when local TZ wall clock matches.
// Format: "HH:MM" 24h. Default 07:00 WIB (Asia/Jakarta = UTC+7).
function nowInJakarta() {
  const d = new Date();
  // Manually offset to UTC+7 (no DST in Indonesia).
  const jakartaUtcMs = d.getTime() + (7 * 60 + d.getTimezoneOffset()) * 60_000;
  const j = new Date(jakartaUtcMs);
  return { hh: j.getUTCHours(), mm: j.getUTCMinutes() };
}

export function startDailyReportScheduler({ hourWib = 7, minute = 0, windowMs = 24 * 3600 * 1000 } = {}) {
  if (!boolSetting('enable_daily_report', true)) {
    console.log('[daily] disabled via settings');
    return null;
  }
  if (!TELEGRAM_CHAT_ID) {
    console.log('[daily] TELEGRAM_CHAT_ID missing, skipping');
    return null;
  }

  let lastFiredKey = null;
  const tick = async () => {
    const { hh, mm } = nowInJakarta();
    if (hh !== hourWib || mm !== minute) return;
    const key = `${new Date().toISOString().slice(0, 10)}-${hourWib}${minute}`;
    if (lastFiredKey === key) return;
    lastFiredKey = key;
    try {
      const text = buildDailyReport(windowMs);
      await sendTelegram(text);
      console.log(`[daily] report sent (${key})`);
    } catch (err) {
      console.log(`[daily] failed: ${err.message}`);
    }
  };

  // Check every minute
  const handle = setInterval(tick, 60_000);
  console.log(`[daily] scheduler armed for ${String(hourWib).padStart(2,'0')}:${String(minute).padStart(2,'0')} WIB`);
  return handle;
}
