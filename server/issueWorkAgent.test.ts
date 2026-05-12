import assert from "node:assert/strict";
import test from "node:test";
import { buildIssueWorkPrompt, extractIssueWorkSummary, runIssueWorkRepair } from "./issueWorkAgent";

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
