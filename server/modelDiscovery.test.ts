import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentModelCatalog,
  parseClaudeModelAliases,
  parseCodexModelList,
} from "./modelDiscovery";

test("parseCodexModelList reads visible models from the app-server response", () => {
  const output = [
    JSON.stringify({ id: 1, result: { userAgent: "patchdeck-test" } }),
    JSON.stringify({ method: "account/updated", params: {} }),
    JSON.stringify({
      id: 2,
      result: {
        data: [
          { model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", hidden: false },
          { model: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", hidden: false },
          { model: "internal-model", displayName: "Internal", hidden: true },
        ],
        nextCursor: null,
      },
    }),
  ].join("\n");

  assert.deepEqual(parseCodexModelList(output), ["gpt-5.6-sol", "gpt-5.6-luna"]);
});

test("parseClaudeModelAliases reads aliases advertised by the installed CLI", () => {
  const output = [
    "  --model <model>  Model for the current session. Provide an alias for the latest model",
    "                   (e.g. 'fable', 'opus', or 'sonnet') or a model's full name",
    "                   (e.g. 'claude-fable-5').",
    "  -n, --name <name> Session name",
  ].join("\n");

  assert.deepEqual(
    parseClaudeModelAliases(output),
    ["fable", "opus", "sonnet", "claude-fable-5"],
  );
});

test("buildAgentModelCatalog returns detected and saved models without inventing choices", () => {
  const catalog = buildAgentModelCatalog(
    {
      codex: ["gpt-5.6-sol", "gpt-5.5"],
      claude: ["fable", "opus"],
    },
    {
      codexModel: "saved-codex-model",
      claudeModel: "sonnet",
      reviewAgent: "claude",
      reviewModel: "saved-review-model",
    },
  );

  assert.deepEqual(catalog.codex.slice(0, 3).map((option) => option.value), [
    "",
    "gpt-5.6-sol",
    "gpt-5.5",
  ]);
  assert.ok(catalog.codex.some((option) => option.value === "saved-codex-model"));
  assert.ok(catalog.claude.some((option) => option.value === "fable"));
  assert.ok(catalog.claude.some((option) => option.value === "sonnet"));
  assert.ok(catalog.claude.some((option) => option.value === "saved-review-model"));
  assert.equal(catalog.codex.some((option) => option.value === "gpt-5.4"), false);
});
