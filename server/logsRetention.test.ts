import test from "node:test";
import assert from "node:assert/strict";
import { MemStorage } from "./storage";
import { DEFAULT_LOG_RETENTION_DAYS, pruneAgentInvocationsOnce, pruneLogsOnce, STDERR_LOG_MESSAGE_PREFIX, startLogsRetentionJob } from "./logsRetention";

async function seedLog(storage: MemStorage, message: string, timestampOverride?: string) {
  const entry = await storage.addLog("pr-1", "info", message);
  if (timestampOverride) {
    (entry as { timestamp: string }).timestamp = timestampOverride;
    // The MemStorage stores entries by reference; the in-memory list already
    // contains this same object, so the override propagates.
  }
}

test("pruneLogsOnce drops rows older than the retention window", async () => {
  const storage = new MemStorage();
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date().toISOString();

  await seedLog(storage, "old message", eightDaysAgo);
  await seedLog(storage, "fresh message", recent);

  const result = await pruneLogsOnce(storage, { daysToKeep: DEFAULT_LOG_RETENTION_DAYS, pruneStderr: false });
  assert.equal(result.byAge, 1);

  const remaining = await storage.getLogs("pr-1");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].message, "fresh message");
});

test("pruneLogsOnce drops stderr-prefixed rows even when fresh", async () => {
  const storage = new MemStorage();
  await seedLog(storage, `${STDERR_LOG_MESSAGE_PREFIX}}}`);
  await seedLog(storage, `${STDERR_LOG_MESSAGE_PREFIX}+`);
  await seedLog(storage, "[stdout] hi");

  const result = await pruneLogsOnce(storage, { daysToKeep: 30, pruneStderr: true });
  assert.equal(result.byStderrPrefix, 2);

  const remaining = await storage.getLogs("pr-1");
  assert.deepEqual(remaining.map((entry) => entry.message), ["[stdout] hi"]);
});

test("startLogsRetentionJob ticks once at startup and on the interval", async () => {
  const storage = new MemStorage();
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  await seedLog(storage, "old-1", eightDaysAgo);
  await seedLog(storage, "old-2", eightDaysAgo);

  const handle = startLogsRetentionJob(storage, { intervalMs: 60_000 });
  try {
    // Allow the synchronous tick scheduled at startup to flush.
    await new Promise((resolve) => setImmediate(resolve));
    const remaining = await storage.getLogs("pr-1");
    assert.equal(remaining.length, 0);
  } finally {
    handle.stop();
  }
});

test("pruneAgentInvocationsOnce drops ledger rows past the retention horizon", async () => {
  const storage = new MemStorage();
  const now = Date.now();

  const rows = [
    { id: "fresh", startedAt: new Date(now - 60_000).toISOString() },
    { id: "stale", startedAt: new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString() },
  ];

  for (const row of rows) {
    await storage.recordAgentInvocationStart({
      id: row.id,
      workKind: "babysit_pr",
      agent: "claude",
      model: null,
      repo: "acme/app",
      targetId: "pr-1",
      agentRunId: null,
      startedAt: row.startedAt,
      finishedAt: row.startedAt,
      durationMs: 0,
      exitCode: 0,
      outcome: "completed",
      error: null,
    });
  }

  const removed = await pruneAgentInvocationsOnce(storage);
  assert.equal(removed, 1);

  const remaining = await storage.listAgentInvocationsSince(new Date(0).toISOString());
  assert.deepEqual(remaining.map((row) => row.id), ["fresh"]);
});
