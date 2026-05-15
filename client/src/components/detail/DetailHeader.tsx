import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { toneFailedBgClass, toneHeaderAccentClass, type StatusTone } from "@/lib/statusTones";

export type DetailHeaderProps = {
  statusDot?: ReactNode;
  title: string;
  titleMultiline?: boolean;
  titleSuffix?: ReactNode;
  externalLink?: { href: string; label: string };
  chips?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  banner?: ReactNode;
  stageBar?: ReactNode;
  accentTone?: StatusTone;
  failed?: boolean;
};

export function DetailHeader({
  statusDot,
  title,
  titleMultiline = false,
  titleSuffix,
  externalLink,
  chips,
  meta,
  actions,
  banner,
  stageBar,
  accentTone,
  failed = false,
}: DetailHeaderProps) {
  const titleClass = titleMultiline
    ? "line-clamp-2 break-words text-[15px] font-semibold leading-snug tracking-tight"
    : "truncate text-[15px] font-semibold tracking-tight";
  const accentClass = accentTone ? ` border-t-2 ${toneHeaderAccentClass(accentTone)}` : "";
  const failedBg = toneFailedBgClass(failed);

  return (
    <div className={`shrink-0 border-b border-border px-4 py-3${accentClass}${failedBg ? ` ${failedBg}` : ""}`}>
      <div className="mb-1 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {statusDot}
            <span className={titleClass} title={title}>
              {title}
            </span>
            {titleSuffix}
            {externalLink && (
              <a
                href={externalLink.href}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              >
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
                {externalLink.label}
              </a>
            )}
          </div>
          {meta && <div>{meta}</div>}
          {chips && <div className="mt-2 flex flex-wrap items-center gap-2">{chips}</div>}
          {stageBar && <div className="mt-2">{stageBar}</div>}
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {actions}
          </div>
        )}
      </div>
      {banner}
    </div>
  );
}
