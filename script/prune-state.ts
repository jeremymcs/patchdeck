import { performance } from "node:perf_hooks";
import { statSync } from "node:fs";
import { getCodeFactoryPaths } from "../server/paths";
import { getDefaultStorage } from "../server/storage";
import { pruneLogsOnce, DEFAULT_LOG_RETENTION_DAYS, STDERR_LOG_MESSAGE_PREFIX } from "../server/logsRetention";
import { SqliteStorage } from "../server/sqliteStorage";

function parseArgs(argv: string[]): { daysToKeep: number; skipVacuum: boolean; skipStderr: boolean } {
  let daysToKeep = DEFAULT_LOG_RETENTION_DAYS;
  let skipVacuum = false;
  let skipStderr = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--days" && i + 1 < argv.length) {
      const value = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(value) && value > 0) {
        daysToKeep = value;
      }
      i += 1;
    } else if (arg === "--no-vacuum") {
      skipVacuum = true;
    } else if (arg === "--no-stderr-prune") {
      skipStderr = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: tsx script/prune-state.ts [options]",
          "",
          "Options:",
          `  --days <n>           keep logs newer than n days (default ${DEFAULT_LOG_RETENTION_DAYS})`,
          `  --no-stderr-prune    skip deletion of rows starting with "${STDERR_LOG_MESSAGE_PREFIX}"`,
          "  --no-vacuum          skip VACUUM after the prune (keeps freelist as-is)",
        ].join("\n"),
      );
      process.exit(0);
    }
  }

  return { daysToKeep, skipVacuum, skipStderr };
}

function fileSizeMb(path: string): string {
  try {
    return (statSync(path).size / (1024 * 1024)).toFixed(1);
  } catch {
    return "?";
  }
}

async function main(): Promise<void> {
  const { daysToKeep, skipVacuum, skipStderr } = parseArgs(process.argv.slice(2));
  const paths = getCodeFactoryPaths();
  console.log(`PatchDeck home: ${paths.rootDir}`);
  console.log(`Before:  state.sqlite = ${fileSizeMb(paths.stateDbPath)} MB`);

  const storage = getDefaultStorage();

  const start = performance.now();
  const result = await pruneLogsOnce(storage, { daysToKeep, pruneStderr: !skipStderr });
  console.log(
    `Pruned: ${result.byAge} rows older than ${daysToKeep} day(s)`
      + (skipStderr ? "" : `, ${result.byStderrPrefix} stderr-prefixed rows`),
  );

  if (!skipVacuum) {
    if (!(storage instanceof SqliteStorage)) {
      console.log("Skipping VACUUM: storage backend is not SQLite");
    } else {
      console.log("Running VACUUM...");
      storage.vacuum();
    }
  }
  console.log(`Elapsed: ${((performance.now() - start) / 1000).toFixed(1)}s`);
  console.log(`After:   state.sqlite = ${fileSizeMb(paths.stateDbPath)} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
