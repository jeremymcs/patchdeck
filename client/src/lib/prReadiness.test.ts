import test from "node:test";
import assert from "node:assert/strict";
import type { FeedbackItem, PR, PRSummary } from "@shared/schema";
import {
  buildPRReadinessChecks,
  isGitHubReadyToMerge,
  isPRDetailReadyToMerge,
  isPRSummaryReadyToMerge,
} from "./prReadiness";

const resolvedFeedback = [{
  id: "1",
  prId: "pr-1",
  author: "reviewer",
  body: "done",
  bodyHtml: "<p>done</p>",
  replyKind: "general_comment",
  sourceId: "comment-1",
  sourceNodeId: null,
  sourceUrl: null,
  threadId: null,
  threadResolved: null,
  auditToken: "audit",
  file: null,
  line: null,
  type: "comment",
  createdAt: "2026-05-16T18:00:00.000Z",
  decision: "accepted",
  decisionReason: null,
  action: null,
  status: "resolved",
  statusReason: null,
}] satisfies FeedbackItem[];

function makePr(overrides: Partial<PR> = {}): PR {
  return {
    id: "pr-1",
    number: 42,
    title: "PR",
    body: null,
    bodyHtml: null,
    repo: "owner/repo",
    branch: "feature",
    author: "alice",
    url: "https://github.com/owner/repo/pull/42",
    status: "done",
    feedbackItems: resolvedFeedback,
    accepted: 1,
    rejected: 0,
    flagged: 0,
    testsPassed: true,
    lintPassed: true,
    mergeableState: "clean",
    lastChecked: "2026-05-16T18:00:00.000Z",
    lastSyncAttemptedAt: null,
    lastSyncSucceededAt: null,
    lastSyncError: null,
    watchEnabled: true,
    addedAt: "2026-05-16T18:00:00.000Z",
    ...overrides,
  };
}

test("isGitHubReadyToMerge only treats GitHub clean state as ready", () => {
  assert.equal(isGitHubReadyToMerge({ mergeableState: "clean" }), true);
  assert.equal(isGitHubReadyToMerge({ mergeableState: "blocked" }), false);
  assert.equal(isGitHubReadyToMerge({ mergeableState: "dirty" }), false);
  assert.equal(isGitHubReadyToMerge({ mergeableState: null }), false);
});

test("isPRDetailReadyToMerge requires idle work, no known check failures, resolved comments, and GitHub ready state", () => {
  assert.equal(isPRDetailReadyToMerge(makePr()), true);
  assert.equal(isPRDetailReadyToMerge(makePr({ testsPassed: null })), true);
  assert.equal(isPRDetailReadyToMerge(makePr({ lintPassed: null })), true);
  assert.equal(isPRDetailReadyToMerge(makePr({ testsPassed: false })), false);
  assert.equal(isPRDetailReadyToMerge(makePr({ lintPassed: false })), false);
  assert.equal(isPRDetailReadyToMerge(makePr({ mergeableState: "blocked" })), false);
  assert.equal(isPRDetailReadyToMerge(makePr({ feedbackItems: [] })), true);
  assert.equal(isPRDetailReadyToMerge(makePr({ status: "processing" })), false);
  assert.equal(isPRDetailReadyToMerge(makePr({ status: "error" })), false);
});

test("isPRSummaryReadyToMerge uses stored checks and GitHub ready state", () => {
  const summary = makePr();
  const { feedbackItems: _feedbackItems, ...base } = summary;

  assert.equal(isPRSummaryReadyToMerge(base satisfies PRSummary), true);
  assert.equal(isPRSummaryReadyToMerge({ ...base, status: "watching" }), true);
  assert.equal(isPRSummaryReadyToMerge({ ...base, testsPassed: null }), true);
  assert.equal(isPRSummaryReadyToMerge({ ...base, lintPassed: null }), true);
  assert.equal(isPRSummaryReadyToMerge({ ...base, testsPassed: false }), false);
  assert.equal(isPRSummaryReadyToMerge({ ...base, lintPassed: false }), false);
  assert.equal(isPRSummaryReadyToMerge({ ...base, mergeableState: "unstable" }), false);
  assert.equal(isPRSummaryReadyToMerge({ ...base, status: "processing" }), false);
});

test("buildPRReadinessChecks explains why a PR is not ready", () => {
  const checks = buildPRReadinessChecks(makePr({
    status: "processing",
    testsPassed: false,
    lintPassed: null,
    mergeableState: "dirty",
    feedbackItems: [
      { ...resolvedFeedback[0], id: "1", status: "resolved" },
      { ...resolvedFeedback[0], id: "2", status: "queued" },
    ] as FeedbackItem[],
  }));

  assert.deepEqual(checks.map((check) => [check.key, check.passed]), [
    ["work-state", false],
    ["tests", false],
    ["lint", true],
    ["comments", false],
    ["github", false],
  ]);
  assert.match(checks.find((check) => check.key === "comments")?.detail ?? "", /1 tracked feedback item/);
});
