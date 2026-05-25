import axios from 'axios';
import { SIGNAL_SERVER_URL, SIGNAL_SERVER_KEY } from '../config.js';
import { now, pruneSeen, json } from '../utils.js';
import { db } from '../db/connection.js';

// Apex uses ONLY the Charon signal feed for discovery. No other sources.
// Each signal envelope is dedup'd within a 10-minute window then forwarded to
// the screening pipeline.

let candidateHandler = null;
const seenSignals = new Map();

export function setCandidateHandler(fn) { candidateHandler = fn; }

function recordSignalEvent(mint, source, payload) {
  db.prepare(`
    INSERT INTO signal_events (mint, kind, at_ms, source, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(mint, sourceKind(source), now(), source, json(payload));
}
function sourceKind(source) {
  if (/trending/i.test(source)) return 'trending';
  if (/fee/i.test(source))      return 'fee_claim';
  if (/grad/i.test(source))     return 'graduated';
  return 'signal';
}

export async function fetchSignals() {
  if (!candidateHandler) return;
  try {
    const url = new URL('/api/signals', SIGNAL_SERVER_URL);
    url.searchParams.set('limit', '100');
    url.searchParams.set('minSources', '2');
    const res = await axios.get(url.toString(), {
      timeout: 10_000,
      headers: SIGNAL_SERVER_KEY ? { 'x-api-key': SIGNAL_SERVER_KEY } : {},
    });
    const signals = res.data?.signals || [];
    pruneSeen(seenSignals, 10 * 60_000);

    let processed = 0;
    let triggered = 0;
    for (const signal of signals) {
      const mint = signal.mint;
      if (!mint) continue;
      const key = `signal:${mint}`;
      if (seenSignals.has(key)) { processed++; continue; }
      seenSignals.set(key, now());

      for (const source of signal.sources || []) {
        recordSignalEvent(mint, source, signal);
      }

      try {
        await candidateHandler({
          mint,
          ageMs: Number(signal.ageMs || 0),
          sourceCount: Number(signal.sourceCount || (signal.sources || []).length || 1),
          sources: signal.sources || [],
          name: signal.name,
          symbol: signal.symbol,
          priceUsd: Number(signal.priceUsd || 0),
          marketCapUsd: Number(signal.marketCapUsd || 0),
          liquidityUsd: Number(signal.liquidityUsd || 0),
          holders: Number(signal.holders || 0),
          volume5m: Number(signal.volume5m || 0),
          volume24h: Number(signal.volume24h || 0),
          trending: signal.trending || null,
          graduated: signal.graduated || null,
          feeClaim: signal.feeClaim || null,
          raw: signal,
        });
        triggered++;
      } catch (err) {
        console.log(`[signals] handler error for ${mint.slice(0, 8)}... : ${err.message}`);
      }
      processed++;
    }
    console.log(`[signals] processed ${processed}, forwarded ${triggered}`);
  } catch (err) {
    console.log(`[signals] ${err.message}`);
  }
}
