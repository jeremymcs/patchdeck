import assert from "node:assert/strict";
import test from "node:test";
import { buildIssueReplyBody, buildIssueWorkStatusComment, buildPullRequestBody } from "./issueFormatter";

const input = {
  repoFullName: "acme/widgets",
  issueNumber: 17,
  issueTitle: "Fix the toggle",
  issueUrl: "https://github.com/acme/widgets/issues/17",
  prNumber: 88,
  prUrl: "https://github.com/acme/widgets/pull/88",
  branch: "issue/17-fix-the-toggle-123",
  summary: "Updated the toggle state.\nVerified the state transition with the targeted test.",
};

test("buildIssueReplyBody renders a structured multi-section issue reply", () => {
  const body = buildIssueReplyBody(input);

  assert.match(body, /Worked issue #17 into PR #88\./);
  assert.match(body, /## Summary/);
  assert.match(body, /- Updated the toggle state\./);
  assert.match(body, /- Verified the state transition with the targeted test\./);
  assert.match(body, /## Verification/);
  assert.match(body, /## Issue/);
  assert.match(body, /Repo: `acme\/widgets`/);
  assert.match(body, /## Pull Request/);
  assert.match(body, /Branch: `issue\/17-fix-the-toggle-123`/);
});

test("buildPullRequestBody renders a structured PR body with related issue details", () => {
  const body = buildPullRequestBody(input);

  assert.match(body, /## Summary/);
  assert.match(body, /## Verification/);
  assert.match(body, /## Related Issue/);
  assert.match(body, /Closes #17/);
  assert.match(body, /\[#17 Fix the toggle\]\(https:\/\/github.com\/acme\/widgets\/issues\/17\)/);
  assert.match(body, /## Repo/);
  assert.match(body, /## Branch/);
});

test("buildIssueWorkStatusComment renders the issue workflow milestones", () => {
  const started = buildIssueWorkStatusComment({
    repoFullName: input.repoFullName,
    issueNumber: input.issueNumber,
    issueTitle: input.issueTitle,
    issueUrl: input.issueUrl,
    stage: "started",
  });
  const verifying = buildIssueWorkStatusComment({
    repoFullName: input.repoFullName,
    issueNumber: input.issueNumber,
    issueTitle: input.issueTitle,
    issueUrl: input.issueUrl,
    stage: "verifying",
    detail: "Verification passed in the worktree.",
  });
  const failed = buildIssueWorkStatusComment({
    repoFullName: input.repoFullName,
    issueNumber: input.issueNumber,
    issueTitle: input.issueTitle,
    issueUrl: input.issueUrl,
    stage: "failed",
    detail: "agent timed out",
  });

  assert.match(started, /Issue work started/);
  assert.match(started, /\[#17 Fix the toggle\]/);
  assert.match(verifying, /Issue work verified/);
  assert.match(verifying, /Verification passed in the worktree\./);
  assert.match(failed, /Issue work failed/);
  assert.match(failed, /agent timed out/);
});

test("buildIssueWorkStatusComment redacts local file paths from failure details", () => {
  const failed = buildIssueWorkStatusComment({
    repoFullName: input.repoFullName,
    issueNumber: input.issueNumber,
    issueTitle: input.issueTitle,
    issueUrl: input.issueUrl,
    stage: "failed",
    detail: "ENOENT: no such file or directory, open '/Users/jeremymcspadden/.patchdeck/worktrees/widgets/file.txt'",
  });

  assert.match(failed, /Issue work failed/);
  assert.match(failed, /\[path redacted\]/);
  assert.doesNotMatch(failed, /\/Users\/jeremymcspadden/);
});
