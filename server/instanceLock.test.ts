import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { acquireInstanceLock, InstanceLockError } from "./instanceLock";

function makeRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `instance-lock-${prefix}-`));
}

test("acquireInstanceLock writes our pid and releases cleanly", () => {
  const root = makeRoot("happy");
  const release = acquireInstanceLock(root);
  const lockPath = path.join(root, ".lock");

  assert.equal(fs.readFileSync(lockPath, "utf8"), String(process.pid));
  release();
  assert.equal(fs.existsSync(lockPath), false);
});

test("acquireInstanceLock takes over a stale lock from a dead pid", () => {
  const root = makeRoot("stale");
  const lockPath = path.join(root, ".lock");
  fs.mkdirSync(root, { recursive: true });
  // PID 0 is invalid on every Unix; process.kill(0, 0) throws ESRCH.
  // We use a very high pid we know is unlikely to be live.
  const fakeDeadPid = 2 ** 22;
  fs.writeFileSync(lockPath, String(fakeDeadPid));

  const release = acquireInstanceLock(root);
  assert.equal(fs.readFileSync(lockPath, "utf8"), String(process.pid));
  release();
});

test("acquireInstanceLock refuses when an alive pid already holds the lock", async () => {
  const root = makeRoot("alive");
  const lockPath = path.join(root, ".lock");
  fs.mkdirSync(root, { recursive: true });

  // Spawn a sleeping child whose pid we can use as a "live holder".
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.writeFileSync(lockPath, String(child.pid));

    assert.throws(() => acquireInstanceLock(root), (err: unknown) => {
      assert.ok(err instanceof InstanceLockError);
      assert.equal((err as InstanceLockError).pid, child.pid);
      return true;
    });
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
});

test("acquireInstanceLock release is idempotent and only removes our own lock", () => {
  const root = makeRoot("idem");
  const lockPath = path.join(root, ".lock");
  const release = acquireInstanceLock(root);

  release();
  assert.equal(fs.existsSync(lockPath), false);

  // Simulate a second instance writing the lock with a different pid; our second
  // release() call must not delete that file.
  fs.writeFileSync(lockPath, "999999");
  release();
  assert.equal(fs.existsSync(lockPath), true);
  fs.unlinkSync(lockPath);
});
