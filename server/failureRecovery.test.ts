// PatchDeck + Failure classification and retry policy tests
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_INVOKING_JOB_KINDS,
  classifyFailure,
  computeRetryDelayMs,
  planFailedJobRecovery,
  resolveMaxAttempts,
} from "./failureRecovery";

test("classifies network and GitHub infrastructure failures as transient", () => {
  const transient = [
    new Error("connect ECONNRESET 140.82.121.6:443"),
    new Error("request to https://api.github.com failed, reason: socket hang up"),
    new Error("fetch failed"),
    new Error("GitHub sync failed with status 503"),
    new Error("You have exceeded a secondary rate limit"),
    new Error("GitHub core budget is in the reserve band; deferring low-priority request"),
  ];

  for (const error of transient) {
    assert.equal(classifyFailure(error), "transient", error.message);
  }
});

test("classifies agent availability failures as blocked", () => {
  const blocked = [
    new Error("Claude apply failed: authentication failed"),
    new Error("codex cli is not installed"),
    new Error("spawn claude ENOENT"),
    new Error("Bad credentials"),
    new Error("Resource not accessible by integration"),
  ];

  for (const error of blocked) {
    assert.equal(classifyFailure(error), "blocked", error.message);
  }
});

test("defaults unrecognized failures to retryable", () => {
  assert.equal(classifyFailure(new Error("worktree checkout produced no changes")), "retryable");
  assert.equal(classifyFailure("something odd happened"), "retryable");
  assert.equal(classifyFailure(new Error("")), "retryable");
});

test("a network timeout is not mistaken for an expired credential", () => {
  assert.equal(classifyFailure(new Error("Claude apply failed: ETIMEDOUT")), "transient");
});

test("blocked and terminal failures are never retried", () => {
  for (const failureClass of ["blocked", "terminal"] as const) {
    assert.equal(
      resolveMaxAttempts({ kind: "babysit_pr", failureClass, maxAgentRetryAttempts: 3 }),
      0,
    );
  }
});

test("transient retries are generous and not governed by the agent spend cap", () => {
  const attempts = resolveMaxAttempts({
    kind: "babysit_pr",
    failureClass: "transient",
    maxAgentRetryAttempts: 1,
  });

  assert.equal(attempts, 10);
});

test("the agent spend cap governs unclassified failures on agent-invoking kinds", () => {
  assert.equal(
    resolveMaxAttempts({ kind: "work_issue", failureClass: "retryable", maxAgentRetryAttempts: 3 }),
    3,
  );
  assert.equal(
    resolveMaxAttempts({ kind: "work_issue", failureClass: "retryable", maxAgentRetryAttempts: 7 }),
    7,
  );
  assert.equal(
    resolveMaxAttempts({ kind: "work_issue", failureClass: "retryable", maxAgentRetryAttempts: 0 }),
    1,
    "a zero cap still allows the attempt already made to be the last one",
  );
});

test("the agent spend cap does not throttle api-only job kinds", () => {
  assert.ok(!AGENT_INVOKING_JOB_KINDS.has("sync_watched_repos"));
  assert.equal(
    resolveMaxAttempts({
      kind: "sync_watched_repos",
      failureClass: "retryable",
      maxAgentRetryAttempts: 1,
    }),
    8,
  );
});

test("backoff grows exponentially and caps at an hour", () => {
  const noJitter = { random: () => 0.5 };

  assert.equal(computeRetryDelayMs(1, noJitter), 30_000);
  assert.equal(computeRetryDelayMs(2, noJitter), 60_000);
  assert.equal(computeRetryDelayMs(3, noJitter), 120_000);
  assert.equal(computeRetryDelayMs(4, noJitter), 240_000);
  assert.equal(computeRetryDelayMs(10, noJitter), 3_600_000);
  assert.equal(computeRetryDelayMs(50, noJitter), 3_600_000);
});

test("backoff jitter stays within twenty percent and never goes negative", () => {
  assert.equal(computeRetryDelayMs(2, { random: () => 0 }), 48_000);
  assert.equal(computeRetryDelayMs(2, { random: () => 1 }), 72_000);
  assert.ok(computeRetryDelayMs(0, { random: () => 0 }) >= 1_000);
});

test("planFailedJobRecovery leaves freshly parked jobs alone", () => {
  const nowMs = Date.parse("2026-05-01T12:00:00.000Z");
  const revivable = planFailedJobRecovery(
    [{
      id: "job-1",
      status: "failed",
      lastError: "agent run failed",
      createdAt: "2026-05-01T11:00:00.000Z",
      updatedAt: "2026-05-01T11:50:00.000Z",
    }],
    nowMs,
  );

  assert.deepEqual(revivable, []);
});

test("planFailedJobRecovery gives a parked job another cycle once its interval elapses", () => {
  const nowMs = Date.parse("2026-05-01T12:00:00.000Z");
  const revivable = planFailedJobRecovery(
    [{
      id: "job-1",
      status: "failed",
      lastError: "codex cli is not installed",
      createdAt: "2026-05-01T10:00:00.000Z",
      updatedAt: "2026-05-01T10:30:00.000Z",
    }],
    nowMs,
  );

  assert.deepEqual(revivable, ["job-1"]);
});

test("planFailedJobRecovery stops cycling a job that has been failing for a day", () => {
  const nowMs = Date.parse("2026-05-03T12:00:00.000Z");
  const revivable = planFailedJobRecovery(
    [{
      id: "job-1",
      status: "failed",
      lastError: "authentication failed",
      createdAt: "2026-05-01T09:00:00.000Z",
      updatedAt: "2026-05-03T10:00:00.000Z",
    }],
    nowMs,
  );

  assert.deepEqual(revivable, [], "at that point it really does need a person");
});

test("planFailedJobRecovery ignores jobs that are not parked", () => {
  const nowMs = Date.parse("2026-05-01T12:00:00.000Z");
  const revivable = planFailedJobRecovery(
    [
      {
        id: "queued",
        status: "queued",
        lastError: null,
        createdAt: "2026-05-01T09:00:00.000Z",
        updatedAt: "2026-05-01T09:00:00.000Z",
      },
      {
        id: "canceled",
        status: "canceled",
        lastError: "PR no longer exists",
        createdAt: "2026-05-01T09:00:00.000Z",
        updatedAt: "2026-05-01T09:00:00.000Z",
      },
    ],
    nowMs,
  );

  assert.deepEqual(revivable, []);
});
