import type { BackgroundJob, DeploymentPlatform } from "@shared/schema";
import type { CodingAgent } from "./agentRunner";
import { TerminalBabysitterError, type PRBabysitter } from "./babysitter";
import { CancelBackgroundJobError, TerminalBackgroundJobError, type BackgroundJobHandlers } from "./backgroundJobDispatcher";
import { createAdapter } from "./deploymentAdapters";
import type { DeploymentHealingManager } from "./deploymentHealingManager";
import { runDeploymentHealingRepair } from "./deploymentHealingAgent";
import {
  buildGitHubCloneUrl,
  buildOctokit,
  addLabelsToIssue,
  createIssueComment,
  fetchIssueSummary,
  parseRepoSlug,
  resolveGitHubAuthToken,
} from "./github";
import { buildIssueEvaluationComment, evaluateIssueForAutomation } from "./issueEvaluator";
import { buildIssueReplyBody, buildIssueWorkStatusComment, buildPullRequestBody } from "./issueFormatter";
import { runIssueWorkRepair } from "./issueWorkAgent";
import { answerPRQuestion } from "./prQuestionAgent";
import type { ReleaseManager } from "./releaseManager";
import type { IStorage } from "./storage";

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

export function createBackgroundJobHandlers(params: {
  storage: IStorage;
  babysitter?: Pick<PRBabysitter, "runQueuedBabysitPR" | "syncAndBabysitTrackedRepos">;
  releaseManager?: Pick<ReleaseManager, "processReleaseRun">;
  deploymentHealingManager?: DeploymentHealingManager;
  questionAnswerer?: typeof answerPRQuestion;
  deps?: BackgroundJobHandlerDeps;
}): BackgroundJobHandlers {
  const storage = params.storage;
  const babysitter = params.babysitter;
  const releaseManager = params.releaseManager;
  const deploymentHealingManager = params.deploymentHealingManager;
  const questionAnswerer = params.questionAnswerer ?? answerPRQuestion;
  const buildOctokitFn = params.deps?.buildOctokitFn ?? buildOctokit;
  const createAdapterFn = params.deps?.createAdapterFn ?? createAdapter;
  const runIssueWorkRepairFn = params.deps?.runIssueWorkRepairFn ?? runIssueWorkRepair;
  const resolveGitHubAuthTokenFn = params.deps?.resolveGitHubAuthTokenFn ?? resolveGitHubAuthToken;
  const runDeploymentHealingRepairFn = params.deps?.runDeploymentHealingRepairFn ?? runDeploymentHealingRepair;

  async function postIssueWorkStatusComment(
    octokit: {
      issues: {
        createComment: (params: {
          owner: string;
          repo: string;
          issue_number: number;
          body: string;
        }) => Promise<unknown>;
      };
    },
    parsedRepo: { owner: string; repo: string },
    issueNumber: number,
    body: string,
    targetId: string,
    stage: string,
  ): Promise<void> {
    try {
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

  return {
    sync_watched_repos: babysitter
      ? async () => {
        await babysitter.syncAndBabysitTrackedRepos();
      }
      : undefined,

    babysit_pr: babysitter
      ? async (job) => {
        const pr = await storage.getPR(job.targetId);
        if (!pr) {
          throw new CancelBackgroundJobError(`PR ${job.targetId} no longer exists`);
        }

        const preferredAgent = readCodingAgentPayload(job, "preferredAgent")
          ?? (await storage.getConfig()).codingAgent;
        try {
          await babysitter.runQueuedBabysitPR(pr.id, preferredAgent);
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
          agent: config.codingAgent,
        });
      } catch (error) {
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
              detail: error instanceof Error ? error.message : String(error),
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
            error: error instanceof Error ? error.message : String(error),
          },
          "error",
        );
        throw error;
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
            }),
            targetId,
            "failed",
          );
        }
        throw new Error(repairResult.rejectionReason ?? "Issue work not accepted");
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

      const pr = await octokit.pulls.create({
        owner: parsedRepo.owner,
        repo: parsedRepo.repo,
        title: `fix(issue): ${issue.title}`,
        head: repairResult.fixBranch,
        base: baseBranch,
        body: buildPullRequestBody({
          repoFullName: issue.repoFullName,
          issueNumber: issue.number,
          issueTitle: issue.title,
          issueUrl: issue.url,
          summary: repairResult.summary,
          branch: repairResult.fixBranch,
        }),
      });

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
      await questionAnswerer({
        storage,
        prId: question.prId,
        questionId: question.id,
        question: question.question,
        preferredAgent: config.codingAgent,
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

        await releaseManager.processReleaseRun(releaseRun.id);
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
            agent: config.codingAgent,
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
