// Holder risk filter — Phase 2 defensive layer.
// Detection-only: returns flags + score 0..1. Hard-reject decision lives in metricsGate.
//
// References:
//   - MemeTrans paper (Georgia Tech): high-risk launches have top 10 holders +17pp
//     vs low-risk; bundled supply averages 36% in high-risk cohort
//   - Mobula: top10 < 30%, dev < 5%, no single holder > 50% as green flags
export function evaluateHolderRisk(candidate) {
  const flags = [];
  const metrics = {};
  const holders = candidate.holders;

  if (!holders || !Array.isArray(holders.holders) || holders.holders.length === 0) {
    return { checked: false, flags: [], metrics: {}, riskScore: 0 };
  }

  const all = holders.holders;
  const top10 = all.slice(0, 10);
  const top20 = all.slice(0, 20);

  const top10Pct = top10.reduce((sum, h) => sum + Number(h.percent || 0), 0);
  const top20Pct = top20.reduce((sum, h) => sum + Number(h.percent || 0), 0);
  const top1Pct = Number(all[0]?.percent || 0);
  metrics.top1Percent = top1Pct;
  metrics.top10Percent = top10Pct;
  metrics.top20Percent = top20Pct;

  if (top1Pct > 20) flags.push('top1_holder_above_20pct');
  if (top10Pct > 50) flags.push('top10_holders_above_50pct');
  else if (top10Pct > 30) flags.push('top10_holders_above_30pct');
  if (top20Pct > 70) flags.push('top20_holders_above_70pct');

  const clusterBands = new Map();
  for (const h of top20) {
    const band = Math.round(Number(h.percent || 0) * 2) / 2;
    if (band <= 0) continue;
    clusterBands.set(band, (clusterBands.get(band) || 0) + 1);
  }
  let largestCluster = 0;
  let largestClusterBand = 0;
  for (const [band, count] of clusterBands) {
    if (count > largestCluster) { largestCluster = count; largestClusterBand = band; }
  }
  metrics.largestClusterCount = largestCluster;
  metrics.largestClusterBandPct = largestClusterBand;
  if (largestCluster >= 4) flags.push('possible_bundle_cluster');

  const taggedBundlers = all.filter(h => Array.isArray(h.tags) && h.tags.some(t => /bundle|sniper/i.test(String(t))));
  metrics.taggedBundlerCount = taggedBundlers.length;
  metrics.taggedBundlerPercent = taggedBundlers.reduce((sum, h) => sum + Number(h.percent || 0), 0);
  if (metrics.taggedBundlerPercent > 20) flags.push('tagged_bundlers_above_20pct');

  let riskScore = 0;
  if (top1Pct > 20) riskScore += 0.30;
  else if (top1Pct > 15) riskScore += 0.15;
  if (top10Pct > 50) riskScore += 0.40;
  else if (top10Pct > 30) riskScore += 0.20;
  if (largestCluster >= 4) riskScore += 0.20;
  if (metrics.taggedBundlerPercent > 20) riskScore += 0.30;
  riskScore = Math.min(1, riskScore);

  return { checked: true, flags, metrics, riskScore };
}
