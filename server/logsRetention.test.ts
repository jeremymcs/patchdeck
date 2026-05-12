import test from "node:test";
import assert from "node:assert/strict";
import { MemStorage } from "./storage";
import { DEFAULT_LOG_RETENTION_DAYS, pruneLogsOnce, STDERR_LOG_MESSAGE_PREFIX, startLogsRetentionJob } from "./logsRetention";

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
