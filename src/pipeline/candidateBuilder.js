import { now, firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn, lamToSol } from '../utils.js';
import { activeStrategy } from '../db/settings.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext } from '../enrichment/jupiter.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { fetchTwitterNarrative } from '../enrichment/twitter.js';
import { fetchTokenAuthority } from '../enrichment/tokenAuthority.js';
import { evaluateHolderRisk } from '../filters/holderRisk.js';
import { evaluateWashTrade } from '../filters/washTrade.js';
import { evaluateTaEntry, evaluateStochRsiSignal } from '../filters/technicalAnalysis.js';
import { boolSetting, numSetting } from '../db/settings.js';
import { gmgnLink } from '../format.js';

export function buildFeeSnapshot(fee, signature) {
  return {
    mint: fee.mint,
    signature,
    distributedSol: lamToSol(fee.distributed),
    recipients: fee.shareholders.map(holder => ({
      address: holder.pubkey,
      bps: holder.bps,
      percent: holder.bps / 100,
    })),
  };
}

export function signalLabel(signals = {}) {
  return [
    signals.hasFeeClaim ? 'fees' : null,
    signals.hasGraduated ? 'graduated' : null,
    signals.hasTrending ? 'trending' : null,
  ].filter(Boolean).join(' + ') || signals.route || 'unknown';
}

export function filterCandidate(candidate) {
  const strat = activeStrategy();
  const failures = [];
  const riskFlags = [];
  const mcap = candidate.metrics.marketCapUsd;
  const totalFees = candidate.metrics.gmgnTotalFeesSol;
  const gradVolume = candidate.metrics.graduatedVolumeUsd;
  const maxHolder = candidate.holders.maxHolderPercent;
  const savedCount = candidate.savedWalletExposure.holderCount;
  const feeSol = candidate.feeClaim?.distributedSol;
  const holderCount = Number(candidate.metrics.holderCount || 0);
  const trendingVolume = Number(candidate.trending?.volume ?? 0);
  const trendingSwaps = Number(candidate.trending?.swaps ?? 0);
  const rugRatio = Number(candidate.trending?.rug_ratio ?? 0);
  const bundlerRate = Number(candidate.trending?.bundler_rate ?? 0);

  // ── Phase 2 defensive layer hard rejects ─────────────────────────────────
  // Authority guard (ponyin phase 1)
  const authority = candidate.authority;
  const guardEnabled = boolSetting('enable_token_authority_guard', true);
  if (guardEnabled && authority?.checked) {
    if (authority.mintAuthorityActive && boolSetting('reject_active_mint_authority', true)) {
      failures.push('mint authority: active (rejected by guard)');
    }
    if (authority.freezeAuthorityActive) {
      riskFlags.push('freeze_authority_active');
    }
  }

  // Holder risk score penalty / hard reject
  const holderRisk = candidate.holderRisk;
  // Allow per-strategy override of holder_risk_reject_score (e.g. degen_micro uses 0.90)
  const holderRiskRejectScore = (strat.holder_risk_reject_score != null && Number.isFinite(Number(strat.holder_risk_reject_score)))
    ? Number(strat.holder_risk_reject_score)
    : numSetting('holder_risk_reject_score', 0.75);
  if (holderRisk?.checked && holderRisk.riskScore >= holderRiskRejectScore) {
    failures.push(`holder risk score: ${holderRisk.riskScore.toFixed(2)} ≥ reject threshold ${holderRiskRejectScore}`);
  }
  if (holderRisk?.flags?.length) riskFlags.push(...holderRisk.flags.map(f => `holder:${f}`));

  // Wash trade flag
  const washTrade = candidate.washTrade;
  if (washTrade?.checked && washTrade.flags?.includes('source_flagged_wash_trading')) {
    failures.push('wash trade: flagged by source');
  }
  if (washTrade?.flags?.length) riskFlags.push(...washTrade.flags.map(f => `wash:${f}`));

  // Network congestion guard (sniper-class strategy only)
  const congestion = candidate.networkCongestion;
  const guardCongestion = boolSetting('enable_network_congestion_guard', true);
  if (guardCongestion && congestion?.checked && congestion.action === 'skip_fresh_launch') {
    if (strat.id === 'graduation_pump' || strat.id === 'sniper') {
      failures.push(`network congestion: ${congestion.level} fees, skipping fresh-launch class`);
    } else {
      riskFlags.push(`congestion:${congestion.level}`);
    }
  }

  // ── Existing v1 filters ──────────────────────────────────────────────────
  // Fee claim check
  if (candidate.feeClaim) {
    const minFee = strat.min_fee_claim_sol ?? 0.5;
    if (minFee > 0 && feeSol < minFee) {
      failures.push(`fee claim: ${feeSol} SOL < min ${minFee} SOL`);
    }
  } else if (strat.require_fee_claim) {
    failures.push('fee claim: missing (required by strategy)');
  }

  // Market cap checks
  if (strat.min_mcap_usd > 0 && (!Number.isFinite(mcap) || mcap < strat.min_mcap_usd)) {
    failures.push(`market cap min: ${mcap} < ${strat.min_mcap_usd}`);
  }
  if (strat.max_mcap_usd > 0 && Number.isFinite(mcap) && mcap > strat.max_mcap_usd) {
    failures.push(`market cap max: ${mcap} > ${strat.max_mcap_usd}`);
  }

  // ── Phase 3 strategy-specific filters (obicle/graduation_pump/migration_play) ──
  // Token age (lower bound — anti-snipe / wait-for-cooldown)
  const ageMs = Number(candidate.signals?.ageMs ?? candidate.signals?.tokenAgeMs ?? 0);
  if (strat.token_age_min_ms > 0 && ageMs > 0 && ageMs < strat.token_age_min_ms) {
    failures.push(`token age min: ${Math.round(ageMs/60000)}m < ${Math.round(strat.token_age_min_ms/60000)}m`);
  }

  // Token age (upper bound — already supported via token_age_max_ms in v1)
  if (strat.token_age_max_ms > 0 && ageMs > 0 && ageMs > strat.token_age_max_ms) {
    failures.push(`token age max: ${Math.round(ageMs/60000)}m > ${Math.round(strat.token_age_max_ms/60000)}m`);
  }

  // Fee:mcap health ratio (Obicle's 1:10K rule, ponyin phase 3 vol-fee)
  if (strat.fee_to_mcap_min_ratio > 0 && Number.isFinite(mcap) && mcap > 0) {
    const feeUsdEst = Number(totalFees || 0) * Number(candidate.metrics?.solUsdEstimate ?? 0);
    // We don't have a hard SOL/USD yet here; use feeSol / mcap as a coarse proxy.
    // Obicle's rule: 15 SOL fee per 150K MC = 0.0001 SOL-fee per USD-mcap.
    const ratio = Number(totalFees || 0) / Number(mcap);
    if (Number.isFinite(ratio) && ratio < strat.fee_to_mcap_min_ratio) {
      failures.push(`fee/mcap ratio: ${ratio.toFixed(6)} < ${strat.fee_to_mcap_min_ratio}`);
    }
  }

  // Top-10 holder concentration (Mobula green flag)
  const holderRiskMetrics = candidate.holderRisk?.metrics || {};
  const top10Pct = Number(holderRiskMetrics.top10Percent ?? 0);
  if (strat.max_top10_holder_percent > 0 && top10Pct > strat.max_top10_holder_percent) {
    failures.push(`top10 holders: ${top10Pct.toFixed(1)}% > ${strat.max_top10_holder_percent}%`);
  }

  // Dev holder cap (uses graduated.devHoldingsPercent if available)
  const devPct = Number(candidate.graduation?.devHoldingsPercent ?? candidate.graduation?.devHoldingsPct ?? 0);
  if (strat.max_dev_holder_percent > 0 && devPct > strat.max_dev_holder_percent) {
    failures.push(`dev holders: ${devPct.toFixed(1)}% > ${strat.max_dev_holder_percent}%`);
  }

  // Bundled supply cap (heuristic via cluster + tagged bundlers)
  const bundledPct = Math.max(
    Number(holderRiskMetrics.taggedBundlerPercent ?? 0),
    Number(candidate.trending?.bundler_rate ?? 0) * 100,
  );
  if (strat.max_bundled_pct > 0 && bundledPct > strat.max_bundled_pct) {
    failures.push(`bundled supply: ${bundledPct.toFixed(1)}% > ${strat.max_bundled_pct}%`);
  }

  // ATH age guard (migration_play — avoid catching falling knife)
  if (strat.min_age_after_ath_ms > 0) {
    const athTs = Number(candidate.chart?.athTimestamp ?? 0);
    if (athTs > 0) {
      const ageAfterAth = now() - athTs;
      if (ageAfterAth < strat.min_age_after_ath_ms) {
        failures.push(`age after ATH: ${Math.round(ageAfterAth/60000)}m < ${Math.round(strat.min_age_after_ath_ms/60000)}m`);
      }
    }
  }

  // TA entry confirmation (ta_confirmed mode — Obicle entry pattern)
  // Two-stage: pending_execution_refresh = pre-LLM (skip), checked = post-refresh (enforce).
  if (strat.entry_mode === 'ta_confirmed' && candidate.taEntry && candidate.taEntry.reason !== 'pending_execution_refresh') {
    if (candidate.taEntry.checked && !candidate.taEntry.entrySignal) {
      failures.push(`ta entry: ${candidate.taEntry.metCount}/5 conditions met (need ≥3)`);
    } else if (!candidate.taEntry.checked) {
      failures.push(`ta entry: ${candidate.taEntry.reason || 'compute failed'}`);
    }
  }

  // Stoch RSI entry gate (stoch_rsi mode — degen_micro)
  // Entry only when Stoch RSI K < oversold (default 20) AND turning up.
  // Evaluated at build time so micro-cap windows are not missed.
  if (strat.entry_mode === 'stoch_rsi' && candidate.taEntry) {
    if (candidate.taEntry.checked && !candidate.taEntry.entrySignal) {
      failures.push(`stoch rsi entry: K=${candidate.taEntry.k?.toFixed(1)} not oversold+turning-up (need K<${strat.stoch_rsi_oversold ?? 20} AND turning up)`);
    } else if (!candidate.taEntry.checked) {
      // Data unavailable — skip gate rather than hard-reject (micro-cap tokens may not have enough candles yet)
      console.log(`[ta] stoch rsi gate skipped for ${candidate.token.mint.slice(0, 8)}: ${candidate.taEntry.reason}`);
    }
  }

  // GMGN fees — only enforce when GMGN data is available; Jupiter has no equivalent
  if (strat.min_gmgn_total_fee_sol > 0 && candidate.gmgn !== null && totalFees < strat.min_gmgn_total_fee_sol) {
    failures.push(`GMGN total fees: ${totalFees} < ${strat.min_gmgn_total_fee_sol}`);
  }

  // Graduated volume — only enforce when the token actually has graduated data
  if (strat.min_graduated_volume_usd > 0 && candidate.graduation && gradVolume < strat.min_graduated_volume_usd) {
    failures.push(`graduated volume: ${gradVolume} < ${strat.min_graduated_volume_usd}`);
  }

  // Holder count
  if (strat.min_holders > 0 && holderCount < strat.min_holders) {
    failures.push(`holders: ${holderCount} < ${strat.min_holders}`);
  }

  // Top holder concentration
  if (strat.max_top20_holder_percent < 100 && Number.isFinite(maxHolder) && maxHolder > strat.max_top20_holder_percent) {
    failures.push(`max top holder: ${maxHolder}% > ${strat.max_top20_holder_percent}%`);
  }

  // Saved wallet holders
  if (strat.min_saved_wallet_holders > 0 && savedCount < strat.min_saved_wallet_holders) {
    failures.push(`saved wallet holders: ${savedCount} < ${strat.min_saved_wallet_holders}`);
  }

  // ATH distance (dip buy strategy)
  if (strat.max_ath_distance_pct < 0) {
    const athDist = candidate.chart?.distanceFromAthPercent;
    if (athDist != null && athDist > strat.max_ath_distance_pct) {
      failures.push(`ATH distance: ${athDist.toFixed(0)}% > target ${strat.max_ath_distance_pct}%`);
    }
  }

  // Trending filters
  if (candidate.trending) {
    if (strat.trending_min_volume_usd > 0 && trendingVolume < strat.trending_min_volume_usd) {
      failures.push(`trending volume: ${trendingVolume} < ${strat.trending_min_volume_usd}`);
    }
    if (strat.trending_min_swaps > 0 && trendingSwaps > 0 && trendingSwaps < strat.trending_min_swaps) {
      failures.push(`trending swaps: ${trendingSwaps} < ${strat.trending_min_swaps}`);
    }
    if (strat.trending_max_rug_ratio > 0 && Number.isFinite(rugRatio) && rugRatio > strat.trending_max_rug_ratio) {
      failures.push(`trending rug ratio: ${rugRatio} > ${strat.trending_max_rug_ratio}`);
    }
    if (strat.trending_max_bundler_rate > 0 && Number.isFinite(bundlerRate) && bundlerRate > strat.trending_max_bundler_rate) {
      failures.push(`trending bundler rate: ${bundlerRate} > ${strat.trending_max_bundler_rate}`);
    }
    if (candidate.trending.is_wash_trading === true || candidate.trending.is_wash_trading === 1) {
      failures.push('trending wash trading');
    }
  }

  return { passed: failures.length === 0, failures, riskFlags, strategy: strat.id };
}

export async function buildCandidate({ mint, fee = null, signature = null, graduatedCoin = null, trendingToken = null, route, networkCongestion = null, ageMs = null }) {
  const strat = activeStrategy();
  const gmgn = await fetchGmgnTokenInfo(mint);
  const jupiterAsset = await fetchJupiterAsset(mint);
  const holders = await fetchJupiterHolders(mint);
  const chart = await fetchJupiterChartContext(mint);
  const savedWalletExposure = await fetchSavedWalletExposure(mint, holders);
  const twitterNarrative = await fetchTwitterNarrative(graduatedCoin || jupiterAsset, gmgn);
  const authority = boolSetting('enable_token_authority_guard', true)
    ? await fetchTokenAuthority(mint).catch(() => ({ checked: false, error: 'fetch failed' }))
    : { checked: false, error: 'guard disabled' };
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), jupiterAsset?.usdPrice, trendingToken?.price);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    jupiterAsset?.mcap,
    jupiterAsset?.fdv,
    trendingToken?.market_cap,
    graduatedCoin?.marketCap,
    graduatedCoin?.usd_market_cap,
  );
  const signalRoute = route || [
    fee ? 'fee' : null,
    graduatedCoin ? 'graduated' : null,
    trendingToken ? 'trending' : null,
  ].filter(Boolean).join('_');

  const candidate = {
    token: {
      mint,
      name: gmgn?.name || jupiterAsset?.name || trendingToken?.name || graduatedCoin?.name || '',
      symbol: gmgn?.symbol || jupiterAsset?.symbol || trendingToken?.symbol || graduatedCoin?.ticker || '',
      gmgnUrl: gmgn?.link?.gmgn || gmgnLink(mint),
      twitter: graduatedCoin?.twitter || jupiterAsset?.twitter || gmgn?.link?.twitter_username || trendingToken?.twitter || '',
      website: graduatedCoin?.website || jupiterAsset?.website || gmgn?.link?.website || '',
      telegram: graduatedCoin?.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? jupiterAsset?.liquidity ?? trendingToken?.liquidity ?? 0),
      holderCount: Number(gmgn?.holder_count ?? jupiterAsset?.holderCount ?? trendingToken?.holder_count ?? graduatedCoin?.numHolders ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? jupiterAsset?.fees ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? 0),
      graduatedVolumeUsd: Number(graduatedCoin?.volume ?? 0),
      graduatedMarketCapUsd: Number(graduatedCoin?.marketCap ?? 0),
      trendingVolumeUsd: Number(trendingToken?.volume ?? 0),
      trendingSwaps: Number(trendingToken?.swaps ?? 0),
      trendingHotLevel: Number(trendingToken?.hot_level ?? 0),
      trendingSmartDegenCount: Number(trendingToken?.smart_degen_count ?? 0),
    },
    signals: {
      route: signalRoute,
      label: signalLabel({
        hasFeeClaim: Boolean(fee),
        hasGraduated: Boolean(graduatedCoin),
        hasTrending: Boolean(trendingToken),
      }),
      hasFeeClaim: Boolean(fee),
      hasGraduated: Boolean(graduatedCoin),
      hasTrending: Boolean(trendingToken),
      triggerSignature: signature,
      strategy: strat.id,
      ageMs: ageMs != null ? Number(ageMs) : null,
    },
    graduation: graduatedCoin,
    trending: trendingToken,
    feeClaim: fee ? buildFeeSnapshot(fee, signature) : null,
    gmgn,
    jupiterAsset,
    holders,
    chart,
    savedWalletExposure,
    twitterNarrative,
    authority,
    networkCongestion,
    createdAtMs: now(),
  };
  // Phase 2 risk evaluations (require holders + trending populated above).
  candidate.holderRisk = evaluateHolderRisk(candidate);
  candidate.washTrade = evaluateWashTrade(candidate);
  // Phase 5: TA entry confirmation for `ta_confirmed` strategy. Skip on first
  // build for performance; only refresh-stage runs full TA. But we still seed
  // a "not-yet-checked" marker so filterCandidate can distinguish absent vs failed.
  if (strat.entry_mode === 'ta_confirmed') {
    candidate.taEntry = { checked: false, reason: 'pending_execution_refresh' };
  }
  // Phase 5b: Stoch RSI entry gate for `stoch_rsi` mode (degen_micro).
  // Evaluated immediately at build time — micro-cap windows are short.
  if (strat.entry_mode === 'stoch_rsi') {
    const stochOversold = strat.stoch_rsi_oversold ?? 20;
    candidate.taEntry = await evaluateStochRsiSignal(candidate.token.mint, {
      interval: '5_MINUTE',
      oversold: stochOversold,
      overbought: strat.stoch_rsi_overbought ?? 80,
    }).catch(err => ({ checked: false, reason: err.message }));
  }
  candidate.filters = filterCandidate(candidate);
  return candidate;
}
