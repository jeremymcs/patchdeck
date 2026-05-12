import type { FeedbackItem, FeedbackStatus } from "@shared/schema";

export function formatFeedbackStatusLabel(status: FeedbackStatus): string {
  return status.replace("_", " ").toUpperCase();
}

export function getFeedbackStatusBadgeClass(status: FeedbackStatus): string {
  if (status === "in_progress") return "border-primary bg-primary/10 text-primary animate-pulse";
  if (status === "failed") return "border-destructive bg-destructive/10 text-destructive";
  if (status === "warning") return "border-warning-border bg-warning-muted text-warning-foreground";
  if (status === "resolved") return "border-success-border bg-success-muted text-success-foreground";
  if (status === "rejected") return "border-border text-muted-foreground line-through";
  if (status === "flagged") return "border-warning-border text-warning-foreground";
  if (status === "queued") return "border-primary/50 text-primary";
  return "border-border text-muted-foreground"; // pending
}

function isTerminalFeedbackStatus(status: FeedbackStatus): boolean {
  return status === "resolved" || status === "rejected";
}

export function isFeedbackCollapsedByDefault(status: FeedbackStatus): boolean {
  return isTerminalFeedbackStatus(status) || status === "warning";
}

/**
 * A PR is ready to merge when it has feedback items and every item
 * has reached a terminal state (resolved or rejected).
 */
export function isPRReadyToMerge(items: FeedbackItem[]): boolean {
  if (items.length === 0) return false;
  return items.every((item) => isTerminalFeedbackStatus(item.status));
}

export function countActiveFeedbackStatuses(items: FeedbackItem[]): {
  queued: number;
  inProgress: number;
  failed: number;
  warning: number;
} {
  return items.reduce(
    (counts, item) => {
      if (item.status === "queued") counts.queued += 1;
      else if (item.status === "in_progress") counts.inProgress += 1;
      else if (item.status === "failed") counts.failed += 1;
      else if (item.status === "warning") counts.warning += 1;
      return counts;
    },
    {
      queued: 0,
      inProgress: 0,
      failed: 0,
      warning: 0,
    },
  );
}
