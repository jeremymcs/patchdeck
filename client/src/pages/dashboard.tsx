import { useMemo, type KeyboardEvent } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, GitPullRequest, ListTodo, Loader2 } from "lucide-react";
import type { ActivityItem, ActivitySnapshot, BackgroundJobKind, Config, IssueListPage, PR } from "@shared/schema";
import { fetchJson } from "@/lib/queryClient";
import { AppHeader } from "@/components/AppHeader";
import { UpdateBanner } from "@/components/UpdateBanner";
import { DetailPanel } from "@/components/detail/DetailPanel";
import { StatusChip } from "@/components/detail/StatusChip";
import { EMPTY_ACTIVITY_SNAPSHOT } from "@/components/ActivityMenu";
import { Skeleton } from "@/components/ui/skeleton";

type PRBreakdown = {
  total: number;
  watching: number;
  processing: number;
  done: number;
  error: number;
};

type RepoStats = {
  repo: string;
  prCounts: PRBreakdown;
  issueCount: number;
};

function emptyPRBreakdown(): PRBreakdown {
  return { total: 0, watching: 0, processing: 0, done: 0, error: 0 };
}

function buildPRBreakdown(prs: PR[]): PRBreakdown {
  const result = emptyPRBreakdown();
  for (const pr of prs) {
    result.total += 1;
    if (pr.status === "watching") result.watching += 1;
    else if (pr.status === "processing") result.processing += 1;
    else if (pr.status === "done") result.done += 1;
    else if (pr.status === "error") result.error += 1;
  }
  return result;
}

function activityTargetRoute(kind: BackgroundJobKind): string | null {
  switch (kind) {
    case "babysit_pr":
    case "answer_pr_question":
      return "/prs";
    case "evaluate_issue":
    case "verify_issue":
    case "work_issue":
      return "/issues";
    case "process_release_run":
      return "/releases";
    case "sync_watched_repos":
    case "heal_deployment":
    case "generate_social_changelog":
    default:
      return null;
  }
}

function ActivityRow({ item, accent, leadingIcon, timeRef }: {
  item: ActivityItem;
  accent?: "destructive" | "warning" | "neutral";
  leadingIcon?: React.ReactNode;
  timeRef?: "queuedAt" | "startedAt" | "updatedAt";
}) {
  const [, setLocation] = useLocation();
  const route = activityTargetRoute(item.kind);
  const timestamp = timeRef === "queuedAt"
    ? item.queuedAt
    : timeRef === "startedAt"
      ? (item.startedAt ?? item.updatedAt)
      : item.updatedAt;
  const errorMessage = accent === "destructive" ? item.lastError : null;

  const labelClass = accent === "destructive"
    ? "inline-flex items-center gap-1 truncate text-[12px] font-medium text-destructive"
    : "inline-flex items-center gap-1 truncate text-[12px] text-foreground";

  const handleNavigate = () => {
    if (!route) return;
    setLocation(route);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!route) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setLocation(route);
    }
  };

  const interactiveProps = route
    ? {
        role: "link" as const,
        tabIndex: 0,
        onClick: handleNavigate,
        onKeyDown: handleKeyDown,
      }
    : {};

  return (
    <div
      data-testid={`activity-row-${item.id}`}
      {...interactiveProps}
      className={`border-b border-border/60 px-3 py-2 last:border-b-0 ${
        route
          ? "cursor-pointer transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          : ""
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={labelClass}>
          {leadingIcon}
          {item.label}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">{formatRelative(timestamp)}</span>
      </div>
      {item.detail && (
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{item.detail}</div>
      )}
      {errorMessage && (
        <div
          title={errorMessage}
          className="mt-1 line-clamp-2 break-words text-[11px] leading-snug text-destructive/85"
        >
          {errorMessage}
        </div>
      )}
      {(route || item.targetUrl) && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          {route && (
            <span className="inline-flex items-center gap-1 text-primary">
              open {route === "/prs" ? "PR" : route === "/issues" ? "issue" : "page"} →
            </span>
          )}
          {item.targetUrl && (
            <a
              href={item.targetUrl}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(event) => event.stopPropagation()}
              className="inline-flex items-center gap-1 underline decoration-border underline-offset-2 hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
              GitHub
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function formatRelative(value: string | null | undefined): string {
  if (!value) return "never";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "never";
  const diffMs = Date.now() - parsed;
  if (diffMs < 60_000) return `${Math.max(1, Math.round(diffMs / 1000))}s ago`;
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.round(diffMs / 3_600_000)}h ago`;
  return `${Math.round(diffMs / 86_400_000)}d ago`;
}

function scrollToId(id: string): void {
  if (typeof document === "undefined") return;
  const target = document.getElementById(id);
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
}

function KpiCell({
  label,
  value,
  tone = "neutral",
  testId,
  scrollTo,
}: {
  label: string;
  value: number | string;
  tone?: "neutral" | "primary" | "success" | "warning" | "destructive";
  testId?: string;
  scrollTo?: string;
}) {
  const toneClass = tone === "destructive"
    ? "border-destructive/40 bg-destructive/[0.04] text-destructive"
    : tone === "warning"
      ? "border-warning-border bg-warning-muted/40 text-warning-foreground"
      : tone === "success"
        ? "border-success-border bg-success-muted/40 text-success-foreground"
        : tone === "primary"
          ? "border-primary/40 bg-primary/[0.04] text-primary"
          : "border-border bg-muted/20 text-foreground";

  const baseClass = `flex flex-col gap-1 rounded-md border px-3 py-2 ${toneClass}`;

  if (scrollTo) {
    return (
      <button
        type="button"
        data-testid={testId}
        onClick={() => scrollToId(scrollTo)}
        className={`${baseClass} text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`}
      >
        <div className="text-[10px] font-medium uppercase tracking-wider opacity-80">{label}</div>
        <div className="font-mono text-xl leading-none">{value}</div>
      </button>
    );
  }

  return (
    <div data-testid={testId} className={baseClass}>
      <div className="text-[10px] font-medium uppercase tracking-wider opacity-80">{label}</div>
      <div className="font-mono text-xl leading-none">{value}</div>
    </div>
  );
}

function RepoCard({ stats }: { stats: RepoStats }) {
  const { prCounts, issueCount, repo } = stats;
  const linkHref = `/prs`;
  return (
    <DetailPanel
      title={repo}
      testId={`dashboard-repo-${repo}`}
      chip={(
        <Link
          href={linkHref}
          className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          open →
        </Link>
      )}
    >
      <div className="space-y-2 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            <GitPullRequest className="h-3 w-3" /> PRs
          </span>
          <StatusChip tone="neutral" label={`${prCounts.total} total`} />
          {prCounts.processing > 0 && (
            <StatusChip tone="primary" pulsing label={`${prCounts.processing} processing`} />
          )}
          {prCounts.error > 0 && (
            <StatusChip tone="destructive" label={`${prCounts.error} error`} />
          )}
          {prCounts.done > 0 && (
            <StatusChip tone="success" label={`${prCounts.done} done`} />
          )}
          {prCounts.watching > 0 && (
            <StatusChip tone="neutral" label={`${prCounts.watching} watching`} />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            <ListTodo className="h-3 w-3" /> Issues
          </span>
          <StatusChip tone="neutral" label={`${issueCount} open`} />
        </div>
      </div>
    </DetailPanel>
  );
}

function DashboardActivityPanel({ activities }: { activities: ActivitySnapshot }) {
  return (
    <div className="flex flex-col gap-3">
      <div id="failed-activity" className="scroll-mt-4">
        <DetailPanel
          title="Failed"
          tone={activities.failed.length > 0 ? "destructive" : "neutral"}
          testId="dashboard-activity-failed"
          chip={<span className="font-mono text-[10px] text-muted-foreground">{activities.failed.length}</span>}
        >
          <div className="max-h-72 overflow-y-auto">
            {activities.failed.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-muted-foreground">No failures.</div>
            ) : (
              activities.failed.slice(0, 12).map((item) => (
                <ActivityRow
                  key={item.id}
                  item={item}
                  accent="destructive"
                  leadingIcon={<AlertTriangle className="h-3 w-3 text-destructive" />}
                />
              ))
            )}
          </div>
        </DetailPanel>
      </div>

      <DetailPanel
        title="In progress"
        tone={activities.inProgress.length > 0 ? "warning" : "neutral"}
        testId="dashboard-activity-in-progress"
        chip={<span className="font-mono text-[10px] text-muted-foreground">{activities.inProgress.length}</span>}
      >
        <div className="max-h-48 overflow-y-auto">
          {activities.inProgress.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-muted-foreground">No active jobs.</div>
          ) : (
            activities.inProgress.slice(0, 8).map((item) => (
              <ActivityRow
                key={item.id}
                item={item}
                leadingIcon={<Loader2 className="h-3 w-3 animate-spin text-primary" />}
                timeRef="startedAt"
              />
            ))
          )}
        </div>
      </DetailPanel>

      <DetailPanel
        title="Queued"
        testId="dashboard-activity-queued"
        chip={<span className="font-mono text-[10px] text-muted-foreground">{activities.queued.length}</span>}
      >
        <div className="max-h-48 overflow-y-auto">
          {activities.queued.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-muted-foreground">Queue is empty.</div>
          ) : (
            activities.queued.slice(0, 8).map((item) => (
              <ActivityRow key={item.id} item={item} timeRef="queuedAt" />
            ))
          )}
        </div>
      </DetailPanel>
    </div>
  );
}

export default function Dashboard() {
  const { data: config } = useQuery<Config>({ queryKey: ["/api/config"] });
  const { data: prs = [], isLoading: prsLoading } = useQuery<PR[]>({
    queryKey: ["/api/prs"],
  });
  const { data: issuesPage, isLoading: issuesLoading } = useQuery<IssueListPage>({
    queryKey: ["/api/issues", 100, 0],
    queryFn: () => fetchJson<IssueListPage>("/api/issues?limit=100&offset=0"),
  });
  const { data: activities = EMPTY_ACTIVITY_SNAPSHOT } = useQuery<ActivitySnapshot>({
    queryKey: ["/api/activities"],
  });

  const watchedRepos = config?.watchedRepos ?? [];

  const repoStats: RepoStats[] = useMemo(() => {
    const prsByRepo = new Map<string, PR[]>();
    for (const pr of prs) {
      const list = prsByRepo.get(pr.repo) ?? [];
      list.push(pr);
      prsByRepo.set(pr.repo, list);
    }
    const repoTotals = issuesPage?.repoTotals ?? {};
    return watchedRepos.map((repo) => ({
      repo,
      prCounts: buildPRBreakdown(prsByRepo.get(repo) ?? []),
      issueCount: repoTotals[repo] ?? 0,
    }));
  }, [prs, issuesPage, watchedRepos]);

  const totalPRs = prs.length;
  const totalIssues = issuesPage?.totalCount ?? 0;
  const failedPRs = prs.filter((pr) => pr.status === "error").length;
  const inProgressPRs = prs.filter((pr) => pr.status === "processing").length;
  const activeJobs = activities.inProgress.length + activities.queued.length;
  const failedJobs = activities.failed.length;
  const failedTotal = failedPRs + failedJobs;

  const isLoading = prsLoading || issuesLoading;

  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:overflow-hidden">
      <UpdateBanner />
      <AppHeader
        active="dashboard"
        status={(
          <>
            <span><span className="font-mono text-foreground">{watchedRepos.length}</span> repos</span>
            <span><span className="font-mono text-foreground">{totalPRs}</span> PRs</span>
            <span><span className="font-mono text-foreground">{totalIssues}</span> issues</span>
            {failedTotal > 0 && (
              <button
                type="button"
                onClick={() => scrollToId("failed-activity")}
                data-testid="header-failed-link"
                className="cursor-pointer rounded-md border border-destructive/40 bg-destructive/[0.06] px-1.5 py-0 text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <span className="font-mono">{failedTotal}</span> failed →
              </button>
            )}
          </>
        )}
      />

      <main className="flex-1 overflow-y-auto p-4 lg:p-6">
        <div className="space-y-4">
          <section data-testid="dashboard-kpi-strip" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <KpiCell label="Watched repos" value={watchedRepos.length} testId="kpi-repos" />
            <KpiCell label="Open PRs" value={totalPRs} testId="kpi-prs" />
            <KpiCell label="Open issues" value={totalIssues} testId="kpi-issues" />
            <KpiCell
              label="Processing"
              value={inProgressPRs}
              tone={inProgressPRs > 0 ? "primary" : "neutral"}
              testId="kpi-processing"
            />
            <KpiCell
              label="Active jobs"
              value={activeJobs}
              tone={activeJobs > 0 ? "warning" : "neutral"}
              testId="kpi-active-jobs"
            />
            <KpiCell
              label="Failed"
              value={failedTotal}
              tone={failedTotal > 0 ? "destructive" : "neutral"}
              testId="kpi-failed"
              scrollTo={failedTotal > 0 ? "failed-activity" : undefined}
            />
          </section>

          <div className="grid gap-4 lg:grid-cols-[1fr_24rem]">
            <section aria-label="Repository overview">
              <div className="border-b border-border pb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                Repositories
                {watchedRepos.length > 0 && (
                  <span className="ml-2 font-mono text-foreground/80">({watchedRepos.length})</span>
                )}
              </div>
              {isLoading ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {Array.from({ length: 4 }).map((_, idx) => (
                    <Skeleton key={idx} className="h-28 w-full" />
                  ))}
                </div>
              ) : watchedRepos.length === 0 ? (
                <div
                  data-testid="dashboard-empty-repos"
                  className="mt-3 flex flex-col items-start gap-2 rounded-md border border-dashed border-border bg-muted/10 px-4 py-6 text-[12px] text-muted-foreground"
                >
                  <AlertTriangle className="h-4 w-4 text-warning-foreground" />
                  <div>No repositories are being watched yet.</div>
                  <Link
                    href="/settings"
                    className="text-[11px] uppercase tracking-wider text-primary underline decoration-border underline-offset-2 hover:text-primary/90"
                  >
                    Add a repo in settings →
                  </Link>
                </div>
              ) : (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {repoStats.map((stats) => (
                    <RepoCard key={stats.repo} stats={stats} />
                  ))}
                </div>
              )}
            </section>

            <aside aria-label="Activity">
              <div className="border-b border-border pb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                Activity
              </div>
              <div className="mt-3">
                <DashboardActivityPanel activities={activities} />
              </div>
            </aside>
          </div>
        </div>
      </main>
    </div>
  );
}
