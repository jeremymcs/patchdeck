import { AlertTriangle, ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import type { ActivityItem, ActivitySnapshot } from "@shared/schema";

function isIssueActivityTarget(targetId: string): boolean {
  const separator = targetId.lastIndexOf("#");
  if (separator === -1) {
    return false;
  }

  const repo = targetId.slice(0, separator);
  const number = Number(targetId.slice(separator + 1));
  return Boolean(repo) && Number.isInteger(number) && number > 0;
}

export function DashboardErrorsPanel({
  activities,
  onClearFailed,
  isClearingFailed,
  onClearIssueFailure,
  isClearingIssueFailure,
  rolledUp,
  onToggleRolledUp,
}: {
  activities: ActivitySnapshot;
  onClearFailed: () => void;
  isClearingFailed: boolean;
  onClearIssueFailure: (activity: ActivityItem) => void;
  isClearingIssueFailure: boolean;
  rolledUp: boolean;
  onToggleRolledUp: () => void;
}) {
  if (activities.failed.length === 0) {
    return null;
  }

  const latestError = activities.failed[0];

  return (
    <section
      id="dashboard-errors"
      className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-4 py-3"
      data-testid="dashboard-errors-panel"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex items-center gap-2 text-body font-medium uppercase tracking-wider text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          Needs attention
          <span className="font-mono text-foreground">{activities.failed.length}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-label text-muted-foreground">
            Failed jobs stay here until retried or cleared from activity.
          </div>
          <button
            type="button"
            onClick={onClearFailed}
            disabled={isClearingFailed}
            data-testid="dashboard-clear-failed-activities"
            className="inline-flex items-center gap-1 rounded-md border border-destructive/50 px-2 py-0.5 text-label uppercase tracking-wider text-destructive transition-colors hover:bg-destructive hover:text-background disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            {isClearingFailed ? (
              "Clearing"
            ) : (
              <>
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                Clear failed
              </>
            )}
          </button>
          <button
            type="button"
            onClick={onToggleRolledUp}
            aria-expanded={!rolledUp}
            data-testid="dashboard-errors-rollup-toggle"
            className="inline-flex items-center gap-1 rounded-md border border-destructive/50 px-2 py-0.5 text-label uppercase tracking-wider text-destructive transition-colors hover:bg-destructive hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            {rolledUp ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronUp className="h-3 w-3" aria-hidden="true" />}
            {rolledUp ? "Expand" : "Roll up"}
          </button>
        </div>
      </div>
      {rolledUp ? (
        <div
          className="truncate text-label text-muted-foreground"
          data-testid="dashboard-errors-rollup-summary"
          title={latestError?.lastError ?? latestError?.detail ?? latestError?.label}
        >
          {`Latest: ${latestError.label}${latestError.detail ? ` - ${latestError.detail}` : ""}`}
        </div>
      ) : (
        <>
          <div className="grid gap-2 lg:grid-cols-2">
            {activities.failed.slice(0, 4).map((activity) => (
              <div
                key={activity.id}
                className="rounded-md border border-destructive/40 bg-background/70 px-3 py-2"
                data-testid={`dashboard-error-${activity.id}`}
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-body font-medium text-foreground">{activity.label}</div>
                    {activity.detail && (
                      <div className="mt-0.5 truncate text-label text-muted-foreground">{activity.detail}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-2">
                    {activity.kind === "work_issue" && isIssueActivityTarget(activity.targetId) && (
                      <button
                        type="button"
                        onClick={() => onClearIssueFailure(activity)}
                        disabled={isClearingIssueFailure}
                        className="inline-flex items-center gap-1 rounded-md border border-destructive/50 px-2 py-0.5 text-label uppercase tracking-wider text-destructive transition-colors hover:bg-destructive hover:text-background disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                        data-testid="dashboard-clear-issue-failure"
                      >
                        {isClearingIssueFailure ? (
                          "Clearing"
                        ) : (
                          <>
                            <Trash2 className="h-3 w-3" aria-hidden="true" />
                            Clear
                          </>
                        )}
                      </button>
                    )}
                    {activity.targetUrl && (
                      <a
                        href={activity.targetUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 rounded-md border border-destructive/50 px-2 py-0.5 text-label uppercase tracking-wider text-destructive transition-colors hover:bg-destructive hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                      >
                        Open
                      </a>
                    )}
                  </div>
                </div>
                {activity.lastError && (
                  <div
                    className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-label leading-4 text-destructive"
                    title={activity.lastError}
                  >
                    {activity.lastError}
                  </div>
                )}
              </div>
            ))}
          </div>
          {activities.failed.length > 4 && (
            <div className="mt-2 text-label text-muted-foreground">
              {activities.failed.length - 4} more failed job{activities.failed.length - 4 === 1 ? "" : "s"} in activity.
            </div>
          )}
        </>
      )}
    </section>
  );
}
