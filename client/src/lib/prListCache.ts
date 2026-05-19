import { prSummarySchema, type PRSummary } from "@shared/schema";

export type PRListCacheView = "active" | "archived";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const PR_LIST_STALE_MS = 15 * 60 * 1000;
export const PR_LIST_CACHE_RETENTION_MS = 24 * 60 * 60 * 1000;

function getStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

function cacheKey(view: PRListCacheView): string {
  return `patchdeck:prs-cache:v1:${view}`;
}

export function readCachedPRs(
  view: PRListCacheView,
  options: {
    storage?: StorageLike | null;
    now?: () => number;
    maxAgeMs?: number;
  } = {},
): { data: PRSummary[]; updatedAt: number } | null {
  const storage = getStorage(options.storage);
  if (!storage) return null;

  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? PR_LIST_CACHE_RETENTION_MS;
  try {
    const raw = storage.getItem(cacheKey(view));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { data?: unknown; updatedAt?: unknown };
    if (!parsed.data || typeof parsed.updatedAt !== "number" || !Number.isFinite(parsed.updatedAt)) {
      storage.removeItem(cacheKey(view));
      return null;
    }

    if (now() - parsed.updatedAt > maxAgeMs) {
      return null;
    }

    const normalized = prSummarySchema.array().safeParse(parsed.data);
    if (!normalized.success) {
      storage.removeItem(cacheKey(view));
      return null;
    }

    return { data: normalized.data, updatedAt: parsed.updatedAt };
  } catch {
    storage.removeItem(cacheKey(view));
    return null;
  }
}

export function writeCachedPRs(
  view: PRListCacheView,
  data: PRSummary[],
  options: {
    storage?: StorageLike | null;
    now?: () => number;
  } = {},
): void {
  const storage = getStorage(options.storage);
  if (!storage) return;

  try {
    storage.setItem(cacheKey(view), JSON.stringify({
      data,
      updatedAt: (options.now ?? Date.now)(),
    }));
  } catch {
    // Best-effort cache only.
  }
}
