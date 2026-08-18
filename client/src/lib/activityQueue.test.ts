import assert from "node:assert/strict";
import test from "node:test";
import type { ActivitySnapshot } from "@shared/schema";
import { buildQueueStatusIndex, getQueueStatusForTarget } from "./activityQueue";

const snapshot: ActivitySnapshot = {
  failed: [],
  inProgress: [
    {
      id: "run-1",
      kind: "babysit_pr",
      status: "in_progress",
      label: "Working PR #1",
      detail: null,
      targetId: "pr-1",
      targetUrl: null,
      queuedAt: "2026-05-12T11:56:00.000Z",
      availableAt: "2026-05-12T11:56:00.000Z",
      startedAt: "2026-05-12T11:59:00.000Z",
      updatedAt: "2026-05-12T11:59:10.000Z",
      attemptCount: 1,
      lastError: null,
    },
  ],
  queued: [
    {
      id: "queued-1",
      kind: "work_issue",
      status: "queued",
      label: "Working issue #7",
      detail: null,
      targetId: "issue-7",
      targetUrl: null,
      queuedAt: "2026-05-12T11:59:30.000Z",
      availableAt: "2026-05-12T12:00:00.000Z",
      startedAt: null,
      updatedAt: "2026-05-12T11:59:30.000Z",
      attemptCount: 0,
      lastError: null,
    },
    {
      id: "queued-2",
      kind: "evaluate_issue",
      status: "queued",
      label: "Evaluating issue #8",
      detail: null,
      targetId: "issue-8",
      targetUrl: null,
      queuedAt: "2026-05-12T11:59:45.000Z",
      availableAt: "2026-05-12T12:00:30.000Z",
      startedAt: null,
      updatedAt: "2026-05-12T11:59:45.000Z",
      attemptCount: 0,
      lastError: null,
    },
  ],
  warnings: [],
  generatedAt: "2026-05-12T12:00:00.000Z",
};

test("buildQueueStatusIndex summarizes queued and running activities", () => {
  const index = buildQueueStatusIndex(snapshot, Date.parse("2026-05-12T12:00:00.000Z"));

  assert.deepEqual(index.get("pr-1"), {
    label: "running",
    detail: "~4m remaining",
    className: "border-primary bg-primary/10 text-primary animate-pulse",
  });
  assert.deepEqual(index.get("issue-7"), {
    label: "up next",
    detail: "starts in ~4m",
    className: "border-primary/50 text-primary",
  });
  assert.deepEqual(index.get("issue-8"), {
    label: "#2 in queue",
    detail: "available in ~30s",
    className: "border-warning-border bg-warning-muted text-warning-foreground",
  });
});

test("getQueueStatusForTarget returns null for missing targets", () => {
  assert.equal(getQueueStatusForTarget(snapshot, "missing", Date.parse("2026-05-12T12:00:00.000Z")), null);
});

test("buildQueueStatusIndex distinguishes a backing-off retry from a normal queue wait", () => {
  const retrying: ActivitySnapshot = {
    failed: [],
    inProgress: [],
    queued: [
      {
        id: "queued-1",
        kind: "work_issue",
        status: "queued",
        label: "Working issue #7",
        detail: null,
        targetId: "issue-7",
        targetUrl: null,
        queuedAt: "2026-05-12T11:00:00.000Z",
        availableAt: "2026-05-12T12:05:00.000Z",
        startedAt: null,
        updatedAt: "2026-05-12T11:59:30.000Z",
        attemptCount: 2,
        lastError: "connect ECONNRESET",
      },
    ],
    warnings: [],
    generatedAt: "2026-05-12T12:00:00.000Z",
  };

  const index = buildQueueStatusIndex(retrying, Date.parse("2026-05-12T12:00:00.000Z"));
  const status = index.get("issue-7");

  assert.equal(status?.label, "retrying (attempt 3)");
  assert.match(status?.detail ?? "", /retry in ~5m/);
  assert.match(status?.detail ?? "", /ECONNRESET/);
});

test("buildQueueStatusIndex still reads as a queue position for untried work", () => {
  const index = buildQueueStatusIndex(snapshot, Date.parse("2026-05-12T12:00:00.000Z"));
  assert.equal(index.get("issue-7")?.label, "up next");
});
