import type { Config } from "@shared/schema";

const DEFAULT_UI_POLL_INTERVAL_MS = 600_000;
const MIN_UI_POLL_INTERVAL_MS = 10_000;

export function getUiPollIntervalMs(config?: Pick<Config, "pollIntervalMs"> | null): number {
  const configured = config?.pollIntervalMs ?? DEFAULT_UI_POLL_INTERVAL_MS;
  return Math.max(MIN_UI_POLL_INTERVAL_MS, configured);
}
