import fs from "fs";
import path from "path";
import { childLogger } from "./logger";

const log = childLogger("instanceLock");

export class InstanceLockError extends Error {
  readonly pid: number;
  constructor(pid: number, lockPath: string) {
    super(
      `Another PatchDeck instance (pid ${pid}) is already running. `
        + `If that's wrong, remove the stale lockfile at ${lockPath} and retry.`,
    );
    this.pid = pid;
    this.name = "InstanceLockError";
  }
}

export type ReleaseLock = () => void;

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 sends no signal but performs the permission/existence check.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but is owned by another user — still alive.
    return code === "EPERM";
  }
}

function tryWriteExclusive(lockPath: string, pid: number): boolean {
  try {
    fs.writeFileSync(lockPath, String(pid), { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw err;
  }
}

export function acquireInstanceLock(rootDir: string): ReleaseLock {
  fs.mkdirSync(rootDir, { recursive: true });
  const lockPath = path.join(rootDir, ".lock");
  const myPid = process.pid;

  if (!tryWriteExclusive(lockPath, myPid)) {
    const existingRaw = fs.readFileSync(lockPath, "utf8").trim();
    const existingPid = Number.parseInt(existingRaw, 10);
    const valid = Number.isFinite(existingPid) && existingPid > 0;

    if (valid && existingPid !== myPid && isPidAlive(existingPid)) {
      throw new InstanceLockError(existingPid, lockPath);
    }

    log.warn(
      { staleLockPid: valid ? existingPid : existingRaw, lockPath },
      "Stale instance lock detected; taking over",
    );
    fs.unlinkSync(lockPath);
    if (!tryWriteExclusive(lockPath, myPid)) {
      // Another process raced us between unlink and create. Re-read and decide.
      const racedRaw = fs.readFileSync(lockPath, "utf8").trim();
      const racedPid = Number.parseInt(racedRaw, 10);
      throw new InstanceLockError(Number.isFinite(racedPid) ? racedPid : -1, lockPath);
    }
  }

  let released = false;
  const release: ReleaseLock = () => {
    if (released) return;
    released = true;
    try {
      const currentRaw = fs.readFileSync(lockPath, "utf8").trim();
      const currentPid = Number.parseInt(currentRaw, 10);
      if (currentPid === myPid) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // Lockfile already removed or unreadable; nothing to clean up.
    }
  };

  const onExit = () => release();
  process.once("exit", onExit);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      release();
      process.exit(0);
    });
  }

  return release;
}
