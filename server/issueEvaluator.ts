import type { IssueEvaluationStatus } from "@shared/schema";

export const ISSUE_EVALUATION_MARKER_PREFIX = "<!-- patchdeck:issue-evaluation";

export type IssueEvaluationInput = {
  repo: string;
  issueNumber: number;
  title: string;
  body: string | null;
  labels: string[];
  author: string;
};

export type IssueEvaluationDecision = {
  status: IssueEvaluationStatus;
  confidence: number;
  summary: string;
  safetyFlags: string[];
  recommendedLabels: string[];
};

const BLOCKED_LABELS = new Set([
  "blocked",
  "question",
  "needs-maintainer-review",
  "needs-maintainer-input",
  "needs-author-feedback",
  "needs-discussion",
  "wontfix",
  "duplicate",
  "invalid",
  "not-planned",
]);

const SECRET_PATTERNS = [
  /\b(api|access|auth|github|npm|aws|stripe)\s*(key|token|secret)\b/i,
  /\b(private|ssh)\s+key\b/i,
  /\bpasswords?\b/i,
  /\bcredentials?\b/i,
  /\bprocess\.env\b/i,
  /\b\.env\b/i,
  /\bprintenv\b/i,
  /\benv\s*\|\s*sort\b/i,
];

const EXFILTRATION_PATTERNS = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bwebhook\b/i,
  /\bpastebin\b/i,
  /\bupload\b/i,
  /\bsend\s+(it|them|data|logs?|secrets?)\s+to\b/i,
  /\bpost\s+(it|them|data|logs?|secrets?)\s+to\b/i,
  /\b(download|fetch)\s+(and\s+)?(run|execute)\b/i,
  /\b(curl|wget).*\|\s*(sh|bash)\b/i,
];

const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bdrop\s+table\b/i,
  /\bdelete\s+(the\s+)?database\b/i,
  /\bdisable\s+(auth|authentication|security)\b/i,
  /\bbypass\s+(auth|authentication|security)\b/i,
  /\bhide\s+(logs?|audit)\b/i,
  /\bremove\s+(audit|logging)\b/i,
];

const PRIVILEGED_PATTERNS = [
  /\bauth(entication)?\b/i,
  /\bsecurity\b/i,
  /\bsecrets?\b/i,
  /\bpayments?\b/i,
  /\bbilling\b/i,
  /\bdeployment\b/i,
  /\bci\b/i,
];

const ACTIONABLE_PATTERNS = [
  /\bbug\b/i,
  /\bregression\b/i,
  /\bcrash(es|ing)?\b/i,
  /\bfails?\b/i,
  /\berrors?\b/i,
  /\bbroken\b/i,
  /\bexpected\b/i,
  /\bactual\b/i,
  /\brepro(duce|duction)?\b/i,
  /\bsteps?\s+to\s+reproduce\b/i,
];

const DISCUSSION_PATTERNS = [
  /\bhow\s+do\s+i\b/i,
  /\bquestion\b/i,
  /\bhelp\b/i,
  /\bsupport\b/i,
  /\bdiscussion\b/i,
  /\bproposal\b/i,
  /\bfeature\s+request\b/i,
];

function normalizeLabels(labels: string[]): string[] {
  return labels.map((label) => label.trim().toLowerCase()).filter(Boolean);
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function addFlag(flags: string[], flag: string): void {
  if (!flags.includes(flag)) {
    flags.push(flag);
  }
}

export function evaluateIssueForAutomation(input: IssueEvaluationInput): IssueEvaluationDecision {
  const labels = normalizeLabels(input.labels);
  const text = `${input.title}\n${input.body ?? ""}\n${labels.join("\n")}`;
  const safetyFlags: string[] = [];

  const blockedLabel = labels.find((label) => BLOCKED_LABELS.has(label));
  if (blockedLabel) {
    addFlag(safetyFlags, `blocked-label:${blockedLabel}`);
  }
  if (matchesAny(text, SECRET_PATTERNS)) addFlag(safetyFlags, "secret-access");
  if (matchesAny(text, EXFILTRATION_PATTERNS)) addFlag(safetyFlags, "exfiltration-risk");
  if (matchesAny(text, DESTRUCTIVE_PATTERNS)) addFlag(safetyFlags, "destructive-request");
  if (matchesAny(text, PRIVILEGED_PATTERNS)) addFlag(safetyFlags, "privileged-area");

  const hardBlock = safetyFlags.some((flag) =>
    flag === "secret-access" || flag === "exfiltration-risk" || flag === "destructive-request"
  );
  if (hardBlock || blockedLabel) {
    return {
      status: "blocked",
      confidence: 0.9,
      summary: hardBlock
        ? "Blocked from automatic work because the issue asks for risky secret, network, or destructive behavior."
        : `Blocked from automatic work by label: ${blockedLabel}.`,
      safetyFlags,
      recommendedLabels: ["needs-maintainer-review", "blocked"],
    };
  }

  const needsReview = safetyFlags.includes("privileged-area") || matchesAny(text, DISCUSSION_PATTERNS);
  if (needsReview) {
    return {
      status: "needs_review",
      confidence: 0.75,
      summary: safetyFlags.includes("privileged-area")
        ? "Needs maintainer review because it touches a privileged area."
        : "Needs maintainer review because the issue looks like discussion or support, not direct implementation work.",
      safetyFlags,
      recommendedLabels: ["needs-maintainer-review"],
    };
  }

  const actionable = labels.some((label) => label === "bug" || label === "regression")
    || matchesAny(text, ACTIONABLE_PATTERNS);

  if (actionable) {
    return {
      status: "approved",
      confidence: 0.82,
      summary: "Approved for automatic work: actionable bug report with no safety flags.",
      safetyFlags,
      recommendedLabels: ["ready-for-agent"],
    };
  }

  return {
    status: "needs_review",
    confidence: 0.55,
    summary: "Needs maintainer review because the issue is not clearly actionable yet.",
    safetyFlags,
    recommendedLabels: ["needs-maintainer-review"],
  };
}

export function buildIssueEvaluationMarker(input: {
  targetId: string;
  status: IssueEvaluationStatus;
  confidence: number;
}): string {
  return `${ISSUE_EVALUATION_MARKER_PREFIX} target=${input.targetId} status=${input.status} confidence=${input.confidence.toFixed(2)} -->`;
}

export function buildIssueEvaluationComment(input: {
  targetId: string;
  issueTitle: string;
  issueUrl: string;
  decision: IssueEvaluationDecision;
}): string {
  const flags = input.decision.safetyFlags.length > 0
    ? input.decision.safetyFlags.map((flag) => `- ${flag}`).join("\n")
    : "- none";
  const labels = input.decision.recommendedLabels.length > 0
    ? input.decision.recommendedLabels.map((label) => `- \`${label}\``).join("\n")
    : "- none";

  return [
    buildIssueEvaluationMarker({
      targetId: input.targetId,
      status: input.decision.status,
      confidence: input.decision.confidence,
    }),
    `### Issue evaluation - ${input.decision.status.replace("_", " ")}`,
    "",
    `Issue: [${input.issueTitle}](${input.issueUrl})`,
    "",
    input.decision.summary,
    "",
    "**Safety flags**",
    flags,
    "",
    "**Labels applied**",
    labels,
  ].join("\n");
}
