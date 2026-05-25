// Pipeline orchestrator: signal envelope → enrichment → metricsGate → LLM → watchlist.
//
// Single function `processSignal(envelope)` is the candidateHandler attached to
// the Charon signal poller. Shape of envelope (from signals/charonServer):
//   { mint, ageMs, sourceCount, sources, name, symbol, priceUsd, marketCapUsd,
//     liquidityUsd, holders, volume5m, volume24h, trending, graduated, feeClaim, raw }

import { now } from '../utils.js';
import { activeStrategy, boolSetting } from '../db/settings.js';
import { upsertCandidate, latestCandidateByMint, updateCandidateStatus } from '../db/candidates.js';
import { isWatchlisted, admitOrEvict } from '../watchlist/manager.js';
import { isBlacklisted } from '../db/blacklist.js';
import { gateCandidate } from '../screening/metricsGate.js';
import { screenNarrative } from '../screening/llmNarrative.js';
import { recordLlmDecision, logDecision } from '../db/decisions.js';
import { evaluateHolderRisk } from '../filters/holderRisk.js';
import { evaluateWashTrade } from '../filters/washTrade.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders } from '../enrichment/jupiter.js';
import { fetchTokenAuthority } from '../enrichment/tokenAuthority.js';
import { fetchTwitterNarrative } from '../enrichment/twitter.js';

export async function processSignal(envelope) {
  const mint = envelope.mint;
  if (!mint) return;
  if (isBlacklisted(mint)) return;
  if (isWatchlisted(mint)) return;     // already on watchlist; ticker handles updates

  // Build enriched candidate snapshot.
  const candidate = await buildCandidate(envelope);

  // Run defensive filter evaluations (attached to candidate).
  candidate.holderRisk = evaluateHolderRisk(candidate);
  candidate.washTrade  = evaluateWashTrade(candidate);

  // Hard gate.
  const strat = activeStrategy();
  const gate = gateCandidate(candidate, strat);
  candidate.filters = {
    passed: gate.passed,
    failures: gate.failures,
    riskFlags: gate.riskFlags,
    checkedAtMs: now(),
  };

  // Persist the candidate row no matter what.
  const candidateId = upsertCandidate(candidate, envelope.feeClaim?.signature || null);

  if (!gate.passed) {
    logDecision({
      candidateId, mint, strategyId: strat.id,
      action: 'metrics_reject',
      reason: gate.failures.slice(0, 3).join('; '),
      payload: { failures: gate.failures, riskFlags: gate.riskFlags },
    });
    return;
  }

  // LLM narrative screen.
  if (!strat.use_llm) {
    // LLM disabled by strategy — admit straight to watchlist with neutral verdict.
    const verdict = {
      verdict: 'WATCH', narrative_score: 50, viral_potential: 0,
      narrative_summary: '', risks: ['llm_disabled_by_strategy'],
      reason: 'LLM disabled by strategy', unverified: true,
    };
    return admit(candidateId, candidate, verdict, strat);
  }

  const verdict = await screenNarrative(candidate, strat);
  recordLlmDecision({ candidateId, mint, kind: 'screen', verdict });

  if (verdict.verdict === 'PASS') {
    updateCandidateStatus(candidateId, 'rejected_llm_pass');
    logDecision({ candidateId, mint, strategyId: strat.id, action: 'llm_pass', reason: verdict.reason, payload: { verdict } });
    return;
  }
  if (verdict.verdict === 'REJECT') {
    updateCandidateStatus(candidateId, 'rejected_llm_reject');
    logDecision({ candidateId, mint, strategyId: strat.id, action: 'llm_reject', reason: verdict.reason, payload: { verdict } });
    const { addBlacklist } = await import('../db/blacklist.js');
    addBlacklist(mint, verdict.reason || 'llm_reject');
    return;
  }
  // WATCH (or unverified)
  if (Number(verdict.narrative_score || 0) < Number(strat.llm_min_narrative_score || 0)
      && !verdict.unverified) {
    updateCandidateStatus(candidateId, 'rejected_low_narrative');
    logDecision({ candidateId, mint, strategyId: strat.id, action: 'narrative_below_min', payload: { score: verdict.narrative_score, min: strat.llm_min_narrative_score } });
    return;
  }
  return admit(candidateId, candidate, verdict, strat);
}

async function admit(candidateId, candidate, verdict, strat) {
  const result = admitOrEvict(candidateId, candidate, verdict);
  if (result.admitted) {
    updateCandidateStatus(candidateId, 'watchlisted');
    logDecision({
      candidateId, mint: candidate.token.mint, strategyId: strat.id,
      action: 'watchlist_admit',
      reason: verdict.reason,
      payload: { evicted: result.evicted, score: verdict.narrative_score },
    });
  } else {
    updateCandidateStatus(candidateId, 'watchlist_full');
    logDecision({
      candidateId, mint: candidate.token.mint, strategyId: strat.id,
      action: 'watchlist_admission_denied',
      reason: result.reason,
      payload: { score: verdict.narrative_score },
    });
  }
}

async function buildCandidate(envelope) {
  const mint = envelope.mint;
  // Parallel fetches.
  const [gmgn, asset, holders, authority] = await Promise.all([
    fetchGmgnTokenInfo(mint).catch(() => null),
    fetchJupiterAsset(mint).catch(() => null),
    fetchJupiterHolders(mint).catch(() => null),
    boolSetting('enable_token_authority_guard', true)
      ? fetchTokenAuthority(mint).catch(() => null)
      : Promise.resolve(null),
  ]);
  const twitterNarrative = await fetchTwitterNarrative(envelope.graduated || envelope, gmgn).catch(() => null);

  const previous = latestCandidateByMint(mint);
  const baseToken = previous?.candidate?.token || {};

  const candidate = {
    createdAtMs: now(),
    token: {
      mint,
      name: gmgn?.name || asset?.name || envelope.name || baseToken.name || null,
      symbol: gmgn?.symbol || asset?.symbol || envelope.symbol || baseToken.symbol || null,
      twitter: gmgn?.link?.twitter_username || asset?.twitter || baseToken.twitter || null,
      website: gmgn?.link?.website || asset?.website || baseToken.website || null,
      telegram: gmgn?.link?.telegram || baseToken.telegram || null,
    },
    signals: {
      route: routeFromEnvelope(envelope),
      sources: envelope.sources || [],
      sourceCount: envelope.sourceCount,
      ageMs: envelope.ageMs,
    },
    metrics: {
      priceUsd: envelope.priceUsd ?? Number(asset?.usdPrice ?? 0),
      marketCapUsd: envelope.marketCapUsd ?? Number(asset?.mcap ?? asset?.fdv ?? 0),
      liquidityUsd: envelope.liquidityUsd ?? Number(asset?.liquidity ?? 0),
      holderCount: envelope.holders ?? Number(asset?.holderCount ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? 0),
      trendingVolumeUsd: envelope.volume5m ?? envelope.volume24h ?? 0,
    },
    feeClaim: envelope.feeClaim ? {
      distributedSol: Number(envelope.feeClaim.distributedSol || 0),
      signature: envelope.feeClaim.signature,
      shareholders: envelope.feeClaim.shareholders || [],
    } : null,
    trending: envelope.trending || null,
    graduation: envelope.graduated || null,
    holders: holders || { count: 0, holders: [], top10: [], top20: [] },
    chart: {
      currentNative: null,
      rangeHighNative: null,
      distanceFromAthPercent: null,
      topBlastRisk: null,
    },
    authority: authority || { checked: false },
    twitterNarrative,
    savedWalletExposure: { holderCount: 0, checked: 0, wallets: [] },
  };
  return candidate;
}

function routeFromEnvelope(envelope) {
  const flags = [];
  if (envelope.feeClaim) flags.push('fee');
  if (envelope.graduated) flags.push('graduated');
  if (envelope.trending) flags.push('trending');
  return flags.join('+') || 'signal';
}
