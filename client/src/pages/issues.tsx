import { Component, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CircleDashed, CircleSlash, ExternalLink, Loader2, Plus, RefreshCw, ShieldCheck, Trash2, Wrench, X } from "lucide-react";
import { apiRequest, fetchJson, queryClient } from "@/lib/queryClient";
import { AppHeader } from "@/components/AppHeader";
import { UpdateBanner } from "@/components/UpdateBanner";
import { toast } from "@/hooks/use-toast";
import { issueListPageSchema, issueSchema, type ActivityItem, type ActivitySnapshot, type Config, type Issue, type IssueListPage, type IssueSubtask, type LogEntry, type RuntimeState } from "@shared/schema";
import { Skeleton } from "@/components/ui/skeleton";
import { buildQueueStatusIndex, type QueueStatusView } from "@/lib/activityQueue";
import { QueueStatusBadge } from "@/components/QueueStatusBadge";
import { ActivityMenu, EMPTY_ACTIVITY_SNAPSHOT } from "@/components/ActivityMenu";
import { DashboardErrorsPanel } from "@/components/DashboardErrorsPanel";
import { DetailHeader } from "@/components/detail/DetailHeader";
import { DetailPanel } from "@/components/detail/DetailPanel";
import { MetaBreadcrumb, type MetaItem } from "@/components/detail/MetaBreadcrumb";
import { StageProgressBar } from "@/components/detail/StageProgressBar";
import { StatusChip } from "@/components/detail/StatusChip";
import { buildIssueStages } from "@/lib/stages";
import { autoWorkTone, issueEvaluationTone, issueRowTone, issueWorkStatusTone, toneRailClass } from "@/lib/statusTones";
import { getUiPollIntervalMs } from "@/lib/polling";

const ISSUES_CACHE_KEY = "patchdeck:issues-cache:v2";
const ISSUES_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const ISSUES_PAGE_SIZE = 100;
const LIVE_POLL_INTERVAL_MS = 5000;
const AUTOMATION_LABELS = new Set(["blocked", "ready-for-agent", "needs-maintainer-review"]);

function readCachedIssues(): { data: IssueListPage; updatedAt: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ISSUES_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data?: unknown; updatedAt?: unknown };
    if (!parsed.data || typeof parsed.updatedAt !== "number" || !Number.isFinite(parsed.updatedAt)) {
      return null;
    }
    if (Date.now() - parsed.updatedAt > ISSUES_CACHE_MAX_AGE_MS) {
      return null;
    }
    const normalized = issueListPageSchema.safeParse(parsed.data);
    if (!normalized.success) {
      window.localStorage.removeItem(ISSUES_CACHE_KEY);
      return null;
    }
    if (normalized.data.limit !== ISSUES_PAGE_SIZE) {
      return null;
    }
    return { data: normalized.data, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

function writeCachedIssues(data: IssueListPage): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ISSUES_CACHE_KEY, JSON.stringify({
      data,
      updatedAt: Date.now(),
    }));
  } catch {
    // Best-effort cache only.
  }
}

function parseIssueListPageOrThrow(value: unknown): IssueListPage {
  const parsed = issueListPageSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid issue list response");
  }
  return parsed.data;
}

function parseIssueOrNull(value: unknown): Issue | null {
  const parsed = issueSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "n/a";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatBodyPreview(body: string | null | undefined): string {
  if (!body) return "No body provided.";
  const text = body.trim().replace(/\s+/g, " ");
  return text.length > 220 ? `${text.slice(0, 220)}...` : text;
}

function issueKey(issue: Issue): string {
  return issue.id;
}

function issueDetailUrl(issue: Issue): string {
  const [owner, repo] = issue.repo.split("/");
  return `/api/issues/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(repo ?? "")}/${issue.number}`;
}

function parseIssueTargetId(targetId: string): { repo: string; number: number } | null {
  const separator = targetId.lastIndexOf("#");
  if (separator === -1) {
    return null;
  }

  const repo = targetId.slice(0, separator);
  const number = Number(targetId.slice(separator + 1));
  if (!repo || !Number.isInteger(number) || number <= 0) {
    return null;
  }

  return { repo, number };
}

function scrollToDashboardErrors() {
  document.getElementById("dashboard-errors")?.scrollIntoView({ block: "start" });
}

function issueListUrl(limit: number, offset: number): string {
  return `/api/issues?limit=${limit}&offset=${offset}`;
}

function isActiveWorkStatus(status: Issue["workStatus"]): boolean {
  return status === "queued" || status === "in_progress";
}

function normalizeNumberSearch(value: string): string {
  return value.trim().replace(/^#/, "").trim();
}

function matchesNumberSearch(number: number, search: string): boolean {
  const normalized = normalizeNumberSearch(search);
  return normalized === "" || String(number).includes(normalized);
}

function getWorkPrReadiness(issue: Issue): { label: string; detail: string; tone: "success" | "warning" | "neutral" } {
  if (issue.workPrMergeable === true) {
    return {
      label: "Ready to merge",
      detail: `PR #${issue.workPrNumber} is mergeable on GitHub`,
      tone: "success",
    };
  }

  if (issue.workPrMergeable === false) {
    return {
      label: "PR needs attention",
      detail: `PR #${issue.workPrNumber} is not mergeable yet`,
      tone: "warning",
    };
  }

  return {
    label: "PR opened",
    detail: `PR #${issue.workPrNumber} on GitHub`,
    tone: "neutral",
  };
}

function hasExternalIssuePr(issue: Issue): boolean {
  return Boolean(issue.externalWorkPrUrl && issue.externalWorkPrNumber !== undefined && issue.externalWorkPrNumber !== null);
}

function canStartIssueWork(issue: Issue): boolean {
  return issue.workStatus === "idle"
    && !issue.workPrUrl
    && !hasExternalIssuePr(issue)
    && Boolean(issue.autoWorkEligible);
}

function formatIssueWorkStage(issue: Issue): string {
  const stage = issue.workStage ?? (
    issue.workStatus === "in_progress" ? "working" : issue.workStatus
  );

  return stage.replace("_", " ");
}

function formatIssueWorkAttempt(issue: Issue): string | null {
  if (!issue.workJobId) {
    return null;
  }

  return `attempt ${issue.workAttemptCount ?? 1}`;
}

function formatAutoWorkState(issue: Issue): string {
  if (issue.autoWorkEligible) {
    return "auto eligible";
  }

  return issue.autoWorkBlockedReason ?? "manual only";
}

function formatEvaluationState(issue: Issue): string {
  if (!issue.evaluationStatus) {
    return "not evaluated";
  }

  return issue.evaluationStatus.replace("_", " ");
}

function formatEvaluationConfidence(confidence: number): string {
  const grade = confidence >= 0.9
    ? "very high"
    : confidence >= 0.75
    ? "high"
    : confidence >= 0.5
    ? "medium"
    : "low";

  return `${grade} (${Math.round(confidence * 100)}%)`;
}

type IssueWorkFilter = "all" | "ready" | "worked" | "auto" | "needs_eval" | "review" | "failed" | "stale";
type IssueCoverageRow = {
  repo: string;
  syncedOpenCount: number;
  githubOpenCount: number | null;
  lastSyncedAt: string | null;
};

type GitHubRateLimitState = {
  limited: boolean;
  resetAt: string | null;
  recentlyLimited: boolean;
};

function isStaleIssue(issue: Issue): boolean {
  const updatedAt = Date.parse(issue.updatedAt);
  if (!Number.isFinite(updatedAt)) {
    return false;
  }

  return Date.now() - updatedAt > 7 * 24 * 60 * 60 * 1000;
}

function matchesIssueWorkFilter(issue: Issue, filter: IssueWorkFilter): boolean {
  if (filter === "ready") return issue.workPrMergeable === true;
  if (filter === "worked") return Boolean(issue.isWorked);
  if (filter === "auto") return canStartIssueWork(issue);
  if (filter === "needs_eval") return !issue.evaluationStatus;
  if (filter === "review") return issue.evaluationStatus === "blocked" || issue.evaluationStatus === "needs_review";
  if (filter === "failed") return issue.workStatus === "failed";
  if (filter === "stale") return isStaleIssue(issue);
  return true;
}

function issueLifecycleLabel(issue: Issue): string | null {
  if (!issue.isWorked) {
    return null;
  }

  if (issue.workPrUrl && issue.workPrMergeable === false) {
    return "re-opened after divergence";
  }

  if (issue.workPrUrl) {
    return "worked, awaiting merge";
  }

  return "worked";
}

function shouldShowIssueAutomationState(issue: Issue): boolean {
  return !issue.isWorked && !issue.workPrUrl;
}

function visibleIssueListLabels(issue: Issue): string[] {
  if (!issue.isWorked) {
    return issue.labels;
  }

  return issue.labels.filter((label) => !AUTOMATION_LABELS.has(label.trim().toLowerCase()));
}

const LOG_METADATA_ORDER = ["repo", "issueNumber", "prNumber", "prUrl", "jobId", "stage", "status", "safetyFlags"] as const;

function formatLogMetadataValue(key: string, value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    if (key === "prUrl") {
      return "open PR";
    }
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getLogMetadataEntries(metadata: LogEntry["metadata"]): Array<{ key: string; label: string; value: string; href?: string }> {
  if (!metadata || Object.keys(metadata).length === 0) {
    return [];
  }

  const entries = new Map<string, unknown>(Object.entries(metadata));
  const orderedKeys = [
    ...LOG_METADATA_ORDER.filter((key) => entries.has(key)),
    ...Array.from(entries.keys()).filter((key) => !LOG_METADATA_ORDER.includes(key as (typeof LOG_METADATA_ORDER)[number])),
  ];

  return orderedKeys.flatMap((key) => {
    const value = entries.get(key);
    if (value === null || value === undefined) {
      return [];
    }

    return [{
      key,
      label: key === "issueNumber" ? "issue" : key === "prNumber" ? "pr" : key === "prUrl" ? "PR link" : key,
      value: formatLogMetadataValue(key, value),
      href: key === "prUrl" && typeof value === "string" ? value : undefined,
    }];
  });
}

function IssueStatusBadge({ issue }: { issue: Issue }) {
  return (
    <StatusChip
      tone={issueWorkStatusTone(issue.workStatus)}
      pulsing={issue.workStatus === "in_progress"}
      label={issue.workStatus.replace("_", " ")}
    />
  );
}

function IssueRow({
  issue,
  selected,
  onSelect,
  queueStatus,
  verifyState,
}: {
  issue: Issue;
  selected: boolean;
  onSelect: (issueId: string) => void;
  queueStatus: QueueStatusView | null;
  verifyState: VerifyState | null;
}) {
  const showInlineStatusBadge = issue.workStatus !== "queued" && issue.workStatus !== "in_progress";
  const lifecycle = issueLifecycleLabel(issue);
  const showAutomationState = shouldShowIssueAutomationState(issue);
  const visibleLabels = visibleIssueListLabels(issue);
  const rowAction =
    issue.workPrUrl && issue.workPrNumber !== undefined && issue.workPrNumber !== null
      ? (
        (() => {
          const readiness = getWorkPrReadiness(issue);
          const toneClass = readiness.tone === "success"
            ? "border-success-border text-success-foreground"
            : readiness.tone === "warning"
              ? "border-warning-border text-warning-foreground"
              : "border-border text-muted-foreground";
          return (
        <a
          href={issue.workPrUrl}
          target="_blank"
          rel="noreferrer noopener"
          data-testid="issue-ready-to-merge-list"
          className={`mt-2 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors hover:border-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${toneClass}`}
        >
          <ExternalLink className="h-3 w-3" />
          PR <span className="font-mono">#{issue.workPrNumber}</span>
          <span className={readiness.tone === "success" ? "text-success-foreground/70" : readiness.tone === "warning" ? "text-warning-foreground/70" : "text-muted-foreground/70"}>
            {readiness.label.toLowerCase()}
          </span>
        </a>
          );
        })()
      )
      : hasExternalIssuePr(issue)
        ? (
          <a
            href={issue.externalWorkPrUrl ?? "#"}
            target="_blank"
            rel="noreferrer noopener"
            data-testid="issue-external-pr-list"
            className="mt-2 inline-flex items-center gap-1 rounded-md border border-warning-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-warning-foreground transition-colors hover:border-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            <ExternalLink className="h-3 w-3" />
            PR <span className="font-mono">#{issue.externalWorkPrNumber}</span>
            <span className="text-warning-foreground/70">external linked</span>
          </a>
        )
      : issue.workStatus === "queued" || issue.workStatus === "in_progress"
        ? (
          <div
            data-testid="issue-work-in-progress-list"
            className="mt-2 inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
          >
            {issue.workStatus === "in_progress" ? <Loader2 className="h-3 w-3 animate-spin" /> : <span className="h-3 w-3" />}
            {formatIssueWorkStage(issue)}
            {formatIssueWorkAttempt(issue) && (
              <span className="text-muted-foreground/70">{formatIssueWorkAttempt(issue)}</span>
            )}
          </div>
        )
        : null;

  return (
    <div className={`cursor-pointer border-b border-border px-4 py-3 transition-colors ${
      selected
        ? "border-l-[3px] border-l-primary bg-muted"
        : `border-l-2 ${toneRailClass(issueRowTone(issue))} hover:bg-muted/30`
    }`}>
      <button
        type="button"
        onClick={() => onSelect(issue.id)}
        className="flex w-full items-start justify-between gap-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{issue.title}</span>
            {showInlineStatusBadge && <IssueStatusBadge issue={issue} />}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {issue.repo} <span className="font-mono text-foreground/70">#{issue.number}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            by {issue.author || "unknown"}
          </div>
          <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-muted-foreground">
            {formatBodyPreview(issue.body)}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {showAutomationState && (
              <StatusChip
                tone={issueEvaluationTone(issue.evaluationStatus)}
                label={formatEvaluationState(issue)}
                title={issue.evaluationSummary ?? undefined}
                testId="issue-evaluation-state-list"
              />
            )}
            <QueueStatusBadge status={queueStatus} />
            {verifyState && <VerifyStateBadge state={verifyState} />}
            {lifecycle && (
              <StatusChip
                tone={lifecycle === "re-opened after divergence" ? "warning" : "success"}
                label={lifecycle}
                testId="issue-lifecycle-badge"
              />
            )}
            {issue.subtasks && issue.subtasks.length >= 2 && (
              <StatusChip
                tone="primary"
                label={`${issue.subtasks.length} bugs`}
                title={issue.subtasks.map((task) => `• ${task.title}`).join("\n")}
                testId="issue-multi-bug-badge"
              />
            )}
            {visibleLabels.slice(0, 3).map((label) => (
              <span key={label} className="border border-border px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                {label}
              </span>
            ))}
            {visibleLabels.length > 3 && (
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                +{visibleLabels.length - 3}
              </span>
            )}
          </div>
        </div>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {formatDateTime(issue.updatedAt)}
        </span>
      </button>
      {rowAction}
    </div>
  );
}

type VerifyState = "verifying" | "verified";

function VerifyStateBadge({ state }: { state: VerifyState }) {
  const isPending = state === "verifying";
  return (
    <span
      data-testid="issue-verify-state-badge"
      data-verify-state={state}
      className={`inline-flex items-center gap-1 border px-1.5 py-0 text-[10px] uppercase tracking-wider ${
        isPending
          ? "border-primary/60 bg-primary/10 text-primary animate-pulse"
          : "border-success-border bg-success-muted text-success-foreground"
      }`}
    >
      {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
      {isPending ? "re-verifying" : "re-verified"}
    </span>
  );
}

function IssueRowSkeleton() {
  return (
    <div className="border-b border-l-2 border-l-transparent border-border px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
          <div className="flex gap-1.5 pt-1">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 w-10" />
          </div>
        </div>
        <Skeleton className="h-3 w-20 shrink-0" />
      </div>
    </div>
  );
}

function SubtaskStatusIcon({ status }: { status: IssueSubtask["status"] }) {
  if (status === "done") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-success-foreground" aria-label="done" />;
  }
  if (status === "deferred" || status === "skipped") {
    return <CircleSlash className="h-3.5 w-3.5 text-muted-foreground" aria-label={status} />;
  }
  return <CircleDashed className="h-3.5 w-3.5 text-warning-foreground" aria-label="pending" />;
}

function SubtaskListPanel({ subtasks }: { subtasks: IssueSubtask[] }) {
  const doneCount = subtasks.reduce((sum, task) => sum + (task.status === "done" ? 1 : 0), 0);

  return (
    <DetailPanel
      title="Subtasks"
      testId="issue-subtasks"
      chip={(
        <span className="font-mono text-[10px] text-muted-foreground">
          {doneCount} / {subtasks.length} done
        </span>
      )}
    >
      <ul className="divide-y divide-border/60">
        {subtasks.map((task) => (
          <li
            key={task.id}
            data-testid="issue-subtask-row"
            data-subtask-status={task.status}
            className="flex items-start gap-2 px-3 py-2"
          >
            <span className="mt-0.5 shrink-0">
              <SubtaskStatusIcon status={task.status} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-[12px] font-medium text-foreground">{task.title}</span>
                <span className="border border-border/60 px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {task.status}
                </span>
              </div>
              {task.summary && (
                <div className="mt-0.5 text-[11px] leading-5 text-muted-foreground">
                  {task.summary}
                </div>
              )}
              {task.statusReason && (
                <div className="mt-1 text-[11px] italic leading-5 text-foreground/70">
                  {task.statusReason}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </DetailPanel>
  );
}

function IssueLogRow({ entry }: { entry: LogEntry }) {
  const metadataEntries = getLogMetadataEntries(entry.metadata);

  return (
    <div className="border-b border-border/60 px-3 py-2 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] text-foreground">{entry.message}</div>
          {entry.phase && <div className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">{entry.phase}</div>}
        </div>
        <span className="shrink-0 text-[10px] text-muted-foreground">{formatDateTime(entry.timestamp)}</span>
      </div>
      {metadataEntries.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {metadataEntries.map((field) => {
            const content = (
              <span className="inline-flex max-w-full items-center gap-1 border border-border/60 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                <span className="shrink-0 text-foreground/70">{field.label}:</span>
                <span className="min-w-0 truncate normal-case tracking-normal text-foreground/85">{field.value}</span>
                {field.href && <ExternalLink className="h-3 w-3 shrink-0" />}
              </span>
            );

            if (field.href) {
              return (
                <a
                  key={field.key}
                  href={field.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                >
                  {content}
                </a>
              );
            }

            return <div key={field.key}>{content}</div>;
          })}
        </div>
      )}
    </div>
  );
}

function IssueLogPanel({ logs, selected }: { logs: LogEntry[]; selected: boolean }) {
  return (
    <div className="flex min-h-[24rem] w-full shrink-0 flex-col border-t border-border lg:min-h-0 lg:w-80 lg:border-l lg:border-t-0">
      <div className="flex shrink-0 border-b border-border">
        <div
          className="flex-1 bg-muted px-3 py-2 text-[11px] uppercase tracking-wider text-foreground shadow-[inset_0_-2px_0_0_hsl(var(--primary))]"
          data-testid="tab-issue-activity"
        >
          Activity
        </div>
      </div>
      <div className="flex-1 overflow-y-auto" data-testid="issue-detail-logs">
        {!selected ? (
          <div className="p-4 text-[12px] text-muted-foreground">
            Select an issue to see logs.
          </div>
        ) : logs.length === 0 ? (
          <div className="p-4 text-[12px] text-muted-foreground">
            No workflow logs yet.
          </div>
        ) : (
          logs.map((entry) => <IssueLogRow key={entry.id} entry={entry} />)
        )}
      </div>
    </div>
  );
}

type IssuesErrorBoundaryState = {
  hasError: boolean;
  message: string;
};

class IssuesErrorBoundary extends Component<{ children: ReactNode }, IssuesErrorBoundaryState> {
  state: IssuesErrorBoundaryState = {
    hasError: false,
    message: "",
  };

  static getDerivedStateFromError(error: unknown): IssuesErrorBoundaryState {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-background p-6">
          <div className="max-w-2xl border border-destructive/40 bg-destructive/10 p-4 text-[12px] text-destructive">
            <div className="text-[11px] uppercase tracking-wider text-destructive/80">Issues UI runtime error</div>
            <pre className="mt-2 whitespace-pre-wrap break-words">{this.state.message || "Unknown render error"}</pre>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function IssuesPage() {
  const { data: runtime } = useQuery<RuntimeState>({
    queryKey: ["/api/runtime"],
    refetchInterval: LIVE_POLL_INTERVAL_MS,
  });
  const globalDrainMode = runtime?.drainMode === true;
  const { data: activities = EMPTY_ACTIVITY_SNAPSHOT } = useQuery<ActivitySnapshot>({
    queryKey: ["/api/activities"],
    refetchInterval: LIVE_POLL_INTERVAL_MS,
  });
  const { data: config } = useQuery<Config>({ queryKey: ["/api/config"] });
  const uiPollIntervalMs = getUiPollIntervalMs(config);
  const { data: githubRateLimit } = useQuery<GitHubRateLimitState>({
    queryKey: ["/api/github-rate-limit"],
    refetchInterval: uiPollIntervalMs,
  });
  const isGitHubThrottled = githubRateLimit?.limited === true;
  const { data: issueCoverage = [] } = useQuery<IssueCoverageRow[]>({
    queryKey: ["/api/issues/coverage"],
    enabled: config !== undefined && !globalDrainMode && !isGitHubThrottled,
    refetchInterval: uiPollIntervalMs,
  });
  const queueStatusById = useMemo(() => buildQueueStatusIndex(activities), [activities]);
  const throttledTitle = githubRateLimit?.resetAt
    ? `GitHub rate limited until ${formatDateTime(githubRateLimit.resetAt)}`
    : "GitHub rate limited";
  const cachedIssues = useMemo(() => readCachedIssues(), []);

  const clearFailedActivitiesMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/activities/failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
    },
    onError: (error) => {
      toast({
        title: "Could not clear failed activities",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    },
  });

  const [extraPages, setExtraPages] = useState<IssueListPage[]>([]);
  const issuesQuery = useQuery<IssueListPage>({
    queryKey: ["/api/issues", ISSUES_PAGE_SIZE, 0],
    queryFn: async () => parseIssueListPageOrThrow(await fetchJson<unknown>(issueListUrl(ISSUES_PAGE_SIZE, 0))),
    enabled: runtime !== undefined && !globalDrainMode,
    initialData: cachedIssues?.data,
    initialDataUpdatedAt: cachedIssues?.updatedAt,
    staleTime: ISSUES_CACHE_MAX_AGE_MS,
    refetchOnMount: cachedIssues ? false : true,
    refetchInterval: (query) => {
      if (globalDrainMode) {
        return false;
      }
      const loaded = [
        ...(query.state.data?.items ?? []),
        ...extraPages.flatMap((page) => page.items),
      ];
      return loaded.some((issue) => isActiveWorkStatus(issue.workStatus))
        ? LIVE_POLL_INTERVAL_MS
        : false;
    },
  });
  const { data: issuesPage, isLoading, isFetching } = issuesQuery;
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isSyncingRepos, setIsSyncingRepos] = useState(false);
  useEffect(() => {
    if (issuesQuery.status === "success") {
      writeCachedIssues(issuesQuery.data);
    }
  }, [issuesQuery.status, issuesQuery.data]);
  useEffect(() => {
    setExtraPages([]);
  }, [issuesPage?.fetchedAt]);

  const issues = useMemo(() => {
    const all = [issuesPage, ...extraPages].flatMap((page) => page?.items ?? []);
    const deduped = new Map<string, Issue>();
    for (const issue of all) deduped.set(issue.id, issue);
    return Array.from(deduped.values()).sort((a, b) => b.number - a.number);
  }, [issuesPage, extraPages]);
  const latestPage = extraPages[extraPages.length - 1] ?? issuesPage ?? null;
  const canLoadMore = Boolean(latestPage?.hasMore);
  const nextOffset = latestPage?.nextOffset ?? null;
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const issueListScrollRef = useRef<HTMLDivElement | null>(null);

  const loadMoreIssues = async (): Promise<void> => {
    if (!canLoadMore || nextOffset === null || globalDrainMode || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const nextPage = parseIssueListPageOrThrow(await fetchJson<unknown>(issueListUrl(ISSUES_PAGE_SIZE, nextOffset)));
      setExtraPages((current) => [...current, nextPage]);
    } catch (error) {
      toast({
        variant: "destructive",
        description: `Could not load more issues: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setIsLoadingMore(false);
    }
  };

  const handleSyncIssues = async (fullSweep = false): Promise<void> => {
    setIsSyncingRepos(true);
    try {
      if (fullSweep) {
        const rateLimit = await fetchJson<GitHubRateLimitState>("/api/github-rate-limit");
        if (rateLimit.limited) {
          const resetLabel = rateLimit.resetAt ? formatDateTime(rateLimit.resetAt) : "later";
          toast({
            title: "Full sweep blocked",
            variant: "destructive",
            description: `GitHub is rate-limited. Full sweep paused until ${resetLabel}.`,
          });
          return;
        }
        toast({ description: "Full sweep started." });
      }
      await apiRequest("POST", fullSweep ? "/api/repos/sync?fullSweep=1" : "/api/repos/sync");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/issues"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/issues/coverage"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/issues/detail"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/activities"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/runtime"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] }),
      ]);
      setExtraPages([]);
      toast({ description: fullSweep ? "Full sweep completed." : "Issue sync completed." });
    } catch (error) {
      toast({
        variant: "destructive",
        description: `${fullSweep ? "Could not run full sweep" : "Could not sync repositories"}: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setIsSyncingRepos(false);
    }
  };

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    const scrollRoot = issueListScrollRef.current;
    if (!sentinel || !scrollRoot || !canLoadMore || globalDrainMode) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void loadMoreIssues();
      }
    }, { root: scrollRoot, rootMargin: "200px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canLoadMore, globalDrainMode, isLoadingMore, nextOffset]);

  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<string>("all");
  const [selectedWorkFilter, setSelectedWorkFilter] = useState<IssueWorkFilter>("all");
  const [issueNumberSearch, setIssueNumberSearch] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [areErrorsRolledUp, setAreErrorsRolledUp] = useState(false);
  const normalizedIssueNumberSearch = normalizeNumberSearch(issueNumberSearch);
  const filteredIssues = useMemo(
    () => issues
      .filter((issue) => selectedRepo === "all" || issue.repo === selectedRepo)
      .filter((issue) => matchesIssueWorkFilter(issue, selectedWorkFilter))
      .filter((issue) => matchesNumberSearch(issue.number, issueNumberSearch)),
    [issues, selectedRepo, selectedWorkFilter, issueNumberSearch],
  );
  const startableVisibleIssues = useMemo(
    () => filteredIssues.filter(canStartIssueWork),
    [filteredIssues],
  );

  useEffect(() => {
    const nextIssue = filteredIssues[0];

    if (!nextIssue) {
      if (selectedIssueId !== null) {
        setSelectedIssueId(null);
      }
      return;
    }

    if (!selectedIssueId) {
      setSelectedIssueId(nextIssue.id);
      return;
    }

    const selected = filteredIssues.find((issue) => issue.id === selectedIssueId);
    if (!selected) {
      setSelectedIssueId(nextIssue.id);
    }
  }, [filteredIssues, selectedIssueId]);

  const selectedIssueFromList = useMemo(
    () => {
      const baseIssue = issues.find((issue) => issue.id === selectedIssueId) ?? null;
      if (
        baseIssue
        && (selectedRepo === "all" || baseIssue.repo === selectedRepo)
        && matchesIssueWorkFilter(baseIssue, selectedWorkFilter)
        && matchesNumberSearch(baseIssue.number, issueNumberSearch)
      ) {
        return baseIssue;
      }
      return filteredIssues[0] ?? null;
    },
    [filteredIssues, issueNumberSearch, issues, selectedIssueId, selectedRepo, selectedWorkFilter],
  );
  const { data: selectedIssueDetail } = useQuery<Issue>({
    queryKey: ["/api/issues/detail", selectedIssueFromList?.repo ?? "", selectedIssueFromList?.number ?? 0],
    queryFn: async () => {
      if (!selectedIssueFromList) {
        throw new Error("No issue selected");
      }

      const parsed = parseIssueOrNull(await fetchJson<unknown>(issueDetailUrl(selectedIssueFromList)));
      if (!parsed) {
        throw new Error("Invalid issue detail response");
      }
      return parsed;
    },
    enabled: Boolean(selectedIssueFromList) && !globalDrainMode,
    refetchInterval: selectedIssueFromList && isActiveWorkStatus(selectedIssueFromList.workStatus) && !globalDrainMode ? uiPollIntervalMs : false,
  });
  const selectedIssue = selectedIssueDetail ?? selectedIssueFromList;
  const selectedIssueKey = selectedIssue ? issueKey(selectedIssue) : null;
  const selectedIssueQueueStatus = selectedIssue ? queueStatusById.get(selectedIssue.id) ?? null : null;
  const selectedIssueHasExternalPr = selectedIssue ? hasExternalIssuePr(selectedIssue) : false;
  const repoGroups = useMemo(() => {
    const counts = new Map<string, Issue[]>();
    for (const issue of filteredIssues) {
      const current = counts.get(issue.repo) ?? [];
      current.push(issue);
      counts.set(issue.repo, current);
    }
    return Array.from(counts.entries()).map(([repo, repoIssues]) => ({
      repo,
      issues: repoIssues,
    }));
  }, [filteredIssues]);
  const repoCounts = useMemo(
    () => Object.entries(issuesPage?.repoTotals ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    [issuesPage?.repoTotals],
  );
  const totalIssueCount = issuesPage?.totalCount ?? issues.length;
  const repoTotals = issuesPage?.repoTotals ?? {};
  const coverageByRepo = useMemo(
    () => new Map(issueCoverage.map((entry) => [entry.repo, entry])),
    [issueCoverage],
  );
  const selectedCoverage = selectedRepo === "all" ? null : coverageByRepo.get(selectedRepo) ?? null;
  const aggregateCoverage = useMemo(() => {
    let synced = 0;
    let github = 0;
    let unknown = false;
    for (const row of issueCoverage) {
      synced += row.syncedOpenCount;
      if (row.githubOpenCount === null) unknown = true;
      else github += row.githubOpenCount;
    }
    return { synced, github: unknown ? null : github };
  }, [issueCoverage]);
  const selectedSyncedFallback = selectedRepo === "all" ? null : (repoTotals[selectedRepo] ?? 0);
  const aggregateSyncedFallback = totalIssueCount;

  const { data: issueLogs = [] } = useQuery<LogEntry[]>({
    queryKey: ["/api/logs", selectedIssueKey ?? "issue"],
    queryFn: async () => {
      if (!selectedIssueKey) {
        return [];
      }

      return fetchJson<LogEntry[]>(`/api/logs?prId=${encodeURIComponent(selectedIssueKey)}`);
    },
    enabled: Boolean(selectedIssueKey),
  });

  const workMutation = useMutation({
    mutationFn: async (issue: Issue) => {
      const res = await apiRequest("POST", "/api/issues/work", {
        repo: issue.repo,
        number: issue.number,
      });
      return res.json() as Promise<{ repo: string; number: number; id: string }>;
    },
    onSuccess: async (issue) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/issues"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/issues/detail", issue.repo, issue.number] }),
        queryClient.invalidateQueries({ queryKey: ["/api/activities"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/logs", issue.id] }),
      ]);
      toast({ description: `Queued work for #${issue.number}.` });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `Could not queue issue work: ${error.message}` });
    },
  });

  const startVisibleWorkMutation = useMutation({
    mutationFn: async (issuesToStart: Issue[]) => {
      const queued: Array<{ repo: string; number: number; id: string }> = [];
      const failed: Array<{ issue: Issue; message: string }> = [];

      for (const issue of issuesToStart) {
        try {
          const res = await apiRequest("POST", "/api/issues/work", {
            repo: issue.repo,
            number: issue.number,
          });
          queued.push(await res.json() as { repo: string; number: number; id: string });
        } catch (error) {
          failed.push({
            issue,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return { queued, failed };
    },
    onSuccess: async ({ queued, failed }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/issues"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/issues/detail"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/activities"] }),
      ]);

      if (failed.length > 0) {
        toast({
          variant: "destructive",
          description: `Queued ${queued.length} issue${queued.length === 1 ? "" : "s"}; ${failed.length} failed to queue.`,
        });
        return;
      }

      toast({ description: `Queued work for ${queued.length} issue${queued.length === 1 ? "" : "s"}.` });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `Could not start issue work: ${error.message}` });
    },
  });

  const clearFailuresMutation = useMutation({
    mutationFn: async (issue: Issue) => {
      const res = await apiRequest("DELETE", "/api/issues/work/failures", {
        repo: issue.repo,
        number: issue.number,
      });
      return res.json() as Promise<Issue>;
    },
    onSuccess: async (issue) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/issues"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/issues/detail", issue.repo, issue.number] }),
        queryClient.invalidateQueries({ queryKey: ["/api/activities"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/logs", issue.id] }),
      ]);
      toast({ description: `Cleared failed work attempts for #${issue.number}.` });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `Could not clear issue failures: ${error.message}` });
    },
  });

  const clearIssueFailureFromActivityMutation = useMutation({
    mutationFn: async (activity: ActivityItem) => {
      const issueTarget = parseIssueTargetId(activity.targetId);
      if (!issueTarget) {
        throw new Error(`Invalid issue activity target: ${activity.targetId}`);
      }

      const res = await apiRequest("DELETE", "/api/issues/work/failures", issueTarget);
      return res.json() as Promise<Issue>;
    },
    onSuccess: async (issue) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/issues"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/issues/detail", issue.repo, issue.number] }),
        queryClient.invalidateQueries({ queryKey: ["/api/activities"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/logs", issue.id] }),
      ]);
      toast({ description: `Cleared failed work attempts for #${issue.number}.` });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `Could not clear issue failures: ${error.message}` });
    },
  });

  const evaluateMutation = useMutation({
    mutationFn: async (issue: Issue) => {
      const res = await apiRequest("POST", "/api/issues/evaluate", {
        repo: issue.repo,
        number: issue.number,
      });
      return res.json() as Promise<Issue>;
    },
    onSuccess: async (issue) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/issues"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/issues/detail", issue.repo, issue.number] }),
        queryClient.invalidateQueries({ queryKey: ["/api/activities"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/logs", issue.id] }),
      ]);
      toast({ description: `Queued evaluation for #${issue.number}.` });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `Could not queue issue evaluation: ${error.message}` });
    },
  });
  const verifyingIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const activity of activities.queued) {
      if (activity.kind === "verify_issue") ids.add(activity.targetId);
    }
    for (const activity of activities.inProgress) {
      if (activity.kind === "verify_issue") ids.add(activity.targetId);
    }
    return ids;
  }, [activities.queued, activities.inProgress]);

  const previousVerifyingRef = useRef<Set<string>>(new Set());
  const [recentlyVerifiedIds, setRecentlyVerifiedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const prior = previousVerifyingRef.current;
    const justFinished: string[] = [];
    prior.forEach((id) => {
      if (!verifyingIssueIds.has(id)) justFinished.push(id);
    });
    previousVerifyingRef.current = verifyingIssueIds;

    if (justFinished.length === 0) return;

    setRecentlyVerifiedIds((prev) => {
      const next = new Set(prev);
      justFinished.forEach((id) => next.add(id));
      return next;
    });
    const timers = justFinished.map((id) =>
      window.setTimeout(() => {
        setRecentlyVerifiedIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 8000),
    );
    return () => { timers.forEach((t) => window.clearTimeout(t)); };
  }, [verifyingIssueIds]);

  const verifyMutation = useMutation({
    mutationFn: async (issue: Issue) => {
      const res = await apiRequest("POST", "/api/issues/verify", {
        repo: issue.repo,
        number: issue.number,
      });
      return res.json() as Promise<Issue>;
    },
    onSuccess: async (issue) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/issues"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/issues/detail", issue.repo, issue.number] }),
        queryClient.invalidateQueries({ queryKey: ["/api/activities"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/logs", issue.id] }),
      ]);
      toast({ description: `Queued verification for #${issue.number}.` });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `Could not queue verification: ${error.message}` });
    },
  });

  const syncIssueMutation = useMutation({
    mutationFn: async (issue: Issue) => {
      const res = await apiRequest("POST", "/api/issues/sync", {
        repo: issue.repo,
        number: issue.number,
      });
      return res.json() as Promise<Issue>;
    },
    onSuccess: async (issue) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/issues"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/issues/detail", issue.repo, issue.number] }),
        queryClient.invalidateQueries({ queryKey: ["/api/logs", issue.id] }),
      ]);
      toast({ description: `Synced issue #${issue.number}.` });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `Could not sync issue: ${error.message}` });
    },
  });

  const labelMutation = useMutation({
    mutationFn: async ({ issue, add, remove }: { issue: Issue; add?: string[]; remove?: string[] }) => {
      const res = await apiRequest("PATCH", "/api/issues/labels", {
        repo: issue.repo,
        number: issue.number,
        add,
        remove,
      });
      return res.json() as Promise<Issue>;
    },
    onSuccess: async (issue) => {
      setLabelInput("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/issues"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/issues/detail", issue.repo, issue.number] }),
        queryClient.invalidateQueries({ queryKey: ["/api/logs", issue.id] }),
      ]);
      toast({ description: `Updated labels for #${issue.number}.` });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `Could not update issue labels: ${error.message}` });
    },
  });

  const activeIssueCount = issues.filter((issue) => isActiveWorkStatus(issue.workStatus)).length;
  const activeErrorCount = activities.failed.length + activities.warnings.length;
  const visibleIssues = filteredIssues;
  const readyIssueCount = issues.filter((issue) =>
    (selectedRepo === "all" || issue.repo === selectedRepo) && issue.workPrMergeable === true
  ).length;
  const workedIssueCount = issues.filter((issue) =>
    (selectedRepo === "all" || issue.repo === selectedRepo) && Boolean(issue.isWorked)
  ).length;
  const autoEligibleIssueCount = issues.filter((issue) =>
    (selectedRepo === "all" || issue.repo === selectedRepo) && canStartIssueWork(issue)
  ).length;
  const needsEvaluationIssueCount = issues.filter((issue) =>
    (selectedRepo === "all" || issue.repo === selectedRepo) && !issue.evaluationStatus
  ).length;
  const reviewIssueCount = issues.filter((issue) =>
    (selectedRepo === "all" || issue.repo === selectedRepo)
    && (issue.evaluationStatus === "blocked" || issue.evaluationStatus === "needs_review")
  ).length;
  const failedIssueCount = issues.filter((issue) =>
    (selectedRepo === "all" || issue.repo === selectedRepo) && issue.workStatus === "failed"
  ).length;
  const staleIssueCount = issues.filter((issue) =>
    (selectedRepo === "all" || issue.repo === selectedRepo) && isStaleIssue(issue)
  ).length;

  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:overflow-hidden">
      <UpdateBanner />
      <AppHeader
        active="issues"
        status={(
          <>
            <span><span className="font-mono text-foreground">{issues.length}</span> open</span>
            <span><span className="font-mono text-foreground">{activeIssueCount}</span> active</span>
            {runtime?.drainMode && (
              <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                paused
              </span>
            )}
          </>
        )}
        actions={(
          <>
            {activeErrorCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  setAreErrorsRolledUp(false);
                  scrollToDashboardErrors();
                }}
                className="inline-flex items-center gap-1 rounded-md border border-destructive/50 px-2 py-0.5 text-[11px] uppercase tracking-wider text-destructive transition-colors hover:bg-destructive hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                data-testid="issues-error-pill"
              >
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                Errors
                <span className="font-mono">{activeErrorCount}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => { void handleSyncIssues(false); }}
              disabled={isSyncingRepos || globalDrainMode || isGitHubThrottled}
              title={isGitHubThrottled ? throttledTitle : undefined}
              data-testid="button-sync-issues"
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
            >
              {globalDrainMode ? <span className="h-3.5 w-3.5" /> : (isSyncingRepos || isFetching) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {globalDrainMode ? "paused" : "sync"}
            </button>
            <ActivityMenu
              activities={activities}
              onClearFailed={() => clearFailedActivitiesMutation.mutate()}
              isClearingFailed={clearFailedActivitiesMutation.isPending}
              globalDrainMode={Boolean(runtime?.drainMode)}
              queueStatusById={queueStatusById}
              pollIntervalMs={config?.pollIntervalMs}
            />
          </>
        )}
      />

      <DashboardErrorsPanel
        activities={activities}
        onClearFailed={() => clearFailedActivitiesMutation.mutate()}
        isClearingFailed={clearFailedActivitiesMutation.isPending}
        onClearIssueFailure={(activity) => clearIssueFailureFromActivityMutation.mutate(activity)}
        isClearingIssueFailure={clearIssueFailureFromActivityMutation.isPending}
        rolledUp={areErrorsRolledUp}
        onToggleRolledUp={() => setAreErrorsRolledUp((current) => !current)}
      />

      <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
        <div className="flex max-h-[42vh] w-full shrink-0 flex-col overflow-hidden border-b border-border lg:max-h-none lg:w-[42rem] lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            <div>
              Watched issues
              <span className="ml-2 normal-case tracking-normal text-muted-foreground/80">
                {selectedCoverage
                  ? `synced ${selectedCoverage.syncedOpenCount}${selectedCoverage.githubOpenCount !== null ? ` / GitHub ${selectedCoverage.githubOpenCount}` : ""}`
                  : selectedRepo !== "all"
                    ? `synced ${selectedSyncedFallback}${aggregateCoverage.github !== null ? ` / GitHub ${aggregateCoverage.github}` : " / GitHub ?"}`
                    : `synced ${aggregateSyncedFallback}${aggregateCoverage.github !== null ? ` / GitHub ${aggregateCoverage.github}` : " / GitHub ?"}`}
              </span>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => startVisibleWorkMutation.mutate(startableVisibleIssues)}
                disabled={
                  startVisibleWorkMutation.isPending
                  || startableVisibleIssues.length === 0
                  || globalDrainMode
                  || isGitHubThrottled
                }
                title={
                  globalDrainMode
                    ? "Issue work is paused by drain mode"
                    : isGitHubThrottled
                      ? throttledTitle
                      : startableVisibleIssues.length === 0
                        ? "No visible auto-eligible idle issues to start"
                        : `Start work for ${startableVisibleIssues.length} visible issue${startableVisibleIssues.length === 1 ? "" : "s"}`
                }
                data-testid="button-start-visible-issue-work"
                className="inline-flex items-center gap-1 rounded-md border border-primary bg-primary px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
              >
                {startVisibleWorkMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
                {startVisibleWorkMutation.isPending ? "starting" : `start work (${startableVisibleIssues.length})`}
              </button>
              <button
                type="button"
                onClick={() => { void handleSyncIssues(true); }}
                disabled={isSyncingRepos || globalDrainMode || isGitHubThrottled}
                title={isGitHubThrottled ? throttledTitle : undefined}
                data-testid="button-full-sweep-issues"
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
              >
                {globalDrainMode ? "paused" : "full sweep"}
              </button>
            </div>
          </div>
          <div data-testid="repo-filter-bar" className="flex flex-col gap-2 border-b border-border px-4 py-2.5">
            <div className="flex flex-wrap items-start gap-2">
              <span className="mt-1 w-14 shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Search
              </span>
              <label htmlFor="issue-number-search" className="sr-only">Search issue number</label>
              <input
                id="issue-number-search"
                value={issueNumberSearch}
                onChange={(event) => setIssueNumberSearch(event.target.value)}
                placeholder="Search #"
                data-testid="issue-number-search"
                className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-[12px] text-foreground placeholder:font-sans placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div className="flex flex-wrap items-start gap-2">
              <span className="mt-1 w-14 shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Repo
              </span>
              <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() => setSelectedRepo("all")}
                  className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
                    selectedRepo === "all"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary"
                  }`}
                >
                  all ({totalIssueCount})
                </button>
                {repoCounts.map(([repo, count]) => (
                  <button
                    key={repo}
                    type="button"
                    onClick={() => setSelectedRepo(repo)}
                    className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
                      selectedRepo === repo
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary"
                    }`}
                  >
                    {repo} ({count})
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-start gap-2">
              <span className="mt-1 w-14 shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Status
              </span>
              <div className="flex min-w-0 flex-1 flex-wrap gap-1">
            <button
              type="button"
              onClick={() => setSelectedWorkFilter("ready")}
              className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
                selectedWorkFilter === "ready"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary"
              }`}
            >
              ready to merge ({readyIssueCount})
            </button>
            <button
              type="button"
              onClick={() => setSelectedWorkFilter("worked")}
              data-testid="issue-worked-filter"
              className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
                selectedWorkFilter === "worked"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary"
              }`}
            >
              worked ({workedIssueCount})
            </button>
            <button
              type="button"
              onClick={() => setSelectedWorkFilter("auto")}
              data-testid="issue-auto-eligible-filter"
              className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
                selectedWorkFilter === "auto"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary"
              }`}
            >
              ready to work ({autoEligibleIssueCount})
            </button>
            <button
              type="button"
              onClick={() => setSelectedWorkFilter("needs_eval")}
              data-testid="issue-needs-evaluation-filter"
              className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
                selectedWorkFilter === "needs_eval"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary"
              }`}
            >
              needs eval ({needsEvaluationIssueCount})
            </button>
            <button
              type="button"
              onClick={() => setSelectedWorkFilter("review")}
              data-testid="issue-review-filter"
              className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
                selectedWorkFilter === "review"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary"
              }`}
            >
              review ({reviewIssueCount})
            </button>
            <button
              type="button"
              onClick={() => setSelectedWorkFilter("failed")}
              data-testid="issue-failed-filter"
              className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
                selectedWorkFilter === "failed"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary"
              }`}
            >
              failed ({failedIssueCount})
            </button>
            <button
              type="button"
              onClick={() => setSelectedWorkFilter("stale")}
              data-testid="issue-stale-filter"
              className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
                selectedWorkFilter === "stale"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary"
              }`}
            >
              stale ({staleIssueCount})
            </button>
            <button
              type="button"
              onClick={() => setSelectedWorkFilter("all")}
              className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
                selectedWorkFilter === "all"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary"
              }`}
            >
              all statuses
            </button>
              </div>
            </div>
          </div>
          <div ref={issueListScrollRef} className="flex-1 overflow-y-auto">
            <div data-testid="issue-list">
              {isLoading ? (
                <div data-testid="issue-list-loading" aria-label="Loading issues">
                  {Array.from({ length: 6 }).map((_, idx) => (
                    <IssueRowSkeleton key={idx} />
                  ))}
                </div>
              ) : visibleIssues.length === 0 ? (
                <div className="p-4 text-[12px] text-muted-foreground">
                  {normalizedIssueNumberSearch
                    ? `No issues match #${normalizedIssueNumberSearch}.`
                    : "No open issues found in watched repositories."}
                </div>
              ) : (
                <>
                  {repoGroups.map((group) => (
                    <div key={group.repo} className="border-b border-border/60 last:border-b-0">
                      <div className="sticky top-0 z-10 border-b border-border bg-background px-4 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                        {group.repo} <span className="font-mono text-foreground/70">({group.issues.length})</span>
                      </div>
                      {group.issues.map((issue) => (
                        <IssueRow
                          key={issue.id}
                          issue={issue}
                          selected={issue.id === selectedIssueId}
                          onSelect={setSelectedIssueId}
                          queueStatus={queueStatusById.get(issue.id) ?? null}
                          verifyState={
                            verifyingIssueIds.has(issue.id)
                              ? "verifying"
                              : recentlyVerifiedIds.has(issue.id)
                                ? "verified"
                                : null
                          }
                        />
                      ))}
                    </div>
                  ))}
                  {canLoadMore && <div ref={loadMoreSentinelRef} className="h-8 w-full" data-testid="issues-load-more-sentinel" />}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {selectedIssue ? (
            <>
              {(() => {
                const metaItems: MetaItem[] = [
                  { key: "repo", content: <span>{selectedIssue.repo} <span className="font-mono text-foreground/80">#{selectedIssue.number}</span></span> },
                  { key: "author", content: <span>author: <span className="text-foreground/80">{selectedIssue.author || "unknown"}</span></span> },
                  { key: "comments", content: <span>comments: <span className="font-mono text-foreground/80">{selectedIssue.comments}</span></span> },
                  { key: "updated", content: <span>updated <span className="font-mono">{formatDateTime(selectedIssue.updatedAt)}</span></span> },
                ];
                if (selectedIssue.lastSyncSucceededAt) {
                  metaItems.push({ key: "synced", content: <span>synced <span className="font-mono">{formatDateTime(selectedIssue.lastSyncSucceededAt)}</span></span> });
                }
                if (selectedIssue.lastSyncError) {
                  metaItems.push({ key: "sync-error", content: <span className="text-destructive">sync error</span> });
                }
                return (
              <DetailHeader
                title={selectedIssue.title}
                titleMultiline
                accentTone="warning"
                failed={selectedIssue.workStatus === "failed"}
                stageBar={<StageProgressBar stages={buildIssueStages(selectedIssue)} testId="issue-stage-progress" />}
                externalLink={{ href: selectedIssue.url, label: `${selectedIssue.repo}#${selectedIssue.number}` }}
                meta={<MetaBreadcrumb items={metaItems} />}
                chips={(
                  <>
                    <IssueStatusBadge issue={selectedIssue} />
                    <QueueStatusBadge status={selectedIssueQueueStatus} />
                    {selectedIssue.workStage && selectedIssue.workStage !== selectedIssue.workStatus && (
                      <StatusChip
                        tone="neutral"
                        label={formatIssueWorkStage(selectedIssue)}
                        testId="issue-work-stage"
                      />
                    )}
                    {formatIssueWorkAttempt(selectedIssue) && (
                      <StatusChip
                        tone="neutral"
                        label={formatIssueWorkAttempt(selectedIssue) ?? ""}
                        testId="issue-work-attempt"
                      />
                    )}
                    {shouldShowIssueAutomationState(selectedIssue) && (
                      <>
                        <StatusChip
                          tone={autoWorkTone(selectedIssue.autoWorkEligible)}
                          label={formatAutoWorkState(selectedIssue)}
                          testId="issue-auto-work-state"
                        />
                        <StatusChip
                          tone={issueEvaluationTone(selectedIssue.evaluationStatus)}
                          label={formatEvaluationState(selectedIssue)}
                          title={selectedIssue.evaluationSummary ?? undefined}
                          testId="issue-evaluation-state"
                        />
                      </>
                    )}
                  </>
                )}
                actions={(
                  <>
                    <button
                      type="button"
                      onClick={() => syncIssueMutation.mutate(selectedIssue)}
                      disabled={syncIssueMutation.isPending || Boolean(runtime?.drainMode)}
                      title={runtime?.drainMode ? "Issue sync is paused by drain mode" : "Sync issue from GitHub now"}
                      data-testid="button-sync-issue"
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-transparent px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {syncIssueMutation.isPending ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Syncing
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-3.5 w-3.5" />
                          Sync
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => evaluateMutation.mutate(selectedIssue)}
                      disabled={evaluateMutation.isPending || Boolean(runtime?.drainMode)}
                      title={runtime?.drainMode ? "Issue evaluation is paused by drain mode" : "Evaluate this issue for auto work"}
                      data-testid="button-evaluate-issue"
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-transparent px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {evaluateMutation.isPending ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Evaluating
                        </>
                      ) : (
                        <>
                          <ShieldCheck className="h-3.5 w-3.5" />
                          Evaluate
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => workMutation.mutate(selectedIssue)}
                      disabled={workMutation.isPending || isActiveWorkStatus(selectedIssue.workStatus) || Boolean(runtime?.drainMode) || selectedIssueHasExternalPr}
                      title={
                        runtime?.drainMode
                          ? "Manual issue work is paused by drain mode"
                          : selectedIssueHasExternalPr
                            ? "Manual issue work is blocked because this issue already has a linked external PR"
                            : "Work this issue"
                      }
                      data-testid="button-work-issue"
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-primary bg-primary px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {workMutation.isPending ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Working
                        </>
                      ) : (
                        <>
                          <Wrench className="h-3.5 w-3.5" />
                          Work issue
                        </>
                      )}
                    </button>
                    {(() => {
                      const isVerifying = verifyingIssueIds.has(selectedIssue.id) || verifyMutation.isPending;
                      return (
                    <button
                      type="button"
                      onClick={() => verifyMutation.mutate(selectedIssue)}
                      disabled={
                        isVerifying
                        || Boolean(runtime?.drainMode)
                        || !selectedIssue.workPrUrl
                      }
                      title={
                        runtime?.drainMode
                          ? "Verification is paused by drain mode"
                          : !selectedIssue.workPrUrl
                            ? "Verification requires an open work PR"
                            : "Check the work PR diff against this issue's subtasks"
                      }
                      data-testid="button-verify-issue"
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-transparent px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {isVerifying ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Verifying
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Verify work
                        </>
                      )}
                    </button>
                      );
                    })()}
                  </>
                )}
              />
                );
              })()}
              <div className="flex-1 overflow-y-auto" data-testid="issue-detail-body">
              <div className="px-4 py-3">
                <div data-testid="issue-label-editor" className="flex flex-wrap items-center gap-1">
                  {selectedIssue.labels.length > 0 ? selectedIssue.labels.map((label) => (
                    <span key={label} className="inline-flex max-w-full items-center gap-1 border border-border pl-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <span className="min-w-0 truncate">{label}</span>
                      <button
                        type="button"
                        onClick={() => labelMutation.mutate({ issue: selectedIssue, remove: [label] })}
                        disabled={labelMutation.isPending}
                        title={`Remove ${label}`}
                        data-testid="button-remove-issue-label"
                        className="inline-flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  )) : (
                    <span className="text-[11px] text-muted-foreground">No labels</span>
                  )}
                  <form
                    className="ml-1 inline-flex items-center gap-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const label = labelInput.trim();
                      if (!label || !selectedIssue || selectedIssue.labels.includes(label)) {
                        return;
                      }
                      labelMutation.mutate({ issue: selectedIssue, add: [label] });
                    }}
                  >
                    <input
                      value={labelInput}
                      onChange={(event) => setLabelInput(event.target.value)}
                      placeholder="add label"
                      data-testid="issue-label-input"
                      className="h-6 w-44 border border-border bg-background px-2 text-[11px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                    <button
                      type="submit"
                      disabled={labelMutation.isPending || !labelInput.trim() || selectedIssue.labels.includes(labelInput.trim())}
                      title="Add label"
                      data-testid="button-add-issue-label"
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40"
                    >
                      {labelMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                    </button>
                  </form>
                </div>
                {selectedIssue.workPrUrl && selectedIssue.workPrNumber !== undefined && selectedIssue.workPrNumber !== null && (() => {
                  const readiness = getWorkPrReadiness(selectedIssue);
                  const toneClass = readiness.tone === "success"
                    ? "border-success-border bg-success-muted text-success-foreground"
                    : readiness.tone === "warning"
                      ? "border-warning-border bg-warning-muted text-warning-foreground"
                      : "border-border bg-muted/30 text-muted-foreground";

                  return (
                    <a
                      href={selectedIssue.workPrUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      data-testid="issue-ready-to-merge"
                      className={`mt-3 flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-[11px] transition-colors hover:border-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${toneClass}`}
                    >
                      <span className="min-w-0">
                        <span className="block text-[10px] uppercase tracking-wider opacity-70">
                          {readiness.label}
                        </span>
                        <span className="block truncate text-[12px] leading-5">
                          {readiness.detail}
                        </span>
                      </span>
                      <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-80" />
                    </a>
                  );
                })()}
                {hasExternalIssuePr(selectedIssue) && (
                  <a
                    href={selectedIssue.externalWorkPrUrl ?? "#"}
                    target="_blank"
                    rel="noreferrer noopener"
                    data-testid="issue-external-pr"
                    className="mt-3 flex items-center justify-between gap-3 rounded-md border border-warning-border bg-warning-muted px-3 py-2 text-[11px] text-warning-foreground transition-colors hover:border-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                  >
                    <span className="min-w-0">
                      <span className="block text-[10px] uppercase tracking-wider opacity-70">
                        Linked external PR
                      </span>
                      <span className="block truncate text-[12px] leading-5">
                        {selectedIssue.externalWorkPrRepo ?? selectedIssue.repo} #{selectedIssue.externalWorkPrNumber}
                      </span>
                    </span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-80" />
                  </a>
                )}
                {selectedIssue.workStatus === "failed" && selectedIssue.lastError && (
                  <DetailPanel
                    title="Issue work failed"
                    tone="destructive"
                    testId="issue-work-failed"
                    action={(
                      <button
                        type="button"
                        onClick={() => clearFailuresMutation.mutate(selectedIssue)}
                        disabled={clearFailuresMutation.isPending}
                        title="Clear failed issue work attempts"
                        data-testid="button-clear-issue-failures"
                        className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-destructive/50 bg-background/40 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-destructive transition-colors hover:bg-destructive hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {clearFailuresMutation.isPending ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Clearing
                          </>
                        ) : (
                          <>
                            <Trash2 className="h-3.5 w-3.5" />
                            Clear failures
                          </>
                        )}
                      </button>
                    )}
                  >
                    <div className="max-h-80 overflow-auto whitespace-pre-wrap px-3 py-2 text-[11px] leading-5 text-destructive">
                      {selectedIssue.lastError}
                    </div>
                  </DetailPanel>
                )}
                {selectedIssue.subtasks && selectedIssue.subtasks.length > 0 && (
                  <SubtaskListPanel subtasks={selectedIssue.subtasks} />
                )}
                {shouldShowIssueAutomationState(selectedIssue) && (
                  <DetailPanel
                    title="Automation gate"
                    testId="issue-evaluation-detail"
                    chip={(
                      <StatusChip
                        tone={issueEvaluationTone(selectedIssue.evaluationStatus)}
                        label={formatEvaluationState(selectedIssue)}
                      />
                    )}
                  >
                    <div className="px-3 py-2">
                      <div className="text-[12px] leading-5 text-foreground/85">
                        {selectedIssue.evaluationSummary ?? selectedIssue.autoWorkBlockedReason ?? "Evaluate this issue before auto-mode can work it."}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <span className="border border-border/60 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                          auto: {selectedIssue.autoWorkEligible ? "enabled" : "blocked"}
                        </span>
                        {typeof selectedIssue.evaluationConfidence === "number" && (
                          <span className="border border-border/60 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                            confidence: {formatEvaluationConfidence(selectedIssue.evaluationConfidence)}
                          </span>
                        )}
                        {selectedIssue.evaluationUpdatedAt && (
                          <span className="border border-border/60 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                            evaluated: {formatDateTime(selectedIssue.evaluationUpdatedAt)}
                          </span>
                        )}
                      </div>
                      {selectedIssue.evaluationSafetyFlags && selectedIssue.evaluationSafetyFlags.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {selectedIssue.evaluationSafetyFlags.map((flag) => (
                            <span key={flag} className="border border-destructive/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-destructive">
                              {flag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </DetailPanel>
                )}
                <div className="mt-3 text-[11px] uppercase tracking-wider text-muted-foreground">
                  Issue body
                </div>
                {selectedIssue.bodyHtml ? (
                  <article
                    data-testid="issue-body-markdown"
                    className="issue-markdown mt-2 border border-border/60 bg-background p-4"
                    dangerouslySetInnerHTML={{ __html: selectedIssue.bodyHtml }}
                  />
                ) : (
                  <pre className="mt-2 whitespace-pre-wrap break-words border border-border/60 bg-background p-4 text-[12px] leading-6 text-muted-foreground">
                    {selectedIssue.body?.trim() || "No body provided."}
                  </pre>
                )}
              </div>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
              Select an issue from the left panel.
            </div>
          )}
        </div>

        <IssueLogPanel logs={issueLogs} selected={Boolean(selectedIssue)} />
      </div>
    </div>
  );
}

export default function Issues() {
  return (
    <IssuesErrorBoundary>
      <IssuesPage />
    </IssuesErrorBoundary>
  );
}
