import type { AgentModelCatalog, Config } from "@shared/schema";
import { spawn } from "child_process";
import { resolveCommandPath, runCommand } from "./agentRunner";
import { childLogger } from "./logger";

const log = childLogger("modelDiscovery");

function uniqueModels(models: readonly string[]): string[] {
  return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));
}

export function parseCodexModelList(output: string): string[] {
  const models: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    try {
      const message = JSON.parse(line) as {
        result?: { data?: Array<{ model?: unknown; hidden?: unknown }> };
      };
      for (const candidate of message.result?.data ?? []) {
        if (candidate.hidden !== true && typeof candidate.model === "string") {
          models.push(candidate.model);
        }
      }
    } catch {
      // App-server output is JSONL; ignore non-protocol lines defensively.
    }
  }
  return uniqueModels(models);
}

export function parseClaudeModelAliases(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes("--model <model>"));
  if (start === -1) {
    return [];
  }

  const block: string[] = [];
  for (const line of lines.slice(start)) {
    if (block.length > 0 && /^\s{2}(?:-\w|--)/.test(line)) {
      break;
    }
    block.push(line);
  }

  return uniqueModels(
    Array.from(block.join("\n").matchAll(/'([A-Za-z0-9][A-Za-z0-9._-]*)'/g))
      .map((match) => match[1]),
  );
}

export function buildAgentModelCatalog(
  detected: { codex: string[]; claude: string[] },
  config: Pick<Config, "codexModel" | "claudeModel" | "reviewAgent" | "reviewModel">,
): AgentModelCatalog {
  const savedCodexReviewModel = config.reviewAgent === "codex" ? config.reviewModel : "";
  const savedClaudeReviewModel = config.reviewAgent === "claude" ? config.reviewModel : "";
  const options = (models: readonly string[]) => [
    { value: "", label: "CLI default" },
    ...uniqueModels(models).map((model) => ({ value: model, label: model })),
  ];

  return {
    codex: options([
      ...detected.codex,
      config.codexModel,
      savedCodexReviewModel,
    ]),
    claude: options([
      ...detected.claude,
      config.claudeModel,
      savedClaudeReviewModel,
    ]),
  };
}

async function discoverCodexModels(): Promise<string[]> {
  const command = await resolveCommandPath("codex");
  if (!command) {
    return [];
  }
  const input = [
    JSON.stringify({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "patchdeck", title: "PatchDeck", version: "1.0.0" },
        capabilities: { experimentalApi: false },
      },
    }),
    JSON.stringify({ method: "initialized" }),
    JSON.stringify({ id: 2, method: "model/list", params: { limit: 100 } }),
    "",
  ].join("\n");
  return new Promise((resolve) => {
    const child = spawn(command, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const finish = (error?: Error, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (timedOut) {
        log.warn({ timeoutMs: 5000 }, "Codex model discovery timed out");
      } else if (error) {
        log.warn({ err: error.message }, "Codex model discovery failed");
        log.debug({ err: error }, "Codex model discovery failure details");
      }
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      resolve(parseCodexModelList(stdout));
    };
    const timeout = setTimeout(() => finish(undefined, true), 5000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (parseCodexModelList(stdout).length > 0) {
        finish();
      }
    });
    child.stdin.on("error", (error) => finish(error));
    child.on("error", (error) => finish(error));
    child.on("close", () => finish());
    child.stdin.write(input);
  });
}

async function discoverClaudeModels(): Promise<string[]> {
  const command = await resolveCommandPath("claude");
  if (!command) {
    return [];
  }
  const result = await runCommand(command, ["--help"], { timeoutMs: 5000 });
  if (result.code !== 0) {
    log.warn({ code: result.code, timedOut: result.timedOut === true }, "Claude model discovery failed");
    log.debug({ stderr: result.stderr }, "Claude model discovery failure details");
  }
  return parseClaudeModelAliases(`${result.stdout}\n${result.stderr}`);
}

export async function discoverAgentModels(
  config: Pick<Config, "codexModel" | "claudeModel" | "reviewAgent" | "reviewModel">,
): Promise<AgentModelCatalog> {
  const [codex, claude] = await Promise.all([
    discoverCodexModels(),
    discoverClaudeModels(),
  ]);
  return buildAgentModelCatalog({ codex, claude }, config);
}
