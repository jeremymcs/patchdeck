import test from "node:test";
import assert from "node:assert/strict";
import type { Config } from "@shared/schema";
import { buildOctokit } from "./github";
import { clearRateLimitStateForTests, clearRateLimited, getRateLimitState } from "./rateLimitState";

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
