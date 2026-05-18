import { Activity as ActivityIcon } from "lucide-react";
import { Link } from "wouter";
import type { ActivityItem, ActivitySnapshot, BackgroundJobKind } from "@shared/schema";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { QueueStatusBadge } from "@/components/QueueStatusBadge";
import type { QueueStatusView } from "@/lib/activityQueue";
import { formatActivityDetail, formatActivityLabel } from "@/lib/activityDisplay";
import { getActivityTargetRoute } from "@/lib/activityTargetRoute";

export const EMPTY_ACTIVITY_SNAPSHOT: ActivitySnapshot = {
  failed: [],
  inProgress: [],
  queued: [],
  warnings: [],
  generatedAt: "",
};

export const QUEUED_DRAIN_COPY = "Queued automation is paused until drain mode is disabled.";

function formatClock(timestamp: string | null): string | null {
  if (!timestamp) {
    return null;
  }
  return new Date(timestamp).toLocaleTimeString("en-US", { hour12: false });
}

function formatPollLabel(pollIntervalMs?: number): string {
  const seconds = Math.max(1, Math.round((pollIntervalMs ?? 600000) / 1000));
  return `${seconds}s`;
}

const ACTIVITY_KIND_META: Record<BackgroundJobKind, { label: string; className: string }> = {
  evaluate_issue: { label: "issue", className: "border-sky-500/40 text-sky-400" },
  verify_issue: { label: "issue", className: "border-sky-500/40 text-sky-400" },
  work_issue: { label: "issue", className: "border-sky-500/40 text-sky-400" },
  babysit_pr: { label: "pr", className: "border-emerald-500/40 text-emerald-400" },
  answer_pr_question: { label: "pr", className: "border-emerald-500/40 text-emerald-400" },
  process_release_run: { label: "release", className: "border-border text-muted-foreground" },
  sync_watched_repos: { label: "sync", className: "border-border text-muted-foreground" },
  generate_social_changelog: { label: "changelog", className: "border-border text-muted-foreground" },
  heal_deployment: { label: "deploy", className: "border-border text-muted-foreground" },
};

function ActivityKindBadge({ kind }: { kind: BackgroundJobKind }) {
  const meta = ACTIVITY_KIND_META[kind];
  return (
    <span
      className={`shrink-0 border px-1 text-label uppercase leading-4 tracking-wider ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

function ActivityRow({ activity, queueStatus }: { activity: ActivityItem; queueStatus: QueueStatusView | null }) {
  const label = formatActivityLabel(activity.label);
  const detail = formatActivityDetail(activity.detail);
  const targetRoute = getActivityTargetRoute(activity.kind);
  const timeLabel = activity.status === "failed"
    ? formatClock(activity.updatedAt)
    : activity.status === "in_progress"
      ? formatClock(activity.startedAt) ?? formatClock(activity.updatedAt)
      : formatClock(activity.availableAt) ?? formatClock(activity.queuedAt);

  const content = (
    <div className="flex min-w-0 items-start gap-2 px-2 py-1.5 text-left">
      <span
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 ${
          activity.status === "failed"
            ? "bg-destructive"
            : activity.status === "in_progress"
              ? "animate-pulse bg-foreground"
              : "bg-muted-foreground"
        }`}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <ActivityKindBadge kind={activity.kind} />
          <span className="min-w-0 truncate text-body leading-4 text-foreground">{label}</span>
        </span>
        {detail && (
          <span className="block truncate text-label leading-4 text-muted-foreground">{detail}</span>
        )}
        <div className="mt-1">
          <QueueStatusBadge status={queueStatus} />
        </div>
        {activity.status === "failed" && activity.lastError && (
          <span
            className="block whitespace-pre-wrap break-words text-label leading-4 text-destructive"
            title={activity.lastError}
          >
            {activity.lastError}
          </span>
        )}
      </span>
      {timeLabel && (
        <span className="shrink-0 text-label leading-4 text-muted-foreground">{timeLabel}</span>
      )}
    </div>
  );

  if (targetRoute) {
    return (
      <Link
        href={targetRoute}
        className="block outline-none hover:bg-muted focus:bg-muted focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        {content}
      </Link>
    );
  }

  return <div>{content}</div>;
}

function ActivitySection({
  title,
  items,
  emptyLabel,
  queueStatusById,
}: {
  title: string;
  items: ActivityItem[];
  emptyLabel: string;
  queueStatusById: Map<string, QueueStatusView>;
}) {
  return (
    <div className="py-1">
      <div className="px-2 py-1 text-label uppercase tracking-wider text-muted-foreground">{title}</div>
      {items.length > 0 ? (
        <div className="max-h-52 overflow-y-auto">
          {items.map((activity) => (
            <ActivityRow key={activity.id} activity={activity} queueStatus={queueStatusById.get(activity.targetId) ?? null} />
          ))}
        </div>
      ) : (
        <div className="px-2 pb-2 text-label text-muted-foreground">{emptyLabel}</div>
      )}
    </div>
  );
}

export function ActivityMenu({
  activities,
  onClearFailed,
  isClearingFailed,
  globalDrainMode,
  queueStatusById,
  pollIntervalMs,
  idleReason,
}: {
  activities: ActivitySnapshot;
  onClearFailed: () => void;
  isClearingFailed: boolean;
  globalDrainMode: boolean;
  queueStatusById: Map<string, QueueStatusView>;
  pollIntervalMs?: number;
  idleReason?: string | null;
}) {
  const failedCount = activities.failed.length;
  const inProgressCount = activities.inProgress.length;
  const queuedCount = activities.queued.length;
  const totalCount = failedCount + inProgressCount + queuedCount;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex min-h-8 items-center gap-1 border border-border px-2 py-0.5 text-label text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background sm:min-h-0"
        aria-label="Open activity menu"
        data-testid="activity-menu-trigger"
      >
        <ActivityIcon className="h-3 w-3" aria-hidden="true" />
        <span>activity</span>
        <span className="text-foreground">{totalCount}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[calc(100dvh-6rem)] w-[calc(100vw-1rem)] max-w-sm overflow-y-auto p-0 sm:w-80">
        <div className="border-b border-border px-2 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-body font-medium">Activities</div>
            {failedCount > 0 && (
              <button
                type="button"
                onClick={onClearFailed}
                disabled={isClearingFailed}
                className="border border-border px-1.5 py-0.5 text-label uppercase tracking-wider text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                data-testid="clear-failed-activities"
              >
                {isClearingFailed ? "clearing" : "clear failed"}
              </button>
            )}
          </div>
          <div className="text-label text-muted-foreground">
            {failedCount} failed / {inProgressCount} in progress / {queuedCount} queued
          </div>
        </div>
        <ActivitySection
          title="Failed"
          items={activities.failed}
          emptyLabel="No failed activities."
          queueStatusById={queueStatusById}
        />
        <div className="border-t border-border" />
        <ActivitySection
          title="In progress"
          items={activities.inProgress}
          emptyLabel="No automation running right now."
          queueStatusById={queueStatusById}
        />
        <div className="border-t border-border" />
        <ActivitySection
          title="Queued"
          items={activities.queued}
          emptyLabel={idleReason ? "No work is queued." : "Queue is empty."}
          queueStatusById={queueStatusById}
        />
        {idleReason && totalCount === 0 && (
          <div
            className="border-t border-border px-2 py-2 text-label leading-4 text-warning-foreground"
            data-testid="activity-idle-reason"
          >
            {idleReason}
          </div>
        )}
        {globalDrainMode && queuedCount > 0 && (
          <div
            className="border-t border-border px-2 py-2 text-label text-muted-foreground"
            data-testid="activity-drain-note"
          >
            {QUEUED_DRAIN_COPY}
          </div>
        )}
        {pollIntervalMs !== undefined && (
          <div
            className="border-t border-border px-2 py-1.5 text-label uppercase tracking-wider text-muted-foreground"
            data-testid="activity-poll-footer"
          >
            poll <span className="font-mono text-foreground/80">{formatPollLabel(pollIntervalMs)}</span>
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
