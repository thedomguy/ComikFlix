// #/downloads: every download attempt ever, from any source (the app, or Jarvis on behalf
// of ChatGPT / Claude / Claude Code / Cursor ...), with tags and live progress.
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useLibrary } from "../lib/library";
import type { IngestJob } from "../lib/types";
import { fmtSpan, sourceLabel } from "../components/ingest/fmt";
import "../styles/downloads.css";

const POLL_MS = 3000;
const IDLE_POLL_MS = 15000;
const STATE_LABEL: Record<string, string> = {
  running: "Running",
  done: "Done",
  partial: "Some failed",
  cancelled: "Cancelled",
  error: "Error",
  interrupted: "Interrupted",
};

/** A persisted job row from /api/downloads (counts by chapter state instead of the chapter map). */
type HistoryJob = IngestJob & {
  source: string | null;
  tags: string[];
  counts: Record<string, number>;
  failed: string[];
  log: { t: number; level: string; msg: string }[];
};

function ago(t: number) {
  const s = Math.max(0, Date.now() / 1000 - t);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

const PROBLEMS = ["partial", "error", "interrupted", "cancelled"];

function matches(j: HistoryJob, filter: string) {
  if (filter === "all") return true;
  if (filter === "running") return j.state === "running";
  if (filter === "problems") return PROBLEMS.includes(j.state);
  return (j.source || "app") === filter;
}

function JobCard({
  j,
  inLibrary,
  logOpen,
  onToggleLog,
}: {
  j: HistoryJob;
  inLibrary: boolean;
  logOpen: boolean;
  onToggleLog: (open: boolean) => void;
}) {
  const c = j.counts || {};
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  const handled = (c.done || 0) + (c.cached || 0) + (c.failed || 0) + (c.locked || 0);
  const parts = [
    c.done ? `${c.done} fetched` : null,
    c.cached ? `${c.cached} already had` : null,
    c.failed ? `${c.failed} failed` : null,
    c.locked ? `${c.locked} locked` : null,
  ].filter(Boolean);
  const title = j.title || j.slug.replace(/-[0-9a-f]{8}$/, "").replace(/-/g, " ");
  const tags = (j.tags || []).filter((t) => !t.startsWith("via:") && !t.startsWith("client:"));
  const log = j.log || [];

  return (
    <div className={`dl-card ${j.state}`}>
      <div className="dl-top">
        {inLibrary ? (
          <a className="dl-title" href={`#/series/${j.slug}`}>
            {title}
          </a>
        ) : (
          <span className="dl-title">{title}</span>
        )}
        <span className={`dl-state ${j.state}`}>{STATE_LABEL[j.state] || j.state}</span>
      </div>
      <div className="dl-tags">
        <span className="dl-tag src">{sourceLabel(j.source)}</span>
        {tags.map((t) => (
          <span key={t} className="dl-tag">
            {t}
          </span>
        ))}
      </div>
      <div className="dl-meta">
        {ago(j.started)} · from ch. {j.start_chapter}
        {j.latest ? ` to ${j.latest}` : ""}
        {j.finished
          ? ` · took ${fmtSpan(j.started, j.finished)}`
          : j.state === "running"
            ? ` · ${fmtSpan(j.started, Date.now() / 1000)} so far`
            : ""}
      </div>
      {j.state === "running" && (
        <div className="dl-progress">
          <div className="dl-bar">
            <span style={{ width: `${total ? (handled / total) * 100 : 0}%` }} />
          </div>
          <small>
            {j.stage || "Working"}
            {total ? ` · ${handled}/${total} chapters` : ""}
          </small>
        </div>
      )}
      {parts.length > 0 && <div className="dl-counts">{parts.join(" · ")}</div>}
      {j.error && <div className="dl-error">{j.error}</div>}
      {(j.failed || []).length > 0 &&<div className="dl-error">Failed chapters: {j.failed.join(", ")}</div>}
      {log.length > 0 && (
        <details className="dl-log" open={logOpen} onToggle={(e) => onToggleLog(e.currentTarget.open)}>
          <summary>Log</summary>
          {logOpen && (
            <pre>
              {log.map((l) => `${new Date(l.t * 1000).toLocaleTimeString([], { hour12: false })}  ${l.msg}`).join("\n")}
            </pre>
          )}
        </details>
      )}
    </div>
  );
}

export default function DownloadsPage() {
  const { library } = useLibrary();
  const [jobs, setJobs] = useState<HistoryJob[] | null>(null);
  const [filter, setFilter] = useState("all");
  const [openLogs, setOpenLogs] = useState<Set<string>>(() => new Set()); // survive refreshes

  useEffect(() => {
    let alive = true;
    let timer = 0;
    let last: HistoryJob[] = [];
    const load = async () => {
      try {
        last = await api<HistoryJob[]>("/api/downloads");
      } catch {
        /* offline: keep what we have */
      }
      if (!alive) return;
      setJobs(last);
      // Fast while something runs; slower otherwise so new downloads (e.g. from Jarvis) still appear.
      timer = window.setTimeout(load, last.some((j) => j.state === "running") ? POLL_MS : IDLE_POLL_MS);
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => scrollTo(0, 0), []);

  const lib = useMemo(() => new Set(library.map((s) => s.slug)), [library]);
  const list = jobs || [];
  const sources = [...new Set(list.map((j) => j.source || "app"))];
  const opts: [string, string][] = [
    ["all", `All (${list.length})`],
    ["running", `Running (${list.filter((j) => j.state === "running").length})`],
    ["problems", `Problems (${list.filter((j) => PROBLEMS.includes(j.state)).length})`],
    ...sources.map((s): [string, string] => [s, sourceLabel(s)]),
  ];
  const shown = list.filter((j) => matches(j, filter));

  return (
    <main className="dl-page">
      <div className="dl-head">
        <h1>Downloads</h1>
        <p>Every download attempt, from the app or through Jarvis.</p>
      </div>
      <div className="dl-filters">
        {opts.map(([v, label]) => (
          <button key={v} className={`dl-filter${filter === v ? " on" : ""}`} onClick={() => setFilter(v)}>
            {label}
          </button>
        ))}
      </div>
      <div className="dl-list">
        {jobs === null ? (
          <p className="dl-empty">Loading…</p>
        ) : shown.length ? (
          shown.map((j) => (
            <JobCard
              key={j.id}
              j={j}
              inLibrary={lib.has(j.slug)}
              logOpen={openLogs.has(j.id)}
              onToggleLog={(open) =>
                setOpenLogs((prev) => {
                  if (open === prev.has(j.id)) return prev;
                  const next = new Set(prev);
                  if (open) next.add(j.id);
                  else next.delete(j.id);
                  return next;
                })
              }
            />
          ))
        ) : (
          <p className="dl-empty">{list.length ? "Nothing matches this filter." : "No downloads yet."}</p>
        )}
      </div>
    </main>
  );
}
