import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntimeSettings, CodingAgent } from "./agentRunner";
import { runAgentOneShot } from "./agentRunner";
import { childLogger } from "./logger";
import type { IssueSubtask } from "@shared/schema";

const log = childLogger("issue-decompose");

export type DecomposeInput = {
  body: string | null;
  agent: CodingAgent;
  settings?: AgentRuntimeSettings;
  timeoutMs?: number;
};

export type DecomposeDependencies = {
  runOneShot: typeof runAgentOneShot;
};

export function hashIssueBody(body: string | null): string {
  return createHash("sha256").update(body ?? "").digest("hex").slice(0, 32);
}

const HEADING_PATTERN = /^(#{2,3})\s+Bug\s+(\d+)\s*[—\-:]\s*(.+?)\s*$/i;
const PLAIN_BUG_PATTERN = /^Bug\s+(\d+)\s+[—\-:]\s+(.+?)\s*$/i;

export function decomposeFromHeuristic(body: string): IssueSubtask[] {
  const lines = body.split(/\r?\n/);
  const headings: Array<{ lineIndex: number; bugNumber: number; title: string }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = line.match(HEADING_PATTERN);
    if (heading) {
      headings.push({ lineIndex: i, bugNumber: Number(heading[2]), title: heading[3].trim() });
      continue;
    }
    const plain = line.match(PLAIN_BUG_PATTERN);
    if (plain) {
      headings.push({ lineIndex: i, bugNumber: Number(plain[1]), title: plain[2].trim() });
    }
  }

  if (headings.length < 2) return [];

  return headings.map((heading, idx) => {
    const nextIndex = headings[idx + 1]?.lineIndex ?? lines.length;
    const summaryLines = lines
      .slice(heading.lineIndex + 1, nextIndex)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("---"));
    const summary = summaryLines.slice(0, 8).join(" ").replace(/\s+/g, " ").trim();
    return {
      id: `bug-${heading.bugNumber}`,
      title: heading.title.slice(0, 120),
      summary: summary.slice(0, 500),
      status: "pending" as const,
    };
  });
}

const LLM_INSTRUCTIONS = `You analyze a GitHub issue body to determine whether it describes one bug or multiple distinct independent bugs.

Rules:
- Return ONLY a JSON array. No prose, no markdown code fences, no explanation.
- If the issue describes a single bug (even if it has multiple steps or symptoms of one root cause), return [].
- If it describes 2 or more distinct, independent bugs that could each be fixed in a separate change, return one object per bug.
- Each object must have exactly two string fields: title (under 80 chars) and summary (one paragraph, under 500 chars).
- Multiple symptoms of one root cause count as a single bug. Return [].`;

function buildDecomposePrompt(body: string): string {
  const truncated = body.length > 12000 ? `${body.slice(0, 12000)}…` : body;
  return `${LLM_INSTRUCTIONS}

Issue body:
"""
${truncated}
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

function normalizeAgentSubtasks(raw: unknown[]): IssueSubtask[] {
  const cleaned: IssueSubtask[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const candidate = entry as { title?: unknown; summary?: unknown };
    if (typeof candidate.title !== "string" || typeof candidate.summary !== "string") return;
    cleaned.push({
      id: `bug-${index + 1}`,
      title: candidate.title.trim().slice(0, 120),
      summary: candidate.summary.trim().slice(0, 500),
      status: "pending",
    });
  });
  return cleaned;
}

async function decomposeFromAgent(
  input: DecomposeInput,
  body: string,
  runOneShot: typeof runAgentOneShot,
): Promise<IssueSubtask[]> {
  let workCwd: string | null = null;
  try {
    workCwd = await mkdtemp(path.join(tmpdir(), "patchdeck-decompose-"));
    const result = await runOneShot({
      agent: input.agent,
      prompt: buildDecomposePrompt(body),
      cwd: workCwd,
      settings: input.settings,
      timeoutMs: input.timeoutMs ?? 30000,
    });

    if (result.code !== 0) {
      log.info(
        { agent: input.agent, code: result.code, stderr: result.stderr.slice(0, 200) },
        "issue decompose agent exited non-zero; treating as single-bug",
      );
      return [];
    }

    const parsed = extractJsonArray(result.stdout);
    if (!parsed || parsed.length < 2) {
      return [];
    }

    const normalized = normalizeAgentSubtasks(parsed);
    return normalized.length >= 2 ? normalized : [];
  } catch (error) {
    log.info(
      { agent: input.agent, err: error instanceof Error ? error.message : String(error) },
      "issue decompose threw; treating as single-bug",
    );
    return [];
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

export async function decomposeIssueBody(
  input: DecomposeInput,
  deps?: Partial<DecomposeDependencies>,
): Promise<IssueSubtask[]> {
  const body = input.body?.trim();
  if (!body || body.length < 200) {
    return [];
  }

  const heuristic = decomposeFromHeuristic(body);
  if (heuristic.length >= 2) {
    return heuristic;
  }

  const runOneShot = deps?.runOneShot ?? runAgentOneShot;
  return decomposeFromAgent(input, body, runOneShot);
}
