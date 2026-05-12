import { childLogger } from "./logger";

const log = childLogger("rateLimit");

export type RateLimitSnapshot = {
  limited: boolean;
  resetAt: Date | null;
};

let resetAt: Date | null = null;

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

  return resetAt;
}

export function getRateLimitState(): RateLimitSnapshot {
  if (!resetAt) {
    return { limited: false, resetAt: null };
  }
  if (resetAt.getTime() <= Date.now()) {
    resetAt = null;
    return { limited: false, resetAt: null };
  }
  return { limited: true, resetAt };
}

export function clearRateLimited(): void {
  if (resetAt) {
    log.info({}, "GitHub rate limit cleared by a successful request");
    resetAt = null;
  }
}
