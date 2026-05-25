// Metrics hard gate (FR-2). Pure function: takes a fully-enriched candidate +
// active strategy, returns { passed, failures, riskFlags }.

import { boolSetting, numSetting } from '../db/settings.js';

export function gateCandidate(candidate, strat) {
  const failures = [];
  const riskFlags = [];

  const mcap = Number(candidate.metrics?.marketCapUsd || 0);
  const ageMs = Number(candidate.signals?.ageMs || 0);
  const holderCount = Number(candidate.metrics?.holderCount || 0);
  const top10 = Number(candidate.holders?.top10Percent || 0);
  const maxHolder = Number(candidate.holders?.maxHolderPercent || 0);
  const sourceCount = Number(candidate.signals?.sourceCount || 0);

  // 1) Source count
  if (Number(strat.min_source_count || 0) > 0 && sourceCount < strat.min_source_count) {
    failures.push(`min_source_count: ${sourceCount} < ${strat.min_source_count}`);
  }

  // 2) Fee claim required?
  if (strat.require_fee_claim && !candidate.feeClaim) {
    failures.push('require_fee_claim: missing');
  }

  // 3) Mint authority guard
  if (boolSetting('enable_token_authority_guard', true)) {
    const auth = candidate.authority || {};
    if (auth.checked && auth.mintAuthorityActive
        && (strat.require_mint_authority_revoked ?? boolSetting('reject_active_mint_authority', true))) {
      failures.push('mint_authority: still active');
    }
    if (auth.checked && auth.freezeAuthorityActive) {
      riskFlags.push('freeze_authority_active');
    }
  }

  // 4) Token age window
  if (Number(strat.token_age_min_ms || 0) > 0 && ageMs > 0 && ageMs < strat.token_age_min_ms) {
    failures.push(`token_age_min: ${Math.round(ageMs / 60000)}m < ${Math.round(strat.token_age_min_ms / 60000)}m`);
  }
  if (Number(strat.token_age_max_ms || 0) > 0 && ageMs > 0 && ageMs > strat.token_age_max_ms) {
    failures.push(`token_age_max: ${Math.round(ageMs / 60000)}m > ${Math.round(strat.token_age_max_ms / 60000)}m`);
  }

  // 5) Market cap window
  if (Number(strat.min_mcap_usd || 0) > 0 && (!Number.isFinite(mcap) || mcap < strat.min_mcap_usd)) {
    failures.push(`min_mcap_usd: ${mcap} < ${strat.min_mcap_usd}`);
  }
  if (Number(strat.max_mcap_usd || 0) > 0 && Number.isFinite(mcap) && mcap > strat.max_mcap_usd) {
    failures.push(`max_mcap_usd: ${mcap} > ${strat.max_mcap_usd}`);
  }

  // 6) Holder count
  if (Number(strat.min_holders || 0) > 0 && holderCount < strat.min_holders) {
    failures.push(`min_holders: ${holderCount} < ${strat.min_holders}`);
  }

  // 7) Top10 concentration
  if (Number(strat.max_top10_holder_percent || 0) > 0 && top10 > 0 && top10 > strat.max_top10_holder_percent) {
    failures.push(`max_top10_holder_percent: ${top10.toFixed(1)} > ${strat.max_top10_holder_percent}`);
  }
  if (Number(strat.max_top20_holder_percent || 0) > 0 && maxHolder > 0 && maxHolder > strat.max_top20_holder_percent) {
    failures.push(`max_top_holder_percent: ${maxHolder.toFixed(1)} > ${strat.max_top20_holder_percent}`);
  }

  // 8) Fee/mcap ratio — Obicle 1:10K rule.
  // Uses TOTAL fees (gmgnTotalFeesSol) as primary — this is the total trading fees
  // the token has generated. Falls back to claimed fees (feeClaim.distributedSol)
  // if GMGN data unavailable. Ratio: fee_sol / mcap_usd.
  // Example: 10 SOL fees / $100K mcap = 0.0001 → passes at ratio 0.0001.
  const totalFeesSol = Number(candidate.metrics?.gmgnTotalFeesSol || 0);
  const claimedFeesSol = Number(candidate.feeClaim?.distributedSol || 0);
  const effectiveFeeSol = totalFeesSol > 0 ? totalFeesSol : claimedFeesSol;
  const ratioMin = Number(strat.fee_to_mcap_min_ratio || 0);
  if (ratioMin > 0 && mcap > 0) {
    if (effectiveFeeSol <= 0) {
      // No fee data available — skip check (don't reject tokens without fee info)
    } else {
      const ratio = effectiveFeeSol / mcap;
      if (ratio < ratioMin) {
        failures.push(`fee_to_mcap_ratio: ${effectiveFeeSol.toFixed(2)} SOL / $${mcap.toFixed(0)} = ${ratio.toExponential(2)} < ${ratioMin.toExponential(2)} (need ${(mcap * ratioMin).toFixed(1)} SOL)`);
      }
    }
  }

  // 8b) Absolute minimum fee floor (optional, per-strategy).
  const minFeeSol = Number(strat.min_fee_claim_sol || 0);
  if (minFeeSol > 0 && effectiveFeeSol > 0 && effectiveFeeSol < minFeeSol) {
    failures.push(`min_fee_sol: ${effectiveFeeSol.toFixed(2)} < ${minFeeSol} SOL`);
  }

  // 9) Holder risk score (uses filters/holderRisk evaluation already attached)
  const holderRisk = candidate.holderRisk;
  const rejectScore = (strat.holder_risk_reject_score != null && Number.isFinite(Number(strat.holder_risk_reject_score)))
    ? Number(strat.holder_risk_reject_score)
    : numSetting('holder_risk_reject_score', 0.90);
  if (holderRisk?.checked && holderRisk.riskScore >= rejectScore) {
    failures.push(`holder_risk_score: ${holderRisk.riskScore.toFixed(2)} >= ${rejectScore}`);
  }
  if (holderRisk?.flags?.length) riskFlags.push(...holderRisk.flags.map(f => `holder:${f}`));

  // 10) Wash trade source flag
  const wash = candidate.washTrade;
  if (wash?.checked && wash.flags?.includes('source_flagged_wash_trading')) {
    failures.push('wash_trade: source flagged');
  }
  if (wash?.flags?.length) riskFlags.push(...wash.flags.map(f => `wash:${f}`));

  return {
    passed: failures.length === 0,
    failures,
    riskFlags,
  };
}
