import assert from "node:assert/strict";
import test from "node:test";
import { getActivityTargetRoute } from "./activityTargetRoute";

test("activity routes point to PatchDeck pages instead of external targets", () => {
  assert.equal(getActivityTargetRoute("babysit_pr"), "/prs");
  assert.equal(getActivityTargetRoute("answer_pr_question"), "/prs");
  assert.equal(getActivityTargetRoute("work_issue"), "/issues");
  assert.equal(getActivityTargetRoute("evaluate_issue"), "/issues");
  assert.equal(getActivityTargetRoute("verify_issue"), "/issues");
  assert.equal(getActivityTargetRoute("process_release_run"), "/releases");
});

test("background-only activities do not render as navigable links", () => {
  assert.equal(getActivityTargetRoute("sync_watched_repos"), null);
  assert.equal(getActivityTargetRoute("heal_deployment"), null);
  assert.equal(getActivityTargetRoute("generate_social_changelog"), null);
});
