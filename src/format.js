export function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export function short(address) {
  const s = String(address || '');
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}
export function fmtSol(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(4) : '?';
}
export function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '?';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
export function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : '?';
}
export function fmtMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '0s';
  if (n < 60_000) return `${Math.round(n / 1000)}s`;
  if (n < 3_600_000) return `${Math.round(n / 60_000)}m`;
  if (n < 86_400_000) return `${(n / 3_600_000).toFixed(1)}h`;
  return `${(n / 86_400_000).toFixed(1)}d`;
}
export function gmgnLink(mint) {
  return `https://gmgn.ai/sol/token/${mint}`;
}
export function txLink(signature) {
  return `https://solscan.io/tx/${signature}`;
}
export function accountLink(address) {
  return `https://solscan.io/account/${address}`;
}
