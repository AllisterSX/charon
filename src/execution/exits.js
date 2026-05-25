// Exit evaluator (FR-8, design §3.10).
// Order-of-checks (first hit wins):
//   1. SL                     → full exit
//   2. trailing armed + drawdown ≥ trailing_pct → full exit
//   3. !partial_tp_done && stoch_k > overbought && pnl > 0 → partial 40%, arm trailing
//   4. trend reversing && pnl > 0 → full exit (capture profit while trend rolls)
//   5. hold

export function evaluateExit({ position, marketSnapshot, ind, strat }) {
  const pnl = pnlPct(position, marketSnapshot);
  const sl  = Number(position.sl_percent ?? strat.sl_pct ?? -25);
  const trailingPct = Number(position.trailing_percent ?? strat.trailing_pct ?? 30);
  const overbought = Number(strat.stoch_overbought ?? 80);
  const partialSell = Number(strat.partial_tp_sell_pct ?? 40);

  // 1) SL
  if (pnl <= sl) {
    return { action: 'sl_exit', sellPct: 100, reason: `pnl ${pnl.toFixed(2)}% <= SL ${sl}%`, pnl };
  }

  // 2) Trailing
  const armed = Number(position.trailing_armed) === 1;
  const peak = Number(position.high_water_mcap || position.high_water_price || 0);
  const cur  = Number(marketSnapshot?.marketCapUsd || marketSnapshot?.priceUsd || 0);
  if (armed && peak > 0 && cur > 0) {
    const drawdownPct = ((cur / peak) - 1) * 100;
    if (drawdownPct <= -trailingPct) {
      return { action: 'trail_exit', sellPct: 100, reason: `trail dd ${drawdownPct.toFixed(2)}% <= -${trailingPct}%`, pnl };
    }
  }

  // 3) Partial TP on Stoch RSI overbought (only once)
  const partialDone = Number(position.partial_tp_done) === 1;
  const k = Number(ind?.stoch_k ?? 0);
  if (!partialDone && Number.isFinite(k) && k > overbought && pnl > 0) {
    return {
      action: 'partial_tp',
      sellPct: partialSell,
      reason: `stoch_k ${k.toFixed(1)} > ${overbought} & pnl ${pnl.toFixed(2)}% > 0`,
      pnl,
    };
  }

  // 4) Trend reversing while in profit — bank the gain
  if (ind?.trend_status === 'reversing' && pnl > 0) {
    return { action: 'trend_exit', sellPct: 100, reason: `trend reversing while in profit (${pnl.toFixed(2)}%)`, pnl };
  }

  return { action: 'hold', sellPct: 0, reason: '', pnl };
}

export function pnlPct(position, marketSnapshot) {
  const entry = Number(position.entry_mcap || position.entry_price || 0);
  const cur   = Number(marketSnapshot?.marketCapUsd || marketSnapshot?.priceUsd || 0);
  if (entry <= 0 || cur <= 0) return 0;
  return (cur / entry - 1) * 100;
}
