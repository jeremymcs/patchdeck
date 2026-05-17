import type { CurrentRunStatus, Issue, PR, PRStatus } from "@shared/schema";
import type { StatusTone } from "@/lib/statusTones";

export function formatPRWorkState(status: PRStatus, prStage?: PR["prStage"]): string {
  if (status === "processing") {
    if (prStage === "feedback_synced") return "feedback synced";
    if (prStage === "triaged") return "triaged";
    if (prStage === "applying") return "applying fixes";
    if (prStage === "tests") return "verifying checks";
    if (prStage === "done") return "work finished";
    return "automation running";
  }

  if (status === "done") return "work finished";
  if (status === "error") return "needs attention";
  if (status === "archived") return "archived";
  return "watching";
}

export function prWorkStateTone(status: PRStatus): StatusTone {
  if (status === "error") return "destructive";
  if (status === "processing") return "primary";
  if (status === "archived") return "success";
  return "neutral";
}

export function formatCurrentRunStatus(status: CurrentRunStatus["status"]): string {
  if (status === "completed") return "run finished";
  return status.replace("_", " ");
}

export function formatIssueWorkStage(issue: Pick<Issue, "workStage" | "workStatus">): string {
  const stage = issue.workStage ?? (
    issue.workStatus === "in_progress" ? "working" : issue.workStatus
  );

  if (stage === "completed") return "work finished";
  return stage.replace("_", " ");
}

export function formatIssueAutoWorkState(
  issue: Pick<Issue, "autoWorkEligible" | "autoWorkBlockedReason">,
): string {
  if (issue.autoWorkEligible) return "ready to work";
  return issue.autoWorkBlockedReason ?? "manual only";
}

export function autoWorkStateTone(eligible: boolean | undefined): StatusTone {
  return eligible ? "primary" : "neutral";
}
