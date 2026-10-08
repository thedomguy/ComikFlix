// Library filtering/sorting (LibraryPage) and fuzzy matching (SearchPage). Reading-state rules
// come from lib/series so these agree with home and the cards.
import { lastReadAt, latestDate, newSinceRead, progressOf, unreadCount } from "./series";
import type { Chapter, Series } from "./types";

// ---- text ----

/** Lowercase, strip accents and punctuation; keeps any script (alt titles may be Korean/Japanese). */
export function norm(s: string | null | undefined) {
  return (s || "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const haystackCache = new WeakMap<Series, string>();
function haystack(s: Series) {
  let h = haystackCache.get(s);
  if (h == null) {
    h = norm([s.title, ...(s.alt_titles || []), s.author, s.artist, ...(s.genres || [])].join(" | "));
    haystackCache.set(s, h);
  }
  return h;
}

/** Library text filter: every word of the query appears somewhere (predictable, instant). */
export function matchesText(s: Series, q: string) {
  const words = norm(q).split(" ").filter(Boolean);
  if (!words.length) return true;
  const h = haystack(s);
  return words.every((w) => h.includes(w));
}

/** 0..1 match quality of query `q` against `text` (both already normalized). */
function score(q: string, t: string): number {
  if (!q || !t) return 0;
  if (t === q) return 1;
  if (t.startsWith(q)) return 0.95;
  if (` ${t}`.includes(` ${q}`)) return 0.85;
  if (t.includes(q)) return 0.75;
  const words = t.split(" ");
  const qs = q.split(" ");
  if (qs.every((w) => words.some((x) => x.startsWith(w)))) return 0.68;
  if (!q.includes(" ") && q.length >= 2 && words.map((w) => w[0]).join("").startsWith(q)) return 0.62; // "sss" -> Sword Sense S...
  if (qs.every((w) => t.includes(w))) return 0.55;
  // Typo-ish fallback: query letters appear in order, scored by how tightly.
  const a = q.replace(/ /g, "");
  const b = t.replace(/ /g, "");
  if (a.length < 3) return 0;
  let i = 0;
  let start = -1;
  let end = -1;
  for (let j = 0; j < b.length && i < a.length; j++) {
    if (b[j] === a[i]) {
      if (start < 0) start = j;
      end = j;
      i++;
    }
  }
  if (i < a.length) return 0;
  const tight = a.length / (end - start + 1);
  return tight < 0.5 ? 0 : 0.2 + 0.3 * tight;
}

/** Best field match for a series: title > alt titles > author/artist > genres. */
export function seriesScore(s: Series, query: string) {
  const q = norm(query);
  if (!q) return 0;
  let best = score(q, norm(s.title));
  for (const a of s.alt_titles || []) best = Math.max(best, 0.92 * score(q, norm(a)));
  best = Math.max(best, 0.75 * score(q, norm(s.author)), 0.75 * score(q, norm(s.artist)));
  for (const g of s.genres || []) best = Math.max(best, 0.6 * score(q, norm(g)));
  return best;
}

/** Library series matching `q`, best first (ties: most recently read). */
export function searchLibrary(library: Series[], q: string, min = 0.3) {
  return library
    .map((s) => ({ s, score: seriesScore(s, q) }))
    .filter((r) => r.score >= min)
    .sort((a, b) => b.score - a.score || lastReadAt(b.s.slug) - lastReadAt(a.s.slug));
}

/** "sword sense 52", "absolute ch 52", "solo #12.5" -> { rest, num }. */
export function parseChapterQuery(q: string): { rest: string; num: string } | null {
  const m = q.trim().match(/^(.*?)(?:\s+|\s*#\s*|\s+(?:ch(?:apter)?|ep|c)\.?\s*)(\d+(?:\.\d+)?)$/i);
  if (!m || !m[1].trim()) return null;
  return { rest: m[1].trim(), num: m[2] };
}

export function findChapter(s: Series, num: string): Chapter | undefined {
  return s.chapters.find((c) => c.id === num) ?? s.chapters.find((c) => parseFloat(c.id) === parseFloat(num));
}

// ---- library view state (lives in the hash query) ----

export type ReadState = "" | "reading" | "unstarted" | "unread" | "new" | "finished";
export type SortKey = "recent" | "latest" | "title" | "rating" | "chapters" | "unread";
export type ViewMode = "grid" | "list";

export interface LibraryView {
  q: string;
  status: string;
  genres: string[];
  type: string;
  state: ReadState;
  sort: SortKey;
  view: ViewMode;
}

export const READ_STATES: { id: ReadState; label: string }[] = [
  { id: "", label: "All" },
  { id: "reading", label: "Reading" },
  { id: "unstarted", label: "Not started" },
  { id: "unread", label: "Has unread" },
  { id: "new", label: "New since last read" },
  { id: "finished", label: "Finished" },
];

export const SORTS: { id: SortKey; label: string }[] = [
  { id: "recent", label: "Recently read" },
  { id: "latest", label: "Latest release" },
  { id: "title", label: "Title A–Z" },
  { id: "rating", label: "Rating" },
  { id: "chapters", label: "Most chapters" },
  { id: "unread", label: "Most unread" },
];

export const DEFAULT_VIEW: LibraryView = { q: "", status: "", genres: [], type: "", state: "", sort: "recent", view: "grid" };

export function parseLibraryQuery(p: URLSearchParams): LibraryView {
  const pick = <T extends string>(v: string | null, ok: readonly T[], d: T) => (ok.includes(v as T) ? (v as T) : d);
  return {
    q: p.get("q") || "",
    status: (p.get("status") || "").toLowerCase(),
    genres: (p.get("genre") || "").split(",").map((g) => g.trim().toLowerCase()).filter(Boolean),
    type: (p.get("type") || "").toLowerCase(),
    state: pick(p.get("state"), READ_STATES.map((r) => r.id), ""),
    sort: pick(p.get("sort"), SORTS.map((r) => r.id), DEFAULT_VIEW.sort),
    view: pick(p.get("view"), ["grid", "list"] as const, "grid"),
  };
}

/** "?q=..&genre=a,b" with defaults left out ("" when nothing is set). */
export function libraryQueryString(v: LibraryView) {
  const p = new URLSearchParams();
  if (v.q) p.set("q", v.q);
  if (v.status) p.set("status", v.status);
  if (v.genres.length) p.set("genre", v.genres.join(","));
  if (v.type) p.set("type", v.type);
  if (v.state) p.set("state", v.state);
  if (v.sort !== DEFAULT_VIEW.sort) p.set("sort", v.sort);
  if (v.view !== DEFAULT_VIEW.view) p.set("view", v.view);
  const s = p.toString().replace(/%2C/g, ",");
  return s ? `?${s}` : "";
}

/** Number of narrowing filters set (text excluded). */
export const activeFilterCount = (v: LibraryView) => (v.status ? 1 : 0) + v.genres.length + (v.type ? 1 : 0) + (v.state ? 1 : 0);

const ACTIVE_DAYS = 30; // "Reading" = opened within this many days

export function matchesState(s: Series, state: ReadState) {
  if (!state) return true;
  const p = progressOf(s.slug);
  switch (state) {
    case "unstarted":
      return !p;
    case "reading":
      return !!p && Date.now() - p.at < ACTIVE_DAYS * 86400000 && unreadCount(s) > 0;
    case "unread":
      return !!p && unreadCount(s) > 0;
    case "new":
      return newSinceRead(s) > 0;
    case "finished":
      return !!p && unreadCount(s) === 0;
  }
}

export function filterLibrary(library: Series[], v: LibraryView) {
  return library.filter(
    (s) =>
      (!v.status || (s.status || "").toLowerCase() === v.status) &&
      (!v.type || (s.type || "").toLowerCase() === v.type) &&
      v.genres.every((g) => (s.genres || []).some((x) => x.toLowerCase() === g)) &&
      matchesState(s, v.state) &&
      matchesText(s, v.q),
  );
}

export function sortLibrary(list: Series[], sort: SortKey) {
  const byTitle = (a: Series, b: Series) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });
  const key: Record<SortKey, (s: Series) => number> = {
    // started series by last read, then the rest by latest release
    recent: (s) => {
      const p = progressOf(s.slug);
      return p ? 1e15 + (p.readAt || 0) : latestDate(s);
    },
    latest: latestDate,
    title: () => 0,
    rating: (s) => s.rating ?? -1,
    chapters: (s) => s.chapters.length,
    unread: (s) => (progressOf(s.slug) ? unreadCount(s) : -1),
  };
  const k = key[sort];
  return list
    .map((s) => ({ s, k: k(s) }))
    .sort((a, b) => b.k - a.k || byTitle(a.s, b.s))
    .map((r) => r.s);
}

/** Filter options present in the data, with counts (most common first; genres then A–Z). */
export function facets(library: Series[]) {
  const count = (vals: (string | null | undefined)[]) => {
    const m = new Map<string, { id: string; label: string; n: number }>();
    for (const v of vals) {
      if (!v) continue;
      const id = v.toLowerCase();
      const e = m.get(id) || { id, label: v, n: 0 };
      e.n++;
      m.set(id, e);
    }
    return [...m.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  };
  return {
    statuses: count(library.map((s) => s.status)),
    types: count(library.map((s) => s.type)),
    genres: count(library.flatMap((s) => s.genres || [])),
  };
}
