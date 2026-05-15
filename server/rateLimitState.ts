import { childLogger } from "./logger";

const log = childLogger("rateLimit");

export type RateLimitSnapshot = {
  limited: boolean;
  resetAt: Date | null;
  recentlyLimited: boolean;
  lastLimitedAt: Date | null;
};

let resetAt: Date | null = null;
let lastLimitedAt: Date | null = null;
const RECENT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export function markRateLimited(reset: Date | number | undefined): Date {
  let parsed: Date | null = null;
  if (reset instanceof Date) {
    parsed = reset;
  } else if (typeof reset === "number" && Number.isFinite(reset) && reset > 0) {
    // Accept both unix seconds (GitHub's `x-ratelimit-reset`) and millis.
    const ms = reset < 1e12 ? reset * 1000 : reset;
    parsed = new Date(ms);
  }

  // Without a header we still want to gate further calls for a short window —
  // most rate-limit windows reset within an hour, so a 60s safety floor avoids
  // hammering immediately on the next tick.
  const fallback = new Date(Date.now() + 60_000);
  const next = parsed && parsed.getTime() > Date.now() ? parsed : fallback;

  if (!resetAt || next.getTime() > resetAt.getTime()) {
    resetAt = next;
    log.warn(
      { resetAt: resetAt.toISOString(), secondsUntilReset: Math.ceil((resetAt.getTime() - Date.now()) / 1000) },
      "GitHub rate limit reached; gating further requests until reset",
    );
  }
  lastLimitedAt = new Date();

  return resetAt;
}

export function getRateLimitState(): RateLimitSnapshot {
  const now = Date.now();
  const recentlyLimited = lastLimitedAt !== null && (now - lastLimitedAt.getTime()) <= RECENT_RATE_LIMIT_WINDOW_MS;
  if (!resetAt) {
    return { limited: false, resetAt: null, recentlyLimited, lastLimitedAt };
  }
  if (resetAt.getTime() <= now) {
    resetAt = null;
    return { limited: false, resetAt: null, recentlyLimited, lastLimitedAt };
  }
  return { limited: true, resetAt, recentlyLimited, lastLimitedAt };
}

export function clearRateLimited(): void {
  if (resetAt) {
    log.info({}, "GitHub rate limit cleared by a successful request");
    resetAt = null;
  }
}

export function clearRateLimitStateForTests(): void {
  resetAt = null;
  lastLimitedAt = null;
}
