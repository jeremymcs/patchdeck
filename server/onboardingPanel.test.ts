import test from "node:test";
import assert from "node:assert/strict";
import { getOnboardingPanelState } from "../client/src/components/OnboardingPanel";

test("getOnboardingPanelState starts with three pending steps and no repos", () => {
  const state = getOnboardingPanelState({
    githubConnected: false,
    githubError: "No GitHub token found",
    repos: [],
  });

  assert.equal(state.hasIssues, true);
  assert.equal(state.summary, "0 of 3 complete");
  assert.equal(state.completedCount, 0);
  assert.deepEqual(
    state.steps.map((step) => ({ id: step.id, complete: step.complete })),
    [
      { id: "github", complete: false },
      { id: "repo", complete: false },
      { id: "workflow", complete: false },
    ],
  );
  assert.equal(state.dismissalKey, "github|repo|workflow");
});

test("getOnboardingPanelState keeps the panel visible for inaccessible repos after GitHub connects", () => {
  const state = getOnboardingPanelState({
    githubConnected: true,
    repos: [
      {
        repo: "octo/accessible",
        accessible: true,
        codeReviews: { claude: false, codex: false, gemini: false },
      },
      {
        repo: "octo/inaccessible",
        accessible: false,
        error: "Resource not accessible by integration",
        codeReviews: { claude: false, codex: false, gemini: false },
      },
    ],
  });

  assert.equal(state.hasIssues, true);
  assert.equal(state.summary, "2 of 3 complete");
  assert.deepEqual(state.inaccessibleRepos, [
    {
      repo: "octo/inaccessible",
      accessible: false,
      error: "Resource not accessible by integration",
      codeReviews: { claude: false, codex: false, gemini: false },
    },
  ]);
  assert.equal(state.dismissalKey, "access:octo/inaccessible:resource not accessible by integration|workflow");
});

test("getOnboardingPanelState keeps only workflow pending when repo access works but no review workflow exists", () => {
  const state = getOnboardingPanelState({
    githubConnected: true,
    githubUser: "octo",
    repos: [
      {
        repo: "octo/accessible",
        accessible: true,
        codeReviews: { claude: false, codex: false, gemini: false },
      },
    ],
  });

  assert.equal(state.hasIssues, true);
  assert.equal(state.summary, "2 of 3 complete");
  assert.deepEqual(state.pendingSteps.map((step) => step.id), ["workflow"]);
  assert.deepEqual(state.reposMissingReview.map((repo) => repo.repo), ["octo/accessible"]);
});

test("getOnboardingPanelState hides the panel when GitHub, repo access, and a review workflow are ready", () => {
  const state = getOnboardingPanelState({
    githubConnected: true,
    githubUser: "octo",
    repos: [
      {
        repo: "octo/accessible",
        accessible: true,
        codeReviews: { claude: false, codex: true, gemini: false },
      },
    ],
  });

  assert.equal(state.hasIssues, false);
  assert.equal(state.summary, "0 access issues");
  assert.deepEqual(state.inaccessibleRepos, []);
  assert.equal(state.completedCount, 3);
  assert.deepEqual(state.reposWithReview.map((repo) => repo.repo), ["octo/accessible"]);
  assert.equal(state.dismissalKey, "complete");
});

test("getOnboardingPanelState treats GitHub rate-limit gate as transient, not a setup blocker", () => {
  const state = getOnboardingPanelState({
    githubConnected: false,
    githubError: "GitHub rate limit gate active until 2026-05-14T23:19:11.000Z",
    repos: [],
  });

  assert.equal(state.steps[0]?.id, "github");
  assert.equal(state.steps[0]?.complete, true);
  assert.equal(state.completedCount, 3);
  assert.equal(state.summary, "0 access issues");
  assert.equal(state.hasIssues, false);
  assert.deepEqual(state.pendingSteps, []);
});

test("getOnboardingPanelState keeps repo/workflow steps complete when rate-limit gate blocks repo checks", () => {
  const state = getOnboardingPanelState({
    githubConnected: false,
    githubError: "GitHub rate limit gate active until 2026-05-14T23:19:11.000Z",
    repos: [
      {
        repo: "octo/app",
        accessible: false,
        error: "GitHub rate limit gate active until 2026-05-14T23:19:11.000Z",
        codeReviews: { claude: false, codex: false, gemini: false },
      },
    ],
  });

  assert.equal(state.completedCount, 3);
  assert.equal(state.summary, "0 access issues");
  assert.equal(state.hasIssues, false);
  assert.deepEqual(state.pendingSteps, []);
});
