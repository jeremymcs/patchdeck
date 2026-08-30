import { randomUUID } from "crypto";
import type { BackgroundJob, BackgroundJobKind } from "@shared/schema";
import type { IStorage } from "./storage";
import { BackgroundJobQueue } from "./backgroundJobQueue";
import { isAgentBudgetExhausted } from "./agentSpend";
import { classifyFailure, computeRetryDelayMs, resolveMaxAttempts, AGENT_INVOKING_JOB_KINDS, type FailureClass } from "./failureRecovery";
import { childLogger } from "./logger";
import { DEFAULT_CONFIG } from "./defaultConfig";

const log = childLogger("jobs");
const DRAIN_ALLOWED_KINDS: ReadonlySet<BackgroundJobKind> = new Set<BackgroundJobKind>(["sync_watched_repos"]);

export type BackgroundJobHandler = (job: BackgroundJob) => Promise<void>;

export type BackgroundJobHandlers = Partial<Record<BackgroundJobKind, BackgroundJobHandler>>;

export class CancelBackgroundJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CancelBackgroundJobError";
  }
}

export class TerminalBackgroundJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalBackgroundJobError";
  }
}

export class DeferBackgroundJobError extends Error {
  readonly availableAt: Date;

  constructor(message: string, availableAt: Date) {
    super(message);
    this.name = "DeferBackgroundJobError";
    this.availableAt = availableAt;
  }
}

export class BackgroundJobDispatcher {
  private readonly storage: IStorage;
  private readonly queue: BackgroundJobQueue;
  private readonly handlers: BackgroundJobHandlers;
  private readonly handledKinds: BackgroundJobKind[];
  private readonly drainClaimableKinds: BackgroundJobKind[];
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxAttempts: number | null;
  private readonly retryBackoffMs: number | null;
  private readonly now: () => Date;
  private readonly onError: (error: unknown) => void;
  private readonly onReclaimedJobs: (jobs: BackgroundJob[]) => void;
  private readonly activeJobs = new Map<string, Promise<void>>();

  private running = false;
  private polling = false;
  private loggedBudgetPause = false;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(params: {
    storage: IStorage;
    queue: BackgroundJobQueue;
    handlers: BackgroundJobHandlers;
    workerId?: string;
    pollIntervalMs?: number;
    leaseMs?: number;
    heartbeatIntervalMs?: number;
    maxAttempts?: number;
    retryBackoffMs?: number;
    now?: () => Date;
    onError?: (error: unknown) => void;
    onReclaimedJobs?: (jobs: BackgroundJob[]) => void;
  }) {
    this.storage = params.storage;
    this.queue = params.queue;
    this.handlers = params.handlers;
    this.handledKinds = Object.keys(params.handlers) as BackgroundJobKind[];
    this.drainClaimableKinds = this.handledKinds.filter((kind) => DRAIN_ALLOWED_KINDS.has(kind));
    this.workerId = params.workerId ?? randomUUID();
    this.pollIntervalMs = params.pollIntervalMs ?? 1_000;
    this.leaseMs = params.leaseMs ?? 30_000;
    this.heartbeatIntervalMs = params.heartbeatIntervalMs ?? 10_000;
    // Left unset in production so the classified retry policy applies. Tests
    // pin them to keep retries instant and bounded.
    this.maxAttempts = params.maxAttempts === undefined ? null : Math.max(1, params.maxAttempts);
    this.retryBackoffMs = params.retryBackoffMs === undefined ? null : Math.max(0, params.retryBackoffMs);
    this.now = params.now ?? (() => new Date());
    this.onError = params.onError ?? ((error) => {
      log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "Background job dispatcher error",
      );
    });
    this.onReclaimedJobs = params.onReclaimedJobs ?? (() => {});
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    await this.requeueExpiredAndNotify();
    this.wake();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  wake(): void {
    if (!this.running) {
      return;
    }

    this.schedulePoll(0);
  }

  getActiveRunCount(): number {
    return this.activeJobs.size;
  }

  async waitForIdle(timeoutMs = 120_000): Promise<boolean> {
    const startedAt = Date.now();

    while (this.activeJobs.size > 0) {
      if (Date.now() - startedAt >= timeoutMs) {
        return false;
      }
      await wait(25);
    }

    return true;
  }

  private schedulePoll(delayMs: number): void {
    if (!this.running) {
      return;
    }

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }

    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollOnce();
    }, delayMs);
  }

  private async pollOnce(): Promise<void> {
    if (!this.running || this.polling) {
      return;
    }

    this.polling = true;
    try {
      if (this.handledKinds.length === 0) {
        return;
      }

      const runtimeState = await this.storage.getRuntimeState();
      const claimableKinds = await this.resolveClaimableKinds(
        runtimeState.drainMode ? this.drainClaimableKinds : this.handledKinds,
      );
      if (claimableKinds.length === 0) {
        return;
      }

      await this.requeueExpiredAndNotify();

      const job = await this.queue.claimNext({
        workerId: this.workerId,
        leaseMs: this.leaseMs,
        now: this.now(),
        kinds: claimableKinds,
      });

      if (!job) {
        return;
      }

      this.runJob(job);
      this.schedulePoll(0);
    } catch (error) {
      this.onError(error);
    } finally {
      this.polling = false;
      if (this.running && !this.pollTimer) {
        this.schedulePoll(this.pollIntervalMs);
      }
    }
  }

  private async resolveClaimableKinds(kinds: BackgroundJobKind[]): Promise<BackgroundJobKind[]> {
    // Nothing here can spend an agent, so neither gate applies and the poll
    // stays free of a config read.
    if (!kinds.some((kind) => AGENT_INVOKING_JOB_KINDS.has(kind))) {
      return kinds;
    }

    const config = await this.storage.getConfig();
    const withinBudget = await this.filterKindsWithinAgentBudget(kinds, config.maxAgentInvocationsPerHour);
    if (!withinBudget.includes("babysit_pr")) {
      return withinBudget;
    }

    const maxConcurrentBabysitRuns = Math.max(1, config.maxConcurrentBabysitRuns);
    const activeBabysitRuns = Array.from(this.activeJobs.keys())
      .filter((jobId) => jobId.startsWith("babysit_pr:"))
      .length;

    if (activeBabysitRuns < maxConcurrentBabysitRuns) {
      return withinBudget;
    }

    return withinBudget.filter((kind) => kind !== "babysit_pr");
  }

  /**
   * Stop claiming jobs that can spend a paid agent once the rolling-hour
   * ceiling is reached. Jobs stay `queued` and flow again as the window rolls
   * forward, exactly as under drain mode — nothing fails and nothing is lost.
   */
  private async filterKindsWithinAgentBudget(
    kinds: BackgroundJobKind[],
    ceiling: number,
  ): Promise<BackgroundJobKind[]> {
    if (!(await isAgentBudgetExhausted(this.storage, this.now(), ceiling))) {
      if (this.loggedBudgetPause) {
        this.loggedBudgetPause = false;
        log.info("Agent invocation ceiling cleared; resuming agent-invoking job kinds");
      }
      return kinds;
    }

    const remaining = kinds.filter((kind) => !AGENT_INVOKING_JOB_KINDS.has(kind));
    if (!this.loggedBudgetPause) {
      this.loggedBudgetPause = true;
      log.warn(
        { stillClaimable: remaining },
        "Agent invocation ceiling reached; pausing agent-invoking job kinds until the window rolls",
      );
    }

    return remaining;
  }

  private runJob(job: BackgroundJob): void {
    const leaseToken = job.leaseToken;
    const handler = this.handlers[job.kind];

    const jobPromise = (async () => {
      if (!leaseToken) {
        throw new Error(`Claimed background job ${job.id} is missing a lease token`);
      }

      const heartbeatTimer = this.heartbeatIntervalMs > 0
        ? setInterval(() => {
          void this.queue.heartbeat({
            jobId: job.id,
            leaseToken,
            leaseMs: this.leaseMs,
            now: this.now(),
          }).catch((error) => {
            this.onError(error);
          });
        }, this.heartbeatIntervalMs)
        : null;

      try {
        if (!handler) {
          throw new Error(`No background job handler registered for ${job.kind}`);
        }

        await handler(job);
        await this.queue.complete({
          jobId: job.id,
          leaseToken,
          now: this.now(),
        });
      } catch (error) {
        await this.finalizeFailedJob(job, leaseToken, error);
      } finally {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        this.activeJobs.delete(`${job.kind}:${job.id}`);
      }
    })().catch((error) => {
      this.onError(error);
    }).finally(() => {
      if (this.running) {
        this.schedulePoll(0);
      }
    });

    this.activeJobs.set(`${job.kind}:${job.id}`, jobPromise);
  }

  private async requeueExpiredAndNotify(): Promise<void> {
    const reclaimed = await this.queue.requeueExpiredWithDetails(this.now());
    if (reclaimed.length > 0) {
      this.onReclaimedJobs(reclaimed);
    }
  }

  private async finalizeFailedJob(
    job: BackgroundJob,
    leaseToken: string,
    error: unknown,
  ): Promise<void> {
    const now = this.now();
    const { action, failureClass } = await this.resolveFailureAction(job, error);

    try {
      switch (action) {
        case "cancel":
          await this.queue.cancel({
            jobId: job.id,
            leaseToken,
            error: error instanceof CancelBackgroundJobError ? (error.message || null) : null,
            now,
          });
          return;
        case "defer":
          await this.queue.defer({
            jobId: job.id,
            leaseToken,
            error: summarizeError(error),
            now,
            availableAt: error instanceof DeferBackgroundJobError ? error.availableAt : now,
          });
          return;
        case "retry": {
          const delayMs = this.retryBackoffMs ?? computeRetryDelayMs(job.attemptCount);
          log.info(
            {
              jobId: job.id,
              kind: job.kind,
              attempt: job.attemptCount,
              failureClass,
              delayMs,
            },
            "Background job retrying after failure",
          );
          await this.queue.retry({
            jobId: job.id,
            leaseToken,
            error: summarizeError(error),
            now,
            availableAt: new Date(now.getTime() + delayMs),
          });
          return;
        }
        case "fail":
          log.warn(
            {
              jobId: job.id,
              kind: job.kind,
              attempt: job.attemptCount,
              failureClass,
            },
            "Background job parked; automation needs a human for this one",
          );
          await this.queue.fail({
            jobId: job.id,
            leaseToken,
            error: summarizeError(error),
            now,
          });
          return;
      }
    } catch (finalizeError) {
      this.onError(
        new Error(
          `Failed to ${action} background job ${job.id} (kind=${job.kind}, attempt=${job.attemptCount}): ${
            finalizeError instanceof Error ? finalizeError.message : String(finalizeError)
          }`,
          { cause: finalizeError },
        ),
      );
    }
  }

  /**
   * Decide what happens to a failed job. Retry budget depends on why it failed:
   * infrastructure blips retry generously because they cost a request, while an
   * unclassified failure on a job kind that can invoke a coding agent is capped
   * by the user's `maxAgentRetryAttempts` spend setting. Failures a human has to
   * clear (expired agent auth, missing CLI) park immediately — retrying them
   * only burns time.
   */
  private async resolveFailureAction(
    job: BackgroundJob,
    error: unknown,
  ): Promise<{ action: "cancel" | "defer" | "retry" | "fail"; failureClass: FailureClass | null }> {
    if (error instanceof CancelBackgroundJobError) {
      return { action: "cancel", failureClass: "terminal" };
    }
    if (error instanceof DeferBackgroundJobError) {
      return { action: "defer", failureClass: null };
    }
    if (error instanceof TerminalBackgroundJobError) {
      return { action: "fail", failureClass: "terminal" };
    }

    const failureClass = classifyFailure(error);
    const policyAttempts = resolveMaxAttempts({
      kind: job.kind,
      failureClass,
      maxAgentRetryAttempts: await this.resolveMaxAgentRetryAttempts(),
    });
    const maxAttempts = this.maxAttempts === null
      ? policyAttempts
      : Math.min(this.maxAttempts, policyAttempts);

    return {
      action: job.attemptCount < maxAttempts ? "retry" : "fail",
      failureClass,
    };
  }

  private async resolveMaxAgentRetryAttempts(): Promise<number> {
    try {
      const config = await this.storage.getConfig();
      return config.maxAgentRetryAttempts;
    } catch (error) {
      log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "Could not read agent retry setting; using the default",
      );
      return DEFAULT_CONFIG.maxAgentRetryAttempts;
    }
  }
}

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 2_000);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
