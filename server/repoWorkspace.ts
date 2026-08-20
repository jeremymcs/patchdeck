import { mkdir, readdir, readFile, rm } from "fs/promises";
import path from "path";
import { type CommandResult, runCommand } from "./agentRunner";
import { getCodeFactoryPaths } from "./paths";

type GitRunner = typeof runCommand;

type EnsureRepoCacheParams = {
  rootDir?: string;
  repoFullName: string;
  repoCloneUrl: string;
  runCommand: GitRunner;
  forceReclone?: boolean;
};

type PreparePrWorktreeParams = {
  rootDir?: string;
  repoFullName: string;
  repoCloneUrl: string;
  headRepoFullName: string;
  headRepoCloneUrl: string;
  headRef: string;
  prNumber: number;
  runId: string;
  runCommand: GitRunner;
};

type RemovePrWorktreeParams = {
  repoCacheDir: string;
  worktreePath: string;
  runCommand: GitRunner;
};

const repoMutationLocks = new Map<string, Promise<void>>();
const activeRepoWorkspaceCounts = new Map<string, number>();
/**
 * Worktrees this process is actively using. Anything registered in a repo cache
 * but absent from here is an orphan: the run that owned it died without
 * unwinding its cleanup. A single instance lock (see `instanceLock.ts`) means no
 * other PatchDeck can own one, so the set is authoritative.
 */
const activeWorktreePaths = new Set<string>();

function summarizeCommandFailure(result: CommandResult): string {
  return result.stderr.trim() || result.stdout.trim() || "no output";
}

function normalizeRemoteUrl(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = new URL(trimmed);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const port = parsed.port ? `:${parsed.port}` : "";
    return `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${port}${pathname}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function sameRemoteUrl(left: string, right: string): boolean {
  return normalizeRemoteUrl(left) === normalizeRemoteUrl(right);
}

async function ensureDirectory(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

async function runGit(
  run: GitRunner,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return run("git", args, { timeoutMs });
}

function getRepoCacheDir(rootDir: string | undefined, repoFullName: string): string {
  const paths = getCodeFactoryPaths(rootDir);
  return path.join(paths.repoRootDir, sanitizeRepoName(repoFullName));
}

function getWorktreePath(rootDir: string | undefined, repoFullName: string, prNumber: number, runId: string): string {
  const paths = getCodeFactoryPaths(rootDir);
  const repoDir = sanitizeRepoName(repoFullName);
  return path.join(paths.worktreeRootDir, repoDir, `pr-${prNumber}-${runId}`);
}

function getForkRemoteName(headRepoFullName: string): string {
  const owner = headRepoFullName.split("/")[0] || "fork";
  const safeOwner = owner.replace(/[^a-zA-Z0-9_.-]+/g, "-");
  return `fork-${safeOwner}`;
}

async function withRepoMutationLock<T>(repoCacheDir: string, operation: () => Promise<T>): Promise<T> {
  const previousLock = repoMutationLocks.get(repoCacheDir) ?? Promise.resolve();
  let releaseCurrentLock: (() => void) | undefined;
  const currentLock = new Promise<void>((resolve) => {
    releaseCurrentLock = () => resolve();
  });
  const lockQueue = previousLock.then(() => currentLock);
  repoMutationLocks.set(repoCacheDir, lockQueue);

  await previousLock;
  try {
    return await operation();
  } finally {
    releaseCurrentLock?.();
    if (repoMutationLocks.get(repoCacheDir) === lockQueue) {
      repoMutationLocks.delete(repoCacheDir);
    }
  }
}

function adjustActiveRepoWorkspaceCount(repoCacheDir: string, delta: number): void {
  const nextCount = Math.max(0, (activeRepoWorkspaceCounts.get(repoCacheDir) ?? 0) + delta);
  if (nextCount === 0) {
    activeRepoWorkspaceCounts.delete(repoCacheDir);
    return;
  }

  activeRepoWorkspaceCounts.set(repoCacheDir, nextCount);
}

async function pruneRegisteredWorktrees(repoCacheDir: string, run: GitRunner): Promise<void> {
  const pruneResult = await runGit(run, ["-C", repoCacheDir, "worktree", "prune"], 15000);
  if (pruneResult.code !== 0) {
    const revParseResult = await runGit(run, ["-C", repoCacheDir, "rev-parse", "--is-inside-work-tree"], 4000);
    if (revParseResult.code === 0) {
      throw new Error(`git worktree prune failed: ${summarizeCommandFailure(pruneResult)}`);
    }
  }
}

/**
 * Paths of every worktree registered in the cache. Each `.git/worktrees/<name>`
 * holds a `gitdir` file pointing at the worktree's own `.git`, so the worktree
 * itself is that file's parent directory.
 */
async function listRegisteredWorktreePaths(repoCacheDir: string): Promise<string[]> {
  const worktreesDir = path.join(repoCacheDir, ".git", "worktrees");
  let entries;
  try {
    entries = await readdir(worktreesDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const gitdir = await readFile(path.join(worktreesDir, entry.name, "gitdir"), "utf8");
      const trimmed = gitdir.trim();
      if (trimmed) {
        paths.push(path.dirname(trimmed));
      }
    } catch {
      // A registration without a readable gitdir pointer is already broken;
      // `git worktree prune` is the right tool for it.
    }
  }

  return paths;
}

/**
 * Remove worktrees registered in this cache that no live run owns, so a crashed
 * run cannot strand the cache forever. Callers must already hold the repo
 * mutation lock.
 */
async function reclaimOrphanedWorktreesUnlocked(
  repoCacheDir: string,
  run: GitRunner,
  options: { includeActive?: boolean } = {},
): Promise<number> {
  await pruneRegisteredWorktrees(repoCacheDir, run);

  const registered = await listRegisteredWorktreePaths(repoCacheDir);
  const orphans = options.includeActive === true
    ? registered
    : registered.filter((worktreePath) => !activeWorktreePaths.has(worktreePath));

  let reclaimed = 0;
  for (const worktreePath of orphans) {
    await runGit(run, ["-C", repoCacheDir, "worktree", "remove", "--force", worktreePath], 30000);
    await rm(worktreePath, { recursive: true, force: true });
    activeWorktreePaths.delete(worktreePath);
    reclaimed += 1;
  }

  if (reclaimed > 0) {
    await pruneRegisteredWorktrees(repoCacheDir, run);
  }

  return reclaimed;
}

async function countRegisteredWorktrees(repoCacheDir: string): Promise<number> {
  try {
    const worktreeEntries = await readdir(path.join(repoCacheDir, ".git", "worktrees"), { withFileTypes: true });
    return worktreeEntries.filter((entry) => entry.isDirectory()).length;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return 0;
    }

    throw error;
  }
}

async function assertRepoCacheCanBeRecloned(repoCacheDir: string, run: GitRunner): Promise<void> {
  const activeWorkspaceCount = activeRepoWorkspaceCounts.get(repoCacheDir) ?? 0;
  if (activeWorkspaceCount > 0) {
    throw new Error(
      `Refusing to reclone repo cache while ${activeWorkspaceCount} active workspace(s) still depend on it`,
    );
  }

  await pruneRegisteredWorktrees(repoCacheDir, run);

  if (await countRegisteredWorktrees(repoCacheDir) > 0) {
    // Registrations left by dead runs used to block the reclone permanently:
    // `git worktree prune` only clears entries whose directory is already gone,
    // so worktrees still on disk kept the count above zero forever and the repo
    // could never recover without a human.
    await reclaimOrphanedWorktreesUnlocked(repoCacheDir, run);
  }

  const registeredWorktreeCount = await countRegisteredWorktrees(repoCacheDir);
  if (registeredWorktreeCount > 0) {
    throw new Error(
      `Refusing to reclone repo cache while ${registeredWorktreeCount} registered worktree(s) still exist`,
    );
  }
}

async function isRepoCacheHealthy(repoCacheDir: string, repoCloneUrl: string, run: GitRunner): Promise<boolean> {
  const repoCheck = await runGit(run, ["-C", repoCacheDir, "rev-parse", "--is-inside-work-tree"], 4000);
  if (repoCheck.code !== 0) {
    return false;
  }

  const originUrl = await runGit(run, ["-C", repoCacheDir, "config", "--get", "remote.origin.url"], 4000);
  if (originUrl.code !== 0 || !sameRemoteUrl(originUrl.stdout, repoCloneUrl)) {
    return false;
  }

  const status = await runGit(run, ["-C", repoCacheDir, "status", "--porcelain"], 4000);
  if (status.code !== 0 || status.stdout.trim().length > 0) {
    return false;
  }

  return true;
}

async function cloneRepoCache(repoCacheDir: string, repoCloneUrl: string, run: GitRunner): Promise<void> {
  await ensureDirectory(path.dirname(repoCacheDir));
  await rm(repoCacheDir, { recursive: true, force: true });

  const cloneResult = await runGit(run, ["clone", repoCloneUrl, repoCacheDir], 180000);
  if (cloneResult.code !== 0) {
    throw new Error(`git clone failed: ${summarizeCommandFailure(cloneResult)}`);
  }
}

async function fetchOrigin(repoCacheDir: string, run: GitRunner): Promise<CommandResult> {
  return runGit(run, ["-C", repoCacheDir, "fetch", "origin", "--prune"], 120000);
}

async function ensureRemote(repoCacheDir: string, remoteName: string, cloneUrl: string, run: GitRunner): Promise<void> {
  const currentUrl = await runGit(run, ["-C", repoCacheDir, "config", "--get", `remote.${remoteName}.url`], 4000);
  if (currentUrl.code !== 0 || !currentUrl.stdout.trim()) {
    const addResult = await runGit(run, ["-C", repoCacheDir, "remote", "add", remoteName, cloneUrl], 8000);
    if (addResult.code !== 0) {
      throw new Error(`git remote add ${remoteName} failed: ${summarizeCommandFailure(addResult)}`);
    }
    return;
  }

  if (!sameRemoteUrl(currentUrl.stdout, cloneUrl)) {
    const setUrlResult = await runGit(run, ["-C", repoCacheDir, "remote", "set-url", remoteName, cloneUrl], 8000);
    if (setUrlResult.code !== 0) {
      throw new Error(`git remote set-url ${remoteName} failed: ${summarizeCommandFailure(setUrlResult)}`);
    }
  }
}

async function fetchHeadRef(params: {
  repoCacheDir: string;
  repoFullName: string;
  headRepoFullName: string;
  headRepoCloneUrl: string;
  headRef: string;
  runCommand: GitRunner;
}): Promise<string> {
  const { repoCacheDir, repoFullName, headRepoFullName, headRepoCloneUrl, headRef, runCommand: run } = params;
  const remoteName = headRepoFullName === repoFullName ? "origin" : getForkRemoteName(headRepoFullName);

  if (remoteName !== "origin") {
    await ensureRemote(repoCacheDir, remoteName, headRepoCloneUrl, run);
  }

  let fetchResult = await runGit(run, ["-C", repoCacheDir, "fetch", remoteName, headRef], 120000);
  if (fetchResult.code === 0) {
    return remoteName;
  }

  if (remoteName !== "origin") {
    await runGit(run, ["-C", repoCacheDir, "remote", "remove", remoteName], 8000);
    await ensureRemote(repoCacheDir, remoteName, headRepoCloneUrl, run);
    fetchResult = await runGit(run, ["-C", repoCacheDir, "fetch", remoteName, headRef], 120000);
    if (fetchResult.code === 0) {
      return remoteName;
    }
  }

  throw new Error(`git fetch ${remoteName} ${headRef} failed: ${summarizeCommandFailure(fetchResult)}`);
}

async function addWorktree(repoCacheDir: string, worktreePath: string, run: GitRunner): Promise<void> {
  await ensureDirectory(path.dirname(worktreePath));
  await rm(worktreePath, { recursive: true, force: true });

  const worktreeCreate = await runGit(
    run,
    ["-C", repoCacheDir, "worktree", "add", "--detach", worktreePath, "FETCH_HEAD"],
    60000,
  );

  if (worktreeCreate.code !== 0) {
    throw new Error(`git worktree add failed: ${summarizeCommandFailure(worktreeCreate)}`);
  }
}

export function sanitizeRepoName(repoFullName: string): string {
  return repoFullName.replace(/[^a-zA-Z0-9_.-]+/g, "__");
}

async function ensureRepoCacheUnlocked(params: EnsureRepoCacheParams): Promise<{
  repoCacheDir: string;
  healed: boolean;
}> {
  const { rootDir, repoFullName, repoCloneUrl, runCommand: run, forceReclone = false } = params;
  const paths = getCodeFactoryPaths(rootDir);
  const repoCacheDir = getRepoCacheDir(rootDir, repoFullName);

  await ensureDirectory(paths.repoRootDir);

  let healed = forceReclone;
  if (forceReclone || !await isRepoCacheHealthy(repoCacheDir, repoCloneUrl, run)) {
    await assertRepoCacheCanBeRecloned(repoCacheDir, run);
    await cloneRepoCache(repoCacheDir, repoCloneUrl, run);
    healed = true;
  }

  const fetchResult = await fetchOrigin(repoCacheDir, run);
  if (fetchResult.code !== 0) {
    await assertRepoCacheCanBeRecloned(repoCacheDir, run);
    await cloneRepoCache(repoCacheDir, repoCloneUrl, run);
    healed = true;

    const retryFetchResult = await fetchOrigin(repoCacheDir, run);
    if (retryFetchResult.code !== 0) {
      throw new Error(`git fetch origin failed: ${summarizeCommandFailure(retryFetchResult)}`);
    }
  }

  return { repoCacheDir, healed };
}

export async function ensureRepoCache(params: EnsureRepoCacheParams): Promise<{
  repoCacheDir: string;
  healed: boolean;
}> {
  const repoCacheDir = getRepoCacheDir(params.rootDir, params.repoFullName);
  return withRepoMutationLock(repoCacheDir, async () => ensureRepoCacheUnlocked(params));
}

export async function preparePrWorktree(params: PreparePrWorktreeParams): Promise<{
  repoCacheDir: string;
  worktreePath: string;
  healed: boolean;
  remoteName: string;
}> {
  const {
    rootDir,
    repoFullName,
    repoCloneUrl,
    headRepoFullName,
    headRepoCloneUrl,
    headRef,
    prNumber,
    runId,
    runCommand: run,
  } = params;

  const worktreePath = getWorktreePath(rootDir, repoFullName, prNumber, runId);
  const repoCacheDir = getRepoCacheDir(rootDir, repoFullName);

  return withRepoMutationLock(repoCacheDir, async () => {
    let healed = false;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const cache = await ensureRepoCacheUnlocked({
        rootDir,
        repoFullName,
        repoCloneUrl,
        runCommand: run,
        forceReclone: attempt > 0,
      });
      healed = healed || cache.healed;

      try {
        const remoteName = await fetchHeadRef({
          repoCacheDir: cache.repoCacheDir,
          repoFullName,
          headRepoFullName,
          headRepoCloneUrl,
          headRef,
          runCommand: run,
        });

        await addWorktree(cache.repoCacheDir, worktreePath, run);
        adjustActiveRepoWorkspaceCount(cache.repoCacheDir, 1);
        activeWorktreePaths.add(worktreePath);
        return {
          repoCacheDir: cache.repoCacheDir,
          worktreePath,
          healed,
          remoteName,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new Error("Failed to prepare PR worktree");
  });
}

export async function removePrWorktree(params: RemovePrWorktreeParams): Promise<void> {
  const { repoCacheDir, worktreePath, runCommand: run } = params;
  await withRepoMutationLock(repoCacheDir, async () => {
    try {
      await runGit(run, ["-C", repoCacheDir, "worktree", "remove", "--force", worktreePath], 30000);
      await rm(worktreePath, { recursive: true, force: true });
    } finally {
      adjustActiveRepoWorkspaceCount(repoCacheDir, -1);
      activeWorktreePaths.delete(worktreePath);
    }
  });
}

/**
 * Reclaim worktrees left behind by runs that never unwound their cleanup.
 *
 * Cleanup normally happens in a `finally` inside each run, which covers both the
 * success and the throw path but not the process dying — a crash, a kill, or a
 * machine restart mid-run strands the worktree. Nothing else sweeps them, so they
 * accumulated until `assertRepoCacheCanBeRecloned` refused to heal the cache and
 * the repo's automation stopped for good.
 *
 * `includeActive` is for startup, where the single-instance lock guarantees no
 * worktree can legitimately be in use, so every registration is an orphan.
 */
export async function reclaimOrphanedWorktrees(params: {
  rootDir?: string;
  runCommand: GitRunner;
  includeActive?: boolean;
}): Promise<{ repoCacheDir: string; reclaimed: number }[]> {
  const paths = getCodeFactoryPaths(params.rootDir);

  let repoDirs;
  try {
    repoDirs = await readdir(paths.repoRootDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const results: { repoCacheDir: string; reclaimed: number }[] = [];
  for (const entry of repoDirs) {
    if (!entry.isDirectory()) {
      continue;
    }

    const repoCacheDir = path.join(paths.repoRootDir, entry.name);
    const reclaimed = await withRepoMutationLock(repoCacheDir, async () =>
      reclaimOrphanedWorktreesUnlocked(repoCacheDir, params.runCommand, {
        includeActive: params.includeActive,
      }));

    if (reclaimed > 0) {
      results.push({ repoCacheDir, reclaimed });
    }
  }

  return results;
}
