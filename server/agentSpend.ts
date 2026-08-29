// PatchDeck + Coding-agent spend ledger, attribution, and rolling-hour ceiling
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import type {
  AgentInvocation,
  AgentInvocationOutcome,
  AgentSpendSummary,
  AgentWorkKind,
} from "@shared/schema";
import { childLogger } from "./logger";
import type { IStorage } from "./storage";

const log = childLogger("agentSpend");

/** Rolling window the ceiling is measured over. */
export const AGENT_SPEND_WINDOW_MS = 3_600_000;

/** How long ledger rows are kept before the retention sweep drops them. */
export const AGENT_SPEND_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Work kinds that do not count against the ceiling. `probe` is the fixed
 * one-token health check used by onboarding and diagnostics: opening Settings
 * must never be able to exhaust a budget.
 */
export const UNMETERED_WORK_KINDS: AgentWorkKind[] = ["probe"];

export type AgentWorkContext = {
  kind: AgentWorkKind;
  repo?: string | null;
  targetId?: string | null;
  agentRunId?: string | null;
  model?: string | null;
};

export class AgentBudgetExhaustedError extends Error {
  readonly used: number;
  readonly max: number;
  readonly resetsAt: string;

  constructor(params: { used: number; max: number; resetsAt: string }) {
    super(
      `Agent budget exhausted: ${params.used}/${params.max} agent runs in the last hour. `
      + `Work resumes as the window rolls forward (next slot around ${params.resetsAt}).`,
    );
    this.name = "AgentBudgetExhaustedError";
    this.used = params.used;
    this.max = params.max;
    this.resetsAt = params.resetsAt;
  }
}

export function isAgentBudgetExhaustedError(error: unknown): boolean {
  return error instanceof AgentBudgetExhaustedError;
}

const workContext = new AsyncLocalStorage<AgentWorkContext>();

/**
 * Wrap a unit of work so every coding-agent spawn inside it is attributed to
 * it. Nesting is allowed and the innermost context wins: CI healing runs inside
 * a babysit session and should be billed as `heal_ci`.
 */
export function withAgentWork<T>(context: AgentWorkContext, fn: () => Promise<T>): Promise<T> {
  return workContext.run(context, fn);
}

export function currentAgentWork(): AgentWorkContext | null {
  return workContext.getStore() ?? null;
}

/** Start of the rolling window, as an ISO timestamp comparable to `started_at`. */
export function spendWindowStart(now: Date): string {
  return new Date(now.getTime() - AGENT_SPEND_WINDOW_MS).toISOString();
}

/** The configured ceiling, normalised. 0 means unlimited. */
export async function resolveAgentCeiling(storage: IStorage): Promise<number> {
  const config = await storage.getConfig();
  return Math.max(0, Math.floor(config.maxAgentInvocationsPerHour));
}

/** Invocations inside the rolling window that count against the ceiling. */
export async function countMeteredAgentInvocations(storage: IStorage, now: Date): Promise<number> {
  return storage.countAgentInvocationsSince(spendWindowStart(now), {
    excludeKinds: UNMETERED_WORK_KINDS,
  });
}

/**
 * Pick the model the agent will actually run with. The ledger records the
 * resolved agent separately, so this is best-effort context for the row.
 */
export function resolveAgentModel(
  agent: AgentInvocation["agent"],
  settings?: { claudeModel?: string | null; codexModel?: string | null } | null,
): string | null {
  const model = agent === "claude" ? settings?.claudeModel : settings?.codexModel;
  return model && model.trim().length > 0 ? model : null;
}

export async function readAgentSpend(storage: IStorage, now: Date): Promise<AgentSpendSummary> {
  const max = await resolveAgentCeiling(storage);
  const windowStartedAt = spendWindowStart(now);
  const invocations = await storage.listAgentInvocationsSince(windowStartedAt, { limit: 5000 });
  const metered = invocations.filter((invocation) => !UNMETERED_WORK_KINDS.includes(invocation.workKind));

  const byKind = new Map<AgentWorkKind, { count: number; totalDurationMs: number }>();
  for (const invocation of invocations) {
    const entry = byKind.get(invocation.workKind) ?? { count: 0, totalDurationMs: 0 };
    entry.count += 1;
    entry.totalDurationMs += invocation.durationMs ?? 0;
    byKind.set(invocation.workKind, entry);
  }

  const used = metered.length;

  return {
    windowMs: AGENT_SPEND_WINDOW_MS,
    windowStartedAt,
    resetsAt: nextSlotAt(metered, max, now),
    max,
    used,
    remaining: max === 0 ? null : Math.max(0, max - used),
    exhausted: max > 0 && used >= max,
    byKind: Array.from(byKind.entries())
      .map(([workKind, entry]) => ({ workKind, ...entry }))
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * When the next slot frees up. With a rolling window that is the moment the
 * oldest invocation still inside the window ages out, not the top of the hour.
 */
function nextSlotAt(metered: AgentInvocation[], max: number, now: Date): string {
  if (max === 0 || metered.length < max) {
    return now.toISOString();
  }

  // `metered` arrives newest-first, so the row that has to age out to free a
  // slot is the one sitting on the ceiling boundary.
  const boundary = metered[max - 1];
  return new Date(new Date(boundary.startedAt).getTime() + AGENT_SPEND_WINDOW_MS).toISOString();
}

/**
 * True when a new agent spawn would exceed the ceiling. `max: 0` is unlimited.
 * Pass `ceiling` when the caller has already read config, so a hot poll loop
 * does not read it twice.
 */
export async function isAgentBudgetExhausted(
  storage: IStorage,
  now: Date,
  ceiling?: number,
): Promise<boolean> {
  const max = ceiling ?? await resolveAgentCeiling(storage);
  if (max === 0) {
    return false;
  }

  return (await countMeteredAgentInvocations(storage, now)) >= max;
}

/** Throws {@link AgentBudgetExhaustedError} when the ceiling has been reached. */
export async function assertAgentBudgetAvailable(storage: IStorage, now: Date): Promise<void> {
  const max = await resolveAgentCeiling(storage);
  if (max === 0) {
    return;
  }

  const used = await countMeteredAgentInvocations(storage, now);
  if (used < max) {
    return;
  }

  const summary = await readAgentSpend(storage, now);
  throw new AgentBudgetExhaustedError({ used, max, resetsAt: summary.resetsAt });
}

export type AgentSpendMeter = {
  /**
   * Gate, record, and time a single coding-agent process spawn. `run` is the
   * spawn itself; everything else is ledger bookkeeping.
   */
  meter<T extends { code: number; timedOut?: boolean }>(
    agent: AgentInvocation["agent"],
    run: () => Promise<T>,
  ): Promise<T>;
};

let installedMeter: AgentSpendMeter | null = null;

export function getInstalledAgentSpendMeter(): AgentSpendMeter | null {
  return installedMeter;
}

/** Test seam. */
export function uninstallAgentSpendMeter(): void {
  installedMeter = null;
}

/**
 * Install the meter for the process. Done once at boot so `agentRunner` keeps
 * no storage dependency and its existing tests run unmetered.
 */
export function installAgentSpendMeter(storage: IStorage, now: () => Date = () => new Date()): AgentSpendMeter {
  const meter: AgentSpendMeter = {
    async meter(agent, run) {
      const context = currentAgentWork();
      if (!context) {
        log.warn(
          { agent },
          "Coding agent invoked outside an attributed work context; recording as unattributed",
        );
      }

      const workKind: AgentWorkKind = context?.kind ?? "unattributed";
      const metered = !UNMETERED_WORK_KINDS.includes(workKind);

      if (metered) {
        await assertAgentBudgetAvailable(storage, now());
      }

      const startedAtDate = now();
      const invocation: AgentInvocation = {
        id: randomUUID(),
        workKind,
        agent,
        model: context?.model ?? null,
        repo: context?.repo ?? null,
        targetId: context?.targetId ?? null,
        agentRunId: context?.agentRunId ?? null,
        startedAt: startedAtDate.toISOString(),
        finishedAt: null,
        durationMs: null,
        exitCode: null,
        outcome: "running",
        error: null,
      };

      await storage.recordAgentInvocationStart(invocation);

      const finish = async (end: {
        outcome: AgentInvocationOutcome;
        exitCode: number | null;
        error: string | null;
      }) => {
        const finishedAtDate = now();
        await storage.recordAgentInvocationEnd(invocation.id, {
          finishedAt: finishedAtDate.toISOString(),
          durationMs: Math.max(0, finishedAtDate.getTime() - startedAtDate.getTime()),
          exitCode: end.exitCode,
          outcome: end.outcome,
          error: end.error,
        });
      };

      try {
        const result = await run();
        await finish({
          outcome: result.timedOut ? "timeout" : result.code === 0 ? "completed" : "failed",
          exitCode: result.code,
          error: null,
        });
        return result;
      } catch (error) {
        await finish({
          outcome: "failed",
          exitCode: null,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };

  installedMeter = meter;
  return meter;
}
