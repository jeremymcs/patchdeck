import { useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/queryClient";
import { AppHeader } from "@/components/AppHeader";
import { UpdateBanner } from "@/components/UpdateBanner";
import type { ActivitySnapshot } from "@shared/schema";
import { EMPTY_ACTIVITY_SNAPSHOT } from "@/components/ActivityMenu";
import { ACTIVITY_POLL_INTERVAL_MS } from "@/lib/polling";

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
type Level = (typeof LEVELS)[number];

type LogRecord = {
  seq: number;
  time: number;
  level: Level;
  source?: string;
  msg: string;
  fields: Record<string, unknown>;
};

type LogsResponse = {
  records: LogRecord[];
  sources: string[];
  latestSeq: number;
};

const LEVEL_RANK: Record<Level, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const LEVEL_COLOR: Record<Level, string> = {
  trace: "text-muted-foreground",
  debug: "text-muted-foreground",
  info: "text-primary",
  warn: "text-warning-foreground",
  error: "text-destructive",
  fatal: "text-destructive font-medium",
};

function parseSearchParams(search: string): {
  level: Level | "";
  source: string;
  search: string;
  follow: boolean;
} {
  const params = new URLSearchParams(search);
  const rawLevel = params.get("level") ?? "";
  const level = (LEVELS as readonly string[]).includes(rawLevel) ? (rawLevel as Level) : "";
  return {
    level,
    source: params.get("source") ?? "",
    search: params.get("q") ?? "",
    follow: params.get("follow") === "1",
  };
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function recordToText(r: LogRecord): string {
  const fields = Object.keys(r.fields).length > 0 ? " " + JSON.stringify(r.fields) : "";
  const source = r.source ? ` [${r.source}]` : "";
  return `${formatTime(r.time)} ${r.level.toUpperCase().padEnd(5)}${source} ${r.msg}${fields}`;
}

function recordsToText(records: LogRecord[]): string {
  return records.map(recordToText).join("\n");
}

function setUrlParams(updates: { level?: string; source?: string; q?: string; follow?: boolean }) {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(updates)) {
    if (value === "" || value === false || value === undefined) {
      params.delete(key);
    } else if (value === true) {
      params.set(key, "1");
    } else {
      params.set(key, String(value));
    }
  }
  const next = params.toString();
  const url = new URL(window.location.href);
  url.search = next ? `?${next}` : "";
  // wouter monkey-patches replaceState to dispatch a "replaceState" event,
  // which useSearch listens for, so subscribers re-render.
  history.replaceState(history.state, "", url.href);
}

export default function Logs() {
  const search = useSearch();
  const initial = useMemo(() => parseSearchParams(search), [search]);

  const [level, setLevel] = useState<Level | "">(initial.level);
  const [source, setSource] = useState<string>(initial.source);
  const [searchTerm, setSearchTerm] = useState<string>(initial.search);
  const [follow, setFollow] = useState<boolean>(initial.follow);

  const [records, setRecords] = useState<LogRecord[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [clearedRecordSeqs, setClearedRecordSeqs] = useState<Set<number>>(() => new Set());
  const { data: activities = EMPTY_ACTIVITY_SNAPSHOT } = useQuery<ActivitySnapshot>({
    queryKey: ["/api/activities"],
    refetchInterval: ACTIVITY_POLL_INTERVAL_MS,
  });

  const recordsRef = useRef<LogRecord[]>([]);
  recordsRef.current = records;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(follow);
  followRef.current = follow;

  // Initial load
  useEffect(() => {
    let cancelled = false;
    setError(null);
    const params = new URLSearchParams();
    if (level) params.set("level", level);
    if (source) params.set("source", source);
    if (searchTerm) params.set("search", searchTerm);
    params.set("limit", "1000");

    fetchJson<LogsResponse>(`/api/server-logs?${params.toString()}`)
      .then((res) => {
        if (cancelled) return;
        setRecords(res.records);
        setSources(res.sources);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });

    return () => { cancelled = true; };
  }, [level, source, searchTerm]);

  // SSE tail when "follow" is on
  useEffect(() => {
    if (!follow) return;
    const lastSeq = recordsRef.current[recordsRef.current.length - 1]?.seq ?? 0;
    const url = `/api/server-logs/stream?since=${lastSeq}`;
    const es = new EventSource(url);
    es.onmessage = (event) => {
      try {
        const record = JSON.parse(event.data) as LogRecord;
        setRecords((prev) => {
          if (prev.length > 0 && prev[prev.length - 1].seq >= record.seq) return prev;
          const next = [...prev, record];
          // Keep the in-memory window bounded
          return next.length > 5000 ? next.slice(next.length - 5000) : next;
        });
      } catch {
        /* ignore malformed line */
      }
    };
    es.onerror = () => {
      setError("Lost log stream connection — disable Follow tail and re-enable to retry");
    };
    return () => {
      es.close();
    };
  }, [follow]);

  // Auto-scroll while following
  useEffect(() => {
    if (!follow) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [records, follow]);

  // URL persistence
  useEffect(() => { setUrlParams({ level }); }, [level]);
  useEffect(() => { setUrlParams({ source }); }, [source]);
  useEffect(() => { setUrlParams({ q: searchTerm }); }, [searchTerm]);
  useEffect(() => { setUrlParams({ follow }); }, [follow]);

  const filteredRecords = useMemo(() => {
    let out = records.filter((record) => !clearedRecordSeqs.has(record.seq));
    if (level) {
      const minRank = LEVEL_RANK[level];
      out = out.filter((r) => LEVEL_RANK[r.level] >= minRank);
    }
    if (source) out = out.filter((r) => r.source === source);
    if (searchTerm) {
      const needle = searchTerm.toLowerCase();
      out = out.filter((r) =>
        r.msg.toLowerCase().includes(needle)
        || JSON.stringify(r.fields).toLowerCase().includes(needle),
      );
    }
    return out;
  }, [clearedRecordSeqs, records, level, source, searchTerm]);

  const activityItems = useMemo(
    () => [...activities.failed, ...activities.inProgress, ...activities.queued]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 100),
    [activities.failed, activities.inProgress, activities.queued],
  );

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(recordsToText(filteredRecords));
    } catch {
      /* ignore */
    }
  };

  const onClearView = () => {
    setClearedRecordSeqs((current) => {
      const next = new Set(current);
      for (const record of filteredRecords) {
        next.add(record.seq);
      }
      return next;
    });
  };

  const onDownload = () => {
    const blob = new Blob([recordsToText(filteredRecords)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `patchdeck-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-screen flex-col">
      <UpdateBanner />
      <AppHeader active="logs" />

      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-[11px]">
        <label htmlFor="logs-level" className="uppercase tracking-wider text-muted-foreground">level</label>
        <select
          id="logs-level"
          value={level}
          onChange={(e) => setLevel(e.target.value as Level | "")}
          className="cursor-pointer border border-border bg-transparent px-2 py-0.5 transition-colors focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">all</option>
          {LEVELS.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>

        <label htmlFor="logs-source" className="uppercase tracking-wider text-muted-foreground">source</label>
        <select
          id="logs-source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="cursor-pointer border border-border bg-transparent px-2 py-0.5 transition-colors focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">all</option>
          {sources.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <input
          type="search"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="search…"
          className="min-w-[180px] flex-1 border border-border bg-transparent px-2 py-0.5 transition-colors focus:border-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />

        <label className="flex cursor-pointer items-center gap-1.5 uppercase tracking-wider text-muted-foreground">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
            className="cursor-pointer"
          />
          follow tail
        </label>

        <span className="ml-auto text-muted-foreground">
          <span className="font-mono text-foreground/80">{filteredRecords.length}</span> of <span className="font-mono text-foreground/80">{records.length}</span>
        </span>

        <button
          type="button"
          onClick={onCopy}
          className="cursor-pointer rounded-md border border-border bg-transparent px-2.5 py-0.5 font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          copy
        </button>
        <button
          type="button"
          onClick={onClearView}
          disabled={filteredRecords.length === 0}
          className="cursor-pointer rounded-md border border-border bg-transparent px-2.5 py-0.5 font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
        >
          clear view
        </button>
        <button
          type="button"
          onClick={onDownload}
          className="cursor-pointer rounded-md border border-border bg-transparent px-2.5 py-0.5 font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          download
        </button>
      </div>

      {error && (
        <div className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-4 py-1 text-[11px] text-destructive">
          {error}
        </div>
      )}

      <div ref={containerRef} className="flex-1 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed">
        <div className="mb-3 border border-border/60">
          <div className="border-b border-border/60 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            Activity
          </div>
          <div className="max-h-56 overflow-y-auto">
            {activityItems.length === 0 ? (
              <div className="px-2 py-2 text-[10px] text-muted-foreground">No active activity.</div>
            ) : (
              activityItems.map((item) => (
                <div key={item.id} className="border-b border-border/40 px-2 py-1.5 last:border-b-0">
                  <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <span>{item.kind.replace("_", " ")}</span>
                    <span>{item.status.replace("_", " ")}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-foreground/85">{item.label}</div>
                  {item.detail && <div className="text-[10px] text-muted-foreground">{item.detail}</div>}
                </div>
              ))
            )}
          </div>
        </div>
        {filteredRecords.length === 0 ? (
          <div className="text-center text-muted-foreground">No log records match the current filter.</div>
        ) : (
          filteredRecords.map((r) => (
            <div key={r.seq} className="flex gap-2 whitespace-pre-wrap break-all">
              <span className="shrink-0 text-muted-foreground">{formatTime(r.time)}</span>
              <span className={`shrink-0 w-12 ${LEVEL_COLOR[r.level]}`}>{r.level}</span>
              {r.source && <span className="shrink-0 text-muted-foreground">[{r.source}]</span>}
              <span className={`grow ${r.level === "error" || r.level === "fatal" ? "text-destructive" : ""}`}>
                {r.msg}
                {Object.keys(r.fields).length > 0 && (
                  <span className="text-muted-foreground"> {JSON.stringify(r.fields)}</span>
                )}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
