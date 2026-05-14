import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, Loader2, Plus, RefreshCw, ShieldCheck, Trash2, Wrench, X } from "lucide-react";
import { apiRequest, fetchJson, queryClient } from "@/lib/queryClient";
import { AppHeader } from "@/components/AppHeader";
import { UpdateBanner } from "@/components/UpdateBanner";
import { toast } from "@/hooks/use-toast";
import type { ActivitySnapshot, Config, Issue, LogEntry, RuntimeState } from "@shared/schema";
import { ScrollArea } from "@/components/ui/scroll-area";
import { buildQueueStatusIndex, type QueueStatusView } from "@/lib/activityQueue";
import { QueueStatusBadge } from "@/components/QueueStatusBadge";
import { ActivityMenu, EMPTY_ACTIVITY_SNAPSHOT } from "@/components/ActivityMenu";

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

function getEvaluationBadgeClass(issue: Issue): string {
  if (issue.evaluationStatus === "approved") {
    return "border-success-border bg-success-muted text-success-foreground";
  }
  if (issue.evaluationStatus === "blocked") {
    return "border-destructive bg-destructive/10 text-destructive";
  }
  if (issue.evaluationStatus === "needs_review") {
    return "border-warning-border bg-warning-muted text-warning-foreground";
  }
  return "border-border text-muted-foreground";
}

type IssueWorkFilter = "all" | "ready" | "auto" | "needs_eval" | "review" | "failed" | "stale";

function isStaleIssue(issue: Issue): boolean {
  const updatedAt = Date.parse(issue.updatedAt);
  if (!Number.isFinite(updatedAt)) {
    return false;
  }

  return Date.now() - updatedAt > 7 * 24 * 60 * 60 * 1000;
}

function matchesIssueWorkFilter(issue: Issue, filter: IssueWorkFilter): boolean {
  if (filter === "ready") return Boolean(issue.workPrUrl);
  if (filter === "auto") return Boolean(issue.autoWorkEligible);
  if (filter === "needs_eval") return !issue.evaluationStatus;
  if (filter === "review") return issue.evaluationStatus === "blocked" || issue.evaluationStatus === "needs_review";
  if (filter === "failed") return issue.workStatus === "failed";
  if (filter === "stale") return isStaleIssue(issue);
  return true;
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
  const cls =
    issue.workStatus === "failed"
      ? "border-destructive bg-destructive/10 text-destructive"
      : issue.workStatus === "in_progress"
        ? "border-primary bg-primary/10 text-primary animate-pulse"
        : issue.workStatus === "queued"
          ? "border-primary/50 text-primary"
          : "border-border text-muted-foreground";

  return (
    <span className={`rounded-md border px-1.5 py-0 text-[10px] font-medium uppercase tracking-wider ${cls}`}>
      {issue.workStatus.replace("_", " ")}
    </span>
  );
}

function IssueRow({
  issue,
  selected,
  onSelect,
  queueStatus,
}: {
  issue: Issue;
  selected: boolean;
  onSelect: (issueId: string) => void;
  queueStatus: QueueStatusView | null;
}) {
  const showInlineStatusBadge = issue.workStatus !== "queued" && issue.workStatus !== "in_progress";
  const rowAction =
    issue.workPrUrl && issue.workPrNumber !== undefined && issue.workPrNumber !== null
      ? (
        <a
          href={issue.workPrUrl}
          target="_blank"
          rel="noreferrer noopener"
          data-testid="issue-ready-to-merge-list"
          className="mt-2 inline-flex items-center gap-1 rounded-md border border-success-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-success-foreground transition-colors hover:border-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          <ExternalLink className="h-3 w-3" />
          PR <span className="font-mono">#{issue.workPrNumber}</span>
          <span className="text-success-foreground/70">ready to merge</span>
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
    <div className={`cursor-pointer border-b border-l-2 border-border px-4 py-3 transition-colors ${selected ? "border-l-primary bg-muted" : "border-l-transparent hover:bg-muted/30"}`}>
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
            <span
              data-testid="issue-evaluation-state-list"
              title={issue.evaluationSummary ?? undefined}
              className={`border px-1.5 py-0 text-[10px] uppercase tracking-wider ${getEvaluationBadgeClass(issue)}`}
            >
              {formatEvaluationState(issue)}
            </span>
            <QueueStatusBadge status={queueStatus} />
            {issue.labels.slice(0, 3).map((label) => (
              <span key={label} className="border border-border px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                {label}
              </span>
            ))}
            {issue.labels.length > 3 && (
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                +{issue.labels.length - 3}
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

export default function Issues() {
  const { data: runtime } = useQuery<RuntimeState>({
    queryKey: ["/api/runtime"],
    refetchInterval: 5000,
  });
  const { data: activities = EMPTY_ACTIVITY_SNAPSHOT } = useQuery<ActivitySnapshot>({
    queryKey: ["/api/activities"],
    refetchInterval: 3000,
  });
  const { data: config } = useQuery<Config>({ queryKey: ["/api/config"] });
  const queueStatusById = useMemo(() => buildQueueStatusIndex(activities), [activities]);

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

  const { data: issues = [], isLoading, refetch, isFetching } = useQuery<Issue[]>({
    queryKey: ["/api/issues"],
    refetchInterval: (query) => {
      const data = query.state.data;
      return Array.isArray(data) && data.some((issue) => isActiveWorkStatus(issue.workStatus))
        ? 5000
        : false;
    },
  });

  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<string>("all");
  const [selectedWorkFilter, setSelectedWorkFilter] = useState<IssueWorkFilter>("all");
  const [issueNumberSearch, setIssueNumberSearch] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const normalizedIssueNumberSearch = normalizeNumberSearch(issueNumberSearch);
  const filteredIssues = useMemo(
    () => issues
      .filter((issue) => selectedRepo === "all" || issue.repo === selectedRepo)
      .filter((issue) => matchesIssueWorkFilter(issue, selectedWorkFilter))
      .filter((issue) => matchesNumberSearch(issue.number, issueNumberSearch)),
    [issues, selectedRepo, selectedWorkFilter, issueNumberSearch],
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
  const { data: selectedIssueDetail, refetch: refetchSelectedIssueDetail } = useQuery<Issue>({
    queryKey: ["/api/issues/detail", selectedIssueFromList?.repo ?? "", selectedIssueFromList?.number ?? 0],
    queryFn: async () => {
      if (!selectedIssueFromList) {
        throw new Error("No issue selected");
      }

      return fetchJson<Issue>(issueDetailUrl(selectedIssueFromList));
    },
    enabled: Boolean(selectedIssueFromList),
    refetchInterval: selectedIssueFromList && isActiveWorkStatus(selectedIssueFromList.workStatus) ? 5000 : false,
  });
  const selectedIssue = selectedIssueDetail ?? selectedIssueFromList;
  const selectedIssueKey = selectedIssue ? issueKey(selectedIssue) : null;
  const selectedIssueQueueStatus = selectedIssue ? queueStatusById.get(selectedIssue.id) ?? null : null;
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
  const repoCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of issues) {
      counts.set(issue.repo, (counts.get(issue.repo) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort(([left], [right]) => left.localeCompare(right));
  }, [issues]);

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
  const visibleIssues = filteredIssues;
  const readyIssueCount = issues.filter((issue) =>
    (selectedRepo === "all" || issue.repo === selectedRepo) && Boolean(issue.workPrUrl)
  ).length;
  const autoEligibleIssueCount = issues.filter((issue) =>
    (selectedRepo === "all" || issue.repo === selectedRepo) && Boolean(issue.autoWorkEligible)
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
            <button
              type="button"
              onClick={() => {
                void Promise.all([
                  refetch(),
                  selectedIssueFromList ? refetchSelectedIssueDetail() : Promise.resolve(),
                ]);
              }}
              disabled={isFetching}
              data-testid="button-refresh-issues"
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
            >
              {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              refresh
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

      <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
        <div className="flex max-h-[42vh] w-full shrink-0 flex-col overflow-hidden border-b border-border lg:max-h-none lg:w-[42rem] lg:border-b-0 lg:border-r">
          <div className="border-b border-border px-4 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            Watched issues
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
                  all ({issues.length})
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
              onClick={() => setSelectedWorkFilter("auto")}
              data-testid="issue-auto-eligible-filter"
              className={`rounded-md border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
                selectedWorkFilter === "auto"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary"
              }`}
            >
              auto eligible ({autoEligibleIssueCount})
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
          <div className="flex-1 overflow-y-auto">
            <div data-testid="issue-list">
              {isLoading ? (
                <div className="p-4 text-[12px] text-muted-foreground">Loading...</div>
              ) : visibleIssues.length === 0 ? (
                <div className="p-4 text-[12px] text-muted-foreground">
                  {normalizedIssueNumberSearch
                    ? `No issues match #${normalizedIssueNumberSearch}.`
                    : "No open issues found in watched repositories."}
                </div>
              ) : (
                repoGroups.map((group) => (
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
                      />
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {selectedIssue ? (
            <ScrollArea className="min-h-0 flex-1" data-testid="issue-detail-logs">
              <div className="border-b border-border px-4 py-3">
                <div className="mb-2 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                  <div className="min-w-0">
                    <h1 className="line-clamp-2 break-words text-[15px] font-semibold leading-snug tracking-tight">
                      {selectedIssue.title}
                    </h1>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                      <span>{selectedIssue.repo} <span className="font-mono text-foreground/80">#{selectedIssue.number}</span></span>
                      <span className="text-border" aria-hidden="true">·</span>
                      <span>author: <span className="text-foreground/80">{selectedIssue.author || "unknown"}</span></span>
                      <span className="text-border" aria-hidden="true">·</span>
                      <span>comments: <span className="font-mono text-foreground/80">{selectedIssue.comments}</span></span>
                      <span className="text-border" aria-hidden="true">·</span>
                      <span>updated <span className="font-mono">{formatDateTime(selectedIssue.updatedAt)}</span></span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <IssueStatusBadge issue={selectedIssue} />
                      <QueueStatusBadge status={selectedIssueQueueStatus} />
                      {selectedIssue.workStage && selectedIssue.workStage !== selectedIssue.workStatus && (
                        <span
                          data-testid="issue-work-stage"
                          className="border border-border px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground"
                        >
                          {formatIssueWorkStage(selectedIssue)}
                        </span>
                      )}
                      {formatIssueWorkAttempt(selectedIssue) && (
                        <span
                          data-testid="issue-work-attempt"
                          className="border border-border px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground"
                        >
                          {formatIssueWorkAttempt(selectedIssue)}
                        </span>
                      )}
                      <span
                        data-testid="issue-auto-work-state"
                        className={`border px-1.5 py-0 text-[10px] uppercase tracking-wider ${
                          selectedIssue.autoWorkEligible
                            ? "border-success-border text-success-foreground"
                            : "border-border text-muted-foreground"
                        }`}
                      >
                        {formatAutoWorkState(selectedIssue)}
                      </span>
                      <span
                        data-testid="issue-evaluation-state"
                        title={selectedIssue.evaluationSummary ?? undefined}
                        className={`border px-1.5 py-0 text-[10px] uppercase tracking-wider ${getEvaluationBadgeClass(selectedIssue)}`}
                      >
                        {formatEvaluationState(selectedIssue)}
                      </span>
                      <a
                        href={selectedIssue.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        open issue
                      </a>
                    </div>
                  </div>
                  <div className="flex shrink-0 justify-end gap-2">
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
                      disabled={workMutation.isPending || isActiveWorkStatus(selectedIssue.workStatus) || Boolean(runtime?.drainMode)}
                      title={runtime?.drainMode ? "Manual issue work is paused by drain mode" : "Work this issue"}
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
                  </div>
                </div>
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
                {selectedIssue.workStatus === "failed" && selectedIssue.lastError && (
                  <div
                    data-testid="issue-work-failed"
                    className="mt-3 border border-destructive/40 bg-destructive/10 text-[11px] text-destructive"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-destructive/20 px-3 py-2">
                      <div className="text-[10px] uppercase tracking-wider text-destructive/70">
                        Issue work failed
                      </div>
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
                    </div>
                    <div className="max-h-80 overflow-auto whitespace-pre-wrap px-3 py-2 leading-5">
                      {selectedIssue.lastError}
                    </div>
                  </div>
                )}
                <div
                  data-testid="issue-evaluation-detail"
                  className="mt-3 border border-border/60 bg-muted/10 px-3 py-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Automation gate
                    </div>
                    <span className={`border px-1.5 py-0 text-[10px] uppercase tracking-wider ${getEvaluationBadgeClass(selectedIssue)}`}>
                      {formatEvaluationState(selectedIssue)}
                    </span>
                  </div>
                  <div className="mt-2 text-[12px] leading-5 text-foreground/85">
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

              <div className="grid min-h-0 grid-rows-[auto,1fr]">
                <div className="border-b border-border px-4 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                  Recent issue work logs
                </div>
                <div>
                  {issueLogs.length === 0 ? (
                    <div className="p-4 text-[12px] text-muted-foreground">
                      No workflow logs yet.
                    </div>
                  ) : (
                    <div>
                      {issueLogs.map((entry) => (
                        <IssueLogRow key={entry.id} entry={entry} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </ScrollArea>
          ) : (
            <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
              Select an issue from the left panel.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
