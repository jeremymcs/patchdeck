export type StageState = "done" | "active" | "pending" | "failed";

export type Stage = {
  key: string;
  label: string;
  state: StageState;
};

export function StageProgressBar({
  stages,
  testId,
}: {
  stages: Stage[];
  testId?: string;
}) {
  if (stages.length === 0) return null;

  const doneCount = stages.filter((s) => s.state === "done").length;

  return (
    <div
      data-testid={testId}
      className="flex items-center gap-2"
      role="progressbar"
      aria-valuenow={doneCount}
      aria-valuemax={stages.length}
      aria-label={`${doneCount} of ${stages.length} stages complete`}
    >
      <div className="flex flex-1 items-center gap-1">
        {stages.map((stage) => {
          const segmentClass = (() => {
            switch (stage.state) {
              case "done":
                return "bg-primary/70";
              case "active":
                return "bg-primary animate-pulse";
              case "failed":
                return "bg-destructive";
              case "pending":
              default:
                return "bg-border";
            }
          })();

          return (
            <div
              key={stage.key}
              title={`${stage.label} — ${stage.state}`}
              data-stage={stage.key}
              data-state={stage.state}
              className={`h-1 flex-1 rounded-sm transition-colors ${segmentClass}`}
            />
          );
        })}
      </div>
      <span className="font-mono text-label uppercase tracking-wider text-muted-foreground">
        {doneCount}/{stages.length}
      </span>
    </div>
  );
}
