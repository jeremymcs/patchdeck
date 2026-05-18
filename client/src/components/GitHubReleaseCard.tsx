import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { GitHubRelease } from "@shared/schema";
import { SocialPostGenerator } from "@/components/SocialPostGenerator";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function GitHubReleaseCard({
  release,
  repoSlug,
  defaultExpanded = false,
}: {
  release: GitHubRelease;
  repoSlug: string;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasBody = Boolean(release.bodyHtml?.trim() || release.body?.trim());

  return (
    <article className="rounded-md border border-border" data-testid={`github-release-${release.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0 font-mono text-label font-medium uppercase tracking-wider text-primary">
              {release.tagName || `release-${release.id}`}
            </span>
            {release.draft && (
              <span className="rounded-md border border-warning-border bg-warning-muted px-1.5 py-0 text-label font-medium uppercase tracking-wider text-warning-foreground">
                draft
              </span>
            )}
            {release.prerelease && (
              <span className="rounded-md border border-warning-border bg-warning-muted px-1.5 py-0 text-label font-medium uppercase tracking-wider text-warning-foreground">
                pre-release
              </span>
            )}
            <span className="truncate text-title font-semibold tracking-tight">
              {release.name || release.tagName}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-label text-muted-foreground">
            <span className="font-mono text-foreground/80">{repoSlug}</span>
            <span className="text-border" aria-hidden="true">·</span>
            <span>
              published <span className="font-mono">{formatDate(release.publishedAt)}</span>
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {hasBody && (
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              aria-expanded={expanded}
              data-testid={`toggle-release-${release.id}`}
              className="cursor-pointer rounded-md border border-border bg-transparent px-2.5 py-0.5 text-label font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            >
              {expanded ? "Hide" : "Notes"}
            </button>
          )}
          <a
            href={release.htmlUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-transparent px-2.5 py-0.5 text-label font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          >
            <ExternalLink className="h-3 w-3" />
            GitHub
          </a>
        </div>
      </div>
      {expanded && hasBody && (
        <div className="border-t border-border px-4 py-3">
          {release.bodyHtml ? (
            <div
              className="feedback-markdown text-body leading-relaxed"
              dangerouslySetInnerHTML={{ __html: release.bodyHtml }}
            />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-body leading-relaxed text-foreground/85">
              {release.body}
            </pre>
          )}
          <SocialPostGenerator
            testIdPrefix={`github-release-${release.id}`}
            request={{ kind: "github", repo: repoSlug, githubReleaseId: release.id }}
          />
        </div>
      )}
    </article>
  );
}
