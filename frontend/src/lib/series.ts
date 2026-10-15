// Shared per-series rules (continue target, unread counts, release forecast). Pages must use
// these rather than re-deriving, so home, library, search and the calendar always agree.
import { store } from "./store";
import type { Chapter, Progress, Series } from "./types";

/** A chapter's publish time in ms (0: unknown). Uses the `ts` fixLibrary precomputed. */
export const chapterTs = (c: Chapter | undefined): number =>
  !c ? 0 : c.ts ?? (c.date ? Date.parse(c.date) || 0 : 0);

export const progressOf = (slug: string): Progress | null => store.progress(slug) as Progress | null;

/** When the user last actually read this series in the app (0: never; imports don't count). */
export const lastReadAt = (slug: string) => progressOf(slug)?.readAt || 0;

/** "Continue reading" order: last read in the app first; series whose progress was only
 *  imported (e.g. set through ChatGPT) follow, A–Z, so imports never reshuffle the list. */
export function byReadingOrder(a: Series, b: Series) {
  return lastReadAt(b.slug) - lastReadAt(a.slug) || a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
}

export function totalPages(s: Series) {
  return s.page_total ?? s.chapters.reduce((n, c) => n + (c.page_count || 0), 0);
}

/** Every chapter the source lists, added or not ("Click to add"), by number. */
export function listedIds(s: Series): string[] {
  return [...s.chapters.map((c) => c.id), ...(s.pending || []).map((c) => c.id)].sort(
    (a, b) => parseFloat(a) - parseFloat(b)
  );
}

/** How many chapters the series has, counting the ones not added yet. */
export const chapterCount = (s: Series) => s.chapters.length + (s.pending?.length || 0);

/** The newest chapter the source lists (added or not). */
export const lastListedId = (s: Series) => listedIds(s).at(-1) ?? "";

/** Which chapter "Read"/"Continue" opens: the next one once the current is finished. Works by
 *  chapter number over everything listed, so a place on (or a next chapter that is) a chapter
 *  never added still resolves; the reader adds such a chapter when it opens it. */
export function resumeTarget(s: Series): { chapter: string; label: "Read" | "Continue" } {
  const p = progressOf(s.slug);
  if (!p) return { chapter: s.chapters[0].id, label: "Read" };
  if (!(p.read || []).includes(p.chapter)) return { chapter: p.chapter, label: "Continue" };
  const at = parseFloat(p.chapter);
  const after = listedIds(s).find((id) => parseFloat(id) > at);
  return { chapter: after ?? p.chapter, label: "Continue" };
}

/** Chapters after where the user is (the current one counts while unfinished), added or not.
 *  Never-started series: every added chapter. */
export function unreadCount(s: Series) {
  const p = progressOf(s.slug);
  if (!p) return s.chapters.length;
  const at = parseFloat(p.chapter);
  if (Number.isNaN(at)) return s.chapters.length;
  const done = (p.read || []).includes(p.chapter);
  return listedIds(s).filter((id) => parseFloat(id) > at || (id === p.chapter && !done)).length;
}

/** Chapters published after the user last read this series (0 if never started). */
export function newSinceRead(s: Series) {
  const p = progressOf(s.slug);
  if (!p) return 0;
  let n = 0;
  for (const c of s.chapters) if (chapterTs(c) > p.at) n++;
  return n;
}

export const latestChapter = (s: Series) => s.chapters[s.chapters.length - 1];

export function latestDate(s: Series) {
  return chapterTs(latestChapter(s));
}

// ---- release calendar ----

export interface ReleaseEvent {
  slug: string;
  title: string;
  poster: string | null;
  chapter: string; // chapter id (released) or expected number (forecast)
  date: Date;
  kind: "released" | "manual" | "forecast";
  overdue?: boolean; // a forecast/manual date that passed with no new chapter
}

const DAY = 86400000;
const WEEK = 7 * DAY;

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** A YYYY-MM-DD day as local noon (ms), so it lands on that day in any timezone. */
export const dayTs = (day: string) => Date.parse(`${day.slice(0, 10)}T12:00:00`);

/** Released chapters plus upcoming ones in [from, to). Every series is assumed weekly: upcoming
 *  chapters of ongoing series fall on its release day each week, from next_release.next_expected.
 *  "manual" when the user set the release day. */
export function releaseEvents(library: Series[], from: Date, to: Date): ReleaseEvent[] {
  const out: ReleaseEvent[] = [];
  const now = Date.now();
  for (const s of library) {
    const base = { slug: s.slug, title: s.title, poster: s.poster };
    for (const c of s.chapters) {
      const t = chapterTs(c);
      if (t && t >= +from && t < +to) out.push({ ...base, chapter: c.id, date: new Date(t), kind: "released" });
    }
    const f = s.next_release;
    if ((s.status || "").toLowerCase() !== "ongoing" || !f) continue;
    const lastNum = Math.floor(parseFloat(latestChapter(s)?.id || "0")) || 0;
    const kind = s.release_day != null ? "manual" : "forecast";
    for (let k = 0, t = dayTs(f.next_expected); t < +to && k < 60; k++, t += WEEK) {
      if (t >= +from) {
        out.push({ ...base, chapter: String(lastNum + 1 + k), date: new Date(t), kind, overdue: t < now - DAY });
      }
    }
  }
  return out.sort((a, b) => +a.date - +b.date);
}
