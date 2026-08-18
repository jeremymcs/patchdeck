// PatchDeck + Background job failure classification and retry policy
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import type { BackgroundJobKind } from "@shared/schema";
import { detectAgentUnavailability } from "./agentRunner";

/**
 * How a background job failure should be treated by the retry policy.
 *
 * - `transient`  infrastructure blipped (network, GitHub 5xx, rate limit).
 *                Retrying costs nothing but a request, so retry generously.
 * - `retryable`  unclassified. Retry, but on an agent-invoking job this is the
 *                path that can spend money, so the user-owned attempt cap applies.
 * - `blocked`    a human has to act (agent auth expired, CLI missing, access
 *                denied). Retrying cannot fix it; park and surface it.
 * - `terminal`   the work is no longer meaningful (target deleted, payload
 *                invalid). Do not retry.
 */
export type FailureClass = "transient" | "retryable" | "blocked" | "terminal";

/** Job kinds whose retry can invoke a paid coding agent. */
export const AGENT_INVOKING_JOB_KINDS: ReadonlySet<BackgroundJobKind> = new Set<BackgroundJobKind>([
  "babysit_pr",
  "work_issue",
  "evaluate_issue",
  "verify_issue",
  "heal_deployment",
  "answer_pr_question",
  "process_release_run",
  "generate_social_changelog",
]);

const TRANSIENT_PATTERNS: RegExp[] = [
  /\b(ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|ESOCKETTIMEDOUT|EPIPE|ENETUNREACH)\b/i,
  /\bsocket hang up\b/i,
  /\bnetwork error\b/i,
  /\bfetch failed\b/i,
  /\brequest timed out\b/i,
  /\bhttp (?:408|500|502|503|504)\b/i,
  /\bstatus (?:408|500|502|503|504)\b/i,
  /\b(?:bad gateway|service unavailable|gateway timeout)\b/i,
  /\brate limit\b/i,
  /\bsecondary rate limit\b/i,
  /\babuse detection\b/i,
  /\bbudget is in the reserve band\b/i,
  /\bserver error\b/i,
];

/** Blocking conditions that are not agent-availability failures. */
const BLOCKED_PATTERNS: RegExp[] = [
  /\bresource not accessible\b/i,
  /\bmust have admin rights\b/i,
  /\bsaml enforcement\b/i,
  /\bbad credentials\b/i,
  /\brepository not found\b/i,
];

const DEFAULT_TRANSIENT_MAX_ATTEMPTS = 10;
const DEFAULT_RETRYABLE_MAX_ATTEMPTS = 8;
const BASE_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 3_600_000;
const JITTER_FRACTION = 0.2;

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

function matchesAny(message: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

/**
 * Classify a failure so the dispatcher can decide between retrying, parking,
 * and dropping the job. Order matters: infrastructure symptoms win over the
 * agent-availability patterns, so a network timeout is never mistaken for an
 * expired credential.
 */
export function classifyFailure(error: unknown): FailureClass {
  const message = toMessage(error).trim();
  if (message.length === 0) {
    return "retryable";
  }

  if (matchesAny(message, TRANSIENT_PATTERNS)) {
    return "transient";
  }

  if (detectAgentUnavailability(message) !== null) {
    return "blocked";
  }

  if (matchesAny(message, BLOCKED_PATTERNS)) {
    return "blocked";
  }

  return "retryable";
}

/**
 * Attempts allowed before a job parks. Only the paid path — an unclassified
 * failure on a job kind that can invoke an agent — is governed by the user's
 * spend setting. Infrastructure retries cost a request, not a run, so they are
 * deliberately not capped by it.
 */
export function resolveMaxAttempts(params: {
  kind: BackgroundJobKind;
  failureClass: FailureClass;
  maxAgentRetryAttempts: number;
}): number {
  const { kind, failureClass, maxAgentRetryAttempts } = params;

  if (failureClass === "blocked" || failureClass === "terminal") {
    return 0;
  }

  if (failureClass === "transient") {
    return DEFAULT_TRANSIENT_MAX_ATTEMPTS;
  }

  if (AGENT_INVOKING_JOB_KINDS.has(kind)) {
    return Math.max(1, Math.floor(maxAgentRetryAttempts));
  }

  return DEFAULT_RETRYABLE_MAX_ATTEMPTS;
}

/**
 * Exponential backoff with jitter, capped at an hour. `attempt` is the number
 * of attempts already made, so the first retry waits the base delay.
 */
export function computeRetryDelayMs(
  attempt: number,
  options: { random?: () => number } = {},
): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  const raw = BASE_RETRY_DELAY_MS * Math.pow(2, Math.min(exponent, 20));
  const capped = Math.min(raw, MAX_RETRY_DELAY_MS);
  const random = options.random ?? Math.random;
  const jitter = capped * JITTER_FRACTION * (random() * 2 - 1);
  return Math.max(1_000, Math.round(capped + jitter));
}

const DEFAULT_PARK_RETRY_INTERVAL_MS = 3_600_000;
const DEFAULT_MAX_RECOVERY_AGE_MS = 86_400_000;

export type FailedJobRecoveryPolicy = {
  /** How long a parked job waits before automation gives it another cycle. */
  retryIntervalMs?: number;
  /** Stop reviving a job that has been failing for longer than this. */
  maxRecoveryAgeMs?: number;
};

export type RecoverableJob = {
  id: string;
  status: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Pick the parked jobs worth another cycle.
 *
 * Parking is not meant to be permanent. Most blocking conditions — an expired
 * credential, a CLI that was not on PATH, a repo that was briefly unreachable —
 * get fixed out of band, and nothing tells us when. Re-running the job on a long
 * interval *is* the probe: if the condition still holds it re-parks after a
 * single cheap attempt, and if it cleared the work simply resumes.
 *
 * Jobs that have been failing for longer than `maxRecoveryAgeMs` stop cycling
 * and stay parked, because at that point it really is something a person needs
 * to look at.
 */
export function planFailedJobRecovery(
  jobs: RecoverableJob[],
  nowMs: number,
  policy: FailedJobRecoveryPolicy = {},
): string[] {
  const retryIntervalMs = policy.retryIntervalMs ?? DEFAULT_PARK_RETRY_INTERVAL_MS;
  const maxRecoveryAgeMs = policy.maxRecoveryAgeMs ?? DEFAULT_MAX_RECOVERY_AGE_MS;

  return jobs
    .filter((job) => {
      if (job.status !== "failed") {
        return false;
      }

      const parkedAt = Date.parse(job.updatedAt);
      if (!Number.isFinite(parkedAt) || nowMs - parkedAt < retryIntervalMs) {
        return false;
      }

      const firstSeenAt = Date.parse(job.createdAt);
      if (Number.isFinite(firstSeenAt) && nowMs - firstSeenAt > maxRecoveryAgeMs) {
        return false;
      }

      return true;
    })
    .map((job) => job.id);
}
