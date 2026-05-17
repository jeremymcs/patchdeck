import test from "node:test";
import assert from "node:assert/strict";
import { ACTIVITY_POLL_INTERVAL_MS, getUiPollIntervalMs } from "./polling";

test("getUiPollIntervalMs follows configured watcher interval", () => {
  assert.equal(getUiPollIntervalMs({ pollIntervalMs: 600_000 }), 600_000);
  assert.equal(getUiPollIntervalMs({ pollIntervalMs: 45_000 }), 45_000);
});

test("getUiPollIntervalMs clamps short or missing intervals", () => {
  assert.equal(getUiPollIntervalMs({ pollIntervalMs: 1_000 }), 10_000);
  assert.equal(getUiPollIntervalMs(null), 600_000);
});

test("activity polling stays fast independent of GitHub tuning interval", () => {
  assert.equal(ACTIVITY_POLL_INTERVAL_MS, 3_000);
});
