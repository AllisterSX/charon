import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { strictJsonFromText } from '../utils.js';
import {
  SYSTEM_PROMPT,
  buildUserPayload,
  normalizeVerdict,
  activeLessons,
} from './llmPrompts.js';

// LLM-driven narrative screen for FRESH candidates.
// Returns a NarrativeVerdict regardless of error — fallback verdict is WATCH with
// `unverified: true` so caller knows to flag for manual review.
export async function screenNarrative(candidate, _strat) {
  if (!ENABLE_LLM || !LLM_API_KEY) {
    return {
      verdict: 'WATCH',
      narrative_score: 0,
      viral_potential: 0,
      narrative_summary: '',
      risks: ['llm_disabled'],
      reason: 'LLM disabled or key missing — admitting to watchlist for manual review.',
      unverified: true,
      raw: null,
    };
  }
  return callLlm(candidate, {
    task: 'Decide WATCH / PASS / REJECT for one candidate (initial narrative screen).',
  });
}

// Periodic re-rating of an already-watchlisted token. Verdict semantics same as
// initial screen: PASS → evict; REJECT → blacklist; WATCH → keep.
export async function revalidateNarrative(candidate, _strat) {
  if (!ENABLE_LLM || !LLM_API_KEY) {
    return {
      verdict: 'WATCH',
      narrative_score: 0,
      viral_potential: 0,
      narrative_summary: '',
      risks: ['llm_disabled'],
      reason: 'LLM disabled — keeping previous verdict.',
      unverified: true,
      raw: null,
    };
  }
  return callLlm(candidate, {
    task: 'Re-rate this watchlisted candidate. WATCH=keep, PASS=evict, REJECT=blacklist.',
  });
}

async function callLlm(candidate, { task }) {
  const user = buildUserPayload(candidate, { task, recentLessons: activeLessons() });
  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(user) },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });
    const content = res.data?.choices?.[0]?.message?.content || '';
    const parsed = strictJsonFromText(content);
    return normalizeVerdict(parsed);
  } catch (err) {
    console.log(`[llm] narrative call failed: ${err.message}`);
    return {
      verdict: 'WATCH',
      narrative_score: 0,
      viral_potential: 0,
      narrative_summary: '',
      risks: ['llm_error'],
      reason: `LLM error: ${err.message}`,
      unverified: true,
      raw: { error: err.message },
    };
  }
}
