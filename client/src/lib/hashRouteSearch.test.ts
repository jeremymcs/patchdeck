import assert from "node:assert/strict";
import test from "node:test";
import { normalizeHashRouteSearch, normalizeInitialHashRoute } from "./hashRouteSearch";

test("normalizeHashRouteSearch merges hash query params with existing search params", () => {
  assert.equal(
    normalizeHashRouteSearch("https://example.test/?utm=campaign#/logs?level=info&source=worker"),
    "https://example.test/?utm=campaign&level=info&source=worker#/logs",
  );
});

test("normalizeHashRouteSearch lowercases hash query keys before matching", () => {
  assert.equal(
    normalizeHashRouteSearch("https://example.test/?level=warn#/logs?LEVEL=info"),
    "https://example.test/?level=info#/logs",
  );
});

test("normalizeHashRouteSearch leaves hashes without query params unchanged", () => {
  assert.equal(normalizeHashRouteSearch("https://example.test/#/logs"), null);
});

test("normalizeInitialHashRoute preserves dashboard anchor ids as scroll targets", () => {
  assert.deepEqual(
    normalizeInitialHashRoute("https://example.test/?level=warn#dashboard-errors"),
    {
      href: "https://example.test/?level=warn#/",
      anchorId: "dashboard-errors",
    },
  );
});

test("normalizeInitialHashRoute preserves hash route query normalization", () => {
  assert.deepEqual(
    normalizeInitialHashRoute("https://example.test/?level=warn#/logs?LEVEL=info"),
    {
      href: "https://example.test/?level=info#/logs",
      anchorId: null,
    },
  );
});
