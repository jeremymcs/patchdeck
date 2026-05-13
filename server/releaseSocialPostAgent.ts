import type { CodingAgent } from "./agentRunner";
import { buildAgentCommandArgs, resolveAgent, runAgentCommand, summarizeCommandResult, type AgentRuntimeSettings } from "./agentRunner";

export type ReleaseSocialPostInput = {
  repo: string;
  tagName: string;
  releaseName: string | null;
  notes: string | null;
  source: "internal" | "github";
  publishedAt: string | null;
  includedPrs: Array<{ number: number; title: string; author: string }>;
};

export type ReleaseSocialPostOutput = {
  twitter: string | null;
  linkedin: string | null;
  raw: string;
};

const TWITTER_SECTION = /##\s*Twitter\s*\/?\s*X(?:\s*Thread)?\s*\n([\s\S]*?)(?=\n##\s|\s*$)/i;
const LINKEDIN_SECTION = /##\s*LinkedIn(?:\s*\/\s*General)?\s*\n([\s\S]*?)(?=\n##\s|\s*$)/i;

export function parseSocialPostSections(raw: string): { twitter: string | null; linkedin: string | null } {
  const twitterMatch = raw.match(TWITTER_SECTION);
  const linkedinMatch = raw.match(LINKEDIN_SECTION);
  return {
    twitter: twitterMatch ? twitterMatch[1].trim() : null,
    linkedin: linkedinMatch ? linkedinMatch[1].trim() : null,
  };
}

function buildPrompt(input: ReleaseSocialPostInput): string {
  const lines: string[] = [];
  lines.push("You are writing release-announcement social media posts for a developer-facing software project.");
  lines.push("Write copy that engineers would respect: concrete, specific, no hype words like 'revolutionary' or 'game-changing'.");
  lines.push("");
  lines.push(`Repository: ${input.repo}`);
  lines.push(`Tag: ${input.tagName}`);
  if (input.releaseName && input.releaseName !== input.tagName) {
    lines.push(`Release title: ${input.releaseName}`);
  }
  if (input.publishedAt) {
    lines.push(`Published: ${input.publishedAt}`);
  }
  lines.push(`Source: ${input.source === "internal" ? "internal release pipeline" : "GitHub release"}`);
  lines.push("");

  if (input.notes && input.notes.trim().length > 0) {
    lines.push("## Release notes");
    lines.push(input.notes.trim());
    lines.push("");
  }

  if (input.includedPrs.length > 0) {
    lines.push("## Included pull requests");
    for (const pr of input.includedPrs.slice(0, 20)) {
      lines.push(`- #${pr.number} ${pr.title} (by ${pr.author})`);
    }
    if (input.includedPrs.length > 20) {
      lines.push(`- (+${input.includedPrs.length - 20} more)`);
    }
    lines.push("");
  }

  lines.push("## Task");
  lines.push("Produce two short social-media posts announcing this release.");
  lines.push("");
  lines.push("Constraints:");
  lines.push("- Twitter/X: a single post under 280 characters. Lead with the most interesting change. Tags optional. No thread.");
  lines.push("- LinkedIn: 2 short paragraphs (4-6 sentences total). Professional tone. Highlight 2-3 concrete improvements. End with a link prompt like 'See the full release notes →'.");
  lines.push("- Mention the version tag in both posts.");
  lines.push("- No emoji spam. At most one tasteful emoji per post.");
  lines.push("- Do not invent features that aren't in the release notes or included PRs above.");
  lines.push("");
  lines.push("Output format (exactly this structure, no preamble, no commentary):");
  lines.push("");
  lines.push("## Twitter / X");
  lines.push("<the tweet>");
  lines.push("");
  lines.push("## LinkedIn");
  lines.push("<the LinkedIn post>");

  return lines.join("\n");
}

export async function generateReleaseSocialPost(params: {
  input: ReleaseSocialPostInput;
  preferredAgent: CodingAgent;
  agentSettings?: AgentRuntimeSettings;
  timeoutMs?: number;
}): Promise<ReleaseSocialPostOutput> {
  const { input, preferredAgent, agentSettings, timeoutMs = 180_000 } = params;

  const agent = await resolveAgent(preferredAgent);
  const prompt = buildPrompt(input);

  const result = await runAgentCommand(
    agent,
    agent === "claude"
      ? buildAgentCommandArgs("claude", ["-p", "--output-format", "text", prompt], agentSettings)
      : buildAgentCommandArgs("codex", ["exec", "--skip-git-repo-check", "--sandbox", "read-only", prompt], agentSettings),
    { timeoutMs },
  );

  if (result.code !== 0) {
    throw new Error(summarizeCommandResult(result, `Agent exited with code ${result.code}`));
  }

  const raw = result.stdout.trim();
  if (!raw) {
    throw new Error("Agent returned an empty response");
  }

  const sections = parseSocialPostSections(raw);
  if (!sections.twitter && !sections.linkedin) {
    throw new Error("Could not parse Twitter / LinkedIn sections from agent response");
  }

  return {
    twitter: sections.twitter,
    linkedin: sections.linkedin,
    raw,
  };
}
