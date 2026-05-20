import { prWorkContractSchema } from "./schema";
import type {
  CurrentRunStatus,
  FeedbackItem,
  PR,
  PRSummary,
  PRWorkBlocker,
  PRWorkContract,
  PRWorkPhase,
} from "./schema";

export const PR_WORK_CONTRACT_STALE_MS = 30 * 60_000;

type PRContractSource = Pick<
  PR,
  | "status"
  | "testsPassed"
  | "lintPassed"
  | "mergeableState"
  | "lastSyncError"
  | "workContract"
> & {
  feedbackItems?: FeedbackItem[];
};

type ContractPatch = {
  phase: PRWorkPhase;
  blocker: PRWorkBlocker | null;
  reason: string | null;
  nextActionAt?: string | null;
  lastAttemptAt?: string | null;
  attemptCount?: number;
  leaseOwner?: string | null;
  staleAfter?: string | null;
};

export function normalizePRWorkContract(contract?: PRWorkContract | null): PRWorkContract {
  return prWorkContractSchema.parse(contract ?? {});
}

function isFeedbackClosedStatus(status: FeedbackItem["status"]): boolean {
  return status === "resolved" || status === "rejected";
}

function hasOpenFeedback(items: FeedbackItem[] | undefined): boolean {
  return Boolean(items?.some((item) => !isFeedbackClosedStatus(item.status)));
}

function hasActiveFeedbackWork(items: FeedbackItem[] | undefined): boolean {
  return Boolean(items?.some((item) => item.status === "queued" || item.status === "in_progress"));
}

function addMs(now: Date, ms: number): string {
  return new Date(now.getTime() + ms).toISOString();
}

function applyContractPatch(
  existing: PRWorkContract | undefined | null,
  patch: ContractPatch,
  now: Date,
  options: { touchUpdatedAt?: boolean } = {},
): PRWorkContract {
  const current = normalizePRWorkContract(existing);
  return prWorkContractSchema.parse({
    ...current,
    ...patch,
    updatedAt: options.touchUpdatedAt === false ? current.updatedAt : now.toISOString(),
  });
}

export function markPRWorkQueuedContract(
  existing: PRWorkContract | undefined | null,
  options: {
    now: Date;
    reason?: string;
    availableAt?: Date;
    leaseOwner?: string | null;
    staleMs?: number;
  },
): PRWorkContract {
  const current = normalizePRWorkContract(existing);
  return applyContractPatch(existing, {
    phase: "fixing",
    blocker: "automation_queued",
    reason: options.reason ?? "PR work is queued.",
    nextActionAt: (options.availableAt ?? options.now).toISOString(),
    lastAttemptAt: options.now.toISOString(),
    attemptCount: current.attemptCount + 1,
    leaseOwner: options.leaseOwner ?? null,
    staleAfter: addMs(options.now, options.staleMs ?? PR_WORK_CONTRACT_STALE_MS),
  }, options.now);
}

export function markPRWorkMonitoringContract(
  existing: PRWorkContract | undefined | null,
  options: {
    now: Date;
    blocker: PRWorkBlocker | null;
    reason: string | null;
    nextActionAt?: Date | null;
  },
): PRWorkContract {
  return applyContractPatch(existing, {
    phase: options.blocker ? "monitoring" : "ready",
    blocker: options.blocker,
    reason: options.reason,
    nextActionAt: options.nextActionAt ? options.nextActionAt.toISOString() : null,
    leaseOwner: null,
    staleAfter: null,
  }, options.now);
}

export function derivePRWorkContract(
  pr: PRContractSource,
  options: {
    currentRun?: CurrentRunStatus | null;
    now?: Date;
  } = {},
): PRWorkContract {
  const now = options.now ?? new Date();
  const current = normalizePRWorkContract(pr.workContract);
  const currentRun = options.currentRun ?? null;

  if (currentRun?.status === "queued") {
    return applyContractPatch(current, {
      phase: "fixing",
      blocker: "automation_queued",
      reason: currentRun.detail ?? "PR work is queued.",
      nextActionAt: current.nextActionAt,
    }, now, { touchUpdatedAt: false });
  }

  if (currentRun?.status === "running") {
    return applyContractPatch(current, {
      phase: "fixing",
      blocker: "automation_running",
      reason: currentRun.detail ?? "PR work is running.",
      nextActionAt: null,
      leaseOwner: currentRun.agent,
    }, now, { touchUpdatedAt: false });
  }

  if (currentRun?.status === "failed") {
    return applyContractPatch(current, {
      phase: "blocked",
      blocker: "automation_stalled",
      reason: currentRun.lastError ?? currentRun.detail ?? "Last PR work run failed.",
      nextActionAt: current.nextActionAt,
      leaseOwner: null,
    }, now, { touchUpdatedAt: false });
  }

  if (pr.status === "done" || pr.status === "archived") {
    return applyContractPatch(current, {
      phase: "ready",
      blocker: null,
      reason: pr.status === "archived" ? "PR is closed on GitHub." : "PR work is complete.",
      nextActionAt: null,
      leaseOwner: null,
      staleAfter: null,
    }, now, { touchUpdatedAt: false });
  }

  if (pr.status === "processing") {
    return applyContractPatch(current, {
      phase: "fixing",
      blocker: "automation_running",
      reason: "Automation work is running.",
      nextActionAt: null,
    }, now, { touchUpdatedAt: false });
  }

  if (pr.status === "error") {
    return applyContractPatch(current, {
      phase: "blocked",
      blocker: "automation_stalled",
      reason: pr.lastSyncError ?? "Last automation run failed.",
      nextActionAt: current.nextActionAt,
      leaseOwner: null,
    }, now, { touchUpdatedAt: false });
  }

  if (pr.testsPassed === false || pr.lintPassed === false) {
    return applyContractPatch(current, {
      phase: "fixing",
      blocker: "checks_failed",
      reason: pr.testsPassed === false ? "Tests are failing." : "Lint is failing.",
      nextActionAt: current.nextActionAt,
    }, now, { touchUpdatedAt: false });
  }

  if (hasOpenFeedback(pr.feedbackItems)) {
    return applyContractPatch(current, {
      phase: hasActiveFeedbackWork(pr.feedbackItems) ? "fixing" : "waiting_review",
      blocker: "review_feedback",
      reason: "Tracked review feedback still needs attention.",
      nextActionAt: current.nextActionAt,
    }, now, { touchUpdatedAt: false });
  }

  if (pr.mergeableState === "clean") {
    return applyContractPatch(current, {
      phase: "ready",
      blocker: null,
      reason: "GitHub reports this PR is ready to merge.",
      nextActionAt: null,
      leaseOwner: null,
      staleAfter: null,
    }, now, { touchUpdatedAt: false });
  }

  if (pr.mergeableState === "dirty") {
    return applyContractPatch(current, {
      phase: "blocked",
      blocker: "merge_conflict",
      reason: "GitHub reports merge conflicts.",
      nextActionAt: current.nextActionAt,
    }, now, { touchUpdatedAt: false });
  }

  if (pr.mergeableState === "draft") {
    return applyContractPatch(current, {
      phase: "blocked",
      blocker: "draft_pr",
      reason: "GitHub reports this PR is still a draft.",
      nextActionAt: current.nextActionAt,
    }, now, { touchUpdatedAt: false });
  }

  return applyContractPatch(current, {
    phase: "monitoring",
    blocker: "checks_pending",
    reason: `GitHub mergeable state is ${pr.mergeableState ?? "unknown"}.`,
    nextActionAt: current.nextActionAt,
  }, now, { touchUpdatedAt: false });
}

export function formatPRWorkBlocker(blocker: PRWorkBlocker | null): string {
  if (!blocker) return "none";
  return blocker.replaceAll("_", " ");
}

export function formatPRWorkPhase(phase: PRWorkPhase): string {
  return phase.replaceAll("_", " ");
}

export function getPRWorkContractSummary(pr: Pick<PRSummary, "workContract">): string {
  const contract = normalizePRWorkContract(pr.workContract);
  if (!contract.blocker) {
    return formatPRWorkPhase(contract.phase);
  }
  return `${formatPRWorkPhase(contract.phase)}: ${formatPRWorkBlocker(contract.blocker)}`;
}
