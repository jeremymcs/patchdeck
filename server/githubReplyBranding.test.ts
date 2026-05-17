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

  assert.match(comment, /\*\*Review Bot\*\* started an automated PR update\./);
  assert.doesNotMatch(comment, /\*\*patchdeck\*\* started/);
  assert.doesNotMatch(comment, /Fix the failing test\./);
  assert.doesNotMatch(comment, /Posted by/);
});

test("GitHub reply branding can remove the visible app name", () => {
  const comment = formatAgentCommandGitHubComment(
    "codex",
    "Fix the failing test.",
    true,
    "   ",
  );

  assert.match(comment, /^<!-- codefactory-agent-command -->\nStarted an automated PR update\./);
  assert.doesNotMatch(comment, /patchdeck/);
  assert.doesNotMatch(comment, /Posted by/);
});

test("GitHub agent command comments summarize merge conflicts without exposing the prompt", () => {
  const comment = formatAgentCommandGitHubComment(
    "codex",
    [
      "A merge from the base branch into the head branch has been started but has conflicts.",
      "The following files have merge conflicts:",
      "  - src/example.ts",
      "",
      "Your task:",
      "1) Resolve ALL merge conflicts in the listed files.",
    ].join("\n"),
    false,
    "Review Bot",
  );

  assert.match(comment, /Merge conflicts were detected/);
  assert.match(comment, /- `src\/example\.ts`/);
  assert.doesNotMatch(comment, /Your task:/);
  assert.doesNotMatch(comment, /Resolve ALL merge conflicts/);
});

test("GitHub reply branding uses the custom name in linked footers", () => {
  assert.equal(
    formatAppCommentFooter("Review Bot", true),
    "Posted by [Review Bot](https://github.com/jeremymcs/patchdeck)",
  );
});
