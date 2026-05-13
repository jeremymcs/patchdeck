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

export type IssueEvaluationConfidenceGrade = "very_high" | "high" | "medium" | "low";

const CONFIDENCE = {
  veryHigh: 0.95,
  high: 0.82,
  needsReviewHigh: 0.75,
  medium: 0.55,
} as const;

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

const ACTIONABLE_DETAIL_PATTERNS = [
  /\bexpected\b.*\bactual\b/i,
  /\bactual\b.*\bexpected\b/i,
  /\bsteps?\s+to\s+reproduce\b/i,
  /\brepro(duce|duction)?\b/i,
  /\bafter\s+(refresh|reload|click|submit|save|login|sign in|sign out|deploy|build)\b/i,
  /\bwhen\s+i\b/i,
  /\bthrows?\b/i,
  /\bstack trace\b/i,
  /\bstatus\s+code\b/i,
  /\bconsole\b/i,
];

const BROAD_BLAST_RADIUS_PATTERNS = [
  /\brewrite\b/i,
  /\bredesign\b/i,
  /\bre-?architect\b/i,
  /\barchitecture\b/i,
  /\brefactor\b/i,
  /\bmigrat(e|ion)\b/i,
  /\breplace\b.*\b(system|framework|database|auth|authentication|api)\b/i,
  /\b(entire|whole)\s+(app|application|codebase|system|dashboard|backend|frontend)\b/i,
  /\ball\s+(pages|routes|components|endpoints|models|tables|repos|repositories)\b/i,
  /\bevery(where|thing| page| route| component| endpoint| model| table)\b/i,
  /\bcross-?cutting\b/i,
  /\bbreaking\s+change\b/i,
  /\bdatabase\s+(schema|migration)\b/i,
  /\bauth(entication)?\s+(flow|system|layer)\b/i,
  /\bpermission\s+(model|system)\b/i,
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

export function gradeIssueEvaluationConfidence(confidence: number): IssueEvaluationConfidenceGrade {
  if (confidence >= 0.9) return "very_high";
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

export function formatIssueEvaluationConfidence(confidence: number): string {
  return `${gradeIssueEvaluationConfidence(confidence).replace("_", " ")} (${Math.round(confidence * 100)}%)`;
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
  if (matchesAny(text, BROAD_BLAST_RADIUS_PATTERNS)) addFlag(safetyFlags, "broad-blast-radius");

  const hardBlock = safetyFlags.some((flag) =>
    flag === "secret-access" || flag === "exfiltration-risk" || flag === "destructive-request"
  );
  if (hardBlock || blockedLabel) {
    return {
      status: "blocked",
      confidence: CONFIDENCE.veryHigh,
      summary: hardBlock
        ? "Blocked from automatic work because the issue asks for risky secret, network, or destructive behavior."
        : `Blocked from automatic work by label: ${blockedLabel}.`,
      safetyFlags,
      recommendedLabels: ["needs-maintainer-review", "blocked"],
    };
  }

  const needsReview = safetyFlags.includes("privileged-area")
    || safetyFlags.includes("broad-blast-radius")
    || matchesAny(text, DISCUSSION_PATTERNS);
  if (needsReview) {
    const recommendedLabels = safetyFlags.includes("broad-blast-radius")
      ? ["needs-maintainer-review", "large-scope"]
      : ["needs-maintainer-review"];
    return {
      status: "needs_review",
      confidence: CONFIDENCE.needsReviewHigh,
      summary: safetyFlags.includes("broad-blast-radius")
        ? "Needs maintainer review because the issue appears larger than a surgical fix and may have broad blast radius."
        : safetyFlags.includes("privileged-area")
        ? "Needs maintainer review because it touches a privileged area."
        : "Needs maintainer review because the issue looks like discussion or support, not direct implementation work.",
      safetyFlags,
      recommendedLabels,
    };
  }

  const concreteReport = matchesAny(text, ACTIONABLE_DETAIL_PATTERNS);
  const actionable = matchesAny(text, ACTIONABLE_PATTERNS) && concreteReport;

  if (actionable) {
    return {
      status: "approved",
      confidence: CONFIDENCE.high,
      summary: "Approved for automatic work: the evaluator could not disprove a concrete, surgical issue report and found no safety flags.",
      safetyFlags,
      recommendedLabels: ["ready-for-agent"],
    };
  }

  return {
    status: "needs_review",
    confidence: CONFIDENCE.medium,
    summary: "Needs maintainer review because the evaluator could not find enough concrete detail to treat the report as proven actionable.",
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
    `Confidence: ${formatIssueEvaluationConfidence(input.decision.confidence)}`,
    "",
    "**Safety flags**",
    flags,
    "",
    "**Labels applied**",
    labels,
  ].join("\n");
}
