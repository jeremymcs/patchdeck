import assert from "node:assert/strict";
import test from "node:test";
import type { PRSummary } from "@shared/schema";
import {
  PR_LIST_CACHE_RETENTION_MS,
  PR_LIST_STALE_MS,
  readCachedPRs,
  writeCachedPRs,
} from "./prListCache";

class FakeStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const samplePR: PRSummary = {
  id: "pr-1",
  number: 42,
  title: "Fix PR monitor",
  body: null,
  bodyHtml: null,
  repo: "acme/widgets",
  branch: "fix/pr-monitor",
  author: "alice",
  url: "https://github.com/acme/widgets/pull/42",
  status: "watching",
  accepted: 0,
  rejected: 0,
  flagged: 0,
  testsPassed: null,
  lintPassed: null,
  mergeableState: null,
  lastChecked: null,
  lastSyncAttemptedAt: null,
  lastSyncSucceededAt: null,
  lastSyncError: null,
  watchEnabled: true,
  addedAt: "2026-05-18T12:00:00.000Z",
};

test("PR list cache round-trips schema-valid summaries", () => {
  const storage = new FakeStorage();
  const now = 1_000_000;

  writeCachedPRs("active", [samplePR], {
    storage,
    now: () => now,
  });

  const cached = readCachedPRs("active", {
    storage,
    now: () => now + PR_LIST_STALE_MS + 1,
  });

  assert.deepEqual(cached, {
    data: [samplePR],
    updatedAt: now,
  });
});

test("PR list cache drops invalid payloads", () => {
  const storage = new FakeStorage();
  storage.setItem("patchdeck:prs-cache:v1:archived", JSON.stringify({
    data: [{ id: "missing-required-fields" }],
    updatedAt: 1_000_000,
  }));

  assert.equal(readCachedPRs("archived", { storage, now: () => 1_000_001 }), null);
  assert.equal(storage.getItem("patchdeck:prs-cache:v1:archived"), null);
});

test("PR list cache retains stale data only within the retention window", () => {
  const storage = new FakeStorage();
  writeCachedPRs("active", [samplePR], {
    storage,
    now: () => 1_000_000,
  });

  assert.notEqual(
    readCachedPRs("active", {
      storage,
      now: () => 1_000_000 + PR_LIST_CACHE_RETENTION_MS,
    }),
    null,
  );
  assert.equal(
    readCachedPRs("active", {
      storage,
      now: () => 1_000_000 + PR_LIST_CACHE_RETENTION_MS + 1,
    }),
    null,
  );
});
