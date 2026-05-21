import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DeploymentHealingSession, DeploymentHealingState } from "@shared/schema";
import { AppHeader } from "@/components/AppHeader";
import { UpdateBanner } from "@/components/UpdateBanner";

const ACTIVE_STATES = new Set<DeploymentHealingState>(["monitoring", "failed", "fixing"]);

function formatDateTime(value: string | null) {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function stateClassName(state: DeploymentHealingState) {
  switch (state) {
    case "fix_submitted":
      return "border-success-border bg-success-muted text-success-foreground";
    case "escalated":
      return "border-destructive/40 bg-destructive/10 text-destructive";
    case "failed":
      return "border-warning-border bg-warning-muted text-warning-foreground";
    case "fixing":
      return "border-primary/40 bg-primary/10 text-primary";
    case "monitoring":
    default:
      return "border-border bg-muted/30 text-muted-foreground";
  }
}

function DeploymentSessionCard({ session }: { session: DeploymentHealingSession }) {
  return (
    <article className="rounded-md border border-border bg-background/60 p-4" data-testid="deployment-healing-session-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-body text-foreground">{session.repo}</span>
            <span className="rounded-md border border-border px-1.5 py-0.5 text-label uppercase tracking-wider text-muted-foreground">
              {session.platform}
            </span>
            <span className={`rounded-md border px-1.5 py-0.5 text-label uppercase tracking-wider ${stateClassName(session.state)}`}>
              {session.state.replace("_", " ")}
            </span>
          </div>
          <a
            href={session.triggerPrUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 block truncate text-title font-medium text-foreground hover:text-primary"
          >
            #{session.triggerPrNumber} {session.triggerPrTitle}
          </a>
        </div>
        <div className="text-right font-mono text-label text-muted-foreground">
          <div>updated {formatDateTime(session.updatedAt)}</div>
          <div>created {formatDateTime(session.createdAt)}</div>
        </div>
      </div>

      <dl className="mt-4 grid gap-3 text-body sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-label uppercase tracking-wider text-muted-foreground">Deployment</dt>
          <dd className="mt-1 font-mono text-foreground">{session.deploymentId ?? "not captured"}</dd>
        </div>
        <div>
          <dt className="text-label uppercase tracking-wider text-muted-foreground">Merge SHA</dt>
          <dd className="mt-1 truncate font-mono text-foreground" title={session.mergeSha}>{session.mergeSha}</dd>
        </div>
        <div>
          <dt className="text-label uppercase tracking-wider text-muted-foreground">Fix branch</dt>
          <dd className="mt-1 truncate font-mono text-foreground">{session.fixBranch ?? "none"}</dd>
        </div>
        <div>
          <dt className="text-label uppercase tracking-wider text-muted-foreground">Follow-up PR</dt>
          <dd className="mt-1">
            {session.fixPrUrl ? (
              <a href={session.fixPrUrl} target="_blank" rel="noreferrer" className="font-mono text-primary hover:underline">
                #{session.fixPrNumber}
              </a>
            ) : (
              <span className="text-muted-foreground">none</span>
            )}
          </dd>
        </div>
      </dl>

      {session.error && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
          {session.error}
        </div>
      )}

      {session.deploymentLog && (
        <pre className="mt-4 max-h-48 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-label text-muted-foreground">
          {session.deploymentLog}
        </pre>
      )}
    </article>
  );
}

export default function Deployments() {
  const { data: sessions = [], isLoading } = useQuery<DeploymentHealingSession[]>({
    queryKey: ["/api/deployment-healing-sessions"],
    refetchInterval: 5000,
  });
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);

  const repoList = useMemo(() => {
    return Array.from(new Set(sessions.map((session) => session.repo))).sort((a, b) => a.localeCompare(b));
  }, [sessions]);

  const filteredSessions = useMemo(() => {
    const visible = selectedRepo ? sessions.filter((session) => session.repo === selectedRepo) : sessions;
    return [...visible].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }, [selectedRepo, sessions]);

  const activeCount = sessions.filter((session) => ACTIVE_STATES.has(session.state)).length;

  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:overflow-hidden">
      <UpdateBanner />
      <AppHeader
        active="deployments"
        status={sessions.length > 0 ? (
          <span>
            <span className="font-mono text-foreground">{activeCount}</span> active / <span className="font-mono text-foreground">{sessions.length}</span> total
          </span>
        ) : null}
      />

      <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
        <aside className="flex max-h-[42vh] w-full shrink-0 flex-col overflow-hidden border-b border-border lg:max-h-none lg:w-72 lg:border-b-0 lg:border-r">
          <div className="border-b border-border px-4 py-2 text-label font-medium uppercase tracking-wider text-muted-foreground">
            Deployment sessions
          </div>
          <div className="flex-1 overflow-y-auto">
            <button
              type="button"
              onClick={() => setSelectedRepo(null)}
              className={`flex w-full items-center justify-between border-b border-border px-4 py-3 text-left text-body ${selectedRepo === null ? "bg-muted/30 text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              <span>All repositories</span>
              <span className="font-mono text-label">{sessions.length}</span>
            </button>
            {repoList.map((repo) => (
              <button
                key={repo}
                type="button"
                onClick={() => setSelectedRepo(repo)}
                className={`flex w-full items-center justify-between border-b border-border px-4 py-3 text-left text-body ${selectedRepo === repo ? "bg-muted/30 text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                <span className="truncate font-mono">{repo}</span>
                <span className="font-mono text-label">{sessions.filter((session) => session.repo === repo).length}</span>
              </button>
            ))}
          </div>
        </aside>

        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-title font-semibold tracking-tight">
              {selectedRepo ?? "All deployment healing"}
            </h2>
            <span className="font-mono text-label text-muted-foreground">
              {filteredSessions.length} session{filteredSessions.length === 1 ? "" : "s"}
            </span>
          </div>

          {isLoading && sessions.length === 0 ? (
            <div className="rounded-md border border-border px-4 py-8 text-center text-body text-muted-foreground">Loading deployment sessions…</div>
          ) : filteredSessions.length === 0 ? (
            <div className="rounded-md border border-border px-4 py-8 text-center" data-testid="deployment-healing-empty-state">
              <p className="text-body text-muted-foreground">No deployment healing sessions yet.</p>
              <p className="mt-1 text-body text-muted-foreground">
                Sessions appear after merged PRs are monitored for supported deployment failures.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {filteredSessions.map((session) => (
                <DeploymentSessionCard key={session.id} session={session} />
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
