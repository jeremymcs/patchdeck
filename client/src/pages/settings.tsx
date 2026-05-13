import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { getRepoHref } from "@/lib/repoHref";
import type { Config, ReleaseRun, RuntimeState, WatchedRepo } from "@shared/schema";
import { AppHeader } from "@/components/AppHeader";
import { UpdateBanner } from "@/components/UpdateBanner";
import { toast } from "@/hooks/use-toast";
import {
  getDrainActionLabel,
  getDrainStatusView,
} from "@/lib/runtimeDisplay";

const WATCH_SCOPE_OPTIONS = [
  { value: "mine", label: "My PRs only" },
  { value: "team", label: "My PRs + teammates" },
] as const;

const ISSUE_WORK_MODE_OPTIONS = [
  { value: "manual", label: "Manual" },
  { value: "auto", label: "Auto" },
] as const;

const AGENT_OPTIONS = [
  { value: "codex", label: "codex" },
  { value: "claude", label: "claude" },
] as const;

const REPO_AGENT_OPTIONS = [
  { value: "inherit", label: "Global" },
  { value: "codex", label: "codex" },
  { value: "claude", label: "claude" },
] as const;

const CODEX_MODEL_OPTIONS = [
  { value: "", label: "CLI default" },
  { value: "gpt-5.5", label: "gpt-5.5" },
  { value: "gpt-5.4", label: "gpt-5.4" },
  { value: "gpt-5.4-mini", label: "gpt-5.4-mini" },
  { value: "gpt-5.3-codex", label: "gpt-5.3-codex" },
  { value: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark" },
  { value: "gpt-5.2", label: "gpt-5.2" },
] as const;

const CLAUDE_MODEL_OPTIONS = [
  { value: "", label: "CLI default" },
  { value: "opus", label: "opus" },
  { value: "sonnet", label: "sonnet" },
] as const;

const CODEX_REASONING_OPTIONS = [
  { value: "default", label: "CLI default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
] as const;

const CLAUDE_EFFORT_OPTIONS = [
  ...CODEX_REASONING_OPTIONS,
  { value: "max", label: "Max" },
] as const;

const DRAIN_PAUSED_LABEL = "Paused";
const DRAIN_PAUSED_TITLE = "Paused by drain mode";

type WatchScope = (typeof WATCH_SCOPE_OPTIONS)[number]["value"];
type IssueWorkMode = (typeof ISSUE_WORK_MODE_OPTIONS)[number]["value"];
type RepoAgentOption = (typeof REPO_AGENT_OPTIONS)[number]["value"];

function getWatchScope(ownPrsOnly?: boolean): WatchScope {
  return ownPrsOnly === false ? "team" : "mine";
}

function getIssueWorkMode(issueAutoWork?: boolean): IssueWorkMode {
  return issueAutoWork ? "auto" : "manual";
}

function getIssueEvaluateMode(issueAutoEvaluate?: boolean): IssueWorkMode {
  return issueAutoEvaluate ? "auto" : "manual";
}

function getPrMonitorMode(prAutoMonitor?: boolean): IssueWorkMode {
  return prAutoMonitor === false ? "manual" : "auto";
}

function getRepoAgentOption(agent?: WatchedRepo["codingAgentOverride"]): RepoAgentOption {
  return agent ?? "inherit";
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function repoTestId(repo: string): string {
  return repo.replace("/", "-");
}

function SegmentControl<T extends string>({
  options,
  value,
  onChange,
  disabled,
  name,
  testIdPrefix,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  name: string;
  testIdPrefix: string;
}) {
  return (
    <div role="radiogroup" className="mt-1 flex flex-wrap gap-1">
      {options.map((option) => {
        const active = value === option.value;
        return (
          <label
            key={option.value}
            data-testid={`${testIdPrefix}-${option.value}`}
            className={`cursor-pointer rounded-md border px-2 py-1 text-[11px] font-medium transition-colors focus-within:ring-1 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background ${
              active
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary"
            } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={active}
              onChange={() => onChange(option.value)}
              disabled={disabled}
              className="sr-only"
            />
            {option.label}
          </label>
        );
      })}
    </div>
  );
}

function WatchScopeControl(props: {
  value: WatchScope;
  onChange: (value: WatchScope) => void;
  disabled?: boolean;
  name: string;
  testIdPrefix: string;
}) {
  return <SegmentControl options={WATCH_SCOPE_OPTIONS} {...props} />;
}

function IssueWorkModeControl(props: {
  value: IssueWorkMode;
  onChange: (value: IssueWorkMode) => void;
  disabled?: boolean;
  name: string;
  testIdPrefix: string;
}) {
  return <SegmentControl options={ISSUE_WORK_MODE_OPTIONS} {...props} />;
}

type SettingsTocItem = { id: string; label: string };
type SettingsTocGroup = { id: string; label: string; items: SettingsTocItem[] };

const SETTINGS_TOC: SettingsTocGroup[] = [
  {
    id: "sources",
    label: "Sources",
    items: [
      { id: "sources-add", label: "Add" },
      { id: "sources-repos", label: "Repositories" },
    ],
  },
  {
    id: "agent",
    label: "Agent",
    items: [
      { id: "agent-models", label: "Models" },
      { id: "agent-autofix", label: "Auto fixes" },
      { id: "agent-tuning", label: "Tuning" },
      { id: "agent-ci", label: "CI Healing" },
    ],
  },
  {
    id: "delivery",
    label: "Delivery",
    items: [
      { id: "delivery-releases", label: "Releases" },
      { id: "delivery-github", label: "GitHub" },
    ],
  },
  {
    id: "system",
    label: "System",
    items: [
      { id: "system-runtime", label: "Runtime" },
      { id: "system-remote", label: "Remote access" },
    ],
  },
];

function scrollToSettingsSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ block: "start" });
}

function SettingsTOC() {
  return (
    <aside className="hidden w-48 shrink-0 lg:block">
      <nav className="sticky top-6 text-[12px]" aria-label="Settings sections">
        <div className="mb-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          On this page
        </div>
        <ul className="space-y-0.5">
          {SETTINGS_TOC.flatMap((group, gi) => [
            <li key={group.id} className={gi > 0 ? "mt-2" : ""}>
              <button
                type="button"
                onClick={() => scrollToSettingsSection(group.id)}
                className="block w-full rounded px-2 py-1 text-left text-foreground transition-colors hover:bg-muted"
              >
                {group.label}
              </button>
            </li>,
            ...group.items.map((item) => (
              <li key={item.id} className="pl-3">
                <button
                  type="button"
                  onClick={() => scrollToSettingsSection(item.id)}
                  className="block w-full rounded px-2 py-1 text-left text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {item.label}
                </button>
              </li>
            )),
          ])}
        </ul>
      </nav>
    </aside>
  );
}

function SettingsGroup({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6">
      <header className="mb-5 border-b border-border pb-3">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {description ? (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </header>
      <div className="space-y-6">{children}</div>
    </section>
  );
}

function SettingsSubsection({
  id,
  title,
  description,
  action,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div id={id} className="scroll-mt-6">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

export default function Settings() {
  const { data: config } = useQuery<Config>({
    queryKey: ["/api/config"],
  });

  const [newGithubToken, setNewGithubToken] = useState("");
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [githubCommentAppNameDraft, setGithubCommentAppNameDraft] = useState("patchdeck");
  const [webUsernameDraft, setWebUsernameDraft] = useState("");
  const [webPasswordDraft, setWebPasswordDraft] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [addRepo, setAddRepo] = useState("");
  const [watchScope, setWatchScope] = useState<WatchScope>("mine");
  const githubTokens = config?.githubTokens ?? (config?.githubToken ? [config.githubToken] : []);
  const githubCommentAppName = config?.githubCommentAppName ?? "patchdeck";

  useEffect(() => {
    setGithubCommentAppNameDraft(githubCommentAppName);
  }, [githubCommentAppName]);

  useEffect(() => {
    setWebUsernameDraft(config?.webUsername ?? "");
    setWebPasswordDraft(config?.webPassword ?? "");
  }, [config?.webUsername, config?.webPassword]);

  const updateGithubTokens = (tokens: string[]) => {
    updateConfigMutation.mutate({ githubTokens: tokens });
  };
  const moveGithubToken = (fromIndex: number, toIndex: number) => {
    const next = [...githubTokens];
    const [token] = next.splice(fromIndex, 1);
    if (!token) {
      return;
    }
    next.splice(toIndex, 0, token);
    updateGithubTokens(next);
  };
  const removeGithubToken = (index: number) => {
    updateGithubTokens(githubTokens.filter((_, i) => i !== index));
  };

  const { data: runtimeState, isError: runtimeStateIsError } = useQuery<RuntimeState>({
    queryKey: ["/api/runtime"],
    refetchInterval: 5000,
  });
  const drainStatusView = getDrainStatusView(runtimeState, runtimeStateIsError);
  const globalDrainMode = runtimeState?.drainMode === true;

  const { data: repos = [] } = useQuery<WatchedRepo[]>({
    queryKey: ["/api/repos/settings"],
    refetchInterval: 5000,
  });

  const drainMutation = useMutation({
    mutationFn: async (input: { enabled: boolean; reason?: string }) => {
      const res = await apiRequest("POST", "/api/runtime/drain", input);
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/runtime"] });
      toast({
        description: variables.enabled
          ? "Automation paused. New runs are blocked; in-flight runs will finish."
          : "Automation resumed.",
      });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `Failed to update drain mode: ${error.message}` });
    },
  });

  const updateConfigMutation = useMutation({
    mutationFn: async (updates: Partial<Config>) => {
      const res = await apiRequest("PATCH", "/api/config", updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      toast({ description: "Settings saved." });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `Failed to save: ${error.message}` });
    },
  });

  const syncReposMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/repos/sync");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      toast({ description: "Repository sync queued." });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `Could not fetch repositories: ${error.message}` });
    },
  });

  const updateRepoSettingsMutation = useMutation({
    mutationFn: async (updates: { repo: string } & Partial<Omit<WatchedRepo, "repo">>) => {
      const res = await apiRequest("PATCH", "/api/repos/settings", updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      toast({ description: "Repository settings saved." });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `Could not update repository settings: ${error.message}` });
    },
  });

  const removeRepoMutation = useMutation({
    mutationFn: async ({ repo, mode }: { repo: string; mode: "soft" | "hard" }) => {
      const res = await apiRequest("DELETE", `/api/repos/settings/${encodeURIComponent(repo)}?mode=${mode}`);
      return res.json() as Promise<{ repo: string; mode: "soft" | "hard"; removedPrs: number }>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prs/archived"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      toast({
        description: result.mode === "hard"
          ? `Removed ${result.repo} and ${result.removedPrs} tracked PR${result.removedPrs === 1 ? "" : "s"}.`
          : `Stopped watching ${result.repo}.`,
      });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `Could not remove repository: ${error.message}` });
    },
  });

  const manualReleaseMutation = useMutation({
    mutationFn: async (repo: string) => {
      const res = await apiRequest("POST", "/api/repos/release", { repo });
      return res.json() as Promise<ReleaseRun>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/releases"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      toast({ description: "Release queued." });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `Could not queue release: ${error.message}` });
    },
  });

  const addMutation = useMutation({
    mutationFn: async (url: string) => {
      const res = await apiRequest("POST", "/api/prs", { url });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
      queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      setAddUrl("");
      toast({ description: "PR added." });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `Could not add PR: ${error.message}` });
    },
  });

  const addRepoMutation = useMutation({
    mutationFn: async ({ repo }: { repo: string; watchScope: WatchScope }) => {
      const res = await apiRequest("POST", "/api/repos", { repo });
      return res.json() as Promise<{ repo: string }>;
    },
    onSuccess: async (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/prs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      setAddRepo("");
      setWatchScope("mine");

      if (variables.watchScope === "team") {
        try {
          const res = await apiRequest("PATCH", "/api/repos/settings", {
            repo: data.repo,
            ownPrsOnly: false,
          });
          await res.json();
          queryClient.invalidateQueries({ queryKey: ["/api/repos/settings"] });
        } catch (error) {
          toast({
            variant: "destructive",
            description: `Repository added, but could not update tracking scope: ${error instanceof Error ? error.message : String(error)}`,
          });
          return;
        }
      }

      toast({ description: "Repository added." });
    },
    onError: (error) => {
      toast({ variant: "destructive", description: `Could not watch repository: ${error.message}` });
    },
  });

  return (
    <div className="flex min-h-screen flex-col">
      <UpdateBanner />
      <AppHeader active="settings" />

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-6xl">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-foreground">Settings</h1>
              <p className="mt-1 text-xs text-muted-foreground">
                Configure what PatchDeck watches, how the agent behaves, and how releases ship.
              </p>
            </div>
          </div>
          <div className="flex gap-8">
            <SettingsTOC />
            <div className="min-w-0 flex-1 space-y-12">
              <SettingsGroup id="sources" title="Sources" description="What PatchDeck watches.">
                <SettingsSubsection id="sources-add" title="Add" description="Add a PR or watch another repo.">
            <div className="grid gap-3 md:grid-cols-2">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (addUrl.trim()) addMutation.mutate(addUrl.trim());
                }}
                className="rounded-md border border-border p-4"
              >
                <label htmlFor="settings-add-pr" className="text-sm">Pull request</label>
                <div className="mt-2 flex gap-2">
                  <input
                    id="settings-add-pr"
                    type="text"
                    value={addUrl}
                    onChange={(e) => setAddUrl(e.target.value)}
                    placeholder="github.com/owner/repo/pull/123"
                    aria-label="GitHub pull request URL"
                    data-testid="input-add-pr"
                    className="min-w-0 flex-1 border border-border bg-transparent px-2 py-1 text-[12px] placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                  />
                  <button
                    type="submit"
                    disabled={addMutation.isPending || !addUrl.trim()}
                    data-testid="button-add-pr"
                    className="cursor-pointer rounded-md border border-primary bg-primary px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Add
                  </button>
                </div>
              </form>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const repo = addRepo.trim();
                  if (repo) {
                    addRepoMutation.mutate({ repo, watchScope });
                  }
                }}
                className="rounded-md border border-border p-4"
              >
                <label htmlFor="settings-add-repo" className="text-sm">Repository</label>
                <div className="mt-2 flex gap-2">
                  <input
                    id="settings-add-repo"
                    type="text"
                    value={addRepo}
                    onChange={(e) => setAddRepo(e.target.value)}
                    placeholder="owner/repo"
                    aria-label="Repository owner and name"
                    data-testid="input-add-repo"
                    className="min-w-0 flex-1 border border-border bg-transparent px-2 py-1 text-[12px] placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                  />
                  <button
                    type="submit"
                    disabled={addRepoMutation.isPending || !addRepo.trim()}
                    data-testid="button-add-repo"
                    className="cursor-pointer rounded-md border border-primary bg-primary px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Watch
                  </button>
                </div>
                <div className="mt-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Track automatically
                  </div>
                  <WatchScopeControl
                    value={watchScope}
                    onChange={setWatchScope}
                    disabled={addRepoMutation.isPending}
                    name="watch-scope"
                    testIdPrefix="watch-scope"
                  />
                </div>
              </form>
            </div>
                </SettingsSubsection>

                <SettingsSubsection
                  id="sources-repos"
                  title="Repositories"
                  description="Repo-level automation, issue work, and release controls."
                  action={
                    <button
                      type="button"
                      onClick={() => syncReposMutation.mutate()}
                      disabled={syncReposMutation.isPending}
                      data-testid="button-sync-repos"
                      className="cursor-pointer rounded-md border border-primary bg-primary px-3 py-1 text-xs font-medium uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {syncReposMutation.isPending ? "Fetching..." : "Fetch"}
                    </button>
                  }
                >
            {repos.length === 0 ? (
              <div className="rounded-md border border-border p-4 text-[12px] text-muted-foreground">
                No repositories being watched yet.
              </div>
            ) : (
              <div className="grid gap-3">
                {repos.map((repo) => {
                  const id = repoTestId(repo.repo);
                  const manualReleasePending = manualReleaseMutation.isPending
                    && manualReleaseMutation.variables === repo.repo;

                  return (
                    <div
                      key={repo.repo}
                      data-testid={`tracked-repo-${repo.repo.replace("/", "-")}`}
                      className="rounded-md border border-border p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <a
                            href={getRepoHref(repo.repo)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="break-all text-sm text-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                          >
                            {repo.repo}
                          </a>
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            {repo.ownPrsOnly === false ? "Tracking team PRs" : "Tracking your PRs"} · PR monitoring {repo.prAutoMonitor === false ? "manual" : "auto"} · issue evaluate {repo.issueAutoEvaluate ? "auto" : "manual"} · issue work {repo.issueAutoWork ? "auto" : "manual"}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => manualReleaseMutation.mutate(repo.repo)}
                          disabled={manualReleaseMutation.isPending || globalDrainMode}
                          title={globalDrainMode ? DRAIN_PAUSED_TITLE : "Queue manual release"}
                          data-testid={`tracked-repo-manual-release-${repo.repo.replace("/", "-")}`}
                          className="shrink-0 border border-border px-2 py-1 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-30"
                        >
                          {globalDrainMode ? DRAIN_PAUSED_LABEL : manualReleasePending ? "Releasing..." : "Release"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm(`Stop watching ${repo.repo}? Tracked PR history will stay in Patchdeck.`)) {
                              removeRepoMutation.mutate({ repo: repo.repo, mode: "soft" });
                            }
                          }}
                          disabled={removeRepoMutation.isPending}
                          title="Stop watching this repository and keep tracked PR history"
                          data-testid={`tracked-repo-soft-remove-${repo.repo.replace("/", "-")}`}
                          className="shrink-0 border border-border px-2 py-1 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-30"
                        >
                          Unwatch
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm(`Hard remove ${repo.repo}? This stops watching and removes tracked PRs for this repo from Patchdeck.`)) {
                              removeRepoMutation.mutate({ repo: repo.repo, mode: "hard" });
                            }
                          }}
                          disabled={removeRepoMutation.isPending}
                          title="Stop watching this repository and remove tracked PRs"
                          data-testid={`tracked-repo-hard-remove-${repo.repo.replace("/", "-")}`}
                          className="shrink-0 border border-destructive/60 px-2 py-1 text-xs uppercase tracking-wider text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-30"
                        >
                          Remove data
                        </button>
                      </div>
                      {config?.autoIssues === false && (
                        <div
                          data-testid={`tracked-repo-global-issues-off-${repo.repo.replace("/", "-")}`}
                          className="mt-3 border border-warning-border bg-warning-muted px-3 py-2 text-[11px] text-warning-foreground"
                        >
                          Global Issues auto is off — these per-repo issue controls are paused. Re-enable from the AUTO MODE menu.
                        </div>
                      )}
                      <div className="mt-4 grid gap-4 md:grid-cols-3">
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Track automatically
                          </div>
                          <WatchScopeControl
                            value={getWatchScope(repo.ownPrsOnly)}
                            onChange={(value) =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                ownPrsOnly: value === "mine",
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending}
                            name={`tracked-repo-scope-${repo.repo}`}
                            testIdPrefix={`tracked-repo-scope-${repo.repo.replace("/", "-")}`}
                          />
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            PR monitoring
                          </div>
                          <IssueWorkModeControl
                            value={getPrMonitorMode(repo.prAutoMonitor)}
                            onChange={(value) =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                prAutoMonitor: value === "auto",
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending}
                            name={`tracked-repo-pr-monitor-${repo.repo}`}
                            testIdPrefix={`tracked-repo-pr-monitor-${repo.repo.replace("/", "-")}`}
                          />
                          <div className="mt-1 text-[10px] text-muted-foreground">
                            Manual still syncs PR status; skips auto babysit.
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Issue auto-evaluate
                          </div>
                          <IssueWorkModeControl
                            value={getIssueEvaluateMode(repo.issueAutoEvaluate)}
                            onChange={(value) =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                issueAutoEvaluate: value === "auto",
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending || repo.issueAutoWork}
                            name={`tracked-repo-issue-evaluate-mode-${repo.repo}`}
                            testIdPrefix={`tracked-repo-issue-evaluate-mode-${repo.repo.replace("/", "-")}`}
                          />
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Issue work mode
                          </div>
                          <IssueWorkModeControl
                            value={getIssueWorkMode(repo.issueAutoWork)}
                            onChange={(value) =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                issueAutoWork: value === "auto",
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending}
                            name={`tracked-repo-issue-work-mode-${repo.repo}`}
                            testIdPrefix={`tracked-repo-issue-work-mode-${repo.repo.replace("/", "-")}`}
                          />
                          <div className="mt-1 text-[10px] text-muted-foreground">
                            Auto-work also enables auto-evaluate.
                          </div>
                        </div>
                        <label className="flex items-end gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={repo.autoCreateReleases}
                            onChange={(e) =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                autoCreateReleases: e.target.checked,
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending}
                            data-testid={`tracked-repo-auto-release-${id}`}
                            className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                          />
                          Auto-release
                        </label>
                      </div>
                      <div className="mt-4 grid gap-3 border-t border-border pt-4 md:grid-cols-5">
                        <div className="grid gap-2">
                          <label htmlFor={`tracked-repo-agent-${id}`} className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Agent
                          </label>
                          <select
                            id={`tracked-repo-agent-${id}`}
                            value={getRepoAgentOption(repo.codingAgentOverride)}
                            onChange={(e) =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                codingAgentOverride: e.target.value === "inherit"
                                  ? null
                                  : e.target.value as WatchedRepo["codingAgentOverride"],
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending}
                            className="border border-border bg-transparent px-2 py-1 text-xs focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                          >
                            {REPO_AGENT_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </div>
                        <div className="grid gap-2">
                          <label htmlFor={`tracked-repo-codex-model-${id}`} className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Codex model
                          </label>
                          <select
                            id={`tracked-repo-codex-model-${id}`}
                            value={repo.codexModel ?? ""}
                            onChange={(e) =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                codexModel: emptyToNull(e.target.value),
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending}
                            className="border border-border bg-transparent px-2 py-1 text-xs focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                          >
                            <option value="">Global</option>
                            {CODEX_MODEL_OPTIONS.filter((option) => option.value !== "").map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </div>
                        <div className="grid gap-2">
                          <label htmlFor={`tracked-repo-codex-reasoning-${id}`} className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Codex thinking
                          </label>
                          <select
                            id={`tracked-repo-codex-reasoning-${id}`}
                            value={repo.codexReasoningEffort ?? ""}
                            onChange={(e) =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                codexReasoningEffort: e.target.value === ""
                                  ? null
                                  : e.target.value as WatchedRepo["codexReasoningEffort"],
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending}
                            className="border border-border bg-transparent px-2 py-1 text-xs focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                          >
                            <option value="">Global</option>
                            {CODEX_REASONING_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </div>
                        <div className="grid gap-2">
                          <label htmlFor={`tracked-repo-claude-model-${id}`} className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Claude model
                          </label>
                          <select
                            id={`tracked-repo-claude-model-${id}`}
                            value={repo.claudeModel ?? ""}
                            onChange={(e) =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                claudeModel: emptyToNull(e.target.value),
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending}
                            className="border border-border bg-transparent px-2 py-1 text-xs focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                          >
                            <option value="">Global</option>
                            {CLAUDE_MODEL_OPTIONS.filter((option) => option.value !== "").map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </div>
                        <div className="grid gap-2">
                          <label htmlFor={`tracked-repo-claude-effort-${id}`} className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Claude thinking
                          </label>
                          <select
                            id={`tracked-repo-claude-effort-${id}`}
                            value={repo.claudeEffort ?? ""}
                            onChange={(e) =>
                              updateRepoSettingsMutation.mutate({
                                repo: repo.repo,
                                claudeEffort: e.target.value === ""
                                  ? null
                                  : e.target.value as WatchedRepo["claudeEffort"],
                              })
                            }
                            disabled={updateRepoSettingsMutation.isPending}
                            className="border border-border bg-transparent px-2 py-1 text-xs focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                          >
                            <option value="">Global</option>
                            {CLAUDE_EFFORT_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
                </SettingsSubsection>
              </SettingsGroup>

              <SettingsGroup id="agent" title="Agent" description="How the agent runs across watched work.">
                <SettingsSubsection id="agent-models" title="Models">
            <div className="flex flex-col gap-4 rounded-md border border-border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <label htmlFor="settings-coding-agent" className="text-sm">Coding Agent</label>
                  <div className="text-[11px] text-muted-foreground">
                    CLI agent used to apply fixes
                  </div>
                </div>
                <select
                  id="settings-coding-agent"
                  value={config?.codingAgent ?? "codex"}
                  onChange={(e) => {
                    const newAgent = e.target.value as Config["codingAgent"];
                    updateConfigMutation.mutate({ codingAgent: newAgent });
                  }}
                  disabled={updateConfigMutation.isPending}
                  className="border border-border bg-transparent px-2 py-1 text-sm focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                >
                  {AGENT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="grid gap-2">
                  <label htmlFor="settings-codex-model" className="text-xs uppercase tracking-wider text-muted-foreground">
                    Codex model
                  </label>
                  <select
                    id="settings-codex-model"
                    value={config?.codexModel ?? ""}
                    onChange={(e) => updateConfigMutation.mutate({ codexModel: e.target.value })}
                    disabled={updateConfigMutation.isPending}
                    className="border border-border bg-transparent px-2 py-1 text-sm focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                  >
                    {CODEX_MODEL_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <label htmlFor="settings-codex-reasoning" className="text-xs uppercase tracking-wider text-muted-foreground">
                    Codex thinking
                  </label>
                  <select
                    id="settings-codex-reasoning"
                    value={config?.codexReasoningEffort ?? "default"}
                    onChange={(e) => updateConfigMutation.mutate({ codexReasoningEffort: e.target.value as Config["codexReasoningEffort"] })}
                    disabled={updateConfigMutation.isPending}
                    className="border border-border bg-transparent px-2 py-1 text-sm focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                  >
                    {CODEX_REASONING_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <label htmlFor="settings-claude-model" className="text-xs uppercase tracking-wider text-muted-foreground">
                    Claude model
                  </label>
                  <select
                    id="settings-claude-model"
                    value={config?.claudeModel ?? "opus"}
                    onChange={(e) => updateConfigMutation.mutate({ claudeModel: e.target.value })}
                    disabled={updateConfigMutation.isPending}
                    className="border border-border bg-transparent px-2 py-1 text-sm focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                  >
                    {CLAUDE_MODEL_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2">
                  <label htmlFor="settings-claude-effort" className="text-xs uppercase tracking-wider text-muted-foreground">
                    Claude thinking
                  </label>
                  <select
                    id="settings-claude-effort"
                    value={config?.claudeEffort ?? "default"}
                    onChange={(e) => updateConfigMutation.mutate({ claudeEffort: e.target.value as Config["claudeEffort"] })}
                    disabled={updateConfigMutation.isPending}
                    className="border border-border bg-transparent px-2 py-1 text-sm focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                  >
                    {CLAUDE_EFFORT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <label className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm">Fallback to next coding agent</div>
                  <div className="text-[11px] text-muted-foreground">
                    If the configured agent cannot start or authenticate, retry the babysitter run with the other local agent.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config?.fallbackToNextCodingAgent ?? false}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      fallbackToNextCodingAgent: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  className="mt-1 h-4 w-4 accent-foreground"
                  data-testid="checkbox-fallback-to-next-coding-agent"
                />
              </label>
            </div>
                </SettingsSubsection>

                <SettingsSubsection id="agent-autofix" title="Auto fixes">
            <div className="flex flex-col gap-4 rounded-md border border-border p-4">
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <div>
                  <div className="text-sm">Auto-fix conflicts</div>
                  <div className="text-[11px] text-muted-foreground">
                    Ask the agent to fix merge conflicts when tracked PRs are not mergeable.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config?.autoResolveMergeConflicts ?? true}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      autoResolveMergeConflicts: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  data-testid="checkbox-auto-resolve-conflicts"
                  className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                />
              </label>
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <div>
                  <div className="text-sm">Auto-update docs</div>
                  <div className="text-[11px] text-muted-foreground">
                    Automatically assess whether tracked PRs need documentation updates.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config?.autoUpdateDocs ?? true}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      autoUpdateDocs: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  data-testid="checkbox-auto-update-docs"
                  className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                />
              </label>
            </div>
                </SettingsSubsection>

                <SettingsSubsection id="agent-tuning" title="Tuning">
            <div className="flex flex-col gap-4 rounded-md border border-border p-4">
              <SettingRow
                label="Max turns"
                description="Maximum agent turns per feedback item"
                value={config?.maxTurns ?? 15}
                onChange={(v) => updateConfigMutation.mutate({ maxTurns: v })}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="Poll interval (ms)"
                description="How often to check for new feedback"
                value={config?.pollIntervalMs ?? 120000}
                onChange={(v) => updateConfigMutation.mutate({ pollIntervalMs: v })}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="Batch window (ms)"
                description="Time to batch feedback before processing"
                value={config?.batchWindowMs ?? 300000}
                onChange={(v) => updateConfigMutation.mutate({ batchWindowMs: v })}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="Max changes per run"
                description="Limit on concurrent changes"
                value={config?.maxChangesPerRun ?? 20}
                onChange={(v) => updateConfigMutation.mutate({ maxChangesPerRun: v })}
                disabled={updateConfigMutation.isPending}
              />
            </div>
                </SettingsSubsection>

                <SettingsSubsection id="agent-ci" title="CI Healing">
            <div className="flex flex-col gap-4 rounded-md border border-border p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm">Automatic CI healing</div>
                  <div className="text-[11px] text-muted-foreground">
                    Classify healable CI failures and run bounded repair attempts in isolated worktrees.
                  </div>
                </div>
                <input
                  type="checkbox"
                  aria-label="Automatic CI healing"
                  checked={config?.autoHealCI ?? false}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      autoHealCI: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                />
              </div>
              <SettingRow
                label="Max healing attempts per session"
                description="Upper bound on repair attempts for a single healing session"
                value={config?.maxHealingAttemptsPerSession ?? 3}
                onChange={(v) => updateConfigMutation.mutate({ maxHealingAttemptsPerSession: v })}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="Max healing attempts per fingerprint"
                description="Cap retries for the same failure fingerprint"
                value={config?.maxHealingAttemptsPerFingerprint ?? 2}
                onChange={(v) => updateConfigMutation.mutate({ maxHealingAttemptsPerFingerprint: v })}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="Max concurrent healing runs"
                description="How many healing runs can execute at once"
                value={config?.maxConcurrentHealingRuns ?? 1}
                onChange={(v) => updateConfigMutation.mutate({ maxConcurrentHealingRuns: v })}
                disabled={updateConfigMutation.isPending}
              />
              <SettingRow
                label="Healing cooldown (ms)"
                description="Backoff before a cooldowned session can retry"
                value={config?.healingCooldownMs ?? 300000}
                onChange={(v) => updateConfigMutation.mutate({ healingCooldownMs: v })}
                disabled={updateConfigMutation.isPending}
              />
            </div>
                </SettingsSubsection>
              </SettingsGroup>

              <SettingsGroup id="delivery" title="Delivery" description="Releases and GitHub integration.">
                <SettingsSubsection id="delivery-releases" title="Releases">
            <div className="flex flex-col gap-4 rounded-md border border-border p-4">
              <label className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm">Automatic release creation</div>
                  <div className="text-[11px] text-muted-foreground">
                    Evaluate merged PRs and publish GitHub releases automatically when the agent decides they are release-worthy.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={config?.autoCreateReleases ?? false}
                  onChange={(e) => updateConfigMutation.mutate({ autoCreateReleases: e.target.checked })}
                  disabled={updateConfigMutation.isPending}
                  className="mt-1 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                  data-testid="checkbox-auto-create-releases"
                />
              </label>
            </div>
                </SettingsSubsection>

                <SettingsSubsection id="delivery-github" title="GitHub">
            <div className="flex flex-col gap-4 rounded-md border border-border p-4">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm">Tokens</div>
                    <div className="text-[11px] text-muted-foreground">
                      Tried in order before GITHUB_TOKEN and gh auth.
                    </div>
                  </div>
                  {!showTokenInput && (
                    <button
                      type="button"
                      onClick={() => setShowTokenInput(true)}
                      className="border border-border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                    >
                      add
                    </button>
                  )}
                </div>
                {githubTokens.length ? (
                  <div className="flex flex-col gap-2">
                    {githubTokens.map((token, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between gap-3 border border-border px-2 py-1.5"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-mono text-xs">{token}</div>
                          <div className="text-[10px] text-muted-foreground">
                            priority {index + 1}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => moveGithubToken(index, index - 1)}
                            disabled={index === 0 || updateConfigMutation.isPending}
                            className="border border-border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                          >
                            up
                          </button>
                          <button
                            type="button"
                            onClick={() => moveGithubToken(index, index + 1)}
                            disabled={index === githubTokens.length - 1 || updateConfigMutation.isPending}
                            className="border border-border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                          >
                            down
                          </button>
                          <button
                            type="button"
                            onClick={() => removeGithubToken(index)}
                            disabled={updateConfigMutation.isPending}
                            className="border border-border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                          >
                            remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[11px] text-muted-foreground">none configured</div>
                )}
                {showTokenInput ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      value={newGithubToken}
                      onChange={(e) => setNewGithubToken(e.target.value)}
                      placeholder="ghp_..."
                      aria-label="GitHub token"
                      className="min-w-0 flex-1 border border-border bg-transparent px-2 py-1 text-sm focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const token = newGithubToken.trim();
                        if (token) {
                          updateGithubTokens([...githubTokens, token]);
                          setNewGithubToken("");
                          setShowTokenInput(false);
                        }
                      }}
                      disabled={!newGithubToken.trim() || updateConfigMutation.isPending}
                      className="border border-border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                    >
                      add
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowTokenInput(false);
                        setNewGithubToken("");
                      }}
                      className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                    >
                      cancel
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="flex flex-col gap-2">
                <label htmlFor="settings-github-comment-app-name" className="text-sm">
                  GitHub reply signature
                </label>
                <div className="text-[11px] text-muted-foreground">
                  Replace the app name shown in public GitHub replies. Leave blank to remove it.
                </div>
                <input
                  id="settings-github-comment-app-name"
                  type="text"
                  value={githubCommentAppNameDraft}
                  placeholder="leave blank to remove"
                  onChange={(e) => setGithubCommentAppNameDraft(e.target.value)}
                  onBlur={(e) => {
                    const githubCommentAppName = e.target.value;
                    if (githubCommentAppName !== (config?.githubCommentAppName ?? "patchdeck")) {
                      updateConfigMutation.mutate({ githubCommentAppName });
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.currentTarget.blur();
                    }
                  }}
                  disabled={updateConfigMutation.isPending}
                  className="w-full border border-border bg-transparent px-2 py-1 text-sm focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm">Repository links in PR comments</div>
                  <div className="text-[11px] text-muted-foreground">
                    Link the reply signature back to the project repository in agent-authored GitHub PR comments and footers.
                  </div>
                </div>
                <input
                  type="checkbox"
                  aria-label="Repository links in PR comments"
                  checked={config?.includeRepositoryLinksInGitHubComments ?? true}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      includeRepositoryLinksInGitHubComments: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm">GitHub progress replies</div>
                  <div className="text-[11px] text-muted-foreground">
                    Post public Accepted/running/completed status replies while the babysitter works on review comments.
                  </div>
                </div>
                <input
                  type="checkbox"
                  aria-label="GitHub progress replies"
                  checked={config?.postGitHubProgressReplies ?? false}
                  onChange={(e) =>
                    updateConfigMutation.mutate({
                      postGitHubProgressReplies: e.target.checked,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  className="h-4 w-4 accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                />
              </div>

              <StringListRow
                label="Trusted reviewers"
                description="GitHub logins whose comments skip agent evaluation and are auto-accepted for fix."
                placeholder="octocat"
                values={config?.trustedReviewers ?? []}
                onChange={(next) => updateConfigMutation.mutate({ trustedReviewers: next })}
                disabled={!config || updateConfigMutation.isPending}
              />

              <StringListRow
                label="Priority issue authors"
                description="GitHub logins whose issues are evaluated and worked before the regular issue queue."
                placeholder="octocat"
                values={config?.priorityIssueAuthors ?? []}
                onChange={(next) => updateConfigMutation.mutate({ priorityIssueAuthors: next })}
                disabled={!config || updateConfigMutation.isPending}
              />

              <StringListRow
                label="Ignored bots"
                description="Bot logins whose comments and reviews are ignored."
                placeholder="dependabot[bot]"
                values={config?.ignoredBots ?? []}
                onChange={(next) => updateConfigMutation.mutate({ ignoredBots: next })}
                disabled={!config || updateConfigMutation.isPending}
              />
            </div>
                </SettingsSubsection>
              </SettingsGroup>

              <SettingsGroup id="system" title="System" description="Runtime and process-level controls.">
                <SettingsSubsection id="system-runtime" title="Runtime">
            <div className="flex flex-col gap-4 rounded-md border border-border p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm">Automation</div>
                  <div className="text-[11px] text-muted-foreground">
                    Drain mode blocks new agent runs. In-flight runs continue until they finish.
                  </div>
                  <div
                    className="mt-2 text-[11px]"
                    aria-live="polite"
                    data-testid="text-drain-status"
                  >
                    <span className={drainStatusView.className}>{drainStatusView.label}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    drainMutation.mutate(
                      runtimeState?.drainMode
                        ? { enabled: false }
                        : { enabled: true, reason: "Manually paused via web settings" },
                    )
                  }
                  disabled={!runtimeState || drainMutation.isPending}
                  data-testid="button-toggle-drain"
                  className="shrink-0 border border-border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                >
                  {getDrainActionLabel(runtimeState)}
                </button>
              </div>
              {runtimeState?.drainMode && (runtimeState.drainReason || runtimeState.drainRequestedAt) ? (
                <div className="border-l-2 border-destructive bg-muted/30 px-3 py-2 text-[11px]">
                  {runtimeState.drainReason ? (
                    <div className="text-foreground">{runtimeState.drainReason}</div>
                  ) : null}
                  {runtimeState.drainRequestedAt ? (
                    <div className="mt-1 text-muted-foreground">
                      since {new Date(runtimeState.drainRequestedAt).toLocaleString()}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
                </SettingsSubsection>

                <SettingsSubsection id="system-remote" title="Remote access">
            <div className="rounded-md border border-border p-4">
              <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
                <div>
                  <label htmlFor="settings-web-username" className="text-sm">Username</label>
                  <input
                    id="settings-web-username"
                    type="text"
                    value={webUsernameDraft}
                    onChange={(e) => setWebUsernameDraft(e.target.value)}
                    placeholder="operator"
                    aria-label="Remote access username"
                    data-testid="input-remote-access-username"
                    className="mt-2 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                  />
                </div>
                <div>
                  <label htmlFor="settings-web-password" className="text-sm">Password</label>
                  <input
                    id="settings-web-password"
                    type="password"
                    value={webPasswordDraft}
                    onChange={(e) => setWebPasswordDraft(e.target.value)}
                    placeholder="not configured"
                    aria-label="Remote access password"
                    data-testid="input-remote-access-password"
                    className="mt-2 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                  />
                </div>
                <button
                  type="button"
                  onClick={() =>
                    updateConfigMutation.mutate({
                      webUsername: webUsernameDraft,
                      webPassword: webPasswordDraft,
                    })
                  }
                  disabled={updateConfigMutation.isPending}
                  data-testid="button-save-remote-access"
                  className="cursor-pointer rounded-md border border-primary bg-primary px-3 py-1 text-xs font-medium uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Save
                </button>
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground">
                Remote network users must sign in with these credentials. Local loopback access remains open.
              </p>
            </div>
                </SettingsSubsection>
              </SettingsGroup>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StringListRow({
  label,
  description,
  placeholder,
  values,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  placeholder: string;
  values: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState("");
  const inputId = `setting-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const descriptionId = `${inputId}-description`;

  const addValue = () => {
    const trimmed = draft.trim();
    const lowered = trimmed.toLowerCase();
    if (!trimmed || values.some((v) => v.toLowerCase() === lowered)) {
      setDraft("");
      return;
    }
    onChange([...values, trimmed]);
    setDraft("");
  };

  const removeValue = (index: number) => {
    onChange(values.filter((_, i) => i !== index));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <label htmlFor={inputId} className="min-w-0 flex-1 cursor-pointer">
          <span className="block text-sm">{label}</span>
          <span id={descriptionId} className="block text-[11px] text-muted-foreground">{description}</span>
          <input
            id={inputId}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addValue();
              }
            }}
            placeholder={placeholder}
            disabled={disabled}
            aria-describedby={descriptionId}
            className="mt-2 w-full min-w-0 border border-border bg-transparent px-2 py-1 text-sm focus:border-primary focus:outline-none disabled:opacity-50"
          />
        </label>
        <button
          type="button"
          onClick={addValue}
          disabled={!draft.trim() || disabled}
          className="border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          add
        </button>
      </div>
      {values.length ? (
        <div className="flex flex-wrap gap-1.5">
          {values.map((value, index) => (
            <span
              key={value}
              className="inline-flex items-center gap-1.5 border border-border px-2 py-0.5 font-mono text-xs"
            >
              {value}
              <button
                type="button"
                onClick={() => removeValue(index)}
                disabled={disabled}
                aria-label={`Remove ${value}`}
                className="text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground">none configured</div>
      )}
    </div>
  );
}

function SettingRow({
  label,
  description,
  value,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  value: number;
  onChange: (v: number) => void;
  disabled: boolean;
}) {
  const inputId = `setting-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const descriptionId = `${inputId}-description`;

  return (
    <div className="flex items-center justify-between">
      <div>
        <label htmlFor={inputId} className="text-sm">{label}</label>
        <div id={descriptionId} className="text-[11px] text-muted-foreground">{description}</div>
      </div>
      <input
        id={inputId}
        type="number"
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (!isNaN(n)) onChange(n);
        }}
        disabled={disabled}
        aria-describedby={descriptionId}
        className="w-28 border border-border bg-transparent px-2 py-1 text-right text-sm focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
      />
    </div>
  );
}
