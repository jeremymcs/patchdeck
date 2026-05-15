import type { Issue, PR } from "@shared/schema";

export type StatusTone = "neutral" | "primary" | "success" | "warning" | "destructive";

export function toneChipClass(tone: StatusTone): string {
  switch (tone) {
    case "primary":
      return "border-primary bg-primary/10 text-primary";
    case "success":
      return "border-success-border bg-success-muted text-success-foreground";
    case "warning":
      return "border-warning-border bg-warning-muted text-warning-foreground";
    case "destructive":
      return "border-destructive bg-destructive/10 text-destructive";
    case "neutral":
    default:
      return "border-border text-muted-foreground";
  }
}

export function toneRailClass(tone: StatusTone): string {
  switch (tone) {
    case "primary":
      return "border-l-primary";
    case "success":
      return "border-l-success-border";
    case "warning":
      return "border-l-warning-border";
    case "destructive":
      return "border-l-destructive";
    case "neutral":
    default:
      return "border-l-border";
  }
}

export function toneHeaderAccentClass(tone: StatusTone): string {
  switch (tone) {
    case "primary":
      return "border-t-primary";
    case "success":
      return "border-t-success-border";
    case "warning":
      return "border-t-warning-border";
    case "destructive":
      return "border-t-destructive";
    case "neutral":
    default:
      return "border-t-border";
  }
}

export function toneFailedBgClass(failed: boolean): string {
  return failed ? "bg-destructive/[0.04]" : "";
}

export function prStatusTone(pr: Pick<PR, "status">): StatusTone {
  if (pr.status === "error") return "destructive";
  if (pr.status === "processing") return "primary";
  if (pr.status === "done") return "success";
  return "neutral";
}

export function issueRowTone(issue: Pick<Issue, "workStatus" | "workPrUrl">): StatusTone {
  if (issue.workStatus === "failed") return "destructive";
  if (issue.workStatus === "in_progress") return "primary";
  if (issue.workStatus === "queued") return "primary";
  if (issue.workPrUrl) return "success";
  return "neutral";
}

export function issueWorkStatusTone(workStatus: Issue["workStatus"]): StatusTone {
  if (workStatus === "failed") return "destructive";
  if (workStatus === "in_progress") return "primary";
  if (workStatus === "queued") return "primary";
  return "neutral";
}

export function issueEvaluationTone(status: Issue["evaluationStatus"]): StatusTone {
  if (status === "approved") return "success";
  if (status === "blocked") return "destructive";
  if (status === "needs_review") return "warning";
  return "neutral";
}

export function autoWorkTone(eligible: boolean | undefined): StatusTone {
  return eligible ? "success" : "neutral";
}
