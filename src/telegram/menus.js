import { activeStrategy, allStrategies, boolSetting, numSetting } from '../db/settings.js';
import { tradingMode, openPositionCount, allPositions } from '../db/positions.js';
import { activeWatchlistCount } from '../db/watchlist.js';
import { ENABLE_LLM, LLM_API_KEY, LLM_MODEL } from '../config.js';
import { escapeHtml, fmtPct, fmtSol, fmtUsd, fmtMs } from '../format.js';
import { formatPosition } from './format.js';

// ── Main menu ────────────────────────────────────────────────────────────────

export function menuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🎯 Strategy', callback_data: 'menu:strategy' },
          { text: '👁 Watchlist', callback_data: 'menu:watchlist' },
          { text: '📍 Positions', callback_data: 'menu:positions' },
        ],
        [
          { text: '🤖 Agent', callback_data: 'menu:agent' },
          { text: '📊 PnL', callback_data: 'menu:pnl' },
        ],
      ],
    },
  };
}

export function mainMenuText() {
  const strat = activeStrategy();
  const wlCount = activeWatchlistCount();
  const posCount = openPositionCount();
  const mode = tradingMode();
  const modeEmoji = { dry_run: '🔵', confirm: '🟡', live: '🟢' }[mode] || '⚪';
  return [
    `🦅 <b>Apex</b>  v3.0.0`,
    ``,
    `${modeEmoji} Mode: <b>${escapeHtml(mode)}</b>`,
    `🎯 Strategy: <b>${escapeHtml(strat.name)}</b>`,
    `👁 Watchlist: <b>${wlCount}/${strat.watchlist_max ?? 25}</b>`,
    `📍 Positions: <b>${posCount}/${strat.max_open_positions ?? 10}</b>`,
    `🤖 LLM: ${ENABLE_LLM && LLM_API_KEY ? `<b>${escapeHtml(LLM_MODEL)}</b>` : '<b>off</b>'}`,
  ].join('\n');
}

// ── Agent ────────────────────────────────────────────────────────────────────

export function agentText() {
  const strat = activeStrategy();
  const mode = tradingMode();
  const modeEmoji = { dry_run: '🔵', confirm: '🟡', live: '🟢' }[mode] || '⚪';
  return [
    `🤖 <b>Apex Agent</b>`,
    ``,
    `Agent: <b>${boolSetting('agent_enabled', true) ? '✅ on' : '⛔ off'}</b>`,
    `${modeEmoji} Mode: <b>${escapeHtml(mode)}</b>`,
    `🎯 Strategy: <b>${escapeHtml(strat.name)}</b>`,
    ``,
    `Position: ${fmtSol(strat.position_size_sol)} SOL  probe ${strat.probe_size_pct}%  max ${strat.max_open_positions} pos`,
    `Probe: confirm +${strat.probe_confirm_min_pnl_pct}% / fail ${strat.probe_fail_max_pnl_pct}% / ${fmtMs(strat.probe_max_age_ms)}`,
    `Exit: SL ${fmtPct(strat.sl_pct)}  trail ${fmtPct(strat.trailing_pct)}  Stoch>${strat.stoch_overbought}→sell ${strat.partial_tp_sell_pct}%`,
    `Re-entry cooldown: ${fmtMs(strat.reentry_cooldown_ms)}`,
    `LLM: ${strat.use_llm && ENABLE_LLM && LLM_API_KEY ? `on  revalidate ${fmtMs(strat.llm_revalidate_interval_ms)}` : 'off'}`,
  ].join('\n');
}

export function agentKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Toggle Agent', callback_data: 'toggle:agent' }],
        [
          { text: '🔵 Dry Run', callback_data: 'set:trading_mode:dry_run' },
          { text: '🟡 Confirm', callback_data: 'set:trading_mode:confirm' },
          { text: '🟢 Live', callback_data: 'set:trading_mode:live' },
        ],
        [{ text: '← Back', callback_data: 'menu:main' }],
      ],
    },
  };
}

// ── Strategy ─────────────────────────────────────────────────────────────────

export function strategyMenuText() {
  const strat = activeStrategy();
  const all = allStrategies();
  return [
    `🎯 <b>Strategy</b>`,
    ``,
    `Active: <b>${escapeHtml(strat.name)}</b>  <code>${escapeHtml(strat.id)}</code>`,
    ``,
    `<b>Sizing</b>`,
    `  Size: ${fmtSol(strat.position_size_sol)} SOL  Probe: ${strat.probe_size_pct}%  Max pos: ${strat.max_open_positions}`,
    ``,
    `<b>Metrics gate</b>`,
    `  Mcap: ${fmtUsd(strat.min_mcap_usd)} – ${fmtUsd(strat.max_mcap_usd)}`,
    `  Age: 0 – ${fmtMs(strat.token_age_max_ms)}`,
    `  Holders ≥ ${strat.min_holders}  Top10 ≤ ${fmtPct(strat.max_top10_holder_percent)}`,
    ``,
    `<b>Watchlist</b>`,
    `  Max: ${strat.watchlist_max}  Low-vol: ${fmtUsd(strat.watchlist_low_volume_threshold_usd)}`,
    `  Trend: up ≥ ${strat.trend_uptrend_min_score}  down ≤ ${strat.trend_reversal_max_score}`,
    ``,
    `<b>Entry signals</b>`,
    `  A (Obicle TA): EMA${strat.sigA_ema_period} touch ${strat.sigA_ema_touch_pct}%  Stoch<${strat.sigA_stoch_oversold}`,
    `  B (Momentum): vol ${strat.sigB_vol_spike_multiplier}×  z≥${strat.sigB_vol_spike_zscore}  ATH dip ${strat.sigB_ath_dip_min_pct}%..${strat.sigB_ath_dip_max_pct}%`,
    ``,
    `<b>Probe</b>`,
    `  Confirm +${strat.probe_confirm_min_pnl_pct}% / fail ${strat.probe_fail_max_pnl_pct}% / ${fmtMs(strat.probe_max_age_ms)}`,
    ``,
    `<b>Exit</b>`,
    `  SL ${fmtPct(strat.sl_pct)}  Stoch>${strat.stoch_overbought}→sell ${strat.partial_tp_sell_pct}%  trail ${fmtPct(strat.trailing_pct)}`,
    ``,
    `<b>LLM</b>: ${strat.use_llm ? `on  min score ${strat.llm_min_narrative_score}  revalidate ${fmtMs(strat.llm_revalidate_interval_ms)}` : 'off'}`,
    ``,
    ...all.map(s => `${s.enabled ? '▶' : '○'} ${escapeHtml(s.name)}  <code>${escapeHtml(s.id)}</code>`),
  ].join('\n');
}

export function strategyKeyboard() {
  const strat = activeStrategy();
  const all = allStrategies();
  return {
    reply_markup: {
      inline_keyboard: [
        // Strategy switcher
        [{ text: '── Switch ──', callback_data: 'noop' }],
        ...all.map(s => [{
          text: `${s.enabled ? '▶ ' : ''}${s.name}`,
          callback_data: `strategy:select:${s.id}`,
        }]),
        // Quick-set most common params
        [{ text: '── Quick set ──', callback_data: 'noop' }],
        [
          { text: `SL ${fmtPct(strat.sl_pct)}`, callback_data: 'stratinput:sl_pct' },
          { text: `Trail ${fmtPct(strat.trailing_pct)}`, callback_data: 'stratinput:trailing_pct' },
          { text: `Size ${fmtSol(strat.position_size_sol)}`, callback_data: 'stratinput:position_size_sol' },
        ],
        [
          { text: `Max pos ${strat.max_open_positions}`, callback_data: 'stratinput:max_open_positions' },
          { text: `Probe ${strat.probe_size_pct}%`, callback_data: 'stratinput:probe_size_pct' },
          { text: `LLM ${strat.use_llm ? 'on' : 'off'}`, callback_data: 'stratcfg:use_llm' },
        ],
        [
          { text: `Max mcap ${fmtUsd(strat.max_mcap_usd)}`, callback_data: 'stratinput:max_mcap_usd' },
          { text: `Min holders ${strat.min_holders}`, callback_data: 'stratinput:min_holders' },
        ],
        [{ text: '← Back', callback_data: 'menu:main' }],
      ],
    },
  };
}

// ── Positions ────────────────────────────────────────────────────────────────

export function positionsText() {
  const rows = allPositions(12);
  if (!rows.length) return '📍 <b>Positions</b>\n\n(none yet)';
  return `📍 <b>Positions</b>\n\n${rows.map(formatPosition).join('\n\n')}`;
}

// ── PnL ──────────────────────────────────────────────────────────────────────

export function pnlKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '24h', callback_data: 'pnl:24h' },
          { text: '7d',  callback_data: 'pnl:7d' },
          { text: '30d', callback_data: 'pnl:30d' },
        ],
        [{ text: '← Back', callback_data: 'menu:main' }],
      ],
    },
  };
}

// ── Shared ───────────────────────────────────────────────────────────────────

export function navKeyboard(extra = []) {
  return {
    reply_markup: {
      inline_keyboard: [
        ...extra,
        [{ text: '← Back', callback_data: 'menu:main' }],
      ],
    },
  };
}
