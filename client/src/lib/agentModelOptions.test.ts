import assert from "node:assert/strict";
import test from "node:test";
import type { AgentModelCatalog } from "@shared/schema";
import {
  buildReviewModelOptions,
  findReviewModelSelection,
} from "./agentModelOptions";

const catalog: AgentModelCatalog = {
  codex: [
    { value: "", label: "CLI default" },
    { value: "gpt-5.6-sol", label: "gpt-5.6-sol" },
    { value: "gpt-5.6-luna", label: "gpt-5.6-luna" },
  ],
  claude: [
    { value: "", label: "CLI default" },
    { value: "opus", label: "opus" },
    { value: "sonnet", label: "sonnet" },
  ],
};

test("buildReviewModelOptions requires an explicit model and excludes the active primary model", () => {
  const options = buildReviewModelOptions(catalog, {
    agent: "claude",
    model: "opus",
  });

  assert.deepEqual(
    options.map(({ agent, model }) => [agent, model]),
    [
      ["codex", "gpt-5.6-sol"],
      ["codex", "gpt-5.6-luna"],
      ["claude", "sonnet"],
    ],
  );
});

test("findReviewModelSelection returns the agent and model represented by the selected option", () => {
  const options = buildReviewModelOptions(catalog, {
    agent: "codex",
    model: "gpt-5.6-sol",
  });
  const sonnet = options.find((option) => option.model === "sonnet");

  assert.deepEqual(findReviewModelSelection(options, sonnet?.value ?? ""), {
    agent: "claude",
    model: "sonnet",
  });
  assert.equal(findReviewModelSelection(options, "unknown"), null);
});
