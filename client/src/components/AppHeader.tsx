import type { ReactNode } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Config, RuntimeState } from "@shared/schema";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { ThemeToggle } from "@/components/ThemeToggle";

type AppHeaderSection = "prs" | "issues" | "releases" | "logs" | "settings";

const PRIMARY_NAV_ITEMS: Array<{ section: AppHeaderSection; label: string; href: string }> = [
  { section: "prs", label: "PRs", href: "/" },
  { section: "issues", label: "Issues", href: "/issues" },
  { section: "releases", label: "Releases", href: "/releases" },
];

const SECONDARY_NAV_ITEMS: Array<{ section: AppHeaderSection; label: string; href: string }> = [
  { section: "logs", label: "Logs", href: "/logs" },
  { section: "settings", label: "Settings", href: "/settings" },
];

function navLinkClass(selected: boolean) {
  return `rounded-md border px-2 py-1 text-[11px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${
    selected
      ? "border-primary/40 bg-primary/10 text-primary"
      : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
  }`;
}

function PatchdeckMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-label="PatchDeck">
      {/* patch cable (drawn first so jacks render on top) */}
      <path
        d="M4 4 Q 9 8 14 9"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      {/* row 1 */}
      <circle cx="4" cy="4" r="1.5" fill="currentColor" />
      <circle cx="9" cy="4" r="1" stroke="currentColor" strokeWidth="1" />
      <circle cx="14" cy="4" r="1" stroke="currentColor" strokeWidth="1" />
      {/* row 2 */}
      <circle cx="4" cy="9" r="1" stroke="currentColor" strokeWidth="1" />
      <circle cx="9" cy="9" r="1" stroke="currentColor" strokeWidth="1" />
      <circle cx="14" cy="9" r="1.5" fill="currentColor" />
      {/* row 3 */}
      <circle cx="4" cy="14" r="1" stroke="currentColor" strokeWidth="1" />
      <circle cx="9" cy="14" r="1" stroke="currentColor" strokeWidth="1" />
      <circle cx="14" cy="14" r="1" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

type AutoModeChipState = "paused" | "auto" | "partial" | "manual";

function describeAutoModeState(state: AutoModeChipState): { label: string; chipClass: string; dotClass: string } {
  switch (state) {
    case "paused":
      return {
        label: "Paused",
        chipClass: "border-warning-border bg-warning-muted text-warning-foreground hover:border-warning",
        dotClass: "bg-warning",
      };
    case "auto":
      return {
        label: "Auto",
        chipClass: "border-success-border bg-success-muted text-success-foreground hover:border-success",
        dotClass: "bg-success animate-pulse",
      };
    case "partial":
      return {
        label: "Partial",
        chipClass: "border-warning-border bg-warning-muted/60 text-warning-foreground hover:border-warning",
        dotClass: "bg-warning",
      };
    case "manual":
      return {
        label: "Manual",
        chipClass: "border-border bg-muted text-muted-foreground hover:border-foreground/30",
        dotClass: "bg-muted-foreground",
      };
  }
}

function AutoModeButton() {
  const queryClient = useQueryClient();
  const { data: runtimeState } = useQuery<RuntimeState>({
    queryKey: ["/api/runtime"],
    refetchInterval: 3000,
  });
  const { data: config } = useQuery<Config>({
    queryKey: ["/api/config"],
  });

  const drainMode = runtimeState?.drainMode === true;
  const autoPrs = config?.autoPrs !== false;
  const autoIssues = config?.autoIssues !== false;

  const chipState: AutoModeChipState =
    drainMode ? "paused"
      : autoPrs && autoIssues ? "auto"
        : !autoPrs && !autoIssues ? "manual"
          : "partial";
  const { label, chipClass, dotClass } = describeAutoModeState(chipState);

  const updateConfigMutation = useMutation({
    mutationFn: async (updates: Partial<Config>) => {
      const res = await apiRequest("PATCH", "/api/config", updates);
      return res.json();
    },
    onMutate: async (updates) => {
      await queryClient.cancelQueries({ queryKey: ["/api/config"] });
      const previous = queryClient.getQueryData<Config>(["/api/config"]);
      if (previous) {
        queryClient.setQueryData<Config>(["/api/config"], { ...previous, ...updates });
      }
      return { previous };
    },
    onError: (_error, _updates, context) => {
      if (context?.previous) {
        queryClient.setQueryData<Config>(["/api/config"], context.previous);
      }
    },
    onSuccess: (updatedConfig) => {
      queryClient.setQueryData<Config>(["/api/config"], updatedConfig);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/config"] });
    },
  });

  const pending = updateConfigMutation.isPending;

  const tooltip = drainMode
    ? "Automation paused via drain mode. Open to see status."
    : chipState === "auto" ? "Auto mode is on for PRs and Issues."
      : chipState === "manual" ? "Auto mode is off. PRs and Issues only run on manual trigger."
        : `Auto mode is partial — ${autoPrs ? "PRs" : "Issues"} only.`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={tooltip}
          aria-label={tooltip}
          data-testid="auto-mode-indicator"
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${chipClass}`}
        >
          <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Auto mode
          </span>
          <span className={`inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider ${drainMode ? "text-warning-foreground" : "text-muted-foreground"}`}>
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} />
            {label}
          </span>
        </div>

        {drainMode && (
          <div className="mb-3 rounded-md border border-warning-border bg-warning-muted px-2 py-1.5 text-[11px] text-warning-foreground">
            Drain mode is active in Settings. Automation is paused regardless of these switches.
          </div>
        )}

        <div className="space-y-2">
          <div
            className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-1 py-1.5"
          >
            <label htmlFor="auto-mode-prs" className="flex min-w-0 cursor-pointer flex-col">
              <span className="text-[12px] font-medium text-foreground">Pull requests</span>
              <span className="text-[10px] text-muted-foreground">
                Watcher runs the babysitter on watched PRs. Per-repo overrides in Settings.
              </span>
            </label>
            <Switch
              id="auto-mode-prs"
              checked={autoPrs}
              disabled={pending || !config}
              onCheckedChange={(next) => updateConfigMutation.mutate({ autoPrs: next })}
              data-testid="auto-mode-prs-switch"
            />
          </div>

          <div
            className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-1 py-1.5"
          >
            <label htmlFor="auto-mode-issues" className="flex min-w-0 cursor-pointer flex-col">
              <span className="text-[12px] font-medium text-foreground">Issues</span>
              <span className="text-[10px] text-muted-foreground">
                Agent auto-evaluates and works eligible issues.
              </span>
            </label>
            <Switch
              id="auto-mode-issues"
              checked={autoIssues}
              disabled={pending || !config}
              onCheckedChange={(next) => updateConfigMutation.mutate({ autoIssues: next })}
              data-testid="auto-mode-issues-switch"
            />
          </div>
        </div>

        <Link
          href="/settings"
          className="mt-3 inline-flex text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          Manage in settings →
        </Link>
      </PopoverContent>
    </Popover>
  );
}

export function AppHeader({
  active,
  status,
  actions,
}: {
  active: AppHeaderSection;
  status?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 flex-col gap-2 border-b border-border bg-background/95 px-3 py-2.5 lg:flex-row lg:items-center lg:justify-between lg:px-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-md px-1 text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          aria-label="PatchDeck dashboard"
        >
          <PatchdeckMark />
          <span className="text-sm font-semibold tracking-tight">PatchDeck</span>
        </Link>
        <nav aria-label="Primary" className="flex flex-wrap items-center gap-1">
          {PRIMARY_NAV_ITEMS.map((item) => {
            const selected = active === item.section;
            return (
              <Link
                key={item.section}
                href={item.href}
                aria-current={selected ? "page" : undefined}
                className={navLinkClass(selected)}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end">
        {status ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2 border-l border-border/70 pl-2 text-[11px] text-muted-foreground lg:border-l-0 lg:pl-0">
            {status}
          </div>
        ) : null}
        {actions ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
        <nav aria-label="Secondary" className="flex flex-wrap items-center gap-1">
          {SECONDARY_NAV_ITEMS.map((item) => {
            const selected = active === item.section;
            return (
              <Link
                key={item.section}
                href={item.href}
                aria-current={selected ? "page" : undefined}
                className={navLinkClass(selected)}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <AutoModeButton />
        <ThemeToggle />
      </div>
    </header>
  );
}
