import type { PR, PRSummary } from "@shared/schema";
import { arePRFeedbackItemsResolved } from "@/lib/feedbackStatus";

export type PRReadinessCheck = {
  key: string;
  label: string;
  passed: boolean;
  detail: string;
};

export function isGitHubReadyToMerge(pr: Pick<PRSummary, "mergeableState">): boolean {
  return pr.mergeableState === "clean";
}

export function isPRSummaryReadyToMerge(
  pr: Pick<PRSummary, "status" | "testsPassed" | "lintPassed" | "mergeableState">,
): boolean {
  return pr.status !== "processing"
    && pr.status !== "error"
    && pr.status !== "archived"
    && pr.testsPassed !== false
    && pr.lintPassed !== false
    && isGitHubReadyToMerge(pr);
}

export function isPRDetailReadyToMerge(
  pr: Pick<PR, "status" | "testsPassed" | "lintPassed" | "mergeableState" | "feedbackItems">,
): boolean {
  return pr.status !== "processing"
    && pr.status !== "error"
    && pr.status !== "archived"
    && pr.testsPassed !== false
    && pr.lintPassed !== false
    && isGitHubReadyToMerge(pr)
    && arePRFeedbackItemsResolved(pr.feedbackItems);
}

export function buildPRReadinessChecks(
  pr: Pick<PR, "status" | "testsPassed" | "lintPassed" | "mergeableState" | "feedbackItems">,
): PRReadinessCheck[] {
  const feedbackResolved = arePRFeedbackItemsResolved(pr.feedbackItems);
  const unresolvedCount = pr.feedbackItems.filter((item) =>
    item.status !== "resolved" && item.status !== "rejected"
  ).length;

  return [
    {
      key: "work-state",
      label: "Automation idle",
      passed: pr.status !== "processing",
      detail: pr.status === "processing" ? "A work run is still active." : "No active work run.",
    },
    {
      key: "tests",
      label: "Tests passing",
      passed: pr.testsPassed !== false && isGitHubReadyToMerge(pr),
      detail: pr.testsPassed === true
        ? "Latest test result passed."
        : pr.testsPassed === false
          ? "Latest test result failed."
          : pr.mergeableState === "clean"
            ? "GitHub reports required checks are passing."
            : "No test result synced yet.",
    },
    {
      key: "lint",
      label: "Lint passing",
      passed: pr.lintPassed !== false,
      detail: pr.lintPassed === true
        ? "Latest lint result passed."
        : pr.lintPassed === false
          ? "Latest lint result failed."
          : "No separate lint result synced yet.",
    },
    {
      key: "comments",
      label: "Comments resolved",
      passed: feedbackResolved,
      detail: feedbackResolved
        ? "All tracked review feedback is resolved or rejected."
        : `${unresolvedCount} tracked feedback item${unresolvedCount === 1 ? "" : "s"} still need attention.`,
    },
    {
      key: "github",
      label: "GitHub mergeable",
      passed: isGitHubReadyToMerge(pr),
      detail: pr.mergeableState === "clean"
        ? "GitHub reports this PR is ready to merge."
        : `GitHub mergeable state is ${pr.mergeableState ?? "unknown"}.`,
    },
  ];
}
