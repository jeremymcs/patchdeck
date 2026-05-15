import assert from "node:assert/strict";
import test from "node:test";
import { buildIssueWorkPrompt, extractBugFiles, extractBugStatuses, extractIssueWorkSummary, parsePorcelainPaths, runIssueWorkRepair } from "./issueWorkAgent";
import type { IssueSubtask } from "@shared/schema";

test("buildIssueWorkPrompt includes the issue context and verification instructions", () => {
  const prompt = buildIssueWorkPrompt({
    repo: "acme/widgets",
    issueNumber: 17,
    issueTitle: "Fix the toggle",
    issueUrl: "https://github.com/acme/widgets/issues/17",
    issueBody: "The toggle is stuck",
    labels: ["bug", "ui"],
    author: "alice",
    baseBranch: "main",
    agent: "claude",
  });

  assert.match(prompt, /Repository: acme\/widgets/);
  assert.match(prompt, /Issue: #17/);
  assert.match(prompt, /ISSUE_WORK_SUMMARY:/);
  assert.match(prompt, /Run the most relevant verification command/);
});

test("buildIssueWorkPrompt includes repository contribution guidance when present", () => {
  const prompt = buildIssueWorkPrompt({
    repo: "acme/widgets",
    issueNumber: 17,
    issueTitle: "Fix the toggle",
    issueUrl: "https://github.com/acme/widgets/issues/17",
    issueBody: "The toggle is stuck",
    labels: [],
    author: "alice",
    baseBranch: "main",
    agent: "claude",
    contributionGuidance: "Keep changes small and update tests.",
  });

  assert.match(prompt, /Repository contribution guidance:/);
  assert.match(prompt, /Keep changes small and update tests\./);
});

test("runIssueWorkRepair commits, pushes, and verifies the issue branch", async () => {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  let agentPrompt = "";
  let branch = "";
  const deps = {
    preparePrWorktree: async () => ({
      repoCacheDir: "/tmp/repo-cache",
      worktreePath: "/tmp/worktree",
    }),
    removePrWorktree: async () => undefined,
    applyFixesWithAgent: async (input) => {
      agentPrompt = input.prompt;
      return {
        code: 0,
        stdout: "ISSUE_WORK_SUMMARY: fixed the toggle",
        stderr: "",
      };
    },
    readFile: async (filePath: string) => {
      if (filePath === "/tmp/worktree/CONTRIBUTING.md") {
        return "Follow the repo checklist.";
      }
      if (filePath === "/tmp/worktree/.github/pull_request_template.md") {
        return "## Summary\n-";
      }

      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    runCommand: async (command: string, args: string[], options?: { cwd?: string }) => {
      calls.push({ command, args, cwd: options?.cwd });
      const key = `${command}${options?.cwd ? ` @${options.cwd}` : ""} ${args.join(" ")}`;

      if (command === "git" && args[0] === "-C" && args[1] === "/tmp/worktree" && args[2] === "checkout" && args[3] === "-b" && typeof args[4] === "string") {
        branch = args[4];
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "git @/tmp/worktree config --get user.name") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (key === "git @/tmp/worktree config user.name PR Babysitter") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "git @/tmp/worktree config --get user.email") {
        return { stdout: "", stderr: "", code: 1 };
      }
      if (key === "git @/tmp/worktree config user.email pr-babysitter@local") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "git -C /tmp/worktree status --porcelain") {
        return { stdout: " M src/toggle.ts\n", stderr: "", code: 0 };
      }
      if (key === "git -C /tmp/worktree add -A") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "git -C /tmp/worktree commit -m fix(issue): Fix the toggle") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "git -C /tmp/worktree rev-parse HEAD") {
        return { stdout: "abc123\n", stderr: "", code: 0 };
      }
      if (branch && key === `git -C /tmp/worktree push origin HEAD:${branch}`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (branch && key === `git -C /tmp/repo-cache fetch origin ${branch}`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === "git -C /tmp/repo-cache rev-parse FETCH_HEAD") {
        return { stdout: "abc123\n", stderr: "", code: 0 };
      }

      throw new Error(`Unexpected command: ${key}`);
    },
  };

  const result = await runIssueWorkRepair({
    repo: "acme/widgets",
    issueNumber: 17,
    issueTitle: "Fix the toggle",
    issueUrl: "https://github.com/acme/widgets/issues/17",
    issueBody: "The toggle is stuck",
    labels: ["bug"],
    author: "alice",
    baseBranch: "main",
    repoCloneUrl: "https://github.com/acme/widgets.git",
    agent: "claude",
    dependencies: deps,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.summary, "fixed the toggle");
  assert.ok(result.fixBranch.startsWith("issue/17-fix-the-toggle-"));
  assert.equal(result.fixBranch, branch);
  assert.ok(calls.some((call) => call.command === "git" && call.args[0] === "-C" && call.args[1] === "/tmp/worktree" && call.args[2] === "checkout"));
  assert.match(agentPrompt, /Follow the repo checklist\./);
  assert.match(agentPrompt, /pull_request_template\.md/);
  assert.match(extractIssueWorkSummary("ISSUE_WORK_SUMMARY: fixed the toggle"), /fixed the toggle/);
});

const SAMPLE_SUBTASKS: IssueSubtask[] = [
  { id: "bug-1", title: "Verifier exit code inverted", summary: "Treats 0 as the only pass.", status: "pending" },
  { id: "bug-2", title: "Preference overrides plan", summary: "Falls back to preference silently.", status: "pending" },
];

test("buildIssueWorkPrompt enumerates bugs and demands BUG_STATUS markers when subtasks present", () => {
  const prompt = buildIssueWorkPrompt({
    repo: "acme/widgets",
    issueNumber: 42,
    issueTitle: "Five verifier bugs",
    issueUrl: "https://example.test/42",
    issueBody: "lots of bugs",
    labels: [],
    author: "alice",
    baseBranch: "main",
    agent: "claude",
    subtasks: SAMPLE_SUBTASKS,
  });

  assert.match(prompt, /multiple distinct bugs/);
  assert.match(prompt, /\[bug-1\] Verifier exit code inverted/);
  assert.match(prompt, /\[bug-2\] Preference overrides plan/);
  assert.match(prompt, /BUG_STATUS_<bug-id>/);
  assert.match(prompt, /Emit one BUG_STATUS_<bug-id>/);
});

test("buildIssueWorkPrompt omits multi-bug instructions when subtasks <2", () => {
  const prompt = buildIssueWorkPrompt({
    repo: "acme/widgets",
    issueNumber: 42,
    issueTitle: "Single bug",
    issueUrl: "https://example.test/42",
    issueBody: "one bug",
    labels: [],
    author: "alice",
    baseBranch: "main",
    agent: "claude",
    subtasks: [SAMPLE_SUBTASKS[0]],
  });

  assert.doesNotMatch(prompt, /multiple distinct bugs/);
  assert.doesNotMatch(prompt, /BUG_STATUS_/);
});

test("extractBugStatuses applies markers from stdout, preserves un-marked bugs as pending", () => {
  const stdout = [
    "Some output…",
    "BUG_STATUS_bug-1: done — replaced exit-code check with explicit success list.",
    "ISSUE_WORK_SUMMARY: fixed two bugs",
  ].join("\n");

  const updated = extractBugStatuses(stdout, SAMPLE_SUBTASKS);
  assert.equal(updated.length, 2);
  assert.equal(updated[0].status, "done");
  assert.equal(updated[0].statusReason, "replaced exit-code check with explicit success list.");
  assert.equal(updated[1].status, "pending");
  assert.equal(updated[1].statusReason ?? null, null);
});

test("extractBugStatuses accepts skipped and deferred statuses with ASCII dash", () => {
  const stdout = [
    "BUG_STATUS_bug-1: skipped - intentional no-op for safety gate.",
    "BUG_STATUS_bug-2: deferred — needs instrumentation in the dispatch loop.",
  ].join("\n");

  const updated = extractBugStatuses(stdout, SAMPLE_SUBTASKS);
  assert.equal(updated[0].status, "skipped");
  assert.equal(updated[0].statusReason, "intentional no-op for safety gate.");
  assert.equal(updated[1].status, "deferred");
  assert.match(updated[1].statusReason ?? "", /instrumentation/);
});

test("extractBugFiles parses comma-separated file lists per bug", () => {
  const stdout = [
    "BUG_FILES_bug-1: server/verifier.ts, server/exitCodes.ts",
    `BUG_FILES_bug-2: "server/preference.ts"`,
    "BUG_FILES_bug-3: ",
  ].join("\n");

  const files = extractBugFiles(stdout);
  assert.deepEqual(files.get("bug-1"), ["server/verifier.ts", "server/exitCodes.ts"]);
  assert.deepEqual(files.get("bug-2"), ["server/preference.ts"]);
  assert.equal(files.has("bug-3"), false);
});

test("parsePorcelainPaths handles modified, added, untracked, and renamed files", () => {
  const paths = parsePorcelainPaths([
    "M server/verifier.ts",
    "?? newfile.ts",
    "A  server/added.ts",
    "R  old/path.ts -> new/path.ts",
  ]);
  assert.deepEqual(paths, [
    "server/verifier.ts",
    "newfile.ts",
    "server/added.ts",
    "new/path.ts",
  ]);
});

test("extractBugStatuses ignores unknown bug ids and invalid statuses", () => {
  const stdout = [
    "BUG_STATUS_bug-99: done — never existed",
    "BUG_STATUS_bug-1: wat — not a valid status",
  ].join("\n");

  const updated = extractBugStatuses(stdout, SAMPLE_SUBTASKS);
  assert.equal(updated[0].status, "pending");
  assert.equal(updated[1].status, "pending");
});

type GitCall = { args: string[] };

function buildMultiBugDeps(options: {
  porcelainStdout: string;
  agentStdout: string;
  gitCalls: GitCall[];
}) {
  let branch = "";
  return {
    deps: {
      preparePrWorktree: async () => ({
        repoCacheDir: "/tmp/repo-cache",
        worktreePath: "/tmp/worktree",
      }),
      removePrWorktree: async () => undefined,
      applyFixesWithAgent: async () => ({
        code: 0,
        stdout: options.agentStdout,
        stderr: "",
      }),
      readFile: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      runCommand: async (command: string, args: string[]) => {
        if (command !== "git") {
          throw new Error(`Unexpected command: ${command}`);
        }
        options.gitCalls.push({ args });
        const key = args.join(" ");

        if (args[2] === "checkout" && args[3] === "-b") {
          branch = args[4]!;
          return { stdout: "", stderr: "", code: 0 };
        }
        if (args[0] === "config") {
          return { stdout: args[1] === "--get" ? "set\n" : "", stderr: "", code: 0 };
        }
        if (key === "-C /tmp/worktree status --porcelain") {
          return { stdout: options.porcelainStdout, stderr: "", code: 0 };
        }
        if (args[2] === "add" || args[2] === "commit") {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (key === "-C /tmp/worktree rev-parse HEAD") {
          return { stdout: "abc123\n", stderr: "", code: 0 };
        }
        if (key === `-C /tmp/worktree push origin HEAD:${branch}`) {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (key === `-C /tmp/repo-cache fetch origin ${branch}`) {
          return { stdout: "", stderr: "", code: 0 };
        }
        if (key === "-C /tmp/repo-cache rev-parse FETCH_HEAD") {
          return { stdout: "abc123\n", stderr: "", code: 0 };
        }
        throw new Error(`Unexpected git args: ${key}`);
      },
    },
  };
}

const TWO_BUG_SUBTASKS: IssueSubtask[] = [
  { id: "bug-1", title: "Exit code inverted", summary: "x", status: "pending" },
  { id: "bug-2", title: "Preference overrides plan", summary: "x", status: "pending" },
];

test("runIssueWorkRepair makes one commit per bug when BUG_FILES markers are present", async () => {
  const gitCalls: GitCall[] = [];
  const { deps } = buildMultiBugDeps({
    porcelainStdout: " M server/verifier.ts\n M server/preference.ts\n",
    agentStdout: [
      "BUG_STATUS_bug-1: done — fixed exit code logic",
      "BUG_FILES_bug-1: server/verifier.ts",
      "BUG_STATUS_bug-2: done — read plan first",
      "BUG_FILES_bug-2: server/preference.ts",
      "ISSUE_WORK_SUMMARY: two fixes",
    ].join("\n"),
    gitCalls,
  });

  const result = await runIssueWorkRepair({
    repo: "acme/widgets",
    issueNumber: 42,
    issueTitle: "Verifier bugs",
    issueUrl: "https://example.test/42",
    issueBody: "lots of bugs",
    labels: [],
    author: "alice",
    baseBranch: "main",
    repoCloneUrl: "https://example.test/acme/widgets.git",
    agent: "claude",
    subtasks: TWO_BUG_SUBTASKS,
    dependencies: deps,
  });

  assert.equal(result.accepted, true);
  const commitCalls = gitCalls.filter((c) => c.args[2] === "commit");
  assert.equal(commitCalls.length, 2);
  assert.match(commitCalls[0].args[4]!, /^fix\(bug-1\): Exit code inverted/);
  assert.match(commitCalls[1].args[4]!, /^fix\(bug-2\): Preference overrides plan/);

  const addCalls = gitCalls.filter((c) => c.args[2] === "add");
  assert.equal(addCalls.length, 2);
  assert.ok(addCalls[0].args.includes("server/verifier.ts"));
  assert.ok(addCalls[1].args.includes("server/preference.ts"));
  assert.equal(result.subtasks?.[0].status, "done");
});

test("runIssueWorkRepair uses first-claim-wins on overlap and catch-all for orphans", async () => {
  const gitCalls: GitCall[] = [];
  const { deps } = buildMultiBugDeps({
    porcelainStdout: " M server/shared.ts\n M server/other.ts\n M server/orphan.ts\n",
    agentStdout: [
      "BUG_STATUS_bug-1: done — first claim",
      "BUG_FILES_bug-1: server/shared.ts, server/other.ts",
      "BUG_STATUS_bug-2: done — overlapping claim",
      "BUG_FILES_bug-2: server/shared.ts",
      "ISSUE_WORK_SUMMARY: overlap test",
    ].join("\n"),
    gitCalls,
  });

  await runIssueWorkRepair({
    repo: "acme/widgets",
    issueNumber: 42,
    issueTitle: "Overlap",
    issueUrl: "https://example.test/42",
    issueBody: "x",
    labels: [],
    author: "alice",
    baseBranch: "main",
    repoCloneUrl: "https://example.test/acme/widgets.git",
    agent: "claude",
    subtasks: TWO_BUG_SUBTASKS,
    dependencies: deps,
  });

  const commitMessages = gitCalls.filter((c) => c.args[2] === "commit").map((c) => c.args[4]!);
  // bug-1 takes both shared.ts and other.ts; bug-2's only claim (shared.ts) was taken by bug-1
  // so bug-2 makes no commit. orphan.ts goes to the catch-all.
  assert.equal(commitMessages.length, 2);
  assert.match(commitMessages[0], /^fix\(bug-1\)/);
  assert.match(commitMessages[1], /remaining changes/);

  const bug1Add = gitCalls.find(
    (c) => c.args[2] === "add" && c.args.includes("server/shared.ts") && c.args.includes("server/other.ts"),
  );
  assert.ok(bug1Add, "bug-1 commit should stage both shared.ts and other.ts");
});

test("runIssueWorkRepair falls back to single commit when no BUG_FILES markers", async () => {
  const gitCalls: GitCall[] = [];
  const { deps } = buildMultiBugDeps({
    porcelainStdout: " M server/something.ts\n",
    agentStdout: [
      "BUG_STATUS_bug-1: done — did it",
      "BUG_STATUS_bug-2: done — also did it",
      "ISSUE_WORK_SUMMARY: no files marked",
    ].join("\n"),
    gitCalls,
  });

  const result = await runIssueWorkRepair({
    repo: "acme/widgets",
    issueNumber: 42,
    issueTitle: "No markers",
    issueUrl: "https://example.test/42",
    issueBody: "x",
    labels: [],
    author: "alice",
    baseBranch: "main",
    repoCloneUrl: "https://example.test/acme/widgets.git",
    agent: "claude",
    subtasks: TWO_BUG_SUBTASKS,
    dependencies: deps,
  });

  assert.equal(result.accepted, true);
  const commitCalls = gitCalls.filter((c) => c.args[2] === "commit");
  assert.equal(commitCalls.length, 1);
  assert.equal(commitCalls[0].args[4], "fix(issue): No markers");
  const addCalls = gitCalls.filter((c) => c.args[2] === "add");
  assert.equal(addCalls.length, 1);
  assert.equal(addCalls[0].args[3], "-A");
});
