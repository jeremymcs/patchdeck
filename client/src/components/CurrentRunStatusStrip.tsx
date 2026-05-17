import { Bot, CheckCircle2, CircleDashed, Loader2, XCircle } from "lucide-react";
import type { CurrentRunStatus } from "@shared/schema";

type CurrentRunStatusStripProps = {
  run: CurrentRunStatus | null | undefined;
  testId: string;
};

function formatRunTime(value: string | null): string | null {
  if (!value) return null;
  return new Date(value).toLocaleTimeString("en-US", { hour12: false });
}

function statusClass(status: CurrentRunStatus["status"]): string {
  if (status === "failed") return "border-destructive/40 bg-destructive/10 text-destructive";
  if (status === "completed") return "border-success/40 bg-success/10 text-success";
  if (status === "queued") return "border-primary/30 bg-primary/10 text-primary";
  return "border-primary/40 bg-primary/10 text-primary";
}

function StatusIcon({ status }: { status: CurrentRunStatus["status"] }) {
  if (status === "failed") return <XCircle className="h-3.5 w-3.5" aria-hidden="true" />;
  if (status === "completed") return <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />;
  if (status === "queued") return <CircleDashed className="h-3.5 w-3.5" aria-hidden="true" />;
  return <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />;
}

export function CurrentRunStatusStrip({ run, testId }: CurrentRunStatusStripProps) {
  if (!run) return null;

  const updatedAt = formatRunTime(run.updatedAt);
  const detail = run.lastError ?? run.detail;

  return (
    <div
      data-testid={testId}
      className={`mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border px-3 py-2 text-[11px] ${statusClass(run.status)}`}
    >
      <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider">
        <StatusIcon status={run.status} />
        {run.status}
      </span>
      <span className="font-medium text-foreground">{run.label}</span>
      {run.phase && <span className="font-mono text-muted-foreground">{run.phase}</span>}
      {run.agent && (
        <span className="inline-flex items-center gap-1 font-mono text-muted-foreground">
          <Bot className="h-3 w-3" aria-hidden="true" />
          {run.agent}
        </span>
      )}
      {updatedAt && <span className="font-mono text-muted-foreground">updated {updatedAt}</span>}
      {detail && <span className="min-w-0 flex-1 truncate text-muted-foreground">{detail}</span>}
    </div>
  );
}
