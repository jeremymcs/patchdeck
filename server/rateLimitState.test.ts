import test from "node:test";
import assert from "node:assert/strict";
import { clearRateLimited, getRateLimitState, markRateLimited } from "./rateLimitState";

test.beforeEach(() => clearRateLimited());

test("getRateLimitState reports unlimited by default", () => {
  const state = getRateLimitState();
  assert.equal(state.limited, false);
  assert.equal(state.resetAt, null);
});

test("markRateLimited with unix seconds sets a future reset", () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  markRateLimited(reset);

  const state = getRateLimitState();
  assert.equal(state.limited, true);
  assert.ok(state.resetAt);
  assert.equal(state.resetAt!.getTime(), reset * 1000);
});

test("markRateLimited with no reset falls back to a 60s gate", () => {
  const before = Date.now();
  markRateLimited(undefined);
  const after = Date.now();

  const state = getRateLimitState();
  assert.equal(state.limited, true);
  assert.ok(state.resetAt);
  // Reset should be roughly +60s from when we marked it.
  assert.ok(state.resetAt!.getTime() >= before + 59_500);
  assert.ok(state.resetAt!.getTime() <= after + 60_500);
});

test("markRateLimited extends but never shortens an active gate", () => {
  const later = Math.floor(Date.now() / 1000) + 600;
  const sooner = Math.floor(Date.now() / 1000) + 30;
  markRateLimited(later);
  markRateLimited(sooner);

  const state = getRateLimitState();
  assert.equal(state.resetAt!.getTime(), later * 1000);
});

test("clearRateLimited resets the gate", () => {
  markRateLimited(Math.floor(Date.now() / 1000) + 600);
  clearRateLimited();
  assert.equal(getRateLimitState().limited, false);
});
