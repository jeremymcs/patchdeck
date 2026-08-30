import type { AgentModelCatalog, Config } from "@shared/schema";

export type ReviewModelSelection = {
  agent: Config["reviewAgent"];
  model: string;
};

export type ReviewModelOption = ReviewModelSelection & {
  value: string;
  label: string;
};

function selectionValue(agent: Config["reviewAgent"], model: string): string {
  return `${agent}:${encodeURIComponent(model)}`;
}

export function buildReviewModelOptions(
  catalog: AgentModelCatalog,
  primary: ReviewModelSelection,
): ReviewModelOption[] {
  const optionsFor = (agent: Config["reviewAgent"], label: string) =>
    catalog[agent]
      .filter((option) => option.value.length > 0)
      .filter((option) => agent !== primary.agent || option.value !== primary.model)
      .map((option) => ({
        agent,
        model: option.value,
        value: selectionValue(agent, option.value),
        label: `${label} · ${option.label}`,
      }));

  return [
    ...optionsFor("codex", "Codex"),
    ...optionsFor("claude", "Claude"),
  ];
}

export function findReviewModelSelection(
  options: readonly ReviewModelOption[],
  value: string,
): ReviewModelSelection | null {
  const selected = options.find((option) => option.value === value);
  return selected ? { agent: selected.agent, model: selected.model } : null;
}
