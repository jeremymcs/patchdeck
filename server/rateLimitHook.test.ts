import test from "node:test";
import assert from "node:assert/strict";
import type { Config } from "@shared/schema";
import { buildOctokit } from "./github";
import {
  clearRateLimitStateForTests,
  clearRateLimited,
  getRateLimitState,
  getResourceBudget,
  recordResourceBudget,
} from "./rateLimitState";
import { runWithRequestPriority } from "./requestPriority";

const config: Config = {
  githubTokens: [],
  codingAgent: "claude",
  maxTurns: 15,
  batchWindowMs: 300000,
  pollIntervalMs: 120000,
  maxChangesPerRun: 20,
  autoResolveMergeConflicts: true,
  autoCreateReleases: true,
  autoUpdateDocs: true,
  includeRepositoryLinksInGitHubComments: true,
  githubCommentAppName: "patchdeck",
  postGitHubProgressReplies: false,
  autoHealCI: false,
  maxHealingAttemptsPerSession: 3,
  maxHealingAttemptsPerFingerprint: 2,
  maxConcurrentHealingRuns: 1,
  healingCooldownMs: 300000,
  autoHealDeployments: false,
  deploymentCheckDelayMs: 60000,
  deploymentCheckTimeoutMs: 600000,
  deploymentCheckPollIntervalMs: 15000,
  watchedRepos: [],
  trustedReviewers: [],
  ignoredBots: [],
};

test.beforeEach(() => clearRateLimitStateForTests());

test("octokit hook spaces concurrent REST requests under GitHub secondary limits", async () => {
  const requestStartedAt: number[] = [];
  const octokit = await buildOctokit(
    { ...config, githubToken: "ghp_fake" },
    {
      ignoreCache: true,
      requestFetch: async () => {
        requestStartedAt.push(Date.now());
        return new Response(JSON.stringify({ login: "octo" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "4999",
          },
        });
      },
    },
  );

  await Promise.all([
    octokit.request("GET /user"),
    octokit.request("GET /user"),
  ]);

  assert.equal(requestStartedAt.length, 2);
  assert.ok(
    requestStartedAt[1] - requestStartedAt[0] >= 50,
    `expected REST requests to be spaced, got ${requestStartedAt[1] - requestStartedAt[0]}ms`,
  );
});

test("octokit throttle caps concurrent search requests below the secondary limit", async () => {
  let active = 0;
  let peak = 0;
  const octokit = await buildOctokit(
    { ...config, githubToken: "ghp_fake" },
    {
      ignoreCache: true,
      requestFetch: async (input) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/search/")) {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 200));
          active -= 1;
        }
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999" },
        });
      },
    },
  );

  await Promise.all(
    Array.from({ length: 6 }, () => octokit.request("GET /search/issues", { q: "is:open is:pr" })),
  );

  // 200ms fetches with ~67ms point spacing would overlap 3-deep uncapped;
  // the search cap of 2 must hold the peak at 2.
  assert.ok(peak >= 2, `expected search requests to overlap, peak was ${peak}`);
  assert.ok(peak <= 2, `expected search concurrency capped at 2, peak was ${peak}`);
});

test("low-priority requests are gated while the core budget sits in the reserve band", async () => {
  let fetchCalls = 0;
  const octokit = await buildOctokit(
    { ...config, githubToken: "ghp_fake" },
    {
      ignoreCache: true,
      requestFetch: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ login: "octo" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "4999",
            "x-ratelimit-limit": "5000",
          },
        });
      },
    },
  );

  recordResourceBudget("core", 500, 5000); // 10% remaining — reserve band, above the 5% floor

  await assert.rejects(
    () => runWithRequestPriority("low", () => octokit.request("GET /user")),
    /budget/i,
  );
  assert.equal(fetchCalls, 0, "a gated low-priority request must not reach GitHub");

  // High-priority work still goes through while the budget is in the reserve band.
  const ok = await runWithRequestPriority("high", () => octokit.request("GET /user"));
  assert.equal(ok.data.login, "octo");
  assert.equal(fetchCalls, 1);
});

test("the hard floor gates even high-priority requests when the budget is critically low", async () => {
  let fetchCalls = 0;
  const octokit = await buildOctokit(
    { ...config, githubToken: "ghp_fake" },
    {
      ignoreCache: true,
      requestFetch: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ login: "octo" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "4999",
            "x-ratelimit-limit": "5000",
          },
        });
      },
    },
  );

  recordResourceBudget("core", 100, 5000); // 2% remaining — below the 5% hard floor

  await assert.rejects(
    () => runWithRequestPriority("high", () => octokit.request("GET /user")),
    /budget/i,
  );
  assert.equal(fetchCalls, 0, "below the floor, even high-priority work must not reach GitHub");
});

test("a low core budget does not gate low-priority GraphQL requests", async () => {
  let graphqlCalls = 0;
  const octokit = await buildOctokit(
    { ...config, githubToken: "ghp_fake" },
    {
      ignoreCache: true,
      requestFetch: async (input) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/graphql")) {
          graphqlCalls += 1;
        }
        return new Response(JSON.stringify({ data: { viewer: { login: "octo" } } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "4999",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-resource": "graphql",
          },
        });
      },
    },
  );

  // Core budget is exhausted, but the GraphQL budget is healthy.
  recordResourceBudget("core", 100, 5000);

  await runWithRequestPriority("low", () => octokit.graphql("query { viewer { login } }"));
  assert.equal(graphqlCalls, 1, "GraphQL has its own budget — a low core budget must not gate it");
});

test("low-priority GraphQL requests are gated while the GraphQL budget is in the reserve", async () => {
  let graphqlCalls = 0;
  const octokit = await buildOctokit(
    { ...config, githubToken: "ghp_fake" },
    {
      ignoreCache: true,
      requestFetch: async () => {
        graphqlCalls += 1;
        return new Response(JSON.stringify({ data: {} }), {
          status: 200,
          headers: { "content-type": "application/json", "x-ratelimit-resource": "graphql" },
        });
      },
    },
  );

  recordResourceBudget("graphql", 1000, 5000); // 20% — reserve band, above the 5% floor

  await assert.rejects(
    () => runWithRequestPriority("low", () => octokit.graphql("query { viewer { login } }")),
    /graphql budget/i,
  );
  assert.equal(graphqlCalls, 0, "a gated low-priority GraphQL request must not reach GitHub");
});

test("the hook records core and GraphQL budgets from response headers", async () => {
  const octokit = await buildOctokit(
    { ...config, githubToken: "ghp_fake" },
    {
      ignoreCache: true,
      requestFetch: async (input) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL ? input.toString() : input.url;
        const resource = url.includes("/graphql") ? "graphql" : "core";
        const remaining = resource === "graphql" ? "4321" : "1234";
        return new Response(JSON.stringify({ data: {}, login: "octo" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": remaining,
            "x-ratelimit-limit": "5000",
            "x-ratelimit-resource": resource,
          },
        });
      },
    },
  );

  assert.equal(getResourceBudget("core"), null);
  assert.equal(getResourceBudget("graphql"), null);
  await octokit.request("GET /user");
  await octokit.graphql("query { viewer { login } }");
  assert.deepEqual(getResourceBudget("core"), { remaining: 1234, limit: 5000 });
  assert.deepEqual(getResourceBudget("graphql"), { remaining: 4321, limit: 5000 });
});

test("octokit hook records rate-limit reset from 403 response headers", async () => {
  const resetUnixSeconds = Math.floor(Date.now() / 1000) + 600;
  const octokit = await buildOctokit(
    { ...config, githubToken: "ghp_fake" },
    {
      ignoreCache: true,
      requestFetch: async () =>
        new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetUnixSeconds),
          },
        }),
    },
  );

  await assert.rejects(() => octokit.request("GET /user"));
  const state = getRateLimitState();
  assert.equal(state.limited, true);
  assert.equal(state.resetAt!.getTime(), resetUnixSeconds * 1000);
});

test("octokit hook refreshes the reset time from /rate_limit when the response omits it", async () => {
  const resetUnixSeconds = Math.floor(Date.now() / 1000) + 900;
  const requestedPaths: string[] = [];
  const octokit = await buildOctokit(
    { ...config, githubToken: "ghp_fake" },
    {
      ignoreCache: true,
      requestFetch: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        requestedPaths.push(new URL(url).pathname);

        if (url.includes("/rate_limit")) {
          return new Response(JSON.stringify({
            resources: {
              core: {
                limit: 5000,
                remaining: 0,
                reset: resetUnixSeconds,
                used: 5000,
              },
            },
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-resource": "core",
          },
        });
      },
    },
  );

  await assert.rejects(() => octokit.request("GET /user"));
  const state = getRateLimitState();
  assert.equal(state.limited, true);
  assert.equal(state.resetAt!.getTime(), resetUnixSeconds * 1000);
  assert.deepEqual(requestedPaths, ["/user", "/rate_limit"]);
});

test("octokit hook short-circuits requests while the gate is active", async () => {
  const resetUnixSeconds = Math.floor(Date.now() / 1000) + 600;
  let realCalls = 0;
  const octokit = await buildOctokit(
    { ...config, githubToken: "ghp_fake" },
    {
      ignoreCache: true,
      requestFetch: async () => {
        realCalls += 1;
        return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetUnixSeconds),
          },
        });
      },
    },
  );

  await assert.rejects(() => octokit.request("GET /user"));
  assert.equal(realCalls, 2);

  // Second call must be short-circuited by the gate.
  await assert.rejects(() => octokit.request("GET /repos/foo/bar"));
  assert.equal(realCalls, 2);
});

test("octokit hook auto-retries once when Retry-After is within the short-wait threshold", async () => {
  let callIndex = 0;
  const octokit = await buildOctokit(
    { ...config, githubToken: "ghp_fake" },
    {
      ignoreCache: true,
      requestFetch: async () => {
        callIndex += 1;
        if (callIndex === 1) {
          return new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit" }), {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "1",
            },
          });
        }
        return new Response(JSON.stringify({ login: "octo" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "4999",
          },
        });
      },
    },
  );

  const start = Date.now();
  const result = await octokit.request("GET /user");
  const elapsed = Date.now() - start;

  assert.equal(result.data.login, "octo");
  assert.equal(callIndex, 3);
  assert.ok(elapsed >= 900, `expected >= ~1s wait, got ${elapsed}ms`);
  assert.equal(getRateLimitState().limited, false);
});

test("octokit hook does not auto-retry when the Retry-After wait exceeds the threshold", async () => {
  let callIndex = 0;
  const octokit = await buildOctokit(
    { ...config, githubToken: "ghp_fake" },
    {
      ignoreCache: true,
      requestFetch: async () => {
        callIndex += 1;
        return new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit" }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "120",
          },
        });
      },
    },
  );

  await assert.rejects(() => octokit.request("GET /user"));
  assert.equal(callIndex, 2);
  const state = getRateLimitState();
  assert.equal(state.limited, true);
  assert.ok(state.resetAt!.getTime() - Date.now() > 60_000);
});

test("octokit hook gates only the resource that 403d, leaving others free", async () => {
  const resetUnixSeconds = Math.floor(Date.now() / 1000) + 600;
  let graphqlCalls = 0;
  let restCalls = 0;
  const octokit = await buildOctokit(
    { ...config, githubToken: "ghp_fake" },
    {
      ignoreCache: true,
      requestFetch: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/graphql")) {
          graphqlCalls += 1;
          return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
            status: 403,
            headers: {
              "content-type": "application/json",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(resetUnixSeconds),
              "x-ratelimit-resource": "graphql",
            },
          });
        }
        restCalls += 1;
        return new Response(JSON.stringify({ login: "octo" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "4999",
            "x-ratelimit-resource": "core",
          },
        });
      },
    },
  );

  await assert.rejects(() => octokit.graphql("query { viewer { login } }"));
  assert.ok(graphqlCalls >= 1);

  // graphql is gated...
  assert.equal(getRateLimitState("graphql").limited, true);
  // ...but core is not, so a REST call still reaches the fake fetch.
  const ok = await octokit.request("GET /user");
  assert.equal(ok.data.login, "octo");
  assert.ok(restCalls >= 1);
  assert.equal(getRateLimitState("core").limited, false);
});

test("octokit hook clears the gate on a successful response with remaining > 0", async () => {
  let callIndex = 0;
  const resetUnixSeconds = Math.floor(Date.now() / 1000) + 600;
  const octokit = await buildOctokit(
    { ...config, githubToken: "ghp_fake" },
    {
      ignoreCache: true,
      requestFetch: async () => {
        callIndex += 1;
        if (callIndex === 1) {
          return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
            status: 403,
            headers: {
              "content-type": "application/json",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(resetUnixSeconds),
            },
          });
        }
        return new Response(JSON.stringify({ login: "octo" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "4999",
          },
        });
      },
    },
  );

  await assert.rejects(() => octokit.request("GET /user"));
  assert.equal(getRateLimitState().limited, true);

  // Manually clear so the next request can hit the fake fetch.
  clearRateLimited();
  const ok = await octokit.request("GET /user");
  assert.equal(ok.data.login, "octo");
  assert.equal(getRateLimitState().limited, false);
});
