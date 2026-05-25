import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID } from '../config.js';
import {
  mainMenuText, menuKeyboard,
  agentText, agentKeyboard,
  strategyMenuText, strategyKeyboard,
  positionsText, navKeyboard,
} from './menus.js';
import {
  activeStrategy, allStrategies, strategyById,
  setActiveStrategy, updateStrategyConfig, cloneStrategy, deleteStrategy,
  setSetting, numSetting,
} from '../db/settings.js';
import { sendTelegram } from './send.js';
import { setupCallbacks } from './callbacks.js';
import { listActiveWatchlist } from '../db/watchlist.js';
import { listBlacklist, addBlacklist, removeBlacklist } from '../db/blacklist.js';
import { removeFromWatchlist } from '../watchlist/manager.js';
import { watchlistSummary } from './format.js';
import { parseNumericInput } from '../utils.js';
import { escapeHtml } from '../format.js';

function isAuthorized(chatId) {
  return String(chatId) === String(TELEGRAM_CHAT_ID);
}

function reply(msg, text, extra = {}) {
  return bot.sendMessage(msg.chat.id, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}),
    ...extra,
  });
}

export function setupTelegram() {
  setupCallbacks();

  bot.onText(/^\/start\b/, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    reply(msg, mainMenuText(), menuKeyboard());
  });

  bot.onText(/^\/menu\b/, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    reply(msg, mainMenuText(), menuKeyboard());
  });

  bot.onText(/^\/agent\b/, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    reply(msg, agentText(), agentKeyboard());
  });

  bot.onText(/^\/strategy\b/, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    try {
      const text = strategyMenuText();
      const kb = strategyKeyboard();
      reply(msg, text, kb).catch(err => {
        // HTML parse error fallback
        reply(msg, text.replace(/<[^>]+>/g, ''), kb).catch(() => {});
      });
    } catch (err) {
      reply(msg, `⚠️ Strategy error: ${err.message}`);
    }
  });

  bot.onText(/^\/strategies\b/, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    const all = allStrategies();
    const text = all.length
      ? all.map(s => `${s.enabled ? '▶' : '○'} <b>${s.name}</b> (<code>${s.id}</code>)`).join('\n')
      : '(none)';
    reply(msg, `<b>Strategies</b>\n\n${text}`);
  });

  bot.onText(/^\/stratswitch\s+(\S+)/, (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    const id = match[1];
    const ok = setActiveStrategy(id);
    reply(msg, ok ? `Switched active strategy to <b>${id}</b>.` : `Strategy <b>${id}</b> not found.`);
  });

  // /stratset <key> <value>  — mutates a config field on active strategy.
  bot.onText(/^\/stratset\s+(\S+)\s+(.+)/, (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    const key = match[1];
    const rawValue = match[2].trim();
    const strat = activeStrategy();
    const cfg = { ...strat };
    delete cfg.id;
    delete cfg.name;
    let value;
    if (rawValue === 'true' || rawValue === 'false') value = rawValue === 'true';
    else if (rawValue === 'null') value = null;
    else if (/^-?\d+(\.\d+)?$/.test(rawValue)) value = Number(rawValue);
    else value = rawValue;
    cfg[key] = value;
    updateStrategyConfig(strat.id, cfg);
    reply(msg, `Updated <code>${escapeHtml(strat.id)}.${escapeHtml(key)}</code> = <code>${escapeHtml(String(rawValue))}</code>`);
  });

  // /stratclone <newId> [name…]
  bot.onText(/^\/stratclone\s+(\S+)(?:\s+(.+))?/, (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    const newId = match[1];
    const name = match[2]?.trim() || null;
    const strat = activeStrategy();
    const ok = cloneStrategy(strat.id, newId, name);
    if (ok === null) reply(msg, `Source strategy not found.`);
    else if (ok === false) reply(msg, `Strategy <b>${newId}</b> already exists.`);
    else reply(msg, `Cloned <b>${strat.id}</b> → <b>${newId}</b> (disabled).`);
  });

  bot.onText(/^\/stratdelete\s+(\S+)/, (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    const id = match[1];
    const ok = deleteStrategy(id);
    reply(msg, ok ? `Deleted strategy <b>${id}</b>.` : `Cannot delete <b>${id}</b> (active or missing).`);
  });

  bot.onText(/^\/positions\b/, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    reply(msg, positionsText(), navKeyboard());
  });

  bot.onText(/^\/watchlist\b/, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    reply(msg, watchlistSummary(listActiveWatchlist()), navKeyboard());
  });

  bot.onText(/^\/watchlistremove\s+(\S+)/, (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    const mint = match[1];
    const ok = removeFromWatchlist(mint, 'manual');
    reply(msg, ok ? `Removed <code>${mint}</code> from watchlist.` : `Mint <code>${mint}</code> not on watchlist.`);
  });

  bot.onText(/^\/blacklist\s+(\S+)(?:\s+(.+))?/, (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    const mint = match[1];
    const reason = match[2] || 'manual';
    addBlacklist(mint, reason);
    removeFromWatchlist(mint, `blacklist:${reason}`);
    reply(msg, `Blacklisted <code>${mint}</code>.`);
  });

  bot.onText(/^\/blacklistremove\s+(\S+)/, (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    const mint = match[1];
    const ok = removeBlacklist(mint);
    reply(msg, ok ? `Removed <code>${mint}</code> from blacklist.` : `Mint <code>${mint}</code> not blacklisted.`);
  });

  bot.onText(/^\/blacklists?\b$/, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    const rows = listBlacklist(50);
    const text = rows.length ? rows.map(r => `• <code>${r.mint}</code> — ${r.reason || ''}`).join('\n') : '(empty)';
    reply(msg, `<b>Blacklist</b>\n\n${text}`);
  });

  bot.onText(/^\/pnl(?:\s+(\S+))?/, async (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    const window = match[1] || '24h';
    const { pnlSummaryText } = await import('../learning/summary.js');
    reply(msg, await pnlSummaryText(window));
  });

  bot.onText(/^\/mode\s+(dry_run|confirm|live)/, (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    setSetting('trading_mode', match[1]);
    reply(msg, `Trading mode set to <b>${match[1]}</b>.`);
  });

  bot.onText(/^\/help\b/, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    reply(msg, [
      '<b>Apex commands</b>',
      '/menu — main menu',
      '/strategy — show active strategy + switcher',
      '/strategies — list all',
      '/stratswitch &lt;id&gt; — switch active',
      '/stratset &lt;key&gt; &lt;value&gt; — mutate active config',
      '/stratclone &lt;newId&gt; [name…] — copy active strategy',
      '/stratdelete &lt;id&gt; — delete a non-active strategy',
      '/watchlist — show watchlist',
      '/watchlistremove &lt;mint&gt;',
      '/blacklist &lt;mint&gt; [reason] · /blacklistremove &lt;mint&gt; · /blacklists',
      '/positions — list positions',
      '/pnl [window] — PnL report',
      '/mode dry_run|confirm|live',
    ].join('\n'));
  });

  console.log('[telegram] commands wired');
}

// Re-exported for the orchestrator to call after start-up.
export { sendTelegram };
