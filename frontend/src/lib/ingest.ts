// Ingest jobs (importing a comic, syncing one): start one and follow the live list. Shared by
// the add dialog, the series page, search and the watch list. The progress window lives in
// IngestHost; the History page (#/downloads) shows every job.
import { useSyncExternalStore } from "react";
import { api } from "./api";
import type { IngestJob } from "./types";

export type ChapterState = "queued" | "running" | "done" | "cached" | "failed" | "locked";

export interface JobChapter {
  state: ChapterState;
  done: number; // images fetched
  total: number;
  pages: number | null;
  error: string | null;
  started?: number | null;
  finished?: number | null;
}

export interface JobLogLine {
  t: number; // epoch seconds
  level: string; // info | error | ...
  msg: string;
}

/** What /api/ingest actually returns per job (IngestJob plus the per-chapter map and log). */
export type LiveJob = IngestJob & {
  chapters: Record<string, JobChapter>;
  log: JobLogLine[];
};

export async function startIngest(opts: {
  series: string;
  start_chapter: number | string;
  latest?: number | null;
}): Promise<IngestJob> {
  const job = await api<IngestJob>("/api/ingest", {
    method: "POST",
    json: {
      series: opts.series,
      start_chapter: Number(opts.start_chapter),
      ...(opts.latest != null ? { latest: Number(opts.latest) } : {}),
    },
  });
  poll();
  return job;
}

// ---- the job whose progress window is open ----

/** import: a comic new to the library; sync: new chapters of one already in it. */
export type JobKind = "import" | "sync";
export type Watched = { id: string; kind: JobKind } | null;

let watched: Watched = null;
const watchSubs = new Set<() => void>();

/** Open the progress window for a job this page just started (replaces any other). */
export function watchJob(id: string, kind: JobKind) {
  watched = { id, kind };
  watchSubs.forEach((f) => f());
}

/** Close the progress window; a running job carries on (History shows it). */
export function unwatchJob() {
  if (!watched) return;
  watched = null;
  watchSubs.forEach((f) => f());
}

export function useWatchedJob(): Watched {
  return useSyncExternalStore(
    (f) => (watchSubs.add(f), () => void watchSubs.delete(f)),
    () => watched,
  );
}

/** Retry a job's failed/queued chapters, or just `chapter`. Throws ApiError. */
export async function retryJob(id: string, chapter?: string) {
  await api(`/api/ingest/${id}/retry`, { method: "POST", json: chapter != null ? { chapter } : {} });
  poll();
}

export async function cancelJob(id: string) {
  await api(`/api/ingest/${id}/cancel`, { method: "POST", json: {} });
  poll();
}

// ---- one shared poller for every useIngestJobs() caller ----

let jobs: LiveJob[] = [];
let timer = 0;
let inflight = false;
let again = false;
const subs = new Set<() => void>();

async function poll() {
  if (inflight) {
    again = true; // a start/retry happened mid-request: fetch once more right after
    return;
  }
  clearTimeout(timer);
  inflight = true;
  try {
    const list = await api<LiveJob[]>("/api/ingest");
    jobs = list.map((j) => ({ ...j, chapters: j.chapters || {}, log: j.log || [] }));
    subs.forEach((f) => f());
  } catch {
    /* keep last */
  }
  inflight = false;
  if (again) {
    again = false;
    return poll();
  }
  if (subs.size) timer = window.setTimeout(poll, nextDelay());
}

const RUNNING_MS = 1500;
const IDLE_MS = 30000;
const IDLE_HIDDEN_MS = 60000;

function nextDelay() {
  if (jobs.some((j) => j.state === "running")) return RUNNING_MS;
  return document.hidden ? IDLE_HIDDEN_MS : IDLE_MS;
}

// Back on the tab: catch up at once instead of waiting out a long idle delay.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && subs.size) void poll();
});

function subscribe(f: () => void) {
  subs.add(f);
  if (subs.size === 1) poll();
  return () => {
    subs.delete(f);
    if (!subs.size) clearTimeout(timer);
  };
}

/** Live in-memory jobs from /api/ingest (newest first): every 1.5s while one runs, else 30s
 *  (60s in a hidden tab), and right away when the tab becomes visible. */
export function useIngestJobs(): LiveJob[] {
  return useSyncExternalStore(subscribe, () => jobs);
}
