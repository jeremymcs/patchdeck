import type { ReactNode } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { ActivitySnapshot, Config, RuntimeState } from "@shared/schema";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { ToastAction } from "@/components/ui/toast";
import { ThemeToggle } from "@/components/ThemeToggle";
import { toast } from "@/hooks/use-toast";
import { ACTIVITY_POLL_INTERVAL_MS, getUiPollIntervalMs } from "@/lib/polling";

type AppHeaderSection = "dashboard" | "prs" | "issues" | "releases" | "logs" | "settings";
type GitHubRateLimitState = {
  limited: boolean;
  resetAt: string | null;
  recentlyLimited: boolean;
  lastLimitedAt: string | null;
};

const PRIMARY_NAV_ITEMS: Array<{ section: AppHeaderSection; label: string; href: string }> = [
  { section: "dashboard", label: "Dashboard", href: "/" },
  { section: "issues", label: "Issues", href: "/issues" },
  { section: "prs", label: "PRs", href: "/prs" },
  { section: "releases", label: "Releases", href: "/releases" },
];

const SECONDARY_NAV_ITEMS: Array<{ section: AppHeaderSection; label: string; href: string }> = [
  { section: "logs", label: "Logs", href: "/logs" },
  { section: "settings", label: "Settings", href: "/settings" },
];

function navLinkClass(selected: boolean) {
  return `inline-flex min-h-8 items-center rounded-md border px-2 py-1 text-label uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background sm:min-h-0 ${
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
  const drainMutation = useMutation({
    mutationFn: async (input: { enabled: boolean; reason?: string }) => {
      const res = await apiRequest("POST", "/api/runtime/drain", input);
      return res.json();
    },
    onSuccess: (_data, variables) => {
      if (variables.enabled) {
        toast({
          description: "Background sync paused. New automation runs are blocked.",
          action: (
            <ToastAction
              altText="Resume background sync"
              onClick={() => drainMutation.mutate({ enabled: false })}
            >
              Undo
            </ToastAction>
          ),
        });
      } else {
        toast({ description: "Background sync resumed." });
      }
    },
    onError: (error, variables) => {
      const message = error instanceof Error ? error.message : String(error);
      toast({
        variant: "destructive",
        description: `Failed to ${variables.enabled ? "pause" : "resume"} background sync: ${message}`,
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/runtime"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
    },
  });

  const switchPending = updateConfigMutation.isPending;
  const drainPending = drainMutation.isPending;

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
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-0.5 text-label font-medium uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${chipClass}`}
        >
          <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-label font-medium uppercase tracking-wider text-muted-foreground">
            Auto mode
          </span>
          <span className={`inline-flex items-center gap-1.5 text-label font-medium uppercase tracking-wider ${drainMode ? "text-warning-foreground" : "text-muted-foreground"}`}>
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} />
            {label}
          </span>
        </div>

        {drainMode && (
          <div className="mb-3 rounded-md border border-warning-border bg-warning-muted px-2 py-1.5 text-label text-warning-foreground">
            Drain mode is active in Settings. Automation is paused regardless of these switches.
          </div>
        )}

        <div className="space-y-2">
          <div
            className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-1 py-1.5"
          >
            <label htmlFor="auto-mode-prs" className="flex min-w-0 cursor-pointer flex-col">
              <span className="text-body font-medium text-foreground">Pull requests</span>
              <span className="text-label text-muted-foreground">
                Watcher queues safe automation runs on watched PRs. Per-repo overrides live in Settings.
              </span>
            </label>
            <Switch
              id="auto-mode-prs"
              checked={autoPrs}
              disabled={switchPending || !config}
              onCheckedChange={(next) => updateConfigMutation.mutate({ autoPrs: next })}
              data-testid="auto-mode-prs-switch"
            />
          </div>

          <div
            className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-1 py-1.5"
          >
            <label htmlFor="auto-mode-issues" className="flex min-w-0 cursor-pointer flex-col">
              <span className="text-body font-medium text-foreground">Issues</span>
              <span className="text-label text-muted-foreground">
                Agent auto-evaluates and works eligible issues.
              </span>
            </label>
            <Switch
              id="auto-mode-issues"
              checked={autoIssues}
              disabled={switchPending || !config}
              onCheckedChange={(next) => updateConfigMutation.mutate({ autoIssues: next })}
              data-testid="auto-mode-issues-switch"
            />
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-2">
          <div className="min-w-0 flex-1 text-label uppercase tracking-wider text-muted-foreground">
            Background sync
          </div>
          <button
            type="button"
            onClick={() => drainMutation.mutate(
              drainMode
                ? { enabled: false }
                : { enabled: true, reason: "Paused from header auto mode menu" },
            )}
            disabled={drainPending}
            data-testid="auto-mode-drain-toggle"
            className="inline-flex min-h-[28px] items-center rounded-md border border-border px-2.5 py-1.5 text-label uppercase tracking-wider text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
          >
            {drainPending ? "…" : drainMode ? "Resume all" : "Pause all"}
          </button>
        </div>

        <Link
          href="/settings"
          className="mt-3 inline-flex text-label uppercase tracking-wider text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          Manage in settings →
        </Link>
      </PopoverContent>
    </Popover>
  );
}

function GitHubRateLimitNotice() {
  const { data: config } = useQuery<Config>({
    queryKey: ["/api/config"],
  });
  const uiPollIntervalMs = getUiPollIntervalMs(config);
  const { data: githubRateLimit } = useQuery<GitHubRateLimitState>({
    queryKey: ["/api/github-rate-limit"],
    refetchInterval: uiPollIntervalMs,
  });
  const explicitlyLimited = githubRateLimit?.limited === true;
  const recentlyLimited = githubRateLimit?.recentlyLimited === true;
  const { data: activities } = useQuery<ActivitySnapshot>({
    queryKey: ["/api/activities"],
    refetchInterval: ACTIVITY_POLL_INTERVAL_MS,
    enabled: !explicitlyLimited,
  });

  const activityRateLimitMessage = !explicitlyLimited && activities
    ? [...activities.failed, ...activities.warnings]
      .map((item) => ("lastError" in item ? item.lastError : item.message) ?? "")
      .find((message) => message.toLowerCase().includes("rate limit")) ?? null
    : null;

  if (!explicitlyLimited && !recentlyLimited && !activityRateLimitMessage) {
    return null;
  }

  const resetTime = githubRateLimit?.resetAt
    ? new Date(githubRateLimit.resetAt).toLocaleTimeString("en-US")
    : null;

  const label = explicitlyLimited
    ? resetTime
      ? `GitHub rate limited until ${resetTime}`
      : "GitHub rate limited"
    : recentlyLimited
      ? "GitHub rate limit hit recently"
    : "GitHub rate limit hit in recent activity";

  const tooltip = explicitlyLimited
    ? resetTime
      ? `GitHub rate limit active until ${resetTime}. Open settings for token configuration.`
      : "GitHub rate limit active. Open settings for token configuration."
    : activityRateLimitMessage ?? "GitHub rate limit errors detected in recent activity. Open settings for token configuration.";

  return (
    <Link
      href="/settings"
      title={tooltip}
      className="inline-flex max-w-[320px] items-center truncate whitespace-nowrap rounded-md border border-warning-border bg-warning-muted px-2.5 py-1 text-label uppercase tracking-wider text-warning-foreground transition-colors hover:border-warning hover:bg-warning-muted/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
    >
      {label}
    </Link>
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
    <header className="flex shrink-0 flex-col gap-2 border-b border-border bg-background/95 px-3 py-2.5 lg:grid lg:grid-cols-[1fr_auto_1fr] lg:items-center lg:px-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2.5 lg:justify-self-start">
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-md px-1 text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          aria-label="PatchDeck dashboard"
        >
          <PatchdeckMark />
          <span className="text-title font-semibold tracking-tight">PatchDeck</span>
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
      <div className="flex min-w-0 items-center justify-center">
        <GitHubRateLimitNotice />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-self-end lg:justify-end">
        {status ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2 border-l border-border/70 pl-2 text-label text-muted-foreground lg:border-l-0 lg:pl-0">
            {status}
          </div>
        ) : null}
        {actions ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2 [&_button]:min-h-8 [&_select]:min-h-8 sm:[&_button]:min-h-0 sm:[&_select]:min-h-0">
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
