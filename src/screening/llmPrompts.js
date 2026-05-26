// LLM prompt templates (Apex). Adapted from charon-main/src/pipeline/llm.js
// `compactCandidateForLlm` + `decideCandidateBatch`, with a new schema:
//   { verdict: WATCH|PASS|REJECT, narrative_score, viral_potential, narrative_summary, risks, reason }

import { db } from '../db/connection.js';
import { clamp } from '../utils.js';

export const SYSTEM_PROMPT = [
  'You are Apex, a Solana memecoin narrative analyst.',
  'Return strict JSON only — no prose, no code fences, no commentary.',
  '',
  'You evaluate ONE freshly-graduated Solana memecoin at a time and judge whether its',
  'NARRATIVE merits adding to the watchlist for technical-entry monitoring.',
  '',
  'Use these dimensions:',
  '1. Twitter narrative quality — coherence of story, account quality (followers, account age),',
  '   engagement (likes, RTs, replies, views).',
  '2. Viral potential — does the meme/story have a hook that crypto twitter will amplify',
  '   (cultural moment, AI/political/celeb tie-in, community angle)?',
  '3. Sanity check — flags missed by metrics: copy-cat narrative, suspicious coordinated',
  '   launches, sniper / bundler concentration patterns.',
  '',
  'IMPORTANT CALIBRATION RULES:',
  '- Missing Twitter data (no_twitter_data) is NOT a reason to REJECT or PASS.',
  '  Most tokens under 6 hours old have no Twitter yet. Treat it as neutral.',
  '- Holder concentration below 50% top-10 is NORMAL for early-stage memecoins.',
  '  Only flag concentration as a risk if top-10 > 50% OR single holder > 25%.',
  '- possible_bundle_cluster alone is NOT enough for REJECT. Many legitimate tokens',
  '  trigger this flag due to LP pools and early buyers.',
  '- REJECT is ONLY for: confirmed scams, copy-paste tokens with zero originality,',
  '  tokens impersonating real projects, or tokens with >60% holder concentration.',
  '- When in doubt between PASS and WATCH, choose WATCH. Let the TA engine decide entry.',
  '',
  'Verdict semantics:',
  '- WATCH = narrative has any potential. Default for anything not obviously bad.',
  '- PASS = narrative is truly uninteresting AND has no cultural hook whatsoever.',
  '- REJECT = ONLY for confirmed scams, impersonation, or extreme concentration (>60%).',
  '',
  'Score scales: narrative_score and viral_potential are 0-100, your conviction (NOT',
  'probability). Calibrate so an average graduated meme scores ~50 and a clearly',
  'breakout-worthy story scores 75+. Be generous — false negatives cost more than',
  'false positives (TA engine handles exit risk).',
  '',
  'Chart data is ATH/range context. Do not penalize a token only because 24h change is',
  'huge — that is normal for new graduations.',
].join('\n');

export const OUTPUT_SCHEMA = {
  verdict: 'WATCH|PASS|REJECT',
  narrative_score: 'integer 0-100',
  viral_potential: 'integer 0-100',
  narrative_summary: 'short string (<=200 chars)',
  risks: ['array of short risk tags'],
  reason: 'one-sentence rationale',
};

export function activeLessons(limit = 6) {
  try {
    return db.prepare(`
      SELECT lesson FROM learning_lessons WHERE status = 'active'
      ORDER BY id DESC LIMIT ?
    `).all(Number(limit)).map(row => row.lesson);
  } catch {
    return [];
  }
}

export function compactCandidateForLlm(candidate) {
  return {
    mint: candidate.token?.mint,
    token: {
      symbol: candidate.token?.symbol,
      name: candidate.token?.name,
      twitter: candidate.token?.twitter,
      website: candidate.token?.website,
      telegram: candidate.token?.telegram,
    },
    signals: {
      route: candidate.signals?.route,
      sources: candidate.signals?.sources,
      sourceCount: candidate.signals?.sourceCount,
      ageMs: candidate.signals?.ageMs,
    },
    metrics: {
      marketCapUsd: candidate.metrics?.marketCapUsd,
      priceUsd: candidate.metrics?.priceUsd,
      liquidityUsd: candidate.metrics?.liquidityUsd,
      holderCount: candidate.metrics?.holderCount,
      gmgnTotalFeesSol: candidate.metrics?.gmgnTotalFeesSol,
    },
    trending: candidate.trending ? {
      volume: candidate.trending.volume,
      swaps: candidate.trending.swaps,
      smart_degen_count: candidate.trending.smart_degen_count,
      organicScore: candidate.trending.organicScore,
    } : null,
    holders: {
      top10Percent: candidate.holders?.top10Percent,
      top20Percent: candidate.holders?.top20Percent,
      maxHolderPercent: candidate.holders?.maxHolderPercent,
    },
    chart: candidate.chart ? {
      currentNative: candidate.chart.currentNative,
      rangeHighNative: candidate.chart.rangeHighNative,
      distanceFromAthPercent: candidate.chart.distanceFromAthPercent,
      topBlastRisk: candidate.chart.topBlastRisk,
    } : null,
    twitterNarrative: candidate.twitterNarrative ? {
      tweetText: candidate.twitterNarrative.text,
      authorScreenName: candidate.twitterNarrative.metrics?.authorScreenName,
      authorFollowers: candidate.twitterNarrative.metrics?.authorFollowers,
      authorVerified: candidate.twitterNarrative.metrics?.authorVerified,
      engagement: candidate.twitterNarrative.metrics ? {
        likes: candidate.twitterNarrative.metrics.likes,
        retweets: candidate.twitterNarrative.metrics.retweets,
        replies: candidate.twitterNarrative.metrics.replies,
        quotes: candidate.twitterNarrative.metrics.quotes,
        views: candidate.twitterNarrative.metrics.views,
      } : null,
    } : null,
    filters: {
      passed: candidate.filters?.passed,
      riskFlags: candidate.filters?.riskFlags,
    },
  };
}

export function buildUserPayload(candidate, { task, recentLessons = [] } = {}) {
  return {
    task: task || 'Decide WATCH / PASS / REJECT for one candidate.',
    recent_lessons: recentLessons,
    output_schema: OUTPUT_SCHEMA,
    candidate: compactCandidateForLlm(candidate),
  };
}

// Normalize parsed JSON to a stable verdict object used by the rest of the system.
export function normalizeVerdict(parsed, fallbackReason = '') {
  const verdictRaw = String(parsed?.verdict || '').toUpperCase();
  const verdict = ['WATCH', 'PASS', 'REJECT'].includes(verdictRaw) ? verdictRaw : 'WATCH';
  return {
    verdict,
    narrative_score: clamp(parseInt(parsed?.narrative_score, 10), 0, 100),
    viral_potential: clamp(parseInt(parsed?.viral_potential, 10), 0, 100),
    narrative_summary: String(parsed?.narrative_summary || '').slice(0, 500),
    risks: Array.isArray(parsed?.risks) ? parsed.risks.map(String).slice(0, 8) : [],
    reason: String(parsed?.reason || fallbackReason).slice(0, 1000),
    raw: parsed || {},
  };
}
