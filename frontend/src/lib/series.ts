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

/** Which chapter "Read"/"Continue" opens: the next one once the current is finished. */
export function resumeTarget(s: Series): { chapter: string; label: "Read" | "Continue" } {
  const p = progressOf(s.slug);
  if (!p) return { chapter: s.chapters[0].id, label: "Read" };
  const idx = s.chapters.findIndex((c) => c.id === p.chapter);
  if (idx >= 0 && (p.read || []).includes(p.chapter) && idx < s.chapters.length - 1) {
    return { chapter: s.chapters[idx + 1].id, label: "Continue" };
  }
  return { chapter: p.chapter, label: "Continue" };
}

/** Chapters after where the user is (the current one counts while unfinished).
 *  Never-started series: every chapter. */
export function unreadCount(s: Series) {
  const p = progressOf(s.slug);
  if (!p) return s.chapters.length;
  const idx = s.chapters.findIndex((c) => c.id === p.chapter);
  if (idx < 0) return s.chapters.length;
  return s.chapters.length - idx - ((p.read || []).includes(p.chapter) ? 1 : 0);
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

/** Released chapters plus upcoming ones in [from, to). Upcoming: a manual release date wins;
 *  otherwise the ingest forecast (next_expected + n * interval) for ongoing series. */
export function releaseEvents(library: Series[], from: Date, to: Date): ReleaseEvent[] {
  const out: ReleaseEvent[] = [];
  const now = Date.now();
  for (const s of library) {
    const base = { slug: s.slug, title: s.title, poster: s.poster };
    for (const c of s.chapters) {
      const t = chapterTs(c);
      if (t && t >= +from && t < +to) out.push({ ...base, chapter: c.id, date: new Date(t), kind: "released" });
    }
    const status = (s.status || "").toLowerCase();
    if (status && !["ongoing", "season end", "hiatus"].includes(status)) continue; // completed/dropped
    const f = s.next_release;
    const lastNum = Math.floor(parseFloat(latestChapter(s)?.id || "0")) || 0;
    const lastPub = f?.last_published ? Date.parse(f.last_published) : latestDate(s);
    const interval = f?.interval_days && f.interval_days > 0 ? f.interval_days * DAY : 0;
    let first: number | null = null;
    let kind: ReleaseEvent["kind"] = "forecast";
    if (s.release_date) {
      const m = Date.parse(`${s.release_date}T12:00:00`);
      if (m > lastPub) {
        first = m;
        kind = "manual";
      }
    }
    if (first == null && f?.next_expected) first = Date.parse(f.next_expected);
    if (first == null) continue;
    for (let k = 0, t = first; t < +to && k < 60; k++, t += interval) {
      if (t >= +from) {
        out.push({
          ...base,
          chapter: String(lastNum + 1 + k),
          date: new Date(t),
          kind: k === 0 ? kind : "forecast",
          overdue: t < now - DAY,
        });
      }
      if (!interval) break;
    }
  }
  return out.sort((a, b) => +a.date - +b.date);
}
