import type { ReactNode } from "react";

export type DetailPanelTone = "neutral" | "destructive" | "warning" | "success";

export function DetailPanel({
  title,
  chip,
  tone = "neutral",
  action,
  testId,
  children,
}: {
  title: string;
  chip?: ReactNode;
  tone?: DetailPanelTone;
  action?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  const containerClass = {
    neutral: "border-border/60 bg-muted/10",
    destructive: "border-destructive/40 bg-destructive/10",
    warning: "border-warning-border bg-warning-muted",
    success: "border-success-border bg-success-muted",
  }[tone];

  const headerStripClass = {
    neutral: "border-border/60 text-muted-foreground",
    destructive: "border-destructive/20 text-destructive/70",
    warning: "border-warning-border text-warning-foreground/80",
    success: "border-success-border text-success-foreground/80",
  }[tone];

  return (
    <div className={`mt-3 border ${containerClass}`} data-testid={testId}>
      <div className={`flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 ${headerStripClass}`}>
        <div className="text-label uppercase tracking-wider">{title}</div>
        <div className="flex items-center gap-2">
          {chip}
          {action}
        </div>
      </div>
      {children}
    </div>
  );
}
