// Date + grouping helpers for the release calendar. All dates are local (calendar days).
import { dayKey } from "../../lib/format";
import type { ReleaseEvent } from "../../lib/series";

export type EventStyle = "released" | "manual" | "forecast" | "overdue";

/** One row in a day: consecutive chapters of the same series and kind on that day are merged
 *  (bulk uploads otherwise fill a cell with "Ch. 1, Ch. 2, ..." of one series). */
export interface DayItem {
  key: string;
  slug: string;
  title: string;
  poster: string | null;
  style: EventStyle;
  manual: boolean;
  chapters: string[]; // ascending
  date: Date;
}

export const DAY_MS = 86400000;

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
// Calendar arithmetic (not +ms) so DST changes don't shift days.
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export const monthKey = (y: number, m0: number) => `${y}-${String(m0 + 1).padStart(2, "0")}`;

/** "YYYY-MM" → {y, m0}; anything invalid falls back to the current month. */
export function parseMonth(m: string | undefined): { y: number; m0: number } {
  const hit = /^(\d{4})-(\d{2})$/.exec(m || "");
  if (hit) {
    const y = +hit[1];
    const m0 = +hit[2] - 1;
    if (m0 >= 0 && m0 < 12 && y > 1900 && y < 3000) return { y, m0 };
  }
  const now = new Date();
  return { y: now.getFullYear(), m0: now.getMonth() };
}

export function shiftMonth(y: number, m0: number, delta: number) {
  const d = new Date(y, m0 + delta, 1);
  return monthKey(d.getFullYear(), d.getMonth());
}

/** Monday-first grid covering the month: whole weeks, so it includes leading/trailing days. */
export function gridRange(y: number, m0: number) {
  const first = new Date(y, m0, 1);
  const lead = (first.getDay() + 6) % 7;
  const dim = new Date(y, m0 + 1, 0).getDate();
  const weeks = Math.ceil((lead + dim) / 7);
  const from = new Date(y, m0, 1 - lead);
  return { from, to: addDays(from, weeks * 7), days: weeks * 7 };
}

export const styleOf = (e: ReleaseEvent): EventStyle =>
  e.kind === "released" ? "released" : e.overdue ? "overdue" : e.kind;

const ORDER: Record<EventStyle, number> = { overdue: 0, manual: 1, forecast: 2, released: 3 };

function chapterNum(id: string) {
  const n = parseFloat(id);
  return isNaN(n) ? Infinity : n;
}

/** Events → day key → merged items (upcoming first, then released, then by title). */
export function groupByDay(events: ReleaseEvent[]): Map<string, DayItem[]> {
  const days = new Map<string, Map<string, DayItem>>();
  for (const e of events) {
    const dk = dayKey(e.date);
    const style = styleOf(e);
    const gk = `${e.slug}|${style}`;
    let day = days.get(dk);
    if (!day) days.set(dk, (day = new Map()));
    const cur = day.get(gk);
    if (cur) cur.chapters.push(e.chapter);
    else
      day.set(gk, {
        key: `${dk}|${gk}`,
        slug: e.slug,
        title: e.title,
        poster: e.poster,
        style,
        manual: e.kind === "manual",
        chapters: [e.chapter],
        date: e.date,
      });
  }
  const out = new Map<string, DayItem[]>();
  for (const [dk, day] of days) {
    const items = [...day.values()];
    for (const it of items) it.chapters.sort((a, b) => chapterNum(a) - chapterNum(b));
    items.sort((a, b) => ORDER[a.style] - ORDER[b.style] || a.title.localeCompare(b.title));
    out.set(dk, items);
  }
  return out;
}

export function chapterLabel(chs: string[]) {
  return chs.length === 1 ? `Ch. ${chs[0]}` : `Ch. ${chs[0]}–${chs[chs.length - 1]}`;
}

export function itemHref(it: DayItem) {
  const slug = encodeURIComponent(it.slug);
  return it.style === "released" ? `#/read/${slug}/${encodeURIComponent(it.chapters[0])}` : `#/series/${slug}`;
}

export const STYLE_LABEL: Record<EventStyle, string> = {
  released: "Released",
  manual: "Set by you",
  forecast: "Expected",
  overdue: "Overdue",
};

/** "Today" / "Tomorrow" / "Yesterday" / "Fri 10". */
export function relDay(d: Date, today: Date) {
  const diff = Math.round((+startOfDay(d) - +today) / DAY_MS);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
}

export const longDay = (d: Date) => d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

/** Parse a dayKey back to a local Date. */
export function fromDayKey(k: string) {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
}
