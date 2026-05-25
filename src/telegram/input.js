// Pending text-input flows (e.g. /stratset prompts). Currently unused — Apex
// commands take inline arguments instead. Kept as an extension point.
const pending = new Map();

export function setPendingInput(chatId, payload) {
  pending.set(String(chatId), { ...payload, at: Date.now() });
}
export function consumePendingInput(chatId) {
  const key = String(chatId);
  const value = pending.get(key);
  pending.delete(key);
  return value || null;
}
export function hasPendingInput(chatId) {
  return pending.has(String(chatId));
}
