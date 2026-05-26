// Pipeline v2: signal → enrichment → metrics gate → TA check → probe entry.
// No watchlist, no LLM. Direct from screening to entry.
//
// Flow:
//   1. Signal arrives (Charon 30s / GMGN trending 60s)
//   2. Dedup + blacklist check
//   3. Enrichment (GMGN token info + Jupiter holders + authority)
//   4. Metrics gate (mcap/age/holders/concentration/authority/wash)
//   5. Fetch candles → compute TA → evaluate Signal A / Signal B
//   6. If signal fires → openProbe()
//   7. If not → skip, try again next cycle

import { now } from '../utils.js';
import { activeStrategy, boolSetting } from '../db/settings.js';
import { upsertCandidate, latestCandidateByMint, updateCandidateStatus } from '../db/candidates.js';
import { isBlacklisted } from '../db/blacklist.js';
import { gateCandidate } from '../screening/metricsGate.js';
import { recordLlmDecision, logDecision } from '../db/decisions.js';
import { evaluateHolderRisk } from '../filters/holderRisk.js';
import { evaluateWashTrade } from '../filters/washTrade.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders } from '../enrichment/jupiter.js';
import { fetchTokenAuthority } from '../enrichment/tokenAuthority.js';
import { fetchTwitterNarrative } from '../enrichment/twitter.js';
import { sendTelegram } from '../telegram/send.js';
import { fetchCandlesAdaptive } from '../chart/jupiterChart.js';
import { pickTimeframe } from '../chart/adaptiveTimeframe.js';
import { ema, stochRsi } from '../chart/indicators.js';
import { evaluateSignalA } from '../entry/signalA.js';
import { evaluateSignalB } from '../entry/signalB.js';
import { openPositionCount, lastPositionForMint } from '../db/positions.js';
import { openProbe } from '../execution/probe.js';
import { mean } from '../utils.js';

// Track recently-evaluated mints to avoid re-evaluating TA every 30s for same token
const recentTaEval = new Map();
const TA_EVAL_COOLDOWN_MS = 120_000; // 2 min between TA evals for same mint

export async function processSignal(envelope) {
  const mint = envelope.mint;
  if (!mint) return;
  if (isBlacklisted(mint)) return;

  // Skip if we recently evaluated TA for this mint (avoid hammering Jupiter chart)
  const lastEval = recentTaEval.get(mint);
  if (lastEval && now() - lastEval < TA_EVAL_COOLDOWN_MS) return;

  // Skip if already have open position on this mint
  const lastPos = lastPositionForMint(mint);
  if (lastPos && ['open', 'probe_open', 'probe_confirmed', 'probe_inconclusive'].includes(lastPos.status)) return;

  // Check max positions
  const strat = activeStrategy();
  const maxPos = Number(strat.max_open_positions ?? 10);
  if (openPositionCount() >= maxPos) return;

  // Build enriched candidate snapshot.
  const candidate = await buildCandidate(envelope);

  // Run defensive filter evaluations.
  candidate.holderRisk = evaluateHolderRisk(candidate);
  candidate.washTrade  = evaluateWashTrade(candidate);

  // Metrics gate.
  const gate = gateCandidate(candidate, strat);
  candidate.filters = {
    passed: gate.passed,
    failures: gate.failures,
    riskFlags: gate.riskFlags,
    checkedAtMs: now(),
  };

  // Persist candidate row.
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

  // ── Direct TA evaluation (no watchlist, no LLM) ─────────────────────────
  recentTaEval.set(mint, now());
  // Prune old entries
  if (recentTaEval.size > 500) {
    for (const [k, v] of recentTaEval) { if (now() - v > TA_EVAL_COOLDOWN_MS * 2) recentTaEval.delete(k); }
  }

  const ageMs = Number(candidate.signals?.ageMs || 0);
  const tf = pickTimeframe(ageMs);
  const { candles } = await fetchCandlesAdaptive(mint, tf, 80);

  if (!candles || candles.length < 25) {
    logDecision({ candidateId, mint, strategyId: strat.id, action: 'ta_skip_insufficient_candles', payload: { candleCount: candles?.length || 0, tf } });
    return;
  }

  const closes = candles.map(c => Number(c.c));
  const vols = candles.map(c => Number(c.v || 0));
  const ema20Arr = ema(closes, 20);
  const sr = stochRsi(closes, 14, 3, 3);
  const lastK = sr?.k?.[closes.length - 1];
  const lastD = sr?.d?.[closes.length - 1];

  // Guard: skip if Stoch RSI data looks invalid
  if (!Number.isFinite(lastK) || (lastK === 0 && lastD === 0)) {
    logDecision({ candidateId, mint, strategyId: strat.id, action: 'ta_skip_invalid_stoch', payload: { lastK, lastD } });
    return;
  }

  // Evaluate Signal A
  let entrySignal = null;
  let evaluation = null;

  if (strat.sigA_enabled !== false) {
    const a = evaluateSignalA({ candles, ema20Arr, sr, strat });
    if (a.entry) {
      entrySignal = 'A';
      evaluation = a;
    }
  }

  // Evaluate Signal B (if A didn't fire)
  if (!entrySignal && strat.sigB_enabled !== false) {
    const last = closes.length - 1;
    // Compute ATH and trough from candles
    let athPrice = 0, athAt = 0, troughPrice = Infinity, troughAt = 0;
    for (const c of candles) {
      if (Number(c.h) > athPrice) { athPrice = Number(c.h); athAt = Number(c.t); }
    }
    for (const c of candles) {
      if (Number(c.t) >= athAt && Number(c.l) > 0 && Number(c.l) < troughPrice) {
        troughPrice = Number(c.l); troughAt = Number(c.t);
      }
    }
    const ath = { price: athPrice, at: athAt };
    const trough = troughPrice < Infinity ? { price: troughPrice, at: troughAt } : { price: null, at: null };

    const b = evaluateSignalB({ candles, vols, ath, trough, strat });
    if (b.entry) {
      entrySignal = 'B';
      evaluation = b;
    }
  }

  if (!entrySignal) {
    updateCandidateStatus(candidateId, 'ta_no_signal');
    logDecision({ candidateId, mint, strategyId: strat.id, action: 'ta_no_signal', payload: { tf, lastK, candles: candles.length } });
    return;
  }

  // ── Entry! Open probe ───────────────────────────────────────────────────
  updateCandidateStatus(candidateId, 'entry_signal');
  logDecision({
    candidateId, mint, strategyId: strat.id,
    action: `entry_signal_${entrySignal}`,
    payload: { tf, signal: entrySignal, metrics: evaluation?.metrics },
  });

  const positionId = await openProbe({
    candidate,
    candidateId,
    watchlistRow: null,
    signal: entrySignal,
    tf,
    evaluation,
    candles,
    strat,
  });

  console.log(`[entry] ${candidate.token?.symbol || mint.slice(0, 8)} signal ${entrySignal} → probe #${positionId} (${tf})`);
}

// ── Candidate builder ────────────────────────────────────────────────────────

async function buildCandidate(envelope) {
  const mint = envelope.mint;
  const [gmgn, asset, holders, authority] = await Promise.all([
    fetchGmgnTokenInfo(mint).catch(() => null),
    fetchJupiterAsset(mint).catch(() => null),
    fetchJupiterHolders(mint).catch(() => null),
    boolSetting('enable_token_authority_guard', true)
      ? fetchTokenAuthority(mint).catch(() => null)
      : Promise.resolve(null),
  ]);

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
    chart: { currentNative: null, rangeHighNative: null, distanceFromAthPercent: null, topBlastRisk: null },
    authority: authority || { checked: false },
    twitterNarrative: null,  // skip twitter fetch for speed
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
