import test from "node:test";
import assert from "node:assert/strict";
import type { ActivitySnapshot } from "@shared/schema";
import { getActivityIdleReason } from "./activityIdle";

const emptyActivities: Pick<ActivitySnapshot, "inProgress" | "queued"> = {
  inProgress: [],
  queued: [],
};

test("getActivityIdleReason returns null while work is running", () => {
  assert.equal(getActivityIdleReason({
    activities: {
      ...emptyActivities,
      inProgress: [{} as ActivitySnapshot["inProgress"][number]],
    },
  }), null);
});

test("getActivityIdleReason explains drain mode before generic idleness", () => {
  assert.equal(getActivityIdleReason({
    activities: emptyActivities,
    drainMode: true,
    drainReason: "operator paused",
    trackedCount: 12,
    trackedLabel: "PR",
  }), "Automation is paused by drain mode: operator paused");
});

test("getActivityIdleReason explains rate limits with reset time", () => {
  const reason = getActivityIdleReason({
    activities: emptyActivities,
    githubRateLimited: true,
    githubRateLimitResetAt: "2026-05-17T16:30:00.000Z",
  });

  assert.match(reason ?? "", /GitHub is rate-limited/);
  assert.match(reason ?? "", /resume after/);
});

test("getActivityIdleReason explains eligible tracked work", () => {
  assert.equal(getActivityIdleReason({
    activities: emptyActivities,
    trackedCount: 20,
    eligibleCount: 3,
    trackedLabel: "PR",
  }), "No jobs are running. 3 PRs can be queued when the next safe work slot opens.");
});

test("getActivityIdleReason explains tracked work with no known eligible items", () => {
  assert.equal(getActivityIdleReason({
    activities: emptyActivities,
    trackedCount: 20,
    eligibleCount: 0,
    trackedLabel: "issue",
  }), "No jobs are running. 20 issues are tracked, but none are eligible right now or the watcher is waiting for the next sync pass.");
});
