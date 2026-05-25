// GMGN Trending signal source — polls top tokens by volume every 60s.
// Filters: mcap $50K-$5M, age 1h-7d, holders ≥500, total fees ≥5 SOL.
// Tokens that pass are forwarded to the same pipeline as Charon signals.

import { gmgnFetch, gmgnBackoffActive, setGmgnBackoff } from '../enrichment/gmgn.js';
import { GMGN_ENABLED } from '../config.js';
import { now, pruneSeen } from '../utils.js';
import { db } from '../db/connection.js';
import { activeStrategy } from '../db/settings.js';

let candidateHandler = null;
const seenTrending = new Map();

export function setTrendingHandler(fn) { candidateHandler = fn; }

// Configurable via strategy config (hot-reloadable via /stratset)
function getConfig() {
  const strat = activeStrategy();
  return {
    enabled: strat.gmgn_trending_enabled !== false,
    timeframe: strat.gmgn_trending_timeframe || '5m',
    limit: Number(strat.gmgn_trending_limit || 50),
    orderby: strat.gmgn_trending_orderby || 'volume',
    // Pre-filters (applied before forwarding to pipeline)
    minMcap: Number(strat.gmgn_trending_min_mcap || 50000),
    maxMcap: Number(strat.gmgn_trending_max_mcap || 5000000),
    minAgeMs: Number(strat.gmgn_trending_min_age_ms || 3600000),       // 1h
    maxAgeMs: Number(strat.gmgn_trending_max_age_ms || 604800000),     // 7d
    minHolders: Number(strat.gmgn_trending_min_holders || 500),
    minTotalFeesSol: Number(strat.gmgn_trending_min_fees_sol || 5),
  };
}

function recordSignalEvent(mint, payload) {
  try {
    db.prepare(`
      INSERT INTO signal_events (mint, kind, at_ms, source, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(mint, 'trending', now(), 'gmgn_trending', JSON.stringify(payload));
  } catch {}
}

export async function fetchGmgnTrending() {
  if (!GMGN_ENABLED || !candidateHandler) return;
  const cfg = getConfig();
  if (!cfg.enabled) return;
  if (gmgnBackoffActive('trending')) return;

  try {
    // GMGN trending endpoint: GET /v1/market/rank
    // Params: chain=sol, interval=5m, limit=50, order_by=volume, direction=desc
    const payload = await gmgnFetch('/v1/market/rank', {
      params: {
        chain: 'sol',
        interval: cfg.timeframe,
        limit: cfg.limit,
        order_by: cfg.orderby,
        direction: 'desc',
      },
    });

    const rows = payload?.data?.rank
      || payload?.data?.data?.rank
      || payload?.data?.data
      || payload?.data
      || [];
    if (!Array.isArray(rows)) {
      console.log(`[gmgn-trending] unexpected response shape`);
      return;
    }

    pruneSeen(seenTrending, 10 * 60_000);

    let processed = 0;
    let forwarded = 0;

    for (const row of rows) {
      const mint = row.address || row.mint || row.token_address;
      if (!mint) continue;

      // Dedup within 10 min window
      const key = `gmgn:${mint}`;
      if (seenTrending.has(key)) { processed++; continue; }

      // Pre-filter before forwarding (saves enrichment API calls)
      const mcap = Number(row.market_cap ?? row.mcap ?? 0);
      const holders = Number(row.holder_count ?? row.holders ?? 0);
      const totalFees = Number(row.total_fee ?? row.fees ?? 0);
      const createdAt = Number(row.creation_timestamp ?? row.created_at ?? 0) * 1000;
      const ageMs = createdAt > 0 ? now() - createdAt : 0;

      if (mcap > 0 && (mcap < cfg.minMcap || mcap > cfg.maxMcap)) { processed++; continue; }
      if (holders > 0 && holders < cfg.minHolders) { processed++; continue; }
      if (totalFees > 0 && totalFees < cfg.minTotalFeesSol) { processed++; continue; }
      if (ageMs > 0 && (ageMs < cfg.minAgeMs || ageMs > cfg.maxAgeMs)) { processed++; continue; }

      seenTrending.set(key, now());
      recordSignalEvent(mint, row);

      try {
        await candidateHandler({
          mint,
          ageMs: ageMs || 0,
          sourceCount: 1,                    // single source (gmgn_trending)
          sources: ['gmgn_trending'],
          name: row.name || row.symbol || null,
          symbol: row.symbol || null,
          priceUsd: Number(row.price ?? 0),
          marketCapUsd: mcap,
          liquidityUsd: Number(row.liquidity ?? 0),
          holders,
          volume5m: Number(row.volume ?? 0),
          volume24h: Number(row.volume_24h ?? row.volume ?? 0),
          trending: {
            volume: Number(row.volume ?? 0),
            swaps: Number(row.swaps ?? row.buys + row.sells ?? 0),
            buys: Number(row.buys ?? 0),
            sells: Number(row.sells ?? 0),
            smart_degen_count: Number(row.smart_degen_count ?? 0),
            organicScore: Number(row.organic_score ?? row.hot_level ?? 0),
          },
          graduated: null,
          feeClaim: null,
          raw: row,
        });
        forwarded++;
      } catch (err) {
        console.log(`[gmgn-trending] handler error ${mint.slice(0, 8)}...: ${err.message}`);
      }
      processed++;
    }

    if (forwarded > 0 || processed > 0) {
      console.log(`[gmgn-trending] ${processed} scanned, ${forwarded} forwarded (${cfg.timeframe} top ${cfg.limit} by ${cfg.orderby})`);
    }
  } catch (err) {
    setGmgnBackoff('trending', err);
    console.log(`[gmgn-trending] ${err.response?.status || ''} ${err.message}`);
  }
}
