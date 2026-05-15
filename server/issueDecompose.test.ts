import assert from "node:assert/strict";
import test from "node:test";
import type { CommandResult } from "./agentRunner";
import { decomposeFromHeuristic, decomposeIssueBody, hashIssueBody } from "./issueDecompose";

const MULTI_BUG_BODY = `## Summary

Auto-mode marked T01–T04 as failed. Root cause is **five distinct bugs**.

## Bug 1 — \`grep\` absence-check inverted (P0)

The verifier treats \`exitCode === 0\` as the only pass condition.

**Evidence:** T01-VERIFY.json shows exitCode 1, verdict fail.

## Bug 2 — \`discoverySource: "preference"\` silently overrides the plan (P0)

When the verifier cannot parse the plan's verification section, it falls back to a global preference.

## Bug 3 — Project test runner path not resolved (P1)

T02/T03/T04 VERIFY.json all show command pytest, exitCode 127.

## Bug 4 — Safety system flags artifacts as 396 unexpected changes (P2)

Pre-verification gate flagged 396 files outside the task plan.

## Bug 5 — Subagent dispatch silently dies after model setup (P0)

Only thinking_level_change and model_change events, no tool calls.
`;

const SINGLE_BUG_BODY = `## Summary

The login button does not respond on Safari 17.

## Steps to reproduce

1. Open the page on Safari.
2. Click the login button.
3. Nothing happens.

## Expected

Login modal should appear.
`;

function buildResult(stdout: string, code = 0): CommandResult {
  return {
    code,
    stdout,
    stderr: "",
    durationMs: 1,
    timedOut: false,
  };
}

test("decomposeFromHeuristic extracts ## Bug N headers", () => {
  const tasks = decomposeFromHeuristic(MULTI_BUG_BODY);
  assert.equal(tasks.length, 5);
  assert.equal(tasks[0].id, "bug-1");
  assert.match(tasks[0].title, /grep.+absence-check inverted/);
  assert.equal(tasks[0].status, "pending");
  assert.ok(tasks[0].summary.includes("exitCode"));
  assert.equal(tasks[4].id, "bug-5");
  assert.match(tasks[4].title, /Subagent dispatch/);
});

test("decomposeFromHeuristic returns [] for single-bug bodies", () => {
  assert.deepEqual(decomposeFromHeuristic(SINGLE_BUG_BODY), []);
});

test("decomposeFromHeuristic also recognizes ### and plain 'Bug N — title' lines", () => {
  const body = `Intro paragraph.

### Bug 1 — first
First details.

### Bug 2 — second
Second details.
`;
  const tasks = decomposeFromHeuristic(body);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[1].id, "bug-2");

  const plain = `Intro.

Bug 1 — alpha
alpha body

Bug 2 — beta
beta body
`;
  const plainTasks = decomposeFromHeuristic(plain);
  assert.equal(plainTasks.length, 2);
  assert.equal(plainTasks[0].title, "alpha");
});

test("hashIssueBody is stable and changes with body changes", () => {
  const a = hashIssueBody("hello");
  const b = hashIssueBody("hello");
  const c = hashIssueBody("hello!");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(hashIssueBody(null).length, 32);
});

test("decomposeIssueBody skips short bodies without invoking the agent", async () => {
  let called = false;
  const tasks = await decomposeIssueBody(
    { body: "tiny body", agent: "claude" },
    {
      runOneShot: async () => {
        called = true;
        return buildResult("[]");
      },
    },
  );
  assert.deepEqual(tasks, []);
  assert.equal(called, false);
});

test("decomposeIssueBody uses heuristic without invoking the agent when it succeeds", async () => {
  let called = false;
  const tasks = await decomposeIssueBody(
    { body: MULTI_BUG_BODY, agent: "claude" },
    {
      runOneShot: async () => {
        called = true;
        return buildResult("[]");
      },
    },
  );
  assert.equal(called, false);
  assert.equal(tasks.length, 5);
});

test("decomposeIssueBody falls back to the agent when heuristic finds <2 bugs", async () => {
  const seenAgents: string[] = [];
  const tasks = await decomposeIssueBody(
    {
      body: SINGLE_BUG_BODY + "\n\nAlso unrelated: the export button crashes the tab.\n".repeat(5),
      agent: "codex",
    },
    {
      runOneShot: async (params) => {
        seenAgents.push(params.agent);
        return buildResult(
          JSON.stringify([
            { title: "Login button unresponsive", summary: "Safari 17 does not fire click events." },
            { title: "Export button crashes tab", summary: "Memory blowup on large exports." },
          ]),
        );
      },
    },
  );
  assert.deepEqual(seenAgents, ["codex"]);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].id, "bug-1");
  assert.equal(tasks[0].title, "Login button unresponsive");
  assert.equal(tasks[1].title, "Export button crashes tab");
});

test("decomposeIssueBody returns [] when agent emits invalid JSON", async () => {
  const tasks = await decomposeIssueBody(
    { body: SINGLE_BUG_BODY.repeat(3), agent: "claude" },
    {
      runOneShot: async () => buildResult("not json at all"),
    },
  );
  assert.deepEqual(tasks, []);
});

test("decomposeIssueBody returns [] when agent returns a single bug", async () => {
  const tasks = await decomposeIssueBody(
    { body: SINGLE_BUG_BODY.repeat(3), agent: "claude" },
    {
      runOneShot: async () => buildResult(JSON.stringify([{ title: "single", summary: "x" }])),
    },
  );
  assert.deepEqual(tasks, []);
});

test("decomposeIssueBody tolerates agent failure", async () => {
  const tasks = await decomposeIssueBody(
    { body: SINGLE_BUG_BODY.repeat(3), agent: "claude" },
    {
      runOneShot: async () => buildResult("", 1),
    },
  );
  assert.deepEqual(tasks, []);
});

test("decomposeIssueBody extracts JSON array from wrapped agent output", async () => {
  const tasks = await decomposeIssueBody(
    { body: SINGLE_BUG_BODY.repeat(3), agent: "codex" },
    {
      runOneShot: async () =>
        buildResult(
          `Here is the array:\n[${JSON.stringify({ title: "a", summary: "a" })},${JSON.stringify({ title: "b", summary: "b" })}]\nDone.`,
        ),
    },
  );
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].title, "a");
});
