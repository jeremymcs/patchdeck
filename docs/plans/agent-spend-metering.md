// PatchDeck + Agent Spend Metering Plan
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

# Agent Spend Metering

## Goal

PatchDeck knows how much paid agent work it has done, across every path that can
invoke one, and refuses to exceed a ceiling the user sets. Turning on Auto PRs,
Auto Issues, CI healing, and deployment healing at the same time becomes a
bounded decision instead of an open-ended one.

This closes the follow-up tracked in `docs/plans/resilient-automation.md:71-73`:

> A true rolling spend ceiling (max agent runs per hour, enforced before every
> invocation) was considered and deferred — `agentRuns` is PR-scoped today
> (`prId`, written only by `babysitter.ts`), so metering global spend needs
> accounting at every agent entry point. Tracked as a follow-up.

Success criteria (verifiable):

1. Every process spawn of `codex` or `claude` writes exactly one ledger row,
   including the paths that never touch a PR (issue decompose, release notes,
   social post, PR Q&A).
2. A ledger row survives deletion of the PR or issue it was working on.
3. With a ceiling configured and reached, the dispatcher stops claiming
   agent-invoking jobs. Nothing fails; jobs stay `queued` and flow again when
   the window rolls.
4. An agent invocation started *inside* an already-running job (CI healing,
   agent fallback, conflict repair) is refused once the ceiling is reached, and
   the refusal backs the job off rather than parking it.
5. `GET /api/agent-spend` reports used / remaining / reset time / breakdown by
   work kind, and the dashboard shows it.
6. `maxAgentInvocationsPerHour: 0` (the default) reproduces today's behaviour
   exactly.

## Current Behaviour (why nothing is counted)

`agent_runs` looks like a spend ledger and is not one. It is a **per-babysit-session
record** used for interrupted-run recovery and failure markers:

| Fact | Code | Consequence |
|---|---|---|
| One row per babysit session, not per CLI invocation. `phase` is mutated as the session progresses. | `babysitter.ts:3256-3282` | A session that evaluates, applies, falls back to the other agent, then repairs a conflict is *one* row. |
| `pr_id TEXT NOT NULL` with `FOREIGN KEY(pr_id) REFERENCES prs(id) ON DELETE CASCADE` | `sqliteStorage.ts:683-696` | Non-PR agent work cannot be represented, and PR-scoped history is destroyed when the PR record goes away. |
| Written only by `babysitter.ts` | `grep upsertAgentRun server/` | Issue work, CI healing, deployment healing, release notes, social posts, and PR Q&A are invisible. |
| No duration, exit code, model, or outcome-vs-cost fields | `shared/schema.ts:179-192` | `createdAt`/`updatedAt` give a rough session span, nothing per invocation. |

So `agent_runs` stays exactly as it is. This plan adds a separate ledger.

### Every path that spawns a paid agent

All of them funnel through **one function**, `runAgentCommand`
(`agentRunner.ts:132`), which is the whole reason this is tractable:

```
runAgentCommand(agent, args, options)          <- the choke point
  ├── evaluateFixNecessityWithAgent            agentRunner.ts:205
  ├── applyFixesWithAgent                      agentRunner.ts:281
  │     └── runAgentOneShot                    agentRunner.ts:320
  ├── checkAgentHealth                         agentRunner.ts:164   (probe, see below)
  └── called directly by three modules
```

| # | Caller | Site | Work kind | Job kind |
|---|---|---|---|---|
| 1 | `babysitter.ts` apply | `3694`, `4190`, `4211` | `babysit_pr` | `babysit_pr` |
| 2 | `babysitter.ts` evaluate | `3913`, `3921` | `evaluate_feedback` | `babysit_pr` |
| 3 | `issueWorkAgent.ts` | `482` | `work_issue` | `work_issue` |
| 4 | `issueDecompose.ts` | `189` | `decompose_issue` | `evaluate_issue` |
| 5 | `issueVerify.ts` | `147` | `verify_issue` | `verify_issue` |
| 6 | `ciHealingAgent.ts` | `332` | `heal_ci` | **none — runs inside `babysit_pr`** |
| 7 | `deploymentHealingAgent.ts` | `131` | `heal_deployment` | `heal_deployment` |
| 8 | `prQuestionAgent.ts` | `27` | `answer_pr_question` | `answer_pr_question` |
| 9 | `releaseAgent.ts` | `49`, `74` | `release_notes` | `process_release_run` |
| 10 | `releaseSocialPostAgent.ts` | `97` | `social_post` | `generate_social_changelog` |

Row 6 is the reason a dispatcher-only gate is not enough: CI healing is started
from inside `babysitter.ts:55` while a `babysit_pr` job is already leased, so the
dispatcher has no further say. Same for the fallback-agent re-run at
`babysitter.ts:4211`.

`checkAgentHealth` does spawn the CLI, but it is a fixed ~1-token probe used by
onboarding and diagnostics. It records as `outcome: "probe"` and is excluded
from the ceiling — otherwise opening Settings could exhaust a budget.

## Decisions

Recommended answers below. Items marked **CONFIRM** change the shape of the
feature and are worth a yes/no before implementation.

### 1. Unit of account

Count **invocations**, record **duration**, enforce on invocations.

Not tokens: neither `codex exec` nor `claude -p` reports token usage on stdout in
the shapes this app parses (`parseEvaluationOutput`, `summarizeCommandResult`),
and scraping it would couple PatchDeck to CLI output formats that change. Not
wall-clock minutes as the primary unit either — a 90-minute `applyFixesWithAgent`
(`timeoutMs = 5400000`, `agentRunner.ts:291`) and a 20-second one-shot cost wildly
different amounts, but invocation count is the number a user can reason about and
the one that maps to "how many times did this thing decide to spend money".
`duration_ms` goes in the ledger so a duration-based ceiling can be added later
without a second migration.

### 2. Window

**Rolling hour**, computed as `started_at >= now - 3600000`. Not calendar-hour
buckets: a calendar window lets 2× the ceiling run across a boundary, which is
exactly the burst an unattended overnight run produces.

### 3. Behaviour at the ceiling — **CONFIRM**

**Park-and-auto-resume**, modelled on drain mode. Jobs stay `queued`, the
dispatcher stops claiming agent-invoking kinds, and work resumes on its own as
the window rolls forward. No manual clear, no failed jobs, no lost work.

The alternative — hard stop requiring a manual reset — is safer against a
runaway but reintroduces exactly the "human clears errors" failure mode the
resilient-automation work removed. Recommending auto-resume.

### 4. Default value — **CONFIRM**

`maxAgentInvocationsPerHour: 0` meaning **unlimited**, matching how
`maxAgentRetryAttempts` shipped disabled-by-default in spirit. Upgrading changes
no behaviour; users opt in once the new spend view tells them what their normal
hour actually looks like.

The alternative is shipping a generous default (30/hour) so the safety net
exists without being configured. That is a behaviour change on upgrade for
anyone running busy repos, and PatchDeck has no data yet on what a normal hour
is. Recommending 0, then revisiting after a release of real numbers.

### 5. Context propagation — **CONFIRM**

`runAgentCommand` is the only place that sees every invocation, and it has no
idea what work it is serving. Two ways to fix that:

**(a) Explicit parameter.** Thread an `AgentInvocationContext` through all ten
call sites. Honest and greppable, matches the repo's dependency-injection
style. Costs: touches ten modules plus every injected seam
(`deps.applyFixesWithAgent` in `ciHealingAgent.ts:10`, `issueWorkAgent.ts:44`,
`deploymentHealingAgent.ts:35`, `runOneShot` in `issueDecompose.ts:20`,
`issueVerify.ts:22`), and an eleventh call site added next year silently escapes
the meter.

**(b) `AsyncLocalStorage`.** A new `server/agentSpend.ts` owns an ALS store.
Each entry point wraps its work once — `withAgentWork({ kind, repo, targetId }, fn)`
— and `runAgentCommand` reads the ambient context. One choke point, impossible to
bypass, and an invocation arriving with *no* context is a detectable bug that
logs at `warn` and still records as `kind: "unattributed"`.

Recommending **(b)**, with (a)'s discipline preserved by a test that asserts each
of the ten call sites runs inside a context. `AGENTS.md` favours simplicity and
surgical changes; (b) is ~40 lines and 10 one-line wrappers, (a) is a signature
change across ten modules and their test doubles.

### 6. Ledger retention

30 days, pruned by a sweep modelled on `logsRetention.ts`. Long enough for
week-over-week comparison, short enough that the table never becomes a
consideration.

## Design

### A. `shared/schema.ts`

```ts
export const agentWorkKindEnum = z.enum([
  "babysit_pr",
  "evaluate_feedback",
  "work_issue",
  "decompose_issue",
  "verify_issue",
  "heal_ci",
  "heal_deployment",
  "answer_pr_question",
  "release_notes",
  "social_post",
  "probe",
  "unattributed",
]);

export const agentInvocationOutcomeEnum = z.enum([
  "running", "completed", "failed", "timeout", "refused",
]);

export const agentInvocationSchema = z.object({
  id: z.string(),
  workKind: agentWorkKindEnum,
  agent: codingAgentSchema,
  model: z.string().nullable(),
  repo: z.string().nullable(),
  targetId: z.string().nullable(),
  agentRunId: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  exitCode: z.number().int().nullable(),
  outcome: agentInvocationOutcomeEnum,
  error: z.string().nullable(),
});
```

Config gains one field, next to `maxAgentRetryAttempts` (`shared/schema.ts:733`):

```ts
maxAgentInvocationsPerHour: z.number().int().nonnegative().default(0), // 0 = unlimited
```

### B. `sqliteStorage.ts`

Additive `CREATE TABLE IF NOT EXISTS` in the same block as the others
(`sqliteStorage.ts:683`). **No foreign key on any target id** — deliberate, so
the ledger survives `prs` cascade deletion (criterion 2).

```sql
CREATE TABLE IF NOT EXISTS agent_invocations (
  id            TEXT PRIMARY KEY,
  work_kind     TEXT NOT NULL,
  agent         TEXT NOT NULL,
  model         TEXT,
  repo          TEXT,
  target_id     TEXT,
  agent_run_id  TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  duration_ms   INTEGER,
  exit_code     INTEGER,
  outcome       TEXT NOT NULL,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_invocations_started_at
  ON agent_invocations(started_at);
CREATE INDEX IF NOT EXISTS idx_agent_invocations_kind_started_at
  ON agent_invocations(work_kind, started_at);
```

`IStorage` (`storage.ts:232`) gains, mirroring the `agentRun` trio:

```ts
recordAgentInvocationStart(row: AgentInvocation): Promise<AgentInvocation>;
recordAgentInvocationEnd(id: string, end: {
  finishedAt: string; durationMs: number; exitCode: number | null;
  outcome: AgentInvocationOutcome; error: string | null;
}): Promise<void>;
countAgentInvocationsSince(since: string, opts?: { excludeKinds?: AgentWorkKind[] }): Promise<number>;
summarizeAgentInvocations(since: string): Promise<AgentSpendSummary>;
pruneAgentInvocationsBefore(cutoff: string): Promise<number>;
```

Implemented in both `sqliteStorage.ts` and `memoryStorage.ts` (`memoryStorage.ts:75`
already holds `agentRuns` in a `Map`; same pattern).

### C. `server/agentSpend.ts` (new, the only new module)

```ts
export type AgentWorkContext = {
  kind: AgentWorkKind;
  repo?: string | null;
  targetId?: string | null;
  agentRunId?: string | null;
};

export class AgentBudgetExhaustedError extends Error {}

/** Wrap a unit of work so every agent spawn inside it is attributed. */
export function withAgentWork<T>(ctx: AgentWorkContext, fn: () => Promise<T>): Promise<T>;

/** Ambient context, or null when an invocation escaped attribution. */
export function currentAgentWork(): AgentWorkContext | null;

/** Rolling-hour usage. */
export function spendWindowStart(now: Date): string;
export async function readSpend(storage: IStorage, now: Date): Promise<AgentSpendSummary>;

/** Throws AgentBudgetExhaustedError when the ceiling is reached. 0 = unlimited. */
export async function assertBudgetAvailable(storage: IStorage, now: Date): Promise<void>;

/** Installed once at boot; agentRunner calls into it. */
export function installAgentSpendMeter(storage: IStorage, now: () => Date): void;
```

The meter is *installed* rather than imported directly by `agentRunner.ts` so the
agent runner keeps no storage dependency and its existing tests keep working with
no meter installed.

### D. `server/agentRunner.ts` — the only hot-path change

```ts
export async function runAgentCommand(
  agent: CodingAgent,
  args: string[],
  options?: Parameters<typeof runCommand>[2],
): Promise<CommandResult> {
  const meter = getInstalledMeter();
  if (!meter) {
    return runCommand((await resolveCommandPath(agent)) ?? agent, args, options);
  }
  return meter.meter(agent, () =>
    runCommand((await resolveCommandPath(agent)) ?? agent, args, options));
}
```

`meter.meter` does: read ambient context (warn + `unattributed` if absent) →
`assertBudgetAvailable` unless the kind is `probe` → write the `running` row →
run → write the terminal row in a `finally`, classifying `timeout` from
`CommandResult` and `failed` from a non-zero exit.

A crash between start and end leaves a `running` row. The boot-time sweep that
already reconciles interrupted `agent_runs` (`babysitter.ts:2290-2319`) gets a
sibling that closes orphaned invocations as `failed`. Counting a `running` row
toward the ceiling is correct in the meantime — an in-flight agent is spend.

### E. Gate 1 — dispatcher (cheap, correct, no failures)

`resolveClaimableKinds` (`backgroundJobDispatcher.ts:198`) already filters kinds
by capacity for `maxConcurrentBabysitRuns`. Extend it: when the ceiling is
reached, drop every member of `AGENT_INVOKING_JOB_KINDS`
(`failureRecovery.ts:22`). Jobs stay `queued`, exactly as under drain mode.

### F. Gate 2 — invocation (catches what the dispatcher cannot see)

`assertBudgetAvailable` throws `AgentBudgetExhaustedError` inside
`runAgentCommand`. This covers CI healing started mid-`babysit_pr`, the
fallback-agent re-run at `babysitter.ts:4211`, and conflict repair.

`classifyFailure` (`failureRecovery.ts`) classifies it **`transient`**, joining
the existing `/\bbudget is in the reserve band\b/i` pattern that already handles
the GitHub-budget analogue. Consequence: the job backs off and retries on the
free/generous cap rather than burning a paid `maxAgentRetryAttempts` slot — the
agent never ran, so it was not a paid attempt.

### G. Surfacing

- `GET /api/agent-spend` → `{ windowMs, max, used, remaining, resetsAt, byKind[], recent[] }`.
- Header pill beside the drain toggle, shown only when a ceiling is set:
  `18/30 agent runs this hour`. Amber at 80%, red plus "paused until HH:MM" at
  the ceiling. Reuses the drain-toggle affordance rather than adding a new one.
- Settings numeric field directly beneath **Max agent retry attempts**
  (`settings.tsx:1356`), with `0 = unlimited` help text.
- Per-PR and per-issue detail: invocation count for that target, from
  `targetId`. This is the first time either page can answer "how many agent runs
  has this thing cost me".
- MCP tool `get_agent_spend` + a `LOCAL_API.md` section.

### H. Retention

`pruneAgentInvocationsBefore(now - 30d)` on the existing logs-retention sweep
schedule (`logsRetention.ts`).

## Work Breakdown

| Step | Change | Verify |
|------|--------|--------|
| 1 | `shared/schema.ts`: `agentInvocationSchema`, enums, `maxAgentInvocationsPerHour`; `defaultConfig.ts` | `defaultConfig.test.ts` — new key present, default 0 |
| 2 | `sqliteStorage.ts` + `memoryStorage.ts` ledger methods | `storage.test.ts` — round-trip; **row survives PR delete**; `countAgentInvocationsSince` respects the window boundary |
| 3 | `server/agentSpend.ts` + `agentSpend.test.ts` | ALS context nests correctly; `assertBudgetAvailable` no-ops at 0; throws at the ceiling; `probe` excluded |
| 4 | `agentRunner.ts` meter hook | `agentRunner.test.ts` — no meter installed ⇒ byte-identical behaviour; installed ⇒ one row per spawn, terminal row written on throw and on timeout |
| 5 | Wrap all ten call sites in `withAgentWork` | A test enumerating the call-site modules asserts none invokes unattributed |
| 6 | Dispatcher gate in `resolveClaimableKinds` | `backgroundJobDispatcher.test.ts` — at ceiling, agent kinds unclaimable and `sync_watched_repos` still claimed; resumes as the window rolls |
| 7 | `AgentBudgetExhaustedError` ⇒ `transient` | `failureRecovery.test.ts` — classified transient, takes the free cap, does not park |
| 8 | Orphaned-`running` reconciliation at boot | `appRuntime.test.ts` — orphan closed as `failed`, counted while open |
| 9 | `/api/agent-spend` + MCP tool + `LOCAL_API.md` | `routes.test.ts` — shape, and `max: 0` reports unlimited |
| 10 | Header pill, Settings field, PR/issue counts | `client/src/lib` test + screenshot |
| 11 | 30-day prune on the retention sweep | `logsRetention.test.ts` |
| 12 | `npm run check`, `npx eslint .`, `npm run build`, `npm run test:all` | Green |

Steps 1–5 are the metering half and are independently shippable: they produce
the data with zero behaviour change. Steps 6–8 are the enforcement half. If the
ceiling decisions above need more thought, land 1–5 first and get a release of
real numbers before choosing a default.

## Outcome

All twelve steps landed. Decisions 3, 4, and 5 were confirmed as recommended:
park-and-auto-resume, `0` (unlimited) default, `AsyncLocalStorage` attribution.

Two things changed during implementation:

- **`babysitPR` was split rather than wrapped in place.** The public method is
  now a thin wrapper that establishes the `babysit_pr` context and delegates to
  a private `babysitPRInternal`. Wrapping the ~900-line body inline would have
  reindented the whole method for no behavioural gain. The wrapper does one
  extra `getPR` to attribute the repo, which is nothing next to a babysit run.
- **`decompose_issue` and `verify_issue` are attributed by their caller.**
  `issueDecompose.ts` and `issueVerify.ts` take no repo or issue identity, and
  their callers in `backgroundJobHandlers.ts` already have both in scope. The
  ALS context flows down, so no signature changed. The step-5 guard test knows
  about this exemption explicitly rather than silently.

The pre-commit quality pass pulled out one more thing: six call sites had each
open-coded the "which model will this agent use" lookup, and three of them used
a `claudeModel ?? codexModel` fallback that would label a codex run with the
Claude model. That is now `resolveAgentModel(agent, settings)` in
`agentSpend.ts`, with its own test.

Verification: `npm run check`, `npx eslint .`, `npm run build`, and
`npm run test:all` (827 tests) are green.

## Risks

- **A gate that strands work.** If the dispatcher filter is wrong, agent-invoking
  jobs never get claimed and automation silently dies. Mitigated by: `0` default
  (gate is inert until opted into), auto-resume on window roll, the header pill
  making the paused state visible, and step 6's test asserting non-agent kinds
  still flow.
- **ALS context lost across an await boundary.** Node's `AsyncLocalStorage`
  survives promise chains but is lost across a manual `setTimeout` bridge or an
  emitter hop. If any call site turns out to lose it, that invocation records as
  `unattributed` and logs at `warn` — it is still counted, just not attributed.
  Step 5's test is what catches it.
- **Double-counting a fallback.** `babysitter.ts:4190` and `:4211` are the
  primary agent and its fallback in one session. Both spawn a CLI, so both are
  genuinely spend and both should count. Noting it because the number will look
  higher than "runs" intuitively suggests — the pill is labelled *agent runs*,
  not *PRs worked*.
- **Ledger write on the agent hot path.** One INSERT before a process that runs
  for seconds to 90 minutes. Negligible, and better-sqlite3 is synchronous
  anyway.
- **`running` rows inflating the count after a hard kill.** Deliberate — an
  in-flight agent is spend — but a crash-loop could accumulate phantom spend
  until the boot sweep runs. The sweep runs at boot, so the exposure is one
  process lifetime.

## Out of scope

- Token or dollar accounting. Neither CLI reports it in a shape this app parses.
  `duration_ms` and `model` are recorded so it can be estimated later.
- Per-repo spend ceilings. `watchedRepoSchema` already carries per-repo
  overrides if it is wanted; the global ceiling is the safety net.
- A duration-based ceiling ("max agent minutes per hour"). The column lands in
  this work; the knob does not.
- Repurposing or migrating `agent_runs`. It stays a babysit-session record.
- Cost attribution across the fallback agent (which of the two produced the
  merged commit). That is the outcomes-dashboard question, not this one.
