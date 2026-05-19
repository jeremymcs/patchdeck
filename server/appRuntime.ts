import { EventEmitter } from "node:events";
import type {
  ActivityItem,
  ActivitySnapshot,
  BackgroundJob,
  Config,
  CurrentRunStatus,
  Issue,
  IssueListPage,
  IssueEvaluation,
  DeploymentHealingSession,
  HealingSession,
  LogEntry,
  OperatorWarning,
  PR,
  PRStage,
  PRSummary,
  PRQuestion,
  ReleaseRun,
  ReleaseSocialPost,
  RepoGitHubReleases,
  RuntimeState,
  SocialChangelog,
  StartReleaseSocialPostRequest,
  WatchedRepo,
} from "@shared/schema";
import { z } from "zod";
import { addPRSchema, askQuestionSchema } from "@shared/schema";
import type { IStorage } from "./storage";
import { getDefaultStorage } from "./storage";
import { PRBabysitter } from "./babysitter";
import { resolveRepoAgentRuntimeSettings, resolveRepoCodingAgent } from "./agentSettings";
import { commandExists, detectAgentUnavailability, type AgentUnavailabilityKind, type CodingAgent } from "./agentRunner";
import { applyEvaluationDecision, applyFlagDecision } from "./feedbackLifecycle";
import { applyManualFeedbackDecision } from "./manualFeedback";
import { childLogger } from "./logger";
import { renderGitHubMarkdown } from "./markdown";
import { generateReleaseSocialPost } from "./releaseSocialPostAgent";
import { randomUUID } from "node:crypto";

const log = childLogger("runtime");
const PRIORITY_ISSUE_JOB_PRIORITY = 50;
import { createBackgroundJobHandlers } from "./backgroundJobHandlers";
import { BackgroundJobDispatcher } from "./backgroundJobDispatcher";
import { BackgroundJobQueue, buildBackgroundJobDedupeKey } from "./backgroundJobQueue";
import { buildActivityPayload, readActivityPayload } from "./activityPayload";
import { createWatcherScheduler, type WatcherScheduler } from "./watcherScheduler";
import { startLogsRetentionJob, type RetentionJobHandle } from "./logsRetention";
import { getRateLimitState } from "./rateLimitState";
import { runWithRequestPriority } from "./requestPriority";
import { ReleaseManager } from "./releaseManager";
import type { ReleaseAgentPullSummary } from "./releaseAgent";
import { DeploymentHealingManager } from "./deploymentHealingManager";
import {
  buildOctokit,
  checkOnboardingStatus,
  createGitHubRelease,
  fetchIssueSummary,
  fetchPullSummary,
  formatRepoSlug,
  getDefaultBranchForRepo,
  getGitHubAuthStatus,
  getLatestSemverTagForRepo,
  GitHubIntegrationError,
  installCodeReviewWorkflow,
  listOpenIssuesForRepo,
  listOpenLinkedPullRequestsForIssue,
  listReleasesForRepo,
  listUnreleasedMergedPulls,
  type MergedPRSummary,
  parsePRUrl,
  parseRepoSlug,
  probeRepoIssuesChanged,
  addLabelsToIssue,
  removeLabelsFromIssue,
  resolveNextSemverTag,
} from "./github";

export class AppRuntimeError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "AppRuntimeError";
    this.statusCode = statusCode;
  }
}

const WATCHER_COLD_START_MIN_DELAY_MS = 15_000;
const WATCHER_COLD_START_MAX_DELAY_MS = 45_000;

/**
 * The first watcher tick after boot runs at a random offset so several
 * instances restarting together (a deploy) don't sync GitHub in lockstep,
 * and so boot isn't competing with the dashboard's initial data load.
 */
export function pickWatcherColdStartDelayMs(random: () => number = Math.random): number {
  const span = WATCHER_COLD_START_MAX_DELAY_MS - WATCHER_COLD_START_MIN_DELAY_MS;
  return WATCHER_COLD_START_MIN_DELAY_MS + Math.floor(random() * (span + 1));
}

export type AppRuntimeDependencies = {
  storage?: IStorage;
  backgroundJobQueue?: BackgroundJobQueue;
  backgroundJobDispatcher?: BackgroundJobDispatcher;
  releaseManager?: ReleaseManager;
  deploymentHealingManager?: DeploymentHealingManager;
  babysitter?: PRBabysitter;
  watcherScheduler?: WatcherScheduler;
  buildOctokitFn?: typeof buildOctokit;
  startBackgroundServices?: boolean;
  startWatcher?: boolean;
};

export type RuntimeSnapshot = RuntimeState & {
  activeRuns: number;
};

export type IssueCoverage = {
  repo: string;
  syncedOpenCount: number;
  githubOpenCount: number | null;
  lastSyncedAt: string | null;
};

export type DrainModeParams = {
  enabled: boolean;
  reason?: string;
  waitForIdle?: boolean;
  timeoutMs?: number;
};

export type RepoSyncScope = "all" | "prs" | "issues";

export type AppRuntime = {
  start(): Promise<void>;
  stop(): void;
  subscribe(listener: () => void): () => void;
  getRuntimeSnapshot(): Promise<RuntimeSnapshot>;
  getGitHubAuthStatus(): ReturnType<typeof getGitHubAuthStatus>;
  setDrainMode(input: DrainModeParams): Promise<RuntimeSnapshot & { drained?: boolean }>;
  listActivities(): Promise<ActivitySnapshot>;
  clearFailedActivities(): Promise<{ cleared: number }>;
  listRepos(): Promise<string[]>;
  listRepoSettings(): Promise<WatchedRepo[]>;
  addRepo(repoInput: string): Promise<{ repo: string }>;
  removeRepo(repoInput: string, mode?: "soft" | "hard"): Promise<{ ok: true; repo: string; mode: "soft" | "hard"; removedPrs: number }>;
  updateRepoSettings(repoInput: string, updates: Partial<Omit<WatchedRepo, "repo">>): Promise<WatchedRepo>;
  syncRepos(options?: { fullSweep?: boolean; scope?: RepoSyncScope }): Promise<{ ok: true }>;
  listIssueCoverage(): Promise<IssueCoverage[]>;
  createManualRelease(repoInput: string): Promise<ReleaseRun>;
  listPRs(view?: "active" | "archived"): Promise<PRSummary[]>;
  getPR(id: string): Promise<PR | null>;
  addPR(url: string): Promise<PR>;
  removePR(id: string): Promise<{ ok: true }>;
  setWatchEnabled(id: string, enabled: boolean): Promise<PR>;
  setPRWatchEnabled(id: string, enabled: boolean): Promise<PR>;
  fetchPRFeedback(id: string): Promise<PR>;
  triagePR(id: string): Promise<PR>;
  applyPR(id: string): Promise<PR>;
  queueBabysit(id: string): Promise<PR>;
  babysitPR(id: string): Promise<PR>;
  setFeedbackDecision(prId: string, feedbackId: string, decision: "accept" | "reject" | "flag"): Promise<PR>;
  retryFeedback(prId: string, feedbackId: string): Promise<PR>;
  listPRQuestions(prId: string): Promise<PRQuestion[]>;
  askQuestion(prId: string, question: string): Promise<PRQuestion>;
  listLogs(prId?: string): Promise<LogEntry[]>;
  getOnboardingStatus(): Promise<unknown>;
  installReviewWorkflow(repo: string, tool: "claude" | "codex"): Promise<unknown>;
  listHealingSessions(): Promise<HealingSession[]>;
  getHealingSession(id: string): Promise<HealingSession>;
  listDeploymentHealingSessions(repo?: string): Promise<DeploymentHealingSession[]>;
  getDeploymentHealingSession(id: string): Promise<DeploymentHealingSession>;
  getConfig(): Promise<Config>;
  updateConfig(updates: Partial<Config>): Promise<Config>;
  listSocialChangelogs(): Promise<SocialChangelog[]>;
  getSocialChangelog(id: string): Promise<SocialChangelog>;
  listReleaseRuns(): Promise<ReleaseRun[]>;
  getReleaseRun(id: string): Promise<ReleaseRun>;
  retryReleaseRun(id: string): Promise<ReleaseRun>;
  listGitHubReleases(): Promise<RepoGitHubReleases[]>;
  startReleaseSocialPost(request: StartReleaseSocialPostRequest): Promise<ReleaseSocialPost>;
  getReleaseSocialPost(jobId: string): Promise<ReleaseSocialPost>;
  listIssues(input?: { limit?: number; offset?: number }): Promise<IssueListPage>;
  getIssue(repo: string, number: number): Promise<Issue>;
  updateIssueLabels(repo: string, number: number, updates: { add?: string[]; remove?: string[] }): Promise<Issue>;
  evaluateIssue(repo: string, number: number): Promise<Issue>;
  verifyIssueWork(repo: string, number: number): Promise<Issue>;
  workIssue(repo: string, number: number): Promise<Issue>;
  clearIssueWorkFailures(repo: string, number: number): Promise<{ repo: string; number: number; id: string; cleared: number }>;
  syncIssue(repo: string, number: number): Promise<Issue>;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertFound<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new AppRuntimeError(404, message);
  }

  return value;
}

function fallbackJobLabel(job: BackgroundJob): string {
  switch (job.kind) {
    case "sync_watched_repos":
      return "Sync watched repositories";
    case "babysit_pr":
      return "Working PR";
    case "process_release_run":
      return "Processing release";
    case "answer_pr_question":
      return "Answering PR question";
    case "evaluate_issue":
      return "Evaluating issue";
    case "verify_issue":
      return "Verifying issue work";
    case "work_issue":
      return "Working issue";
    case "generate_social_changelog":
      return "Social changelog generation removed";
    case "heal_deployment":
      return "Healing deployment";
  }
}

type ActivityDescription = Pick<ActivityItem, "label" | "detail" | "targetUrl">;

type ActivityDescriptionContext = {
  prsById: Map<string, PR>;
  releaseRunsById: Map<string, ReleaseRun>;
  socialChangelogsById: Map<string, SocialChangelog>;
  deploymentHealingSessionsByTarget: Map<string, DeploymentHealingSession>;
};

function normalizeActivityDescription(description: ActivityDescription): ActivityDescription {
  return {
    ...description,
    label: description.label.replace(/^Babysitting PR\b/, "Working PR"),
    detail: description.detail?.replace("Refilling babysitter queue", "Refilling PR work queue") ?? null,
  };
}

function readJobStringPayload(job: BackgroundJob, key: string): string | null {
  const value = job.payload[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function formatIssueTargetId(repo: string, number: number): string {
  return `${repo}#${number}`;
}

const AUTO_WORK_READY_LABELS = new Set([
  "ready-for-agent",
  "ready-to-work",
  "agent-ready",
  "ready",
]);
const DEFAULT_ISSUES_PAGE_SIZE = 100;
const MAX_ISSUES_PAGE_SIZE = 100;
const MAX_AUTO_ISSUE_SWEEP_PAGES = 50;
// After a repo's sweep comes back unchanged, defer its next sweep by this long
// so quiet repos yield watcher slots and rate-limit budget to active ones. Any
// observed change clears the cooldown and the repo returns to every-tick.
const QUIET_REPO_COOLDOWN_MS = 10 * 60_000;
const AUTO_WORK_BLOCKED_LABELS = new Set([
  "blocked",
  "question",
  "needs-maintainer-review",
  "needs-maintainer-input",
  "needs-author-feedback",
  "needs-discussion",
  "wontfix",
  "duplicate",
  "invalid",
  "not-planned",
]);

function normalizeIssueLabel(label: string): string {
  return label.trim().toLowerCase();
}

function normalizeGitHubLogin(login: string): string {
  return login.trim().toLowerCase().replace(/^@/, "");
}

function isPriorityIssueAuthor(author: string | undefined, priorityIssueAuthors: readonly string[]): boolean {
  const normalizedAuthor = normalizeGitHubLogin(author ?? "");
  if (!normalizedAuthor) {
    return false;
  }

  return priorityIssueAuthors.some((entry) => normalizeGitHubLogin(entry) === normalizedAuthor);
}

function compareIssueQueuePriority(
  a: Pick<Issue, "author" | "updatedAt">,
  b: Pick<Issue, "author" | "updatedAt">,
  priorityIssueAuthors: readonly string[],
): number {
  const aPriority = isPriorityIssueAuthor(a.author, priorityIssueAuthors);
  const bPriority = isPriorityIssueAuthor(b.author, priorityIssueAuthors);
  if (aPriority !== bPriority) {
    return aPriority ? -1 : 1;
  }

  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

export type PlanAutomaticIssueQueueInput = {
  repoSettings: Pick<WatchedRepo, "repo" | "issueAutoEvaluate" | "issueAutoWork">[];
  issues: Pick<
    Issue,
    "id" | "repo" | "number" | "author" | "workStatus" | "workPrUrl" | "externalWorkPrUrl" | "autoWorkEligible" | "evaluationStatus" | "updatedAt"
  >[];
  activeEvaluationTargets: Set<string>;
  activeWorkCount: number;
  maxConcurrentIssueEvaluations: number;
  maxConcurrentIssueWork: number;
  priorityIssueAuthors?: string[];
};

export type PlanAutomaticIssueQueueActions = {
  evaluations: Array<{ repo: string; number: number; id: string }>;
  work: Array<{ repo: string; number: number; id: string }>;
};

export function planAutomaticIssueQueueActions(
  input: PlanAutomaticIssueQueueInput,
): PlanAutomaticIssueQueueActions {
  const autoWorkRepos = input.repoSettings.filter((repo) => repo.issueAutoWork).map((repo) => repo.repo);
  const autoEvaluateRepos = input.repoSettings
    .filter((repo) => repo.issueAutoEvaluate || repo.issueAutoWork)
    .map((repo) => repo.repo);

  const result: PlanAutomaticIssueQueueActions = { evaluations: [], work: [] };
  if (autoWorkRepos.length === 0 && autoEvaluateRepos.length === 0) {
    return result;
  }

  let evaluationBudget = Math.max(0, input.maxConcurrentIssueEvaluations - input.activeEvaluationTargets.size);
  let workBudget = Math.max(0, input.maxConcurrentIssueWork - input.activeWorkCount);
  const claimed = new Set<string>();
  const priorityIssueAuthors = input.priorityIssueAuthors ?? [];

  // Auto-work sweep first: budget is scarcer. Preserve per-repo single-flight semantics —
  // at most one work job per repo at a time, regardless of global budget.
  for (const repo of autoWorkRepos) {
    if (workBudget <= 0) break;
    const repoIssues = input.issues.filter((issue) => issue.repo === repo);
    if (repoIssues.some((issue) => issue.workStatus === "queued" || issue.workStatus === "in_progress")) {
      continue;
    }
    const candidate = repoIssues
      .filter((issue) => issue.workStatus === "idle" && !issue.workPrUrl && !issue.externalWorkPrUrl && issue.autoWorkEligible)
      .sort((a, b) => compareIssueQueuePriority(a, b, priorityIssueAuthors))[0];
    if (!candidate) continue;
    result.work.push({ repo: candidate.repo, number: candidate.number, id: candidate.id });
    claimed.add(candidate.id);
    workBudget -= 1;
  }

  // Auto-evaluate sweep: round-robin across repos so a single backlog doesn't starve others.
  if (evaluationBudget > 0 && autoEvaluateRepos.length > 0) {
    const repoQueues = new Map<string, typeof input.issues>();
    for (const repo of autoEvaluateRepos) {
      const pending = input.issues
        .filter((issue) =>
          issue.repo === repo
          && issue.workStatus === "idle"
          && !issue.workPrUrl
          && !issue.externalWorkPrUrl
          && !issue.evaluationStatus
          && !input.activeEvaluationTargets.has(issue.id)
          && !claimed.has(issue.id),
        )
        .sort((a, b) => compareIssueQueuePriority(a, b, priorityIssueAuthors));
      if (pending.length > 0) {
        repoQueues.set(repo, pending);
      }
    }

    while (evaluationBudget > 0 && repoQueues.size > 0) {
      for (const repo of Array.from(repoQueues.keys())) {
        if (evaluationBudget <= 0) break;
        const queue = repoQueues.get(repo);
        const candidate = queue?.shift();
        if (!candidate) {
          repoQueues.delete(repo);
          continue;
        }
        if (!queue || queue.length === 0) {
          repoQueues.delete(repo);
        }
        result.evaluations.push({ repo: candidate.repo, number: candidate.number, id: candidate.id });
        evaluationBudget -= 1;
      }
    }
  }

  return result;
}

export function getIssueAutoWorkEligibility(
  issue: Pick<Issue, "labels">,
  evaluation?: Pick<IssueEvaluation, "status" | "summary" | "safetyFlags"> | null,
): {
  autoWorkEligible: boolean;
  autoWorkBlockedReason: string | null;
} {
  const labels = issue.labels.map(normalizeIssueLabel).filter(Boolean);
  const blockedLabel = labels.find((label) => AUTO_WORK_BLOCKED_LABELS.has(label));
  if (blockedLabel) {
    return {
      autoWorkEligible: false,
      autoWorkBlockedReason: `blocked by label: ${blockedLabel}`,
    };
  }

  if (!labels.some((label) => AUTO_WORK_READY_LABELS.has(label))) {
    return {
      autoWorkEligible: false,
      autoWorkBlockedReason: "missing ready-for-agent label",
    };
  }

  if (!evaluation) {
    return {
      autoWorkEligible: false,
      autoWorkBlockedReason: "missing app evaluation",
    };
  }

  if (evaluation.status !== "approved") {
    return {
      autoWorkEligible: false,
      autoWorkBlockedReason: evaluation.summary || `evaluation ${evaluation.status.replace("_", " ")}`,
    };
  }

  if (evaluation.safetyFlags.length > 0) {
    return {
      autoWorkEligible: false,
      autoWorkBlockedReason: `safety flags: ${evaluation.safetyFlags.join(", ")}`,
    };
  }

  return {
    autoWorkEligible: true,
    autoWorkBlockedReason: null,
  };
}

export function getCurrentIssueEvaluationForLabels<T extends Pick<IssueEvaluation, "status" | "summary" | "safetyFlags">>(
  issue: Pick<Issue, "labels">,
  evaluation?: T | null,
): T | null {
  if (!evaluation) {
    return null;
  }

  const currentLabels = new Set(issue.labels.map(normalizeIssueLabel).filter(Boolean));
  const blockedLabelFlags = evaluation.safetyFlags
    .map((flag) => flag.trim().toLowerCase())
    .filter((flag) => flag.startsWith("blocked-label:"));

  if (
    evaluation.status === "blocked"
    && blockedLabelFlags.length > 0
    && evaluation.safetyFlags.length === blockedLabelFlags.length
    && blockedLabelFlags.some((flag) => !currentLabels.has(flag.slice("blocked-label:".length)))
  ) {
    return null;
  }

  return evaluation;
}

/**
 * Maps a GitHub pull request `mergeable_state` to the "ready to merge" flag.
 * GitHub's `mergeable` boolean only reflects merge conflicts — it stays true
 * even when CI is red. Only `mergeable_state === "clean"` guarantees no
 * conflicts AND that required checks and reviews pass, so that is the sole
 * state treated as ready. "unknown" (GitHub has not finished computing the
 * state) and a missing value resolve to null rather than false.
 */
export function deriveWorkPrMergeable(mergeableState: string | null): boolean | null {
  if (mergeableState === null || mergeableState === "unknown") {
    return null;
  }
  return mergeableState === "clean";
}

function getLatestBackgroundJob(jobs: BackgroundJob[]): BackgroundJob | undefined {
  return jobs
    .slice()
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
}

function issueWorkStatusFromJobs(jobs: BackgroundJob[]): { workStatus: Issue["workStatus"]; workJobId: string | null; lastError: string | null } {
  const latest = getLatestBackgroundJob(jobs);

  if (!latest) {
    return {
      workStatus: "idle",
      workJobId: null,
      lastError: null,
    };
  }

  if (latest.status === "leased") {
    return {
      workStatus: "in_progress",
      workJobId: latest.id,
      lastError: null,
    };
  }

  if (latest.status === "queued") {
    return {
      workStatus: "queued",
      workJobId: latest.id,
      lastError: null,
    };
  }

  if (latest.status === "failed") {
    return {
      workStatus: "failed",
      workJobId: latest.id,
      lastError: latest.lastError,
    };
  }

  return {
    workStatus: "idle",
    workJobId: null,
    lastError: null,
  };
}

export function issueWorkAttemptCountFromJobs(jobs: Array<Pick<BackgroundJob, "attemptCount">>): number {
  return jobs.reduce((total, job) => total + job.attemptCount + 1, 0);
}

function derivePrStageFromLogs(logs: LogEntry[]): PRStage {
  let stage: PRStage = "feedback_synced";
  for (const log of logs) {
    const phase = log.phase?.toLowerCase() ?? "";
    const message = log.message.toLowerCase();
    if (phase.includes("run.sync") || message.includes("syncing github comments/reviews")) {
      stage = "feedback_synced";
      continue;
    }
    if (phase.includes("evaluate.comments")) {
      stage = "triaged";
      continue;
    }
    if (phase.includes("run.agent-running") || phase.includes("run.replay") || phase.includes("run.started")) {
      stage = "applying";
      continue;
    }
    if (phase.includes("verify.ci") || message.includes("waiting for checks") || message.includes("ci")) {
      stage = "tests";
      continue;
    }
    if (phase.includes("run.done") || message.includes("resolved")) {
      stage = "done";
    }
  }
  return stage;
}

function formatRunPhaseLabel(phase: string | null | undefined): string {
  if (!phase) return "Run active";
  const normalized = phase.toLowerCase();
  if (normalized.includes("sync")) return "Syncing GitHub";
  if (normalized.includes("prompt")) return "Preparing work";
  if (normalized.includes("agent-running") || normalized.includes("working")) return "Automation running";
  if (normalized.includes("verify") || normalized.includes("ci")) return "Verifying";
  if (normalized.includes("opening_pr")) return "Opening PR";
  if (normalized.includes("completed") || normalized.includes("done")) return "Run finished";
  if (normalized.includes("failed")) return "Failed";
  return phase.replace(/^run\./, "").replace(/[-_.]/g, " ");
}

function latestRunLog(logs: LogEntry[], runId: string): LogEntry | undefined {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const logEntry = logs[index];
    if (logEntry?.runId === runId) {
      return logEntry;
    }
  }
  return undefined;
}

async function deriveCurrentPrRun(pr: PR | PRSummary, storage: IStorage, logs?: LogEntry[]): Promise<CurrentRunStatus | null> {
  const runs = await storage.listAgentRuns({ prId: pr.id });
  const latestRun = runs
    .slice()
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
  if (!latestRun) return null;

  const prLogs = logs ?? await storage.getLogs(pr.id);
  const detailLog = latestRunLog(prLogs, latestRun.id);
  return {
    id: latestRun.id,
    status: latestRun.status,
    phase: latestRun.phase,
    label: formatRunPhaseLabel(latestRun.phase),
    detail: detailLog?.message ?? latestRun.lastError,
    agent: latestRun.resolvedAgent ?? latestRun.preferredAgent,
    startedAt: latestRun.createdAt,
    updatedAt: latestRun.updatedAt,
    lastError: latestRun.lastError,
  };
}

async function attachDerivedPrStage<T extends PR | PRSummary>(pr: T, storage: IStorage): Promise<T> {
  const withCurrentRun = async (updates: Pick<PR, "prStage">): Promise<T> => ({
    ...pr,
    ...updates,
    currentRun: await deriveCurrentPrRun(pr, storage),
  });

  if (pr.status === "watching") {
    return withCurrentRun({ prStage: "feedback_synced" });
  }
  if (pr.status === "done" || pr.status === "archived") {
    return withCurrentRun({ prStage: "done" });
  }
  const logs = await storage.getLogs(pr.id);
  return {
    ...pr,
    prStage: derivePrStageFromLogs(logs),
    currentRun: await deriveCurrentPrRun(pr, storage, logs),
  };
}

function issueWorkStageFromLogs(
  logs: LogEntry[],
  fallback: Issue["workStatus"],
): NonNullable<Issue["workStage"]> {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const stage = logs[index]?.metadata?.stage;
    if (
      stage === "queued"
      || stage === "started"
      || stage === "working"
      || stage === "verifying"
      || stage === "opening_pr"
      || stage === "completed"
      || stage === "failed"
    ) {
      return stage;
    }
  }

  if (fallback === "queued") return "queued";
  if (fallback === "in_progress") return "working";
  if (fallback === "failed") return "failed";
  return "idle";
}

function currentRunStatusFromIssueJob(
  job: BackgroundJob | undefined,
  logs: LogEntry[],
  workStage: NonNullable<Issue["workStage"]>,
): CurrentRunStatus | null {
  if (!job) return null;

  const latestLog = logs[logs.length - 1];
  const phase = latestLog?.phase ?? workStage;
  return {
    id: job.id,
    status: job.status === "failed"
      ? "failed"
      : job.status === "completed"
        ? "completed"
        : job.status === "queued"
          ? "queued"
          : "running",
    phase,
    label: formatRunPhaseLabel(phase),
    detail: latestLog?.message ?? job.lastError,
    agent: null,
    startedAt: job.createdAt,
    updatedAt: job.completedAt ?? job.updatedAt,
    lastError: job.lastError,
  };
}

export function issueWorkPrFromLogs(
  logs: LogEntry[],
  repo: string,
): { workPrNumber: number; workPrUrl: string } | null {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const entry = logs[index];
    const metadata = entry?.metadata;
    if (!metadata) {
      const legacyMatch = entry?.message.match(/Opened PR #(\d+) for issue #(\d+)/);
      if (!legacyMatch) {
        continue;
      }

      const prNumber = Number(legacyMatch[1]);
      if (!Number.isFinite(prNumber)) {
        continue;
      }

      return {
        workPrNumber: prNumber,
        workPrUrl: `https://github.com/${repo}/pull/${prNumber}`,
      };
    }

    const prNumber = metadata.prNumber;
    const prUrl = metadata.prUrl;
    if (typeof prNumber === "number" && Number.isFinite(prNumber)) {
      if (typeof prUrl === "string" && prUrl.trim()) {
        return {
          workPrNumber: prNumber,
          workPrUrl: prUrl,
        };
      }

      return {
        workPrNumber: prNumber,
        workPrUrl: `https://github.com/${repo}/pull/${prNumber}`,
      };
    }
  }

  return null;
}

type AgentLabel = "Claude" | "Codex";

type AgentAvailabilityFailure = {
  agentLabel: AgentLabel;
  kind: AgentUnavailabilityKind;
  fixSteps: string[];
};

function parseAgentCliMissingDrainReason(reason: string | null): CodingAgent | null {
  const match = reason?.match(/^Agent health check failed for (codex|claude): \1 CLI is not installed$/i);
  return match ? match[1].toLowerCase() as CodingAgent : null;
}

function buildCliMissingFixSteps(agentLabel: AgentLabel, command: "claude" | "codex"): string[] {
  return [
    `Install the ${agentLabel === "Claude" ? "Claude Code" : "Codex"} CLI on this machine.`,
    `If ${agentLabel} is already installed, make sure patchdeck can find it on PATH. The app checks its process PATH, then \`$SHELL -lc "command -v ${command}"\`.`,
    "For nvm installs, add the active Node bin directory to a login-shell startup file such as ~/.zprofile; for example: export PATH=\"$HOME/.nvm/versions/node/<version>/bin:$PATH\".",
    `Verify with \`command -v ${command}\` and \`$SHELL -lc "command -v ${command}"\`.`,
    "Restart patchdeck after installing.",
    "Queue PR work again.",
  ];
}

const AGENT_FIX_STEPS: Record<AgentLabel, Record<AgentUnavailabilityKind, string[]>> = {
  Claude: {
    auth: [
      "Run `claude auth login` on this machine.",
      "Restart patchdeck if it was launched before you refreshed credentials.",
      "Queue PR work again.",
    ],
    cli_missing: buildCliMissingFixSteps("Claude", "claude"),
    unknown_agent: [
      "Open Settings and choose a supported coding agent.",
      "Restart patchdeck if the agent setting was changed outside the app.",
      "Queue PR work again.",
    ],
  },
  Codex: {
    auth: [
      "Run `codex login` on this machine.",
      "Check ownership and permissions for ~/.codex, especially ~/.codex/sessions, so patchdeck can access Codex session files.",
      "Restart patchdeck if it was launched before you refreshed credentials.",
      "Queue PR work again.",
    ],
    cli_missing: buildCliMissingFixSteps("Codex", "codex"),
    unknown_agent: [
      "Open Settings and choose a supported coding agent.",
      "Restart patchdeck if the agent setting was changed outside the app.",
      "Queue PR work again.",
    ],
  },
};

function buildAgentAvailabilityFailure(
  agentLabel: AgentLabel,
  kind: AgentUnavailabilityKind,
): AgentAvailabilityFailure {
  return {
    agentLabel,
    kind,
    fixSteps: AGENT_FIX_STEPS[agentLabel][kind],
  };
}

function detectAgentLabelFromError(error: string): AgentLabel | null {
  const lower = error.toLowerCase();
  if (lower.includes("claude evaluation failed") || lower.includes("claude apply failed")) {
    return "Claude";
  }
  if (lower.includes("codex evaluation failed") || lower.includes("codex apply failed")) {
    return "Codex";
  }
  return null;
}

function classifyAgentAvailabilityFailure(job: BackgroundJob): AgentAvailabilityFailure | null {
  if (job.kind !== "babysit_pr" || !job.lastError) {
    return null;
  }

  const kind = detectAgentUnavailability(job.lastError);
  if (!kind) {
    return null;
  }

  const agentLabel = detectAgentLabelFromError(job.lastError);
  if (agentLabel) {
    return buildAgentAvailabilityFailure(agentLabel, kind);
  }

  const preferredAgent = readJobStringPayload(job, "preferredAgent");
  if (preferredAgent === "claude") {
    return buildAgentAvailabilityFailure("Claude", kind);
  }
  if (preferredAgent === "codex") {
    return buildAgentAvailabilityFailure("Codex", kind);
  }

  return null;
}

export function mapMergedPullsToReleaseSummaries(pulls: MergedPRSummary[]): ReleaseAgentPullSummary[] {
  return pulls.flatMap((pull) => {
    const mergeSha = pull.mergeCommitSha?.trim();
    if (!mergeSha) {
      return [];
    }

    return [{
      number: pull.number,
      title: pull.title,
      url: pull.url,
      author: pull.author,
      repo: pull.repo,
      mergedAt: pull.mergedAt,
      mergeSha,
    }];
  });
}

export function createAppRuntime(dependencies: AppRuntimeDependencies = {}): AppRuntime {
  const storage = dependencies.storage ?? getDefaultStorage();
  const buildOctokitImpl = dependencies.buildOctokitFn ?? buildOctokit;
  const events = new EventEmitter();
  const socialPostJobs = new Map<string, ReleaseSocialPost>();
  const backgroundJobQueue = dependencies.backgroundJobQueue ?? new BackgroundJobQueue(storage);
  // eslint-disable-next-line prefer-const -- circular dep: closure references this before it can be initialized
  let backgroundJobDispatcher!: BackgroundJobDispatcher;

  const scheduleBackgroundJob = async (...args: Parameters<BackgroundJobQueue["enqueue"]>) => {
    const job = await backgroundJobQueue.enqueue(...args);
    backgroundJobDispatcher.wake();
    return job;
  };

  const deploymentHealingManager = dependencies.deploymentHealingManager ?? new DeploymentHealingManager(storage);
  const releaseManager = dependencies.releaseManager ?? new ReleaseManager(storage, {
    github: {
      buildOctokit,
      getDefaultBranch: getDefaultBranchForRepo,
      findLatestSemverReleaseTag: getLatestSemverTagForRepo,
      bumpReleaseTag: resolveNextSemverTag,
      listUnreleasedMergedPulls: async (octokit, repo, options) => {
        const merged = await listUnreleasedMergedPulls(octokit, repo, {
          baseRef: options.baseBranch,
        });

        return mapMergedPullsToReleaseSummaries(merged);
      },
      listMergedPullsForReleaseCandidate: async (octokit, repo, options) => {
        const merged = await listUnreleasedMergedPulls(octokit, repo, {
          baseRef: options.baseBranch,
        });
        const cutoffMs = Date.parse(options.untilMergedAt);

        return mapMergedPullsToReleaseSummaries(
          merged.filter((pull) => !Number.isFinite(cutoffMs) || Date.parse(pull.mergedAt) <= cutoffMs),
        );
      },
      findReleaseByTag: async (octokit, repo, tagName) => {
        const releases = await listReleasesForRepo(octokit, repo);
        const existing = releases.find((release) => !release.draft && release.tagName === tagName);
        if (!existing) {
          return null;
        }

        return {
          id: existing.id,
          url: existing.htmlUrl,
          tagName: existing.tagName,
          name: existing.name,
        };
      },
      createGitHubRelease: async (octokit, repo, params) => {
        const created = await createGitHubRelease(octokit, repo, {
          tagName: params.tagName,
          targetCommitish: params.targetCommitish,
          name: params.name,
          body: params.body,
        });

        return {
          id: created.id,
          url: created.htmlUrl,
          tagName: created.tagName,
          name: created.name,
        };
      },
    },
    scheduleBackgroundJob,
  });

  const babysitter = dependencies.babysitter ?? new PRBabysitter(
    storage,
    undefined,
    undefined,
    releaseManager,
    scheduleBackgroundJob,
    deploymentHealingManager,
  );

  backgroundJobDispatcher = dependencies.backgroundJobDispatcher ?? new BackgroundJobDispatcher({
    storage,
    queue: backgroundJobQueue,
    handlers: createBackgroundJobHandlers({
      storage,
      babysitter,
      releaseManager,
      deploymentHealingManager,
    }),
    onReclaimedJobs: (jobs) => {
      for (const job of jobs) {
        if (job.kind !== "babysit_pr") {
          continue;
        }

        void storage.addLog(job.targetId, "warn", `Reclaimed expired background job ${job.id} for PR ${job.targetId}`, {
          phase: "background.job",
          metadata: {
            jobId: job.id,
            kind: job.kind,
            leaseOwner: job.leaseOwner,
            leaseExpiresAt: job.leaseExpiresAt,
            attemptCount: job.attemptCount,
          },
        }).catch((error) => {
          log.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "Failed to log reclaimed background job",
          );
        });
      }
    },
  });

  let watcherTimer: NodeJS.Timeout | null = null;
  let watcherColdStartTimer: NodeJS.Timeout | null = null;
  let watcherIntervalMs = 0;
  let logsRetentionJob: RetentionJobHandle | null = null;
  const watcherScheduler = dependencies.watcherScheduler ?? createWatcherScheduler(
    async () => {
      const runtimeState = await storage.getRuntimeState();
      if (runtimeState.drainMode) {
        return;
      }

      const config = await storage.getConfig();
      if (config.autoPrs === false && config.autoIssues === false) {
        return;
      }

      const rateLimit = getRateLimitState("core");
      if (rateLimit.limited && rateLimit.resetAt) {
        log.info(
          {
            resetAt: rateLimit.resetAt.toISOString(),
            secondsUntilReset: Math.ceil((rateLimit.resetAt.getTime() - Date.now()) / 1000),
          },
          "Skipping watcher tick: GitHub core rate limit gate active",
        );
        return;
      }

      if (config.autoPrs !== false) {
        await scheduleBackgroundJob(
          "sync_watched_repos",
          "runtime:1",
          buildBackgroundJobDedupeKey("sync_watched_repos", "runtime:1"),
        );
      }

      if (config.autoIssues !== false) {
        // The routine issue sweep is low priority — it yields core REST budget
        // to interactive routes and active babysitter sessions. A manual
        // syncRepos() stays high priority.
        await runWithRequestPriority("low", () => syncStoredIssuesStep());
        await queueAutomaticIssueWorkInternal();
      }
    },
    (error) => {
      log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "Repository PR watcher failed",
      );
    },
  );
  const runWatcher = watcherScheduler.run;

  const startBackgroundServices = dependencies.startBackgroundServices ?? true;
  const startWatcher = dependencies.startWatcher ?? startBackgroundServices;
  let started = false;

  const notifyChange = () => {
    events.emit("change");
  };
  const issueSyncState = new Map<string, {
    lastSyncAttemptedAt: string | null;
    lastSyncSucceededAt: string | null;
    lastSyncError: string | null;
  }>();
  const issueRepoSyncOffsets = new Map<string, number>();
  let issueRepoCursor = 0;

  function markIssueSyncAttempt(targetId: string): string {
    const now = new Date().toISOString();
    const previous = issueSyncState.get(targetId);
    issueSyncState.set(targetId, {
      lastSyncAttemptedAt: now,
      lastSyncSucceededAt: previous?.lastSyncSucceededAt ?? null,
      lastSyncError: null,
    });
    return now;
  }

  function markIssueSyncSuccess(targetId: string, attemptedAt: string): void {
    issueSyncState.set(targetId, {
      lastSyncAttemptedAt: attemptedAt,
      lastSyncSucceededAt: attemptedAt,
      lastSyncError: null,
    });
  }

  function markIssueSyncFailure(targetId: string, attemptedAt: string, error: string): void {
    const previous = issueSyncState.get(targetId);
    issueSyncState.set(targetId, {
      lastSyncAttemptedAt: attemptedAt,
      lastSyncSucceededAt: previous?.lastSyncSucceededAt ?? null,
      lastSyncError: error,
    });
  }

  type IssueWorkQueueSource = "manual" | "automatic";
  type IssueEvaluationQueueSource = "manual" | "automatic";

  async function queueIssueEvaluationInternal(
    repoInput: string,
    number: number,
    source: IssueEvaluationQueueSource,
  ): Promise<Issue> {
    const parsedRepo = parseRepoSlug(repoInput);
    if (!parsedRepo) {
      throw new AppRuntimeError(400, "Invalid repository. Use owner/repo or https://github.com/owner/repo");
    }

    const canonical = formatRepoSlug(parsedRepo);
    const config = await storage.getConfig();
    if (!config.watchedRepos.includes(canonical)) {
      throw new AppRuntimeError(404, `Repository ${canonical} is not being watched`);
    }

    const runtimeState = await storage.getRuntimeState();
    if (runtimeState.drainMode) {
      await rejectManualRunDuringDrain(runtimeState, {
        logMessageBase: "Manual issue evaluation blocked because drain mode is enabled",
        metadata: { repo: canonical, issueNumber: number },
      });
    }

    const octokit = await buildOctokitImpl(config);
    const issue = await fetchIssueSummary(octokit, { ...parsedRepo, number });
    const targetId = formatIssueTargetId(issue.repoFullName, issue.number);
    const priority = isPriorityIssueAuthor(issue.author, config.priorityIssueAuthors)
      ? PRIORITY_ISSUE_JOB_PRIORITY
      : undefined;
    const job = await scheduleBackgroundJob(
      "evaluate_issue",
      targetId,
      buildBackgroundJobDedupeKey("evaluate_issue", targetId),
      {
        repo: issue.repoFullName,
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueUrl: issue.url,
        ...buildActivityPayload({
          label: `Evaluating issue #${issue.number}`,
          detail: `${issue.repoFullName} - ${issue.title}`,
          targetUrl: issue.url,
        }),
      },
      priority === undefined ? undefined : { priority },
    );

    await storage.addLog(targetId, "info", `${source === "automatic" ? "Queued automatic issue evaluation" : "Queued manual issue evaluation"} for ${issue.repoFullName}#${issue.number}`, {
      metadata: {
        repo: issue.repoFullName,
        issueNumber: issue.number,
        jobId: job.id,
        stage: "queued_evaluation",
      },
    });

    notifyChange();
    return applyIssueWorkState(issue);
  }

  async function verifyIssueWorkInternal(
    repoInput: string,
    number: number,
  ): Promise<Issue> {
    const parsedRepo = parseRepoSlug(repoInput);
    if (!parsedRepo) {
      throw new AppRuntimeError(400, "Invalid repository. Use owner/repo or https://github.com/owner/repo");
    }

    const canonical = formatRepoSlug(parsedRepo);
    const config = await storage.getConfig();
    if (!config.watchedRepos.includes(canonical)) {
      throw new AppRuntimeError(404, `Repository ${canonical} is not being watched`);
    }

    const runtimeState = await storage.getRuntimeState();
    if (runtimeState.drainMode) {
      await rejectManualRunDuringDrain(runtimeState, {
        logMessageBase: "Manual issue verification blocked because drain mode is enabled",
        metadata: { repo: canonical, issueNumber: number },
      });
    }

    const octokit = await buildOctokitImpl(config);
    const issueSummary = await fetchIssueSummary(octokit, { ...parsedRepo, number });
    const enriched = await applyIssueWorkState(issueSummary);
    const targetId = formatIssueTargetId(issueSummary.repoFullName, issueSummary.number);

    if (!enriched.workPrUrl || enriched.workPrNumber === undefined || enriched.workPrNumber === null) {
      throw new AppRuntimeError(400, `Issue ${issueSummary.repoFullName}#${issueSummary.number} has no work PR to verify yet`);
    }

    const job = await scheduleBackgroundJob(
      "verify_issue",
      targetId,
      buildBackgroundJobDedupeKey("verify_issue", targetId),
      {
        repo: issueSummary.repoFullName,
        issueNumber: issueSummary.number,
        issueTitle: issueSummary.title,
        issueUrl: issueSummary.url,
        workPrNumber: enriched.workPrNumber,
        workPrUrl: enriched.workPrUrl,
        ...buildActivityPayload({
          label: `Verifying issue #${issueSummary.number}`,
          detail: `${issueSummary.repoFullName} - ${issueSummary.title}`,
          targetUrl: enriched.workPrUrl,
        }),
      },
    );

    await storage.addLog(
      targetId,
      "info",
      `Queued verification for ${issueSummary.repoFullName}#${issueSummary.number} against PR #${enriched.workPrNumber}`,
      {
        metadata: {
          repo: issueSummary.repoFullName,
          issueNumber: issueSummary.number,
          prNumber: enriched.workPrNumber,
          prUrl: enriched.workPrUrl,
          jobId: job.id,
          stage: "queued_verification",
        },
      },
    );

    notifyChange();
    return enriched;
  }

  async function queueIssueWorkInternal(
    repoInput: string,
    number: number,
    source: IssueWorkQueueSource,
  ): Promise<Issue> {
    const parsedRepo = parseRepoSlug(repoInput);
    if (!parsedRepo) {
      throw new AppRuntimeError(400, "Invalid repository. Use owner/repo or https://github.com/owner/repo");
    }

    const canonical = formatRepoSlug(parsedRepo);
    const config = await storage.getConfig();
    if (!config.watchedRepos.includes(canonical)) {
      throw new AppRuntimeError(404, `Repository ${canonical} is not being watched`);
    }

    const runtimeState = await storage.getRuntimeState();
    if (runtimeState.drainMode) {
      await rejectManualRunDuringDrain(runtimeState, {
        logMessageBase: "Manual issue work blocked because drain mode is enabled",
        metadata: { repo: canonical, issueNumber: number },
      });
    }

    const octokit = await buildOctokit(config);
    const issue = await fetchIssueSummary(octokit, { ...parsedRepo, number });
    const linkedOpenPrs = await listOpenLinkedPullRequestsForIssue(octokit, parsedRepo, issue.number);
    if (linkedOpenPrs.length > 0) {
      const linked = linkedOpenPrs[0];
      const linkedRef = linked ? `${linked.repoFullName}#${linked.number}` : "another branch";
      throw new AppRuntimeError(
        409,
        `Issue ${issue.repoFullName}#${issue.number} already has an open linked PR (${linkedRef}): ${linked?.url ?? "unknown"}`,
      );
    }
    const baseBranch = await getDefaultBranchForRepo(octokit, parsedRepo);
    const targetId = formatIssueTargetId(issue.repoFullName, issue.number);
    const priority = isPriorityIssueAuthor(issue.author, config.priorityIssueAuthors)
      ? PRIORITY_ISSUE_JOB_PRIORITY
      : undefined;

    const job = await scheduleBackgroundJob(
      "work_issue",
      targetId,
      buildBackgroundJobDedupeKey("work_issue", targetId),
      {
        repo: issue.repoFullName,
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueUrl: issue.url,
        baseBranch,
        ...buildActivityPayload({
          label: `Working issue #${issue.number}`,
          detail: `${issue.repoFullName} - ${issue.title}`,
          targetUrl: issue.url,
        }),
      },
      priority === undefined ? undefined : { priority },
    );

    await storage.addLog(targetId, "info", `${source === "automatic" ? "Queued automatic issue work" : "Queued manual issue work"} for ${issue.repoFullName}#${issue.number}`, {
      metadata: {
        repo: issue.repoFullName,
        issueNumber: issue.number,
        jobId: job.id,
        stage: "queued",
      },
    });

    notifyChange();
    return {
      ...issue,
      id: targetId,
      repo: issue.repoFullName,
      workStatus: "queued" as const,
      workStage: "queued",
      workJobId: job.id,
      workAttemptCount: job.attemptCount + 1,
      workQueuedAt: job.createdAt,
      workCompletedAt: null,
      lastError: null,
      workPrNumber: null,
      workPrUrl: null,
      workPrMergeable: null,
      externalWorkPrNumber: null,
      externalWorkPrUrl: null,
      externalWorkPrRepo: null,
    };
  }

  async function applyIssueWorkState(
    issue: Awaited<ReturnType<typeof fetchIssueSummary>>,
    options: {
      includePrMergeability?: boolean;
      includeExternalPrLinks?: boolean;
      issueJobs?: BackgroundJob[];
      octokit?: Awaited<ReturnType<typeof buildOctokit>>;
      isWorked?: boolean;
    } = {},
  ): Promise<Issue> {
    const targetId = formatIssueTargetId(issue.repoFullName, issue.number);
    const issueJobs = options.issueJobs ?? await storage.listBackgroundJobs({ kind: "work_issue", targetId });
    const latestJob = getLatestBackgroundJob(issueJobs);
    const workState = issueWorkStatusFromJobs(issueJobs);
    const workLogs = latestJob ? await storage.getLogs(targetId) : [];
    const storedEvaluation = await storage.getIssueEvaluation(targetId);
    const evaluation = getCurrentIssueEvaluationForLabels({
      labels: issue.labels,
    }, storedEvaluation);
    const subtaskSet = await storage.getIssueSubtasks(targetId);
    const readyPr = latestJob?.status === "completed"
      ? issueWorkPrFromLogs(workLogs, issue.repoFullName)
      : null;
    const workStage = issueWorkStageFromLogs(workLogs, workState.workStatus);
    let workPrMergeable: boolean | null = null;
    const autoWork = getIssueAutoWorkEligibility({
      labels: issue.labels,
    }, evaluation);
    let externalPr: { number: number; url: string; repoFullName: string } | null = null;
    const parsedIssueRepo = parseRepoSlug(issue.repoFullName);
    const linkedOpenPrs = options.includeExternalPrLinks !== false && options.octokit && parsedIssueRepo
      ? await listOpenLinkedPullRequestsForIssue(options.octokit, parsedIssueRepo, issue.number)
      : [];
    if (linkedOpenPrs.length > 0) {
      const localRepo = issue.repoFullName.toLowerCase();
      externalPr = linkedOpenPrs.find((entry) => entry.repoFullName.toLowerCase() !== localRepo) ?? linkedOpenPrs[0] ?? null;
    }

    if (options.includePrMergeability && readyPr) {
      const parsedPr = parsePRUrl(readyPr.workPrUrl);
      if (parsedPr) {
        try {
          const octokit = options.octokit ?? await buildOctokitImpl(await storage.getConfig());
          const pull = await fetchPullSummary(octokit, parsedPr);
          workPrMergeable = deriveWorkPrMergeable(pull.mergeableState);
        } catch (error) {
          log.warn(
            { err: error instanceof Error ? error.message : String(error), repo: issue.repoFullName, prNumber: readyPr.workPrNumber },
            "Failed to refresh issue work PR mergeability",
          );
        }
      }
    }

    return {
      ...issue,
      id: targetId,
      repo: issue.repoFullName,
      isWorked: options.isWorked ?? false,
      lastSyncAttemptedAt: issueSyncState.get(targetId)?.lastSyncAttemptedAt ?? null,
      lastSyncSucceededAt: issueSyncState.get(targetId)?.lastSyncSucceededAt ?? null,
      lastSyncError: issueSyncState.get(targetId)?.lastSyncError ?? null,
      workStatus: workState.workStatus,
      workStage,
      workJobId: workState.workJobId,
      workAttemptCount: issueWorkAttemptCountFromJobs(issueJobs),
      workQueuedAt: latestJob?.createdAt ?? null,
      workCompletedAt: latestJob?.completedAt ?? null,
      lastError: workState.lastError,
      workPrNumber: readyPr?.workPrNumber ?? null,
      workPrUrl: readyPr?.workPrUrl ?? null,
      workPrMergeable,
      externalWorkPrNumber: externalPr?.number ?? null,
      externalWorkPrUrl: externalPr?.url ?? null,
      externalWorkPrRepo: externalPr?.repoFullName ?? null,
      autoWorkEligible: autoWork.autoWorkEligible,
      autoWorkBlockedReason: autoWork.autoWorkBlockedReason,
      evaluationStatus: evaluation?.status ?? null,
      evaluationSummary: evaluation?.summary ?? null,
      evaluationConfidence: evaluation?.confidence ?? null,
      evaluationSafetyFlags: evaluation?.safetyFlags ?? [],
      evaluationRecommendedLabels: evaluation?.recommendedLabels ?? [],
      evaluationUpdatedAt: evaluation?.updatedAt ?? null,
      subtasks: subtaskSet?.subtasks ?? null,
      currentRun: currentRunStatusFromIssueJob(latestJob, workLogs, workStage),
    };
  }

  async function syncStoredIssuesStep(options?: { fullSweep?: boolean }): Promise<void> {
    const config = await storage.getConfig();
    if (config.watchedRepos.length === 0) return;
    const octokit = await buildOctokitImpl(config);
    const nowMs = Date.now();
    const repoCount = config.watchedRepos.length;
    const candidates = options?.fullSweep
      ? config.watchedRepos
      : Array.from({ length: repoCount }).map((_, i) => config.watchedRepos[(issueRepoCursor + i) % repoCount]).filter(Boolean) as string[];

    // Backoff state is persisted, so a restart does not re-hammer a repo whose
    // issue sweep was failing before the process went down.
    const issueBackoffUntilMs = new Map<string, number>();
    for (const syncState of await storage.getRepoSyncStates("issues")) {
      if (syncState.nextEligibleAt) {
        issueBackoffUntilMs.set(syncState.repo, new Date(syncState.nextEligibleAt).getTime());
      }
    }

    for (const repoSlug of candidates) {
      try {
        const backoffUntilMs = issueBackoffUntilMs.get(repoSlug) ?? 0;
        if (backoffUntilMs > nowMs) continue;
        const parsed = parseRepoSlug(repoSlug);
        if (!parsed) continue;
        const limit = MAX_ISSUES_PAGE_SIZE;
        const loops = options?.fullSweep ? MAX_AUTO_ISSUE_SWEEP_PAGES : 1;
        let nextOffset = options?.fullSweep ? 0 : (issueRepoSyncOffsets.get(repoSlug) ?? 0);

        // At the start of a repo's sweep, a conditional GET tells us whether
        // anything changed. A 304 costs no primary rate-limit budget, so on an
        // unchanged repo we skip the whole sweep instead of paginating it.
        const etagKey = `issues:open:${repoSlug}`;
        let pendingEtag: string | null = null;
        if (nextOffset === 0) {
          const cachedEtag = (await storage.getGithubEtag(etagKey)) ?? null;
          const probe = await probeRepoIssuesChanged(octokit, parsed, cachedEtag);
          if (probe.notModified) {
            // A 304 confirms the repo's issue list is current. Record the
            // freshness check and defer the next sweep — a quiet repo does not
            // need an every-tick slot.
            await storage.upsertRepoSyncState(repoSlug, "issues", {
              lastSyncedAt: new Date().toISOString(),
              nextEligibleAt: new Date(Date.now() + QUIET_REPO_COOLDOWN_MS).toISOString(),
            });
            const index = config.watchedRepos.indexOf(repoSlug);
            issueRepoCursor = index === -1 ? issueRepoCursor : (index + 1) % repoCount;
            continue;
          }
          pendingEtag = probe.etag;
        }

        let didWork = false;
        for (let i = 0; i < loops; i += 1) {
          const page = await listOpenIssuesForRepo(octokit, parsed, { limit, offset: nextOffset });
          const seenAt = new Date().toISOString();
          if (nextOffset === 0) {
            await storage.markRepoIssuesStale(repoSlug);
          }
          await storage.upsertSyncedIssues(repoSlug, page.items, seenAt);
          nextOffset = page.hasMore ? nextOffset + limit : 0;
          issueRepoSyncOffsets.set(repoSlug, nextOffset);
          didWork = true;
          if (!page.hasMore || !options?.fullSweep) break;
        }
        if (didWork) {
          await storage.upsertRepoSyncState(repoSlug, "issues", {
            lastSyncedAt: new Date().toISOString(),
            nextEligibleAt: null,
          });
          // Persist the etag only after a successful sync so a failure mid-sweep
          // re-probes and re-syncs next tick instead of 304-skipping stale data.
          if (pendingEtag) {
            await storage.setGithubEtag(etagKey, pendingEtag);
          }
          const index = config.watchedRepos.indexOf(repoSlug);
          issueRepoCursor = index === -1 ? issueRepoCursor : (index + 1) % repoCount;
          if (!options?.fullSweep) return;
        }
      } catch (error) {
        await storage.upsertRepoSyncState(repoSlug, "issues", {
          nextEligibleAt: new Date(Date.now() + 60_000).toISOString(),
        });
        log.warn(
          { err: error instanceof Error ? error.message : String(error), repo: repoSlug },
          "Issue sync step failed; backing off",
        );
      }
    }
  }

  async function listIssuesInternal(input?: { limit?: number; offset?: number }): Promise<IssueListPage> {
    const limit = Math.min(Math.max(1, input?.limit ?? DEFAULT_ISSUES_PAGE_SIZE), MAX_ISSUES_PAGE_SIZE);
    const offset = Math.max(0, input?.offset ?? 0);
    const config = await storage.getConfig();
    const nowMs = Date.now();
    if (config.watchedRepos.length === 0) {
      return {
        items: [],
        limit,
        offset,
        nextOffset: null,
        hasMore: false,
        totalCount: 0,
        repoTotals: {},
        fetchedAt: new Date(nowMs).toISOString(),
        staleAt: new Date(nowMs).toISOString(),
      };
    }

    const synced = await storage.listSyncedIssues({ repos: config.watchedRepos, limit, offset, includeWorked: true });
    const counts = await storage.listSyncedIssueCounts({ repos: config.watchedRepos, includeWorked: true });
    const issueAutomationEnabled = config.autoIssues !== false;
    const octokit = issueAutomationEnabled ? await buildOctokit(config) : null;
    const workJobs = await storage.listBackgroundJobs({ kind: "work_issue" });
    const workJobsByTarget = new Map<string, BackgroundJob[]>();

    for (const job of workJobs) {
      const existing = workJobsByTarget.get(job.targetId) ?? [];
      existing.push(job);
      workJobsByTarget.set(job.targetId, existing);
    }

    const issuesWithWorkLinks = await Promise.all(synced.items.map((record) => {
      const issue = record.payload;
      const targetId = formatIssueTargetId(issue.repoFullName, issue.number);
      const attemptedAt = markIssueSyncAttempt(targetId);
      markIssueSyncSuccess(targetId, attemptedAt);
      return applyIssueWorkState(issue, {
        issueJobs: workJobsByTarget.get(targetId) ?? [],
        includePrMergeability: issueAutomationEnabled && record.isWorked,
        includeExternalPrLinks: issueAutomationEnabled,
        octokit: octokit ?? undefined,
        isWorked: record.isWorked,
      });
    }));

    const sortedItems = issuesWithWorkLinks
      .sort((a, b) => b.number - a.number);
    const hasMore = synced.hasMore;
    const fetchedAtMs = Date.now();
    const staleAtMs = fetchedAtMs;
    return {
      items: sortedItems,
      limit,
      offset,
      nextOffset: hasMore ? offset + limit : null,
      hasMore,
      totalCount: counts.totalCount,
      repoTotals: counts.repoTotals,
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      staleAt: new Date(staleAtMs).toISOString(),
    };
  }

  async function getIssueInternal(repoInput: string, number: number): Promise<Issue> {
    const parsedRepo = parseRepoSlug(repoInput);
    if (!parsedRepo) {
      throw new AppRuntimeError(400, "Invalid repository. Use owner/repo or https://github.com/owner/repo");
    }

    const canonical = formatRepoSlug(parsedRepo);
    const config = await storage.getConfig();
    if (!config.watchedRepos.includes(canonical)) {
      throw new AppRuntimeError(404, `Repository ${canonical} is not being watched`);
    }

    const targetId = formatIssueTargetId(canonical, number);
    if (config.autoIssues === false) {
      const cached = await storage.getSyncedIssue(canonical, number);
      if (!cached) {
        throw new AppRuntimeError(404, `Issue ${canonical}#${number} has not been synced yet`);
      }
      return applyIssueWorkState(cached.payload, {
        includePrMergeability: false,
        includeExternalPrLinks: false,
        isWorked: cached.isWorked,
      });
    }

    const octokit = await buildOctokitImpl(config);
    const attemptedAt = markIssueSyncAttempt(targetId);
    try {
      const issue = await fetchIssueSummary(octokit, { ...parsedRepo, number });
      markIssueSyncSuccess(targetId, attemptedAt);
      return applyIssueWorkState(issue, { includePrMergeability: true, octokit });
    } catch (error) {
      markIssueSyncFailure(targetId, attemptedAt, getErrorMessage(error));
      throw error;
    }
  }

  async function syncIssueInternal(repoInput: string, number: number): Promise<Issue> {
    const parsedRepo = parseRepoSlug(repoInput);
    if (!parsedRepo) {
      throw new AppRuntimeError(400, "Invalid repository. Use owner/repo or https://github.com/owner/repo");
    }

    const canonical = formatRepoSlug(parsedRepo);
    const config = await storage.getConfig();
    if (!config.watchedRepos.includes(canonical)) {
      throw new AppRuntimeError(404, `Repository ${canonical} is not being watched`);
    }

    const targetId = formatIssueTargetId(canonical, number);
    const attemptedAt = markIssueSyncAttempt(targetId);
    const octokit = await buildOctokitImpl(config);
    const existing = await storage.getSyncedIssue(canonical, number);
    const issue = await fetchIssueSummary(octokit, { ...parsedRepo, number });
    await storage.upsertSyncedIssues(canonical, [issue], new Date().toISOString());
    markIssueSyncSuccess(targetId, attemptedAt);
    return applyIssueWorkState(issue, { includePrMergeability: true, octokit, isWorked: existing?.isWorked ?? false });
  }

  async function updateIssueLabelsInternal(
    repoInput: string,
    number: number,
    updates: { add?: string[]; remove?: string[] },
  ): Promise<Issue> {
    const parsedRepo = parseRepoSlug(repoInput);
    if (!parsedRepo) {
      throw new AppRuntimeError(400, "Invalid repository. Use owner/repo or https://github.com/owner/repo");
    }

    const canonical = formatRepoSlug(parsedRepo);
    const config = await storage.getConfig();
    if (!config.watchedRepos.includes(canonical)) {
      throw new AppRuntimeError(404, `Repository ${canonical} is not being watched`);
    }

    const add = Array.from(new Set((updates.add ?? []).map((label) => label.trim()).filter(Boolean)));
    const remove = Array.from(new Set((updates.remove ?? []).map((label) => label.trim()).filter(Boolean)));
    if (add.length === 0 && remove.length === 0) {
      throw new AppRuntimeError(400, "At least one label is required");
    }

    const octokit = await buildOctokit(config);
    await Promise.all([
      addLabelsToIssue(octokit, { ...parsedRepo, number }, add),
      removeLabelsFromIssue(octokit, { ...parsedRepo, number }, remove),
    ]);

    const issue = await fetchIssueSummary(octokit, { ...parsedRepo, number });
    const targetId = formatIssueTargetId(issue.repoFullName, issue.number);
    await storage.addLog(targetId, "info", `Updated labels for ${issue.repoFullName}#${issue.number}`, {
      metadata: {
        repo: issue.repoFullName,
        issueNumber: issue.number,
        addedLabels: add,
        removedLabels: remove,
        stage: "labels_updated",
      },
    });

    notifyChange();
    return applyIssueWorkState(issue, { includePrMergeability: true, octokit });
  }

  async function clearIssueWorkFailuresInternal(
    repoInput: string,
    number: number,
  ): Promise<{ repo: string; number: number; id: string; cleared: number }> {
    const parsedRepo = parseRepoSlug(repoInput);
    if (!parsedRepo) {
      throw new AppRuntimeError(400, "Invalid repository. Use owner/repo or https://github.com/owner/repo");
    }

    const canonical = formatRepoSlug(parsedRepo);
    const config = await storage.getConfig();
    if (!config.watchedRepos.includes(canonical)) {
      throw new AppRuntimeError(404, `Repository ${canonical} is not being watched`);
    }

    const targetId = formatIssueTargetId(canonical, number);
    const cleared = await storage.clearFailedBackgroundJobs({
      kind: "work_issue",
      targetId,
    });

    await storage.addLog(
      targetId,
      "info",
      cleared === 1 ? "Cleared 1 failed issue work attempt" : `Cleared ${cleared} failed issue work attempts`,
      {
        metadata: {
          repo: canonical,
          issueNumber: number,
          cleared,
          stage: "reset_failures",
        },
      },
    );

    notifyChange();
    return {
      repo: canonical,
      number,
      id: targetId,
      cleared,
    };
  }

  async function queueAutomaticIssueWorkInternal(): Promise<void> {
    const [runtimeState, config] = await Promise.all([
      storage.getRuntimeState(),
      storage.getConfig(),
    ]);

    if (runtimeState.drainMode) {
      return;
    }

    if (config.autoIssues === false) {
      return;
    }

    const [repoSettings, firstIssuesPage, evaluationJobs, workJobs] = await Promise.all([
      storage.listRepoSettings(),
      listIssuesInternal({ limit: MAX_ISSUES_PAGE_SIZE, offset: 0 }),
      storage.listBackgroundJobs({ kind: "evaluate_issue" }),
      storage.listBackgroundJobs({ kind: "work_issue" }),
    ]);
    const issuesById = new Map(firstIssuesPage.items.map((issue) => [issue.id, issue]));
    let nextOffset = firstIssuesPage.nextOffset;
    let pageCount = 1;
    while (nextOffset !== null && pageCount < MAX_AUTO_ISSUE_SWEEP_PAGES) {
      const page = await listIssuesInternal({ limit: MAX_ISSUES_PAGE_SIZE, offset: nextOffset });
      for (const issue of page.items) {
        if (!issuesById.has(issue.id)) {
          issuesById.set(issue.id, issue);
        }
      }
      nextOffset = page.nextOffset;
      pageCount += 1;
    }
    const issues = Array.from(issuesById.values());

    const isJobActive = (status: string) => status === "queued" || status === "leased";
    const activeEvaluationTargets = new Set(
      evaluationJobs.filter((job) => isJobActive(job.status)).map((job) => job.targetId),
    );
    const activeWorkCount = workJobs.filter((job) => isJobActive(job.status)).length;

    const plan = planAutomaticIssueQueueActions({
      repoSettings,
      issues,
      activeEvaluationTargets,
      activeWorkCount,
      maxConcurrentIssueEvaluations: config.maxConcurrentIssueEvaluations,
      maxConcurrentIssueWork: config.maxConcurrentIssueWork,
      priorityIssueAuthors: config.priorityIssueAuthors,
    });

    for (const action of plan.work) {
      try {
        await queueIssueWorkInternal(action.repo, action.number, "automatic");
      } catch (error) {
        log.warn(
          { err: error instanceof Error ? error.message : String(error), repo: action.repo, issueNumber: action.number },
          "Automatic issue work queue failed",
        );
      }
    }

    for (const action of plan.evaluations) {
      try {
        await queueIssueEvaluationInternal(action.repo, action.number, "automatic");
      } catch (error) {
        log.warn(
          { err: error instanceof Error ? error.message : String(error), repo: action.repo, issueNumber: action.number },
          "Automatic issue evaluation queue failed",
        );
      }
    }
  }

  const getRuntimeSnapshot = async (): Promise<RuntimeSnapshot> => {
    const state = await maybeClearStaleAgentCliDrain(await storage.getRuntimeState());
    return {
      ...state,
      activeRuns: backgroundJobDispatcher.getActiveRunCount(),
    };
  };

  const maybeClearStaleAgentCliDrain = async (state: RuntimeState): Promise<RuntimeState> => {
    const agent = parseAgentCliMissingDrainReason(state.drainReason);
    if (!state.drainMode || !agent || !(await commandExists(agent))) {
      return state;
    }

    const updated = await storage.updateRuntimeState({
      drainMode: false,
      drainRequestedAt: null,
      drainReason: null,
    });
    log.info({ agent }, "Cleared stale agent CLI drain mode after CLI became available");
    notifyChange();
    return updated;
  };

  const buildActivityDescriptionContext = async (jobs: BackgroundJob[]): Promise<ActivityDescriptionContext> => {
    const prIds = new Set<string>();
    const releaseRunIds = new Set<string>();
    const socialChangelogIds = new Set<string>();
    const deploymentHealingTargets = new Set<string>();

    for (const job of jobs) {
      if (job.kind === "babysit_pr") {
        prIds.add(job.targetId);
      } else if (job.kind === "answer_pr_question") {
        const prId = readJobStringPayload(job, "prId");
        if (prId) {
          prIds.add(prId);
        }
      } else if (job.kind === "process_release_run") {
        releaseRunIds.add(job.targetId);
      } else if (job.kind === "generate_social_changelog") {
        socialChangelogIds.add(job.targetId);
      } else if (job.kind === "heal_deployment") {
        deploymentHealingTargets.add(job.targetId);
      }
    }

    const [activePrs, archivedPrs, releaseRuns, socialChangelogs, deploymentHealingSessions] = await Promise.all([
      prIds.size > 0 ? storage.getPRs() : Promise.resolve([]),
      prIds.size > 0 ? storage.getArchivedPRs() : Promise.resolve([]),
      releaseRunIds.size > 0 ? storage.listReleaseRuns() : Promise.resolve([]),
      socialChangelogIds.size > 0 ? storage.getSocialChangelogs() : Promise.resolve([]),
      deploymentHealingTargets.size > 0 ? storage.listDeploymentHealingSessions() : Promise.resolve([]),
    ]);

    const deploymentHealingSessionsByTarget = new Map<string, DeploymentHealingSession>();
    for (const session of deploymentHealingSessions) {
      deploymentHealingSessionsByTarget.set(session.id, session);
      deploymentHealingSessionsByTarget.set(`${session.repo}:${session.mergeSha}`, session);
    }

    return {
      prsById: new Map([...activePrs, ...archivedPrs].map((pr) => [pr.id, pr])),
      releaseRunsById: new Map(releaseRuns.map((run) => [run.id, run])),
      socialChangelogsById: new Map(socialChangelogs.map((changelog) => [changelog.id, changelog])),
      deploymentHealingSessionsByTarget,
    };
  };

  const describeActivityJob = (job: BackgroundJob, context: ActivityDescriptionContext): ActivityDescription => {
    const payloadDescription = readActivityPayload(job.payload);

    if (job.kind === "sync_watched_repos") {
      if (payloadDescription) {
        return normalizeActivityDescription(payloadDescription);
      }

      return {
        label: "Sync watched repositories",
        detail: null,
        targetUrl: null,
      };
    }

    if (job.kind === "babysit_pr") {
      if (job.payload.monitorFollowUp === true && payloadDescription) {
        return normalizeActivityDescription(payloadDescription);
      }

      const pr = context.prsById.get(job.targetId);
      if (pr) {
        return {
          label: `Working PR #${pr.number}`,
          detail: `${pr.repo} - ${pr.title}`,
          targetUrl: pr.url,
        };
      }
    }

    if (payloadDescription) {
      return normalizeActivityDescription(payloadDescription);
    }

    if (job.kind === "answer_pr_question") {
      const prId = readJobStringPayload(job, "prId");
      const pr = prId ? context.prsById.get(prId) : undefined;
      if (pr) {
        return {
          label: `Answering question for PR #${pr.number}`,
          detail: `${pr.repo} - ${pr.title}`,
          targetUrl: pr.url,
        };
      }
    }

    if (job.kind === "process_release_run") {
      const run = context.releaseRunsById.get(job.targetId);
      if (run) {
        return {
          label: `Processing release for ${run.repo}`,
          detail: `PR #${run.triggerPrNumber} - ${run.triggerPrTitle}`,
          targetUrl: run.triggerPrUrl,
        };
      }
    }

    if (job.kind === "generate_social_changelog") {
      const changelog = context.socialChangelogsById.get(job.targetId);
      if (changelog) {
        return {
          label: "Social changelog generation removed",
          detail: `${changelog.date} - ${changelog.triggerCount} merged PRs`,
          targetUrl: null,
        };
      }
    }

    if (job.kind === "heal_deployment") {
      const session = context.deploymentHealingSessionsByTarget.get(job.targetId);
      if (session) {
        return {
          label: `Healing ${session.platform} deployment`,
          detail: `${session.repo} PR #${session.triggerPrNumber} - ${session.triggerPrTitle}`,
          targetUrl: session.triggerPrUrl,
        };
      }
    }

    return {
      label: fallbackJobLabel(job),
      detail: job.targetId,
      targetUrl: null,
    };
  };

  const mapActivityJob = (job: BackgroundJob, context: ActivityDescriptionContext): ActivityItem => {
    const description = describeActivityJob(job, context);
    return {
      id: job.id,
      kind: job.kind,
      status: job.status === "leased" ? "in_progress" : job.status === "failed" ? "failed" : "queued",
      label: description.label,
      detail: description.detail,
      targetId: job.targetId,
      targetUrl: description.targetUrl,
      queuedAt: job.createdAt,
      availableAt: job.availableAt,
      startedAt: job.heartbeatAt,
      updatedAt: job.updatedAt,
      attemptCount: job.attemptCount,
      lastError: job.lastError,
    };
  };

  const isFailedActivityForArchivedPR = (job: BackgroundJob, context: ActivityDescriptionContext): boolean => {
    if (job.kind === "babysit_pr") {
      return context.prsById.get(job.targetId)?.status === "archived";
    }

    if (job.kind === "answer_pr_question") {
      const prId = readJobStringPayload(job, "prId");
      return prId ? context.prsById.get(prId)?.status === "archived" : false;
    }

    return false;
  };

  const mapOperatorWarning = (job: BackgroundJob, context: ActivityDescriptionContext): OperatorWarning | null => {
    const failure = classifyAgentAvailabilityFailure(job);
    if (!failure) {
      return null;
    }

    const pr = context.prsById.get(job.targetId);
    if (!pr || pr.status !== "error") {
      return null;
    }

    const titleSuffix = failure.kind === "auth" ? "authentication failed" : "CLI not installed";
    const reason = failure.kind === "auth"
      ? "local agent credentials are invalid or expired"
      : "the agent CLI is not installed on this machine";

    return {
      id: job.id,
      severity: "warning",
      title: `${failure.agentLabel} ${titleSuffix}`,
      message: `Automation could not run ${failure.agentLabel} for PR #${pr.number} in ${pr.repo} because ${reason}.`,
      fixSteps: failure.fixSteps,
      targetId: job.targetId,
      targetUrl: pr.url,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  };

  const waitForBackgroundIdle = async (timeoutMs: number): Promise<boolean> => {
    const [dispatcherIdle, babysitterIdle, releaseIdle] = await Promise.all([
      backgroundJobDispatcher.waitForIdle(timeoutMs),
      babysitter.waitForIdle(timeoutMs),
      releaseManager.waitForIdle(timeoutMs),
    ]);

    return dispatcherIdle && babysitterIdle && releaseIdle;
  };

  const refreshWatcherSchedule = async () => {
    const config = await storage.getConfig();
    const interval = Math.max(10_000, config.pollIntervalMs || 600_000);

    if (watcherTimer && watcherIntervalMs === interval) {
      return;
    }

    if (watcherTimer) {
      clearInterval(watcherTimer);
      watcherTimer = null;
    }

    watcherIntervalMs = interval;
    watcherTimer = setInterval(() => {
      void runWatcher();
    }, interval);
  };

  const queueBabysitWithAgent = async (pr: PR, preferredAgent: Config["codingAgent"]) => {
    await scheduleBackgroundJob(
      "babysit_pr",
      pr.id,
      buildBackgroundJobDedupeKey("babysit_pr", pr.id),
      {
        preferredAgent,
        ...buildActivityPayload({
          label: `Working PR #${pr.number}`,
          detail: `${pr.repo} - ${pr.title}`,
          targetUrl: pr.url,
        }),
      },
    );
  };

  const activatePRWorkIntent = async (pr: PR, config: Config): Promise<{ pr: PR; config: Config }> => {
    let nextConfig = config;
    if (!nextConfig.watchedRepos.includes(pr.repo)) {
      nextConfig = await storage.updateConfig({
        watchedRepos: [...nextConfig.watchedRepos, pr.repo].sort((a, b) => a.localeCompare(b)),
      });
      await storage.addLog(pr.id, "info", `Repository ${pr.repo} added to automatic PR work watch list`);
    }

    const updates: Partial<PR> = {};
    if (pr.watchEnabled === false) {
      updates.watchEnabled = true;
    }
    if (pr.status === "error") {
      updates.status = "watching";
    }

    if (Object.keys(updates).length === 0) {
      return { pr, config: nextConfig };
    }

    const updated = assertFound(await storage.updatePR(pr.id, updates), "PR not found");
    if (updates.watchEnabled === true) {
      await storage.addLog(pr.id, "info", "Background watch resumed by queued PR work");
    }
    if (updates.status === "watching") {
      await storage.addLog(pr.id, "info", "Queued PR work resumed this PR after a failed run");
    }
    return { pr: updated, config: nextConfig };
  };

  const queueBabysitForRepo = async (pr: PR, config: Config) => {
    const repoSettings = await storage.getRepoSettings(pr.repo);
    await queueBabysitWithAgent(pr, resolveRepoCodingAgent(config, repoSettings));
  };

  const buildManualDrainBlockMessage = (runtimeState: RuntimeState): string => {
    const base = "Drain mode is enabled. Manual runs are blocked until drain mode is disabled.";
    return runtimeState.drainReason ? `${base} Reason: ${runtimeState.drainReason}` : base;
  };

  const rejectManualRunDuringDrain = async (
    runtimeState: RuntimeState,
    options: {
      pr?: PR;
      logMessageBase?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<never> => {
    const message = buildManualDrainBlockMessage(runtimeState);
    const logMessageBase = options.logMessageBase ?? "Manual run blocked because drain mode is enabled";
    const logMessage = runtimeState.drainReason
      ? `${logMessageBase}. Reason: ${runtimeState.drainReason}`
      : `${logMessageBase}.`;
    const metadata = {
      drainReason: runtimeState.drainReason,
      drainRequestedAt: runtimeState.drainRequestedAt,
      ...options.metadata,
    };

    if (options.pr) {
      await storage.addLog(options.pr.id, "warn", logMessage, {
        phase: "run",
        metadata,
      });
      notifyChange();
    } else {
      log.warn(metadata, logMessageBase);
    }

    throw new AppRuntimeError(409, message);
  };

  const runtime: AppRuntime = {
    async start() {
      if (started) {
        return;
      }

      started = true;

      if (startBackgroundServices) {
        await backgroundJobDispatcher.start();
        logsRetentionJob = startLogsRetentionJob(storage);
      }

      if (startWatcher) {
        await refreshWatcherSchedule();
        void babysitter.resumeInterruptedRuns();
        watcherColdStartTimer = setTimeout(() => {
          watcherColdStartTimer = null;
          void runWatcher();
        }, pickWatcherColdStartDelayMs());
      }
    },

    stop() {
      started = false;
      backgroundJobDispatcher.stop();
      if (logsRetentionJob) {
        logsRetentionJob.stop();
        logsRetentionJob = null;
      }
      if (watcherColdStartTimer) {
        clearTimeout(watcherColdStartTimer);
        watcherColdStartTimer = null;
      }
      if (watcherTimer) {
        clearInterval(watcherTimer);
        watcherTimer = null;
      }
    },

    subscribe(listener) {
      events.on("change", listener);
      return () => {
        events.off("change", listener);
      };
    },

    getRuntimeSnapshot,

    async getGitHubAuthStatus() {
      const config = await storage.getConfig();
      return getGitHubAuthStatus(config);
    },

    async listActivities() {
      const [failedJobs, leasedJobs, queuedJobs] = await Promise.all([
        storage.listBackgroundJobs({ status: "failed" }),
        storage.listBackgroundJobs({ status: "leased" }),
        storage.listBackgroundJobs({ status: "queued" }),
      ]);

      const descriptionContext = await buildActivityDescriptionContext([...failedJobs, ...leasedJobs, ...queuedJobs]);
      const visibleFailedJobs = failedJobs.filter((job) => !isFailedActivityForArchivedPR(job, descriptionContext));
      const failedWarningJobs = visibleFailedJobs.filter((job) => classifyAgentAvailabilityFailure(job));
      const failed = visibleFailedJobs.map((job) => mapActivityJob(job, descriptionContext));
      const inProgress = leasedJobs.map((job) => mapActivityJob(job, descriptionContext));
      const queued = queuedJobs.map((job) => mapActivityJob(job, descriptionContext));
      const warnings = failedWarningJobs
        .map((job) => mapOperatorWarning(job, descriptionContext))
        .filter((warning): warning is OperatorWarning => Boolean(warning))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, 5);

      return {
        failed,
        inProgress,
        queued,
        warnings,
        generatedAt: new Date().toISOString(),
      };
    },

    async clearFailedActivities() {
      const cleared = await storage.clearFailedBackgroundJobs();
      if (cleared > 0) {
        notifyChange();
      }
      return { cleared };
    },

    async setDrainMode(input) {
      const updated = await storage.updateRuntimeState({
        drainMode: input.enabled,
        drainRequestedAt: input.enabled ? new Date().toISOString() : null,
        drainReason: input.enabled ? input.reason ?? null : null,
      });

      if (input.enabled) {
        log.warn({
          drainRequestedAt: updated.drainRequestedAt,
          drainReason: updated.drainReason,
          waitForIdle: Boolean(input.waitForIdle),
        }, "Drain mode enabled");
      } else {
        log.info("Drain mode disabled");
      }

      if (input.enabled && input.waitForIdle) {
        const drained = await waitForBackgroundIdle(input.timeoutMs ?? 120_000);
        const snapshot = await getRuntimeSnapshot();
        notifyChange();
        return {
          ...updated,
          ...snapshot,
          drained,
        };
      }

      const snapshot = await getRuntimeSnapshot();
      notifyChange();
      return {
        ...updated,
        ...snapshot,
      };
    },

    async listRepos() {
      const config = await storage.getConfig();
      const prs = await storage.getPRs();

      return Array.from(new Set([
        ...config.watchedRepos,
        ...prs.map((pr) => pr.repo),
      ])).sort((a, b) => a.localeCompare(b));
    },

    async listRepoSettings() {
      return storage.listRepoSettings();
    },

    async addRepo(repoInput) {
      const parsedRepo = parseRepoSlug(repoInput);
      if (!parsedRepo) {
        throw new AppRuntimeError(400, "Invalid repository. Use owner/repo or https://github.com/owner/repo");
      }

      const canonical = formatRepoSlug(parsedRepo);
      const config = await storage.getConfig();
      if (!config.watchedRepos.includes(canonical)) {
        await storage.updateConfig({
          watchedRepos: [...config.watchedRepos, canonical].sort((a, b) => a.localeCompare(b)),
        });
      }

      void runWatcher();
      notifyChange();
      return { repo: canonical };
    },

    async removeRepo(repoInput, mode = "soft") {
      const parsedRepo = parseRepoSlug(repoInput);
      if (!parsedRepo) {
        throw new AppRuntimeError(400, "Invalid repository. Use owner/repo or https://github.com/owner/repo");
      }

      const canonical = formatRepoSlug(parsedRepo);
      const config = await storage.getConfig();
      let removedPrs = 0;
      if (config.watchedRepos.includes(canonical)) {
        await storage.updateConfig({
          watchedRepos: config.watchedRepos.filter((repo) => repo !== canonical),
        });
      }

      if (mode === "hard") {
        const prs = [
          ...await storage.getPRs(),
          ...await storage.getArchivedPRs(),
        ].filter((pr) => pr.repo === canonical);
        for (const pr of prs) {
          if (await storage.removePR(pr.id)) {
            removedPrs += 1;
          }
        }
      }

      notifyChange();
      return { ok: true, repo: canonical, mode, removedPrs };
    },

    async updateRepoSettings(repoInput, updates) {
      const parsedRepo = parseRepoSlug(repoInput);
      if (!parsedRepo) {
        throw new AppRuntimeError(400, "Invalid repository. Use owner/repo or https://github.com/owner/repo");
      }

      const canonical = formatRepoSlug(parsedRepo);
      const updated = await storage.updateRepoSettings(canonical, updates);
      notifyChange();
      if (updates.issueAutoWork === true || updates.issueAutoEvaluate === true) {
        void queueAutomaticIssueWorkInternal().catch((error) => {
          log.warn(
            { err: error instanceof Error ? error.message : String(error), repo: canonical },
            "Failed to queue automatic issue work after repo settings update",
          );
        });
      }
      return updated;
    },

    async syncRepos(options?: { fullSweep?: boolean; scope?: RepoSyncScope }) {
      const runtimeState = await storage.getRuntimeState();
      if (runtimeState.drainMode) {
        return { ok: true as const };
      }

      const fullSweep = options?.fullSweep === true;
      const scope = options?.scope ?? "all";
      if (scope === "all" || scope === "prs") {
        await babysitter.syncAndBabysitTrackedRepos({ fullSweep });
      }
      if (scope === "all" || scope === "issues") {
        await syncStoredIssuesStep({ fullSweep });
      }
      notifyChange();
      return { ok: true as const };
    },

    async listIssueCoverage() {
      const config = await storage.getConfig();
      if (config.watchedRepos.length === 0) {
        return [];
      }
      const [counts, syncStates] = await Promise.all([
        storage.listSyncedIssueCounts({ repos: config.watchedRepos, includeWorked: false }),
        storage.getRepoSyncStates("issues"),
      ]);
      const syncByRepo = new Map(syncStates.map((state) => [state.repo, state]));
      const octokit = await buildOctokit(config);
      const coverage = await Promise.all(config.watchedRepos.map(async (repo): Promise<IssueCoverage> => {
        const localCount = counts.repoTotals[repo] ?? 0;
        const syncState = syncByRepo.get(repo);
        const parsed = parseRepoSlug(repo);
        if (!parsed) {
          return { repo, syncedOpenCount: localCount, githubOpenCount: null, lastSyncedAt: syncState?.lastSyncedAt ?? null };
        }
        try {
          const result = await octokit.request("GET /search/issues", {
            q: `repo:${repo} is:issue is:open`,
            per_page: 1,
          });
          const githubOpenCount = typeof result.data?.total_count === "number" ? result.data.total_count : null;
          return { repo, syncedOpenCount: localCount, githubOpenCount, lastSyncedAt: syncState?.lastSyncedAt ?? null };
        } catch {
          return { repo, syncedOpenCount: localCount, githubOpenCount: null, lastSyncedAt: syncState?.lastSyncedAt ?? null };
        }
      }));
      return coverage;
    },

    async createManualRelease(repoInput) {
      const parsedRepo = parseRepoSlug(repoInput);
      if (!parsedRepo) {
        throw new AppRuntimeError(400, "Invalid repository. Use owner/repo or https://github.com/owner/repo");
      }

      const canonical = formatRepoSlug(parsedRepo);
      const runtimeState = await storage.getRuntimeState();
      if (runtimeState.drainMode) {
        await rejectManualRunDuringDrain(runtimeState, {
          logMessageBase: "Manual release run blocked because drain mode is enabled",
          metadata: { repo: canonical },
        });
      }

      const release = await releaseManager.enqueueManualRepoRelease(canonical);
      if (!release) {
        throw new AppRuntimeError(409, `No unreleased merged pull requests found for ${canonical}`);
      }

      notifyChange();
      return release;
    },

    async listIssues(input) {
      return listIssuesInternal(input);
    },

    async getIssue(repoInput, number) {
      return getIssueInternal(repoInput, number);
    },

    async syncIssue(repoInput, number) {
      return syncIssueInternal(repoInput, number);
    },

    async updateIssueLabels(repoInput, number, updates) {
      return updateIssueLabelsInternal(repoInput, number, updates);
    },

    async evaluateIssue(repoInput, number) {
      return queueIssueEvaluationInternal(repoInput, number, "manual");
    },

    async verifyIssueWork(repoInput, number) {
      return verifyIssueWorkInternal(repoInput, number);
    },

    async workIssue(repoInput, number) {
      return queueIssueWorkInternal(repoInput, number, "manual");
    },

    async clearIssueWorkFailures(repoInput, number) {
      return clearIssueWorkFailuresInternal(repoInput, number);
    },

    async listPRs(view = "active") {
      const prs = view === "archived"
        ? await storage.getArchivedPRSummaries()
        : await storage.getPRSummaries();
      return Promise.all(prs.map((pr) => attachDerivedPrStage(pr, storage)));
    },

    async getPR(id) {
      const pr = await storage.getPR(id);
      if (!pr) {
        return null;
      }
      return attachDerivedPrStage(pr, storage);
    },

    async addPR(url) {
      let parsedUrl: string;
      try {
        ({ url: parsedUrl } = addPRSchema.parse({ url }));
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new AppRuntimeError(400, error.errors[0]?.message ?? "Invalid PR URL");
        }
        throw error;
      }
      const parsed = parsePRUrl(parsedUrl);

      if (!parsed) {
        throw new AppRuntimeError(400, "Invalid GitHub PR URL. Expected: https://github.com/owner/repo/pull/123");
      }

      const repoSlug = `${parsed.owner}/${parsed.repo}`;
      const existing = await storage.getPRByRepoAndNumber(repoSlug, parsed.number);
      if (existing) {
        const config = await storage.getConfig();
        const activated = await activatePRWorkIntent(existing, config);
        await storage.addLog(activated.pr.id, "info", "PR already tracked; queued PR work and monitoring");
        await queueBabysitForRepo(activated.pr, activated.config);
        notifyChange();
        return activated.pr;
      }

      let config = await storage.getConfig();
      const octokit = await buildOctokit(config);
      const summary = await fetchPullSummary(octokit, parsed);

      const pr = await storage.addPR({
        number: parsed.number,
        title: summary.title,
        body: summary.body,
        bodyHtml: summary.bodyHtml,
        repo: repoSlug,
        branch: summary.branch,
        author: summary.author,
        url: summary.url,
        status: "watching",
        feedbackItems: [],
        accepted: 0,
        rejected: 0,
        flagged: 0,
        testsPassed: null,
        lintPassed: null,
        mergeableState: summary.mergeableState,
        lastChecked: null,
      });

      await storage.addLog(pr.id, "info", `Registered PR #${parsed.number} from ${repoSlug}`);
      await storage.addLog(pr.id, "info", `Repository ${repoSlug} added to automatic PR work watch list`);

      if (!config.watchedRepos.includes(repoSlug)) {
        config = await storage.updateConfig({
          watchedRepos: [...config.watchedRepos, repoSlug].sort((a, b) => a.localeCompare(b)),
        });
      }

      await queueBabysitForRepo(pr, config);
      notifyChange();
      return pr;
    },

    async removePR(id) {
      const removed = await storage.removePR(id);
      if (!removed) {
        throw new AppRuntimeError(404, "PR not found");
      }

      notifyChange();
      return { ok: true as const };
    },

    async setPRWatchEnabled(id, enabled) {
      const pr = assertFound(await storage.getPR(id), "PR not found");
      const updated = await storage.updatePR(pr.id, { watchEnabled: enabled });
      const next = assertFound(updated, "PR not found");

      if (pr.watchEnabled !== enabled) {
        await storage.addLog(pr.id, "info", enabled ? "Background watch resumed" : "Background watch paused");
        if (enabled) {
          void runWatcher();
        }
      }

      notifyChange();
      return next;
    },

    async setWatchEnabled(id, enabled) {
      return runtime.setPRWatchEnabled(id, enabled);
    },

    async fetchPRFeedback(id) {
      const pr = assertFound(await storage.getPR(id), "PR not found");
      const attemptedAt = new Date().toISOString();
      await storage.updatePR(pr.id, {
        status: "processing",
        lastChecked: attemptedAt,
        lastSyncAttemptedAt: attemptedAt,
        lastSyncError: null,
      });
      await storage.addLog(pr.id, "info", "Syncing GitHub comments/reviews...");

      try {
        const updated = await babysitter.syncFeedbackForPR(pr.id);
        notifyChange();
        return updated;
      } catch (error) {
        const message = getErrorMessage(error);
        await storage.updatePR(pr.id, {
          status: "error",
          lastChecked: new Date().toISOString(),
          lastSyncError: message,
        });
        await storage.addLog(pr.id, "error", `Fetch failed: ${message}`);
        throw error;
      }
    },

    async triagePR(id) {
      const pr = assertFound(await storage.getPR(id), "PR not found");

      await storage.updatePR(pr.id, { status: "processing" });
      await storage.addLog(pr.id, "info", "Triaging feedback...");

      const triaged = pr.feedbackItems.map((item) => {
        if (item.decision) {
          return item;
        }

        const body = item.body.toLowerCase();
        if (body.includes("lgtm") || body.includes("looks good")) {
          return applyEvaluationDecision(item, false, "Acknowledgement, no code change requested");
        }

        if (
          body.includes("please")
          || body.includes("should")
          || body.includes("fix")
          || body.includes("error")
          || body.includes("fail")
        ) {
          return { ...applyEvaluationDecision(item, true, "Likely actionable request"), action: item.body };
        }

        return applyFlagDecision(item, "Unclear actionability, flagged for manual review");
      });

      const accepted = triaged.filter((item) => item.decision === "accept").length;
      const rejected = triaged.filter((item) => item.decision === "reject").length;
      const flagged = triaged.filter((item) => item.decision === "flag").length;

      const updated = await storage.updatePR(pr.id, {
        feedbackItems: triaged,
        accepted,
        rejected,
        flagged,
        status: "watching",
      });

      await storage.addLog(pr.id, "info", `Triage complete: ${accepted} accept, ${rejected} reject, ${flagged} flag`);
      notifyChange();
      return assertFound(updated, "PR not found");
    },

    async applyPR(id) {
      const pr = assertFound(await storage.getPR(id), "PR not found");
      const runtime = await storage.getRuntimeState();
      if (runtime.drainMode) {
        await rejectManualRunDuringDrain(runtime, {
          pr,
          logMessageBase: "Manual PR work blocked because drain mode is enabled",
        });
      }

      const { pr: activatedPr, config } = await activatePRWorkIntent(pr, await storage.getConfig());
      const repoSettings = await storage.getRepoSettings(activatedPr.repo);
      const selectedAgent = resolveRepoCodingAgent(config, repoSettings);
      await storage.addLog(activatedPr.id, "info", `Queued manual PR work using ${selectedAgent}`);
      await queueBabysitForRepo(activatedPr, config);

      const updated = await storage.getPR(activatedPr.id);
      notifyChange();
      return assertFound(updated, "PR disappeared after apply run");
    },

    async babysitPR(id) {
      const pr = assertFound(await storage.getPR(id), "PR not found");
      const runtime = await storage.getRuntimeState();
      if (runtime.drainMode) {
        await rejectManualRunDuringDrain(runtime, {
          pr,
          logMessageBase: "Manual PR work blocked because drain mode is enabled",
        });
      }

      const { pr: activatedPr, config } = await activatePRWorkIntent(pr, await storage.getConfig());
      const repoSettings = await storage.getRepoSettings(activatedPr.repo);
      const selectedAgent = resolveRepoCodingAgent(config, repoSettings);
      await storage.addLog(activatedPr.id, "info", `Queued manual PR work using ${selectedAgent}`);
      await queueBabysitForRepo(activatedPr, config);

      const updated = await storage.getPR(activatedPr.id);
      notifyChange();
      return assertFound(updated, "PR disappeared after babysit run");
    },

    async queueBabysit(id) {
      return runtime.babysitPR(id);
    },

    async setFeedbackDecision(prId, feedbackId, decision) {
      const pr = assertFound(await storage.getPR(prId), "PR not found");
      const updated = await applyManualFeedbackDecision({
        storage,
        pr,
        feedbackId,
        decision,
      });
      notifyChange();
      return assertFound(updated, "PR not found");
    },

    async retryFeedback(prId, feedbackId) {
      const pr = assertFound(await storage.getPR(prId), "PR not found");
      const item = pr.feedbackItems.find((candidate) => candidate.id === feedbackId);
      if (!item) {
        throw new AppRuntimeError(404, "Feedback item not found");
      }

      if (item.status !== "failed" && item.status !== "warning") {
        throw new AppRuntimeError(400, "Only failed or warning items can be retried");
      }

      const runtimeState = await storage.getRuntimeState();
      if (runtimeState.drainMode) {
        await rejectManualRunDuringDrain(runtimeState, {
          pr,
          logMessageBase: "Manual feedback retry blocked because drain mode is enabled",
          metadata: { feedbackId },
        });
      }

      const result = await babysitter.retryFeedbackItem(prId, feedbackId);
      if (result.kind === "pr_not_found") {
        throw new AppRuntimeError(404, "PR not found");
      }

      if (result.kind === "feedback_not_found") {
        throw new AppRuntimeError(404, "Feedback item not found");
      }

      if (result.kind === "feedback_not_retryable") {
        throw new AppRuntimeError(400, "Only failed or warning items can be retried");
      }

      await storage.addLog(prId, "info", `Feedback item ${feedbackId} queued for retry`);
      const config = await storage.getConfig();
      await queueBabysitForRepo(result.updated, config);
      notifyChange();
      return result.updated;
    },

    async listPRQuestions(prId) {
      assertFound(await storage.getPR(prId), "PR not found");
      return storage.getQuestions(prId);
    },

    async askQuestion(prId, question) {
      const pr = assertFound(await storage.getPR(prId), "PR not found");
      let parsed: { question: string };
      try {
        parsed = askQuestionSchema.parse({ question });
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new AppRuntimeError(400, error.errors[0]?.message ?? "Invalid question");
        }
        throw error;
      }

      const runtimeState = await storage.getRuntimeState();
      if (runtimeState.drainMode) {
        await rejectManualRunDuringDrain(runtimeState, {
          pr,
          logMessageBase: "Manual question run blocked because drain mode is enabled",
        });
      }

      const entry = await storage.addQuestion(prId, parsed.question);
      try {
        await scheduleBackgroundJob(
          "answer_pr_question",
          entry.id,
          buildBackgroundJobDedupeKey("answer_pr_question", entry.id),
          {
            prId,
            ...buildActivityPayload({
              label: `Answering question for PR #${pr.number}`,
              detail: `${pr.repo} - ${pr.title}`,
              targetUrl: pr.url,
            }),
          },
        );
      } catch (error) {
        const message = getErrorMessage(error);
        await storage.updateQuestion(entry.id, {
          status: "error",
          error: message.trim().slice(0, 2_000),
        });
        throw error;
      }

      notifyChange();
      return entry;
    },

    async listLogs(prId) {
      return storage.getLogs(prId);
    },

    async getOnboardingStatus() {
      const config = await storage.getConfig();
      return checkOnboardingStatus(config, config.watchedRepos);
    },

    async installReviewWorkflow(repo, tool) {
      const config = await storage.getConfig();
      return installCodeReviewWorkflow(config, repo, tool);
    },

    async listHealingSessions() {
      return storage.listHealingSessions();
    },

    async getHealingSession(id) {
      return assertFound(await storage.getHealingSession(id), "Healing session not found");
    },

    async listDeploymentHealingSessions(repo) {
      return storage.listDeploymentHealingSessions(repo ? { repo } : undefined);
    },

    async getDeploymentHealingSession(id) {
      return assertFound(
        await storage.getDeploymentHealingSession(id),
        "Deployment healing session not found",
      );
    },

    async getConfig() {
      return storage.getConfig();
    },

    async updateConfig(updates) {
      const updated = await storage.updateConfig(updates);
      if (startWatcher && started) {
        await refreshWatcherSchedule();
      }
      notifyChange();
      return updated;
    },

    async listSocialChangelogs() {
      return storage.getSocialChangelogs();
    },

    async getSocialChangelog(id) {
      return assertFound(await storage.getSocialChangelog(id), "Changelog not found");
    },

    async listReleaseRuns() {
      return storage.listReleaseRuns();
    },

    async getReleaseRun(id) {
      return assertFound(await storage.getReleaseRun(id), "Release run not found");
    },

    async retryReleaseRun(id) {
      const existing = assertFound(await storage.getReleaseRun(id), "Release run not found");
      const runtimeState = await storage.getRuntimeState();
      if (runtimeState.drainMode) {
        await rejectManualRunDuringDrain(runtimeState, {
          logMessageBase: "Manual release retry blocked because drain mode is enabled",
          metadata: {
            releaseRunId: id,
            repo: existing.repo,
          },
        });
      }

      const release = await releaseManager.retryReleaseRun(id);
      if (!release) {
        throw new AppRuntimeError(404, "Release run not found");
      }

      notifyChange();
      return release;
    },

    async listGitHubReleases() {
      const config = await storage.getConfig();
      if (config.watchedRepos.length === 0) {
        return [];
      }

      const octokit = await buildOctokit(config);
      const perRepo = await Promise.all(
        config.watchedRepos.map(async (repoSlug): Promise<RepoGitHubReleases | null> => {
          const parsed = parseRepoSlug(repoSlug);
          if (!parsed) {
            return null;
          }

          try {
            const summaries = await listReleasesForRepo(octokit, parsed);
            return {
              repo: repoSlug,
              releases: summaries.map((release) => ({
                id: release.id,
                tagName: release.tagName,
                name: release.name,
                body: release.body,
                bodyHtml: release.body ? renderGitHubMarkdown(release.body) : null,
                htmlUrl: release.htmlUrl,
                draft: release.draft,
                prerelease: release.prerelease,
                publishedAt: release.publishedAt,
              })),
            };
          } catch (error) {
            log.warn(
              { err: error instanceof Error ? error.message : String(error), repo: repoSlug },
              "Failed to fetch GitHub releases for repo",
            );
            return { repo: repoSlug, releases: [] };
          }
        }),
      );

      return perRepo.filter((entry): entry is RepoGitHubReleases => entry !== null);
    },

    async startReleaseSocialPost(request) {
      const config = await storage.getConfig();

      let input;
      if (request.kind === "internal") {
        const run = assertFound(await storage.getReleaseRun(request.releaseRunId), "Release run not found");
        input = {
          repo: run.repo,
          tagName: run.proposedVersion ?? `run-${run.id.slice(0, 8)}`,
          releaseName: run.releaseTitle,
          notes: run.releaseNotes,
          source: "internal" as const,
          publishedAt: run.completedAt,
          includedPrs: run.includedPrs.map((pr) => ({
            number: pr.number,
            title: pr.title,
            author: pr.author,
          })),
        };
      } else {
        const parsed = parseRepoSlug(request.repo);
        if (!parsed) {
          throw new AppRuntimeError(400, "Invalid repository slug");
        }
        const octokit = await buildOctokit(config);
        const releases = await listReleasesForRepo(octokit, parsed);
        const found = releases.find((r) => r.id === request.githubReleaseId);
        if (!found) {
          throw new AppRuntimeError(404, "GitHub release not found");
        }
        input = {
          repo: request.repo,
          tagName: found.tagName,
          releaseName: found.name,
          notes: found.body,
          source: "github" as const,
          publishedAt: found.publishedAt,
          includedPrs: [],
        };
      }
      const repoSettings = await storage.getRepoSettings(input.repo);
      const preferredAgent = resolveRepoCodingAgent(config, repoSettings);
      const agentSettings = resolveRepoAgentRuntimeSettings(config, repoSettings);

      const jobId = randomUUID();
      const job: ReleaseSocialPost = {
        jobId,
        status: "generating",
        twitter: null,
        linkedin: null,
        raw: null,
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
      };
      socialPostJobs.set(jobId, job);

      void (async () => {
        try {
          const output = await generateReleaseSocialPost({ input, preferredAgent, agentSettings });
          socialPostJobs.set(jobId, {
            ...job,
            status: "done",
            twitter: output.twitter,
            linkedin: output.linkedin,
            raw: output.raw,
            completedAt: new Date().toISOString(),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn({ err: message, jobId }, "Release social post generation failed");
          socialPostJobs.set(jobId, {
            ...job,
            status: "error",
            error: message.slice(0, 2000),
            completedAt: new Date().toISOString(),
          });
        }
      })();

      return job;
    },

    async getReleaseSocialPost(jobId) {
      const job = socialPostJobs.get(jobId);
      if (!job) {
        throw new AppRuntimeError(404, "Social post job not found");
      }
      return job;
    },
  };

  return runtime;
}

export function isAppRuntimeError(error: unknown): error is AppRuntimeError {
  return error instanceof AppRuntimeError;
}

export function isGitHubAwareError(error: unknown): error is GitHubIntegrationError | AppRuntimeError {
  return error instanceof GitHubIntegrationError || error instanceof AppRuntimeError;
}
