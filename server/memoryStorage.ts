import type {
  AgentRun,
  AgentRunStatus,
  BackgroundJob,
  BackgroundJobKind,
  BackgroundJobStatus,
  Config,
  CheckSnapshot,
  DeploymentHealingSession,
  DeploymentHealingState,
  IssueEvaluation,
  IssueSubtaskSet,
  LogEntry,
  FailureFingerprint,
  HealingAttempt,
  HealingAttemptStatus,
  NewPR,
  PR,
  PRSummary,
  PRQuestion,
  HealingSession,
  HealingSessionState,
  ReleaseRun,
  ReleaseRunStatus,
  RuntimeState,
  SocialChangelog,
  WatchedRepo,
} from "@shared/schema";
import {
  applyBackgroundJobUpdate,
  applyConfigUpdate,
  applyDeploymentHealingSessionUpdate,
  applyHealingAttemptUpdate,
  applyHealingSessionUpdate,
  applyIssueEvaluationUpdate,
  applyIssueSubtaskSetUpdate,
  applyPRQuestionUpdate,
  applyPRUpdate,
  applyReleaseRunUpdate,
  applySocialChangelogUpdate,
  applyWatchedRepoUpdate,
  createDeploymentHealingSession,
  createLogEntry,
  createBackgroundJob,
  createCheckSnapshot,
  createFailureFingerprint,
  createHealingAttempt,
  createHealingSession,
  createIssueEvaluation,
  createIssueSubtaskSet,
  createPR,
  createPRQuestion,
  createReleaseRun,
  createSocialChangelog,
  touchAgentRun,
} from "@shared/models";
import type { IStorage, StoredIssueRecord } from "./storage";
import { DEFAULT_CONFIG } from "./defaultConfig";

export class MemStorage implements IStorage {
  private prs: Map<string, PR> = new Map();
  private questions: Map<string, PRQuestion> = new Map();
  private logs: LogEntry[] = [];
  private config: Config = { ...DEFAULT_CONFIG };
  private runtimeState: RuntimeState = {
    drainMode: false,
    drainRequestedAt: null,
    drainReason: null,
  };
  private healingSessions: Map<string, HealingSession> = new Map();
  private healingAttempts: Map<string, HealingAttempt> = new Map();
  private checkSnapshots: Map<string, CheckSnapshot> = new Map();
  private failureFingerprints: Map<string, FailureFingerprint> = new Map();
  private releaseRuns: Map<string, ReleaseRun> = new Map();
  private agentRuns: Map<string, AgentRun> = new Map();
  private socialChangelogs: Map<string, SocialChangelog> = new Map();
  private backgroundJobs: Map<string, BackgroundJob> = new Map();
  private deploymentHealingSessions: Map<string, DeploymentHealingSession> = new Map();
  private repoSettings: Map<string, WatchedRepo> = new Map();
  private issueEvaluations: Map<string, IssueEvaluation> = new Map();
  private issueSubtaskSets: Map<string, IssueSubtaskSet> = new Map();
  private syncedIssues: Map<string, StoredIssueRecord> = new Map();

  private cloneConfig(config: Config): Config {
    return structuredClone(config);
  }

  private cloneHealingSession(session: HealingSession): HealingSession {
    return { ...session };
  }

  private cloneHealingAttempt(attempt: HealingAttempt): HealingAttempt {
    return {
      ...attempt,
      targetFingerprints: [...attempt.targetFingerprints],
    };
  }

  private cloneCheckSnapshot(snapshot: CheckSnapshot): CheckSnapshot {
    return { ...snapshot };
  }

  private cloneFailureFingerprint(fingerprint: FailureFingerprint): FailureFingerprint {
    return {
      ...fingerprint,
      selectedEvidence: [...fingerprint.selectedEvidence],
    };
  }

  private cloneReleaseRun(run: ReleaseRun): ReleaseRun {
    return {
      ...run,
      includedPrs: run.includedPrs.map((pr) => ({ ...pr })),
    };
  }

  private cloneBackgroundJob(job: BackgroundJob): BackgroundJob {
    return {
      ...job,
      payload: { ...job.payload },
    };
  }

  private toPRSummary(pr: PR): PRSummary {
    const { feedbackItems: _feedbackItems, ...summary } = pr;
    return summary;
  }

  async getPRs(): Promise<PR[]> {
    return Array.from(this.prs.values())
      .filter((pr) => pr.status !== "archived")
      .sort((a, b) => b.number - a.number);
  }

  async getArchivedPRs(): Promise<PR[]> {
    return Array.from(this.prs.values())
      .filter((pr) => pr.status === "archived")
      .sort((a, b) => b.number - a.number);
  }

  async getPR(id: string): Promise<PR | undefined> {
    return this.prs.get(id);
  }

  async getPRSummaries(): Promise<PRSummary[]> {
    return Array.from(this.prs.values())
      .filter((pr) => pr.status !== "archived")
      .sort((a, b) => b.number - a.number)
      .map((pr) => this.toPRSummary(pr));
  }

  async getArchivedPRSummaries(): Promise<PRSummary[]> {
    return Array.from(this.prs.values())
      .filter((pr) => pr.status === "archived")
      .sort((a, b) => b.number - a.number)
      .map((pr) => this.toPRSummary(pr));
  }

  async getPRByRepoAndNumber(repo: string, number: number): Promise<PR | undefined> {
    return Array.from(this.prs.values()).find((pr) => pr.repo === repo && pr.number === number);
  }

  async addPR(pr: NewPR): Promise<PR> {
    const full = createPR(pr);
    this.prs.set(full.id, full);
    return full;
  }

  async updatePR(id: string, updates: Partial<PR>): Promise<PR | undefined> {
    const existing = this.prs.get(id);
    if (!existing) return undefined;
    const updated = applyPRUpdate(existing, updates);
    this.prs.set(id, updated);
    return updated;
  }

  async removePR(id: string): Promise<boolean> {
    return this.prs.delete(id);
  }

  async getQuestions(prId: string): Promise<PRQuestion[]> {
    return Array.from(this.questions.values())
      .filter((q) => q.prId === prId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  async addQuestion(prId: string, question: string): Promise<PRQuestion> {
    const entry = createPRQuestion(prId, question);
    this.questions.set(entry.id, entry);
    return entry;
  }

  async updateQuestion(id: string, updates: Partial<PRQuestion>): Promise<PRQuestion | undefined> {
    const existing = this.questions.get(id);
    if (!existing) return undefined;
    const updated = applyPRQuestionUpdate(existing, updates);
    this.questions.set(id, updated);
    return updated;
  }

  async getLogs(prId?: string): Promise<LogEntry[]> {
    const logs = prId ? this.logs.filter((l) => l.prId === prId) : this.logs;
    return logs.slice(-200);
  }

  async addLog(
    prId: string,
    level: "info" | "warn" | "error",
    message: string,
    details?: {
      runId?: string | null;
      phase?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<LogEntry> {
    const entry = createLogEntry(prId, level, message, details);

    this.logs.push(entry);
    if (this.logs.length > 1000) {
      this.logs = this.logs.slice(-500);
    }

    return entry;
  }

  async addLogToFile(
    prId: string,
    level: "info" | "warn" | "error",
    message: string,
    details?: {
      runId?: string | null;
      phase?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<LogEntry> {
    return createLogEntry(prId, level, message, details);
  }

  async clearLogs(prId?: string): Promise<void> {
    if (prId) {
      this.logs = this.logs.filter((l) => l.prId !== prId);
      return;
    }

    this.logs = [];
  }

  async pruneLogs(options: { olderThan?: string; messagePrefix?: string }): Promise<number> {
    const before = this.logs.length;
    this.logs = this.logs.filter((entry) => {
      if (options.olderThan && entry.timestamp < options.olderThan) return false;
      if (options.messagePrefix && entry.message.startsWith(options.messagePrefix)) return false;
      return true;
    });
    return before - this.logs.length;
  }

  async getConfig(): Promise<Config> {
    return this.cloneConfig(this.config);
  }

  async updateConfig(updates: Partial<Config>): Promise<Config> {
    this.config = applyConfigUpdate(this.config, updates);
    this.syncRepoSettings();
    return this.cloneConfig(this.config);
  }

  async listRepoSettings(): Promise<WatchedRepo[]> {
    return Array.from(this.repoSettings.values())
      .sort((a, b) => a.repo.localeCompare(b.repo))
      .map((entry) => ({ ...entry }));
  }

  async getRepoSettings(repo: string): Promise<WatchedRepo | undefined> {
    const entry = this.repoSettings.get(repo);
    return entry ? { ...entry } : undefined;
  }

  async updateRepoSettings(
    repo: string,
    updates: Partial<Omit<WatchedRepo, "repo">>,
  ): Promise<WatchedRepo> {
    if (!this.config.watchedRepos.includes(repo)) {
      this.config = applyConfigUpdate(this.config, {
        watchedRepos: [...this.config.watchedRepos, repo].sort((a, b) => a.localeCompare(b)),
      });
    }

    const existing = this.repoSettings.get(repo) ?? {
      repo,
      autoCreateReleases: false,
      ownPrsOnly: true,
      issueAutoEvaluate: false,
      issueAutoWork: false,
      prAutoMonitor: true,
      codingAgentOverride: null,
      codexModel: null,
      codexReasoningEffort: null,
      claudeModel: null,
      claudeEffort: null,
    };
    const next = applyWatchedRepoUpdate(existing, updates);
    this.repoSettings.set(repo, next);
    this.syncRepoSettings();
    return { ...next };
  }

  async getIssueEvaluation(targetId: string): Promise<IssueEvaluation | undefined> {
    const evaluation = this.issueEvaluations.get(targetId);
    return evaluation ? { ...evaluation, safetyFlags: [...evaluation.safetyFlags], recommendedLabels: [...evaluation.recommendedLabels] } : undefined;
  }

  async upsertIssueEvaluation(
    evaluation: Omit<IssueEvaluation, "createdAt" | "updatedAt">,
  ): Promise<IssueEvaluation> {
    const existing = this.issueEvaluations.get(evaluation.targetId);
    const next = existing
      ? applyIssueEvaluationUpdate(existing, evaluation)
      : createIssueEvaluation(evaluation);
    this.issueEvaluations.set(next.targetId, next);
    return { ...next, safetyFlags: [...next.safetyFlags], recommendedLabels: [...next.recommendedLabels] };
  }

  async getIssueSubtasks(targetId: string): Promise<IssueSubtaskSet | undefined> {
    const set = this.issueSubtaskSets.get(targetId);
    return set ? { ...set, subtasks: set.subtasks.map((task) => ({ ...task })) } : undefined;
  }

  async upsertIssueSubtasks(
    input: Omit<IssueSubtaskSet, "analyzedAt" | "updatedAt"> & { analyzedAt?: string },
  ): Promise<IssueSubtaskSet> {
    const existing = this.issueSubtaskSets.get(input.targetId);
    const next = existing
      ? applyIssueSubtaskSetUpdate(existing, { ...input, analyzedAt: input.analyzedAt ?? existing.analyzedAt })
      : createIssueSubtaskSet(input);
    this.issueSubtaskSets.set(next.targetId, next);
    return { ...next, subtasks: next.subtasks.map((task) => ({ ...task })) };
  }

  async markRepoIssuesStale(repo: string): Promise<void> {
    for (const [key, record] of Array.from(this.syncedIssues.entries())) {
      if (record.repo !== repo) continue;
      this.syncedIssues.set(key, { ...record, isOpen: false });
    }
  }

  async upsertSyncedIssues(repo: string, issues: StoredIssueRecord["payload"][], seenAt: string): Promise<void> {
    for (const issue of issues) {
      const key = `${repo}#${issue.number}`;
      const existing = this.syncedIssues.get(key);
      if (existing?.isWorked) {
        continue;
      }
      this.syncedIssues.set(key, {
        repo,
        number: issue.number,
        payload: { ...issue },
        isOpen: true,
        isWorked: existing?.isWorked ?? false,
        firstSeenAt: existing?.firstSeenAt ?? seenAt,
        lastSeenAt: seenAt,
      });
    }
  }

  async listSyncedIssues(input: { repos: string[]; limit: number; offset: number; includeWorked?: boolean }): Promise<{ items: StoredIssueRecord[]; hasMore: boolean }> {
    const repos = new Set(input.repos.map((repo) => repo.toLowerCase()));
    const includeWorked = input.includeWorked ?? false;
    const all = Array.from(this.syncedIssues.values())
      .filter((record) => record.isOpen && repos.has(record.repo.toLowerCase()) && (includeWorked || !record.isWorked))
      .sort((a, b) => b.number - a.number);
    const items = all.slice(input.offset, input.offset + input.limit).map((record) => structuredClone(record));
    return { items, hasMore: input.offset + items.length < all.length };
  }

  async listSyncedIssueCounts(input: { repos: string[]; includeWorked?: boolean }): Promise<{ totalCount: number; repoTotals: Record<string, number> }> {
    const repos = new Set(input.repos.map((repo) => repo.toLowerCase()));
    const includeWorked = input.includeWorked ?? false;
    const repoTotals: Record<string, number> = {};
    let totalCount = 0;
    for (const record of Array.from(this.syncedIssues.values())) {
      if (!record.isOpen) continue;
      if (!repos.has(record.repo.toLowerCase())) continue;
      if (!includeWorked && record.isWorked) continue;
      repoTotals[record.repo] = (repoTotals[record.repo] ?? 0) + 1;
      totalCount += 1;
    }
    return { totalCount, repoTotals };
  }

  async getSyncedIssue(repo: string, number: number): Promise<StoredIssueRecord | undefined> {
    const record = this.syncedIssues.get(`${repo}#${number}`);
    return record ? structuredClone(record) : undefined;
  }

  async markSyncedIssueWorked(repo: string, number: number): Promise<void> {
    const key = `${repo}#${number}`;
    const existing = this.syncedIssues.get(key);
    if (!existing) return;
    this.syncedIssues.set(key, { ...existing, isWorked: true });
  }

  private syncRepoSettings(): void {
    const watchedRepos = new Set(this.config.watchedRepos);

    for (const repo of Array.from(watchedRepos)) {
      if (!this.repoSettings.has(repo)) {
        this.repoSettings.set(repo, {
          repo,
          autoCreateReleases: false,
          ownPrsOnly: true,
          issueAutoEvaluate: false,
          issueAutoWork: false,
          prAutoMonitor: true,
          codingAgentOverride: null,
          codexModel: null,
          codexReasoningEffort: null,
          claudeModel: null,
          claudeEffort: null,
        });
      }
    }

    for (const repo of Array.from(this.repoSettings.keys())) {
      if (!watchedRepos.has(repo)) {
        this.repoSettings.delete(repo);
      }
    }
  }

  async getHealingSession(id: string): Promise<HealingSession | undefined> {
    const session = this.healingSessions.get(id);
    return session ? this.cloneHealingSession(session) : undefined;
  }

  async getHealingSessionByPrAndHead(prId: string, initialHeadSha: string): Promise<HealingSession | undefined> {
    const session = Array.from(this.healingSessions.values()).find(
      (candidate) => candidate.prId === prId && candidate.initialHeadSha === initialHeadSha,
    );
    return session ? this.cloneHealingSession(session) : undefined;
  }

  async listHealingSessions(filters?: {
    status?: HealingSessionState;
    prId?: string;
    repo?: string;
  }): Promise<HealingSession[]> {
    return Array.from(this.healingSessions.values())
      .filter((session) => {
        if (filters?.status && session.state !== filters.status) return false;
        if (filters?.prId && session.prId !== filters.prId) return false;
        if (filters?.repo && session.repo !== filters.repo) return false;
        return true;
      })
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((session) => this.cloneHealingSession(session));
  }

  async createHealingSession(data: Omit<HealingSession, "id" | "startedAt" | "updatedAt">): Promise<HealingSession> {
    const entry = createHealingSession(data);
    this.healingSessions.set(entry.id, entry);
    return this.cloneHealingSession(entry);
  }

  async updateHealingSession(id: string, updates: Partial<HealingSession>): Promise<HealingSession | undefined> {
    const existing = this.healingSessions.get(id);
    if (!existing) return undefined;
    const updated = applyHealingSessionUpdate(existing, updates);
    this.healingSessions.set(id, updated);
    return this.cloneHealingSession(updated);
  }

  async getHealingAttempt(id: string): Promise<HealingAttempt | undefined> {
    const attempt = this.healingAttempts.get(id);
    return attempt ? this.cloneHealingAttempt(attempt) : undefined;
  }

  async listHealingAttempts(filters?: {
    sessionId?: string;
    status?: HealingAttemptStatus;
  }): Promise<HealingAttempt[]> {
    return Array.from(this.healingAttempts.values())
      .filter((attempt) => {
        if (filters?.sessionId && attempt.sessionId !== filters.sessionId) return false;
        if (filters?.status && attempt.status !== filters.status) return false;
        return true;
      })
      .sort((a, b) => {
        const attemptDiff = a.attemptNumber - b.attemptNumber;
        if (attemptDiff !== 0) return attemptDiff;
        return new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
      })
      .map((attempt) => this.cloneHealingAttempt(attempt));
  }

  async createHealingAttempt(data: Omit<HealingAttempt, "id" | "startedAt">): Promise<HealingAttempt> {
    const entry = createHealingAttempt(data);
    this.healingAttempts.set(entry.id, entry);
    return this.cloneHealingAttempt(entry);
  }

  async updateHealingAttempt(id: string, updates: Partial<HealingAttempt>): Promise<HealingAttempt | undefined> {
    const existing = this.healingAttempts.get(id);
    if (!existing) return undefined;
    const updated = applyHealingAttemptUpdate(existing, updates);
    this.healingAttempts.set(id, updated);
    return this.cloneHealingAttempt(updated);
  }

  async listCheckSnapshots(filters?: {
    prId?: string;
    sha?: string;
  }): Promise<CheckSnapshot[]> {
    return Array.from(this.checkSnapshots.values())
      .filter((snapshot) => {
        if (filters?.prId && snapshot.prId !== filters.prId) return false;
        if (filters?.sha && snapshot.sha !== filters.sha) return false;
        return true;
      })
      .sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime())
      .map((snapshot) => this.cloneCheckSnapshot(snapshot));
  }

  async createCheckSnapshot(data: Omit<CheckSnapshot, "id">): Promise<CheckSnapshot> {
    const entry = createCheckSnapshot(data);
    this.checkSnapshots.set(entry.id, entry);
    return this.cloneCheckSnapshot(entry);
  }

  async listFailureFingerprints(filters?: {
    sessionId?: string;
    sha?: string;
  }): Promise<FailureFingerprint[]> {
    return Array.from(this.failureFingerprints.values())
      .filter((fingerprint) => {
        if (filters?.sessionId && fingerprint.sessionId !== filters.sessionId) return false;
        if (filters?.sha && fingerprint.sha !== filters.sha) return false;
        return true;
      })
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .map((fingerprint) => this.cloneFailureFingerprint(fingerprint));
  }

  async createFailureFingerprint(data: Omit<FailureFingerprint, "id" | "createdAt">): Promise<FailureFingerprint> {
    const entry = createFailureFingerprint(data);
    this.failureFingerprints.set(entry.id, entry);
    return this.cloneFailureFingerprint(entry);
  }

  async getRuntimeState(): Promise<RuntimeState> {
    return { ...this.runtimeState };
  }

  async updateRuntimeState(updates: Partial<RuntimeState>): Promise<RuntimeState> {
    this.runtimeState = {
      ...this.runtimeState,
      ...updates,
    };

    return { ...this.runtimeState };
  }

  async getBackgroundJob(id: string): Promise<BackgroundJob | undefined> {
    const job = this.backgroundJobs.get(id);
    return job ? this.cloneBackgroundJob(job) : undefined;
  }

  async listBackgroundJobs(filters?: {
    kind?: BackgroundJobKind;
    status?: BackgroundJobStatus;
    dedupeKey?: string;
    targetId?: string;
  }): Promise<BackgroundJob[]> {
    return Array.from(this.backgroundJobs.values())
      .filter((job) => {
        if (filters?.kind && job.kind !== filters.kind) return false;
        if (filters?.status && job.status !== filters.status) return false;
        if (filters?.dedupeKey && job.dedupeKey !== filters.dedupeKey) return false;
        if (filters?.targetId && job.targetId !== filters.targetId) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.priority !== b.priority) {
          return a.priority - b.priority;
        }

        const availableDiff = new Date(a.availableAt).getTime() - new Date(b.availableAt).getTime();
        if (availableDiff !== 0) {
          return availableDiff;
        }

        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      })
      .map((job) => this.cloneBackgroundJob(job));
  }

  async enqueueBackgroundJob(data: {
    kind: BackgroundJobKind;
    targetId: string;
    dedupeKey: string;
    payload?: Record<string, unknown>;
    priority?: number;
    availableAt?: string;
  }): Promise<BackgroundJob> {
    const existing = Array.from(this.backgroundJobs.values()).find(
      (job) =>
        job.dedupeKey === data.dedupeKey
        && (job.status === "queued" || job.status === "leased"),
    );
    if (existing) {
      return this.cloneBackgroundJob(existing);
    }

    const entry = createBackgroundJob({
      kind: data.kind,
      targetId: data.targetId,
      dedupeKey: data.dedupeKey,
      payload: data.payload ?? {},
      priority: data.priority,
      availableAt: data.availableAt ?? new Date().toISOString(),
    });
    this.backgroundJobs.set(entry.id, entry);
    return this.cloneBackgroundJob(entry);
  }

  async claimNextBackgroundJob(params: {
    workerId: string;
    leaseToken: string;
    leaseExpiresAt: string;
    now: string;
    kinds?: BackgroundJobKind[];
  }): Promise<BackgroundJob | undefined> {
    const job = Array.from(this.backgroundJobs.values())
      .filter((entry) => {
        if (entry.status !== "queued") return false;
        if (new Date(entry.availableAt).getTime() > new Date(params.now).getTime()) return false;
        if (params.kinds && !params.kinds.includes(entry.kind)) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.priority !== b.priority) {
          return a.priority - b.priority;
        }

        const availableDiff = new Date(a.availableAt).getTime() - new Date(b.availableAt).getTime();
        if (availableDiff !== 0) {
          return availableDiff;
        }

        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      })[0];

    if (!job) {
      return undefined;
    }

    const updated = applyBackgroundJobUpdate(job, {
      status: "leased",
      leaseOwner: params.workerId,
      leaseToken: params.leaseToken,
      leaseExpiresAt: params.leaseExpiresAt,
      heartbeatAt: params.now,
      attemptCount: job.attemptCount + 1,
      completedAt: null,
    });
    this.backgroundJobs.set(updated.id, updated);
    return this.cloneBackgroundJob(updated);
  }

  async heartbeatBackgroundJob(
    id: string,
    leaseToken: string,
    heartbeatAt: string,
    leaseExpiresAt: string,
  ): Promise<BackgroundJob | undefined> {
    const existing = this.backgroundJobs.get(id);
    if (!existing || existing.status !== "leased" || existing.leaseToken !== leaseToken) {
      return undefined;
    }

    const updated = applyBackgroundJobUpdate(existing, {
      heartbeatAt,
      leaseExpiresAt,
    });
    this.backgroundJobs.set(id, updated);
    return this.cloneBackgroundJob(updated);
  }

  async completeBackgroundJob(id: string, leaseToken: string, completedAt: string): Promise<BackgroundJob | undefined> {
    const existing = this.backgroundJobs.get(id);
    if (!existing || existing.status !== "leased" || existing.leaseToken !== leaseToken) {
      return undefined;
    }

    const updated = applyBackgroundJobUpdate(existing, {
      status: "completed",
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      lastError: null,
      completedAt,
    });
    this.backgroundJobs.set(id, updated);
    return this.cloneBackgroundJob(updated);
  }

  async failBackgroundJob(id: string, leaseToken: string, error: string, completedAt: string): Promise<BackgroundJob | undefined> {
    const existing = this.backgroundJobs.get(id);
    if (!existing || existing.status !== "leased" || existing.leaseToken !== leaseToken) {
      return undefined;
    }

    const updated = applyBackgroundJobUpdate(existing, {
      status: "failed",
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      lastError: error,
      completedAt,
    });
    this.backgroundJobs.set(id, updated);
    return this.cloneBackgroundJob(updated);
  }

  async retryBackgroundJob(
    id: string,
    leaseToken: string,
    error: string,
    availableAt: string,
    updatedAt: string,
  ): Promise<BackgroundJob | undefined> {
    const existing = this.backgroundJobs.get(id);
    if (!existing || existing.status !== "leased" || existing.leaseToken !== leaseToken) {
      return undefined;
    }

    const updated = applyBackgroundJobUpdate(existing, {
      status: "queued",
      availableAt,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      lastError: error,
      completedAt: null,
      updatedAt,
    });
    this.backgroundJobs.set(id, updated);
    return this.cloneBackgroundJob(updated);
  }

  async cancelBackgroundJob(
    id: string,
    leaseToken: string,
    error: string | null,
    completedAt: string,
  ): Promise<BackgroundJob | undefined> {
    const existing = this.backgroundJobs.get(id);
    if (!existing || existing.status !== "leased" || existing.leaseToken !== leaseToken) {
      return undefined;
    }

    const updated = applyBackgroundJobUpdate(existing, {
      status: "canceled",
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      lastError: error,
      completedAt,
    });
    this.backgroundJobs.set(id, updated);
    return this.cloneBackgroundJob(updated);
  }

  async requeueExpiredBackgroundJobs(now: string): Promise<number> {
    const expired = Array.from(this.backgroundJobs.values()).filter(
      (job) =>
        job.status === "leased"
        && job.leaseExpiresAt !== null
        && new Date(job.leaseExpiresAt).getTime() <= new Date(now).getTime(),
    );

    for (const job of expired) {
      const updated = applyBackgroundJobUpdate(job, {
        status: "queued",
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        completedAt: null,
      });
      this.backgroundJobs.set(updated.id, updated);
    }

    return expired.length;
  }

  async clearFailedBackgroundJobs(filters: { kind?: BackgroundJobKind; targetId?: string } = {}): Promise<number> {
    const failed = Array.from(this.backgroundJobs.values()).filter((job) =>
      job.status === "failed"
      && (!filters.kind || job.kind === filters.kind)
      && (!filters.targetId || job.targetId === filters.targetId),
    );
    for (const job of failed) {
      this.backgroundJobs.delete(job.id);
    }
    return failed.length;
  }

  async getReleaseRun(id: string): Promise<ReleaseRun | undefined> {
    const run = this.releaseRuns.get(id);
    return run ? this.cloneReleaseRun(run) : undefined;
  }

  async getReleaseRunByRepoAndMergeSha(repo: string, triggerMergeSha: string): Promise<ReleaseRun | undefined> {
    const run = Array.from(this.releaseRuns.values()).find(
      (candidate) => candidate.repo === repo && candidate.triggerMergeSha === triggerMergeSha,
    );
    return run ? this.cloneReleaseRun(run) : undefined;
  }

  async getReleaseRunByTrigger(repo: string, triggerPrNumber: number, triggerMergeSha: string): Promise<ReleaseRun | undefined> {
    const run = Array.from(this.releaseRuns.values()).find(
      (candidate) =>
        candidate.repo === repo
        && candidate.triggerPrNumber === triggerPrNumber
        && candidate.triggerMergeSha === triggerMergeSha,
    );
    return run ? this.cloneReleaseRun(run) : undefined;
  }

  async listReleaseRuns(filters?: {
    status?: ReleaseRunStatus;
    repo?: string;
  }): Promise<ReleaseRun[]> {
    return Array.from(this.releaseRuns.values())
      .map((run, index) => ({ run, index }))
      .filter((run) => {
        if (filters?.status && run.run.status !== filters.status) return false;
        if (filters?.repo && run.run.repo !== filters.repo) return false;
        return true;
      })
      .sort((a, b) => {
        const createdDiff = new Date(b.run.createdAt).getTime() - new Date(a.run.createdAt).getTime();
        if (createdDiff !== 0) {
          return createdDiff;
        }

        // If timestamps match to the same millisecond, prefer later insertion.
        return b.index - a.index;
      })
      .map(({ run }) => this.cloneReleaseRun(run));
  }

  async createReleaseRun(data: Omit<ReleaseRun, "id" | "createdAt" | "updatedAt">): Promise<ReleaseRun> {
    const entry = createReleaseRun(data);
    this.releaseRuns.set(entry.id, entry);
    return this.cloneReleaseRun(entry);
  }

  async updateReleaseRun(id: string, updates: Partial<ReleaseRun>): Promise<ReleaseRun | undefined> {
    const existing = this.releaseRuns.get(id);
    if (!existing) return undefined;
    const updated = applyReleaseRunUpdate(existing, updates);
    this.releaseRuns.set(id, updated);
    return this.cloneReleaseRun(updated);
  }

  async getAgentRun(id: string): Promise<AgentRun | undefined> {
    const run = this.agentRuns.get(id);
    return run ? { ...run } : undefined;
  }

  async listAgentRuns(filters?: { status?: AgentRunStatus; prId?: string }): Promise<AgentRun[]> {
    const runs = Array.from(this.agentRuns.values())
      .filter((run) => {
        if (filters?.status && run.status !== filters.status) return false;
        if (filters?.prId && run.prId !== filters.prId) return false;
        return true;
      })
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    return runs.map((run) => ({ ...run }));
  }

  async upsertAgentRun(run: AgentRun): Promise<AgentRun> {
    const existing = this.agentRuns.get(run.id);
    const stored = existing ? touchAgentRun(existing, run) : { ...run };
    this.agentRuns.set(run.id, stored);
    return { ...stored };
  }

  async getSocialChangelogs(): Promise<SocialChangelog[]> {
    return Array.from(this.socialChangelogs.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  async getSocialChangelog(id: string): Promise<SocialChangelog | undefined> {
    return this.socialChangelogs.get(id);
  }

  async getSocialChangelogForDateAndCount(date: string, triggerCount: number): Promise<SocialChangelog | undefined> {
    return Array.from(this.socialChangelogs.values()).find(
      (c) => c.date === date && c.triggerCount === triggerCount,
    );
  }

  async createSocialChangelog(data: Omit<SocialChangelog, "id" | "createdAt">): Promise<SocialChangelog> {
    const entry = createSocialChangelog(data);
    this.socialChangelogs.set(entry.id, entry);
    return entry;
  }

  async updateSocialChangelog(id: string, updates: Partial<SocialChangelog>): Promise<SocialChangelog | undefined> {
    const existing = this.socialChangelogs.get(id);
    if (!existing) return undefined;
    const updated = applySocialChangelogUpdate(existing, updates);
    this.socialChangelogs.set(id, updated);
    return updated;
  }

  async getDeploymentHealingSession(id: string): Promise<DeploymentHealingSession | undefined> {
    const session = this.deploymentHealingSessions.get(id);
    return session ? { ...session } : undefined;
  }

  async getDeploymentHealingSessionByRepoAndMergeSha(repo: string, mergeSha: string): Promise<DeploymentHealingSession | undefined> {
    const session = Array.from(this.deploymentHealingSessions.values()).find(
      (candidate) => candidate.repo === repo && candidate.mergeSha === mergeSha,
    );
    return session ? { ...session } : undefined;
  }

  async listDeploymentHealingSessions(filters?: { repo?: string; state?: DeploymentHealingState }): Promise<DeploymentHealingSession[]> {
    return Array.from(this.deploymentHealingSessions.values())
      .filter((session) => {
        if (filters?.repo && session.repo !== filters.repo) return false;
        if (filters?.state && session.state !== filters.state) return false;
        return true;
      })
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((session) => ({ ...session }));
  }

  async createDeploymentHealingSession(data: Omit<DeploymentHealingSession, "id" | "createdAt" | "updatedAt">): Promise<DeploymentHealingSession> {
    const entry = createDeploymentHealingSession(data);
    this.deploymentHealingSessions.set(entry.id, entry);
    return { ...entry };
  }

  async updateDeploymentHealingSession(id: string, updates: Partial<DeploymentHealingSession>): Promise<DeploymentHealingSession | undefined> {
    const existing = this.deploymentHealingSessions.get(id);
    if (!existing) return undefined;
    const updated = applyDeploymentHealingSessionUpdate(existing, updates);
    this.deploymentHealingSessions.set(id, updated);
    return { ...updated };
  }
}
