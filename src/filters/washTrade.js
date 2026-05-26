// Wash trade filter — Phase 2 defensive layer.
// Sanity-check buy:sell ratio + buy/sell volume balance.
//
// Berdasarkan MemeTrans paper: 21% transaksi pre-migration di token graduated == wash trade
// (same wallet buy & sell within single tx). Bots cycle untuk simulasi demand.
//
// Sumber data: trending payload sudah punya buys/sells/buyVolume/sellVolume di stats5m.
// Server agregasi juga forward `is_wash_trading` flag (dari GMGN/Axiom).

export function evaluateWashTrade(candidate) {
  const flags = [];
  const metrics = {};
  const trending = candidate.trending;

  if (!trending) return { checked: false, flags: [], metrics: {}, riskScore: 0 };

  if (trending.is_wash_trading === true || trending.is_wash_trading === 1) {
    flags.push('source_flagged_wash_trading');
    return { checked: true, flags, metrics: { sourceFlag: true }, riskScore: 1.0 };
  }

  const buys = Number(trending.buys ?? trending.stats5m?.numBuys ?? 0);
  const sells = Number(trending.sells ?? trending.stats5m?.numSells ?? 0);
  const buyVolume = Number(trending.buyVolume ?? trending.stats5m?.buyVolume ?? 0);
  const sellVolume = Number(trending.sellVolume ?? trending.stats5m?.sellVolume ?? 0);
  const totalSwaps = buys + sells;
  const totalVolume = buyVolume + sellVolume;

  metrics.buys = buys;
  metrics.sells = sells;
  metrics.buyVolume = buyVolume;
  metrics.sellVolume = sellVolume;
  metrics.totalSwaps = totalSwaps;

  if (totalSwaps < 20) {
    // Not enough trade flow to evaluate
    return { checked: false, flags: [], metrics, riskScore: 0 };
  }

  // Buy:sell ratio sanity. Healthy momentum: ratio >1.2 (more buys).
  // Suspicious: ratio very close to 1:1 with high volume = wash cycling.
  const buyRatio = totalSwaps > 0 ? buys / totalSwaps : 0;
  metrics.buyRatio = buyRatio;
  if (buyRatio > 0.45 && buyRatio < 0.55 && totalSwaps > 100) {
    flags.push('suspicious_balanced_buys_sells');
  }

  // Volume mismatch — if numTraders very low but volume very high = bots
  const numTraders = Number(trending.stats5m?.numTraders ?? 0);
  metrics.numTraders = numTraders;
  if (numTraders > 0 && totalSwaps / numTraders > 8) {
    flags.push('high_swaps_per_trader');
  }

  // Organic-buyer ratio (Jupiter `organicScore` lebih bagus, tapi fallback ke trader count)
  const organicScore = Number(trending.organicScore ?? candidate.metrics?.trendingHotLevel ?? 0);
  metrics.organicScore = organicScore;
  if (organicScore > 0 && organicScore < 30) {
    flags.push('low_organic_score');
  }

  let riskScore = 0;
  if (flags.includes('suspicious_balanced_buys_sells')) riskScore += 0.4;
  if (flags.includes('high_swaps_per_trader')) riskScore += 0.3;
  if (flags.includes('low_organic_score')) riskScore += 0.3;
  riskScore = Math.min(1, riskScore);

  return { checked: true, flags, metrics, riskScore };
}
