import test from "node:test";
import assert from "node:assert/strict";
import type { FeedbackItem, PR, PRSummary } from "@shared/schema";
import {
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

test("isPRDetailReadyToMerge requires comments, checks, lint, and GitHub ready state", () => {
  assert.equal(isPRDetailReadyToMerge(makePr()), true);
  assert.equal(isPRDetailReadyToMerge(makePr({ testsPassed: false })), false);
  assert.equal(isPRDetailReadyToMerge(makePr({ lintPassed: false })), false);
  assert.equal(isPRDetailReadyToMerge(makePr({ mergeableState: "blocked" })), false);
  assert.equal(isPRDetailReadyToMerge(makePr({ feedbackItems: [] })), false);
  assert.equal(isPRDetailReadyToMerge(makePr({ status: "processing" })), false);
});

test("isPRSummaryReadyToMerge uses stored checks and GitHub ready state", () => {
  const summary = makePr();
  const { feedbackItems: _feedbackItems, ...base } = summary;

  assert.equal(isPRSummaryReadyToMerge(base satisfies PRSummary), true);
  assert.equal(isPRSummaryReadyToMerge({ ...base, testsPassed: null }), false);
  assert.equal(isPRSummaryReadyToMerge({ ...base, lintPassed: null }), false);
  assert.equal(isPRSummaryReadyToMerge({ ...base, mergeableState: "unstable" }), false);
});
