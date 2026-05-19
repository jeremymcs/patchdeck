import { childLogger } from "./logger";

const log = childLogger("rateLimit");

export type RateLimitResource = "core" | "graphql" | "search";

const RESOURCES: RateLimitResource[] = ["core", "graphql", "search"];

export type ResourceSnapshot = {
  limited: boolean;
  resetAt: Date | null;
  recentlyLimited: boolean;
  lastLimitedAt: Date | null;
  budget: ResourceBudget | null;
  belowReserve: boolean;
  belowFloor: boolean;
};

export type RateLimitSnapshot = ResourceSnapshot & {
  resources: Record<RateLimitResource, ResourceSnapshot>;
};

type ResourceState = { resetAt: Date | null; lastLimitedAt: Date | null };

const RECENT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

// Fraction of a resource's budget held in reserve for high-priority work
// (interactive routes, active babysitter sessions). Low-priority requests are
// gated once `remaining` falls to or below this fraction of the limit.
const BUDGET_RESERVE_FRACTION = 0.3;

// Hard floor: below this fraction every request is gated regardless of
// priority, so a burst of high-priority automation cannot drain the budget to
// zero. Leaves a sliver so the next hourly reset is not met from empty.
const BUDGET_FLOOR_FRACTION = 0.05;

const state: Record<RateLimitResource, ResourceState> = {
  core: { resetAt: null, lastLimitedAt: null },
  graphql: { resetAt: null, lastLimitedAt: null },
  search: { resetAt: null, lastLimitedAt: null },
};

export type ResourceBudget = { remaining: number; limit: number; resetAt?: Date | null };

const budgets: Record<RateLimitResource, ResourceBudget | null> = {
  core: null,
  graphql: null,
  search: null,
};

export function deriveRateLimitResource(
  urlOrHeader: string | null | undefined,
): RateLimitResource {
  if (!urlOrHeader) return "core";
  const trimmed = urlOrHeader.trim().toLowerCase();
  if (!trimmed) return "core";
  if (trimmed === "graphql" || trimmed.startsWith("graphql ") || trimmed.includes("/graphql")) {
    return "graphql";
  }
  if (trimmed === "search" || trimmed.startsWith("search ") || trimmed.includes("/search/")) {
    return "search";
  }
  return "core";
}

function parseReset(reset: Date | number | undefined): Date | null {
  if (reset instanceof Date) return reset;
  if (typeof reset === "number" && Number.isFinite(reset) && reset > 0) {
    // Accept both unix seconds (GitHub's `x-ratelimit-reset`) and millis.
    const ms = reset < 1e12 ? reset * 1000 : reset;
    return new Date(ms);
  }
  return null;
}

export function markRateLimited(
  reset: Date | number | undefined,
  resource: RateLimitResource = "core",
): Date {
  const parsed = parseReset(reset);
  // Without a header we still want to gate further calls for a short window —
  // most rate-limit windows reset within an hour, so a 60s safety floor avoids
  // hammering immediately on the next tick.
  const fallback = new Date(Date.now() + 60_000);
  const next = parsed && parsed.getTime() > Date.now() ? parsed : fallback;

  const entry = state[resource];
  if (!entry.resetAt || next.getTime() > entry.resetAt.getTime()) {
    entry.resetAt = next;
    log.warn(
      {
        resource,
        resetAt: entry.resetAt.toISOString(),
        secondsUntilReset: Math.ceil((entry.resetAt.getTime() - Date.now()) / 1000),
      },
      "GitHub rate limit reached; gating further requests until reset",
    );
  }
  entry.lastLimitedAt = new Date();

  return entry.resetAt;
}

function snapshotResource(resource: RateLimitResource, now: number): ResourceSnapshot {
  const entry = state[resource];
  const budget = getResourceBudget(resource);
  const belowReserve = isResourceBudgetBelowReserve(resource);
  const belowFloor = isResourceBudgetBelowFloor(resource);
  const recentlyLimited = entry.lastLimitedAt !== null
    && (now - entry.lastLimitedAt.getTime()) <= RECENT_RATE_LIMIT_WINDOW_MS;
  if (entry.resetAt && entry.resetAt.getTime() <= now) {
    entry.resetAt = null;
  }
  if (!entry.resetAt) {
    return {
      limited: false,
      resetAt: null,
      recentlyLimited,
      lastLimitedAt: entry.lastLimitedAt,
      budget,
      belowReserve,
      belowFloor,
    };
  }
  return {
    limited: true,
    resetAt: entry.resetAt,
    recentlyLimited,
    lastLimitedAt: entry.lastLimitedAt,
    budget,
    belowReserve,
    belowFloor,
  };
}

export function getRateLimitState(resource?: RateLimitResource): RateLimitSnapshot {
  const now = Date.now();
  const resources: Record<RateLimitResource, ResourceSnapshot> = {
    core: snapshotResource("core", now),
    graphql: snapshotResource("graphql", now),
    search: snapshotResource("search", now),
  };

  if (resource) {
    return { ...resources[resource], resources };
  }

  const limitedResources = RESOURCES.filter((r) => resources[r].limited);
  const limited = limitedResources.length > 0;
  const resetAt = limited
    ? limitedResources
        .map((r) => resources[r].resetAt!)
        .reduce((a, b) => (a.getTime() >= b.getTime() ? a : b))
    : null;
  const recentlyLimited = RESOURCES.some((r) => resources[r].recentlyLimited);
  const belowReserve = RESOURCES.some((r) => resources[r].belowReserve);
  const belowFloor = RESOURCES.some((r) => resources[r].belowFloor);
  const lastLimitedAt = RESOURCES
    .map((r) => resources[r].lastLimitedAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

  return {
    limited,
    resetAt,
    recentlyLimited,
    lastLimitedAt,
    budget: null,
    belowReserve,
    belowFloor,
    resources,
  };
}

export function clearRateLimited(resource: RateLimitResource = "core"): void {
  const entry = state[resource];
  if (entry.resetAt) {
    log.info({ resource }, "GitHub rate limit cleared by a successful request");
    entry.resetAt = null;
  }
}

/**
 * Records the latest observed budget for a resource from `x-ratelimit-*`
 * response headers. Used to decide whether low-priority requests should be
 * gated. The core REST and GraphQL APIs have independent budgets.
 */
export function recordResourceBudget(
  resource: RateLimitResource,
  remaining: number,
  limit: number,
  reset?: Date | number,
): void {
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0) {
    return;
  }
  const resetAt = parseReset(reset);
  budgets[resource] = {
    remaining: Math.max(0, remaining),
    limit,
    ...(resetAt ? { resetAt } : {}),
  };
}

function readFreshResourceBudget(resource: RateLimitResource): ResourceBudget | null {
  const budget = budgets[resource];
  if (!budget) return null;
  if (budget.resetAt && budget.resetAt.getTime() <= Date.now()) {
    budgets[resource] = null;
    return null;
  }
  return budget;
}

export function getResourceBudget(resource: RateLimitResource): ResourceBudget | null {
  const budget = readFreshResourceBudget(resource);
  return budget ? { ...budget } : null;
}

/**
 * True when a resource's budget has fallen into the reserve band. While true,
 * low-priority (background sweep) requests against that resource are gated so
 * the remaining budget is kept for high-priority work. Returns false when the
 * budget is unknown — an unobserved budget must not block work.
 */
export function isResourceBudgetBelowReserve(resource: RateLimitResource): boolean {
  const budget = readFreshResourceBudget(resource);
  if (!budget) return false;
  return budget.remaining <= budget.limit * BUDGET_RESERVE_FRACTION;
}

/**
 * True when a resource's budget has fallen below the hard floor. While true,
 * every request against that resource is gated regardless of priority — a
 * burst of high-priority automation must not be able to drain the budget to
 * zero. Returns false when the budget is unknown.
 */
export function isResourceBudgetBelowFloor(resource: RateLimitResource): boolean {
  const budget = readFreshResourceBudget(resource);
  if (!budget) return false;
  return budget.remaining <= budget.limit * BUDGET_FLOOR_FRACTION;
}

export function clearRateLimitStateForTests(): void {
  for (const resource of RESOURCES) {
    state[resource].resetAt = null;
    state[resource].lastLimitedAt = null;
    budgets[resource] = null;
  }
}
