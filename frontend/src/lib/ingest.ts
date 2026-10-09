// Download (ingest) jobs: start one and follow the live list. Shared by the add dialog,
// the tray, the series page and search's "Add from Asura". The tray/UI live in IngestHost.
import { useSyncExternalStore } from "react";
import { api } from "./api";
import { store } from "./store";
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
  store.setTrayOpen(true);
  store.undismissJob(job.id);
  poll();
  return job;
}

/** Retry a job's failed/queued chapters, or just `chapter`. Throws ApiError. */
export async function retryJob(id: string, chapter?: string) {
  await api(`/api/ingest/${id}/retry`, { method: "POST", json: chapter != null ? { chapter } : {} });
  store.setTrayOpen(true);
  poll();
}

export async function cancelJob(id: string) {
  await api(`/api/ingest/${id}/cancel`, { method: "POST", json: {} });
  poll();
}

// ---- one shared poller for every useIngestJobs() caller ----

let jobs: LiveJob[] = [];
let loaded = false;
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
    if (!loaded) {
      // Finished jobs from before this page load stay out of the tray.
      for (const j of list) if (j.state === "done" || j.state === "cancelled") store.dismissJob(j.id);
      loaded = true;
    }
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
