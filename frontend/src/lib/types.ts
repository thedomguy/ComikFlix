// Shapes returned by the Python API (server.py). Keep in sync with scan_library etc.

export interface Chapter {
  id: string; // chapter number as text, e.g. "52" or "12.5"
  page_count: number;
  date: string | null; // ISO publish date on the source
  /** ms epoch of `date` (0: none), computed once in fixLibrary (lib/library.tsx). */
  ts?: number;
  // No longer sent by /api/library (kept optional for older servers; don't read them).
  size?: number;
  source_url?: string | null;
  status?: string;
  pages?: Page[];
}

export interface Page {
  src: string;
  aspect?: string | null;
}

/** Forecast computed at ingest from recent chapter dates (see ingest.estimate_release). */
export interface ReleaseForecast {
  interval_days: number;
  last_published: string;
  next_expected: string;
  based_on: number;
}

export interface Series {
  slug: string;
  title: string;
  description: string | null;
  genres: string[];
  status: string | null; // ongoing | completed | hiatus | ...
  author: string | null;
  artist: string | null;
  type: string | null; // manhwa | manga | manhua
  rating: number | null;
  alt_titles: string[];
  next_release: ReleaseForecast | null;
  release_date: string | null; // manual override, YYYY-MM-DD
  remote_total: number | null; // chapters on the source (incl. not fetched)
  source_url: string | null;
  poster: string | null;
  backdrop: string | null;
  size: number;
  page_total: number;
  chapters: Chapter[]; // ascending
}

export interface Progress {
  chapter: string;
  frac: number;
  read: string[];
  at: number; // ms epoch: last change from anywhere (sync)
  readAt: number | null; // ms epoch: last read in the app; null if only imported (Jarvis)
}

export interface CatalogHit {
  slug: string;
  title: string;
  url: string;
  score: number;
}

export interface IngestJob {
  id: string;
  slug: string;
  title: string | null;
  state: "running" | "done" | "partial" | "cancelled" | "error" | "interrupted";
  stage: string | null;
  error: string | null;
  start_chapter: string;
  latest: number | null;
  started: number;
  finished: number | null;
  [k: string]: unknown;
}

/** The user's own status for a watch list entry (not the series' publishing status). */
export type WatchStatus = "reading" | "plan" | "completed";

/** A watch list entry (watchlist.py): the user's record of a series, downloaded or not. */
export interface WatchEntry {
  id: string;
  title: string;
  status: WatchStatus;
  rating: number | null; // stars 0.5-5 in half steps
  notes: string | null;
  source: "asura" | "manual";
  asura_slug: string | null;
  in_library: boolean;
  source_url: string | null;
  cover_url: string | null;
  series_status: "ongoing" | "hiatus" | "completed" | "dropped" | null;
  type: string | null;
  author: string | null;
  artist: string | null;
  description: string | null;
  genres: string[];
  alt_titles: string[];
  chapters_total: number | null;
  progress: { chapter: string | null; read_count: number; read_at: number | null } | null;
  suggestion: { status: WatchStatus; reason: string } | null;
  status_at: string;
  metadata_at: string | null;
  created_at: string;
  updated_at: string;
}
