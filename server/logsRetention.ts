import { childLogger } from "./logger";
import type { IStorage } from "./storage";

const log = childLogger("logsRetention");

export const DEFAULT_LOG_RETENTION_DAYS = 7;
export const DEFAULT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const STDERR_LOG_MESSAGE_PREFIX = "[stderr] ";

export type PruneResult = {
  byAge: number;
  byStderrPrefix: number;
};

export async function pruneLogsOnce(
  storage: IStorage,
  options: { daysToKeep?: number; pruneStderr?: boolean } = {},
): Promise<PruneResult> {
  const daysToKeep = options.daysToKeep ?? DEFAULT_LOG_RETENTION_DAYS;
  const pruneStderr = options.pruneStderr ?? true;

  const threshold = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
  const byAge = await storage.pruneLogs({ olderThan: threshold });
  const byStderrPrefix = pruneStderr
    ? await storage.pruneLogs({ messagePrefix: STDERR_LOG_MESSAGE_PREFIX })
    : 0;

  log.info(
    { daysToKeep, threshold, byAge, byStderrPrefix },
    "Pruned logs table",
  );

  return { byAge, byStderrPrefix };
}

export type RetentionJobHandle = {
  stop: () => void;
};

export function startLogsRetentionJob(
  storage: IStorage,
  options: {
    daysToKeep?: number;
    intervalMs?: number;
    pruneStderr?: boolean;
  } = {},
): RetentionJobHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS;

  let stopped = false;
  const tick = () => {
    if (stopped) return;
    pruneLogsOnce(storage, options).catch((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Scheduled logs prune failed",
      );
    });
  };

  // Run once at startup so existing bloat starts shrinking immediately, then on
  // the interval.
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
