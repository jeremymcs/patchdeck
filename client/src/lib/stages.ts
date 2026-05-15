import type { Issue, PR } from "@shared/schema";
import type { Stage } from "@/components/detail/StageProgressBar";

const ISSUE_PIPELINE: Array<{ key: NonNullable<Issue["workStage"]>; label: string }> = [
  { key: "queued", label: "Queued" },
  { key: "started", label: "Started" },
  { key: "working", label: "Working" },
  { key: "verifying", label: "Verifying" },
  { key: "opening_pr", label: "Opening PR" },
  { key: "completed", label: "Completed" },
];

export function buildIssueStages(issue: Pick<Issue, "workStage" | "workStatus">): Stage[] {
  const stage = issue.workStage ?? (issue.workStatus === "in_progress" ? "working" : issue.workStatus);
  const failed = issue.workStatus === "failed" || stage === "failed";
  const currentIndex = ISSUE_PIPELINE.findIndex((entry) => entry.key === stage);

  return ISSUE_PIPELINE.map((entry, index) => {
    if (failed && currentIndex >= 0 && index === currentIndex) {
      return { key: entry.key, label: entry.label, state: "failed" as const };
    }
    if (failed && index >= Math.max(currentIndex, 0)) {
      return { key: entry.key, label: entry.label, state: "pending" as const };
    }
    if (entry.key === "completed" && stage === "completed") {
      return { key: entry.key, label: entry.label, state: "done" as const };
    }
    if (currentIndex < 0) {
      return { key: entry.key, label: entry.label, state: "pending" as const };
    }
    if (index < currentIndex) {
      return { key: entry.key, label: entry.label, state: "done" as const };
    }
    if (index === currentIndex) {
      return { key: entry.key, label: entry.label, state: "active" as const };
    }
    return { key: entry.key, label: entry.label, state: "pending" as const };
  });
}

const PR_PIPELINE: Array<{ key: NonNullable<PR["prStage"]>; label: string }> = [
  { key: "feedback_synced", label: "Feedback synced" },
  { key: "triaged", label: "Triaged" },
  { key: "applying", label: "Applying" },
  { key: "tests", label: "Tests" },
  { key: "done", label: "Done" },
];

export function buildPRStages(pr: Pick<PR, "status" | "prStage">): Stage[] {
  const stage = pr.prStage ?? (pr.status === "done" || pr.status === "archived" ? "done" : "feedback_synced");
  if (pr.status === "archived") {
    return PR_PIPELINE.map((entry) => ({ key: entry.key, label: entry.label, state: "done" as const }));
  }
  const failed = pr.status === "error";
  const currentIndex = PR_PIPELINE.findIndex((entry) => entry.key === stage);

  return PR_PIPELINE.map((entry, index) => {
    if (failed && index === Math.max(currentIndex, 0)) {
      return { key: entry.key, label: entry.label, state: "failed" as const };
    }
    if (currentIndex < 0) {
      return { key: entry.key, label: entry.label, state: "pending" as const };
    }
    if (entry.key === "done" && stage === "done") {
      return { key: entry.key, label: entry.label, state: "done" as const };
    }
    if (index < currentIndex) {
      return { key: entry.key, label: entry.label, state: "done" as const };
    }
    if (index === currentIndex) {
      return { key: entry.key, label: entry.label, state: "active" as const };
    }
    return { key: entry.key, label: entry.label, state: "pending" as const };
  });
}
