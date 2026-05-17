import type { ActivitySnapshot } from "@shared/schema";

export type ActivityIdleReasonInput = {
  activities: Pick<ActivitySnapshot, "inProgress" | "queued">;
  drainMode?: boolean;
  drainReason?: string | null;
  githubRateLimited?: boolean;
  githubRateLimitResetAt?: string | null;
  autoEnabled?: boolean;
  trackedLabel?: string;
  trackedCount?: number;
  eligibleCount?: number;
};

function formatResetTime(resetAt: string | null | undefined): string | null {
  if (!resetAt) return null;
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString("en-US");
}

function pluralize(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

export function getActivityIdleReason(input: ActivityIdleReasonInput): string | null {
  if (input.activities.inProgress.length > 0 || input.activities.queued.length > 0) {
    return null;
  }

  if (input.drainMode) {
    return input.drainReason
      ? `Automation is paused by drain mode: ${input.drainReason}`
      : "Automation is paused by drain mode.";
  }

  if (input.githubRateLimited) {
    const resetTime = formatResetTime(input.githubRateLimitResetAt);
    return resetTime
      ? `GitHub is rate-limited. Work will resume after ${resetTime}.`
      : "GitHub is rate-limited. Work will resume when the limit resets.";
  }

  if (input.autoEnabled === false) {
    return "Automation is set to manual mode.";
  }

  const trackedCount = input.trackedCount ?? 0;
  const trackedLabel = input.trackedLabel ?? "item";
  const eligibleCount = input.eligibleCount ?? 0;

  if (eligibleCount > 0) {
    return `No jobs are running. ${pluralize(eligibleCount, trackedLabel)} can be queued when the next safe work slot opens.`;
  }

  if (trackedCount > 0) {
    return `No jobs are running. ${pluralize(trackedCount, trackedLabel)} are tracked, but none are eligible right now or the watcher is waiting for the next sync pass.`;
  }

  return "No tracked work yet.";
}
