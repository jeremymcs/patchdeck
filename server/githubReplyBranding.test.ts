import test from "node:test";
import assert from "node:assert/strict";
import {
  APP_COMMENT_FOOTER,
  formatAppCommentFooter,
  formatAgentCommandGitHubComment,
} from "./babysitter";

test("GitHub reply branding defaults to patchdeck", () => {
  assert.equal(
    APP_COMMENT_FOOTER,
    "Posted by [patchdeck](https://github.com/jeremymcs/patchdeck)",
  );
});

test("GitHub reply branding can replace the visible app name", () => {
  const comment = formatAgentCommandGitHubComment(
    "codex",
    "Fix the failing test.",
    false,
    "Review Bot",
  );

  assert.match(comment, /\*\*Review Bot\*\* dispatched `codex`/);
  assert.doesNotMatch(comment, /\*\*patchdeck\*\* dispatched/);
  assert.doesNotMatch(comment, /Posted by/);
});

test("GitHub reply branding can remove the visible app name", () => {
  const comment = formatAgentCommandGitHubComment(
    "codex",
    "Fix the failing test.",
    true,
    "   ",
  );

  assert.match(comment, /\ud83e\udd16 Dispatched `codex`/);
  assert.doesNotMatch(comment, /patchdeck/);
  assert.doesNotMatch(comment, /Posted by/);
});

test("GitHub reply branding uses the custom name in linked footers", () => {
  assert.equal(
    formatAppCommentFooter("Review Bot", true),
    "Posted by [Review Bot](https://github.com/jeremymcs/patchdeck)",
  );
});
