import test from "node:test";
import assert from "node:assert/strict";
import { autoWorkStateTone, formatCurrentRunStatus, formatIssueAutoWorkState, formatIssueWorkStage, formatPRWorkState, prWorkStateTone } from "./statusCopy";

test("formatPRWorkState separates run completion from merge readiness", () => {
  assert.equal(formatPRWorkState("done"), "work finished");
  assert.equal(formatPRWorkState("processing", "tests"), "verifying checks");
  assert.equal(prWorkStateTone("done"), "neutral");
});

test("formatCurrentRunStatus keeps completed runs neutral in copy", () => {
  assert.equal(formatCurrentRunStatus("completed"), "run finished");
  assert.equal(formatCurrentRunStatus("running"), "running");
});

test("issue auto-work copy says ready to work instead of auto eligible", () => {
  assert.equal(formatIssueAutoWorkState({ autoWorkEligible: true, autoWorkBlockedReason: null }), "ready to work");
  assert.equal(formatIssueAutoWorkState({ autoWorkEligible: false, autoWorkBlockedReason: "blocked label" }), "blocked label");
  assert.equal(autoWorkStateTone(true), "primary");
});

test("formatIssueWorkStage names completed issue work as work finished", () => {
  assert.equal(formatIssueWorkStage({ workStage: "completed", workStatus: "idle" }), "work finished");
});
