import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID, TELEGRAM_TOPIC_ID } from '../config.js';
import { positionById } from '../db/positions.js';
import { formatPosition, watchlistSummary } from './format.js';
import { listActiveWatchlist } from '../db/watchlist.js';

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

export async function sendWatchlistSummary() {
  const rows = listActiveWatchlist();
  await sendTelegram(watchlistSummary(rows));
}

function escapeOrEmpty(value) {
  if (!value) return '';
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
