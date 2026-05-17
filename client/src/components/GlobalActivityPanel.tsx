import type { ActivityItem, ActivitySnapshot } from "@shared/schema";
import { QueueStatusBadge } from "@/components/QueueStatusBadge";
import type { QueueStatusView } from "@/lib/activityQueue";
import { formatActivityDetail, formatActivityLabel } from "@/lib/activityDisplay";

function formatClock(timestamp: string | null): string | null {
  if (!timestamp) {
    return null;
  }

  return new Date(timestamp).toLocaleTimeString("en-US", { hour12: false });
}

export function GlobalActivityPanel({
  activities,
  queueStatusById,
  idleReason,
}: {
  activities: ActivitySnapshot;
  queueStatusById: Map<string, QueueStatusView>;
  idleReason?: string | null;
}) {
  const visibleActivities = [...activities.inProgress, ...activities.queued, ...activities.failed].slice(0, 5);

  return (
    <div className="shrink-0 border-b border-border px-3 py-2" data-testid="global-activity-panel">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Automation</div>
        <div className="flex shrink-0 items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <span><span className="font-mono text-foreground/80">{activities.inProgress.length}</span> running</span>
          <span><span className="font-mono text-foreground/80">{activities.queued.length}</span> queued</span>
        </div>
      </div>
      {visibleActivities.length === 0 ? (
        <div className="mt-2 text-[11px] leading-4 text-muted-foreground" data-testid="global-activity-idle-reason">
          {idleReason ?? "No automation running or queued."}
        </div>
      ) : (
        <div className="mt-2 space-y-1">
          {visibleActivities.map((activity) => (
            <GlobalActivityRow
              key={activity.id}
              activity={activity}
              queueStatus={queueStatusById.get(activity.targetId) ?? null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function GlobalActivityRow({
  activity,
  queueStatus,
}: {
  activity: ActivityItem;
  queueStatus: QueueStatusView | null;
}) {
  const label = formatActivityLabel(activity.label);
  const detail = formatActivityDetail(activity.detail);
  const statusClass = activity.status === "failed"
    ? "border-destructive/50 text-destructive"
    : activity.status === "in_progress"
      ? "border-primary/50 text-primary"
      : "border-border text-muted-foreground";
  const timeLabel = activity.status === "in_progress"
    ? formatClock(activity.startedAt) ?? formatClock(activity.updatedAt)
    : formatClock(activity.availableAt) ?? formatClock(activity.updatedAt);
  const content = (
    <div
      className="min-w-0 rounded-md border border-border/70 bg-background px-2 py-1.5"
      data-testid="global-activity-row"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${statusClass}`}>
          {activity.status === "in_progress" ? "running" : activity.status}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{label}</span>
        {timeLabel && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{timeLabel}</span>}
      </div>
      {detail && (
        <div className="mt-1 truncate text-[11px] text-muted-foreground">{detail}</div>
      )}
      <div className="mt-1">
        <QueueStatusBadge status={queueStatus} />
      </div>
      {activity.lastError && (
        <div className="mt-1 line-clamp-2 text-[11px] text-destructive">{activity.lastError}</div>
      )}
    </div>
  );

  if (activity.targetUrl) {
    return (
      <a href={activity.targetUrl} target="_blank" rel="noopener noreferrer" className="block outline-none focus-visible:ring-1 focus-visible:ring-ring">
        {content}
      </a>
    );
  }

  return content;
}
