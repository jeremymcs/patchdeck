import assert from "node:assert/strict";
import test from "node:test";
import type { NewPR } from "@shared/schema";
import {
  createAppRuntime,
  getIssueAutoWorkEligibility,
  issueWorkAttemptCountFromJobs,
  issueWorkPrFromLogs,
  mapMergedPullsToReleaseSummaries,
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
  assert.equal(jobs[0]?.payload.activityLabel, "Babysitting PR #42");
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

test("watcher tick does not enqueue sync jobs while global manual mode is on", async () => {
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
