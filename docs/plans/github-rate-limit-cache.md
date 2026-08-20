# GitHub rate-limit: stop paying for the same data twice

Cut GitHub API spend on the paths we already identified. Keep product behavior (coverage numbers, PR babysitting, feedback, CI, releases). Do not add a generic Octokit HTTP cache.

## Goal

Quiet watched repos and dashboard polls should consume **zero primary Search budget** and **near-zero extra REST/GraphQL** after the first successful fetch. Restarts must not re-paginate every open PR list. Feedback GraphQL and CI-by-SHA must not rerun when the underlying data cannot have changed.

Success looks like:

- `/api/issues/coverage` never calls `GET /search/issues`
- Issues page still shows `synced N / GitHub M` from last sweep
- After process restart, a quiet repo’s open-PR list is a 304, not a full pagination
- Changed issue lists cost one page-1 GET, not two
- Unchanged PR comment lists skip GraphQL entirely
- Settled `owner/repo@sha` CI is fetched once per process
- `listMergedPullsSince` stops paging once `updated_at` is older than the since bound

## Non-goals

- Octokit plugin-cache / generic HTTP cache (stale CI and mergeable)
- Token rotation or extra PATs
- Changing `pollIntervalMs` as the fix
- Caching writes, diffs, timelines, or file contents
- Persisting CI snapshots to SQLite (in-memory by SHA is enough)

## Delivery

Work from a **fresh worktree of origin/main**, not `main` itself.

Five stacked PRs so each is reviewable and each has tests. One worktree, branch stack `fix/github-quota-coverage` → `…-pr-etags` → `…-feedback` → `…-ci-sha` → `…-merged-pulls` (or Graphite if available).

Copy this plan to `docs/plans/github-rate-limit-cache.md` in PR 1 so it is in-repo.

TDD on every behavior change (`test.md`). File headers match existing modules (no new copyright banners on files that do not have them).

---

## PR 1 — Coverage: no Search on UI poll

**Why first:** Search is 30 req/min. The Issues page refetches `/api/issues/coverage` on `getUiPollIntervalMs`, and each refetch hits Search once per watched repo.

**Behavior**

- `listIssueCoverage()` reads SQLite only: local `syncedOpenCount` + persisted `githubOpenCount` + `lastSyncedAt`. No Octokit.
- During the issue sweep (`syncStoredIssuesStep`), fetch open-issue count **once per repo that actually syncs** via GraphQL:

```graphql
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN) { totalCount }
  }
}
```

That is ~1 GraphQL point vs Search. Persist on `repo_sync_state` (`kind = 'issues'`).
- 304 probe path: **do not refetch** the count; previous value is still valid.
- Full sweep / successful page sync: write the new count.
- GraphQL count failure: leave previous count; coverage shows last known (`null` only if never observed).
- Issues page: keep polling `/api/issues/coverage` (now a local read). **Enable it while GitHub is throttled** so last-known counts still render. Update `fullAppQaSurface.test.ts` (today it asserts `!isGitHubThrottled`).

**Schema**

- `repo_sync_state.github_open_count INTEGER` via `ensureColumn`
- `RepoSyncState.githubOpenCount: number | null`
- `upsertRepoSyncState` accepts optional `githubOpenCount`
- Persist across reopen (`storage.test.ts` already has the etag reopen pattern)

**Files**

- `server/storage.ts`, `memoryStorage.ts`, `sqliteStorage.ts`, `storage.test.ts`
- `server/github.ts` — `fetchOpenIssueCount(octokit, repo)`
- `server/appRuntime.ts` — sweep writes count; `listIssueCoverage` does not call GitHub
- `server/appRuntime.test.ts` — coverage + 304 does not GraphQL; changed list does
- `client/src/pages/issues.tsx` — drop throttle gate on coverage query
- `client/src/lib/fullAppQaSurface.test.ts`

**Tests (red first)**

- `listIssueCoverage` with a stub octokit that throws if `request`/`graphql` is called — still returns persisted counts
- Sweep 200 path stores `githubOpenCount` from GraphQL `totalCount`
- Sweep 304 path does not call GraphQL and keeps the old count
- Sqlite reopen preserves `githubOpenCount`
- Issues page coverage query stays enabled when `githubRateLimit.limited === true`

**Verify:** `npx tsx --test server/appRuntime.test.ts server/storage.test.ts server/github.test.ts client/src/lib/fullAppQaSurface.test.ts` and `npm run check`

---

## PR 2 — Persist PR list cache + reuse issue page 1

**Why:** Issue etags already survive restart; PR etags do not. On restart the babysitter 304s then **falls back to a full `listOpenPullsForRepo`** because the in-memory list is gone (`babysitter.ts` ~2612–2615). Issue probe also downloads page 1 twice on a cache miss.

### 2a. PR list: persist etag **and** summaries

Persisting etag alone is not enough. 304 without a list still paginates.

- Add `github_etags.payload TEXT` via `ensureColumn`
- `getGithubEtag` stays as-is; add `getGithubEtagRecord(url) -> { etag, payload } | undefined` and `setGithubEtag(url, etag, payload?)`
- Key remains `prs:open:${repoSlug}` (use the same style as `issues:open:${repoSlug}`)
- On 200: write etag + `JSON.stringify(pulls)` and keep the in-memory map
- On 304: if memory miss, parse payload and reuse; **never** call `listOpenPullsForRepo` for a 304
- If 304 and payload missing (upgrade / first persist): treat as miss and do the conditional 200 path (no `If-None-Match`), then persist. Do not add a second uncached pagination helper call if the conditional already returned 304 with no payload — drop the etag and fetch without If-None-Match once.

Babysitter `prListCache` remains the hot path. Storage is the restart path.

### 2b. Issues: one page-1 GET

Replace `probeRepoIssuesChanged` + first `listOpenIssuesForRepo` with a pulls-style helper:

`listOpenIssuesForRepoConditional(octokit, repo, cachedEtag, { offset, limit })`

- Page 1 sends `If-None-Match`
- 304 → `{ notModified: true }` (unchanged)
- 200 → `{ notModified: false, etag, items, hasMore }` using the **same** page already fetched
- Further pages (full sweep) stay uncached, as today

`syncStoredIssuesStep` uses that result as offset 0. Existing 304 test (`listForRepoCalls === 1`) stays. Change the 200 test to assert **one** `listForRepo` call, not two.

Keep `probeRepoIssuesChanged` as a thin wrapper **only if** something else calls it; otherwise delete it and update `github.test.ts`.

**Files**

- `server/github.ts`, `github.test.ts`
- `server/babysitter.ts`, `babysitter.test.ts` (restart: 304 + persisted payload, zero `listOpenPullsForRepo`)
- `server/appRuntime.ts`, `appRuntime.test.ts`
- `server/storage.ts`, `sqliteStorage.ts`, `memoryStorage.ts`, `storage.test.ts`

**Tests**

- Sqlite stores/reloads etag+payload
- Babysitter 304 with empty memory uses persisted pulls; `listOpenPullsForRepo` not called
- Conditional issue list 200 returns items+etag in one GET
- `syncRepos` on a changed issue list: `listForRepoCalls === 1`

**Verify:** `npx tsx --test server/github.test.ts server/babysitter.test.ts server/appRuntime.test.ts server/storage.test.ts` and `npm run check`

---

## PR 3 — Feedback: 304-skip GraphQL + smaller nested page

**Why:** `fetchFeedbackItemsForPR` always paginates 3 REST lists **and** runs `reviewThreads(first: 100) { comments(first: 100) }`. That nested query is the GraphQL point bomb. On a quiet PR the comment lists are unchanged.

**Behavior**

- Manual page-1 `If-None-Match` on:
  - `pulls.listReviewComments`
  - `pulls.listReviews`
  - `issues.listComments`
- Persist three etags: `pr:${repo}#${n}:review-comments|reviews|issue-comments`
- If **all three** 304: return `{ notModified: true }`. Babysitter `syncFeedbackForPR` skips merge and keeps stored `feedbackItems`.
- If **any** 200: full fetch as today (paginate remaining pages, GraphQL threads), then persist new etags.
- Shrink `REVIEW_THREADS_QUERY` nested `comments(first: 100)` to `comments(first: 20)`. Overflow still uses `REVIEW_THREAD_COMMENTS_QUERY`. Cost ≈ 2.1k points/query instead of ~10k (and under GitHub’s 5k/query ceiling).

Do not try to persist comment bodies. All-304 means GitHub says nothing in those lists changed, so stored feedback is the source of truth.

**Files**

- `server/github.ts` — `fetchFeedbackItemsForPR` return type becomes `FeedbackItem[] | { notModified: true }` **or** keep the array and add `fetchFeedbackItemsForPRConditional`. Prefer a single function with an optional `{ etags }` input/output so babysitter owns persistence via existing `github_etags`.
- `server/babysitter.ts` — load/store the three etags around sync
- `server/github.test.ts` — 304 all three: graphql call count 0; mixed 304/200: GraphQL runs; pagination test updated for `first: 20`
- `server/babysitter.test.ts` — unchanged comments: no GraphQL, feedback items unmodified

**Tests**

- All-304 → no `graphql`, no extra REST pages
- One list 200 → GraphQL + that list’s body used
- Nested comments page size 20 still maps `databaseId` 21 via overflow query

**Verify:** `npx tsx --test server/github.test.ts server/babysitter.test.ts` and `npm run check`

---

## PR 4 — CI by SHA: one fetch, then reuse

**Why:** `getCombinedStatusForRef` + `checks.listForRef` run from `fetchCiPollResult`, `listFailingStatuses`, `checkCISettled`, and `fetchCheckSnapshotsForRef`. The babysit path at ~3884 calls `listFailingStatuses` **then** `fetchCheckSnapshotsForRef` (same two endpoints twice). Settled SHA results do not change.

**Behavior**

- One internal `loadCommitCheckState(octokit, repo, sha)` that hits the two endpoints (plus Actions job enrichment when needed).
- `fetchCiPollResult`, `listFailingStatuses`, `checkCISettled`, `fetchCheckSnapshotsForRef` all read that result.
- Process-local cache keyed by `${owner}/${repo}@${sha}`:
  - If last result is **settled** (no pending statuses/checks): return it
  - If unsettled: fetch again
- Babysitter ~3884: drop the extra `listFailingStatuses` call; derive failures from snapshots
- `pollForCICompletion` keeps low-priority re-polls; cache still applies so a settled SHA is not refetched
- Cache is in-memory only. Restart refetches once. Fine.

**Files**

- `server/github.ts`, `github.test.ts`
- `server/babysitter.ts` (the double-fetch site and poll loop)

**Tests**

- Two `fetchCiPollResult` calls for a settled SHA: one HTTP pair
- Unsettled SHA: second call hits GitHub again
- `fetchCheckSnapshotsForRef` after `fetchCiPollResult` on same SHA: zero extra HTTP
- Babysitter healing/status path: statuses+checks fetched once

**Verify:** `npx tsx --test server/github.test.ts server/babysitter.test.ts` and `npm run check`

---

## PR 5 — Early-stop merged-PR pagination

**Why:** `listMergedPullsSince` uses `octokit.paginate` over **all** closed PRs, then filters by `merged_at`. For a busy repo that is tens of REST pages per release preview.

**Behavior**

- Replace `paginate` with a manual `per_page: 100` loop (`sort: updated`, `direction: desc`), same as open-PR listing.
- After each page:
  - Apply the existing `merged_at` / merge-sha filters
  - **Stop** when every item on the page has `updated_at` older than `sinceMergedAt` (`merged_at <= updated_at`, so the since window cannot still be ahead)
  - **Stop** when `sinceMergeCommitSha` is found
- No since bound (and no sha): keep paging (same as today). `listUnreleasedMergedPulls` almost always has a release-date bound.

**Files**

- `server/github.ts`, `github.test.ts` (existing tests mock `paginate`; switch them to paged `pulls.list`)

**Tests**

- Two pages, page 2 all `updated_at` before since → `pulls.list` called twice, not a third time
- Boundary sha on page 1 → no page 2
- No since / no sha → pages until a short page (current unbounded behavior)
- Existing timestamp + sha filter assertions still pass

**Verify:** `npx tsx --test server/github.test.ts server/releaseManager.test.ts` and `npm run check`

---

## Execution order and gates

1. Fetch `origin/main`, create worktree, branch for PR 1
2. TDD → implement → `npm run check` + focused tests per PR
3. After PR 5: `npm run test:all`
4. UI: coverage is the only dashboard behavior change. After PR 1, with the app running, open Issues, confirm `synced N / GitHub M` still appears, Network tab shows `/api/issues/coverage` with **no** GitHub token use (server-side: no Search). If the app is not running, say so and rely on tests.
5. Open PRs as they complete; do not push to `main`

## Risk notes

- **Coverage freshness:** GitHub count updates on issue sweep (default 10 min), not every UI poll. That is the point. Manual full sweep still refreshes it.
- **PR payload size:** Open-PR JSON in `github_etags.payload` is small (summaries, not diffs). Hundreds of PRs is fine.
- **Feedback 304:** GitHub 304 on those three lists is the contract that comments/reviews did not change. Thread resolved-state that GitHub changes *without* touching comments is rare; accept that until someone files it. Do not add a fourth GraphQL poll to catch it.
- **CI cache:** Commit statuses can theoretically flip after “settled” if a check is rerun. Key stays SHA; a rerun on the same SHA would be stale until process restart **or** until we also invalidate when babysitter explicitly reruns Actions. Invalidate the SHA entry in `rerunFailedGitHubActionsRunsForSnapshots` (same PR 4).
- **Merged-PR sort:** Early-stop depends on `sort=updated`. Do not change sort.

## Out of scope unless a PR still 429s after this

- Secondary-limit pacing beyond the existing 67ms / search-concurrency=2 throttle
- GraphQL persisted queries
- Cross-process CI cache
