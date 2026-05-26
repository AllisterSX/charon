// Holder risk filter — Phase 2 defensive layer.
// Detects bundle / cluster patterns dari Jupiter holders list yang charon udah fetch.
//
// Berdasarkan riset:
//   - MemeTrans paper (Georgia Tech): high-risk launches: top 10 holders +17pp dari low-risk,
//     wash trade rate 21%, bundled supply rata-rata 36% di high-risk
//   - Mobula docs thresholds: top10 < 30%, dev < 5%, no single sniper > 50%
//   - Pine Analytics: deployer-funded same-block snipers exit <1min in 87% of cases
//
// Strategy ini detection-only — return risk flags + score, tidak hard-reject sendiri.
// Hard-reject keputusan diserahkan ke filterCandidate() di candidateBuilder, sehingga
// strategy spesifik bisa tune threshold via .env / SQLite settings.

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

  // Top concentration metrics
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

  // Cluster detection — round-amount bundling
  // If multiple top holders have suspiciously similar percentages, may be bundled wallets
  // controlled by same entity. Group within 0.5% bands.
  const clusterBands = new Map();
  for (const h of top20) {
    const band = Math.round(Number(h.percent || 0) * 2) / 2; // round to 0.5
    if (band <= 0) continue;
    clusterBands.set(band, (clusterBands.get(band) || 0) + 1);
  }
  let largestCluster = 0;
  let largestClusterBand = 0;
  for (const [band, count] of clusterBands) {
    if (count > largestCluster) {
      largestCluster = count;
      largestClusterBand = band;
    }
  }
  metrics.largestClusterCount = largestCluster;
  metrics.largestClusterBandPct = largestClusterBand;
  if (largestCluster >= 4) flags.push('possible_bundle_cluster');

  // Tagged-bundler check — if Jupiter holder data includes bundler tags
  const taggedBundlers = all.filter(h => Array.isArray(h.tags) && h.tags.some(t => /bundle|sniper/i.test(String(t))));
  metrics.taggedBundlerCount = taggedBundlers.length;
  metrics.taggedBundlerPercent = taggedBundlers.reduce((sum, h) => sum + Number(h.percent || 0), 0);
  if (metrics.taggedBundlerPercent > 20) flags.push('tagged_bundlers_above_20pct');

  // Risk score: 0..1 where 1 = max risk
  // Weighted by severity of each signal
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
