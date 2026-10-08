/** Settings + reading progress: in-memory cache backed by API (not localStorage). */

import { withBase } from "./paths.js";

const KEY = "comicflix";
const LEGACY = {
  width: "comicflix-width",
  sort: "comicflix-sort",
  dismissed: "comicflix-dismissed",
};

const defaultAutoScroll = () => ({
  speed: 40, // px/sec
  persist: "global", // global | series | chapter
  bySeries: {},
  byChapter: {},
});

const defaults = () => ({
  progress: {},
  readerWidth: 800,
  sortNewest: true,
  dismissedJobs: [],
  trayOpen: true,
  autoScroll: defaultAutoScroll(),
});

let state = defaults();
let booted = false;
let bootPromise = null;

const pendingProgress = new Map();
let progressTimer = null;
const PROGRESS_DEBOUNCE_MS = 400;

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function putJson(url, body) {
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    /* offline / API missing — keep memory cache */
    return false;
  }
}

function normalizeAutoScroll(raw) {
  const out = defaultAutoScroll();
  if (!raw || typeof raw !== "object") return out;
  const speed = +raw.speed;
  if (Number.isFinite(speed)) out.speed = Math.min(400, Math.max(10, Math.round(speed)));
  const persist = String(raw.persist || out.persist).toLowerCase();
  if (persist === "global" || persist === "series" || persist === "chapter") out.persist = persist;
  for (const [srcKey, destKey] of [
    ["bySeries", "bySeries"],
    ["byChapter", "byChapter"],
  ]) {
    const src = raw[srcKey];
    if (!src || typeof src !== "object") continue;
    const cleaned = {};
    for (const [k, v] of Object.entries(src)) {
      const n = +v;
      if (Number.isFinite(n)) cleaned[String(k)] = Math.min(400, Math.max(10, Math.round(n)));
    }
    out[destKey] = cleaned;
  }
  return out;
}

function settingsPayload() {
  return {
    readerWidth: state.readerWidth,
    sortNewest: state.sortNewest,
    trayOpen: state.trayOpen,
    dismissedJobs: state.dismissedJobs,
    autoScroll: state.autoScroll,
  };
}

function putSettings() {
  return putJson(withBase("/api/settings"), settingsPayload());
}

function putProgressSlug(slug, data) {
  return putJson(withBase(`/api/progress/${encodeURIComponent(slug)}`), {
    chapter: data.chapter,
    frac: data.frac,
    read: data.read || [],
    at: data.at,
  });
}

function scheduleProgressWrite(slug) {
  const data = state.progress[slug];
  if (!data) return;
  pendingProgress.set(slug, data);
  clearTimeout(progressTimer);
  progressTimer = setTimeout(flushProgress, PROGRESS_DEBOUNCE_MS);
}

async function flushProgress() {
  clearTimeout(progressTimer);
  progressTimer = null;
  const entries = [...pendingProgress.entries()];
  pendingProgress.clear();
  await Promise.all(entries.map(([slug, data]) => putProgressSlug(slug, data)));
}

/** Read and normalize any pre-API localStorage blob (does not write back). */
function readLocalMigration() {
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    raw = null;
  }

  const hasKey = (() => {
    try {
      return localStorage.getItem(KEY) != null;
    } catch {
      return false;
    }
  })();

  let legacyHit = false;
  const next = defaults();

  if (raw && raw.v === 1 && raw.progress) {
    Object.assign(next, {
      progress: raw.progress || {},
      readerWidth: raw.readerWidth ?? next.readerWidth,
      sortNewest: raw.sortNewest ?? next.sortNewest,
      dismissedJobs: Array.isArray(raw.dismissedJobs) ? raw.dismissedJobs : [],
      trayOpen: raw.trayOpen ?? next.trayOpen,
    });
  } else if (raw && !raw.v && typeof raw === "object") {
    const looksLikeProgress = Object.values(raw).some(
      (v) => v && typeof v === "object" && ("chapter" in v || "read" in v)
    );
    if (looksLikeProgress) next.progress = raw;
    else if (raw.progress) Object.assign(next, raw);
  } else if (raw?.progress) {
    Object.assign(next, raw);
  }

  try {
    const w = +(localStorage.getItem(LEGACY.width) || "");
    if (Number.isFinite(w) && w > 0) {
      next.readerWidth = Math.min(1400, Math.max(400, w));
      legacyHit = true;
    }
  } catch {}
  try {
    const s = localStorage.getItem(LEGACY.sort) || "";
    if (s === "oldest" || s.endsWith("-asc")) {
      next.sortNewest = false;
      legacyHit = true;
    } else if (s) {
      next.sortNewest = true;
      legacyHit = true;
    }
  } catch {}
  try {
    const d = JSON.parse(localStorage.getItem(LEGACY.dismissed) || "[]");
    if (Array.isArray(d) && d.length) {
      next.dismissedJobs = d.slice(-200);
      legacyHit = true;
    }
  } catch {}

  const hadLocal = hasKey || legacyHit || Object.keys(next.progress).length > 0;
  return hadLocal ? next : null;
}

function clearLocalStorage() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(LEGACY.width);
    localStorage.removeItem(LEGACY.sort);
    localStorage.removeItem(LEGACY.dismissed);
  } catch {}
}

function applySettings(src) {
  if (!src || typeof src !== "object") return;
  if (src.readerWidth != null) {
    const w = +src.readerWidth;
    if (Number.isFinite(w) && w > 0) state.readerWidth = Math.min(1400, Math.max(400, w));
  }
  if (src.sortNewest != null) state.sortNewest = !!src.sortNewest;
  if (src.trayOpen != null) state.trayOpen = !!src.trayOpen;
  if (Array.isArray(src.dismissedJobs)) state.dismissedJobs = src.dismissedJobs.slice(-200);
  if (src.autoScroll != null) state.autoScroll = normalizeAutoScroll(src.autoScroll);
}

function applyProgressMap(map) {
  if (!map || typeof map !== "object") return;
  // Accept either a bare slug→entry map or { progress: { ... } }
  const src = map.progress && typeof map.progress === "object" && !("chapter" in map.progress)
    ? map.progress
    : map;
  for (const [slug, entry] of Object.entries(src)) {
    if (!entry || typeof entry !== "object") continue;
    if (!("chapter" in entry || "read" in entry || "frac" in entry)) continue;
    state.progress[slug] = {
      chapter: entry.chapter,
      frac: entry.frac ?? 0,
      read: Array.isArray(entry.read) ? entry.read : [],
      at: entry.at || Date.now(),
    };
  }
}

async function doBootstrap() {
  const local = readLocalMigration();
  const [apiSettings, apiProgress] = await Promise.all([
    fetchJson(withBase("/api/settings")),
    fetchJson(withBase("/api/progress")),
  ]);

  state = defaults();
  applySettings(apiSettings);
  applyProgressMap(apiProgress);

  if (local) {
    // One-time migrate: browser cache wins, then push to API and clear localStorage.
    // Only clear localStorage after a successful push so a missing API does not wipe data.
    applySettings(local);
    state.progress = { ...state.progress, ...local.progress };
    const settingsOk = await putSettings();
    const progressSlugs = Object.keys(state.progress);
    const progressOk = (
      await Promise.all(progressSlugs.map((slug) => putProgressSlug(slug, state.progress[slug])))
    ).every(Boolean);
    if (settingsOk && (progressSlugs.length === 0 || progressOk)) {
      clearLocalStorage();
    }
  }

  booted = true;
  return state;
}

function ensureFlushHooks() {
  if (ensureFlushHooks.done) return;
  ensureFlushHooks.done = true;
  window.addEventListener("pagehide", () => {
    flushProgress();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushProgress();
  });
}

export const store = {
  /** Load settings + progress from API (and migrate localStorage once). Await before routing. */
  bootstrap() {
    if (!bootPromise) {
      ensureFlushHooks();
      bootPromise = doBootstrap();
    }
    return bootPromise;
  },
  get ready() {
    return booted;
  },
  get() {
    return state;
  },
  progress(slug) {
    return state.progress[slug] || null;
  },
  saveProgress(slug, chapter, frac, done) {
    const cur = state.progress[slug] || { read: [] };
    const read = new Set(cur.read || []);
    if (done) read.add(chapter);
    state.progress[slug] = { chapter, frac, read: [...read], at: Date.now() };
    scheduleProgressWrite(slug);
  },
  flush() {
    return flushProgress();
  },
  get readerWidth() {
    return state.readerWidth;
  },
  setReaderWidth(n) {
    state.readerWidth = Math.min(1400, Math.max(400, +n || 800));
    putSettings();
    return state.readerWidth;
  },
  get sortNewest() {
    return state.sortNewest;
  },
  setSortNewest(v) {
    state.sortNewest = !!v;
    putSettings();
  },
  get trayOpen() {
    return state.trayOpen;
  },
  setTrayOpen(v) {
    state.trayOpen = !!v;
    putSettings();
  },
  get dismissedJobs() {
    return new Set(state.dismissedJobs);
  },
  dismissJob(id) {
    const set = new Set(state.dismissedJobs);
    set.add(id);
    state.dismissedJobs = [...set].slice(-200);
    putSettings();
  },
  undismissJob(id) {
    state.dismissedJobs = state.dismissedJobs.filter((x) => x !== id);
    putSettings();
  },
  get autoScroll() {
    return state.autoScroll;
  },
  /** Effective speed for a series/chapter, respecting persist scope. */
  autoScrollSpeed(slug, chapterId) {
    const a = state.autoScroll || defaultAutoScroll();
    if (a.persist === "chapter") {
      const key = `${slug}:${chapterId}`;
      if (a.byChapter[key] != null) return a.byChapter[key];
    }
    if (a.persist === "series" || a.persist === "chapter") {
      if (a.bySeries[slug] != null) return a.bySeries[slug];
    }
    return a.speed;
  },
  /**
   * Update speed + persist preference.
   * Writes into the active scope bucket so the next open of that chapter/series
   * (or globally) picks it up.
   */
  setAutoScroll({ speed, persist, slug, chapterId } = {}) {
    const a = normalizeAutoScroll(state.autoScroll);
    if (persist === "global" || persist === "series" || persist === "chapter") {
      a.persist = persist;
    }
    const n = speed != null ? Math.min(400, Math.max(10, Math.round(+speed))) : null;
    if (n != null) {
      if (a.persist === "chapter" && slug && chapterId != null) {
        a.byChapter[`${slug}:${chapterId}`] = n;
      } else if (a.persist === "series" && slug) {
        a.bySeries[slug] = n;
      } else {
        a.speed = n;
      }
    }
    state.autoScroll = a;
    putSettings();
    return a;
  },
};
