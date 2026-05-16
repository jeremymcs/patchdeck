import type { PR, PRSummary } from "@shared/schema";
import { isPRReadyToMerge } from "@/lib/feedbackStatus";

export function isGitHubReadyToMerge(pr: Pick<PRSummary, "mergeableState">): boolean {
  return pr.mergeableState === "clean";
}

export function isPRSummaryReadyToMerge(
  pr: Pick<PRSummary, "status" | "testsPassed" | "lintPassed" | "mergeableState">,
): boolean {
  return pr.status === "done"
    && pr.testsPassed === true
    && pr.lintPassed === true
    && isGitHubReadyToMerge(pr);
}

export function isPRDetailReadyToMerge(
  pr: Pick<PR, "status" | "testsPassed" | "lintPassed" | "mergeableState" | "feedbackItems">,
): boolean {
  return pr.status !== "processing"
    && pr.testsPassed === true
    && pr.lintPassed === true
    && isGitHubReadyToMerge(pr)
    && isPRReadyToMerge(pr.feedbackItems);
}
