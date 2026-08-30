// PatchDeck + Agent spend ledger, attribution, and ceiling tests
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import assert from "node:assert/strict";
import test from "node:test";
import { MemStorage } from "./memoryStorage";
import {
  AGENT_SPEND_WINDOW_MS,
  AgentBudgetExhaustedError,
  assertAgentBudgetAvailable,
  currentAgentWork,
  installAgentSpendMeter,
  isAgentBudgetExhausted,
  isAgentBudgetExhaustedError,
  readAgentSpend,
  resolveAgentModel,
  uninstallAgentSpendMeter,
  withAgentWork,
} from "./agentSpend";
import type { IStorage } from "./storage";

const NOW = new Date("2026-08-29T12:00:00.000Z");

async function storageWithCeiling(max: number): Promise<IStorage> {
  const storage = new MemStorage();
  const config = await storage.getConfig();
  await storage.updateConfig({ ...config, maxAgentInvocationsPerHour: max });
  return storage;
}

function ok() {
  return Promise.resolve({ stdout: "done", stderr: "", code: 0 });
}

test("context nests, innermost wins, and unwinds cleanly", async () => {
  assert.equal(currentAgentWork(), null);

  await withAgentWork({ kind: "babysit_pr", targetId: "pr-1" }, async () => {
    assert.equal(currentAgentWork()?.kind, "babysit_pr");

    await withAgentWork({ kind: "heal_ci", targetId: "pr-1" }, async () => {
      assert.equal(currentAgentWork()?.kind, "heal_ci");
    });

    assert.equal(currentAgentWork()?.kind, "babysit_pr");
  });

  assert.equal(currentAgentWork(), null);
});

test("context survives await boundaries inside the wrapped work", async () => {
  await withAgentWork({ kind: "work_issue", repo: "acme/app" }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(currentAgentWork()?.repo, "acme/app");
  });
});

test("a ceiling of 0 means unlimited", async () => {
  const storage = await storageWithCeiling(0);
  const meter = installAgentSpendMeter(storage, () => NOW);

  try {
    for (let index = 0; index < 25; index += 1) {
      await withAgentWork({ kind: "babysit_pr" }, () => meter.meter("claude", ok));
    }

    assert.equal(await isAgentBudgetExhausted(storage, NOW), false);
    await assertAgentBudgetAvailable(storage, NOW);

    const spend = await readAgentSpend(storage, NOW);
    assert.equal(spend.max, 0);
    assert.equal(spend.used, 25);
    assert.equal(spend.remaining, null);
    assert.equal(spend.exhausted, false);
  } finally {
    uninstallAgentSpendMeter();
  }
});

test("records one ledger row per spawn, with duration and outcome", async () => {
  const storage = await storageWithCeiling(0);
  let clock = NOW.getTime();
  const meter = installAgentSpendMeter(storage, () => new Date(clock));

  try {
    await withAgentWork({ kind: "work_issue", repo: "acme/app", targetId: "acme/app#7" }, () =>
      meter.meter("claude", async () => {
        clock += 4000;
        return { stdout: "", stderr: "", code: 0 };
      }));

    const rows = await storage.listAgentInvocationsSince(new Date(NOW.getTime() - 1000).toISOString());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].workKind, "work_issue");
    assert.equal(rows[0].agent, "claude");
    assert.equal(rows[0].repo, "acme/app");
    assert.equal(rows[0].targetId, "acme/app#7");
    assert.equal(rows[0].outcome, "completed");
    assert.equal(rows[0].durationMs, 4000);
    assert.equal(rows[0].exitCode, 0);
  } finally {
    uninstallAgentSpendMeter();
  }
});

test("classifies non-zero exits, timeouts, and thrown errors", async () => {
  const storage = await storageWithCeiling(0);
  const meter = installAgentSpendMeter(storage, () => NOW);

  try {
    await withAgentWork({ kind: "babysit_pr" }, () =>
      meter.meter("codex", async () => ({ stdout: "", stderr: "boom", code: 1 })));
    await withAgentWork({ kind: "babysit_pr" }, () =>
      meter.meter("codex", async () => ({ stdout: "", stderr: "", code: 124, timedOut: true })));
    await assert.rejects(
      withAgentWork({ kind: "babysit_pr" }, () =>
        meter.meter("codex", async () => {
          throw new Error("spawn failed");
        })),
      /spawn failed/,
    );

    const rows = await storage.listAgentInvocationsSince(new Date(NOW.getTime() - 1000).toISOString());
    const outcomes = rows.map((row) => row.outcome).sort();
    assert.deepEqual(outcomes, ["failed", "failed", "timeout"]);
    // Every row is terminal: a thrown spawn still closes its ledger entry.
    assert.equal(rows.filter((row) => row.finishedAt === null).length, 0);
  } finally {
    uninstallAgentSpendMeter();
  }
});

test("refuses a spawn once the ceiling is reached and reports when it clears", async () => {
  const storage = await storageWithCeiling(2);
  const meter = installAgentSpendMeter(storage, () => NOW);

  try {
    await withAgentWork({ kind: "babysit_pr" }, () => meter.meter("claude", ok));
    await withAgentWork({ kind: "work_issue" }, () => meter.meter("claude", ok));

    assert.equal(await isAgentBudgetExhausted(storage, NOW), true);

    let refused: unknown;
    try {
      await withAgentWork({ kind: "heal_ci" }, () => meter.meter("claude", ok));
    } catch (error) {
      refused = error;
    }

    assert.ok(refused instanceof AgentBudgetExhaustedError);
    assert.equal(isAgentBudgetExhaustedError(refused), true);

    // The refused spawn never ran, so it is not itself recorded as spend.
    const spend = await readAgentSpend(storage, NOW);
    assert.equal(spend.used, 2);
    assert.equal(spend.remaining, 0);
    assert.equal(spend.exhausted, true);

    // Rolling window: the ceiling clears as the oldest invocation ages out.
    const later = new Date(NOW.getTime() + AGENT_SPEND_WINDOW_MS + 1000);
    assert.equal(await isAgentBudgetExhausted(storage, later), false);
  } finally {
    uninstallAgentSpendMeter();
  }
});

test("health probes are recorded but never counted against the ceiling", async () => {
  const storage = await storageWithCeiling(1);
  const meter = installAgentSpendMeter(storage, () => NOW);

  try {
    for (let index = 0; index < 5; index += 1) {
      await withAgentWork({ kind: "probe" }, () => meter.meter("claude", ok));
    }

    assert.equal(await isAgentBudgetExhausted(storage, NOW), false);

    const spend = await readAgentSpend(storage, NOW);
    assert.equal(spend.used, 0);
    assert.equal(spend.byKind.find((entry) => entry.workKind === "probe")?.count, 5);

    // The one metered run still fits, and the next one does not.
    await withAgentWork({ kind: "babysit_pr" }, () => meter.meter("claude", ok));
    await assert.rejects(
      withAgentWork({ kind: "babysit_pr" }, () => meter.meter("claude", ok)),
      AgentBudgetExhaustedError,
    );
  } finally {
    uninstallAgentSpendMeter();
  }
});

test("an unattributed spawn is still counted", async () => {
  const storage = await storageWithCeiling(0);
  const meter = installAgentSpendMeter(storage, () => NOW);

  try {
    await meter.meter("claude", ok);

    const rows = await storage.listAgentInvocationsSince(new Date(NOW.getTime() - 1000).toISOString());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].workKind, "unattributed");
  } finally {
    uninstallAgentSpendMeter();
  }
});

test("invocations outside the rolling window do not count", async () => {
  const storage = await storageWithCeiling(1);
  const stale = new Date(NOW.getTime() - AGENT_SPEND_WINDOW_MS - 60_000);
  const meter = installAgentSpendMeter(storage, () => stale);

  try {
    await withAgentWork({ kind: "babysit_pr" }, () => meter.meter("claude", ok));

    assert.equal(await isAgentBudgetExhausted(storage, NOW), false);
    const spend = await readAgentSpend(storage, NOW);
    assert.equal(spend.used, 0);
  } finally {
    uninstallAgentSpendMeter();
  }
});

// Guard: the ALS context only works if every module that reaches an agent
// primitive establishes one. A new call site added without a context would
// silently record as `unattributed`, so the set is pinned here.
test("every module that invokes a coding agent establishes a work context", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const path = await import("node:path");

  const AGENT_PRIMITIVES = [
    "runAgentCommand(",
    "applyFixesWithAgent(",
    "runAgentOneShot(",
    "evaluateFixNecessityWithAgent(",
  ];

  // Modules that reach a primitive but are attributed by their caller instead,
  // because the caller is where the repo and target are known.
  const ATTRIBUTED_BY_CALLER = new Set(["issueDecompose.ts", "issueVerify.ts"]);

  const serverDir = path.join(import.meta.dirname, ".");
  const files = (await readdir(serverDir))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .filter((name) => name !== "agentSpend.ts");

  const missing: string[] = [];
  for (const name of files) {
    const source = await readFile(path.join(serverDir, name), "utf8");
    const callsAgent = AGENT_PRIMITIVES.some((primitive) => source.includes(primitive));
    if (!callsAgent || ATTRIBUTED_BY_CALLER.has(name)) {
      continue;
    }

    if (!source.includes("withAgentWork")) {
      missing.push(name);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `these modules invoke a coding agent without establishing a spend context: ${missing.join(", ")}`,
  );
});

test("resolveAgentModel picks the model for the agent that will actually run", () => {
  const settings = { claudeModel: "opus", codexModel: "gpt-5" };

  assert.equal(resolveAgentModel("claude", settings), "opus");
  assert.equal(resolveAgentModel("codex", settings), "gpt-5");
  // An unset codexModel is the shipped default and must not fall through to
  // the Claude model just because one is configured.
  assert.equal(resolveAgentModel("codex", { claudeModel: "opus", codexModel: "" }), null);
  assert.equal(resolveAgentModel("claude", undefined), null);
  assert.equal(resolveAgentModel("claude", null), null);
});
