// simple per-user per-command cooldown store
const lastUsed = new Map(); // key: `${cmd}:${uid}` -> timestamp

/**
 * Returns 0 if allowed now; otherwise remaining ms on cooldown.
 */
export function onCooldown(cmd, uid, cooldownMs = 3000) {
  const key = `${cmd}:${uid}`;
  const now = Date.now();
  const last = lastUsed.get(key) || 0;
  if (now - last < cooldownMs) return cooldownMs - (now - last);
  lastUsed.set(key, now);
  return 0;
}
