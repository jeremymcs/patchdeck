import type { Express, Response } from "express";
import type { Server } from "http";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { claudeEffortSchema, codexReasoningEffortSchema, codingAgentSchema, configSchema, startReleaseSocialPostSchema } from "@shared/schema";
import type { Config } from "@shared/schema";
import {
  createAppRuntime,
  type AppRuntime,
  type AppRuntimeDependencies,
  isAppRuntimeError,
} from "./appRuntime";
import { createAppUpdateChecker, type AppUpdateChecker } from "./appUpdate";
import { GitHubIntegrationError } from "./github";
import {
  getKnownLogSources,
  readLogRecords,
  subscribeToLogs,
  type LogLevel,
  type LogRecord,
} from "./logger";
import { getRateLimitState } from "./rateLimitState";

const VALID_LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

type SseWritable = Pick<Response, "write">;

function parseLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== "string") return undefined;
  return (VALID_LEVELS as string[]).includes(value) ? (value as LogLevel) : undefined;
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

const TOKEN_MASK_PREFIX = "***";
const WEB_PASSWORD_MASK = "********";
const GITHUB_API_VERSION = "2022-11-28";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendAppAwareError(res: Response, error: unknown): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: error.errors[0]?.message ?? "Invalid request" });
    return;
  }

  if (error instanceof GitHubIntegrationError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  if (isAppRuntimeError(error)) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  res.status(500).json({ error: getErrorMessage(error) });
}

function maskToken(token: string): string {
  return token ? `${TOKEN_MASK_PREFIX}${token.slice(-4)}` : "";
}

function resolveMaskedGithubTokens(currentTokens: string[], requestedTokens: string[]): string[] {
  const existing = currentTokens.map((token) => ({
    token,
    masked: maskToken(token),
    used: false,
  }));

  return requestedTokens
    .map((requestedToken) => {
      const trimmed = requestedToken.trim();
      if (!trimmed) {
        return "";
      }

      if (trimmed.startsWith(TOKEN_MASK_PREFIX)) {
        const match = existing.find((entry) => !entry.used && entry.masked === trimmed);
        if (match) {
          match.used = true;
          return match.token;
        }
      }

      return trimmed;
    })
    .filter(Boolean);
}

export function writeServerLogSseEvent(res: SseWritable, record: LogRecord): boolean {
  return res.write(`id: ${record.seq}\ndata: ${JSON.stringify(record)}\n\n`) !== false;
}

function resolveConfigSecrets(current: Config, updates: Partial<Config>): Partial<Config> {
  const requestedTokens = updates.githubTokens
    ?? (updates.githubToken !== undefined ? [updates.githubToken] : undefined);
  const webPassword = updates.webPassword === WEB_PASSWORD_MASK
    ? current.webPassword
    : updates.webPassword;

  if (requestedTokens === undefined) {
    return updates.webPassword === undefined ? updates : { ...updates, webPassword };
  }

  const { githubToken: _legacyGithubToken, ...rest } = updates;
  return {
    ...rest,
    ...(updates.webPassword === undefined ? {} : { webPassword }),
    githubTokens: resolveMaskedGithubTokens(current.githubTokens, requestedTokens),
  };
}

function maskConfig(config: Config): Config {
  const githubTokens = config.githubTokens.map(maskToken);
  return {
    ...config,
    githubTokens,
    githubToken: githubTokens[0] ?? "",
    webPassword: config.webPassword ? WEB_PASSWORD_MASK : "",
  };
}

export type RouteDependencies = AppRuntimeDependencies & {
  runtime?: AppRuntime;
  appUpdateChecker?: AppUpdateChecker;
  testGitHubTokensFn?: (config: Config, watchedRepos: string[]) => Promise<GitHubTokenTestResponse>;
};

type GitHubTokenTestStatus = "ok" | "throttled" | "error";

type GitHubTokenTestResult = {
  index: number;
  token: string;
  status: GitHubTokenTestStatus;
  login: string | null;
  remaining: number | null;
  resetAt: string | null;
  message: string;
  repoProbe: string | null;
};

type GitHubTokenTestResponse = {
  testedAt: string;
  results: GitHubTokenTestResult[];
};

function parseRateLimitInfo(headers: Record<string, string | string[] | undefined>): { remaining: number | null; resetAt: string | null } {
  const remainingRaw = headers["x-ratelimit-remaining"];
  const resetRaw = headers["x-ratelimit-reset"];
  const remainingText = Array.isArray(remainingRaw) ? remainingRaw[0] : remainingRaw;
  const resetText = Array.isArray(resetRaw) ? resetRaw[0] : resetRaw;
  const remaining = typeof remainingText === "string" ? Number.parseInt(remainingText, 10) : Number.NaN;
  const resetEpoch = typeof resetText === "string" ? Number.parseInt(resetText, 10) : Number.NaN;
  return {
    remaining: Number.isFinite(remaining) ? remaining : null,
    resetAt: Number.isFinite(resetEpoch) ? new Date(resetEpoch * 1000).toISOString() : null,
  };
}

async function testGitHubTokens(config: Config, watchedRepos: string[]): Promise<GitHubTokenTestResponse> {
  const tokens = (config.githubTokens ?? []).map((token) => token.trim()).filter(Boolean);
  const firstWatchedRepo = watchedRepos[0] ?? null;
  const results: GitHubTokenTestResult[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const client = new Octokit({
      auth: token,
      request: {
        headers: {
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
      },
    });

    try {
      const user = await client.request("GET /user");
      const { remaining, resetAt } = parseRateLimitInfo(user.headers as Record<string, string>);
      let message = "Authenticated successfully";

      if (firstWatchedRepo) {
        const [owner, repo] = firstWatchedRepo.split("/");
        if (owner && repo) {
          try {
            await client.request("GET /repos/{owner}/{repo}", { owner, repo });
            message = `Authenticated and can access ${firstWatchedRepo}`;
          } catch (error) {
            const status = (error as { status?: number } | undefined)?.status;
            const detail = error instanceof Error ? error.message : String(error);
            message = status
              ? `Authenticated, but repo probe ${firstWatchedRepo} returned ${status}: ${detail}`
              : `Authenticated, but repo probe ${firstWatchedRepo} failed: ${detail}`;
          }
        }
      }

      results.push({
        index: index + 1,
        token: maskToken(token),
        status: remaining === 0 ? "throttled" : "ok",
        login: typeof user.data?.login === "string" ? user.data.login : null,
        remaining,
        resetAt,
        message,
        repoProbe: firstWatchedRepo,
      });
    } catch (error) {
      const status = (error as { status?: number; response?: { headers?: Record<string, string> } } | undefined)?.status;
      const headers = (error as { response?: { headers?: Record<string, string> } } | undefined)?.response?.headers ?? {};
      const { remaining, resetAt } = parseRateLimitInfo(headers);
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        index: index + 1,
        token: maskToken(token),
        status: status === 403 && remaining === 0 ? "throttled" : "error",
        login: null,
        remaining,
        resetAt,
        message: status ? `GitHub returned ${status}: ${message}` : message,
        repoProbe: firstWatchedRepo,
      });
    }
  }

  return {
    testedAt: new Date().toISOString(),
    results,
  };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express,
  dependencies: RouteDependencies = {},
): Promise<Server> {
  const runtime = dependencies.runtime ?? createAppRuntime(dependencies);
  const PR_DETAIL_CACHE_TTL_MS = 2_000;
  const PR_DETAIL_CACHE_MAX_ENTRIES = 200;
  const prDetailCache = new Map<string, {
    expiresAt: number;
    value: NonNullable<Awaited<ReturnType<AppRuntime["getPR"]>>>;
  }>();
  const invalidatePrDetailCache = (prId?: string): void => {
    if (prId) {
      prDetailCache.delete(prId);
      return;
    }
    prDetailCache.clear();
  };
  const appUpdateChecker = dependencies.appUpdateChecker ?? createAppUpdateChecker();
  const testGitHubTokensFn = dependencies.testGitHubTokensFn ?? testGitHubTokens;
  await runtime.start();

  httpServer.on("close", () => {
    runtime.stop();
  });

  app.get("/api/runtime", async (_req, res) => {
    res.json(await runtime.getRuntimeSnapshot());
  });

  app.get("/api/github-rate-limit", async (_req, res) => {
    const state = getRateLimitState();
    const serializeResource = (snapshot: typeof state.resources[keyof typeof state.resources]) => ({
      limited: snapshot.limited,
      resetAt: snapshot.resetAt ? snapshot.resetAt.toISOString() : null,
      recentlyLimited: snapshot.recentlyLimited,
      lastLimitedAt: snapshot.lastLimitedAt ? snapshot.lastLimitedAt.toISOString() : null,
    });
    res.json({
      limited: state.limited,
      resetAt: state.resetAt ? state.resetAt.toISOString() : null,
      recentlyLimited: state.recentlyLimited,
      lastLimitedAt: state.lastLimitedAt ? state.lastLimitedAt.toISOString() : null,
      resources: {
        core: serializeResource(state.resources.core),
        graphql: serializeResource(state.resources.graphql),
        search: serializeResource(state.resources.search),
      },
    });
  });

  app.post("/api/github-tokens/test", async (_req, res) => {
    try {
      const config = await runtime.getConfig();
      const watchedRepos = (await runtime.listRepoSettings()).map((repo) => repo.repo);
      res.json(await testGitHubTokensFn(config, watchedRepos));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/server-logs", (req, res) => {
    const records = readLogRecords({
      level: parseLevel(req.query.level),
      source: typeof req.query.source === "string" ? req.query.source : undefined,
      since: parsePositiveInt(req.query.since),
      search: typeof req.query.search === "string" ? req.query.search : undefined,
      limit: parsePositiveInt(req.query.limit) ?? 500,
    });
    res.json({
      records,
      sources: getKnownLogSources(),
      latestSeq: records.length > 0 ? records[records.length - 1].seq : (parsePositiveInt(req.query.since) ?? 0),
    });
  });

  app.get("/api/server-logs/stream", (req, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // Defeat any compression middleware that may be added later — SSE must not buffer.
    res.setHeader("Content-Encoding", "identity");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    let closed = false;
    let unsubscribe = () => {};
    const heartbeat = setInterval(() => {
      if (res.write(`: heartbeat ${Date.now()}\n\n`) === false) cleanup();
    }, 20_000);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      if (!res.writableEnded) res.end();
    };

    const send = (record: LogRecord) => {
      if (!writeServerLogSseEvent(res, record)) cleanup();
    };

    // Replay any backlog the client missed, if `since` was provided.
    const since = parsePositiveInt(req.query.since);
    if (since !== undefined) {
      const backlog = readLogRecords({ since, limit: 1000 });
      for (const record of backlog) {
        send(record);
        if (closed) return;
      }
    }

    unsubscribe = subscribeToLogs(send);

    req.on("close", cleanup);
    req.on("aborted", cleanup);
  });

  app.get("/api/activities", async (_req, res) => {
    res.json(await runtime.listActivities());
  });

  app.delete("/api/activities/failed", async (_req, res) => {
    try {
      res.json(await runtime.clearFailedActivities());
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/runtime/drain", async (req, res) => {
    try {
      const payload = z.object({
        enabled: z.boolean(),
        reason: z.string().optional(),
        waitForIdle: z.boolean().optional(),
        timeoutMs: z.number().int().positive().max(600000).optional(),
      }).parse(req.body);

      const updated = await runtime.setDrainMode(payload);
      if (payload.enabled && payload.waitForIdle && updated.drained === false) {
        return res.status(202).json(updated);
      }

      res.json(updated);
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/repos", async (_req, res) => {
    res.json(await runtime.listRepos());
  });

  app.get("/api/repos/settings", async (_req, res) => {
    res.json(await runtime.listRepoSettings());
  });

  app.post("/api/repos", async (req, res) => {
    try {
      const { repo } = z.object({ repo: z.string().min(1) }).parse(req.body);
      res.status(201).json(await runtime.addRepo(repo));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.patch("/api/repos/settings", async (req, res) => {
    try {
      const payload = z.object({
        repo: z.string().min(1),
        autoCreateReleases: z.boolean().optional(),
        ownPrsOnly: z.boolean().optional(),
        issueAutoEvaluate: z.boolean().optional(),
        issueAutoWork: z.boolean().optional(),
        prAutoMonitor: z.boolean().optional(),
        codingAgentOverride: codingAgentSchema.nullable().optional(),
        codexModel: z.string().nullable().optional(),
        codexReasoningEffort: codexReasoningEffortSchema.nullable().optional(),
        claudeModel: z.string().nullable().optional(),
        claudeEffort: claudeEffortSchema.nullable().optional(),
      }).refine(
        (value) => (
          value.autoCreateReleases !== undefined
          || value.ownPrsOnly !== undefined
          || value.issueAutoEvaluate !== undefined
          || value.issueAutoWork !== undefined
          || value.prAutoMonitor !== undefined
          || value.codingAgentOverride !== undefined
          || value.codexModel !== undefined
          || value.codexReasoningEffort !== undefined
          || value.claudeModel !== undefined
          || value.claudeEffort !== undefined
        ),
        "At least one repository setting must be provided",
      ).parse(req.body);
      const { repo, ...updates } = payload;
      res.json(await runtime.updateRepoSettings(repo, updates));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.delete("/api/repos/settings/:repo", async (req, res) => {
    try {
      const mode = z.enum(["soft", "hard"]).default("soft").parse(req.query.mode);
      res.json(await runtime.removeRepo(req.params.repo, mode));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/repos/sync", async (req, res) => {
    try {
      const fullSweep = req.query.fullSweep === "1" || req.query.fullSweep === "true";
      const scope = z.enum(["all", "prs", "issues"]).default("all").parse(req.query.scope);
      const result = await runtime.syncRepos({ fullSweep, scope });
      invalidatePrDetailCache();
      res.json(result);
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/repos/release", async (req, res) => {
    try {
      const { repo } = z.object({ repo: z.string().min(1) }).parse(req.body);
      res.status(201).json(await runtime.createManualRelease(repo));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/prs", async (_req, res) => {
    res.json(await runtime.listPRs("active"));
  });

  app.get("/api/prs/archived", async (_req, res) => {
    res.json(await runtime.listPRs("archived"));
  });

  app.get("/api/prs/:id", async (req, res) => {
    const now = Date.now();
    const cached = prDetailCache.get(req.params.id);
    if (cached && cached.expiresAt > now) {
      return res.json(cached.value);
    }

    const pr = await runtime.getPR(req.params.id);
    if (!pr) {
      return res.status(404).json({ error: "PR not found" });
    }

    prDetailCache.set(req.params.id, {
      value: pr,
      expiresAt: now + PR_DETAIL_CACHE_TTL_MS,
    });
    if (prDetailCache.size > PR_DETAIL_CACHE_MAX_ENTRIES) {
      for (const [id, entry] of Array.from(prDetailCache.entries())) {
        if (entry.expiresAt <= now || prDetailCache.size > PR_DETAIL_CACHE_MAX_ENTRIES) {
          prDetailCache.delete(id);
        }
        if (prDetailCache.size <= PR_DETAIL_CACHE_MAX_ENTRIES) {
          break;
        }
      }
    }

    res.json(pr);
  });

  app.post("/api/prs", async (req, res) => {
    try {
      const pr = await runtime.addPR(req.body?.url);
      invalidatePrDetailCache(pr.id);
      res.status(201).json(pr);
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.delete("/api/prs/:id", async (req, res) => {
    try {
      const result = await runtime.removePR(req.params.id);
      invalidatePrDetailCache(req.params.id);
      res.json(result);
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.patch("/api/prs/:id/watch", async (req, res) => {
    try {
      const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
      const pr = await runtime.setPRWatchEnabled(req.params.id, enabled);
      invalidatePrDetailCache(req.params.id);
      res.json(pr);
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/prs/:id/fetch", async (req, res) => {
    try {
      const pr = await runtime.fetchPRFeedback(req.params.id);
      invalidatePrDetailCache(req.params.id);
      res.json(pr);
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/prs/:id/triage", async (req, res) => {
    try {
      const pr = await runtime.triagePR(req.params.id);
      invalidatePrDetailCache(req.params.id);
      res.json(pr);
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/prs/:id/apply", async (req, res) => {
    try {
      const pr = await runtime.applyPR(req.params.id);
      invalidatePrDetailCache(req.params.id);
      res.json(pr);
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/prs/:id/babysit", async (req, res) => {
    try {
      const pr = await runtime.babysitPR(req.params.id);
      invalidatePrDetailCache(req.params.id);
      res.json(pr);
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.patch("/api/prs/:id/feedback/:feedbackId", async (req, res) => {
    try {
      const { decision } = z.object({
        decision: z.enum(["accept", "reject", "flag"]),
      }).parse(req.body);

      const pr = await runtime.setFeedbackDecision(req.params.id, req.params.feedbackId, decision);
      invalidatePrDetailCache(req.params.id);
      res.json(pr);
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/prs/:id/feedback/:feedbackId/retry", async (req, res) => {
    try {
      const pr = await runtime.retryFeedback(req.params.id, req.params.feedbackId);
      invalidatePrDetailCache(req.params.id);
      res.json(pr);
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/prs/:id/questions", async (req, res) => {
    try {
      res.json(await runtime.listPRQuestions(req.params.id));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/prs/:id/questions", async (req, res) => {
    try {
      res.status(201).json(await runtime.askQuestion(req.params.id, req.body?.question));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/issues", async (req, res) => {
    try {
      const query = z.object({
        limit: z.coerce.number().int().positive().max(100).optional(),
        offset: z.coerce.number().int().nonnegative().optional(),
      }).parse(req.query);
      res.json(await runtime.listIssues(query));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/issues/coverage", async (_req, res) => {
    try {
      res.json(await runtime.listIssueCoverage());
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/issues/:owner/:repo/:number", async (req, res) => {
    try {
      const payload = z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        number: z.coerce.number().int().positive(),
      }).parse(req.params);

      res.json(await runtime.getIssue(`${payload.owner}/${payload.repo}`, payload.number));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/issues/sync", async (req, res) => {
    try {
      const payload = z.object({
        repo: z.string().min(1),
        number: z.number().int().positive(),
      }).parse(req.body);
      res.json(await runtime.syncIssue(payload.repo, payload.number));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.patch("/api/issues/labels", async (req, res) => {
    try {
      const payload = z.object({
        repo: z.string().min(1),
        number: z.number().int().positive(),
        add: z.array(z.string().min(1)).optional(),
        remove: z.array(z.string().min(1)).optional(),
      }).parse(req.body);

      res.json(await runtime.updateIssueLabels(payload.repo, payload.number, {
        add: payload.add,
        remove: payload.remove,
      }));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/issues/work", async (req, res) => {
    try {
      const payload = z.object({
        repo: z.string().min(1),
        number: z.number().int().positive(),
      }).parse(req.body);

      res.status(201).json(await runtime.workIssue(payload.repo, payload.number));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.delete("/api/issues/work/failures", async (req, res) => {
    try {
      const payload = z.object({
        repo: z.string().min(1),
        number: z.number().int().positive(),
      }).parse(req.body);

      res.json(await runtime.clearIssueWorkFailures(payload.repo, payload.number));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/issues/evaluate", async (req, res) => {
    try {
      const payload = z.object({
        repo: z.string().min(1),
        number: z.number().int().positive(),
      }).parse(req.body);

      res.status(201).json(await runtime.evaluateIssue(payload.repo, payload.number));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/issues/verify", async (req, res) => {
    try {
      const payload = z.object({
        repo: z.string().min(1),
        number: z.number().int().positive(),
      }).parse(req.body);

      res.status(201).json(await runtime.verifyIssueWork(payload.repo, payload.number));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/logs", async (req, res) => {
    const prId = typeof req.query.prId === "string" ? req.query.prId : undefined;
    res.json(await runtime.listLogs(prId));
  });

  app.get("/api/onboarding/status", async (_req, res) => {
    try {
      res.json(await runtime.getOnboardingStatus());
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/onboarding/install-review", async (req, res) => {
    try {
      const { repo, tool } = z.object({
        repo: z.string().min(1),
        tool: z.enum(["claude", "codex"]),
      }).parse(req.body);

      res.json(await runtime.installReviewWorkflow(repo, tool));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/healing-sessions", async (_req, res) => {
    try {
      res.json(await runtime.listHealingSessions());
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/healing-sessions/:id", async (req, res) => {
    try {
      res.json(await runtime.getHealingSession(req.params.id));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/deployment-healing-sessions", async (req, res) => {
    try {
      const repo = typeof req.query.repo === "string" ? req.query.repo : undefined;
      res.json(await runtime.listDeploymentHealingSessions(repo));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/deployment-healing-sessions/:id", async (req, res) => {
    try {
      res.json(await runtime.getDeploymentHealingSession(req.params.id));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/config", async (_req, res) => {
    res.json(maskConfig(await runtime.getConfig()));
  });

  app.get("/api/app-update", async (_req, res) => {
    try {
      const currentVersion = process.env.APP_VERSION || "dev";
      res.json(await appUpdateChecker(currentVersion));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/changelogs", async (_req, res) => {
    try {
      res.json(await runtime.listSocialChangelogs());
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/changelogs/:id", async (req, res) => {
    try {
      res.json(await runtime.getSocialChangelog(req.params.id));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/releases", async (_req, res) => {
    try {
      res.json(await runtime.listReleaseRuns());
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/releases/:id", async (req, res) => {
    try {
      res.json(await runtime.getReleaseRun(req.params.id));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/releases/:id/retry", async (req, res) => {
    try {
      res.json(await runtime.retryReleaseRun(req.params.id));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/github-releases", async (_req, res) => {
    try {
      res.json(await runtime.listGitHubReleases());
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.post("/api/releases/social-post", async (req, res) => {
    try {
      const parsed = startReleaseSocialPostSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ message: "Invalid request", issues: parsed.error.flatten() });
        return;
      }
      res.json(await runtime.startReleaseSocialPost(parsed.data));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.get("/api/releases/social-post/:jobId", async (req, res) => {
    try {
      res.json(await runtime.getReleaseSocialPost(req.params.jobId));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  app.patch("/api/config", async (req, res) => {
    try {
      const updates = configSchema.partial().parse(req.body);
      const current = await runtime.getConfig();
      res.json(maskConfig(await runtime.updateConfig(resolveConfigSecrets(current, updates))));
    } catch (error: unknown) {
      sendAppAwareError(res, error);
    }
  });

  return httpServer;
}
