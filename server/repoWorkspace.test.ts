import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import test from "node:test";
import { ensureRepoCache, preparePrWorktree, reclaimOrphanedWorktrees, removePrWorktree } from "./repoWorkspace";

test("preparePrWorktree reuses the watched-repo cache and fetches fork heads on demand", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codefactory-workspace-"));
  const calls: Array<{ command: string; args: string[] }> = [];
  let cloned = false;

  const result = await preparePrWorktree({
    rootDir,
    repoFullName: "acme/widgets",
    repoCloneUrl: "https://github.com/acme/widgets.git",
    headRepoFullName: "contrib/widgets",
    headRepoCloneUrl: "https://github.com/contrib/widgets.git",
    headRef: "fix-branch",
    prNumber: 42,
    runId: "run-1",
    runCommand: async (command, args) => {
      calls.push({ command, args });

      if (command !== "git") {
        return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
      }

      if (args[0] === "-C" && args[2] === "rev-parse") {
        return cloned ? { code: 0, stdout: "true\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
      }

      if (args[0] === "clone") {
        cloned = true;
        await mkdir(args[2], { recursive: true });
        return { code: 0, stdout: "cloned\n", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "config" && args[3] === "--get" && args[4] === "remote.origin.url") {
        return { code: 0, stdout: "https://github.com/acme/widgets.git\n", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "config" && args[3] === "--get" && args[4] === "remote.fork-contrib.url") {
        return { code: 1, stdout: "", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "status") {
        return { code: 0, stdout: "", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "fetch") {
        return { code: 0, stdout: "fetched\n", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "remote" && args[3] === "add") {
        return { code: 0, stdout: "remote added\n", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "worktree" && args[3] === "add") {
        await mkdir(args[5], { recursive: true });
        return { code: 0, stdout: "worktree added\n", stderr: "" };
      }

      return { code: 0, stdout: "", stderr: "" };
    },
  });

  assert.match(result.repoCacheDir, /\/repos\/acme__widgets$/);
  assert.match(result.worktreePath, /\/worktrees\/acme__widgets\/pr-42-run-1$/);
  assert.equal(result.remoteName, "fork-contrib");
  assert.equal(result.healed, true);
  assert.ok(calls.some((call) => call.args[2] === "remote" && call.args[3] === "add" && call.args[4] === "fork-contrib"));
});

test("preparePrWorktree reclones the cache when git health checks fail", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codefactory-workspace-heal-"));
  let cloneCount = 0;

  const result = await preparePrWorktree({
    rootDir,
    repoFullName: "acme/widgets",
    repoCloneUrl: "https://github.com/acme/widgets.git",
    headRepoFullName: "acme/widgets",
    headRepoCloneUrl: "https://github.com/acme/widgets.git",
    headRef: "feature-branch",
    prNumber: 18,
    runId: "run-2",
    runCommand: async (command, args) => {
      if (command !== "git") {
        return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
      }

      if (args[0] === "-C" && args[2] === "rev-parse") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "config" && args[3] === "--get" && args[4] === "remote.origin.url") {
        if (cloneCount === 0) {
          return { code: 0, stdout: "https://github.com/other/repo.git\n", stderr: "" };
        }

        return { code: 0, stdout: "https://github.com/acme/widgets.git\n", stderr: "" };
      }

      if (args[0] === "clone") {
        cloneCount += 1;
        await mkdir(args[2], { recursive: true });
        return { code: 0, stdout: "cloned\n", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "status") {
        return { code: 0, stdout: "", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "fetch") {
        return { code: 0, stdout: "fetched\n", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "worktree" && args[3] === "add") {
        await mkdir(args[5], { recursive: true });
        return { code: 0, stdout: "worktree added\n", stderr: "" };
      }

      return { code: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(cloneCount, 1);
  assert.equal(result.healed, true);
  assert.equal(result.remoteName, "origin");
});

test("ensureRepoCache treats tokenized and public GitHub clone URLs as the same remote", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codefactory-workspace-auth-"));
  let cloneCount = 0;

  const result = await ensureRepoCache({
    rootDir,
    repoFullName: "acme/widgets",
    repoCloneUrl: "https://x-access-token:ghs_123@github.com/acme/widgets.git",
    runCommand: async (command, args) => {
      if (command !== "git") {
        return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
      }

      if (args[0] === "-C" && args[2] === "rev-parse") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "config" && args[3] === "--get" && args[4] === "remote.origin.url") {
        return { code: 0, stdout: "https://github.com/acme/widgets.git\n", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "status") {
        return { code: 0, stdout: "", stderr: "" };
      }

      if (args[0] === "-C" && args[2] === "fetch") {
        return { code: 0, stdout: "fetched\n", stderr: "" };
      }

      if (args[0] === "clone") {
        cloneCount += 1;
        return { code: 0, stdout: "cloned\n", stderr: "" };
      }

      return { code: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(result.healed, false);
  assert.equal(cloneCount, 0);
});

test("ensureRepoCache refuses to reclone while an active worktree still depends on the shared cache", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codefactory-workspace-active-"));
  let cloned = false;
  let cloneCount = 0;

  const runCommand = async (command: string, args: string[]) => {
    if (command !== "git") {
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    }

    if (args[0] === "-C" && args[2] === "rev-parse") {
      return cloned ? { code: 0, stdout: "true\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
    }

    if (args[0] === "clone") {
      cloned = true;
      cloneCount += 1;
      await mkdir(args[2], { recursive: true });
      return { code: 0, stdout: "cloned\n", stderr: "" };
    }

    if (args[0] === "-C" && args[2] === "config" && args[3] === "--get" && args[4] === "remote.origin.url") {
      return { code: 0, stdout: "https://github.com/acme/widgets.git\n", stderr: "" };
    }

    if (args[0] === "-C" && args[2] === "status") {
      return { code: 0, stdout: "", stderr: "" };
    }

    if (args[0] === "-C" && args[2] === "fetch") {
      return { code: 0, stdout: "fetched\n", stderr: "" };
    }

    if (args[0] === "-C" && args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[5], { recursive: true });
      return { code: 0, stdout: "worktree added\n", stderr: "" };
    }

    if (args[0] === "-C" && args[2] === "worktree" && args[3] === "remove") {
      return { code: 0, stdout: "worktree removed\n", stderr: "" };
    }

    return { code: 0, stdout: "", stderr: "" };
  };

  const worktree = await preparePrWorktree({
    rootDir,
    repoFullName: "acme/widgets",
    repoCloneUrl: "https://github.com/acme/widgets.git",
    headRepoFullName: "acme/widgets",
    headRepoCloneUrl: "https://github.com/acme/widgets.git",
    headRef: "feature-branch",
    prNumber: 18,
    runId: "run-2",
    runCommand,
  });

  await assert.rejects(
    () => ensureRepoCache({
      rootDir,
      repoFullName: "acme/widgets",
      repoCloneUrl: "https://github.com/acme/widgets.git",
      runCommand,
      forceReclone: true,
    }),
    /active workspace/,
  );
  assert.equal(cloneCount, 1);

  await removePrWorktree({
    repoCacheDir: worktree.repoCacheDir,
    worktreePath: worktree.worktreePath,
    runCommand,
  });

  const healed = await ensureRepoCache({
    rootDir,
    repoFullName: "acme/widgets",
    repoCloneUrl: "https://github.com/acme/widgets.git",
    runCommand,
    forceReclone: true,
  });

  assert.equal(healed.healed, true);
  assert.equal(cloneCount, 2);
});

test("ensureRepoCache refuses to reclone when registered worktrees still exist on disk", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codefactory-workspace-registered-"));
  const repoCacheDir = path.join(rootDir, "repos", "acme__widgets");
  await mkdir(path.join(repoCacheDir, ".git", "worktrees", "pr-18-run-2"), { recursive: true });
  let cloneCount = 0;

  await assert.rejects(
    () => ensureRepoCache({
      rootDir,
      repoFullName: "acme/widgets",
      repoCloneUrl: "https://github.com/acme/widgets.git",
      forceReclone: true,
      runCommand: async (command, args) => {
        if (command !== "git") {
          return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
        }

        if (args[0] === "-C" && args[2] === "worktree" && args[3] === "prune") {
          return { code: 0, stdout: "", stderr: "" };
        }

        if (args[0] === "clone") {
          cloneCount += 1;
          return { code: 0, stdout: "cloned\n", stderr: "" };
        }

        return { code: 0, stdout: "", stderr: "" };
      },
    }),
    /registered worktree/,
  );

  assert.equal(cloneCount, 0);
});

/**
 * Build a repo cache whose `.git/worktrees` holds a registration left behind by a
 * run that died before its cleanup could run, plus the worktree directory itself.
 * `git worktree prune` cannot clear this: the directory still exists.
 */
async function seedOrphanedWorktree(rootDir: string, name: string): Promise<{
  repoCacheDir: string;
  registrationDir: string;
  worktreePath: string;
}> {
  const repoCacheDir = path.join(rootDir, "repos", "acme__widgets");
  const registrationDir = path.join(repoCacheDir, ".git", "worktrees", name);
  const worktreePath = path.join(rootDir, "worktrees", "acme__widgets", name);

  await mkdir(registrationDir, { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  await writeFile(path.join(registrationDir, "gitdir"), `${path.join(worktreePath, ".git")}\n`, "utf8");

  return { repoCacheDir, registrationDir, worktreePath };
}

/** A git stand-in that mirrors the one side effect the reclaim path depends on. */
function makeReclaimingGit(counters: { clones: number; removals: string[] }) {
  return async (command: string, args: string[]) => {
    if (command !== "git") {
      return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
    }

    if (args[0] === "clone") {
      counters.clones += 1;
      return { code: 0, stdout: "cloned\n", stderr: "" };
    }

    if (args[2] === "worktree" && args[3] === "remove") {
      const worktreePath = args[args.length - 1];
      counters.removals.push(worktreePath);
      // Real git drops the registration as part of `worktree remove`.
      const name = path.basename(worktreePath);
      await rm(path.join(args[1], ".git", "worktrees", name), { recursive: true, force: true });
      return { code: 0, stdout: "", stderr: "" };
    }

    return { code: 0, stdout: "", stderr: "" };
  };
}

test("ensureRepoCache reclaims worktrees stranded by a dead run instead of refusing forever", async () => {
  // Goal: cleanup only runs in a `finally` inside each run, so a crash strands the
  // worktree. Those registrations used to block every future reclone permanently —
  // `git worktree prune` cannot clear them while the directory still exists — which
  // killed the repo's automation until a human intervened.
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codefactory-workspace-orphan-"));
  const { worktreePath } = await seedOrphanedWorktree(rootDir, "pr-18-run-dead");
  const counters = { clones: 0, removals: [] as string[] };

  const result = await ensureRepoCache({
    rootDir,
    repoFullName: "acme/widgets",
    repoCloneUrl: "https://github.com/acme/widgets.git",
    forceReclone: true,
    runCommand: makeReclaimingGit(counters) as never,
  });

  assert.equal(result.healed, true);
  assert.equal(counters.clones, 1, "the reclone must proceed once the orphan is cleared");
  assert.deepEqual(counters.removals, [worktreePath]);
});

test("reclaimOrphanedWorktrees sweeps caches and reports what it cleared", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codefactory-workspace-sweep-"));
  const { repoCacheDir, worktreePath } = await seedOrphanedWorktree(rootDir, "pr-7-run-dead");
  const counters = { clones: 0, removals: [] as string[] };

  const swept = await reclaimOrphanedWorktrees({
    rootDir,
    runCommand: makeReclaimingGit(counters) as never,
  });

  assert.deepEqual(swept, [{ repoCacheDir, reclaimed: 1 }]);
  assert.deepEqual(counters.removals, [worktreePath]);

  // A second sweep has nothing left to do.
  const again = await reclaimOrphanedWorktrees({
    rootDir,
    runCommand: makeReclaimingGit(counters) as never,
  });
  assert.deepEqual(again, []);
});

test("reclaimOrphanedWorktrees leaves a worktree the current process is still using", async () => {
  // The startup sweep may clear everything because the instance lock proves nothing
  // is live, but the periodic sweep must never pull a worktree out from under a
  // running agent.
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codefactory-workspace-active-"));
  const counters = { clones: 0, removals: [] as string[] };

  const prepared = await preparePrWorktree({
    rootDir,
    repoFullName: "acme/widgets",
    repoCloneUrl: "https://github.com/acme/widgets.git",
    headRepoFullName: "acme/widgets",
    headRepoCloneUrl: "https://github.com/acme/widgets.git",
    headRef: "feature",
    prNumber: 99,
    runId: "live-run",
    runCommand: (async (command: string, args: string[]) => {
      if (command !== "git") {
        return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
      }
      if (args[0] === "clone") {
        counters.clones += 1;
        return { code: 0, stdout: "cloned\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }) as never,
  });

  // Register it the way git would, so the sweep can see it at all.
  const registrationDir = path.join(prepared.repoCacheDir, ".git", "worktrees", "pr-99-live-run");
  await mkdir(registrationDir, { recursive: true });
  await writeFile(
    path.join(registrationDir, "gitdir"),
    `${path.join(prepared.worktreePath, ".git")}\n`,
    "utf8",
  );

  const swept = await reclaimOrphanedWorktrees({
    rootDir,
    runCommand: makeReclaimingGit(counters) as never,
  });

  assert.deepEqual(swept, [], "an in-flight worktree is not an orphan");
  assert.deepEqual(counters.removals, []);
});
