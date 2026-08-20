import type { BackgroundJob, DeploymentPlatform, PR } from "@shared/schema";
import { markPRWorkQueuedContract } from "@shared/prWorkContract";
import type { CodingAgent } from "./agentRunner";
import { resolveRepoAgentRuntimeSettings, resolveRepoCodingAgent } from "./agentSettings";
import { TerminalBabysitterError, type PRBabysitter } from "./babysitter";
import { CancelBackgroundJobError, DeferBackgroundJobError, TerminalBackgroundJobError, type BackgroundJobHandlers } from "./backgroundJobDispatcher";
import { classifyFailure, resolveMaxAttempts } from "./failureRecovery";
import { buildBackgroundJobDedupeKey, type ScheduleBackgroundJob } from "./backgroundJobQueue";
import { buildActivityPayload } from "./activityPayload";
import { createAdapter } from "./deploymentAdapters";
import type { DeploymentHealingManager } from "./deploymentHealingManager";
import { runDeploymentHealingRepair } from "./deploymentHealingAgent";
import {
  buildGitHubCloneUrl,
  buildOctokit,
  addLabelsToIssue,
  createIssueComment,
  fetchIssueSummary,
  fetchPullDiff,
  parsePRUrl,
  parseRepoSlug,
  resolveGitHubAuthToken,
} from "./github";
import { buildIssueEvaluationComment, evaluateIssueForAutomation } from "./issueEvaluator";
import { buildIssueReplyBody, buildIssueVerifyComment, buildIssueWorkStatusComment, buildIssueWorkStatusMarker, buildPullRequestBody } from "./issueFormatter";
import { decomposeIssueBody, hashIssueBody } from "./issueDecompose";
import { verifySubtasksAgainstPr } from "./issueVerify";
import { runIssueWorkRepair } from "./issueWorkAgent";
import { answerPRQuestion, type PRQuestionRepositoryContext } from "./prQuestionAgent";
import { getRateLimitState } from "./rateLimitState";
import type { ReleaseManager } from "./releaseManager";
import { runWithRequestPriority } from "./requestPriority";
import type { IStorage } from "./storage";

const PASSIVE_MONITOR_BUDGET_DEFER_MS = 60_000;

type BackgroundJobHandlerDeps = {
  buildOctokitFn?: typeof buildOctokit;
  createAdapterFn?: typeof createAdapter;
  runIssueWorkRepairFn?: typeof runIssueWorkRepair;
  resolveGitHubAuthTokenFn?: typeof resolveGitHubAuthToken;
  runDeploymentHealingRepairFn?: typeof runDeploymentHealingRepair;
};

function readStringPayload(job: BackgroundJob, key: string): string | null {
  const value = job.payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readCodingAgentPayload(job: BackgroundJob, key: string): CodingAgent | null {
  const value = readStringPayload(job, key);
  if (value === "codex" || value === "claude") {
    return value;
  }

  return null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldPostInitialIssueWorkNotice(job: BackgroundJob): boolean {
  return job.attemptCount <= 1;
}

function resolvePassiveMonitorDefer(): { reason: string; availableAt: Date } | null {
  const core = getRateLimitState("core");
  if (!core.limited && !core.belowReserve && !core.belowFloor) {
    return null;
  }

  const resetAtMs = core.resetAt?.getTime() ?? null;
  const availableAt = resetAtMs && resetAtMs > Date.now()
    ? new Date(Math.max(resetAtMs, Date.now() + 30_000))
    : new Date(Date.now() + PASSIVE_MONITOR_BUDGET_DEFER_MS);

  if (core.limited) {
    return {
      reason: core.resetAt
        ? `GitHub core rate limit active until ${core.resetAt.toISOString()}; passive PR monitor deferred`
        : "GitHub core rate limit active; passive PR monitor deferred",
      availableAt,
    };
  }

  if (core.belowFloor) {
    return {
      reason: "GitHub core budget is below the hard floor; passive PR monitor deferred",
      availableAt,
    };
  }

  return {
    reason: "GitHub core budget is in reserve; passive PR monitor deferred",
    availableAt,
  };
}

export function createBackgroundJobHandlers(params: {
  storage: IStorage;
  babysitter?: Pick<PRBabysitter, "runQueuedBabysitPR" | "syncAndBabysitTrackedRepos">;
  releaseManager?: Pick<ReleaseManager, "processReleaseRun" | "markReleaseRunFailed">;
  deploymentHealingManager?: DeploymentHealingManager;
  questionAnswerer?: typeof answerPRQuestion;
  scheduleBackgroundJob?: ScheduleBackgroundJob;
  deps?: BackgroundJobHandlerDeps;
}): BackgroundJobHandlers {
  const storage = params.storage;
  const babysitter = params.babysitter;
  const releaseManager = params.releaseManager;
  const deploymentHealingManager = params.deploymentHealingManager;
  const questionAnswerer = params.questionAnswerer ?? answerPRQuestion;
  const scheduleBackgroundJob = params.scheduleBackgroundJob;
  const buildOctokitFn = params.deps?.buildOctokitFn ?? buildOctokit;
  const createAdapterFn = params.deps?.createAdapterFn ?? createAdapter;
  const runIssueWorkRepairFn = params.deps?.runIssueWorkRepairFn ?? runIssueWorkRepair;
  const resolveGitHubAuthTokenFn = params.deps?.resolveGitHubAuthTokenFn ?? resolveGitHubAuthToken;
  const runDeploymentHealingRepairFn = params.deps?.runDeploymentHealingRepairFn ?? runDeploymentHealingRepair;

  async function buildQuestionRepositoryContext(prUrl: string): Promise<PRQuestionRepositoryContext | null> {
    const parsed = parsePRUrl(prUrl);
    if (!parsed) return null;

    try {
      const octokit = await buildOctokitFn(await storage.getConfig());
      const [filesResponse, commitsResponse] = await Promise.all([
        octokit.pulls.listFiles({
          owner: parsed.owner,
          repo: parsed.repo,
          pull_number: parsed.number,
          per_page: 100,
        }),
        octokit.pulls.listCommits({
          owner: parsed.owner,
          repo: parsed.repo,
          pull_number: parsed.number,
          per_page: 30,
        }),
      ]);

      const changedFiles = filesResponse.data.map((file) => {
        const patch = typeof file.patch === "string" && file.patch.trim()
          ? `\n${file.patch.split("\n").slice(0, 80).join("\n")}`
          : "";
        return [
          `- ${file.filename} (${file.status}, +${file.additions}/-${file.deletions}, ${file.changes} changes)`,
          patch,
        ].join("");
      }).join("\n\n");

      const commits = commitsResponse.data.map((commit) => {
        const message = commit.commit.message.split("\n")[0] ?? "";
        const author = commit.commit.author?.name ?? commit.author?.login ?? "unknown";
        return `- ${commit.sha.slice(0, 7)} ${message} (${author})`;
      }).join("\n");

      return {
        changedFiles,
        commits,
        note: filesResponse.data.length >= 100
          ? "Only the first 100 changed files were included."
          : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        changedFiles: "(unavailable)",
        commits: "(unavailable)",
        note: `Could not fetch live GitHub change context: ${message.slice(0, 300)}`,
      };
    }
  }

  /**
   * Maintain a single status comment per issue instead of appending a new one for
   * every attempt. A permanently failing issue used to collect one "started" and
   * one "failed" notice per recovery cycle, which turned into dozens of identical
   * comments; editing the existing comment keeps the thread readable and still
   * shows the current state.
   */
  async function postIssueWorkStatusComment(
    octokit: {
      issues: {
        createComment: (params: {
          owner: string;
          repo: string;
          issue_number: number;
          body: string;
        }) => Promise<unknown>;
        updateComment?: (params: {
          owner: string;
          repo: string;
          comment_id: number;
          body: string;
        }) => Promise<unknown>;
        listComments?: (params: {
          owner: string;
          repo: string;
          issue_number: number;
          per_page?: number;
        }) => Promise<{ data: Array<{ id: number; body?: string | null }> }>;
      };
    },
    parsedRepo: { owner: string; repo: string },
    issueNumber: number,
    body: string,
    targetId: string,
    stage: string,
  ): Promise<void> {
    try {
      const existingId = await findIssueWorkStatusCommentId(
        octokit,
        parsedRepo,
        issueNumber,
        `${parsedRepo.owner}/${parsedRepo.repo}`,
      );

      if (existingId !== null && octokit.issues.updateComment) {
        await octokit.issues.updateComment({
          owner: parsedRepo.owner,
          repo: parsedRepo.repo,
          comment_id: existingId,
          body,
        });
        return;
      }

      await octokit.issues.createComment({
        owner: parsedRepo.owner,
        repo: parsedRepo.repo,
        issue_number: issueNumber,
        body,
      });
    } catch (error) {
      await storage.addLog(targetId, "warn", `Failed to post issue work status comment: ${error instanceof Error ? error.message : String(error)}`, {
        metadata: { stage },
      });
    }
  }

  /**
   * The status comment is edited in place, so without this line a reader cannot
   * tell whether automation tried once or twenty times.
   */
  function describeIssueWorkAttempts(attemptCount: number): string | null {
    if (attemptCount <= 1) {
      return null;
    }

    return `Attempts: ${attemptCount}`;
  }

  /** Locate the status comment PatchDeck already owns on this issue, if any. */
  async function findIssueWorkStatusCommentId(
    octokit: {
      issues: {
        listComments?: (params: {
          owner: string;
          repo: string;
          issue_number: number;
          per_page?: number;
        }) => Promise<{ data: Array<{ id: number; body?: string | null }> }>;
      };
    },
    parsedRepo: { owner: string; repo: string },
    issueNumber: number,
    repoFullName: string,
  ): Promise<number | null> {
    if (!octokit.issues.listComments) {
      return null;
    }

    const marker = buildIssueWorkStatusMarker(repoFullName, issueNumber);
    const response = await octokit.issues.listComments({
      owner: parsedRepo.owner,
      repo: parsedRepo.repo,
      issue_number: issueNumber,
      per_page: 100,
    });

    const match = response.data.filter((comment) => (comment.body ?? "").includes(marker)).pop();
    return match ? match.id : null;
  }

  async function addIssueWorkStageLog(
    targetId: string,
    stage: string,
    message: string,
    metadata: Record<string, unknown>,
    level: "info" | "warn" | "error" = "info",
  ): Promise<void> {
    await storage.addLog(targetId, level, message, {
      metadata: {
        ...metadata,
        stage,
      },
    });
  }

  async function trackIssueWorkPr(params: {
    repo: string;
    prNumber: number;
    title: string;
    body: string;
    branch: string;
    author: string;
    url: string;
  }): Promise<PR> {
    const existing = await storage.getPRByRepoAndNumber(params.repo, params.prNumber);
    if (existing) {
      return await storage.updatePR(existing.id, {
        title: params.title,
        body: params.body,
        repo: params.repo,
        branch: params.branch,
        author: params.author,
        url: params.url,
        status: "watching",
        watchEnabled: true,
      }) ?? existing;
    }

    return storage.addPR({
      number: params.prNumber,
      title: params.title,
      body: params.body,
      bodyHtml: null,
      repo: params.repo,
      branch: params.branch,
      author: params.author,
      url: params.url,
      status: "watching",
      feedbackItems: [],
      accepted: 0,
      rejected: 0,
      flagged: 0,
      testsPassed: null,
      lintPassed: null,
      mergeableState: null,
      lastChecked: null,
    });
  }

  return {
    sync_watched_repos: babysitter
      ? async (job) => {
        // The routine sweep runs at low priority so it yields core REST
        // budget to interactive routes and active babysitter sessions.
        const fullSweep = job.payload.deferredBabysitBackfill === true;
        await runWithRequestPriority("low", () => babysitter.syncAndBabysitTrackedRepos(
          fullSweep ? { fullSweep: true } : undefined,
        ));
      }
      : undefined,

    babysit_pr: babysitter
      ? async (job) => {
        const pr = await storage.getPR(job.targetId);
        if (!pr) {
          throw new CancelBackgroundJobError(`PR ${job.targetId} no longer exists`);
        }

        if (job.payload.monitorFollowUp === true) {
          const defer = resolvePassiveMonitorDefer();
          if (defer) {
            throw new DeferBackgroundJobError(defer.reason, defer.availableAt);
          }
        }

        const config = await storage.getConfig();
        const repoSettings = await storage.getRepoSettings(pr.repo);
        const preferredAgent = readCodingAgentPayload(job, "preferredAgent")
          ?? resolveRepoCodingAgent(config, repoSettings);
        const agentSettings = resolveRepoAgentRuntimeSettings(config, repoSettings);
        try {
          await babysitter.runQueuedBabysitPR(pr.id, preferredAgent, agentSettings, job.attemptCount);
        } catch (error) {
          if (error instanceof TerminalBabysitterError) {
            throw new TerminalBackgroundJobError(error.message);
          }
          throw error;
        }
      }
      : undefined,

    evaluate_issue: async (job) => {
      const repo = readStringPayload(job, "repo");
      const issueNumber = Number(job.payload.issueNumber);
      const issueTitle = readStringPayload(job, "issueTitle");
      const issueUrl = readStringPayload(job, "issueUrl");

      if (!repo || !issueTitle || !issueUrl || !Number.isFinite(issueNumber)) {
        throw new CancelBackgroundJobError(`Background job ${job.id} is missing required issue evaluation fields`);
      }

      const parsedRepo = parseRepoSlug(repo);
      if (!parsedRepo) {
        throw new CancelBackgroundJobError(`Background job ${job.id} has invalid repo context: ${repo}`);
      }

      const config = await storage.getConfig();
      const octokit = await buildOctokitFn(config);
      const issue = await fetchIssueSummary(octokit, { ...parsedRepo, number: issueNumber });
      const targetId = `${issue.repoFullName}#${issue.number}`;
      const decision = evaluateIssueForAutomation({
        repo: issue.repoFullName,
        issueNumber: issue.number,
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
        author: issue.author,
      });
      const labelsToApply = decision.recommendedLabels.filter((label) => !issue.labels.includes(label));

      if (labelsToApply.length > 0) {
        await addLabelsToIssue(octokit, { ...parsedRepo, number: issue.number }, labelsToApply);
      }

      const comment = await createIssueComment(
        octokit,
        { ...parsedRepo, number: issue.number },
        buildIssueEvaluationComment({
          targetId,
          issueTitle: issue.title,
          issueUrl: issue.url,
          decision,
        }),
      );

      await storage.upsertIssueEvaluation({
        targetId,
        repo: issue.repoFullName,
        issueNumber: issue.number,
        status: decision.status,
        confidence: decision.confidence,
        summary: decision.summary,
        safetyFlags: decision.safetyFlags,
        recommendedLabels: decision.recommendedLabels,
        markerCommentId: comment.id,
      });

      await addIssueWorkStageLog(
        targetId,
        "evaluated",
        `Issue evaluation ${decision.status.replace("_", " ")} for ${issue.repoFullName}#${issue.number}`,
        {
          repo: issue.repoFullName,
          issueNumber: issue.number,
          jobId: job.id,
          status: decision.status,
          safetyFlags: decision.safetyFlags,
          recommendedLabels: decision.recommendedLabels,
        },
      );
    },

    verify_issue: async (job) => {
      const repo = readStringPayload(job, "repo");
      const issueNumber = Number(job.payload.issueNumber);
      const workPrUrl = readStringPayload(job, "workPrUrl");
      const workPrNumber = Number(job.payload.workPrNumber);

      if (!repo || !workPrUrl || !Number.isFinite(issueNumber) || !Number.isFinite(workPrNumber)) {
        throw new CancelBackgroundJobError(`Background job ${job.id} is missing required verify fields`);
      }

      const parsedRepo = parseRepoSlug(repo);
      if (!parsedRepo) {
        throw new CancelBackgroundJobError(`Background job ${job.id} has invalid repo context: ${repo}`);
      }

      const parsedPr = parsePRUrl(workPrUrl);
      if (!parsedPr) {
        throw new CancelBackgroundJobError(`Background job ${job.id} has invalid work PR URL: ${workPrUrl}`);
      }

      const config = await storage.getConfig();
      const octokit = await buildOctokitFn(config);
      const issue = await fetchIssueSummary(octokit, { ...parsedRepo, number: issueNumber });
      const targetId = `${issue.repoFullName}#${issue.number}`;
      const baseMetadata = {
        repo: issue.repoFullName,
        issueNumber: issue.number,
        prNumber: workPrNumber,
        prUrl: workPrUrl,
        jobId: job.id,
      };

      const diff = await fetchPullDiff(octokit, parsedPr);

      const repoSettings = await storage.getRepoSettings(issue.repoFullName);
      const agent = resolveRepoCodingAgent(config, repoSettings);
      const agentSettings = resolveRepoAgentRuntimeSettings(config, repoSettings);

      const freshDecomposed = await decomposeIssueBody({
        body: issue.body,
        agent,
        settings: agentSettings,
      });
      const existingSet = await storage.getIssueSubtasks(targetId);
      const subtasks = freshDecomposed.length >= 2
        ? freshDecomposed
        : existingSet?.subtasks?.length
          ? existingSet.subtasks
          : [{
            id: "issue",
            title: issue.title.slice(0, 120),
            summary: (issue.body ?? "").trim().slice(0, 500) || issue.title.slice(0, 500),
            status: "pending" as const,
          }];

      const result = await verifySubtasksAgainstPr({
        issueTitle: issue.title,
        issueBody: issue.body,
        subtasks,
        prDiff: diff,
        agent,
        settings: agentSettings,
      });

      await storage.upsertIssueSubtasks({
        targetId,
        repo: issue.repoFullName,
        issueNumber: issue.number,
        subtasks: result.subtasks,
        analyzedBodyHash: hashIssueBody(issue.body),
      });

      if (config.postGitHubProgressReplies) {
        try {
          await octokit.issues.createComment({
            owner: parsedPr.owner,
            repo: parsedPr.repo,
            issue_number: workPrNumber,
            body: buildIssueVerifyComment({
              repoFullName: issue.repoFullName,
              issueNumber: issue.number,
              issueTitle: issue.title,
              issueUrl: issue.url,
              prNumber: workPrNumber,
              prUrl: workPrUrl,
              subtasks: result.subtasks,
              doneCount: result.doneCount,
              totalCount: result.totalCount,
            }),
          });
        } catch (error) {
          await addIssueWorkStageLog(
            targetId,
            "verifying",
            `Failed to post verification comment on PR #${workPrNumber}: ${error instanceof Error ? error.message : String(error)}`,
            baseMetadata,
            "warn",
          );
        }
      }

      await addIssueWorkStageLog(
        targetId,
        "verifying",
        `Verified work PR #${workPrNumber} for ${issue.repoFullName}#${issue.number} — ${result.doneCount} of ${result.totalCount} subtasks addressed`,
        baseMetadata,
      );
    },

    work_issue: async (job) => {
      const repo = readStringPayload(job, "repo");
      const issueNumber = Number(job.payload.issueNumber);
      const issueTitle = readStringPayload(job, "issueTitle");
      const issueUrl = readStringPayload(job, "issueUrl");
      const baseBranch = readStringPayload(job, "baseBranch");

      if (!repo || !issueTitle || !issueUrl || !baseBranch || !Number.isFinite(issueNumber)) {
        throw new CancelBackgroundJobError(`Background job ${job.id} is missing required issue work fields`);
      }

      const parsedRepo = parseRepoSlug(repo);
      if (!parsedRepo) {
        throw new CancelBackgroundJobError(`Background job ${job.id} has invalid repo context: ${repo}`);
      }

      const config = await storage.getConfig();
      const octokit = await buildOctokitFn(config);
      const issue = await fetchIssueSummary(octokit, { ...parsedRepo, number: issueNumber });
      const githubToken = await resolveGitHubAuthTokenFn(config);
      const progressRepliesEnabled = config.postGitHubProgressReplies;
      const targetId = `${issue.repoFullName}#${issue.number}`;
      const repoSettings = await storage.getRepoSettings(issue.repoFullName);
      const agent = resolveRepoCodingAgent(config, repoSettings);
      const agentSettings = resolveRepoAgentRuntimeSettings(config, repoSettings);
      const baseMetadata = {
        repo: issue.repoFullName,
        issueNumber: issue.number,
        jobId: job.id,
      };

      await addIssueWorkStageLog(
        targetId,
        "started",
        `Issue work started for ${issue.repoFullName}#${issue.number}`,
        baseMetadata,
      );

      if (progressRepliesEnabled && shouldPostInitialIssueWorkNotice(job)) {
        await postIssueWorkStatusComment(
          octokit,
          parsedRepo,
          issue.number,
          buildIssueWorkStatusComment({
            repoFullName: issue.repoFullName,
            issueNumber: issue.number,
            issueTitle: issue.title,
            issueUrl: issue.url,
            stage: "started",
          }),
          targetId,
          "started",
        );
      }

      let repairResult;
      try {
        await addIssueWorkStageLog(
          targetId,
          "working",
          `Running issue repair for ${issue.repoFullName}#${issue.number}`,
          baseMetadata,
        );

        const bodyHash = hashIssueBody(issue.body);
        const existingSubtasks = await storage.getIssueSubtasks(targetId);
        let subtasks = existingSubtasks?.subtasks ?? [];
        if (!existingSubtasks || existingSubtasks.analyzedBodyHash !== bodyHash) {
          subtasks = await decomposeIssueBody({
            body: issue.body,
            agent,
            settings: agentSettings,
          });
          await storage.upsertIssueSubtasks({
            targetId,
            repo: issue.repoFullName,
            issueNumber: issue.number,
            subtasks,
            analyzedBodyHash: bodyHash,
          });
        }

        repairResult = await runIssueWorkRepairFn({
          repo: issue.repoFullName,
          issueNumber: issue.number,
          issueTitle: issue.title,
          issueUrl: issue.url,
          issueBody: issue.body,
          labels: issue.labels,
          author: issue.author,
          baseBranch,
          repoCloneUrl: buildGitHubCloneUrl(issue.repoFullName, githubToken),
          agent,
          agentSettings,
          agentInstructions: repoSettings?.agentInstructions ?? "",
          subtasks: subtasks.length >= 2 ? subtasks : undefined,
        });
      } catch (error) {
        // A thrown error here used to be terminal, so a single network blip
        // stranded the issue until someone cleared it by hand. Let the shared
        // policy decide, and only announce failure on GitHub once the job is
        // actually out of attempts.
        const message = error instanceof Error ? error.message : String(error);
        const failureClass = classifyFailure(error);
        const willRetry = job.attemptCount < resolveMaxAttempts({
          kind: job.kind,
          failureClass,
          maxAgentRetryAttempts: config.maxAgentRetryAttempts,
        });

        if (willRetry) {
          await addIssueWorkStageLog(
            targetId,
            "working",
            `Issue work attempt ${job.attemptCount} failed for ${issue.repoFullName}#${issue.number}; retrying`,
            {
              ...baseMetadata,
              error: message,
              failureClass,
              attempt: job.attemptCount,
            },
            "warn",
          );
          throw error;
        }

        if (progressRepliesEnabled) {
          await postIssueWorkStatusComment(
            octokit,
            parsedRepo,
            issue.number,
            buildIssueWorkStatusComment({
              repoFullName: issue.repoFullName,
              issueNumber: issue.number,
              issueTitle: issue.title,
              issueUrl: issue.url,
              stage: "failed",
              detail: message,
              attemptSummary: describeIssueWorkAttempts(job.attemptCount),
            }),
            targetId,
            "failed",
          );
        }
        await addIssueWorkStageLog(
          targetId,
          "failed",
          `Issue work failed for ${issue.repoFullName}#${issue.number}`,
          {
            ...baseMetadata,
            error: message,
            failureClass,
          },
          "error",
        );
        throw new TerminalBackgroundJobError(message);
      }

      if (!repairResult.accepted) {
        await addIssueWorkStageLog(
          targetId,
          "failed",
          `Issue work rejected for ${issue.repoFullName}#${issue.number}`,
          {
            ...baseMetadata,
            error: repairResult.rejectionReason ?? "Issue work not accepted",
          },
          "error",
        );
        if (progressRepliesEnabled) {
          await postIssueWorkStatusComment(
            octokit,
            parsedRepo,
            issue.number,
            buildIssueWorkStatusComment({
              repoFullName: issue.repoFullName,
              issueNumber: issue.number,
              issueTitle: issue.title,
              issueUrl: issue.url,
              stage: "failed",
              detail: repairResult.rejectionReason ?? "Issue work not accepted",
              attemptSummary: describeIssueWorkAttempts(job.attemptCount),
            }),
            targetId,
            "failed",
          );
        }
        throw new TerminalBackgroundJobError(repairResult.rejectionReason ?? "Issue work not accepted");
      }

      if (repairResult.subtasks && repairResult.subtasks.length >= 2) {
        await storage.upsertIssueSubtasks({
          targetId,
          repo: issue.repoFullName,
          issueNumber: issue.number,
          subtasks: repairResult.subtasks,
          analyzedBodyHash: hashIssueBody(issue.body),
        });
      }

      await addIssueWorkStageLog(
        targetId,
        "verifying",
        `Issue work verified for ${issue.repoFullName}#${issue.number}`,
        {
          ...baseMetadata,
          branch: repairResult.fixBranch,
        },
      );

      if (progressRepliesEnabled) {
        await postIssueWorkStatusComment(
          octokit,
          parsedRepo,
          issue.number,
          buildIssueWorkStatusComment({
            repoFullName: issue.repoFullName,
            issueNumber: issue.number,
            issueTitle: issue.title,
            issueUrl: issue.url,
            stage: "verifying",
            detail: "Verification passed in the worktree. Opening the PR now.",
          }),
          targetId,
          "verifying",
        );
      }

      await addIssueWorkStageLog(
        targetId,
        "opening_pr",
        `Opening PR for issue #${issue.number}`,
        {
          ...baseMetadata,
          branch: repairResult.fixBranch,
        },
      );

      const prTitle = `fix(issue): ${issue.title}`;
      const prBody = buildPullRequestBody({
        repoFullName: issue.repoFullName,
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueUrl: issue.url,
        summary: repairResult.summary,
        author: issue.author,
        branch: repairResult.fixBranch,
        subtasks: repairResult.subtasks,
      });
      const pr = await octokit.pulls.create({
        owner: parsedRepo.owner,
        repo: parsedRepo.repo,
        title: prTitle,
        head: repairResult.fixBranch,
        base: baseBranch,
        body: prBody,
      });

      const trackedPr = await trackIssueWorkPr({
        repo: issue.repoFullName,
        prNumber: pr.data.number,
        title: prTitle,
        body: prBody,
        branch: repairResult.fixBranch,
        author: issue.author,
        url: pr.data.html_url,
      });

      if (scheduleBackgroundJob) {
        await scheduleBackgroundJob(
          "verify_issue",
          targetId,
          buildBackgroundJobDedupeKey("verify_issue", targetId),
          {
            repo: issue.repoFullName,
            issueNumber: issue.number,
            issueTitle: issue.title,
            issueUrl: issue.url,
            workPrNumber: pr.data.number,
            workPrUrl: pr.data.html_url,
            ...buildActivityPayload({
              label: `Verifying issue #${issue.number}`,
              detail: `${issue.repoFullName} - ${issue.title}`,
              targetUrl: pr.data.html_url,
            }),
          },
        );

        const babysitJob = await scheduleBackgroundJob(
          "babysit_pr",
          trackedPr.id,
          buildBackgroundJobDedupeKey("babysit_pr", trackedPr.id),
          {
            preferredAgent: agent,
            ...buildActivityPayload({
              label: `Working PR #${trackedPr.number}`,
              detail: `${trackedPr.repo} - ${trackedPr.title}`,
              targetUrl: trackedPr.url,
            }),
          },
        );

        await storage.updatePR(trackedPr.id, {
          workContract: markPRWorkQueuedContract(trackedPr.workContract, {
            now: new Date(),
            availableAt: new Date(babysitJob.availableAt),
            reason: "Issue work opened this PR; queued PR verification and monitoring.",
            leaseOwner: agent,
          }),
        });

        await storage.addLog(trackedPr.id, "info", `Issue work handoff queued verification and PR babysitter for #${pr.data.number}`, {
          phase: "issue_handoff",
          metadata: {
            repo: issue.repoFullName,
            issueNumber: issue.number,
            issueTargetId: targetId,
            verifyTargetId: targetId,
          },
        });
      }

      await octokit.issues.createComment({
        owner: parsedRepo.owner,
        repo: parsedRepo.repo,
        issue_number: issue.number,
        body: buildIssueReplyBody({
          repoFullName: issue.repoFullName,
          issueNumber: issue.number,
          issueTitle: issue.title,
          issueUrl: issue.url,
          prNumber: pr.data.number,
          prUrl: pr.data.html_url,
          summary: repairResult.summary,
          branch: repairResult.fixBranch,
        }),
      });

      await addIssueWorkStageLog(
        job.targetId,
        "completed",
        `Opened PR #${pr.data.number} for issue #${issue.number}`,
        {
          repo: issue.repoFullName,
          issueNumber: issue.number,
          jobId: job.id,
          prNumber: pr.data.number,
          prUrl: pr.data.html_url,
          branch: repairResult.fixBranch,
        },
      );
      await storage.markSyncedIssueWorked(issue.repoFullName, issue.number);
    },

    answer_pr_question: async (job) => {
      const prId = readStringPayload(job, "prId");
      if (!prId) {
        throw new CancelBackgroundJobError(`Background job ${job.id} is missing question PR context`);
      }

      const question = (await storage.getQuestions(prId)).find((entry) => entry.id === job.targetId);
      if (!question) {
        throw new CancelBackgroundJobError(`PR question ${job.targetId} no longer exists`);
      }

      if (question.status === "answered" || question.status === "error") {
        return;
      }

      const config = await storage.getConfig();
      const pr = await storage.getPR(question.prId);
      const repoSettings = pr ? await storage.getRepoSettings(pr.repo) : undefined;
      await questionAnswerer({
        storage,
        prId: question.prId,
        questionId: question.id,
        question: question.question,
        preferredAgent: resolveRepoCodingAgent(config, repoSettings),
        agentSettings: resolveRepoAgentRuntimeSettings(config, repoSettings),
        repositoryContext: pr ? await buildQuestionRepositoryContext(pr.url) : null,
      });
    },

    generate_social_changelog: async (job) => {
      const changelog = await storage.getSocialChangelog(job.targetId);
      if (!changelog) {
        throw new CancelBackgroundJobError(`Social changelog ${job.targetId} no longer exists`);
      }

      if (changelog.status === "done" || changelog.status === "error") {
        return;
      }

      const message = "Social changelog generation has been removed";
      if (changelog.status === "generating") {
        await storage.updateSocialChangelog(changelog.id, {
          status: "error",
          error: message,
          completedAt: new Date().toISOString(),
        });
      }

      throw new CancelBackgroundJobError(message);
    },

    process_release_run: releaseManager
      ? async (job) => {
        const releaseRun = await storage.getReleaseRun(job.targetId);
        if (!releaseRun) {
          throw new CancelBackgroundJobError(`Release run ${job.targetId} no longer exists`);
        }

        if (releaseRun.status === "published" || releaseRun.status === "skipped") {
          return;
        }

        try {
          await releaseManager.processReleaseRun(releaseRun.id, { markErrorOnFailure: false });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failureClass = classifyFailure(error);
          const config = await storage.getConfig();
          const willRetry = job.attemptCount < resolveMaxAttempts({
            kind: job.kind,
            failureClass,
            maxAgentRetryAttempts: config.maxAgentRetryAttempts,
          });

          if (!willRetry) {
            await releaseManager.markReleaseRunFailed(releaseRun.id, message);
          }
          throw error;
        }
      }
      : undefined,

    heal_deployment: deploymentHealingManager
      ? async (job) => {
        const manager = deploymentHealingManager;
        const repo = readStringPayload(job, "repo");
        const platform = readStringPayload(job, "platform") as DeploymentPlatform | null;
        const mergeSha = readStringPayload(job, "mergeSha");
        const triggerPrNumber = Number(job.payload.triggerPrNumber);
        const triggerPrTitle = readStringPayload(job, "triggerPrTitle");
        const triggerPrUrl = readStringPayload(job, "triggerPrUrl");
        const baseBranch = readStringPayload(job, "baseBranch");

        if (!repo || !platform || !mergeSha || !triggerPrNumber || !triggerPrTitle || !triggerPrUrl || !baseBranch) {
          throw new CancelBackgroundJobError(
            `Background job ${job.id} is missing required deployment healing fields`,
          );
        }

        const session = await manager.ensureSession({
          repo,
          platform,
          triggerPrNumber,
          triggerPrTitle,
          triggerPrUrl,
          mergeSha,
        });

        const config = await storage.getConfig();

        // Wait for deployment to start
        await wait(config.deploymentCheckDelayMs);

        // Poll deployment status
        const adapter = createAdapterFn(platform);
        const deadline = Date.now() + config.deploymentCheckTimeoutMs;
        let lastStatus = await adapter.getDeploymentStatus({ repo, sha: mergeSha });

        while (lastStatus.state !== "ready" && lastStatus.state !== "error" && Date.now() < deadline) {
          await wait(config.deploymentCheckPollIntervalMs);
          lastStatus = await adapter.getDeploymentStatus({ repo, sha: mergeSha });
        }

        // Deployment succeeded — nothing to fix
        if (lastStatus.state === "ready") {
          return;
        }

        // Timed out without reaching error — escalate
        if (lastStatus.state !== "error") {
          await manager.transitionTo(session.id, "escalated", {
            error: `Deployment status timed out in state: ${lastStatus.state}`,
          });
          return;
        }

        // Get deployment logs
        const deploymentId = lastStatus.deploymentId ?? "unknown";
        const deploymentLog = await adapter.getDeploymentLogs({ repo, deploymentId });

        await manager.transitionTo(session.id, "failed", {
          deploymentId,
          deploymentLog,
        });
        await manager.transitionTo(session.id, "fixing");

        try {
          const parsedRepo = parseRepoSlug(repo);
          if (!parsedRepo) {
            throw new Error(`Cannot parse repo slug: ${repo}`);
          }

          const githubToken = await resolveGitHubAuthTokenFn(config);
          const octokit = await buildOctokitFn(config);

          const repoSettings = await storage.getRepoSettings(repo);
          const agent = resolveRepoCodingAgent(config, repoSettings);
          const agentSettings = resolveRepoAgentRuntimeSettings(config, repoSettings);
          const repairResult = await runDeploymentHealingRepairFn({
            repo,
            platform,
            mergeSha,
            triggerPrNumber,
            triggerPrTitle,
            triggerPrUrl,
            deploymentLog,
            baseBranch,
            repoCloneUrl: buildGitHubCloneUrl(repo, githubToken),
            agent,
            agentSettings,
            githubToken: githubToken ?? "",
          });

          if (!repairResult.accepted) {
            await manager.transitionTo(session.id, "escalated", {
              error: repairResult.rejectionReason ?? "Repair not accepted",
            });
            return;
          }

          // Create PR for the fix
          const prResult = await octokit.pulls.create({
            owner: parsedRepo.owner,
            repo: parsedRepo.repo,
            title: `fix(deploy): ${repairResult.summary}`,
            head: repairResult.fixBranch,
            base: baseBranch,
            body: [
              `Automated deployment fix for ${platform} failure after #${triggerPrNumber}.`,
              "",
              `**Summary:** ${repairResult.summary}`,
              "",
              `Triggered by merge of ${triggerPrUrl}.`,
            ].join("\n"),
          });

          await manager.transitionTo(session.id, "fix_submitted", {
            fixBranch: repairResult.fixBranch,
            fixPrNumber: prResult.data.number,
            fixPrUrl: prResult.data.html_url,
          });
        } catch (error) {
          await manager.transitionTo(session.id, "escalated", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      : undefined,
  };
}
