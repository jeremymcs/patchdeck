import assert from "node:assert/strict";
import test from "node:test";
import { formatActivityDetail, formatActivityLabel } from "./activityDisplay";

test("formatActivityLabel updates legacy PR work labels", () => {
  assert.equal(formatActivityLabel("Babysitting PR #6097"), "Working PR #6097");
  assert.equal(formatActivityLabel("Working PR #6097"), "Working PR #6097");
});

test("formatActivityDetail updates legacy deferred queue copy", () => {
  assert.equal(
    formatActivityDetail("Refilling babysitter queue after the active batch drains"),
    "Refilling PR work queue after the active batch drains",
  );
  assert.equal(formatActivityDetail(null), null);
});
