import type { ActivityItem, ActivitySnapshot, BackgroundJobKind } from "@shared/schema";

export type QueueStatusView = {
  label: string;
  detail: string | null;
  className: string;
};

const DEFAULT_JOB_DURATION_MS: Record<BackgroundJobKind, number> = {
  sync_watched_repos: 45_000,
  babysit_pr: 5 * 60_000,
  process_release_run: 2 * 60_000,
  answer_pr_question: 90_000,
  evaluate_issue: 90_000,
  work_issue: 4 * 60_000,
  generate_social_changelog: 3 * 60_000,
  heal_deployment: 4 * 60_000,
};

export function buildQueueStatusIndex(snapshot: ActivitySnapshot, nowMs = Date.now()): Map<string, QueueStatusView> {
  const statusById = new Map<string, QueueStatusView>();
  const inProgressBudgetMs = snapshot.inProgress.reduce((total, activity) => {
    return total + estimateRemainingMs(activity, nowMs);
  }, 0);

  let queuedBudgetMs = 0;
  for (let index = 0; index < snapshot.queued.length; index += 1) {
    const activity = snapshot.queued[index];
    const position = index + 1;
    const availableDelayMs = getAvailableDelayMs(activity, nowMs);
    const waitMs = availableDelayMs + inProgressBudgetMs + queuedBudgetMs;

    statusById.set(activity.targetId, {
      label: position === 1 ? "up next" : `#${position} in queue`,
      detail: availableDelayMs > 0
        ? `available in ~${formatDuration(availableDelayMs)}`
        : waitMs > 0
          ? `starts in ~${formatDuration(waitMs)}`
          : "starting soon",
      className: availableDelayMs > 0
        ? "border-warning-border bg-warning-muted text-warning-foreground"
        : "border-primary/50 text-primary",
    });

    queuedBudgetMs += estimateDurationMs(activity.kind);
  }

  for (const activity of snapshot.inProgress) {
    const elapsedMs = Math.max(0, nowMs - getStartedAtMs(activity, nowMs));
    const estimateMs = estimateDurationMs(activity.kind);
    const remainingMs = Math.max(0, estimateMs - elapsedMs);

    statusById.set(activity.targetId, {
      label: "running",
      detail: remainingMs > 0
        ? `~${formatDuration(remainingMs)} remaining`
        : `running for ~${formatDuration(elapsedMs)}`,
      className: "border-primary bg-primary/10 text-primary animate-pulse",
    });
  }

  return statusById;
}

export function getQueueStatusForTarget(snapshot: ActivitySnapshot, targetId: string, nowMs = Date.now()): QueueStatusView | null {
  const statusIndex = buildQueueStatusIndex(snapshot, nowMs);
  return statusIndex.get(targetId) ?? null;
}

function estimateDurationMs(kind: BackgroundJobKind): number {
  return DEFAULT_JOB_DURATION_MS[kind];
}

function getStartedAtMs(activity: ActivityItem, fallbackNowMs: number): number {
  const startedAt = activity.startedAt ? Date.parse(activity.startedAt) : Number.NaN;
  if (Number.isFinite(startedAt)) {
    return startedAt;
  }

  const updatedAt = Date.parse(activity.updatedAt);
  if (Number.isFinite(updatedAt)) {
    return updatedAt;
  }

  return fallbackNowMs;
}

function getAvailableDelayMs(activity: ActivityItem, nowMs: number): number {
  const availableAt = Date.parse(activity.availableAt);
  if (!Number.isFinite(availableAt) || availableAt <= nowMs) {
    return 0;
  }

  return availableAt - nowMs;
}

function estimateRemainingMs(activity: ActivityItem, nowMs: number): number {
  const elapsedMs = Math.max(0, nowMs - getStartedAtMs(activity, nowMs));
  return Math.max(0, estimateDurationMs(activity.kind) - elapsedMs);
}

function formatDuration(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms));
  const totalSeconds = Math.max(1, Math.round(safeMs / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${minutes}m`;
}
