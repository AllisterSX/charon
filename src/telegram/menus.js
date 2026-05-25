import { activeStrategy, allStrategies, boolSetting, numSetting } from '../db/settings.js';
import { tradingMode, openPositionCount, allPositions } from '../db/positions.js';
import { activeWatchlistCount } from '../db/watchlist.js';
import { ENABLE_LLM, LLM_API_KEY, LLM_MODEL } from '../config.js';
import { escapeHtml, fmtPct, fmtSol, fmtUsd, fmtMs } from '../format.js';
import { formatPosition } from './format.js';

// Safe helpers — never crash on undefined strategy fields
function sf(v, fallback = '?') { return v != null ? v : fallback; }
function sfPct(v) { const n = Number(v); return Number.isFinite(n) ? fmtPct(n) : '?'; }
function sfSol(v) { const n = Number(v); return Number.isFinite(n) ? fmtSol(n) : '?'; }
function sfUsd(v) { const n = Number(v); return Number.isFinite(n) ? fmtUsd(n) : '?'; }
function sfMs(v)  { const n = Number(v); return Number.isFinite(n) && n > 0 ? fmtMs(n) : '?'; }

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
    `🎯 Strategy: <b>${escapeHtml(strat.name || strat.id)}</b>`,
    `👁 Watchlist: <b>${wlCount}/${sf(strat.watchlist_max, 25)}</b>`,
    `📍 Positions: <b>${posCount}/${sf(strat.max_open_positions, 10)}</b>`,
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
    `🎯 Strategy: <b>${escapeHtml(strat.name || strat.id)}</b>`,
    ``,
    `Position: ${sfSol(strat.position_size_sol)} SOL  probe ${sf(strat.probe_size_pct, '?')}%  max ${sf(strat.max_open_positions, '?')} pos`,
    `Probe: confirm +${sf(strat.probe_confirm_min_pnl_pct, '?')}% / fail ${sf(strat.probe_fail_max_pnl_pct, '?')}% / ${sfMs(strat.probe_max_age_ms)}`,
    `Exit: SL ${sfPct(strat.sl_pct)}  trail ${sfPct(strat.trailing_pct)}  Stoch>${sf(strat.stoch_overbought, '?')}→sell ${sf(strat.partial_tp_sell_pct, '?')}%`,
    `Re-entry cooldown: ${sfMs(strat.reentry_cooldown_ms)}`,
    `LLM: ${strat.use_llm && ENABLE_LLM && LLM_API_KEY ? `on  revalidate ${sfMs(strat.llm_revalidate_interval_ms)}` : 'off'}`,
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

  // Detect whether this is an apex_obicle-style strategy or a legacy charon strategy
  const isApex = strat.probe_size_pct != null;

  const lines = [
    `🎯 <b>Strategy</b>`,
    ``,
    `Active: <b>${escapeHtml(strat.name || strat.id)}</b>  <code>${escapeHtml(strat.id)}</code>`,
    ``,
  ];

  if (isApex) {
    lines.push(
      `<b>Sizing</b>`,
      `  Size: ${sfSol(strat.position_size_sol)} SOL  Probe: ${sf(strat.probe_size_pct, '?')}%  Max pos: ${sf(strat.max_open_positions, '?')}`,
      ``,
      `<b>Metrics gate</b>`,
      `  Mcap: ${sfUsd(strat.min_mcap_usd)} – ${sfUsd(strat.max_mcap_usd)}`,
      `  Age: 0 – ${sfMs(strat.token_age_max_ms)}`,
      `  Holders ≥ ${sf(strat.min_holders, '?')}  Top10 ≤ ${sfPct(strat.max_top10_holder_percent)}`,
      ``,
      `<b>Watchlist</b>`,
      `  Max: ${sf(strat.watchlist_max, '?')}  Low-vol: ${sfUsd(strat.watchlist_low_volume_threshold_usd)}`,
      `  Trend: up ≥ ${sf(strat.trend_uptrend_min_score, '?')}  down ≤ ${sf(strat.trend_reversal_max_score, '?')}`,
      ``,
      `<b>Entry signals</b>`,
      `  A (Obicle TA): ${sf(strat.sigA_enabled, true) ? '✅' : '⛔'}  EMA${sf(strat.sigA_ema_period, 20)} touch ${sf(strat.sigA_ema_touch_pct, '?')}%  Stoch<${sf(strat.sigA_stoch_oversold, '?')}`,
      `  B (Momentum): ${sf(strat.sigB_enabled, true) ? '✅' : '⛔'}  vol ${sf(strat.sigB_vol_spike_multiplier, '?')}×  z≥${sf(strat.sigB_vol_spike_zscore, '?')}  ATH dip ${sf(strat.sigB_ath_dip_min_pct, '?')}%..${sf(strat.sigB_ath_dip_max_pct, '?')}%`,
      ``,
      `<b>Probe</b>`,
      `  Confirm +${sf(strat.probe_confirm_min_pnl_pct, '?')}% / fail ${sf(strat.probe_fail_max_pnl_pct, '?')}% / ${sfMs(strat.probe_max_age_ms)}`,
      ``,
      `<b>Exit</b>`,
      `  SL ${sfPct(strat.sl_pct)}  Stoch>${sf(strat.stoch_overbought, '?')}→sell ${sf(strat.partial_tp_sell_pct, '?')}%  trail ${sfPct(strat.trailing_pct)}`,
      ``,
      `<b>LLM</b>: ${strat.use_llm ? `on  min score ${sf(strat.llm_min_narrative_score, '?')}  revalidate ${sfMs(strat.llm_revalidate_interval_ms)}` : 'off'}`,
    );
  } else {
    // Legacy charon strategy — show what we have
    lines.push(
      `⚠️ <i>Legacy strategy (charon-v2 format). Switch to apex_obicle for full Apex features.</i>`,
      ``,
      `Size: ${sfSol(strat.position_size_sol)} SOL  Max pos: ${sf(strat.max_open_positions, '?')}`,
      `Mcap: ${sfUsd(strat.min_mcap_usd)} – ${sfUsd(strat.max_mcap_usd)}`,
      `TP: ${sfPct(strat.tp_percent)}  SL: ${sfPct(strat.sl_percent)}  Trail: ${sfPct(strat.trailing_percent)}`,
      `LLM: ${strat.use_llm ? 'on' : 'off'}`,
    );
  }

  lines.push(``, ...all.map(s => `${s.enabled ? '▶' : '○'} ${escapeHtml(s.name)}  <code>${escapeHtml(s.id)}</code>`));
  return lines.join('\n');
}

export function strategyKeyboard() {
  const strat = activeStrategy();
  const all = allStrategies();
  const isApex = strat.probe_size_pct != null;

  const quickSet = isApex ? [
    [
      { text: `SL ${sfPct(strat.sl_pct)}`, callback_data: 'stratinput:sl_pct' },
      { text: `Trail ${sfPct(strat.trailing_pct)}`, callback_data: 'stratinput:trailing_pct' },
      { text: `Size ${sfSol(strat.position_size_sol)}`, callback_data: 'stratinput:position_size_sol' },
    ],
    [
      { text: `Max pos ${sf(strat.max_open_positions, '?')}`, callback_data: 'stratinput:max_open_positions' },
      { text: `Probe ${sf(strat.probe_size_pct, '?')}%`, callback_data: 'stratinput:probe_size_pct' },
      { text: `LLM ${strat.use_llm ? 'on' : 'off'}`, callback_data: 'stratcfg:use_llm' },
    ],
    [
      { text: `Max mcap ${sfUsd(strat.max_mcap_usd)}`, callback_data: 'stratinput:max_mcap_usd' },
      { text: `Min holders ${sf(strat.min_holders, '?')}`, callback_data: 'stratinput:min_holders' },
    ],
  ] : [
    [{ text: '⚠️ Switch to apex_obicle for full features', callback_data: 'strategy:select:apex_obicle' }],
  ];

  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '── Switch ──', callback_data: 'noop' }],
        ...all.map(s => [{
          text: `${s.enabled ? '▶ ' : ''}${s.name}`,
          callback_data: `strategy:select:${s.id}`,
        }]),
        [{ text: '── Quick set ──', callback_data: 'noop' }],
        ...quickSet,
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
