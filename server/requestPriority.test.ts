import test from "node:test";
import assert from "node:assert/strict";
import { getRequestPriority, runWithRequestPriority } from "./requestPriority";

test("getRequestPriority defaults to high outside any scope", () => {
  assert.equal(getRequestPriority(), "high");
});

test("runWithRequestPriority sets the priority for its callback and does not leak", () => {
  const inside = runWithRequestPriority("low", () => getRequestPriority());
  assert.equal(inside, "low");
  assert.equal(getRequestPriority(), "high", "priority must not leak past the scope");
});

test("request priority propagates across awaits", async () => {
  const observed = await runWithRequestPriority("low", async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return getRequestPriority();
  });
  assert.equal(observed, "low");
});

test("nested scopes restore the outer priority on exit", () => {
  runWithRequestPriority("low", () => {
    assert.equal(getRequestPriority(), "low");
    runWithRequestPriority("high", () => {
      assert.equal(getRequestPriority(), "high");
    });
    assert.equal(getRequestPriority(), "low", "inner scope must not clobber the outer one");
  });
});
