import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { NewPR } from "@shared/schema";
import {
  createAppRuntime,
  deriveWorkPrMergeable,
  getCurrentIssueEvaluationForLabels,
  getIssueAutoWorkEligibility,
  issueWorkAttemptCountFromJobs,
  issueWorkPrFromLogs,
  mapMergedPullsToReleaseSummaries,
  pickWatcherColdStartDelayMs,
  planAutomaticIssueQueueActions,
  type PlanAutomaticIssueQueueInput,
} from "./appRuntime";
import { _resetRingBufferForTests, readRingBuffer } from "./logger";
import { MemStorage } from "./memoryStorage";

async function seedPR(storage: MemStorage, overrides: Partial<NewPR> = {}) {
  return storage.addPR({
    number: 42,
    title: "feat: add widget",
    repo: "acme/widgets",
    branch: "feat/widget",
    author: "alice",
    url: "https://github.com/acme/widgets/pull/42",
    status: "watching",
    feedbackItems: [],
    accepted: 0,
    rejected: 0,
    flagged: 0,
    testsPassed: null,
    lintPassed: null,
    lastChecked: null,
    ...overrides,
  });
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 250,
): Promise<void> {
  const startedAt = Date.now();

  while (true) {
    if (await condition()) {
      return;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Condition not met within ${timeoutMs}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("runtime lists active and archived PRs separately", async () => {
  const storage = new MemStorage();
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
  });

  await seedPR(storage, { number: 1, title: "active pr" });
  await seedPR(storage, {
    number: 2,
    title: "archived pr",
    status: "archived",
    url: "https://github.com/acme/widgets/pull/2",
  });

  const active = await runtime.listPRs("active");
  const archived = await runtime.listPRs("archived");

  assert.equal(active.length, 1);
  assert.equal(active[0]?.title, "active pr");
  assert.equal(archived.length, 1);
  assert.equal(archived[0]?.title, "archived pr");
});

test("runtime queueBabysit enqueues a babysit job using the configured agent", async () => {
  const storage = new MemStorage();
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
  });
  const pr = await seedPR(storage);

  const updated = await runtime.queueBabysit(pr.id);
  assert.equal(updated.id, pr.id);

  const jobs = await storage.listBackgroundJobs({
    kind: "babysit_pr",
    status: "queued",
  });

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.targetId, pr.id);
  assert.equal(jobs[0]?.payload.preferredAgent, "claude");
  assert.equal(jobs[0]?.payload.activityLabel, "Working PR #42");
  assert.equal(jobs[0]?.payload.activityDetail, "acme/widgets - feat: add widget");
  assert.equal(jobs[0]?.payload.activityTargetUrl, pr.url);
});

test("runtime queueBabysit uses repo agent override when configured", async () => {
  const storage = new MemStorage();
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
  });
  const pr = await seedPR(storage);
  await storage.updateRepoSettings(pr.repo, {
    codingAgentOverride: "codex",
  });

  await runtime.queueBabysit(pr.id);

  const jobs = await storage.listBackgroundJobs({
    kind: "babysit_pr",
    status: "queued",
  });
  assert.equal(jobs[0]?.payload.preferredAgent, "codex");
});

test("runtime exposes the latest PR agent run status", async () => {
  const storage = new MemStorage();
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
  });
  const pr = await seedPR(storage, { status: "processing" });

  await storage.upsertAgentRun({
    id: "run-1",
    prId: pr.id,
    preferredAgent: "claude",
    resolvedAgent: "claude",
    status: "running",
    phase: "run.agent-running",
    prompt: null,
    initialHeadSha: null,
    metadata: null,
    lastError: null,
    createdAt: "2026-05-17T10:00:00.000Z",
    updatedAt: "2026-05-17T10:01:00.000Z",
  });
  await storage.addLog(pr.id, "info", "Applying approved feedback", {
    runId: "run-1",
    phase: "run.agent-running",
  });

  const selected = await runtime.getPR(pr.id);

  assert.equal(selected?.currentRun?.status, "running");
  assert.equal(selected?.currentRun?.phase, "run.agent-running");
  assert.equal(selected?.currentRun?.agent, "claude");
  assert.equal(selected?.currentRun?.detail, "Applying approved feedback");
});

test("runtime setWatchEnabled updates the PR and emits a change event", async () => {
  const storage = new MemStorage();
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
  });
  const pr = await seedPR(storage);

  let changeEvents = 0;
  const unsubscribe = runtime.subscribe(() => {
    changeEvents += 1;
  });

  try {
    const updated = await runtime.setWatchEnabled(pr.id, false);
    assert.equal(updated.watchEnabled, false);
    assert.ok(changeEvents >= 1);

    const refreshed = await storage.getPR(pr.id);
    assert.equal(refreshed?.watchEnabled, false);
  } finally {
    unsubscribe();
  }
});

test("runtime setDrainMode logs enable and disable transitions", async () => {
  const storage = new MemStorage();
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
  });

  _resetRingBufferForTests();

  await runtime.setDrainMode({
    enabled: true,
    reason: "Agent health check failed for codex",
  });
  await runtime.setDrainMode({
    enabled: false,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, 30));

  const ring = readRingBuffer().join("\n");
  assert.match(ring, /Drain mode enabled/);
  assert.match(ring, /Agent health check failed for codex/);
  assert.match(ring, /Drain mode disabled/);
});

test("runtime clears stale CLI-missing drain mode once the agent command is available", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "fake-runtime-agent-bin-"));
  const fakeCodexPath = path.join(
    tempRoot,
    process.platform === "win32" ? "codex.cmd" : "codex",
  );
  const originalPath = process.env.PATH;

  try {
    await writeFile(
      fakeCodexPath,
      process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
      "utf8",
    );
    await chmod(fakeCodexPath, 0o755);
    process.env.PATH = [tempRoot, "/usr/bin", "/bin"].join(path.delimiter);

    const storage = new MemStorage();
    const runtime = createAppRuntime({
      storage,
      startBackgroundServices: false,
      startWatcher: false,
    });
    await storage.updateRuntimeState({
      drainMode: true,
      drainRequestedAt: "2026-05-17T13:57:29.224Z",
      drainReason: "Agent health check failed for codex: codex CLI is not installed",
    });

    const snapshot = await runtime.getRuntimeSnapshot();

    assert.equal(snapshot.drainMode, false);
    assert.equal(snapshot.drainReason, null);
    assert.equal(snapshot.drainRequestedAt, null);
  } finally {
    process.env.PATH = originalPath;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runtime askQuestion persists the question and enqueues a durable job", async () => {
  const storage = new MemStorage();
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
  });
  const pr = await seedPR(storage);

  const question = await runtime.askQuestion(pr.id, "What changed?");

  const questions = await storage.getQuestions(pr.id);
  assert.equal(questions.length, 1);
  assert.equal(questions[0]?.id, question.id);
  assert.equal(questions[0]?.status, "pending");

  const jobs = await storage.listBackgroundJobs({
    kind: "answer_pr_question",
    status: "queued",
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.targetId, question.id);
  assert.equal(jobs[0]?.payload.prId, pr.id);
  assert.equal(jobs[0]?.payload.activityLabel, "Answering question for PR #42");
  assert.equal(jobs[0]?.payload.activityDetail, "acme/widgets - feat: add widget");
  assert.equal(jobs[0]?.payload.activityTargetUrl, pr.url);
});

test("runtime updateConfig persists updates and exposes them through getConfig", async () => {
  const storage = new MemStorage();
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
  });

  const updated = await runtime.updateConfig({
    codingAgent: "codex",
    autoUpdateDocs: false,
    includeRepositoryLinksInGitHubComments: false,
    githubCommentAppName: "Review Bot",
    postGitHubProgressReplies: true,
  });

  assert.equal(updated.codingAgent, "codex");
  assert.equal(updated.autoUpdateDocs, false);
  assert.equal(updated.includeRepositoryLinksInGitHubComments, false);
  assert.equal(updated.githubCommentAppName, "Review Bot");
  assert.equal(updated.postGitHubProgressReplies, true);

  const config = await runtime.getConfig();
  assert.equal(config.codingAgent, "codex");
  assert.equal(config.autoUpdateDocs, false);
  assert.equal(config.includeRepositoryLinksInGitHubComments, false);
  assert.equal(config.githubCommentAppName, "Review Bot");
  assert.equal(config.postGitHubProgressReplies, true);
});

test("manual sync runs immediately even when global manual mode is on", async () => {
  const storage = new MemStorage();
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
  });

  await runtime.updateConfig({
    autoPrs: false,
    autoIssues: false,
  });

  await runtime.syncRepos();

  const jobs = await storage.listBackgroundJobs({
    kind: "sync_watched_repos",
  });
  assert.equal(jobs.length, 0);
});

test("manual sync can target only PRs or only issues", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ watchedRepos: ["owner/repo"] });

  let prSyncCalls = 0;
  let issueListCalls = 0;
  const fakeOctokit = {
    issues: {
      listForRepo: async () => {
        issueListCalls += 1;
        return { data: [], headers: {} };
      },
    },
  };
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
    babysitter: {
      syncAndBabysitTrackedRepos: async () => {
        prSyncCalls += 1;
      },
    } as never,
    buildOctokitFn: async () => fakeOctokit as never,
  });

  await runtime.syncRepos({ scope: "prs" });
  assert.equal(prSyncCalls, 1);
  assert.equal(issueListCalls, 0);

  await runtime.syncRepos({ scope: "issues" });
  assert.equal(prSyncCalls, 1);
  assert.ok(issueListCalls > 0);

  const issueOnlyCalls = issueListCalls;
  await runtime.syncRepos();
  assert.equal(prSyncCalls, 2);
  assert.ok(issueListCalls > issueOnlyCalls);
});

test("automatic watcher does not sync issues when issue automation is off", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({
    autoPrs: true,
    autoIssues: false,
    watchedRepos: ["owner/repo"],
  });
  const pr = await seedPR(storage, { repo: "owner/repo", watchEnabled: false });

  let issueListCalls = 0;
  const fakeOctokit = {
    issues: {
      listForRepo: async () => {
        issueListCalls += 1;
        return { data: [], headers: {} };
      },
    },
  };
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
    babysitter: { syncAndBabysitTrackedRepos: async () => {} } as never,
    buildOctokitFn: async () => fakeOctokit as never,
  });

  await runtime.setPRWatchEnabled(pr.id, true);
  await waitForCondition(async () => {
    const jobs = await storage.listBackgroundJobs({ kind: "sync_watched_repos" });
    return jobs.length === 1;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(issueListCalls, 0, "PR-only auto mode must not spend budget on issue sync");
});

test("automatic watcher runs issue sync without PR sync when PR automation is off", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({
    autoPrs: false,
    autoIssues: true,
    watchedRepos: ["owner/repo"],
  });
  const pr = await seedPR(storage, { repo: "owner/repo", watchEnabled: false });

  let issueListCalls = 0;
  const fakeOctokit = {
    issues: {
      listForRepo: async () => {
        issueListCalls += 1;
        return { data: [], headers: {} };
      },
    },
  };
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
    babysitter: {
      syncAndBabysitTrackedRepos: async () => {
        throw new Error("issue-only auto mode must not sync PRs");
      },
    } as never,
    buildOctokitFn: async () => fakeOctokit as never,
  });

  await runtime.setPRWatchEnabled(pr.id, true);
  await waitForCondition(() => issueListCalls > 0);

  const jobs = await storage.listBackgroundJobs({ kind: "sync_watched_repos" });
  assert.equal(jobs.length, 0, "issue-only auto mode must not queue PR sync");
});

test("automatic watcher does nothing when PR and issue automation are both off", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({
    autoPrs: false,
    autoIssues: false,
    watchedRepos: ["owner/repo"],
  });
  const pr = await seedPR(storage, { repo: "owner/repo", watchEnabled: false });

  let issueListCalls = 0;
  const fakeOctokit = {
    issues: {
      listForRepo: async () => {
        issueListCalls += 1;
        return { data: [], headers: {} };
      },
    },
  };
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
    babysitter: {
      syncAndBabysitTrackedRepos: async () => {
        throw new Error("disabled auto mode must not sync PRs");
      },
    } as never,
    buildOctokitFn: async () => fakeOctokit as never,
  });

  await runtime.setPRWatchEnabled(pr.id, true);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(issueListCalls, 0);
  const jobs = await storage.listBackgroundJobs({ kind: "sync_watched_repos" });
  assert.equal(jobs.length, 0);
});

test("automatic watcher can run PR and issue automation together", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({
    autoPrs: true,
    autoIssues: true,
    watchedRepos: ["owner/repo"],
  });
  const pr = await seedPR(storage, { repo: "owner/repo", watchEnabled: false });

  let issueListCalls = 0;
  const fakeOctokit = {
    issues: {
      listForRepo: async () => {
        issueListCalls += 1;
        return { data: [], headers: {} };
      },
    },
  };
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
    babysitter: { syncAndBabysitTrackedRepos: async () => {} } as never,
    buildOctokitFn: async () => fakeOctokit as never,
  });

  await runtime.setPRWatchEnabled(pr.id, true);
  await waitForCondition(async () => {
    const jobs = await storage.listBackgroundJobs({ kind: "sync_watched_repos" });
    return jobs.length === 1 && issueListCalls > 0;
  });
});

test("runtime release adapter skips merged PRs without a merge commit SHA", () => {
  const summaries = mapMergedPullsToReleaseSummaries([
    {
      number: 12,
      title: "Missing merge SHA",
      url: "https://github.com/acme/widgets/pull/12",
      author: "alice",
      repo: "acme/widgets",
      mergedAt: "2026-04-26T12:00:00.000Z",
      mergeCommitSha: null,
    },
    {
      number: 13,
      title: "Real release target",
      url: "https://github.com/acme/widgets/pull/13",
      author: "bob",
      repo: "acme/widgets",
      mergedAt: "2026-04-26T13:00:00.000Z",
      mergeCommitSha: "  abc123  ",
    },
  ]);

  assert.deepEqual(summaries, [
    {
      number: 13,
      title: "Real release target",
      url: "https://github.com/acme/widgets/pull/13",
      author: "bob",
      repo: "acme/widgets",
      mergedAt: "2026-04-26T13:00:00.000Z",
      mergeSha: "abc123",
    },
  ]);
});

test("issueWorkPrFromLogs backfills legacy PR links from the completion log message", () => {
  const readyPr = issueWorkPrFromLogs([
    {
      id: "log-1",
      prId: "gsd-build/gsd-2#5830",
      runId: null,
      timestamp: "2026-05-11T20:43:00.000Z",
      level: "info",
      phase: null,
      message: "Opened PR #5832 for issue #5830",
      metadata: null,
    },
  ], "gsd-build/gsd-2");

  assert.deepEqual(readyPr, {
    workPrNumber: 5832,
    workPrUrl: "https://github.com/gsd-build/gsd-2/pull/5832",
  });
});

test("issueWorkAttemptCountFromJobs counts repeated jobs and retries as attempts", () => {
  assert.equal(issueWorkAttemptCountFromJobs([]), 0);
  assert.equal(issueWorkAttemptCountFromJobs([
    { attemptCount: 0 },
    { attemptCount: 0 },
    { attemptCount: 0 },
  ]), 3);
  assert.equal(issueWorkAttemptCountFromJobs([
    { attemptCount: 2 },
    { attemptCount: 0 },
  ]), 4);
});

test("getIssueAutoWorkEligibility requires a ready label, app approval, and no blocking labels", () => {
  assert.deepEqual(getIssueAutoWorkEligibility({ labels: ["ready-for-agent"] }, {
    status: "approved",
    summary: "Ready",
    safetyFlags: [],
  }), {
    autoWorkEligible: true,
    autoWorkBlockedReason: null,
  });

  assert.deepEqual(getIssueAutoWorkEligibility({ labels: ["ready-for-agent"] }), {
    autoWorkEligible: false,
    autoWorkBlockedReason: "missing app evaluation",
  });

  assert.deepEqual(getIssueAutoWorkEligibility({ labels: ["ready-for-agent", "blocked"] }, {
    status: "approved",
    summary: "Ready",
    safetyFlags: [],
  }), {
    autoWorkEligible: false,
    autoWorkBlockedReason: "blocked by label: blocked",
  });

  assert.deepEqual(getIssueAutoWorkEligibility({ labels: ["needs-triage"] }), {
    autoWorkEligible: false,
    autoWorkBlockedReason: "missing ready-for-agent label",
  });
});

test("getCurrentIssueEvaluationForLabels ignores stale blocked-label evaluations", () => {
  assert.equal(getCurrentIssueEvaluationForLabels({ labels: ["needs-triage"] }, {
    status: "blocked",
    summary: "Blocked from automatic work by label: needs-maintainer-review.",
    safetyFlags: ["blocked-label:needs-maintainer-review"],
  }), null);

  assert.deepEqual(getCurrentIssueEvaluationForLabels({ labels: ["needs-maintainer-review"] }, {
    status: "blocked",
    summary: "Blocked from automatic work by label: needs-maintainer-review.",
    safetyFlags: ["blocked-label:needs-maintainer-review"],
  }), {
    status: "blocked",
    summary: "Blocked from automatic work by label: needs-maintainer-review.",
    safetyFlags: ["blocked-label:needs-maintainer-review"],
  });

  assert.deepEqual(getCurrentIssueEvaluationForLabels({ labels: ["needs-triage"] }, {
    status: "blocked",
    summary: "Blocked from automatic work because the issue asks for risky secret, network, or destructive behavior.",
    safetyFlags: ["blocked-label:needs-maintainer-review", "secret-access"],
  }), {
    status: "blocked",
    summary: "Blocked from automatic work because the issue asks for risky secret, network, or destructive behavior.",
    safetyFlags: ["blocked-label:needs-maintainer-review", "secret-access"],
  });
});

test("deriveWorkPrMergeable only treats a clean PR as ready to merge", () => {
  // "clean" is the only state where conflicts, required checks, and required
  // reviews are all satisfied — so it is the only one that counts as ready.
  assert.equal(deriveWorkPrMergeable("clean"), true);

  // A PR with red or pending CI must never read as ready to merge. "blocked"
  // = a required check is failing/pending; "unstable" = a non-required check
  // is failing; "dirty" = merge conflicts; "behind" = base moved on.
  assert.equal(deriveWorkPrMergeable("blocked"), false);
  assert.equal(deriveWorkPrMergeable("unstable"), false);
  assert.equal(deriveWorkPrMergeable("dirty"), false);
  assert.equal(deriveWorkPrMergeable("behind"), false);

  // GitHub computes the state lazily; until it is known, stay undecided
  // (null) rather than asserting the PR is not ready.
  assert.equal(deriveWorkPrMergeable("unknown"), null);
  assert.equal(deriveWorkPrMergeable(null), null);
});

// ── planAutomaticIssueQueueActions ───────────────────────────────────────────
//
// The planner is the throttle. It decides which evaluations and work jobs to enqueue on each
// watcher tick, capped by `maxConcurrent*` config. Tests here encode the *intent* (respect the
// caps, never starve a repo, don't double-queue) so they fail when business rules drift, not
// just when implementation churns.

function makePlanIssue(
  overrides: Partial<PlanAutomaticIssueQueueInput["issues"][number]> & {
    repo: string;
    number: number;
  },
): PlanAutomaticIssueQueueInput["issues"][number] {
  return {
    id: `${overrides.repo}#${overrides.number}`,
    repo: overrides.repo,
    number: overrides.number,
    author: overrides.author ?? "alice",
    workStatus: overrides.workStatus ?? "idle",
    workPrUrl: overrides.workPrUrl ?? null,
    autoWorkEligible: overrides.autoWorkEligible ?? false,
    evaluationStatus: overrides.evaluationStatus ?? null,
    updatedAt: overrides.updatedAt ?? "2026-05-01T00:00:00.000Z",
  };
}

test("planAutomaticIssueQueueActions enqueues no jobs when no repo has auto-evaluate or auto-work on", () => {
  const plan = planAutomaticIssueQueueActions({
    repoSettings: [{ repo: "acme/widgets", issueAutoEvaluate: false, issueAutoWork: false }],
    issues: [makePlanIssue({ repo: "acme/widgets", number: 1 })],
    activeEvaluationTargets: new Set(),
    activeWorkCount: 0,
    maxConcurrentIssueEvaluations: 2,
    maxConcurrentIssueWork: 1,
  });
  assert.deepEqual(plan, { evaluations: [], work: [] });
});

test("planAutomaticIssueQueueActions sweeps every unevaluated issue up to the evaluation cap", () => {
  // Goal: a repo with auto-evaluate on and a backlog of unevaluated issues should not be
  // drained one-per-tick — the planner should enqueue evaluations up to the global cap.
  const issues = Array.from({ length: 10 }, (_, i) =>
    makePlanIssue({ repo: "acme/widgets", number: i + 1 }),
  );
  const plan = planAutomaticIssueQueueActions({
    repoSettings: [{ repo: "acme/widgets", issueAutoEvaluate: true, issueAutoWork: false }],
    issues,
    activeEvaluationTargets: new Set(),
    activeWorkCount: 0,
    maxConcurrentIssueEvaluations: 3,
    maxConcurrentIssueWork: 1,
  });
  assert.equal(plan.evaluations.length, 3, "must respect the evaluation cap exactly");
  assert.equal(plan.work.length, 0);
});

test("planAutomaticIssueQueueActions prioritizes configured issue authors", () => {
  // Goal: when support-critical users report issues, their work should get the scarce
  // auto-work slot before newer reports from the regular queue.
  const plan = planAutomaticIssueQueueActions({
    repoSettings: [{ repo: "acme/widgets", issueAutoEvaluate: true, issueAutoWork: true }],
    issues: [
      makePlanIssue({
        repo: "acme/widgets",
        number: 1,
        author: "regular-user",
        autoWorkEligible: true,
        updatedAt: "2026-05-02T00:00:00.000Z",
      }),
      makePlanIssue({
        repo: "acme/widgets",
        number: 2,
        author: "Priority-User",
        autoWorkEligible: true,
        updatedAt: "2026-05-01T00:00:00.000Z",
      }),
    ],
    activeEvaluationTargets: new Set(),
    activeWorkCount: 0,
    maxConcurrentIssueEvaluations: 2,
    maxConcurrentIssueWork: 1,
    priorityIssueAuthors: ["priority-user"],
  });

  assert.deepEqual(plan.work.map((action) => action.number), [2]);
});

test("planAutomaticIssueQueueActions counts already-queued evaluations against the cap", () => {
  // Goal: in-flight jobs aren't free — the budget is global (queued + leased + about-to-queue).
  const issues = Array.from({ length: 5 }, (_, i) =>
    makePlanIssue({ repo: "acme/widgets", number: i + 1 }),
  );
  const plan = planAutomaticIssueQueueActions({
    repoSettings: [{ repo: "acme/widgets", issueAutoEvaluate: true, issueAutoWork: false }],
    issues,
    activeEvaluationTargets: new Set(["acme/widgets#1", "acme/widgets#2"]),
    activeWorkCount: 0,
    maxConcurrentIssueEvaluations: 2,
    maxConcurrentIssueWork: 1,
  });
  assert.equal(plan.evaluations.length, 0, "cap already filled by in-flight jobs");
});

test("planAutomaticIssueQueueActions does not auto-queue work when auto-work is off", () => {
  // Goal: auto-evaluate without auto-work should classify issues only — never run the agent.
  // This separation is the whole point of having two toggles.
  const plan = planAutomaticIssueQueueActions({
    repoSettings: [{ repo: "acme/widgets", issueAutoEvaluate: true, issueAutoWork: false }],
    issues: [
      makePlanIssue({
        repo: "acme/widgets",
        number: 1,
        evaluationStatus: "approved",
        autoWorkEligible: true,
      }),
    ],
    activeEvaluationTargets: new Set(),
    activeWorkCount: 0,
    maxConcurrentIssueEvaluations: 2,
    maxConcurrentIssueWork: 1,
  });
  assert.equal(plan.work.length, 0, "auto-work toggle gates work even on approved issues");
});

test("planAutomaticIssueQueueActions queues work for approved+eligible issues when auto-work is on", () => {
  const plan = planAutomaticIssueQueueActions({
    repoSettings: [{ repo: "acme/widgets", issueAutoEvaluate: true, issueAutoWork: true }],
    issues: [
      makePlanIssue({
        repo: "acme/widgets",
        number: 1,
        evaluationStatus: "approved",
        autoWorkEligible: true,
      }),
    ],
    activeEvaluationTargets: new Set(),
    activeWorkCount: 0,
    maxConcurrentIssueEvaluations: 2,
    maxConcurrentIssueWork: 1,
  });
  assert.deepEqual(plan.work, [{ repo: "acme/widgets", number: 1, id: "acme/widgets#1" }]);
});

test("planAutomaticIssueQueueActions respects per-repo single-flight on work", () => {
  // Goal: don't pile multiple work jobs onto one repo even if budget allows — the agent
  // runs one at a time per repo, so queueing more just creates lag.
  const plan = planAutomaticIssueQueueActions({
    repoSettings: [{ repo: "acme/widgets", issueAutoEvaluate: true, issueAutoWork: true }],
    issues: [
      makePlanIssue({
        repo: "acme/widgets",
        number: 1,
        workStatus: "in_progress",
      }),
      makePlanIssue({
        repo: "acme/widgets",
        number: 2,
        evaluationStatus: "approved",
        autoWorkEligible: true,
      }),
    ],
    activeEvaluationTargets: new Set(),
    activeWorkCount: 0,
    maxConcurrentIssueEvaluations: 2,
    maxConcurrentIssueWork: 5,
  });
  assert.equal(plan.work.length, 0, "skip repo that already has a work job in flight");
});

test("planAutomaticIssueQueueActions interleaves evaluations across repos fairly", () => {
  // Goal: one repo with a huge backlog must not starve sibling repos. Round-robin is the
  // simplest fairness contract — issue N for repo A, then issue N for repo B, etc.
  const issues = [
    makePlanIssue({ repo: "acme/widgets", number: 1 }),
    makePlanIssue({ repo: "acme/widgets", number: 2 }),
    makePlanIssue({ repo: "acme/widgets", number: 3 }),
    makePlanIssue({ repo: "globex/gizmo", number: 100 }),
  ];
  const plan = planAutomaticIssueQueueActions({
    repoSettings: [
      { repo: "acme/widgets", issueAutoEvaluate: true, issueAutoWork: false },
      { repo: "globex/gizmo", issueAutoEvaluate: true, issueAutoWork: false },
    ],
    issues,
    activeEvaluationTargets: new Set(),
    activeWorkCount: 0,
    maxConcurrentIssueEvaluations: 2,
    maxConcurrentIssueWork: 1,
  });
  const repos = plan.evaluations.map((action) => action.repo);
  assert.equal(plan.evaluations.length, 2);
  assert.deepEqual(repos.sort(), ["acme/widgets", "globex/gizmo"], "both repos get one slot");
});

test("planAutomaticIssueQueueActions skips evaluations already queued for the same target", () => {
  // Goal: don't double-queue. The dedupe key in the background_jobs table would reject it,
  // but the planner should avoid even trying — cleaner logs, deterministic behavior.
  const plan = planAutomaticIssueQueueActions({
    repoSettings: [{ repo: "acme/widgets", issueAutoEvaluate: true, issueAutoWork: false }],
    issues: [makePlanIssue({ repo: "acme/widgets", number: 1 })],
    activeEvaluationTargets: new Set(["acme/widgets#1"]),
    activeWorkCount: 0,
    maxConcurrentIssueEvaluations: 2,
    maxConcurrentIssueWork: 1,
  });
  assert.equal(plan.evaluations.length, 0);
});

test("planAutomaticIssueQueueActions counts active work jobs against the work cap", () => {
  // Goal: same global-budget semantics on work as on evaluations.
  const plan = planAutomaticIssueQueueActions({
    repoSettings: [
      { repo: "acme/widgets", issueAutoEvaluate: true, issueAutoWork: true },
      { repo: "globex/gizmo", issueAutoEvaluate: true, issueAutoWork: true },
    ],
    issues: [
      makePlanIssue({
        repo: "globex/gizmo",
        number: 1,
        evaluationStatus: "approved",
        autoWorkEligible: true,
      }),
    ],
    activeEvaluationTargets: new Set(),
    activeWorkCount: 1,
    maxConcurrentIssueEvaluations: 2,
    maxConcurrentIssueWork: 1,
  });
  assert.equal(plan.work.length, 0, "work cap already saturated");
});

test("syncRepos skips the issue sweep for a repo whose issue list responds 304", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ watchedRepos: ["owner/repo"] });
  await storage.setGithubEtag("issues:open:owner/repo", 'W/"stale"');

  let listForRepoCalls = 0;
  const fakeOctokit = {
    issues: {
      listForRepo: async () => {
        listForRepoCalls += 1;
        const error = new Error("Not modified") as Error & { status: number };
        error.status = 304;
        throw error;
      },
    },
  };

  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
    babysitter: { syncAndBabysitTrackedRepos: async () => {} } as never,
    buildOctokitFn: async () => fakeOctokit as never,
  });

  await runtime.syncRepos();

  assert.equal(listForRepoCalls, 1, "only the conditional probe should reach GitHub");
  const synced = await storage.listSyncedIssues({ repos: ["owner/repo"], limit: 50, offset: 0 });
  assert.equal(synced.items.length, 0, "a 304 must not sync any issues");
});

test("syncRepos syncs issues and persists the new etag when the issue list changed", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ watchedRepos: ["owner/repo"] });

  const issuePayload = {
    number: 7,
    title: "Issue 7",
    body: "needs attention",
    html_url: "https://github.com/owner/repo/issues/7",
    user: { login: "alice" },
    labels: [],
    assignees: [],
    comments: 0,
    created_at: "2026-05-03T17:00:00.000Z",
    updated_at: "2026-05-03T18:00:00.000Z",
  };
  const fakeOctokit = {
    issues: {
      listForRepo: async () => ({
        data: [issuePayload],
        headers: { etag: 'W/"issues-v1"' },
      }),
    },
  };

  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
    babysitter: { syncAndBabysitTrackedRepos: async () => {} } as never,
    buildOctokitFn: async () => fakeOctokit as never,
  });

  await runtime.syncRepos();

  const synced = await storage.listSyncedIssues({ repos: ["owner/repo"], limit: 50, offset: 0 });
  assert.equal(synced.items.length, 1);
  assert.equal(synced.items[0]?.number, 7);
  assert.equal(
    await storage.getGithubEtag("issues:open:owner/repo"),
    'W/"issues-v1"',
    "a successful sweep should persist the fresh etag for next tick",
  );
});

test("listIssues stays cached-only when issue automation is off", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoIssues: false, watchedRepos: ["owner/repo"] });
  await storage.upsertSyncedIssues("owner/repo", [{
    number: 7,
    title: "Cached issue",
    body: "cached body",
    bodyHtml: null,
    url: "https://github.com/owner/repo/issues/7",
    repoFullName: "owner/repo",
    repoCloneUrl: "https://github.com/owner/repo.git",
    author: "alice",
    labels: ["needs-triage"],
    assignees: [],
    comments: 0,
    createdAt: "2026-05-03T17:00:00.000Z",
    updatedAt: "2026-05-03T18:00:00.000Z",
  }], "2026-05-03T18:00:00.000Z");

  let buildOctokitCalls = 0;
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
    buildOctokitFn: async () => {
      buildOctokitCalls += 1;
      return {
        paginate: async () => {
          throw new Error("issue timeline should not be fetched when issue automation is off");
        },
      } as never;
    },
  });

  const page = await runtime.listIssues({ limit: 50, offset: 0 });

  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.title, "Cached issue");
  assert.equal(page.items[0]?.externalWorkPrNumber, null);
  assert.equal(buildOctokitCalls, 0, "disabled issue automation must not enrich list rows through GitHub");
});

test("getIssue stays cached-only when issue automation is off", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoIssues: false, watchedRepos: ["owner/repo"] });
  await storage.upsertSyncedIssues("owner/repo", [{
    number: 7,
    title: "Cached issue",
    body: "cached body",
    bodyHtml: null,
    url: "https://github.com/owner/repo/issues/7",
    repoFullName: "owner/repo",
    repoCloneUrl: "https://github.com/owner/repo.git",
    author: "alice",
    labels: ["needs-triage"],
    assignees: [],
    comments: 0,
    createdAt: "2026-05-03T17:00:00.000Z",
    updatedAt: "2026-05-03T18:00:00.000Z",
  }], "2026-05-03T18:00:00.000Z");

  let buildOctokitCalls = 0;
  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
    buildOctokitFn: async () => {
      buildOctokitCalls += 1;
      throw new Error("issue detail should not fetch GitHub when issue automation is off");
    },
  });

  const issue = await runtime.getIssue("owner/repo", 7);

  assert.equal(issue.title, "Cached issue");
  assert.equal(issue.externalWorkPrNumber, null);
  assert.equal(buildOctokitCalls, 0, "disabled issue automation must keep issue detail cached-only");
});

test("syncIssue refreshes worked issue metadata from GitHub", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ autoIssues: false, watchedRepos: ["owner/repo"] });
  await storage.upsertSyncedIssues("owner/repo", [{
    number: 7,
    title: "Old title",
    body: "old body",
    bodyHtml: null,
    url: "https://github.com/owner/repo/issues/7",
    repoFullName: "owner/repo",
    repoCloneUrl: "https://github.com/owner/repo.git",
    author: "alice",
    labels: ["needs-maintainer-review"],
    assignees: [],
    comments: 0,
    createdAt: "2026-05-03T17:00:00.000Z",
    updatedAt: "2026-05-03T18:00:00.000Z",
  }], "2026-05-03T18:00:00.000Z");
  await storage.markSyncedIssueWorked("owner/repo", 7);
  await storage.upsertIssueEvaluation({
    targetId: "owner/repo#7",
    repo: "owner/repo",
    issueNumber: 7,
    status: "blocked",
    confidence: 0.95,
    summary: "Blocked from automatic work by label: needs-maintainer-review.",
    safetyFlags: ["blocked-label:needs-maintainer-review"],
    recommendedLabels: ["needs-maintainer-review", "blocked"],
    markerCommentId: null,
  });

  let issueFetches = 0;
  const fakeOctokit = {
    issues: {
      get: async () => {
        issueFetches += 1;
        return {
          data: {
            number: 7,
            title: "Fresh title",
            body: "fresh body",
            html_url: "https://github.com/owner/repo/issues/7",
            user: { login: "alice" },
            labels: [{ name: "needs-triage" }],
            assignees: [],
            comments: 2,
            created_at: "2026-05-03T17:00:00.000Z",
            updated_at: "2026-05-16T18:00:00.000Z",
          },
        };
      },
    },
    paginate: async () => [],
  };

  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
    babysitter: { syncAndBabysitTrackedRepos: async () => {} } as never,
    buildOctokitFn: async () => fakeOctokit as never,
  });

  const synced = await runtime.syncIssue("owner/repo", 7);

  assert.equal(issueFetches, 1, "manual issue sync must fetch GitHub even when the issue is already worked");
  assert.equal(synced.isWorked, true);
  assert.equal(synced.title, "Fresh title");
  assert.deepEqual(synced.labels, ["needs-triage"]);
  assert.equal(synced.evaluationStatus, null, "stale blocked-label evaluation should not survive label refresh");
  assert.equal(synced.autoWorkBlockedReason, "missing ready-for-agent label");

  const stored = await storage.getSyncedIssue("owner/repo", 7);
  assert.equal(stored?.isWorked, true, "refresh must preserve the worked marker");
  assert.equal(stored?.payload.title, "Fresh title");
});

test("runtime exposes queued issue work as current run status", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ watchedRepos: ["owner/repo"] });
  await storage.enqueueBackgroundJob({
    kind: "work_issue",
    targetId: "owner/repo#7",
    dedupeKey: "work_issue:owner/repo#7",
  });
  await storage.addLog("owner/repo#7", "info", "Queued manual issue work", {
    phase: "issue.queued",
    metadata: { stage: "queued" },
  });

  const fakeOctokit = {
    issues: {
      get: async () => ({
        data: {
          number: 7,
          title: "Fix issue work",
          body: "body",
          html_url: "https://github.com/owner/repo/issues/7",
          user: { login: "alice" },
          labels: [],
          assignees: [],
          comments: 0,
          created_at: "2026-05-03T17:00:00.000Z",
          updated_at: "2026-05-16T18:00:00.000Z",
        },
      }),
    },
    paginate: async () => [],
  };

  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
    buildOctokitFn: async () => fakeOctokit as never,
  });

  const selected = await runtime.getIssue("owner/repo", 7);

  assert.equal(selected.currentRun?.status, "queued");
  assert.equal(selected.currentRun?.phase, "issue.queued");
  assert.equal(selected.currentRun?.detail, "Queued manual issue work");
});

test("pickWatcherColdStartDelayMs stays within the 15-45s cold-start window", () => {
  assert.equal(pickWatcherColdStartDelayMs(() => 0), 15_000);
  assert.equal(pickWatcherColdStartDelayMs(() => 0.5), 30_000);
  assert.equal(pickWatcherColdStartDelayMs(() => 0.999999999), 45_000);
  for (let i = 0; i < 200; i += 1) {
    const delay = pickWatcherColdStartDelayMs();
    assert.ok(delay >= 15_000 && delay <= 45_000, `delay ${delay} out of range`);
  }
});

test("start() defers the first watcher tick instead of firing it during start", async () => {
  let watcherRuns = 0;
  const runtime = createAppRuntime({
    storage: new MemStorage(),
    startBackgroundServices: false,
    startWatcher: true,
    babysitter: { resumeInterruptedRuns: async () => {} } as never,
    watcherScheduler: { run: async () => { watcherRuns += 1; } } as never,
  });

  await runtime.start();

  assert.equal(watcherRuns, 0, "the first watcher tick must be deferred, not run during start()");
  runtime.stop();
});

test("syncRepos persists an issue-sweep backoff when the probe fails", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ watchedRepos: ["owner/repo"] });

  const fakeOctokit = {
    issues: {
      listForRepo: async () => {
        const error = new Error("not found") as Error & { status: number };
        error.status = 404;
        throw error;
      },
    },
  };

  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
    babysitter: { syncAndBabysitTrackedRepos: async () => {} } as never,
    buildOctokitFn: async () => fakeOctokit as never,
  });

  await runtime.syncRepos();

  const state = (await storage.getRepoSyncStates("issues")).find((s) => s.repo === "owner/repo");
  assert.ok(state?.nextEligibleAt, "a failed issue sweep must persist a backoff");
  assert.ok(
    new Date(state!.nextEligibleAt!).getTime() > Date.now(),
    "the persisted backoff must be in the future",
  );
});

test("syncRepos skips an issue sweep for a repo whose persisted backoff is active", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ watchedRepos: ["owner/repo"] });
  await storage.upsertRepoSyncState("owner/repo", "issues", {
    nextEligibleAt: new Date(Date.now() + 600_000).toISOString(),
  });

  let listForRepoCalls = 0;
  const fakeOctokit = {
    issues: {
      listForRepo: async () => {
        listForRepoCalls += 1;
        return { data: [], headers: {} };
      },
    },
  };

  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
    babysitter: { syncAndBabysitTrackedRepos: async () => {} } as never,
    buildOctokitFn: async () => fakeOctokit as never,
  });

  await runtime.syncRepos();

  assert.equal(listForRepoCalls, 0, "a backed-off repo must not be probed or synced");
});

test("syncRepos defers the next sweep for a repo whose issue list is unchanged", async () => {
  const storage = new MemStorage();
  await storage.updateConfig({ watchedRepos: ["owner/repo"] });
  await storage.setGithubEtag("issues:open:owner/repo", 'W/"cached"');

  const fakeOctokit = {
    issues: {
      listForRepo: async () => {
        const error = new Error("Not modified") as Error & { status: number };
        error.status = 304;
        throw error;
      },
    },
  };

  const runtime = createAppRuntime({
    storage,
    startBackgroundServices: false,
    startWatcher: false,
    babysitter: { syncAndBabysitTrackedRepos: async () => {} } as never,
    buildOctokitFn: async () => fakeOctokit as never,
  });

  const before = Date.now();
  await runtime.syncRepos();

  const state = (await storage.getRepoSyncStates("issues")).find((s) => s.repo === "owner/repo");
  assert.ok(state?.lastSyncedAt, "a 304 still counts as a freshness check");
  assert.ok(state?.nextEligibleAt, "an unchanged repo must be deprioritized");
  const eligibleMs = new Date(state!.nextEligibleAt!).getTime();
  assert.ok(
    eligibleMs >= before + 9 * 60_000,
    `expected a ~10min cooldown, got ${(eligibleMs - before) / 60_000}min`,
  );
});
