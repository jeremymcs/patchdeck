import { memo, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as Collapsible from "@radix-ui/react-collapsible";
import { AlertTriangle, Bot, ChevronDown, ChevronUp, Loader2, Pause, Play, PlayCircle, RefreshCw } from "lucide-react";
import { queryClient, apiRequest, fetchJson } from "@/lib/queryClient";
import type { ActivityItem, ActivitySnapshot, Config, FeedbackItem, HealingSession, Issue, IssueListPage, LogEntry, OperatorWarning, PR, PRQuestion, PRSummary, RuntimeState, WatchedRepo } from "@shared/schema";
import { AppHeader } from "@/components/AppHeader";
import { OnboardingPanel } from "@/components/OnboardingPanel";
import { UpdateBanner } from "@/components/UpdateBanner";
import { ActivityMenu, EMPTY_ACTIVITY_SNAPSHOT } from "@/components/ActivityMenu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { toast } from "@/hooks/use-toast";
import {
  formatFeedbackStatusLabel,
  getFeedbackStatusBadgeClass,
  isFeedbackCollapsedByDefault,
  countActiveFeedbackStatuses,
  isPRReadyToMerge,
} from "@/lib/feedbackStatus";
import {
  getHealingSessionView,
  selectRelevantHealingSession,
} from "@/lib/ciHealing";
import { buildQueueStatusIndex, type QueueStatusView } from "@/lib/activityQueue";
import { QueueStatusBadge } from "@/components/QueueStatusBadge";
import { DashboardErrorsPanel } from "@/components/DashboardErrorsPanel";
import { Skeleton } from "@/components/ui/skeleton";
import { DetailHeader } from "@/components/detail/DetailHeader";
import { MetaBreadcrumb, type MetaItem } from "@/components/detail/MetaBreadcrumb";
import { StageProgressBar } from "@/components/detail/StageProgressBar";
import { StatusChip } from "@/components/detail/StatusChip";
import { buildPRStages } from "@/lib/stages";
import { prStatusTone, toneRailClass } from "@/lib/statusTones";
import { getUiPollIntervalMs } from "@/lib/polling";

type GitHubRateLimitState = {
  limited: boolean;
  resetAt: string | null;
  recentlyLimited?: boolean;
};

function formatClock(timestamp: string | null): string | null {
  if (!timestamp) {
    return null;
  }

  return new Date(timestamp).toLocaleTimeString("en-US", { hour12: false });
}

function isPRWatchEnabled(pr: Pick<PRSummary, "watchEnabled">): boolean {
  return pr.watchEnabled;
}

function normalizeNumberSearch(value: string): string {
  return value.trim().replace(/^#/, "").trim();
}

function matchesNumberSearch(number: number, search: string): boolean {
  const normalized = normalizeNumberSearch(search);
  return normalized === "" || String(number).includes(normalized);
}

function prIssueLinkKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

type PrStatusFilter = "all" | "ready" | "ci_failing" | "attention" | "processing" | "done";

function matchesPrStatusFilter(pr: PRSummary, filter: PrStatusFilter): boolean {
  switch (filter) {
    case "ready":
      // No mergeable_state on the stored PR — "done with green CI" is the proxy.
      return pr.status === "done" && pr.testsPassed === true && pr.lintPassed === true;
    case "ci_failing":
      return pr.testsPassed === false || pr.lintPassed === false;
    case "attention":
      return pr.flagged > 0 || pr.status === "error";
    case "processing":
      return pr.status === "processing";
    case "done":
      return pr.status === "done";
    case "all":
      return true;
  }
}

const PR_STATUS_FILTERS: { value: PrStatusFilter; label: string; testId: string }[] = [
  { value: "ready", label: "ready to merge", testId: "pr-ready-filter" },
  { value: "ci_failing", label: "ci failing", testId: "pr-ci-failing-filter" },
  { value: "attention", label: "needs attention", testId: "pr-attention-filter" },
  { value: "processing", label: "processing", testId: "pr-processing-filter" },
  { value: "done", label: "done", testId: "pr-done-filter" },
];

function FilterChip({
  active,
  onClick,
  testId,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary"
      }`}
    >
      {children}
    </button>
  );
}

function buildIssueLinkedPRIndex(issues: Issue[]): Map<string, Issue> {
  const index = new Map<string, Issue>();
  for (const issue of issues) {
    if (issue.workPrNumber === null || issue.workPrNumber === undefined) {
      continue;
    }

    index.set(prIssueLinkKey(issue.repo, issue.workPrNumber), issue);
  }
  return index;
}

function formatStatusLabel(status: PR["status"], prStage?: PR["prStage"]): string {
  if (status === "processing") {
    if (prStage === "feedback_synced") return "feedback synced";
    if (prStage === "triaged") return "triaged";
    if (prStage === "applying") return "applying fixes";
    if (prStage === "tests") return "running tests";
    if (prStage === "done") return "completed";
    return "autonomous run active";
  }

  if (status === "done") {
    return "completed";
  }

  if (status === "error") {
    return "attention needed";
  }

  if (status === "archived") {
    return "archived";
  }

  return "watching";
}

function latestActivityForTarget(activities: ActivityItem[], targetId: string): ActivityItem | undefined {
  return activities.reduce((latest, activity) => {
    if (activity.targetId !== targetId) {
      return latest;
    }
    if (!latest || Date.parse(activity.updatedAt) > Date.parse(latest.updatedAt)) {
      return activity;
    }
    return latest;
  }, undefined as ActivityItem | undefined);
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

function getPRFeedbackFailureReason(pr: PR | PRSummary | null): string | null {
  if (!pr || !("feedbackItems" in pr)) {
    return null;
  }

  const failedItem = pr.feedbackItems.find((item) =>
    (item.status === "failed" || item.status === "warning") && Boolean(item.statusReason),
  );

  return failedItem?.statusReason ?? null;
}

const MAX_VISIBLE_LOGS = 200;
const DRAIN_PAUSED_LABEL = "Paused";
const DRAIN_PAUSED_TITLE = "Paused by drain mode";
const MANUAL_RUNS_BLOCKED_COPY = "Manual runs are blocked while global automation is paused.";
const GLOBAL_DRAIN_PR_COPY = "Background and manual runs are paused by drain mode.";
const ASK_DRAIN_COPY = "Ask Agent is paused by drain mode.";

const HEALING_TONE_CLASSES: Record<"neutral" | "info" | "warning" | "success" | "danger", string> = {
  neutral: "border-border text-muted-foreground",
  info: "border-primary bg-primary/10 text-primary",
  warning: "border-warning-border bg-warning-muted text-warning-foreground",
  success: "border-success-border bg-success-muted text-success-foreground",
  danger: "border-destructive bg-destructive/10 text-destructive",
};

function FeedbackStatusTag({ status }: { status: FeedbackItem["status"] }) {
  const cls = getFeedbackStatusBadgeClass(status);
  return (
    <span className={`inline-block border px-1.5 py-0 text-[11px] uppercase tracking-wide ${cls}`}>
      {formatFeedbackStatusLabel(status)}
    </span>
  );
}

function WatchPausedIndicator() {
  return (
    <span className="border border-border px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground">
      watch paused
    </span>
  );
}

function DashboardDrainBanner({ runtimeState }: { runtimeState: RuntimeState | undefined }) {
  if (!runtimeState?.drainMode) {
    return null;
  }

  return (
    <div
      className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-[12px]"
      data-testid="dashboard-drain-banner"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-wider text-destructive">
            {DRAIN_PAUSED_TITLE}
          </div>
          {runtimeState.drainReason ? (
            <div
              className="mt-1 break-words text-foreground/80"
              data-testid="dashboard-drain-reason"
            >
              {runtimeState.drainReason}
            </div>
          ) : null}
          <div className="mt-1 text-[11px] text-muted-foreground">
            {MANUAL_RUNS_BLOCKED_COPY}
          </div>
        </div>
        <Link
          href="/settings"
          className="shrink-0 border border-destructive/50 px-2 py-0.5 text-[10px] uppercase tracking-wider text-destructive transition-colors hover:bg-destructive hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          Settings
        </Link>
      </div>
    </div>
  );
}

function OperatorWarningsBanner({ warnings }: { warnings: OperatorWarning[] }) {
  if (warnings.length === 0) {
    return null;
  }

  return (
    <div
      className="shrink-0 border-b border-yellow-600/50 bg-yellow-500/10 px-4 py-3"
      data-testid="operator-warnings-banner"
    >
      <div className="space-y-3">
        {warnings.map((warning) => (
          <div key={warning.id} data-testid={`operator-warning-${warning.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[12px] font-medium uppercase tracking-wider text-yellow-600">
                {warning.title}
              </div>
              {warning.targetUrl && (
                <a
                  href={warning.targetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="border border-yellow-600/60 px-2 py-0.5 text-[10px] uppercase tracking-wider text-yellow-600 transition-colors hover:bg-yellow-600 hover:text-background"
                >
                  Open PR
                </a>
              )}
            </div>
            <div className="mt-1 text-[12px] text-foreground/80">{warning.message}</div>
            <ol className="mt-2 list-decimal space-y-1 pl-4 text-[11px] text-muted-foreground">
              {warning.fixSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReadyToMergeIndicator({
  href,
  testId,
  label,
  hint,
  className,
  dotClassName,
  hintClassName,
  onClick,
}: {
  href: string;
  testId: string;
  label: string;
  hint?: string;
  className: string;
  dotClassName: string;
  hintClassName?: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
      data-testid={testId}
      className={`inline-flex items-center rounded-md border border-success-border bg-success-muted font-medium uppercase text-success-foreground transition-colors hover:bg-success-muted/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${className}`}
    >
      <span className={`inline-block rounded-full bg-success ${dotClassName}`} />
      {label}
      {hint && <span className={hintClassName}>{hint}</span>}
    </a>
  );
}

function AgentIndicator({ pr }: { pr: PRSummary }) {
  const isProcessing = pr.status === "processing";

  if (!isProcessing) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0 cursor-default items-center gap-1 text-[12px] text-primary"
          data-testid={`agent-indicator-${pr.id}`}
        >
          <Bot className="h-3.5 w-3.5 animate-pulse" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p className="text-xs">Agent run active on this PR</p>
      </TooltipContent>
    </Tooltip>
  );
}

function PRRowSkeleton() {
  return (
    <div className="border-b border-l-2 border-l-transparent border-border px-4 py-3">
      <div className="flex items-start gap-3">
        <Skeleton className="mt-1.5 h-2 w-2 rounded-full" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
          <div className="mt-2 ml-[3.75rem] flex items-center gap-3">
            <Skeleton className="h-2.5 w-24" />
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-2.5 w-14" />
          </div>
        </div>
      </div>
    </div>
  );
}

const PRRow = memo(function PRRow({
  pr,
  isSelected,
  onSelect,
  failureMessage,
  queueStatus,
  issueLink,
}: {
  pr: PRSummary;
  isSelected: boolean;
  onSelect: (id: string) => void;
  failureMessage?: string | null;
  queueStatus: QueueStatusView | null;
  issueLink?: Issue | null;
}) {
  const checkedAt = formatClock(pr.lastChecked);
  const watchEnabled = isPRWatchEnabled(pr);
  return (
    <div
      onClick={() => onSelect(pr.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }

        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(pr.id);
        }
      }}
      role="button"
      tabIndex={0}
      data-testid={`pr-row-${pr.id}`}
      className={`w-full cursor-pointer border-b border-border px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
        isSelected
          ? "border-l-[3px] border-l-primary bg-muted"
          : `border-l-2 ${toneRailClass(prStatusTone(pr))}`
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <span className="w-12 shrink-0 font-mono text-[12px] text-muted-foreground">#{pr.number}</span>
            <span className="truncate">{pr.title}</span>
            <AgentIndicator pr={pr} />
            {issueLink && (
              <span
                data-testid="pr-on-issues-badge"
                className="shrink-0 rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0 text-[10px] uppercase tracking-wider text-primary"
                title={`Linked from issue #${issueLink.number}`}
              >
                issue <span className="font-mono">#{issueLink.number}</span>
              </span>
            )}
          </div>
          {pr.status === "error" && failureMessage && (
            <div className="mt-2 ml-[3.75rem] border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] leading-4 text-destructive">
              <span className="font-medium uppercase tracking-wider">Error:</span>{" "}
              <span className="break-words">{failureMessage}</span>
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[3.75rem] text-[11px] text-muted-foreground">
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="underline decoration-border underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            >
              {pr.repo}
            </a>
            <span>{formatStatusLabel(pr.status, pr.prStage)}</span>
            <QueueStatusBadge status={queueStatus} />
            {!watchEnabled && <WatchPausedIndicator />}
            <span>{pr.accepted + pr.rejected + pr.flagged} triaged</span>
            {checkedAt && <span>checked {checkedAt}</span>}
          </div>
        </div>
      </div>
    </div>
  );
});

function isTrustedAuthor(author: string, trustedReviewers: readonly string[] | undefined): boolean {
  if (!author || !trustedReviewers || trustedReviewers.length === 0) return false;
  const normalized = author.trim().toLowerCase().replace(/^@/, "");
  return trustedReviewers.some((entry) => entry.trim().toLowerCase().replace(/^@/, "") === normalized);
}

function FeedbackRow({
  item,
  prId,
  readOnly,
  globalDrainMode = false,
}: {
  item: FeedbackItem;
  prId: string;
  readOnly?: boolean;
  globalDrainMode?: boolean;
}) {
  const overrideMutation = useMutation({
    mutationFn: async (decision: string) => {
      const res = await apiRequest("PATCH", `/api/prs/${prId}/feedback/${item.id}`, { decision });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prs", prId] });
    },
  });

  const retryMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/prs/${prId}/feedback/${item.id}/retry`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prs", prId] });
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/logs"] });
    },
    onError: (error) => {
      showMutationError("Could not retry feedback item", error);
    },
  });

  const createdAt = formatClock(item.createdAt);
  const collapsedByDefault = isFeedbackCollapsedByDefault(item.status);
  const prominentStatusReason = (item.status === "failed" || item.status === "warning") && item.statusReason
    ? item.statusReason
    : null;
  const { data: config } = useQuery<Config>({ queryKey: ["/api/config"] });
  const trusted = isTrustedAuthor(item.author, config?.trustedReviewers);

  return (
    <Collapsible.Root defaultOpen={!collapsedByDefault} className="border-b border-border">
      <div className="px-4 py-3">
        {/* Header row - always visible */}
        <div className="flex items-start gap-3">
          <div className="shrink-0 pt-0.5">
            <FeedbackStatusTag status={item.status} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="font-medium">{item.author}</span>
              {trusted && (
                <span
                  className="rounded-md border border-success-border bg-success-muted px-1.5 py-0 text-[10px] font-medium uppercase tracking-wider text-success-foreground"
                  title={`@${item.author} is in Trusted reviewers — feedback is auto-accepted, agent evaluation skipped.`}
                  data-testid={`feedback-trusted-${item.id}`}
                >
                  trusted
                </span>
              )}
              {item.file && (
                <span className="font-mono text-[11px] text-muted-foreground">
                  {item.file}{item.line ? `:${item.line}` : ""}
                </span>
              )}
              <span className="text-[11px] text-muted-foreground">{item.type.replace("_", " ")}</span>
              {createdAt && <span className="text-[11px] text-muted-foreground">{createdAt}</span>}
            </div>
            {prominentStatusReason && (
              <div className="mt-1 whitespace-pre-wrap break-words border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] leading-4 text-destructive">
                <span className="font-medium uppercase tracking-wider">Failure reason:</span>{" "}
                {prominentStatusReason}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!readOnly && (item.status === "failed" || item.status === "warning") && (
              <button
                type="button"
                onClick={() => retryMutation.mutate()}
                disabled={retryMutation.isPending || globalDrainMode}
                data-testid={`retry-${item.id}`}
                aria-label={`Retry feedback from ${item.author}`}
                title={globalDrainMode ? DRAIN_PAUSED_TITLE : "Retry feedback item"}
                className="border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-30"
              >
                {globalDrainMode ? DRAIN_PAUSED_LABEL : "Retry"}
              </button>
            )}
            <Collapsible.Trigger asChild>
              <button
                type="button"
                data-testid={`toggle-${item.id}`}
                aria-label={`${collapsedByDefault ? "Show" : "Hide"} feedback details from ${item.author}`}
                title="Toggle feedback details"
                className="border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              >
                Details
              </button>
            </Collapsible.Trigger>
            {!readOnly && (["accept", "reject", "flag"] as const).map((decision) => {
              const selected = item.decision === decision;
              const selectedClass =
                decision === "accept"
                  ? "border-success-border bg-success-muted text-success-foreground"
                  : decision === "reject"
                    ? "border-destructive bg-destructive/10 text-destructive"
                    : "border-warning-border bg-warning-muted text-warning-foreground";
              return (
                <button
                  type="button"
                  key={decision}
                  onClick={() => overrideMutation.mutate(decision)}
                  data-testid={`override-${decision}-${item.id}`}
                  aria-label={`${decision} feedback from ${item.author}`}
                  aria-pressed={selected}
                  className={`cursor-pointer rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
                    selected ? selectedClass : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {decision}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <Collapsible.Content>
        <div className="px-4 pb-3">
          {item.bodyHtml ? (
            <div
              className="feedback-markdown text-[12px] leading-relaxed"
              dangerouslySetInnerHTML={{ __html: item.bodyHtml }}
            />
          ) : (
            <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/80">{item.body}</p>
          )}
          {item.statusReason && !prominentStatusReason && (
            <p className="mt-2 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
              <span className="font-medium uppercase tracking-wider text-foreground/70">Status reason:</span>{" "}
              {item.statusReason}
            </p>
          )}
          {item.decisionReason && (
            <p className="mt-2 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
              <span className="font-medium uppercase tracking-wider text-foreground/70">Decision reason:</span>{" "}
              {item.decisionReason}
            </p>
          )}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function LogPanel({ prId }: { prId: string | null }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const { data: logs = [] } = useQuery<LogEntry[]>({
    queryKey: ["/api/logs", prId ?? "all"],
    queryFn: async () => {
      if (!prId) {
        return [];
      }
      const url = `/api/logs?prId=${encodeURIComponent(prId)}`;
      const res = await apiRequest("GET", url);
      return res.json();
    },
    enabled: Boolean(prId),
    refetchInterval: 1500,
  });
  const visibleLogs = useMemo(
    () => logs.length > MAX_VISIBLE_LOGS ? logs.slice(-MAX_VISIBLE_LOGS) : logs,
    [logs],
  );
  const hiddenLogCount = logs.length - visibleLogs.length;
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }

    scroller.scrollTop = scroller.scrollHeight;
  }, [logs.length, prId]);

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollerRef} className="flex-1 overflow-y-auto" data-testid="pr-detail-logs">
        {!prId ? (
          <div className="p-4 text-[12px] text-muted-foreground">Select a PR to see logs.</div>
        ) : logs.length === 0 ? (
          <div className="p-4 text-[12px] text-muted-foreground">No workflow logs yet.</div>
        ) : (
          <>
            {hiddenLogCount > 0 && (
              <div className="border-b border-border/60 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                Showing latest {MAX_VISIBLE_LOGS} of {logs.length} entries.
              </div>
            )}
            {visibleLogs.map((log) => {
              const metadataText = log.metadata && Object.keys(log.metadata).length > 0
                ? JSON.stringify(log.metadata, null, 2)
                : null;

              return (
                <div key={log.id} className="border-b border-border/60 px-3 py-2 last:border-b-0" data-testid={`log-${log.id}`}>
                  <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <span className={
                      log.level === "error" ? "text-destructive" :
                      log.level === "warn" ? "text-warning-foreground" :
                      log.level === "info" ? "text-primary" :
                      "text-muted-foreground"
                    }>
                      {log.level}
                    </span>
                    {log.phase && <span className="border border-border px-1 py-0">{log.phase}</span>}
                    {log.runId && <span className="normal-case text-foreground/45">run {log.runId.slice(0, 8)}</span>}
                    <span>{formatClock(log.timestamp)}</span>
                  </div>
                  <div className={`mt-1 break-words text-[12px] ${log.level === "error" ? "text-destructive" : "text-foreground/75"}`}>
                    {log.message}
                  </div>
                  {metadataText && (
                    <pre className="mt-1 whitespace-pre-wrap break-all text-[10px] text-muted-foreground">
                      {metadataText}
                    </pre>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

function HealingPanel({
  pr,
  config,
  healingSessions,
}: {
  pr: PR;
  config: Config | undefined;
  healingSessions: HealingSession[];
}) {
  const session = selectRelevantHealingSession(healingSessions, pr.id);
  const view = session ? getHealingSessionView(session, config) : null;
  const toneClass = view ? HEALING_TONE_CLASSES[view.tone] : HEALING_TONE_CLASSES.neutral;

  return (
    <div
      className="shrink-0 border-b border-border px-4 py-3"
      data-testid="panel-ci-healing"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">CI healing</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {view ? (
              <>
                <span className={`inline-flex rounded-md border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wider ${toneClass}`}>
                  {view.stateLabel}
                </span>
                <span className="text-[11px] text-muted-foreground">{view.attemptSummary}</span>
              </>
            ) : (
              <span className="text-[11px] text-muted-foreground">
                {config?.autoHealCI === false
                  ? "Automatic CI healing is disabled in settings."
                  : "No healing session yet for this PR."}
              </span>
            )}
          </div>
        </div>
        {session && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            head {session.currentHeadSha.slice(0, 7)}
          </span>
        )}
      </div>

      {view ? (
        <>
          <div className="mt-2 grid gap-1 text-[11px]">
            {view.reasonSummary && (
              <div>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Reason</span>
                <span className="ml-2 text-foreground/80">{view.reasonSummary}</span>
              </div>
            )}
            <div className="text-muted-foreground">{view.statusHint}</div>
            <div>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Attempts</span>
              <span className="ml-2 font-mono text-foreground/80">{view.attemptSummary}</span>
              {session?.latestFingerprint && (
                <>
                  <span className="mx-1.5 text-border" aria-hidden="true">·</span>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">fingerprint</span>
                  <span className="ml-1.5 font-mono text-foreground/80">{session.latestFingerprint}</span>
                </>
              )}
            </div>
          </div>
          {view.actions.length > 0 && (
            <>
              <div className="mt-2 flex flex-wrap gap-2">
                {view.actions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    disabled
                    title={action.hint}
                    className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors ${
                      action.available
                        ? "border-border text-foreground/70 hover:bg-muted"
                        : "border-border text-muted-foreground/60"
                    } disabled:opacity-100`}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">
                Operator controls are read-only until healing action endpoints are added.
              </div>
            </>
          )}
        </>
      ) : (
        config?.autoHealCI !== false && (
          <div className="mt-2 text-[11px] text-muted-foreground">
            The watcher will create a healing session when a failing check is classified as healable.
          </div>
        )
      )}
    </div>
  );
}

function PRDescriptionPanel({ pr }: { pr: PR }) {
  const [isOpen, setIsOpen] = useState(false);
  if (!pr.body && !pr.bodyHtml) return null;
  return (
    <div className="shrink-0 border-b border-border px-4 py-3" data-testid="panel-pr-description">
      <button
        type="button"
        onClick={() => setIsOpen((o) => !o)}
        aria-expanded={isOpen}
        className="flex w-full items-center justify-between gap-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Description</div>
        {isOpen ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
      </button>
      {isOpen && (
        pr.bodyHtml ? (
          <article
            data-testid="pr-body-markdown"
            className="issue-markdown mt-2 border border-border/60 bg-background p-4"
            dangerouslySetInnerHTML={{ __html: pr.bodyHtml }}
          />
        ) : (
          <pre className="mt-2 whitespace-pre-wrap break-words border border-border/60 bg-background p-4 text-[12px] leading-6 text-muted-foreground">
            {pr.body?.trim() || "No description provided."}
          </pre>
        )
      )}
    </div>
  );
}

function RightPanel({ prId }: { prId: string | null }) {
  return (
    <div className="flex min-h-[24rem] w-full shrink-0 flex-col border-t border-border lg:min-h-0 lg:w-80 lg:border-l lg:border-t-0">
      <div className="flex shrink-0 border-b border-border">
        <div
          className="flex-1 bg-muted px-3 py-2 text-[11px] uppercase tracking-wider text-foreground shadow-[inset_0_-2px_0_0_hsl(var(--primary))]"
          data-testid="tab-activity"
        >
          Activity
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <LogPanel prId={prId} />
      </div>
    </div>
  );
}

function QAPanel({ prId, globalDrainMode }: { prId: string; globalDrainMode: boolean }) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: questions = [] } = useQuery<PRQuestion[]>({
    queryKey: ["/api/prs", prId, "questions"],
    refetchInterval: 2000,
  });

  const askMutation = useMutation({
    mutationFn: (question: string) =>
      apiRequest("POST", `/api/prs/${prId}/questions`, { question }).then((res) => res.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs", prId, "questions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      setInput("");
    },
  });

  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [questions.length, questions[questions.length - 1]?.status]);

  const askDisabled = askMutation.isPending || !input.trim() || globalDrainMode;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-4 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
        Ask Agent
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {questions.length === 0 ? (
          <span className="text-[12px] text-muted-foreground">
            {globalDrainMode
              ? ASK_DRAIN_COPY
              : "Ask questions about this PR — the agent will read activity logs, feedback, and status to answer."}
          </span>
        ) : (
          questions.map((q) => (
            <div key={q.id} className="space-y-1.5" data-testid={`question-${q.id}`}>
              <div className="text-[12px]">
                <span className="font-medium text-foreground/90">Q: </span>
                <span className="text-foreground/80">{q.question}</span>
              </div>
              {q.status === "pending" || q.status === "answering" ? (
                <div className="text-[11px] text-muted-foreground animate-pulse">
                  Agent is thinking...
                </div>
              ) : q.status === "error" ? (
                <div className="text-[11px] text-destructive">
                  Error: {q.error || "Unknown error"}
                </div>
              ) : (
                <div className="text-[12px] leading-relaxed text-foreground/85 whitespace-pre-wrap border-l-2 border-primary/40 pl-3">
                  {q.answer}
                </div>
              )}
              <div className="text-[10px] text-muted-foreground">
                {formatClock(q.createdAt)}
                {q.answeredAt && ` — answered ${formatClock(q.answeredAt)}`}
              </div>
            </div>
          ))
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!askDisabled) askMutation.mutate(input.trim());
        }}
        className="border-t border-border p-3"
      >
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={globalDrainMode ? "Drain mode is enabled." : "Was the review done? Why did this fail?"}
            aria-label="Question for selected pull request"
            disabled={globalDrainMode}
            data-testid="input-question"
            className="flex-1 border border-border bg-transparent px-2 py-1 text-[12px] placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          />
          <button
            type="submit"
            disabled={askDisabled}
            title={globalDrainMode ? DRAIN_PAUSED_TITLE : "Ask agent"}
            data-testid="button-ask"
            className="cursor-pointer border border-primary bg-primary px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
          >
            {globalDrainMode ? DRAIN_PAUSED_LABEL : askMutation.isPending ? "..." : "Ask"}
          </button>
        </div>
        {askMutation.isError && (
          <div className="mt-1 text-[11px] text-destructive">
            {getErrorMessage(askMutation.error)}
          </div>
        )}
      </form>
    </div>
  );
}

function getErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const raw = error.message.replace(/^\d+:\s*/, "").trim();
  if (!raw) {
    return "Request failed";
  }

  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string") {
      return parsed.error;
    }
    if (typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // Keep the original message when the server did not return JSON.
  }

  return raw;
}

function showMutationError(title: string, error: unknown) {
  toast({
    variant: "destructive",
    title,
    description: getErrorMessage(error),
  });
}

export default function Dashboard() {
  const [selectedPRId, setSelectedPRId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"active" | "issues" | "archived">("active");
  const [prNumberSearch, setPrNumberSearch] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<string>("all");
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<PrStatusFilter>("all");
  const [areErrorsRolledUp, setAreErrorsRolledUp] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isAskOpen, setIsAskOpen] = useState(false);

  const handleSyncDashboard = async () => {
    setIsRefreshing(true);
    try {
      await apiRequest("POST", "/api/repos/sync");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/prs"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/prs/archived"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/issues"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/activities"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/healing-sessions"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/runtime"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] }),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  };

  const { data: config } = useQuery<Config>({
    queryKey: ["/api/config"],
    refetchInterval: 5000,
  });
  const uiPollIntervalMs = getUiPollIntervalMs(config);

  const { data: prs = [], isLoading } = useQuery<PRSummary[]>({
    queryKey: ["/api/prs"],
    refetchInterval: 3000,
  });

  const { data: archivedPRs = [], isLoading: isLoadingArchived } = useQuery<PRSummary[]>({
    queryKey: ["/api/prs/archived"],
    refetchInterval: 10000,
  });

  const { data: runtimeState } = useQuery<RuntimeState>({
    queryKey: ["/api/runtime"],
    refetchInterval: 3000,
  });
  const { data: githubRateLimit } = useQuery<GitHubRateLimitState>({
    queryKey: ["/api/github-rate-limit"],
    refetchInterval: uiPollIntervalMs,
  });
  const globalDrainMode = runtimeState?.drainMode === true;
  const isGitHubThrottled = githubRateLimit?.limited === true;
  const throttledTitle = githubRateLimit?.resetAt
    ? `GitHub rate limited until ${new Date(githubRateLimit.resetAt).toLocaleTimeString("en-US")}`
    : "GitHub rate limited";

  const { data: issuesPage, isLoading: isLoadingIssues } = useQuery<IssueListPage>({
    queryKey: ["/api/issues"],
    enabled: runtimeState !== undefined && !globalDrainMode,
    refetchInterval: uiPollIntervalMs,
  });
  const issues = issuesPage?.items ?? [];

  const { data: healingSessions = [] } = useQuery<HealingSession[]>({
    queryKey: ["/api/healing-sessions"],
    queryFn: async () => fetchJson<HealingSession[]>("/api/healing-sessions"),
    refetchInterval: 5000,
  });

  const { data: activities = EMPTY_ACTIVITY_SNAPSHOT } = useQuery<ActivitySnapshot>({
    queryKey: ["/api/activities"],
    refetchInterval: 3000,
  });
  const queueStatusById = useMemo(() => buildQueueStatusIndex(activities), [activities]);

  const { data: repos = [] } = useQuery<WatchedRepo[]>({
    queryKey: ["/api/repos/settings"],
    refetchInterval: 5000,
  });

  const issueLinkedPRByKey = useMemo(() => buildIssueLinkedPRIndex(issues), [issues]);
  const issueLinkedPRs = useMemo(
    () => prs.filter((pr) => issueLinkedPRByKey.has(prIssueLinkKey(pr.repo, pr.number))),
    [prs, issueLinkedPRByKey],
  );
  const viewPRs = viewMode === "archived"
    ? archivedPRs
    : viewMode === "issues"
      ? issueLinkedPRs
      : prs;
  const repoCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const pr of viewPRs) {
      counts.set(pr.repo, (counts.get(pr.repo) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [viewPRs]);
  const statusCounts = useMemo(() => {
    const counts: Record<PrStatusFilter, number> = {
      all: viewPRs.length,
      ready: 0,
      ci_failing: 0,
      attention: 0,
      processing: 0,
      done: 0,
    };
    for (const pr of viewPRs) {
      for (const { value } of PR_STATUS_FILTERS) {
        if (matchesPrStatusFilter(pr, value)) {
          counts[value] += 1;
        }
      }
    }
    return counts;
  }, [viewPRs]);
  const displayedPRs = viewPRs
    .filter((pr) => matchesNumberSearch(pr.number, prNumberSearch))
    .filter((pr) => selectedRepo === "all" || pr.repo === selectedRepo)
    .filter((pr) => matchesPrStatusFilter(pr, selectedStatusFilter))
    .sort((a, b) => b.number - a.number);
  const isArchived = viewMode === "archived";
  const normalizedPrNumberSearch = normalizeNumberSearch(prNumberSearch);
  const isLoadingCurrentView = isArchived ? isLoadingArchived : viewMode === "issues" ? isLoading || isLoadingIssues : isLoading;
  const selectedPRSummary = displayedPRs.find((pr) => pr.id === selectedPRId) ?? null;
  const { data: selectedPRDetail } = useQuery<PR | null>({
    queryKey: ["/api/prs", selectedPRId],
    enabled: selectedPRId !== null,
    queryFn: async () => {
      if (!selectedPRId) return null;
      return fetchJson<PR>(`/api/prs/${selectedPRId}`);
    },
    refetchInterval: 3000,
  });

  useEffect(() => {
    // Switching tabs changes the available repos/statuses; reset filters so a
    // stale selection doesn't leave the list looking empty.
    setSelectedRepo("all");
    setSelectedStatusFilter("all");
  }, [viewMode]);

  useEffect(() => {
    if (displayedPRs.length === 0) {
      if (selectedPRId !== null) {
        setSelectedPRId(null);
      }
      return;
    }

    if (!selectedPRId || !displayedPRs.some((pr) => pr.id === selectedPRId)) {
      setSelectedPRId(displayedPRs[0].id);
    }
  }, [displayedPRs, selectedPRId]);

  const selectedPR = selectedPRDetail ?? null;
  const selectedPRWatchEnabled = selectedPRSummary ? isPRWatchEnabled(selectedPRSummary) : true;
  const selectedFailedActivity = selectedPRSummary ? latestActivityForTarget(activities.failed, selectedPRSummary.id) : undefined;
  const selectedPRQueueStatus = selectedPRSummary ? queueStatusById.get(selectedPRSummary.id) ?? null : null;
  const selectedPRErrorMessage = selectedPRSummary?.status === "error"
    ? selectedFailedActivity?.lastError ?? getPRFeedbackFailureReason(selectedPR) ?? "Automation stopped on this PR. Check the activity log for the full failure context."
    : null;
  const activeErrorCount = activities.failed.length + activities.warnings.length;

  const applyMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/prs/${id}/apply`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/logs"] });
    },
    onError: (error) => {
      showMutationError("Could not run babysitter", error);
    },
  });

  const watchMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const res = await apiRequest("PATCH", `/api/prs/${id}/watch`, { enabled });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prs/archived"] });
      queryClient.invalidateQueries({ queryKey: ["/api/logs"] });
    },
    onError: (error) => {
      showMutationError("Could not update PR watch state", error);
    },
  });
  const syncPrMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/prs/${id}/fetch`);
      return res.json() as Promise<PR>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prs/archived"] });
      queryClient.invalidateQueries({ queryKey: ["/api/logs"] });
      toast({ description: "PR sync complete." });
    },
    onError: (error) => {
      showMutationError("Could not sync PR", error);
    },
  });

  const updateConfigMutation = useMutation({
    mutationFn: async (updates: Partial<Config>) => {
      const res = await apiRequest("PATCH", "/api/config", updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
    },
    onError: (error) => {
      showMutationError("Could not update settings", error);
    },
  });

  const clearFailedActivitiesMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/activities/failed");
      return res.json() as Promise<{ cleared: number }>;
    },
    onSuccess: ({ cleared }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      toast({ description: cleared === 1 ? "Cleared 1 failed activity." : `Cleared ${cleared} failed activities.` });
    },
    onError: (error) => {
      showMutationError("Could not clear failed activities", error);
    },
  });

  const clearIssueFailureMutation = useMutation({
    mutationFn: async (activity: ActivityItem) => {
      const issueTarget = parseIssueTargetId(activity.targetId);
      if (!issueTarget) {
        throw new Error(`Could not parse issue target ${activity.targetId}`);
      }

      const res = await apiRequest("DELETE", "/api/issues/work/failures", issueTarget);
      return res.json() as Promise<{ repo: string; number: number; id: string }>;
    },
    onSuccess: (issue) => {
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/issues"] });
      queryClient.invalidateQueries({ queryKey: ["/api/issues/detail", issue.repo, issue.number] });
      queryClient.invalidateQueries({ queryKey: ["/api/logs", issue.id] });
      toast({ description: `Cleared failed work attempts for #${issue.number}.` });
    },
    onError: (error) => {
      showMutationError("Could not clear issue failure", error);
    },
  });

  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:overflow-hidden">
      <UpdateBanner />
      <AppHeader
        active="prs"
        status={(
          <span>
            <span className="font-mono text-foreground">{prs.length}</span> PR{prs.length !== 1 ? "s" : ""} / <span className="font-mono text-foreground">{repos.length}</span> repo{repos.length !== 1 ? "s" : ""}
          </span>
        )}
        actions={(
          <>
            <label htmlFor="dashboard-coding-agent" className="text-[11px] uppercase tracking-wider text-muted-foreground">Agent</label>
            <select
              id="dashboard-coding-agent"
              value={config?.codingAgent ?? "codex"}
              onChange={(e) => {
                const newAgent = e.target.value as Config["codingAgent"];
                updateConfigMutation.mutate({
                  codingAgent: newAgent,
                });
              }}
              disabled={updateConfigMutation.isPending}
              data-testid="select-coding-agent"
              className="cursor-pointer rounded-md border border-border bg-transparent px-2 py-1 text-[11px] transition-colors focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="codex">codex</option>
              <option value="claude">claude</option>
            </select>
            {activeErrorCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  setAreErrorsRolledUp(false);
                  scrollToDashboardErrors();
                }}
                data-testid="dashboard-error-pill"
                className="inline-flex items-center gap-1 rounded-md border border-destructive/50 bg-destructive/10 px-2 py-0.5 text-[11px] uppercase tracking-wider text-destructive transition-colors hover:bg-destructive hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              >
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                errors
                <span className="font-mono">{activeErrorCount}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => { void handleSyncDashboard(); }}
              disabled={isRefreshing || globalDrainMode || isGitHubThrottled}
              title={isGitHubThrottled ? throttledTitle : undefined}
              data-testid="button-sync-dashboard"
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
            >
              {isRefreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              sync
            </button>
            <ActivityMenu
              activities={activities}
              onClearFailed={() => clearFailedActivitiesMutation.mutate()}
              isClearingFailed={clearFailedActivitiesMutation.isPending}
              globalDrainMode={globalDrainMode}
              queueStatusById={queueStatusById}
              pollIntervalMs={config?.pollIntervalMs}
            />
          </>
        )}
      />

      <OnboardingPanel />
      <OperatorWarningsBanner warnings={activities.warnings} />
      <DashboardErrorsPanel
        activities={activities}
        onClearFailed={() => clearFailedActivitiesMutation.mutate()}
        isClearingFailed={clearFailedActivitiesMutation.isPending}
        onClearIssueFailure={(activity) => clearIssueFailureMutation.mutate(activity)}
        isClearingIssueFailure={clearIssueFailureMutation.isPending}
        rolledUp={areErrorsRolledUp}
        onToggleRolledUp={() => setAreErrorsRolledUp((current) => !current)}
      />
      <DashboardDrainBanner runtimeState={runtimeState} />

      <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
        <div className="flex max-h-[42vh] w-full shrink-0 flex-col overflow-hidden border-b border-border lg:max-h-none lg:w-[42rem] lg:border-b-0 lg:border-r">
          <div className="sticky top-0 z-10 flex shrink-0 border-b border-border bg-background">
            <button
              type="button"
              onClick={() => setViewMode("active")}
              data-testid="tab-active"
              className={`flex-1 whitespace-nowrap px-2 py-2 text-[11px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset ${
                viewMode === "active"
                  ? "bg-muted text-foreground shadow-[inset_0_-2px_0_0_hsl(var(--primary))]"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Active ({prs.length})
            </button>
            <button
              type="button"
              onClick={() => setViewMode("issues")}
              data-testid="tab-on-issues"
              className={`flex-1 whitespace-nowrap px-2 py-2 text-[11px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset ${
                viewMode === "issues"
                  ? "bg-muted text-foreground shadow-[inset_0_-2px_0_0_hsl(var(--primary))]"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Issues ({issueLinkedPRs.length})
            </button>
            <button
              type="button"
              onClick={() => setViewMode("archived")}
              data-testid="tab-archived"
              className={`flex-1 whitespace-nowrap px-2 py-2 text-[11px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset ${
                viewMode === "archived"
                  ? "bg-muted text-foreground shadow-[inset_0_-2px_0_0_hsl(var(--primary))]"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Archived ({archivedPRs.length})
            </button>
          </div>
          <div className="flex flex-col gap-2 border-b border-border px-3 py-2" data-testid="pr-filter-bar">
            <div>
              <label htmlFor="pr-number-search" className="sr-only">Search PR number</label>
              <input
                id="pr-number-search"
                value={prNumberSearch}
                onChange={(event) => setPrNumberSearch(event.target.value)}
                placeholder="Search #"
                data-testid="pr-number-search"
                className="h-7 w-full rounded-md border border-border bg-background px-2 font-mono text-[12px] text-foreground placeholder:font-sans placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div className="flex flex-wrap items-start gap-2">
              <span className="mt-1 w-14 shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Repo
              </span>
              <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                <FilterChip active={selectedRepo === "all"} onClick={() => setSelectedRepo("all")}>
                  all ({viewPRs.length})
                </FilterChip>
                {repoCounts.map(([repo, count]) => (
                  <FilterChip
                    key={repo}
                    active={selectedRepo === repo}
                    onClick={() => setSelectedRepo(repo)}
                  >
                    {repo} ({count})
                  </FilterChip>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-start gap-2">
              <span className="mt-1 w-14 shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Status
              </span>
              <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                {PR_STATUS_FILTERS.map((filter) => (
                  <FilterChip
                    key={filter.value}
                    active={selectedStatusFilter === filter.value}
                    onClick={() => setSelectedStatusFilter(filter.value)}
                    testId={filter.testId}
                  >
                    {filter.label} ({statusCounts[filter.value]})
                  </FilterChip>
                ))}
                <FilterChip
                  active={selectedStatusFilter === "all"}
                  onClick={() => setSelectedStatusFilter("all")}
                >
                  all statuses
                </FilterChip>
              </div>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {isLoadingCurrentView ? (
              <div data-testid="pr-list-loading" aria-label="Loading pull requests">
                {Array.from({ length: 6 }).map((_, idx) => (
                  <PRRowSkeleton key={idx} />
                ))}
              </div>
            ) : displayedPRs.length === 0 ? (
              <div className="p-4 text-[12px] text-muted-foreground">
                {normalizedPrNumberSearch
                  ? `No PRs match #${normalizedPrNumberSearch}.`
                  : isArchived
                    ? "No archived PRs. Closed PRs are archived automatically."
                    : viewMode === "issues"
                      ? "No active PRs are linked from Issues yet."
                  : "No PRs tracked yet. Add a repository or PR from Settings."}
              </div>
            ) : (
              displayedPRs.map((pr) => (
                <PRRow
                  key={pr.id}
                  pr={pr}
                  isSelected={pr.id === selectedPRId}
                  onSelect={setSelectedPRId}
                  queueStatus={queueStatusById.get(pr.id) ?? null}
                  issueLink={issueLinkedPRByKey.get(prIssueLinkKey(pr.repo, pr.number)) ?? null}
                  failureMessage={
                    pr.status === "error"
                      ? latestActivityForTarget(activities.failed, pr.id)?.lastError ?? getPRFeedbackFailureReason(pr)
                      : null
                  }
                />
              ))
            )}
          </div>
        </div>

        <div className="flex min-h-[32rem] flex-1 flex-col overflow-hidden lg:min-h-0">
          {selectedPR ? (
            <>
              {(() => {
                const metaItems: MetaItem[] = [
                  { key: "status", content: <span>status: <span className="text-foreground">{formatStatusLabel(selectedPR.status, selectedPR.prStage)}</span></span> },
                  { key: "items", content: <span><span className="font-mono text-foreground">{selectedPR.feedbackItems.length}</span> items</span> },
                ];
                if (selectedPRQueueStatus) {
                  metaItems.push({ key: "queue", content: <QueueStatusBadge status={selectedPRQueueStatus} /> });
                }
                if (selectedPR.feedbackItems.length > 0) {
                  const counts = countActiveFeedbackStatuses(selectedPR.feedbackItems);
                  if (counts.queued > 0) metaItems.push({ key: "fb-queued", content: <span className="text-primary"><span className="font-mono">{counts.queued}</span> queued</span> });
                  if (counts.inProgress > 0) metaItems.push({ key: "fb-inprogress", content: <span className="text-primary"><span className="font-mono">{counts.inProgress}</span> in progress</span> });
                  if (counts.failed > 0) metaItems.push({ key: "fb-failed", content: <span className="text-destructive"><span className="font-mono">{counts.failed}</span> failed</span> });
                  if (counts.warning > 0) metaItems.push({ key: "fb-warning", content: <span className="text-warning-foreground"><span className="font-mono">{counts.warning}</span> warnings</span> });
                }
                if (selectedPR.testsPassed !== null) {
                  metaItems.push({ key: "tests", content: <span>tests: <span className={selectedPR.testsPassed ? "text-success" : "text-destructive"}>{selectedPR.testsPassed ? "pass" : "fail"}</span></span> });
                }
                if (selectedPR.lintPassed !== null) {
                  metaItems.push({ key: "lint", content: <span>lint: <span className={selectedPR.lintPassed ? "text-success" : "text-destructive"}>{selectedPR.lintPassed ? "pass" : "fail"}</span></span> });
                }
                if (selectedPR.lastChecked) {
                  metaItems.push({ key: "checked", content: <span>checked <span className="font-mono">{formatClock(selectedPR.lastChecked)}</span></span> });
                }
                if (selectedPR.lastSyncSucceededAt) {
                  metaItems.push({ key: "synced", content: <span>synced <span className="font-mono">{formatClock(selectedPR.lastSyncSucceededAt)}</span></span> });
                }
                if (selectedPR.lastSyncError) {
                  metaItems.push({ key: "sync-error", content: <span className="text-destructive">sync error</span> });
                }
                return (
              <DetailHeader
                title={selectedPR.title}
                accentTone="primary"
                failed={selectedPR.status === "error"}
                stageBar={<StageProgressBar stages={buildPRStages(selectedPR)} testId="pr-stage-progress" />}
                titleSuffix={(
                  <>
                    <AgentIndicator pr={selectedPR} />
                    {!selectedPRWatchEnabled && <WatchPausedIndicator />}
                    <StatusChip tone={prStatusTone(selectedPR)} pulsing={selectedPR.status === "processing"} label={formatStatusLabel(selectedPR.status, selectedPR.prStage)} />
                  </>
                )}
                externalLink={{ href: selectedPR.url, label: `${selectedPR.repo}#${selectedPR.number}` }}
                meta={<MetaBreadcrumb items={metaItems} />}
                actions={!isArchived ? (
                  <>
                    <button
                      type="button"
                      onClick={() => syncPrMutation.mutate(selectedPR.id)}
                      disabled={syncPrMutation.isPending || globalDrainMode || isGitHubThrottled}
                      title={
                        globalDrainMode
                          ? DRAIN_PAUSED_TITLE
                          : isGitHubThrottled
                            ? throttledTitle
                            : "Sync GitHub feedback now"
                      }
                      data-testid="button-sync-pr"
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-transparent px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {syncPrMutation.isPending ? (
                        <><Loader2 className="h-3.5 w-3.5 animate-spin" />Syncing</>
                      ) : (
                        <><RefreshCw className="h-3.5 w-3.5" />Sync</>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => watchMutation.mutate({ id: selectedPR.id, enabled: !selectedPRWatchEnabled })}
                      disabled={watchMutation.isPending}
                      data-testid="button-toggle-watch"
                      title={selectedPRWatchEnabled ? "Pause background watch for this PR" : "Resume background watch for this PR"}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-transparent px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {selectedPRWatchEnabled ? (
                        <><Pause className="h-3.5 w-3.5" />Pause watch</>
                      ) : (
                        <><Play className="h-3.5 w-3.5" />Resume watch</>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => applyMutation.mutate(selectedPR.id)}
                      disabled={applyMutation.isPending || selectedPR.status === "processing" || globalDrainMode || isGitHubThrottled}
                      title={
                        globalDrainMode
                          ? DRAIN_PAUSED_TITLE
                          : isGitHubThrottled
                            ? throttledTitle
                            : "Run babysitter now"
                      }
                      data-testid="button-apply"
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-primary bg-primary px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {applyMutation.isPending || selectedPR.status === "processing" ? (
                        <><Loader2 className="h-3.5 w-3.5 animate-spin" />{selectedPR.status === "processing" ? "Running" : "Queuing"}</>
                      ) : (
                        <><PlayCircle className="h-3.5 w-3.5" />{globalDrainMode ? DRAIN_PAUSED_LABEL : "Run now"}</>
                      )}
                    </button>
                  </>
                ) : undefined}
                banner={(
                  <>
                    {isPRReadyToMerge(selectedPR.feedbackItems) && (selectedPR.status === "watching" || selectedPR.status === "done") && countActiveFeedbackStatuses(selectedPR.feedbackItems).inProgress === 0 && (
                      <ReadyToMergeIndicator
                        href={selectedPR.url}
                        testId="detail-ready-to-merge"
                        label="All comments resolved — ready to merge"
                        hint="Open PR on GitHub →"
                        className="mt-2 gap-2 px-3 py-1.5 text-[12px] tracking-wider"
                        dotClassName="h-2 w-2"
                        hintClassName="text-[11px] normal-case tracking-normal text-success-foreground/75"
                      />
                    )}
                    {selectedPRErrorMessage && (
                      <div
                        className="mt-2 border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] leading-5 text-destructive"
                        data-testid="selected-pr-error"
                      >
                        <div className="text-[10px] font-medium uppercase tracking-wider">Automation error</div>
                        <div className="mt-1 whitespace-pre-wrap break-words">{selectedPRErrorMessage}</div>
                      </div>
                    )}
                    <div className="mt-2 text-[11px] text-muted-foreground">
                      {globalDrainMode
                        ? GLOBAL_DRAIN_PR_COPY
                        : selectedPRWatchEnabled
                          ? "Background watcher syncs GitHub feedback and pushes approved fixes automatically."
                          : "Background watch is paused for this PR; manual runs still work."}
                    </div>
                  </>
                )}
              />
                );
              })()}

              <HealingPanel pr={selectedPR} config={config} healingSessions={healingSessions} />
              <PRDescriptionPanel pr={selectedPR} />

          <div className="flex-1 overflow-y-auto">
                {selectedPR.feedbackItems.length === 0 ? (
                  <div className="p-4 text-[12px] text-muted-foreground">
                    {selectedPRWatchEnabled
                      ? "No feedback yet. The watcher will sync GitHub comments automatically."
                      : "No feedback yet. Background watch is paused for this PR."}
                  </div>
                ) : (
                  selectedPR.feedbackItems.map((item) => (
                    <FeedbackRow
                      key={item.id}
                      item={item}
                      prId={selectedPR.id}
                      readOnly={isArchived}
                      globalDrainMode={globalDrainMode}
                    />
                  ))
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
              Select a PR from the left panel.
            </div>
          )}
        </div>

        <RightPanel
          prId={selectedPRId}
        />
      </div>
      <div className="fixed bottom-4 right-4 z-50">
        {isAskOpen && (
          <div className="mb-2 h-[32rem] w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-border bg-background shadow-2xl">
            {selectedPRId ? (
              <QAPanel prId={selectedPRId} globalDrainMode={globalDrainMode} />
            ) : (
              <div className="flex h-full items-center justify-center p-4 text-[12px] text-muted-foreground">
                Select a PR to ask questions.
              </div>
            )}
          </div>
        )}
        <span data-testid="tab-ask" className="sr-only">Ask Agent</span>
        <button
          type="button"
          onClick={() => setIsAskOpen((current) => !current)}
          data-testid="button-ask-agent-fab"
          title={isAskOpen ? "Close Ask Agent" : "Open Ask Agent"}
          className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-primary bg-primary text-primary-foreground shadow-lg transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          <Bot className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
