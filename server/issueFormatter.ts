import type { IssueSubtask } from "@shared/schema";

function normalizeSectionLines(text: string | null | undefined, fallback: string): string[] {
  const trimmed = text?.trim();
  if (!trimmed) {
    return [fallback];
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[*-]\s+/, ""));

  return lines.length > 0 ? lines : [fallback];
}

function bulletLines(lines: string[]): string[] {
  return lines.map((line) => `- ${line}`);
}

function redactLocalPaths(text: string): string {
  return text
    .replace(/(?:[A-Za-z]:\\(?:[^\\\s`'"]+\\)+[^\\\s`'"]+|\/(?:Users|home|Volumes|private|var|tmp|opt|usr|Applications|Library)(?:\/[^\s`'"]+)+)/g, "[path redacted]");
}

type IssueWorkBodyInput = {
  repoFullName: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  summary: string;
};

type IssueReplyBodyInput = IssueWorkBodyInput & {
  prNumber: number;
  prUrl: string;
  branch: string;
};

type PullRequestBodyInput = IssueWorkBodyInput & {
  branch: string;
  subtasks?: IssueSubtask[];
};

function formatBugsAddressedSection(subtasks: IssueSubtask[]): string[] {
  if (subtasks.length < 2) return [];
  const lines = ["## Bugs Addressed"];
  for (const task of subtasks) {
    const marker = task.status === "done" ? "x" : " ";
    const suffix = task.status === "done"
      ? ""
      : ` _(${task.status}${task.statusReason ? `: ${task.statusReason}` : ""})_`;
    lines.push(`- [${marker}] **${task.title}**${suffix}`);
  }
  lines.push("");
  return lines;
}

type IssueWorkStatusStage = "started" | "verifying" | "failed";

type IssueWorkStatusCommentInput = {
  repoFullName: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  stage: IssueWorkStatusStage;
  detail?: string | null;
};

export function buildIssueReplyBody(input: IssueReplyBodyInput): string {
  const summaryLines = bulletLines(normalizeSectionLines(input.summary, "No summary provided."));

  return [
    `Worked issue #${input.issueNumber} into PR #${input.prNumber}.`,
    "",
    "## Summary",
    ...summaryLines,
    "",
    "## Verification",
    "- Completed in the repository worktree before push.",
    "",
    "## Issue",
    `- [#${input.issueNumber} ${input.issueTitle}](${input.issueUrl})`,
    `- Repo: \`${input.repoFullName}\``,
    "",
    "## Pull Request",
    `- [#${input.prNumber}](${input.prUrl})`,
    `- Branch: \`${input.branch}\``,
  ].join("\n");
}

export function buildPullRequestBody(input: PullRequestBodyInput): string {
  const summaryLines = bulletLines(normalizeSectionLines(input.summary, "No summary provided."));
  const bugsSection = input.subtasks ? formatBugsAddressedSection(input.subtasks) : [];

  return [
    "## Summary",
    ...summaryLines,
    "",
    ...bugsSection,
    "## Verification",
    "- Completed in the repository worktree before push.",
    "",
    "## Related Issue",
    `- Closes #${input.issueNumber}`,
    `- [#${input.issueNumber} ${input.issueTitle}](${input.issueUrl})`,
    "",
    "## Repo",
    `- \`${input.repoFullName}\``,
    "",
    "## Branch",
    `- \`${input.branch}\``,
  ].join("\n");
}

type IssueVerifyCommentInput = {
  repoFullName: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  prNumber: number;
  prUrl: string;
  subtasks: IssueSubtask[];
  doneCount: number;
  totalCount: number;
};

export function buildIssueVerifyComment(input: IssueVerifyCommentInput): string {
  const issueLink = `[#${input.issueNumber} ${input.issueTitle}](${input.issueUrl})`;
  const allDone = input.totalCount > 0 && input.doneCount === input.totalCount;
  const header = allDone
    ? `✅ **Verification — all ${input.totalCount} ${input.totalCount === 1 ? "task is" : "tasks are"} addressed**`
    : `🔎 **Verification — ${input.doneCount} of ${input.totalCount} addressed**`;

  const checklist = input.subtasks.length === 0
    ? ["- _No subtasks recorded for this issue._"]
    : input.subtasks.map((task) => {
      const marker = task.status === "done" ? "x" : " ";
      const suffix = task.status === "done"
        ? ""
        : ` _(${task.status}${task.statusReason ? `: ${task.statusReason}` : ""})_`;
      return `- [${marker}] **${task.title}**${suffix}`;
    });

  return [
    header,
    "",
    `Re-checked PR #${input.prNumber} against ${issueLink}.`,
    "",
    "## Subtasks",
    ...checklist,
    "",
    `_Re-run from Patchdeck to refresh._`,
  ].join("\n");
}

export function buildIssueWorkStatusComment(input: IssueWorkStatusCommentInput): string {
  const issueLine = `[#${input.issueNumber} ${input.issueTitle}](${input.issueUrl})`;
  const detailLine = input.detail?.trim();
  const safeDetailLine = detailLine ? redactLocalPaths(detailLine) : null;

  switch (input.stage) {
    case "started":
      return [
        `⏳ **Issue work started** — beginning work on ${issueLine}.`,
        "",
        `- Repo: \`${input.repoFullName}\``,
        `- Issue: ${issueLine}`,
      ].join("\n");
    case "verifying":
      return [
        `✅ **Issue work verified** — code changes are ready for PR creation on ${issueLine}.`,
        "",
        `- Repo: \`${input.repoFullName}\``,
        safeDetailLine ? `- ${safeDetailLine}` : "- Verification finished in the worktree.",
      ].join("\n");
    case "failed":
      return [
        `❌ **Issue work failed** — ${issueLine}.`,
        "",
        `- Repo: \`${input.repoFullName}\``,
        `- Reason: ${safeDetailLine || "No failure details provided."}`,
      ].join("\n");
  }
}
