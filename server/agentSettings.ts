import type { Config, WatchedRepo } from "@shared/schema";
import type { AgentRuntimeSettings, CodingAgent } from "./agentRunner";

export function resolveRepoCodingAgent(config: Config, repoSettings?: WatchedRepo | null): CodingAgent {
  return repoSettings?.codingAgentOverride ?? config.codingAgent;
}

export function resolveRepoAgentRuntimeSettings(
  config: Config,
  repoSettings?: WatchedRepo | null,
): AgentRuntimeSettings {
  return {
    codexModel: repoSettings?.codexModel ?? config.codexModel,
    codexReasoningEffort: repoSettings?.codexReasoningEffort ?? config.codexReasoningEffort,
    claudeModel: repoSettings?.claudeModel ?? config.claudeModel,
    claudeEffort: repoSettings?.claudeEffort ?? config.claudeEffort,
  };
}
