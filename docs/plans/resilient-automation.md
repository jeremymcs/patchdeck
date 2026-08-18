// PatchDeck + Unattended Failure Recovery Plan
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

# Unattended Failure Recovery

## Goal

PatchDeck runs without a human clearing errors. Every failure that *can* recover
does so on its own; only failures that genuinely need a person park, stay
visible, and auto-resume once the blocking condition clears.

Success criteria (verifiable):

1. A transient failure (GitHub 5xx, network reset, agent CLI timeout) never
   leaves a job in the terminal `failed` state.
2. An issue whose work job fails is picked up again automatically, and does not
   block its repo's issue queue while it backs off.
3. A PR does not stay in `status: "error"` when its work is still retrying.
4. A release run that errors is retried automatically.
5. Agent-auth / CLI-missing failures park with an operator warning and resume
   automatically once the agent is available again.

## Current Behaviour (why it stalls)

All automation flows through one queue (`background_jobs`, kinds:
`sync_watched_repos`, `babysit_pr`, `process_release_run`, `answer_pr_question`,
`evaluate_issue`, `verify_issue`, `work_issue`, `generate_social_changelog`,
`heal_deployment`). That makes the dispatcher the highest-leverage fix.

| # | Surface | Code | Behaviour |
|---|---------|------|-----------|
| 1 | Dispatcher retry policy | `backgroundJobDispatcher.ts:340` | 3 attempts, flat 30s backoff, then terminal `failed`. A 90-second GitHub blip exhausts the whole budget. No error classification. |
| 2 | Issue auto-work | `appRuntime.ts:360` | `workStatus` derives from the newest job. `failed` ⇒ the issue is excluded from auto-work *and* auto-evaluate permanently. |
| 3 | Issue single-flight | `appRuntime.ts:356` | Any `queued`/`in_progress` job in a repo blocks every other issue in that repo. |
| 4 | Issue work terminal-on-first-failure | `backgroundJobHandlers.ts:611` | Any thrown exception becomes `TerminalBackgroundJobError` — zero retries, even for a network error. |
| 5 | PR `status: "error"` | `babysitter.ts:2815,2847,4698` | Set on sync failure, dependency preflight failure, exhausted conflict repair. Cleared only by a manual queue (`appRuntime.ts:2080`). |
| 6 | Release runs | `releaseManager.ts:443` | `failRun` **swallows** the error: the job completes "successfully", the run sits in `error`, only `/api/releases/:id/retry` revives it. |
| 7 | Failed activity panel | `DashboardErrorsPanel.tsx` | Terminal failures accumulate until *Clear failed*. |

CI healing already self-heals: sessions are `superseded` when the head SHA
changes (`ciHealingManager.ts:104`). Its per-session/per-fingerprint budgets are
deliberate spend controls and stay as they are.

## Decisions (confirmed with the user)

- Retryable failures: exponential backoff, then park. Bounded, not infinite.
- Human-required failures (agent auth, CLI missing, unknown agent): park,
  surface as an operator warning, auto-resume when the condition clears.
- Agent spend is a user setting: `maxAgentRetryAttempts` (global, default 3),
  matching the existing `maxHealingAttemptsPerSession` knob. Per-repo override
  is deliberately out of scope; `watchedRepoSchema` already carries per-repo
  overrides if it is wanted later.

### Free vs paid retries

Retry cost is not uniform, and the setting only governs the paid half:

- **Free** — `sync_watched_repos`, and any failure that happens before the agent
  is invoked (GitHub 5xx, network reset, clone failure, rate-limit gate). These
  retry generously and are *not* gated by the spend setting. This is most of
  what strands automation today and it costs nothing.
- **Paid** — `babysit_pr`, `work_issue`, `evaluate_issue`, `verify_issue`,
  `heal_deployment`, `answer_pr_question`, `process_release_run` when the
  failure indicates the agent actually ran.

The split is derived from the failure class, not guessed per job: a `transient`
failure is infrastructure and takes the free cap; anything else on an
agent-invoking kind takes `maxAgentRetryAttempts`.

A true rolling spend ceiling (max agent runs per hour, enforced before every
invocation) was considered and deferred — `agentRuns` is PR-scoped today
(`prId`, written only by `babysitter.ts`), so metering global spend needs
accounting at every agent entry point. Tracked as a follow-up.

## Design

### A. `server/failureRecovery.ts` (new, pure, unit-testable)

```ts
export type FailureClass = "transient" | "retryable" | "blocked" | "terminal";
export function classifyFailure(error: unknown): FailureClass;
export function computeRetryDelayMs(attempt: number, klass: FailureClass): number;
export function shouldParkAfterAttempt(attempt: number, klass: FailureClass): boolean;
export const AGENT_INVOKING_JOB_KINDS: ReadonlySet<BackgroundJobKind>;
```

- `transient` — 5xx/408, `ECONNRESET`/`EAI_AGAIN`/`ETIMEDOUT`/`socket hang up`/
  `fetch failed`, rate-limit and budget-reserve gates, lock contention.
  Reuses the predicates already in `github.ts:806` and `rateLimitState.ts`.
- `blocked` — `detectAgentUnavailability()` from `agentRunner.ts:74` (auth,
  cli_missing, unknown_agent) plus repo permission denials.
- `terminal` — explicit `TerminalBackgroundJobError` / `CancelBackgroundJobError`.
- `retryable` — everything else (the safe default).

Backoff: exponential with jitter, `30s → 1m → 2m → 5m → 15m → 30m → 1h`, capped
at 1h. Attempt caps: `transient` 10, `retryable` 8. Roughly a 4-hour recovery
window before parking — long enough to ride out any real outage.

### B. Dispatcher: classified backoff (`backgroundJobDispatcher.ts`)

Rewrite `resolveFailureAction` to return `{action, delayMs}`:

- `CancelBackgroundJobError` → cancel (unchanged)
- `DeferBackgroundJobError` → defer (unchanged)
- `TerminalBackgroundJobError` → fail (parked)
- otherwise classify → `retry` with `computeRetryDelayMs` while under the class
  cap; `fail` (parked) once the cap is hit or the class is `blocked`.

Backing-off jobs stay `queued` with a future `availableAt`, so `failed` comes to
mean exactly "parked, needs a human". No schema change: the park sweep and the
UI re-derive the class from `lastError` with the same classifier.

### C. Issue queue: ignore backing-off jobs

`issueWorkStatusFromJobs` (`appRuntime.ts:506`) also returns `workAvailableAt`.
`planAutomaticIssueQueueActions` treats a `queued` job whose `availableAt` is in
the future as **not** occupying the repo's single-flight slot, and re-derives
such an issue as `idle` for candidate selection only when the queue entry is its
own. Additive nullable `workAvailableAt` on the `Issue` schema; the enum is
unchanged.

Fixes symptom 2 and prevents the new regression where one backing-off issue
would freeze its repo's queue for an hour.

### D. Issue work handler: stop being terminal on the first exception

`backgroundJobHandlers.ts:611` — classify instead. Only
`!repairResult.accepted` (the agent explicitly rejected the work) stays
`TerminalBackgroundJobError`. A thrown exception falls through to the
dispatcher's classified retry.

### E. PR error status tracks reality

- The babysitter sets `status: "error"` only when the failure is `blocked` or
  the job actually parked; a retryable failure keeps `watching` and records
  `lastSyncError`.
- Recovery sweep (below) resets `error → watching` for any PR whose newest job
  is queued/leased — i.e. work is still in flight.
- Dependency-preflight and terminal-conflict errors keep their existing
  head-SHA-scoped self-clear.

### F. Release runs retry

`releaseManager.processReleaseRun` rethrows after `failRun` so the job retries
under the dispatcher policy. `failRun` sets `status: "error"` only once the job
has parked, so a mid-retry run shows `publishing`/`evaluating`, not `error`.
`retryReleaseRun`'s existing reset path is unchanged.

### G. Recovery sweep (`appRuntime` watcher tick, default 10 min)

`planFailedJobRecovery(jobs, prs, now, policy)` — pure and unit-tested — returns
the jobs to revive:

- `blocked` jobs: re-probe the blocking condition (`commandExists` for
  `cli_missing`; a cheap auth probe for `auth`). Re-queue when it clears.
  Otherwise re-check hourly.
- Parked `transient`/`retryable` jobs: one revival attempt per hour, giving up
  once the job is older than `maxRecoveryAgeMs` (default 24h) — those stay in
  the panel as a genuine human-required item.
- PRs in `error` with live work → reset to `watching`.

New storage method `requeueFailedBackgroundJob(id, availableAt)` on `IStorage`,
`sqliteStorage`, and `memoryStorage`.

### H. Dashboard honesty

`DashboardErrorsPanel` currently shows only terminal failures — that stays
correct and gets quieter by construction. Activity rows for backing-off jobs
render "Retrying in 12m · attempt 3/10 · <error>" using the `attemptCount`,
`availableAt`, and `lastError` fields already on `ActivityItem`. No schema
change.

## Work Breakdown

| Step | Change | Verify |
|------|--------|--------|
| 1 | `failureRecovery.ts` + `failureRecovery.test.ts` | Unit tests for each class and the backoff curve |
| 2 | Dispatcher classified backoff | `backgroundJobDispatcher.test.ts`: transient failure retries past attempt 3; blocked parks immediately |
| 3 | Issue queue backing-off awareness | `appRuntime.test.ts`: backing-off issue does not block its repo; failed→revived issue is re-picked |
| 4 | Issue work handler classification | `backgroundJobHandlers.test.ts`: thrown network error retries; explicit rejection is terminal |
| 5 | PR error status accuracy | `babysitter.test.ts`: retryable sync failure leaves PR `watching` |
| 6 | Release run rethrow | `releaseManager.test.ts`: errored run is retried; parks only after the cap |
| 7 | Recovery sweep + storage method | `appRuntime.test.ts` + `storage.test.ts`: parked job revived once its cooldown elapses; blocked job revived once the CLI reappears |
| 8 | Activity UI retry state | `client/src/lib` test + visual check |
| 9 | `maxAgentRetryAttempts` config + Settings UI + MCP tool description | `defaultConfig.test.ts`, settings render test |
| 10 | `npm run check` + `npm run test:all` | Green |

## Outcome

All ten steps landed. `npm run check`, `npx eslint .`, `npm run build`, and
`npm run test:all` (784 tests) are green.

## Risks

- **Runaway agent spend.** More retries means more agent runs. Mitigated by:
  the user-owned `maxAgentRetryAttempts` cap, the free/paid split (infrastructure
  retries never invoke an agent), exponential backoff, the unchanged CI-healing
  spend budgets, and the unchanged `maxConcurrentIssueWork` cap.
- **Masking real breakage.** A repo that is genuinely broken now retries for 4h
  before parking. The activity row shows attempt count and last error
  throughout, so it is visible, just not blocking.
- **Backing-off jobs holding dedupe keys.** `enqueueBackgroundJob` dedupes on
  `queued`/`leased` (`sqliteStorage.ts:2827`), so a backing-off job now
  suppresses a fresh enqueue for the same target. This is correct - it is the
  same work - but a manual "run now" would look like a dead button. Resolved:
  `promoteQueuedJob` pulls a future-dated queued job forward to now on the
  manual PR and issue paths, and wakes the dispatcher.
- **Concurrency budget held by backing-off work.** `activeWorkCount` counted
  every queued job, so one issue backing off for an hour would have frozen all
  issue work under `maxConcurrentIssueWork: 1`. Resolved in step 3: a queued job
  scheduled for the future consumes neither the global budget nor its repo's
  single-flight slot.
