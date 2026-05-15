import test from "node:test";
import assert from "node:assert/strict";
import {
  clearRateLimitStateForTests,
  clearRateLimited,
  deriveRateLimitResource,
  getRateLimitState,
  markRateLimited,
} from "./rateLimitState";

test.beforeEach(() => clearRateLimitStateForTests());

test("getRateLimitState reports unlimited by default", () => {
  const state = getRateLimitState();
  assert.equal(state.limited, false);
  assert.equal(state.resetAt, null);
  assert.equal(state.recentlyLimited, false);
  assert.equal(state.lastLimitedAt, null);
});

test("markRateLimited with unix seconds sets a future reset", () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  markRateLimited(reset);

  const state = getRateLimitState();
  assert.equal(state.limited, true);
  assert.ok(state.resetAt);
  assert.equal(state.resetAt!.getTime(), reset * 1000);
  assert.equal(state.recentlyLimited, true);
  assert.ok(state.lastLimitedAt);
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
  assert.equal(state.recentlyLimited, true);
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
  assert.equal(getRateLimitState().recentlyLimited, true);
});

test("deriveRateLimitResource routes URLs and headers to the right bucket", () => {
  assert.equal(deriveRateLimitResource("POST /graphql"), "graphql");
  assert.equal(deriveRateLimitResource("/graphql"), "graphql");
  assert.equal(deriveRateLimitResource("graphql"), "graphql");
  assert.equal(deriveRateLimitResource("GET /search/issues"), "search");
  assert.equal(deriveRateLimitResource("/search/code"), "search");
  assert.equal(deriveRateLimitResource("search"), "search");
  assert.equal(deriveRateLimitResource("GET /repos/foo/bar/pulls"), "core");
  assert.equal(deriveRateLimitResource(undefined), "core");
  assert.equal(deriveRateLimitResource(""), "core");
});

test("limiting graphql does not gate core, and vice versa", () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  markRateLimited(reset, "graphql");

  const coreState = getRateLimitState("core");
  assert.equal(coreState.limited, false, "core should still be open");

  const graphqlState = getRateLimitState("graphql");
  assert.equal(graphqlState.limited, true);
  assert.equal(graphqlState.resetAt!.getTime(), reset * 1000);

  const aggregate = getRateLimitState();
  assert.equal(aggregate.limited, true, "aggregate is limited if any resource is");
  assert.equal(aggregate.resources.core.limited, false);
  assert.equal(aggregate.resources.graphql.limited, true);
  assert.equal(aggregate.resources.search.limited, false);
});

test("clearing one resource does not clear the others", () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  markRateLimited(reset, "core");
  markRateLimited(reset, "search");

  clearRateLimited("core");

  assert.equal(getRateLimitState("core").limited, false);
  assert.equal(getRateLimitState("search").limited, true);
});

test("aggregate resetAt is the latest among limited resources", () => {
  const soon = Math.floor(Date.now() / 1000) + 300;
  const later = Math.floor(Date.now() / 1000) + 900;
  markRateLimited(soon, "core");
  markRateLimited(later, "graphql");

  const aggregate = getRateLimitState();
  assert.equal(aggregate.resetAt!.getTime(), later * 1000);
});
