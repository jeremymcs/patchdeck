import type { QueueStatusView } from "@/lib/activityQueue";

export function QueueStatusBadge({ status }: { status: QueueStatusView | null }) {
  if (!status) {
    return null;
  }

  return (
    <span
      className={`inline-flex items-center gap-1 border px-1.5 py-0 text-[10px] uppercase tracking-wider ${status.className}`}
      data-testid="queue-status-badge"
    >
      <span>{status.label}</span>
      {status.detail && (
        <span className="normal-case tracking-normal opacity-80">
          {status.detail}
        </span>
      )}
    </span>
  );
}
