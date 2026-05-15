import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntimeSettings, CodingAgent } from "./agentRunner";
import { runAgentOneShot } from "./agentRunner";
import { childLogger } from "./logger";
import type { IssueSubtask, IssueSubtaskStatus } from "@shared/schema";

const log = childLogger("issue-verify");

export type VerifyInput = {
  issueTitle: string;
  issueBody: string | null;
  subtasks: IssueSubtask[];
  prDiff: string;
  agent: CodingAgent;
  settings?: AgentRuntimeSettings;
  timeoutMs?: number;
};

export type VerifyDependencies = {
  runOneShot: typeof runAgentOneShot;
};

export type VerifyResult = {
  subtasks: IssueSubtask[];
  doneCount: number;
  totalCount: number;
};

const MAX_DIFF_CHARS = 60000;
const MAX_BODY_CHARS = 12000;

const LLM_INSTRUCTIONS = `You verify whether a pull request addresses each subtask of a GitHub issue.

Rules:
- Return ONLY a JSON array. No prose, no markdown code fences, no explanation.
- Output one object per provided subtask, in the SAME order, with the SAME id.
- Each object has exactly: id (string), status ("done" | "pending" | "deferred"), reason (string, under 200 chars).
- Use "done" only when the diff clearly addresses the subtask.
- Use "deferred" when the diff intentionally skips it (e.g. comment saying so).
- Use "pending" when the diff does not address it.`;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function buildVerifyPrompt(input: VerifyInput): string {
  const body = input.issueBody?.trim() || "(no body)";
  const subtaskList = input.subtasks
    .map((task) => `- id: ${task.id}\n  title: ${task.title}\n  summary: ${task.summary}`)
    .join("\n");
  return `${LLM_INSTRUCTIONS}

Issue title: ${input.issueTitle}

Issue body:
"""
${truncate(body, MAX_BODY_CHARS)}
"""

Subtasks (verify each one):
${subtaskList}

Pull request diff:
"""
${truncate(input.prDiff, MAX_DIFF_CHARS)}
"""

JSON array output:`;
}

function extractJsonArray(text: string): unknown[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through to bracket extraction
  }

  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket === -1 || lastBracket === -1 || lastBracket <= firstBracket) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed.slice(firstBracket, lastBracket + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeStatus(raw: unknown): IssueSubtaskStatus | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (value === "done" || value === "pending" || value === "deferred" || value === "skipped") {
    return value as IssueSubtaskStatus;
  }
  if (value === "addressed" || value === "complete" || value === "completed" || value === "fixed") {
    return "done";
  }
  if (value === "missing" || value === "not_addressed" || value === "todo" || value === "open") {
    return "pending";
  }
  return null;
}

function mergeAgentResults(
  current: IssueSubtask[],
  raw: unknown[],
): IssueSubtask[] {
  const byId = new Map<string, { status: IssueSubtaskStatus; reason: string | null }>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { id?: unknown; status?: unknown; reason?: unknown };
    if (typeof candidate.id !== "string") continue;
    const status = normalizeStatus(candidate.status);
    if (!status) continue;
    const reason = typeof candidate.reason === "string" ? candidate.reason.trim().slice(0, 200) : null;
    byId.set(candidate.id, { status, reason: reason && reason.length > 0 ? reason : null });
  }

  return current.map((task) => {
    const verdict = byId.get(task.id);
    if (!verdict) return task;
    return {
      ...task,
      status: verdict.status,
      statusReason: verdict.reason ?? task.statusReason ?? null,
    };
  });
}

export async function verifySubtasksAgainstPr(
  input: VerifyInput,
  deps?: Partial<VerifyDependencies>,
): Promise<VerifyResult> {
  if (input.subtasks.length === 0) {
    return { subtasks: [], doneCount: 0, totalCount: 0 };
  }

  const runOneShot = deps?.runOneShot ?? runAgentOneShot;
  let workCwd: string | null = null;
  try {
    workCwd = await mkdtemp(path.join(tmpdir(), "patchdeck-verify-"));
    const result = await runOneShot({
      agent: input.agent,
      prompt: buildVerifyPrompt(input),
      cwd: workCwd,
      settings: input.settings,
      timeoutMs: input.timeoutMs ?? 45000,
    });

    if (result.code !== 0) {
      log.info(
        { agent: input.agent, code: result.code, stderr: result.stderr.slice(0, 200) },
        "issue verify agent exited non-zero; leaving subtasks unchanged",
      );
      return { subtasks: input.subtasks, doneCount: countDone(input.subtasks), totalCount: input.subtasks.length };
    }

    const parsed = extractJsonArray(result.stdout);
    if (!parsed) {
      log.info({ agent: input.agent }, "issue verify agent returned non-JSON; leaving subtasks unchanged");
      return { subtasks: input.subtasks, doneCount: countDone(input.subtasks), totalCount: input.subtasks.length };
    }

    const merged = mergeAgentResults(input.subtasks, parsed);
    return { subtasks: merged, doneCount: countDone(merged), totalCount: merged.length };
  } catch (error) {
    log.info(
      { agent: input.agent, err: error instanceof Error ? error.message : String(error) },
      "issue verify threw; leaving subtasks unchanged",
    );
    return { subtasks: input.subtasks, doneCount: countDone(input.subtasks), totalCount: input.subtasks.length };
  } finally {
    if (workCwd) {
      try {
        await rm(workCwd, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

function countDone(subtasks: IssueSubtask[]): number {
  return subtasks.reduce((sum, task) => sum + (task.status === "done" ? 1 : 0), 0);
}
