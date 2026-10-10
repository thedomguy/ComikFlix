// The watch list (/api/watchlist): the user's own list of series with their status, rating and
// notes. Entries may be in the library or not (never downloaded, or not on Asura at all).
// One module-level copy shared by every screen and the reader (mountReader.js), kept fresh on
// focus so changes from Jarvis or another device show up.
import { useSyncExternalStore } from "react";
import { api } from "./api";
import { progressOf } from "./series";
import type { Series, WatchEntry, WatchStatus } from "./types";

export const STATUSES: WatchStatus[] = ["reading", "plan", "completed"];
export const STATUS_LABEL: Record<WatchStatus, string> = {
  reading: "Reading",
  plan: "Plan to Read",
  completed: "Completed",
};
/** Series still being published can't be Completed (the server enforces it too). */
export const CONTINUING = new Set(["ongoing", "hiatus"]);
const ENDED = new Set(["completed", "dropped"]);

interface State {
  entries: WatchEntry[];
  ready: boolean;
  error: string | null;
}

let state: State = { entries: [], ready: false, error: null };
const subs = new Set<() => void>();
const emit = (next: Partial<State>) => {
  state = { ...state, ...next };
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

let loading: Promise<void> | null = null;

/** Fetch the list (deduplicated while a request is in flight). */
export function loadWatchlist(): Promise<void> {
  if (loading) return loading;
  loading = api<WatchEntry[]>("/api/watchlist")
    .then((entries) => emit({ entries, ready: true, error: null }))
    .catch((e) => emit({ ready: true, error: e instanceof Error ? e.message : "Could not load the watch list" }))
    .finally(() => (loading = null));
  return loading;
}

let started = false;
/** Load once and refresh whenever the app comes back to the foreground. */
export function startWatchlist() {
  if (started) return;
  started = true;
  void loadWatchlist();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void loadWatchlist();
  });
}

export function useWatchlist(): State {
  return useSyncExternalStore(subscribe, () => state);
}

export const watchEntries = () => state.entries;

export function entryForSlug(slug: string | null | undefined): WatchEntry | undefined {
  return slug ? state.entries.find((e) => e.asura_slug === slug) : undefined;
}

export function entryById(id: string | null | undefined): WatchEntry | undefined {
  return id ? state.entries.find((e) => e.id === id) : undefined;
}

const put = (entry: WatchEntry) =>
  emit({ entries: [entry, ...state.entries.filter((e) => e.id !== entry.id)] });

export type EntryInput = Partial<{
  asura: string | null;
  title: string;
  status: WatchStatus;
  rating: number | null;
  notes: string | null;
  series_status: string | null;
  type: string | null;
  cover_url: string | null;
  source_url: string | null;
  author: string | null;
  chapters_total: number | null;
}>;

export async function addEntry(data: EntryInput): Promise<WatchEntry> {
  const entry = await api<WatchEntry>("/api/watchlist", { method: "POST", json: data });
  put(entry);
  return entry;
}

export async function updateEntry(id: string, data: EntryInput): Promise<WatchEntry> {
  const entry = await api<WatchEntry>(`/api/watchlist/${encodeURIComponent(id)}`, { method: "PATCH", json: data });
  put(entry);
  return entry;
}

export async function removeEntry(id: string): Promise<void> {
  await api(`/api/watchlist/${encodeURIComponent(id)}`, { method: "DELETE" });
  emit({ entries: state.entries.filter((e) => e.id !== id) });
}

export async function refreshEntry(id: string): Promise<WatchEntry> {
  const entry = await api<WatchEntry>(`/api/watchlist/${encodeURIComponent(id)}/refresh`, { method: "POST", json: {} });
  put(entry);
  return entry;
}

/** The entry's series status, from the library when it's there (fresher than the copy). */
export function seriesStatusOf(e: WatchEntry, s?: Series): string | null {
  return (s?.status || e.series_status || null)?.toLowerCase() ?? null;
}

export const canComplete = (e: WatchEntry, s?: Series) => !CONTINUING.has(seriesStatusOf(e, s) || "");

/** A one-tap status change worth offering, from live progress (same rules as watchlist.py's
 *  suggestion(), which the server sends for Jarvis): started a Plan to Read -> Reading; read
 *  every chapter of an ended series -> Completed; Completed but publishing again -> Reading. */
export function suggestFor(e: WatchEntry, s?: Series): { status: WatchStatus; reason: string } | null {
  const status = seriesStatusOf(e, s);
  if (e.status === "completed") {
    return status && CONTINUING.has(status) ? { status: "reading", reason: `The series is ${status} again` } : null;
  }
  if (!s) return e.suggestion; // not in the library: no live progress, trust the server
  const p = progressOf(s.slug);
  if (e.status === "plan" && p && (p.readAt || p.read?.length)) return { status: "reading", reason: "You've started reading it" };
  if (status && ENDED.has(status) && p && s.chapters.length) {
    const last = s.chapters[s.chapters.length - 1].id;
    const caughtUp = (p.read || []).includes(last) && (s.remote_total == null || s.chapters.length >= s.remote_total);
    if (caughtUp) return { status: "completed", reason: "You've read every chapter" };
  }
  return null;
}

/** "4.5" -> "★ 4.5"; null -> "". */
export const ratingLabel = (r: number | null) => (r ? `★ ${r % 1 ? r.toFixed(1) : r}` : "");
