import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID, TELEGRAM_TOPIC_ID } from '../config.js';
import { positionById } from '../db/positions.js';
import { formatPosition, watchlistSummary, watchlistAdmitNotif, watchlistRemoveNotif } from './format.js';
import { listActiveWatchlist, activeWatchlistCount } from '../db/watchlist.js';

export async function sendTelegram(text, extra = {}) {
  return bot.sendMessage(TELEGRAM_CHAT_ID, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    ...extra,
  });
}

export async function sendPositionOpen(positionId) {
  const position = positionById(positionId);
  if (!position) return;
  const label = position.execution_mode === 'live' ? 'Live probe filled' : 'Dry-run probe stored';
  await sendTelegram(`✅ <b>${label}</b>\n\n${formatPosition(position)}`);
}

export async function sendPositionExit(position) {
  const label = position.execution_mode === 'live' ? 'Live exit' : 'Dry-run exit';
  await sendTelegram(`🏁 <b>${label}: ${escapeOrEmpty(position.exit_reason || position.exitReason)}</b>\n\n${formatPosition({ ...position, status: 'closed' })}`);
}

export async function sendPositionEvent(positionId, headline) {
  const position = positionById(positionId);
  if (!position) return;
  await sendTelegram(`${headline}\n\n${formatPosition(position)}`);
}

// Called immediately when a token is admitted to the watchlist.
export async function sendWatchlistAdmit(row, verdict) {
  await sendTelegram(watchlistAdmitNotif(row, verdict)).catch(() => {});
}

// Called when a token is removed from the watchlist.
export async function sendWatchlistRemove(mint, symbol, reason) {
  await sendTelegram(watchlistRemoveNotif(mint, symbol, reason)).catch(() => {});
}

// Periodic status push — only sends if watchlist is non-empty.
export async function sendWatchlistSummary() {
  if (activeWatchlistCount() === 0) return;   // skip if nothing to show
  const rows = listActiveWatchlist();
  const text = watchlistSummary(rows);
  if (!text) return;
  await sendTelegram(text);
}

function escapeOrEmpty(value) {
  if (!value) return '';
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
