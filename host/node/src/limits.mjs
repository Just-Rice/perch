// Sign-in lockout: after MAX_FAILS failures in a row a route is locked for one minute, doubling with each further
// failure up to an hour. A success resets it. Each route (passkey, backup) has its own counter.
export const MAX_FAILS = 5;
const BASE_LOCK_MS = 60 * 1000;
const MAX_LOCK_MS = 60 * 60 * 1000;

export const freshLimit = () => ({ fails: 0, lockedUntil: 0 });

// Milliseconds until the route opens again (0 when open).
export function lockedFor(limit, now = Date.now()) {
  return Math.max(0, (limit?.lockedUntil ?? 0) - now);
}

export function recordFailure(limit, now = Date.now()) {
  const fails = (limit?.fails ?? 0) + 1;
  const lockedUntil = fails >= MAX_FAILS
    ? now + Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (fails - MAX_FAILS))
    : (limit?.lockedUntil ?? 0);
  return { fails, lockedUntil };
}

export const recordSuccess = () => freshLimit();
