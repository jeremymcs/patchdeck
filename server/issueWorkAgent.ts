import { readFile } from "node:fs/promises";
import type { AgentRuntimeSettings, CodingAgent, CommandResult } from "./agentRunner";
import { applyFixesWithAgent, runCommand, summarizeCommandResult } from "./agentRunner";
import { preparePrWorktree, removePrWorktree } from "./repoWorkspace";
import type { IssueSubtask, IssueSubtaskStatus } from "@shared/schema";
import path from "node:path";

const DEFAULT_GIT_USER_NAME = "PatchDeck";
const DEFAULT_GIT_USER_EMAIL = "patchdeck@local";

export type IssueWorkPromptInput = {
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  issueBody: string | null;
  labels: string[];
  author: string;
  baseBranch: string;
  agent: CodingAgent;
  agentSettings?: AgentRuntimeSettings;
  contributionGuidance?: string | null;
  subtasks?: IssueSubtask[];
};

export type IssueWorkRepairInput = IssueWorkPromptInput & {
  repoCloneUrl: string;
  rootDir?: string;
};

export type IssueWorkRepairResult = {
  accepted: boolean;
  rejectionReason: string | null;
  summary: string;
  fixBranch: string;
  agentResult: CommandResult;
  subtasks?: IssueSubtask[];
};

export type IssueWorkRepairDependencies = {
  preparePrWorktree: typeof preparePrWorktree;
  removePrWorktree: typeof removePrWorktree;
  applyFixesWithAgent: typeof applyFixesWithAgent;
  runCommand: typeof runCommand;
  readFile: typeof readFile;
};

function buildDeps(overrides?: Partial<IssueWorkRepairDependencies>): IssueWorkRepairDependencies {
  return {
    preparePrWorktree: overrides?.preparePrWorktree ?? preparePrWorktree,
    removePrWorktree: overrides?.removePrWorktree ?? removePrWorktree,
    applyFixesWithAgent: overrides?.applyFixesWithAgent ?? applyFixesWithAgent,
    runCommand: overrides?.runCommand ?? runCommand,
    readFile: overrides?.readFile ?? readFile,
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "issue";
}

function trimText(value: string, maxLength = 4000): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 1)}…`;
}

export function buildIssueWorkPrompt(input: IssueWorkPromptInput): string {
  const body = input.issueBody ? trimText(input.issueBody, 5000) : "No issue body provided.";
  const labels = input.labels.length > 0 ? input.labels.join(", ") : "none";
  const author = input.author || "unknown";
  const contributionGuidance = input.contributionGuidance?.trim();
  const guidance = contributionGuidance
    ? [
        "Repository contribution guidance:",
        "```",
        trimText(contributionGuidance, 6000),
        "```",
      ].join("\n")
    : [
        "Repository contribution guidance:",
        "- No CONTRIBUTING.md was found in the repository.",
        "- Use the concise issue-reply and PR-body templates below.",
      ].join("\n");

  const hasSubtasks = (input.subtasks?.length ?? 0) >= 2;
  const subtaskSection = hasSubtasks
    ? [
        "",
        "This issue describes multiple distinct bugs. Address each one separately:",
        ...input.subtasks!.map((task, idx) =>
          [
            `${idx + 1}. [${task.id}] ${task.title}`,
            task.summary ? `   ${task.summary}` : null,
          ].filter((line): line is string => Boolean(line)).join("\n"),
        ),
        "",
        "For each bug above, emit exactly one status line in this format (one line per bug):",
        "BUG_STATUS_<bug-id>: <done|skipped|deferred> — <one short sentence>",
        "Use `done` if you applied a fix, `skipped` if intentionally not fixed (explain why), `deferred` if it needs more investigation.",
        "Example: BUG_STATUS_bug-1: done — replaced exit-code check with explicit success-code list.",
        "",
        "For each bug you mark `done`, also emit one line listing the repo-relative files you changed for THAT bug:",
        "BUG_FILES_<bug-id>: path/one.ts, path/two.ts",
        "Example: BUG_FILES_bug-1: server/verifier.ts, server/exitCodes.ts",
        "List each file under the bug that primarily owns it. If a file truly spans multiple bugs, list it only under the first bug — the app will commit files first-claim-wins.",
      ].join("\n")
    : "";

  const instructions = hasSubtasks
    ? [
        "Instructions:",
        "1. Inspect each listed bug and the repository to understand the required fixes.",
        "2. Address each bug with the smallest change that resolves it. Commit separation is handled by the app — leave all edits unstaged.",
        "3. Run focused verification across all bugs before finishing.",
        "4. Emit one BUG_STATUS_<bug-id>: ... line for every bug listed above.",
        "5. Do not run git commit or git push.",
        "6. Leave the fix branch checked out with your edits in the worktree.",
      ].join("\n")
    : [
        "Instructions:",
        "1. Inspect the issue and the repository to understand the required fix.",
        "2. Make the minimal code change needed to resolve the issue.",
        "3. Run focused verification before finishing.",
        "4. Do not run git commit or git push.",
        "5. Leave the fix branch checked out with your edits in the worktree.",
      ].join("\n");

  return [
    "You are fixing a GitHub issue in this repository.",
    hasSubtasks
      ? "Address every listed bug below. Stay within the scope of the issue title and body."
      : "Make the smallest change that fully addresses the issue.\nStay within the scope of the issue title and body.",
    "Run the most relevant verification command(s) you can justify from the repo.",
    "Leave any file edits unstaged and uncommitted. The app will stage, commit, push, and open the PR.",
    "When a repository contribution file exists, follow it exactly.",
    "If no contribution file exists, keep the final summary concise and factual.",
    "",
    guidance,
    "",
    "Fallback response template:",
    "```",
    "## Summary",
    "-",
    "",
    "## Verification",
    "-",
    "",
    "## Related Issue",
    "- Closes #<issue-number>",
    "```",
    "At the end of your response, include exactly one line in this format:",
    "ISSUE_WORK_SUMMARY: <one short sentence describing the fix and verification>",
    subtaskSection,
    "",
    `Repository: ${input.repo}`,
    `Issue: #${input.issueNumber}`,
    `Title: ${input.issueTitle}`,
    `URL: ${input.issueUrl}`,
    `Author: ${author}`,
    `Labels: ${labels}`,
    `Base branch: ${input.baseBranch}`,
    `Agent: ${input.agent}`,
    "",
    "Issue body:",
    "```",
    body,
    "```",
    "",
    instructions,
  ].join("\n");
}

const BUG_STATUS_PATTERN = /^BUG_STATUS_([A-Za-z0-9_-]+):\s*(done|skipped|deferred)\s*(?:[—\-:]\s*(.+))?$/im;
const BUG_FILES_PATTERN = /^BUG_FILES_([A-Za-z0-9_-]+):\s*(.+)$/i;
const PORCELAIN_PATH_PATTERN = /^[?ACDMRTU!]{1,2}\s+(.*)$/;

export function extractBugFiles(stdout: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(BUG_FILES_PATTERN);
    if (!match) continue;
    const [, id, rawList] = match;
    const files = rawList
      .split(",")
      .map((entry) => entry.trim().replace(/^["'`]|["'`]$/g, ""))
      .filter(Boolean);
    if (files.length > 0) {
      result.set(id, files);
    }
  }
  return result;
}

export function parsePorcelainPaths(statusLines: string[]): string[] {
  const paths: string[] = [];
  for (const line of statusLines) {
    const match = line.match(PORCELAIN_PATH_PATTERN);
    if (!match) continue;
    const rest = match[1];
    const renameIdx = rest.indexOf(" -> ");
    paths.push(renameIdx >= 0 ? rest.slice(renameIdx + 4) : rest);
  }
  return paths;
}

export function extractBugStatuses(
  stdout: string,
  subtasks: IssueSubtask[],
): IssueSubtask[] {
  if (subtasks.length === 0) return subtasks;

  const lines = stdout.split(/\r?\n/);
  const byId = new Map<string, { status: IssueSubtaskStatus; reason: string | null }>();
  for (const line of lines) {
    const match = line.trim().match(BUG_STATUS_PATTERN);
    if (!match) continue;
    const [, rawId, rawStatus, rawReason] = match;
    const status = rawStatus.toLowerCase() as IssueSubtaskStatus;
    if (status !== "done" && status !== "skipped" && status !== "deferred") continue;
    byId.set(rawId, {
      status,
      reason: rawReason ? rawReason.trim().slice(0, 500) : null,
    });
  }

  return subtasks.map((task) => {
    const update = byId.get(task.id);
    if (!update) return task;
    return { ...task, status: update.status, statusReason: update.reason };
  });
}

export function extractIssueWorkSummary(stdout: string): string {
  const marker = stdout.match(/^ISSUE_WORK_SUMMARY:\s*(.+)$/m);
  if (marker?.[1]) {
    return marker[1].trim();
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    return "No agent summary provided";
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "No agent summary provided";
}

async function readHeadSha(
  deps: IssueWorkRepairDependencies,
  cwd: string,
): Promise<string> {
  const result = await deps.runCommand("git", ["-C", cwd, "rev-parse", "HEAD"], {
    timeoutMs: 10000,
  });

  if (result.code !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout.trim();
}

async function readFetchedHeadSha(
  deps: IssueWorkRepairDependencies,
  cwd: string,
): Promise<string> {
  const result = await deps.runCommand("git", ["-C", cwd, "rev-parse", "FETCH_HEAD"], {
    timeoutMs: 10000,
  });

  if (result.code !== 0) {
    throw new Error(`git rev-parse FETCH_HEAD failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout.trim();
}

type CommitFailureReason = { reason: string };

async function commitFiles(
  deps: IssueWorkRepairDependencies,
  worktreePath: string,
  filesToStage: "all" | string[],
  message: string,
): Promise<CommitFailureReason | null> {
  const addArgs = filesToStage === "all"
    ? ["-C", worktreePath, "add", "-A"]
    : ["-C", worktreePath, "add", "--", ...filesToStage];
  const addResult = await deps.runCommand("git", addArgs, { timeoutMs: 30000 });
  if (addResult.code !== 0) {
    return { reason: `git add failed: ${addResult.stderr || addResult.stdout}` };
  }

  const commitResult = await deps.runCommand(
    "git",
    ["-C", worktreePath, "commit", "-m", message],
    { timeoutMs: 60000 },
  );
  if (commitResult.code !== 0) {
    return { reason: `git commit failed: ${commitResult.stderr || commitResult.stdout}` };
  }

  return null;
}

async function commitWorktreeChanges(
  deps: IssueWorkRepairDependencies,
  params: {
    worktreePath: string;
    issueTitle: string;
    statusLines: string[];
    subtasks?: IssueSubtask[];
    agentStdout: string;
  },
): Promise<CommitFailureReason | null> {
  const { worktreePath, issueTitle, statusLines, subtasks, agentStdout } = params;
  const fallbackMessage = `fix(issue): ${issueTitle}`;

  const doneSubtasks = subtasks?.filter((task) => task.status === "done") ?? [];
  const bugFiles = doneSubtasks.length > 0 ? extractBugFiles(agentStdout) : new Map<string, string[]>();
  const hasFileMarkers = Array.from(bugFiles.values()).some((files) => files.length > 0);

  if (doneSubtasks.length === 0 || !hasFileMarkers) {
    return commitFiles(deps, worktreePath, "all", fallbackMessage);
  }

  const changedPaths = parsePorcelainPaths(statusLines);
  const remaining = new Set(changedPaths);
  let perBugCommits = 0;

  for (const task of doneSubtasks) {
    const claimed = (bugFiles.get(task.id) ?? []).filter((file) => remaining.has(file));
    if (claimed.length === 0) continue;

    const message = [
      `fix(${task.id}): ${task.title}`,
      task.statusReason ? `\n${task.statusReason}` : "",
    ].join("");

    const failure = await commitFiles(deps, worktreePath, claimed, message);
    if (failure) return failure;

    for (const file of claimed) remaining.delete(file);
    perBugCommits += 1;
  }

  if (remaining.size > 0) {
    const catchAllMessage = perBugCommits > 0
      ? `${fallbackMessage} — remaining changes`
      : fallbackMessage;
    return commitFiles(deps, worktreePath, "all", catchAllMessage);
  }

  if (perBugCommits === 0) {
    return { reason: "no committable changes after per-bug grouping" };
  }

  return null;
}

async function readGitStatusPorcelain(
  deps: IssueWorkRepairDependencies,
  cwd: string,
): Promise<string[]> {
  const result = await deps.runCommand("git", ["-C", cwd, "status", "--porcelain"], {
    timeoutMs: 10000,
  });

  if (result.code !== 0) {
    throw new Error(`git status failed: ${result.stderr || result.stdout}`);
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function ensureGitIdentity(worktreePath: string, runCommandFn: typeof runCommand): Promise<void> {
  const name = await runCommandFn("git", ["config", "--get", "user.name"], { cwd: worktreePath, timeoutMs: 3000 });
  if (name.code !== 0 || !name.stdout.trim()) {
    await runCommandFn("git", ["config", "user.name", DEFAULT_GIT_USER_NAME], { cwd: worktreePath, timeoutMs: 3000 });
  }

  const email = await runCommandFn("git", ["config", "--get", "user.email"], { cwd: worktreePath, timeoutMs: 3000 });
  if (email.code !== 0 || !email.stdout.trim()) {
    await runCommandFn("git", ["config", "user.email", DEFAULT_GIT_USER_EMAIL], { cwd: worktreePath, timeoutMs: 3000 });
  }
}

async function readOptionalTextFile(
  deps: IssueWorkRepairDependencies,
  filePath: string,
): Promise<string | null> {
  try {
    const content = await deps.readFile(filePath, "utf8");
    return content.trim().length > 0 ? content : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function formatBranchName(issueNumber: number, issueTitle: string): string {
  return `issue/${issueNumber}-${slugify(issueTitle)}-${Math.floor(Date.now() / 1000)}`;
}

export async function runIssueWorkRepair(
  input: IssueWorkRepairInput & {
    env?: NodeJS.ProcessEnv;
    dependencies?: Partial<IssueWorkRepairDependencies>;
  },
): Promise<IssueWorkRepairResult> {
  const deps = buildDeps(input.dependencies);
  const fixBranch = formatBranchName(input.issueNumber, input.issueTitle);
  const { repoCacheDir, worktreePath } = await deps.preparePrWorktree({
    rootDir: input.rootDir,
    repoFullName: input.repo,
    repoCloneUrl: input.repoCloneUrl,
    headRepoFullName: input.repo,
    headRepoCloneUrl: input.repoCloneUrl,
    headRef: input.baseBranch,
    prNumber: input.issueNumber,
    runId: `${input.issueNumber}-${Math.floor(Date.now() / 1000)}`,
    runCommand: deps.runCommand,
  });

  try {
    const repoContributionGuidance = await readOptionalTextFile(deps, path.join(worktreePath, "CONTRIBUTING.md"));
    const repoPullRequestTemplate = await readOptionalTextFile(
      deps,
      path.join(worktreePath, ".github", "pull_request_template.md"),
    );
    const repoPrompt = buildIssueWorkPrompt({
      ...input,
      contributionGuidance: [
        repoContributionGuidance ? `CONTRIBUTING.md:\n${repoContributionGuidance}` : null,
        repoPullRequestTemplate ? `.github/pull_request_template.md:\n${repoPullRequestTemplate}` : null,
      ].filter((value): value is string => Boolean(value)).join("\n\n") || null,
    });
    const branchCreate = await deps.runCommand(
      "git",
      ["-C", worktreePath, "checkout", "-b", fixBranch],
      { timeoutMs: 30000 },
    );
    if (branchCreate.code !== 0) {
      return {
        accepted: false,
        rejectionReason: `branch creation failed: ${branchCreate.stderr || branchCreate.stdout}`,
        summary: "No agent summary provided",
        fixBranch,
        agentResult: branchCreate,
      };
    }

    await ensureGitIdentity(worktreePath, deps.runCommand);

    const agentResult = await deps.applyFixesWithAgent({
      agent: input.agent,
      settings: input.agentSettings,
      cwd: worktreePath,
      prompt: repoPrompt,
      env: input.env,
    });

    if (agentResult.code !== 0) {
      return {
        accepted: false,
        rejectionReason: summarizeCommandResult(agentResult, `agent failed (${agentResult.code})`),
        summary: extractIssueWorkSummary(agentResult.stdout),
        fixBranch,
        agentResult,
        subtasks: input.subtasks,
      };
    }

    const statusLines = await readGitStatusPorcelain(deps, worktreePath);
    if (statusLines.length === 0) {
      return {
        accepted: false,
        rejectionReason: "agent did not produce any working tree changes",
        summary: extractIssueWorkSummary(agentResult.stdout),
        fixBranch,
        agentResult,
        subtasks: input.subtasks,
      };
    }

    const updatedSubtasks = input.subtasks
      ? extractBugStatuses(agentResult.stdout, input.subtasks)
      : undefined;
    const commitFailure = await commitWorktreeChanges(deps, {
      worktreePath,
      issueTitle: input.issueTitle,
      statusLines,
      subtasks: updatedSubtasks,
      agentStdout: agentResult.stdout,
    });
    if (commitFailure) {
      return {
        accepted: false,
        rejectionReason: commitFailure.reason,
        summary: extractIssueWorkSummary(agentResult.stdout),
        fixBranch,
        agentResult,
        subtasks: updatedSubtasks ?? input.subtasks,
      };
    }

    const localHeadSha = await readHeadSha(deps, worktreePath);
    const pushResult = await deps.runCommand(
      "git",
      ["-C", worktreePath, "push", "origin", `HEAD:${fixBranch}`],
      { timeoutMs: 60000 },
    );
    if (pushResult.code !== 0) {
      return {
        accepted: false,
        rejectionReason: `push failed: ${pushResult.stderr || pushResult.stdout}`,
        summary: extractIssueWorkSummary(agentResult.stdout),
        fixBranch,
        agentResult,
        subtasks: input.subtasks,
      };
    }

    const fetchResult = await deps.runCommand(
      "git",
      ["-C", repoCacheDir, "fetch", "origin", fixBranch],
      { timeoutMs: 120000 },
    );
    if (fetchResult.code !== 0) {
      return {
        accepted: false,
        rejectionReason: `verification fetch failed: ${fetchResult.stderr || fetchResult.stdout}`,
        summary: extractIssueWorkSummary(agentResult.stdout),
        fixBranch,
        agentResult,
        subtasks: input.subtasks,
      };
    }

    const remoteHeadSha = await readFetchedHeadSha(deps, repoCacheDir);
    if (remoteHeadSha !== localHeadSha) {
      return {
        accepted: false,
        rejectionReason: `remote branch ${fixBranch} did not match pushed commit ${localHeadSha}`,
        summary: extractIssueWorkSummary(agentResult.stdout),
        fixBranch,
        agentResult,
        subtasks: input.subtasks,
      };
    }

    return {
      accepted: true,
      rejectionReason: null,
      summary: extractIssueWorkSummary(agentResult.stdout),
      fixBranch,
      agentResult,
      subtasks: updatedSubtasks,
    };
  } finally {
    await deps.removePrWorktree({
      repoCacheDir,
      worktreePath,
      runCommand: deps.runCommand,
    });
  }
}
