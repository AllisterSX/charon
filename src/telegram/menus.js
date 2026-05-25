import { activeStrategy, allStrategies, boolSetting, setting, numSetting } from '../db/settings.js';
import { tradingMode, openPositionCount, allPositions } from '../db/positions.js';
import { activeWatchlistCount } from '../db/watchlist.js';
import { ENABLE_LLM, LLM_API_KEY, LLM_MODEL } from '../config.js';
import { escapeHtml, fmtPct, fmtSol, fmtUsd, fmtMs } from '../format.js';
import { formatPosition } from './format.js';

export function menuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Strategy', callback_data: 'menu:strategy' },
          { text: 'Watchlist', callback_data: 'menu:watchlist' },
          { text: 'Positions', callback_data: 'menu:positions' },
        ],
        [
          { text: 'Agent', callback_data: 'menu:agent' },
          { text: 'PnL', callback_data: 'menu:pnl' },
        ],
      ],
    },
  };
}

export function mainMenuText() {
  const strat = activeStrategy();
  return [
    `🦅 <b>Apex</b>`,
    `Strategy: <b>${escapeHtml(strat.name)}</b> (${escapeHtml(strat.id)})`,
    `Mode: <b>${escapeHtml(tradingMode())}</b>`,
    `Watchlist: <b>${activeWatchlistCount()}/${strat.watchlist_max ?? 25}</b>`,
    `Open positions: <b>${openPositionCount()}/${strat.max_open_positions ?? 10}</b>`,
    `LLM: ${ENABLE_LLM && LLM_API_KEY ? `<b>${escapeHtml(LLM_MODEL)}</b>` : '<b>off</b>'}`,
  ].join('\n');
}

export function agentText() {
  const strat = activeStrategy();
  return [
    '🤖 <b>Apex Agent</b>',
    `Agent: <b>${boolSetting('agent_enabled', true) ? 'on' : 'off'}</b>`,
    `Mode: <b>${escapeHtml(tradingMode())}</b>`,
    `Strategy: <b>${escapeHtml(strat.name)}</b>`,
    `Position size: ${fmtSol(strat.position_size_sol)} SOL · Probe ${strat.probe_size_pct}%`,
    `Exits: SL ${fmtPct(strat.sl_pct)} · Trail ${fmtPct(strat.trailing_pct)} · Stoch>${strat.stoch_overbought} → sell ${strat.partial_tp_sell_pct}%`,
    `Re-entry cooldown: ${fmtMs(strat.reentry_cooldown_ms)}`,
    `LLM: ${strat.use_llm && ENABLE_LLM && LLM_API_KEY ? 'on' : 'off'} · revalidate ${fmtMs(strat.llm_revalidate_interval_ms)}`,
  ].join('\n');
}
export function agentKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Toggle Agent', callback_data: 'toggle:agent' }],
        [
          { text: 'Dry Run', callback_data: 'set:trading_mode:dry_run' },
          { text: 'Confirm', callback_data: 'set:trading_mode:confirm' },
          { text: 'Live', callback_data: 'set:trading_mode:live' },
        ],
        [{ text: 'Back', callback_data: 'menu:main' }],
      ],
    },
  };
}

export function strategyMenuText() {
  const strat = activeStrategy();
  const all = allStrategies();
  return [
    '🎯 <b>Strategy</b>',
    '',
    `Active: <b>${escapeHtml(strat.name)}</b> (${escapeHtml(strat.id)})`,
    `Size: ${fmtSol(strat.position_size_sol)} SOL · Probe ${strat.probe_size_pct}% · MaxPos ${strat.max_open_positions}`,
    `Mcap: ${fmtUsd(strat.min_mcap_usd)} – ${fmtUsd(strat.max_mcap_usd)}`,
    `Token age: 0 – ${fmtMs(strat.token_age_max_ms)}`,
    `Min holders: ${strat.min_holders} · Top10 ≤ ${fmtPct(strat.max_top10_holder_percent)}`,
    `LLM: ${strat.use_llm ? `on, narrative ≥ ${strat.llm_min_narrative_score}` : 'off'}`,
    `Watchlist max: ${strat.watchlist_max} · low-vol ${fmtUsd(strat.watchlist_low_volume_threshold_usd)}`,
    `Trend: up ≥ ${strat.trend_uptrend_min_score} · down ≤ ${strat.trend_reversal_max_score}`,
    `Probe: confirm +${strat.probe_confirm_min_pnl_pct}% / fail ${strat.probe_fail_max_pnl_pct}% / age ${fmtMs(strat.probe_max_age_ms)}`,
    `Exit: SL ${fmtPct(strat.sl_pct)} · Stoch>${strat.stoch_overbought}→${strat.partial_tp_sell_pct}% · Trail ${fmtPct(strat.trailing_pct)}`,
    '',
    ...all.map(s => `${s.enabled ? '▶' : '○'} ${escapeHtml(s.name)} (${escapeHtml(s.id)})`),
  ].join('\n');
}
export function strategyKeyboard() {
  const all = allStrategies();
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '── Switch Active ──', callback_data: 'noop' }],
        ...all.map(s => [{
          text: `${s.enabled ? '▶ ' : ''}${s.name}`,
          callback_data: `strategy:select:${s.id}`,
        }]),
        [{ text: '/stratset · /stratclone · /stratswitch', callback_data: 'noop' }],
        [{ text: 'Back', callback_data: 'menu:main' }],
      ],
    },
  };
}

export function positionsText() {
  const rows = allPositions(12);
  if (!rows.length) return '📍 <b>Positions</b>\n\n(none)';
  return `📍 <b>Positions</b>\n\n${rows.map(formatPosition).join('\n\n')}`;
}

export function navKeyboard(extra = []) {
  return {
    reply_markup: {
      inline_keyboard: [
        ...extra,
        [{ text: 'Back', callback_data: 'menu:main' }],
      ],
    },
  };
}
