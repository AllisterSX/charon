import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID } from '../config.js';
import {
  mainMenuText, menuKeyboard,
  agentText, agentKeyboard,
  strategyMenuText, strategyKeyboard,
  positionsText, navKeyboard, pnlKeyboard,
} from './menus.js';
import { setActiveStrategy, setSetting, boolSetting, activeStrategy, updateStrategyConfig } from '../db/settings.js';
import { listActiveWatchlist } from '../db/watchlist.js';
import { watchlistSummary } from './format.js';

async function editOrSend(query, text, extra = {}) {
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  const messageId = query.message?.message_id;
  // Truncate text if too long for Telegram (4096 char limit)
  const safeText = text && text.length > 4000 ? text.slice(0, 4000) + '\n\n<i>(truncated)</i>' : text;
  if (!messageId) {
    return bot.sendMessage(chatId, safeText, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  }
  try {
    return await bot.editMessageText(safeText, {
      chat_id: chatId, message_id: messageId,
      parse_mode: 'HTML', disable_web_page_preview: true, ...extra,
    });
  } catch (err) {
    if (/message is not modified/i.test(err.message)) return null;
    // If edit fails (e.g. can't edit other user's message), send new message instead
    try {
      return await bot.sendMessage(chatId, safeText, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
    } catch (sendErr) {
      console.log(`[telegram] send fallback failed: ${sendErr.message}`);
      // Last resort: send without HTML parse mode
      return bot.sendMessage(chatId, text?.replace(/<[^>]+>/g, '') || 'Error rendering message.').catch(() => null);
    }
  }
}

export function setupCallbacks() {
  bot.on('callback_query', async (query) => {
    const data = String(query.data || '');
    try {
      // ── Menu navigation ──────────────────────────────────────────────────
      if (data === 'menu:main')      return editOrSend(query, mainMenuText(), menuKeyboard());
      if (data === 'menu:agent')     return editOrSend(query, agentText(), agentKeyboard());
      if (data === 'menu:strategy') {
        try {
          return editOrSend(query, strategyMenuText(), strategyKeyboard());
        } catch (err) {
          return editOrSend(query, `⚠️ Strategy menu error: ${err.message}`, navKeyboard());
        }
      }
      if (data === 'menu:positions') return editOrSend(query, positionsText(), navKeyboard());
      if (data === 'menu:watchlist') {
        const rows = listActiveWatchlist();
        const text = watchlistSummary(rows) || '👁 <b>Watchlist</b>\n\n(empty)';
        return editOrSend(query, text, navKeyboard());
      }
      if (data === 'menu:pnl') {
        const { pnlSummaryText } = await import('../learning/summary.js');
        return editOrSend(query, await pnlSummaryText('24h'), pnlKeyboard());
      }

      // ── PnL window selector ──────────────────────────────────────────────
      if (data.startsWith('pnl:')) {
        const window = data.slice(4);
        const { pnlSummaryText } = await import('../learning/summary.js');
        return editOrSend(query, await pnlSummaryText(window), pnlKeyboard());
      }

      // ── Agent toggles ────────────────────────────────────────────────────
      if (data === 'toggle:agent') {
        const next = !boolSetting('agent_enabled', true);
        setSetting('agent_enabled', next ? 'true' : 'false');
        return editOrSend(query, agentText(), agentKeyboard());
      }
      if (data.startsWith('set:')) {
        const parts = data.split(':');
        const key = parts[1];
        const value = parts.slice(2).join(':');
        setSetting(key, value);
        return editOrSend(query, agentText(), agentKeyboard());
      }

      // ── Strategy switcher ────────────────────────────────────────────────
      if (data.startsWith('strategy:select:')) {
        const id = data.slice('strategy:select:'.length);
        setActiveStrategy(id);
        return editOrSend(query, strategyMenuText(), strategyKeyboard());
      }

      // ── Strategy config toggles (boolean fields) ─────────────────────────
      if (data.startsWith('stratcfg:')) {
        const key = data.slice('stratcfg:'.length);
        const strat = activeStrategy();
        const cfg = { ...strat };
        delete cfg.id; delete cfg.name;
        cfg[key] = !cfg[key];
        updateStrategyConfig(strat.id, cfg);
        return editOrSend(query, strategyMenuText(), strategyKeyboard());
      }

      // ── Strategy numeric input prompt ─────────────────────────────────────
      // We can't do inline text input in Telegram bots without a conversation
      // state machine. Instead, show a hint message telling user to use /stratset.
      if (data.startsWith('stratinput:')) {
        const key = data.slice('stratinput:'.length);
        const strat = activeStrategy();
        const current = strat[key] ?? '?';
        const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
        await bot.sendMessage(chatId,
          `To update <code>${key}</code> (current: <code>${current}</code>), send:\n\n<code>/stratset ${key} &lt;value&gt;</code>`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      if (data === 'noop') return;
    } catch (err) {
      console.log(`[telegram] callback ${data} error: ${err.message}`);
    } finally {
      try { await bot.answerCallbackQuery(query.id); } catch {}
    }
  });
}
