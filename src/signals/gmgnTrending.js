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
    // Pre-filters
    minMcap: Number(strat.gmgn_trending_min_mcap || 80000),
    maxMcap: Number(strat.gmgn_trending_max_mcap || 5000000),
    minAgeMs: Number(strat.gmgn_trending_min_age_ms || 3600000),       // 1h
    maxAgeMs: Number(strat.gmgn_trending_max_age_ms || 604800000),     // 7d
    minHolders: Number(strat.gmgn_trending_min_holders || 100),
    // Strict filters
    maxTop10Rate: Number(strat.gmgn_trending_max_top10_rate || 0.20),   // 20%
    maxBundlerRate: Number(strat.gmgn_trending_max_bundler_rate || 0.40), // 40%
    requireNoMint: strat.gmgn_trending_require_no_mint !== false,        // default true
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

      // Pre-filter using GMGN response fields directly.
      // Fields confirmed available: market_cap, holder_count, volume, creation_timestamp,
      // top_10_holder_rate (decimal), bundler_rate (decimal), is_wash_trading, renounced_mint.
      const mcap = Number(row.market_cap ?? 0);
      const holders = Number(row.holder_count ?? 0);
      const volume = Number(row.volume ?? 0);
      const createdAt = Number(row.creation_timestamp ?? 0);
      const ageMs = createdAt > 0 ? (now() - createdAt * 1000) : 0;
      const top10Rate = Number(row.top_10_holder_rate ?? 0);       // decimal (0.20 = 20%)
      const bundlerRate = Number(row.bundler_rate ?? 0);           // decimal
      const isWashTrading = row.is_wash_trading === true;
      const noMint = Number(row.renounced_mint ?? 0) === 1;

      // Hard filters (from strategy config)
      if (mcap > 0 && (mcap < cfg.minMcap || mcap > cfg.maxMcap)) { processed++; continue; }
      if (holders > 0 && holders < cfg.minHolders) { processed++; continue; }
      if (ageMs > 0 && (ageMs < cfg.minAgeMs || ageMs > cfg.maxAgeMs)) { processed++; continue; }

      // Strict filters: top10, bundler, wash trade, NoMint
      const maxTop10 = Number(cfg.maxTop10Rate || 0.20);           // default 20%
      if (top10Rate > 0 && top10Rate > maxTop10) { processed++; continue; }

      const maxBundler = Number(cfg.maxBundlerRate || 0.40);       // default 40%
      if (bundlerRate > 0 && bundlerRate > maxBundler) { processed++; continue; }

      if (isWashTrading) { processed++; continue; }

      if (cfg.requireNoMint && !noMint) { processed++; continue; }

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
