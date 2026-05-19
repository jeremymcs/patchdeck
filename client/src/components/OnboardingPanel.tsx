import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Config, RuntimeState } from "@shared/schema";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { toast } from "@/hooks/use-toast";
import { getUiPollIntervalMs } from "@/lib/polling";

const ONBOARDING_DISMISS_KEY = "onboarding-panel-dismissed-v2";
const ONBOARDING_LAST_GITHUB_USER_KEY = "onboarding-last-github-user-v1";
const ONBOARDING_LAST_HAS_TRACKED_REPO_KEY = "onboarding-last-has-tracked-repo-v1";
const ONBOARDING_LAST_HAS_REVIEWER_KEY = "onboarding-last-has-reviewer-v1";
const REVIEW_TOOL_LABELS = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
} as const;
const REVIEW_PROVIDER_GUIDES = [
  {
    label: "Gemini Code Assist",
    href: "https://github.com/apps/gemini-code-assist",
  },
  {
    label: "OpenAI Codex",
    href: "https://developers.openai.com/codex/integrations/github",
  },
  {
    label: "Claude Code",
    href: "https://support.claude.com/en/articles/14233555-set-up-code-review-for-claude-code",
  },
  {
    label: "Cursor",
    href: "https://cursor.com/docs/integrations/github",
  },
] as const;

type OnboardingStatus = {
  githubConnected: boolean;
  githubError?: string;
  githubUser?: string;
  repos: RepoOnboardingStatus[];
};
type GitHubRateLimitState = {
  limited: boolean;
  resetAt: string | null;
  recentlyLimited: boolean;
  lastLimitedAt: string | null;
};

type CodeReviewPresence = {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
};

type RepoOnboardingStatus = {
  repo: string;
  accessible: boolean;
  error?: string;
  codeReviews: CodeReviewPresence;
};

type InstallReviewTool = "claude" | "codex";
type ReviewTool = keyof CodeReviewPresence;
type OnboardingStepId = "github" | "repo" | "workflow";

type OnboardingStep = {
  id: OnboardingStepId;
  title: string;
  description: string;
  complete: boolean;
};

function isTransientGitHubWarning(githubError?: string): boolean {
  if (!githubError) return false;
  return /rate limit gate active/i.test(githubError);
}

function hasDetectedCodeReviewWorkflow(codeReviews: CodeReviewPresence) {
  return codeReviews.claude || codeReviews.codex || codeReviews.gemini;
}

function getDetectedReviewTools(codeReviews: CodeReviewPresence): ReviewTool[] {
  return (Object.entries(codeReviews) as Array<[ReviewTool, boolean]>)
    .filter(([, present]) => present)
    .map(([tool]) => tool);
}

export function getOnboardingPanelState(status: OnboardingStatus) {
  const transientGithubWarning = isTransientGitHubWarning(status.githubError);
  const githubStepComplete = status.githubConnected || transientGithubWarning;
  const accessibleRepos = status.repos.filter((repo) => repo.accessible);
  const inaccessibleRepos = transientGithubWarning ? [] : status.repos.filter((repo) => !repo.accessible);
  const reposWithReview = accessibleRepos.filter((repo) => hasDetectedCodeReviewWorkflow(repo.codeReviews));
  const reposMissingReview = accessibleRepos.filter((repo) => !hasDetectedCodeReviewWorkflow(repo.codeReviews));
  const repoStepComplete = transientGithubWarning ? true : accessibleRepos.length > 0;
  const workflowStepComplete = transientGithubWarning ? true : reposWithReview.length > 0;

  const steps: OnboardingStep[] = [
    {
      id: "github",
      title: "Connect GitHub",
      description: githubStepComplete
        ? `Connected${status.githubUser ? ` as @${status.githubUser}` : ""}.`
        : "Connect GitHub so the app can read repositories, sync feedback, and add reviewer Actions to your repos.",
      complete: githubStepComplete,
    },
    {
      id: "repo",
      title: "Track your first repository or PR",
      description: repoStepComplete
        ? transientGithubWarning
          ? "Repository tracking preserved while GitHub checks are temporarily rate limited."
          : `Watching ${accessibleRepos.length} accessible repo${accessibleRepos.length === 1 ? "" : "s"}. Choose per repo whether to track only your PRs or your whole team.`
        : "Use the Add PR or Watch form below. Adding a PR also adds its repository to the watch list, and watched repos let you choose whether to track only your PRs or the whole team.",
      complete: repoStepComplete,
    },
    {
      id: "workflow",
      title: "Add a CI reviewer to one of your repos",
      description: workflowStepComplete
        ? transientGithubWarning
          ? "Reviewer setup preserved while GitHub checks are temporarily rate limited."
          : `Reviewer Action detected in ${reposWithReview.length} repo${reposWithReview.length === 1 ? "" : "s"}.`
        : accessibleRepos.length > 0
          ? "Drop a code-review GitHub Action into a tracked repo so review comments appear on every new PR. PatchDeck tracks the feedback and queues safe fixes."
          : "Track a repo first, then add a reviewer GitHub Action to it.",
      complete: workflowStepComplete,
    },
  ];

  const completedCount = steps.filter((step) => step.complete).length;
  const pendingSteps = steps.filter((step) => !step.complete);
  const dismissalKey = [
    ...pendingSteps.map((step) => step.id.toLowerCase()),
    ...inaccessibleRepos.map((repo) => "access:" + repo.repo.toLowerCase() + ":" + (repo.error?.slice(0, 100) ?? "").toLowerCase()),
  ].sort().join("|") || "complete";
  const hasIssues = pendingSteps.length > 0 || inaccessibleRepos.length > 0;
  const summary = pendingSteps.length > 0
    ? `${completedCount} of ${steps.length} complete`
    : `${inaccessibleRepos.length} access issue${inaccessibleRepos.length === 1 ? "" : "s"}`;

  return {
    accessibleRepos,
    hasIssues,
    inaccessibleRepos,
    reposMissingReview,
    reposWithReview,
    steps,
    pendingSteps,
    completedCount,
    dismissalKey,
    summary,
  };
}

function InlineCode({ children }: { children: string }) {
  return (
    <code className="rounded-md border border-border bg-muted/30 px-1 py-0.5 text-label font-mono">
      {children}
    </code>
  );
}

function Step({ number, children }: { number: number; children: ReactNode }) {
  return (
    <div className="flex gap-2.5">
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border border-border text-label text-muted-foreground">
        {number}
      </span>
      <div className="flex-1 text-body leading-relaxed">{children}</div>
    </div>
  );
}

function StepCard({
  step,
  index,
  children,
}: {
  step: OnboardingStep;
  index: number;
  children?: ReactNode;
}) {
  return (
    <div className={`border px-3 py-3 ${step.complete ? "border-border bg-background/60" : "border-warning-border bg-warning-muted"}`}>
      <div className="flex gap-3">
        <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border text-label ${step.complete ? "border-border text-foreground" : "border-warning-border text-warning-foreground"}`}>
          {step.complete ? "✓" : index}
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-label font-medium uppercase tracking-wider">{step.title}</span>
            <span className={`border px-1.5 py-0 text-label uppercase tracking-wider ${step.complete ? "border-border text-muted-foreground" : "border-warning-border text-warning-foreground"}`}>
              {step.complete ? "done" : "next"}
            </span>
          </div>
          <p className="text-body text-muted-foreground">{step.description}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

export function OnboardingPanel() {
  const [lastGitHubUser] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }

    return window.localStorage.getItem(ONBOARDING_LAST_GITHUB_USER_KEY);
  });
  const [lastHasTrackedRepo] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }

    return window.localStorage.getItem(ONBOARDING_LAST_HAS_TRACKED_REPO_KEY) === "1";
  });
  const [lastHasReviewer] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }

    return window.localStorage.getItem(ONBOARDING_LAST_HAS_REVIEWER_KEY) === "1";
  });
  const [dismissedKey, setDismissedKey] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }

    return window.localStorage.getItem(ONBOARDING_DISMISS_KEY);
  });
  const [expanded, setExpanded] = useState(true);

  const { data: runtimeState } = useQuery<RuntimeState>({
    queryKey: ["/api/runtime"],
    refetchInterval: 5000,
  });
  const globalDrainMode = runtimeState?.drainMode === true;
  const { data: config } = useQuery<Config>({
    queryKey: ["/api/config"],
  });
  const uiPollIntervalMs = getUiPollIntervalMs(config);
  const { data: status, isLoading } = useQuery<OnboardingStatus>({
    queryKey: ["/api/onboarding/status"],
    enabled: runtimeState !== undefined && !globalDrainMode,
    refetchInterval: globalDrainMode ? false : uiPollIntervalMs,
  });
  const { data: githubRateLimit } = useQuery<GitHubRateLimitState>({
    queryKey: ["/api/github-rate-limit"],
    refetchInterval: globalDrainMode ? false : uiPollIntervalMs,
  });

  const installWorkflowMutation = useMutation({
    mutationFn: async ({ repo, tool }: { repo: string; tool: InstallReviewTool }) => {
      const res = await apiRequest("POST", "/api/onboarding/install-review", { repo, tool });
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/status"] });
      toast({
        description: `Added ${REVIEW_TOOL_LABELS[variables.tool]} reviewer Action to ${variables.repo}.`,
      });
    },
    onError: (error) => {
      toast({
        variant: "destructive",
        description: `Could not add reviewer Action: ${error.message}`,
      });
    },
  });

  if (isLoading || !status) return null;

  const effectiveGithubError = status.githubError
    ?? ((githubRateLimit?.limited || githubRateLimit?.recentlyLimited) ? "rate limit gate active" : undefined);
  const transientGithubWarning = isTransientGitHubWarning(effectiveGithubError);
  const hasCurrentReviewer = status.repos.some((repo) => hasDetectedCodeReviewWorkflow(repo.codeReviews));
  const shouldUseCachedRepoStatus = transientGithubWarning && status.repos.length === 0 && lastHasTrackedRepo;
  const cachedRepoStatus: RepoOnboardingStatus[] = shouldUseCachedRepoStatus
    ? [{
      repo: "cached/tracked-repo",
      accessible: true,
      codeReviews: {
        claude: lastHasReviewer,
        codex: lastHasReviewer,
        gemini: false,
      },
    }]
    : [];

  const displayStatus = {
    ...status,
    githubError: effectiveGithubError,
    githubUser: status.githubUser ?? lastGitHubUser ?? undefined,
    repos: shouldUseCachedRepoStatus ? cachedRepoStatus : status.repos,
  };
  if (typeof window !== "undefined" && status.githubUser) {
    window.localStorage.setItem(ONBOARDING_LAST_GITHUB_USER_KEY, status.githubUser);
  }
  if (typeof window !== "undefined" && status.repos.length > 0) {
    window.localStorage.setItem(ONBOARDING_LAST_HAS_TRACKED_REPO_KEY, "1");
    window.localStorage.setItem(
      ONBOARDING_LAST_HAS_REVIEWER_KEY,
      hasCurrentReviewer ? "1" : "0",
    );
  }

  const {
    accessibleRepos,
    completedCount,
    dismissalKey,
    hasIssues,
    inaccessibleRepos,
    reposMissingReview,
    reposWithReview,
    steps,
    summary,
  } = getOnboardingPanelState(displayStatus);
  const preferredTool = config?.codingAgent ?? "claude";
  const installOrder: InstallReviewTool[] = preferredTool === "codex"
    ? ["codex", "claude"]
    : ["claude", "codex"];

  if (!hasIssues || dismissedKey === dismissalKey) return null;

  return (
    <div className="shrink-0 border-b border-border bg-muted/35">
      <div className="flex items-center justify-between px-4 py-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-left"
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground" />
          <span className="text-label font-medium uppercase tracking-wider">
            Getting started
          </span>
          <span className="text-label text-muted-foreground">{summary}</span>
          <span className="text-label text-muted-foreground">{expanded ? "▲" : "▼"}</span>
        </button>
        <button
          onClick={() => {
            if (typeof window !== "undefined") {
              window.localStorage.setItem(ONBOARDING_DISMISS_KEY, dismissalKey);
            }
            setDismissedKey(dismissalKey);
          }}
          className="text-label uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          dismiss
        </button>
      </div>

      {expanded && (
        <div className="border-t border-border px-4 py-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-label uppercase tracking-wider text-muted-foreground">
              Setup checklist
            </div>
            <div className="text-label text-muted-foreground">
              {completedCount} of {steps.length} complete
            </div>
          </div>

          <div className="space-y-3">
            {steps.map((step, index) => (
              <StepCard key={step.id} step={step} index={index + 1}>
                {step.id === "github" && !step.complete && (
                  <div className="space-y-2 pt-1">
                    {displayStatus.githubError && !isTransientGitHubWarning(displayStatus.githubError) && (
                      <p className="text-body text-destructive">{displayStatus.githubError}</p>
                    )}
                    <div className="space-y-1.5 text-body text-muted-foreground">
                      <Step number={1}>
                        Run <InlineCode>gh auth login</InlineCode> on this machine, set <InlineCode>GITHUB_TOKEN</InlineCode>, or add a saved token in <Link href="/settings" className="underline underline-offset-2">settings</Link>.
                      </Step>
                      <Step number={2}>
                        Prefer the built-in token list if you want the app to remember it. For fine-grained PATs, give the watched repos the GitHub permissions PatchDeck uses: Metadata read, Contents read/write if you push, Issues read/write, Pull requests read/write, and Checks read.
                      </Step>
                    </div>
                  </div>
                )}

                {step.id === "repo" && !step.complete && (
                  <div className="pt-1 text-body text-muted-foreground">
                    The left sidebar is the real entry point. Use <span className="text-foreground">Add</span> for a PR URL or <span className="text-foreground">Watch</span> for an <InlineCode>owner/repo</InlineCode> slug, then choose whether that watched repo should track only your PRs or your whole team.
                  </div>
                )}

                {step.id === "workflow" && !step.complete && accessibleRepos.length > 0 && (
                  <div className="space-y-2 pt-1">
                    <div className="space-y-2 border border-border bg-muted/40 px-3 py-2">
                      <p className="text-body text-muted-foreground">
                        These are GitHub Actions that run on every PR and post review comments. PatchDeck reads those comments, decides which need code changes, and queues safe fixes. Pick whichever review tool fits your stack.
                      </p>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-label">
                        {REVIEW_PROVIDER_GUIDES.map((provider) => (
                          <a
                            key={provider.href}
                            href={provider.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline underline-offset-2 text-foreground/80 hover:text-foreground"
                          >
                            {provider.label}
                          </a>
                        ))}
                      </div>
                    </div>
                    {reposMissingReview.map((repoStatus) => (
                      <div key={repoStatus.repo} className="flex flex-col gap-2 border border-border bg-background/50 px-3 py-2 md:flex-row md:items-center md:justify-between">
                        <div className="min-w-0">
                          <a
                            href={`https://github.com/${repoStatus.repo}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate text-label font-medium underline underline-offset-2"
                          >
                            {repoStatus.repo}
                          </a>
                          <p className="text-label text-muted-foreground">
                            No reviewer Action installed on this repo yet.
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {installOrder.map((tool) => {
                            const isPending = installWorkflowMutation.isPending
                              && installWorkflowMutation.variables?.repo === repoStatus.repo
                              && installWorkflowMutation.variables?.tool === tool;
                            return (
                            <button
                              key={`${repoStatus.repo}-${tool}`}
                              type="button"
                              onClick={() => installWorkflowMutation.mutate({ repo: repoStatus.repo, tool })}
                              disabled={installWorkflowMutation.isPending || globalDrainMode}
                              className="border border-border px-2 py-1 text-label uppercase tracking-wider transition-colors hover:bg-foreground hover:text-background disabled:opacity-40"
                            >
                              {globalDrainMode ? "Paused" : isPending ? "Adding…" : `Add ${REVIEW_TOOL_LABELS[tool]} Action`}
                            </button>
                          );
                        })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {step.id === "workflow" && step.complete && reposWithReview.length > 0 && (
                  <div className="space-y-2 pt-1">
                    <div className="space-y-2 border border-border bg-muted/40 px-3 py-2">
                      <p className="text-body text-muted-foreground">
                        These are GitHub Actions that run on every PR and post review comments. PatchDeck reads those comments, decides which need code changes, and queues safe fixes. Pick whichever review tool fits your stack.
                      </p>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-label">
                        {REVIEW_PROVIDER_GUIDES.map((provider) => (
                          <a
                            key={provider.href}
                            href={provider.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline underline-offset-2 text-foreground/80 hover:text-foreground"
                          >
                            {provider.label}
                          </a>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {reposWithReview.map((repoStatus) => {
                        const detectedTools = getDetectedReviewTools(repoStatus.codeReviews)
                          .map((tool) => REVIEW_TOOL_LABELS[tool])
                          .join(" + ");
                        return (
                          <span
                            key={repoStatus.repo}
                            className="border border-border px-2 py-0.5 text-label uppercase tracking-wider text-muted-foreground"
                          >
                            {repoStatus.repo} · {detectedTools}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
              </StepCard>
            ))}
          </div>

          {inaccessibleRepos.length > 0 && !isTransientGitHubWarning(displayStatus.githubError) && (
            <div className="space-y-3 border border-destructive/30 bg-destructive/5 px-3 py-3">
              <div className="text-label font-medium uppercase tracking-wider text-destructive">
                Repository access issues
              </div>
              <div className="space-y-2">
                {inaccessibleRepos.map((repoStatus) => (
                  <div key={repoStatus.repo} className="space-y-1">
                    <div className="text-label font-medium">
                      <a
                        href={`https://github.com/${repoStatus.repo}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline underline-offset-2"
                      >
                        {repoStatus.repo}
                      </a>
                    </div>
                    <p className="text-body text-destructive">
                      Cannot access this repository: {repoStatus.error ?? "unknown error"}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
