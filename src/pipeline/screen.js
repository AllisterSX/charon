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
import { sendTelegram } from '../telegram/send.js';

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
  // GMGN trending tokens with strict pre-filter bypass LLM (already vetted by
  // holders 500+, fees 5+ SOL, mcap 50K-5M). Additional checks: bundle ≤40%, bot ≤35%.
  const sources = candidate.signals?.sources || [];
  const isGmgnTrending = sources.includes('gmgn_trending');
  const bypassLlm = isGmgnTrending && shouldBypassLlm(candidate, strat);

  if (bypassLlm) {
    const verdict = {
      verdict: 'WATCH', narrative_score: 55, viral_potential: 50,
      narrative_summary: 'GMGN trending bypass (pre-filtered: holders/fees/concentration OK)',
      risks: ['gmgn_trending_bypass'],
      reason: 'Bypassed LLM — GMGN trending with strict pre-filter passed',
    };
    logDecision({ candidateId, mint, strategyId: strat.id, action: 'gmgn_bypass_llm', payload: { verdict } });
    return admit(candidateId, candidate, verdict, strat);
  }

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
    notifyLlmScreen(candidate, verdict, 'PASS').catch(() => {});
    return;
  }
  if (verdict.verdict === 'REJECT') {
    updateCandidateStatus(candidateId, 'rejected_llm_reject');
    logDecision({ candidateId, mint, strategyId: strat.id, action: 'llm_reject', reason: verdict.reason, payload: { verdict } });
    notifyLlmScreen(candidate, verdict, 'REJECT').catch(() => {});
    const { addBlacklist } = await import('../db/blacklist.js');
    addBlacklist(mint, verdict.reason || 'llm_reject');
    return;
  }
  // WATCH (or unverified)
  if (Number(verdict.narrative_score || 0) < Number(strat.llm_min_narrative_score || 0)
      && !verdict.unverified) {
    updateCandidateStatus(candidateId, 'rejected_low_narrative');
    logDecision({ candidateId, mint, strategyId: strat.id, action: 'narrative_below_min', payload: { score: verdict.narrative_score, min: strat.llm_min_narrative_score } });
    notifyLlmScreen(candidate, verdict, 'LOW_SCORE').catch(() => {});
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

// ── Telegram notification for LLM screening decisions ────────────────────────
async function notifyLlmScreen(candidate, verdict, action) {
  const symbol = candidate.token?.symbol || candidate.token?.name || candidate.token?.mint?.slice(0, 8) || '?';
  const mint = candidate.token?.mint || '';
  const short = mint.length > 10 ? `${mint.slice(0, 6)}...${mint.slice(-4)}` : mint;
  const score = verdict.narrative_score ?? '?';
  const viral = verdict.viral_potential ?? '?';
  const reason = verdict.reason ? String(verdict.reason).slice(0, 200) : '';
  const mcap = candidate.metrics?.marketCapUsd;
  const mcapStr = mcap ? (mcap >= 1e6 ? `$${(mcap/1e6).toFixed(1)}M` : mcap >= 1e3 ? `$${(mcap/1e3).toFixed(1)}K` : `$${mcap}`) : '?';
  const source = (candidate.signals?.sources || []).join('+') || candidate.signals?.route || '?';

  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let emoji, label;
  if (action === 'REJECT')    { emoji = '🚫'; label = 'REJECT (blacklisted)'; }
  else if (action === 'PASS') { emoji = '⏭'; label = 'PASS (skipped)'; }
  else                        { emoji = '📉'; label = `LOW SCORE (${score} &lt; min)`; }

  const text = [
    `${emoji} <b>LLM: ${label}</b>`,
    `${esc(symbol)}  ${mcapStr}  via ${esc(source)}`,
    `<a href="https://gmgn.ai/sol/token/${mint}">${short}</a>`,
    `Score: <b>${score}</b>  Viral: <b>${viral}</b>`,
    reason ? `"${esc(reason)}"` : null,
    verdict.risks?.length ? `Risks: ${verdict.risks.slice(0, 4).map(esc).join(', ')}` : null,
  ].filter(Boolean).join('\n');

  await sendTelegram(text).catch(() => {});
}

// ── GMGN trending LLM bypass gate ───────────────────────────────────────────
// Tokens from GMGN trending already passed pre-filter (holders 500+, fees 5+ SOL,
// mcap 50K-5M). Additional strict checks before bypassing LLM:
//   - Top10 holder concentration ≤ 40% (bundle risk)
//   - Bot/bundler rate ≤ 35%
//   - Holder risk score < 0.70 (stricter than normal 0.90)
//   - No wash trade flag
function shouldBypassLlm(candidate, strat) {
  // Check if bypass is enabled in strategy
  if (strat.gmgn_trending_bypass_llm === false) return false;

  const top10 = Number(candidate.holders?.top10Percent || 0);
  const maxHolder = Number(candidate.holders?.maxHolderPercent || 0);
  const holderRisk = candidate.holderRisk;
  const washTrade = candidate.washTrade;

  // Strict concentration check: top10 ≤ 40%
  const maxBundle = Number(strat.gmgn_bypass_max_top10 || 40);
  if (top10 > 0 && top10 > maxBundle) return false;

  // Single holder ≤ 35%
  const maxBot = Number(strat.gmgn_bypass_max_single_holder || 35);
  if (maxHolder > 0 && maxHolder > maxBot) return false;

  // Holder risk score stricter threshold
  if (holderRisk?.checked && holderRisk.riskScore >= 0.70) return false;

  // No wash trade
  if (washTrade?.checked && washTrade.flags?.includes('source_flagged_wash_trading')) return false;

  return true;
}
