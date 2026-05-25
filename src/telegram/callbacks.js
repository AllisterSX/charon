import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID } from '../config.js';
import {
  mainMenuText, menuKeyboard,
  agentText, agentKeyboard,
  strategyMenuText, strategyKeyboard,
  positionsText, navKeyboard,
} from './menus.js';
import { setActiveStrategy, setSetting, boolSetting } from '../db/settings.js';
import { listActiveWatchlist } from '../db/watchlist.js';
import { watchlistSummary } from './format.js';

async function editOrSend(query, text, extra = {}) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  const messageId = query.message?.message_id;
  if (!messageId) {
    return bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  }
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'HTML', disable_web_page_preview: true, ...extra,
    });
  } catch (err) {
    if (/message is not modified/i.test(err.message)) return null;
    return bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  }
}

export function setupCallbacks() {
  bot.on('callback_query', async (query) => {
    const data = String(query.data || '');
    try {
      if (data === 'menu:main')      return editOrSend(query, mainMenuText(), menuKeyboard());
      if (data === 'menu:agent')     return editOrSend(query, agentText(), agentKeyboard());
      if (data === 'menu:strategy')  return editOrSend(query, strategyMenuText(), strategyKeyboard());
      if (data === 'menu:positions') return editOrSend(query, positionsText(), navKeyboard());
      if (data === 'menu:watchlist') return editOrSend(query, watchlistSummary(listActiveWatchlist()), navKeyboard());
      if (data === 'menu:pnl') {
        const { pnlSummaryText } = await import('../learning/summary.js');
        return editOrSend(query, await pnlSummaryText('24h'), navKeyboard());
      }

      if (data === 'toggle:agent') {
        const next = !boolSetting('agent_enabled', true);
        setSetting('agent_enabled', next ? 'true' : 'false');
        return editOrSend(query, agentText(), agentKeyboard());
      }

      if (data.startsWith('set:')) {
        const [, key, value] = data.split(':');
        setSetting(key, value);
        return editOrSend(query, agentText(), agentKeyboard());
      }

      if (data.startsWith('strategy:select:')) {
        const id = data.slice('strategy:select:'.length);
        setActiveStrategy(id);
        return editOrSend(query, strategyMenuText(), strategyKeyboard());
      }

      if (data === 'noop') return;
    } catch (err) {
      console.log(`[telegram] callback ${data} error: ${err.message}`);
    } finally {
      try { await bot.answerCallbackQuery(query.id); } catch {}
    }
  });
}
