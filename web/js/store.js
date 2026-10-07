/** Unified single-user settings + reading progress (localStorage). */

const KEY = "comicflix";
const LEGACY = {
  width: "comicflix-width",
  sort: "comicflix-sort",
  dismissed: "comicflix-dismissed",
};

const defaults = () => ({
  progress: {},
  readerWidth: 800,
  sortNewest: true,
  dismissedJobs: [],
  trayOpen: true,
  v: 1,
});

function readRaw() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    return null;
  }
}

function migrate() {
  let data = readRaw();
  if (data && data.v === 1 && data.progress) return data;

  const next = defaults();

  // Old format: comicflix was { [slug]: { chapter, frac, read, at } }
  if (data && !data.v && typeof data === "object") {
    const looksLikeProgress = Object.values(data).some(
      (v) => v && typeof v === "object" && ("chapter" in v || "read" in v)
    );
    if (looksLikeProgress) next.progress = data;
  } else if (data?.progress) {
    Object.assign(next, data);
  }

  try {
    const w = +(localStorage.getItem(LEGACY.width) || "");
    if (Number.isFinite(w) && w > 0) next.readerWidth = Math.min(1400, Math.max(400, w));
  } catch {}
  try {
    const s = localStorage.getItem(LEGACY.sort) || "";
    if (s === "oldest" || s.endsWith("-asc")) next.sortNewest = false;
    else if (s) next.sortNewest = true;
  } catch {}
  try {
    const d = JSON.parse(localStorage.getItem(LEGACY.dismissed) || "[]");
    if (Array.isArray(d)) next.dismissedJobs = d.slice(-200);
  } catch {}

  next.v = 1;
  try {
    localStorage.removeItem(LEGACY.width);
    localStorage.removeItem(LEGACY.sort);
    localStorage.removeItem(LEGACY.dismissed);
  } catch {}
  return next;
}

let state = migrate();

function write(s) {
  if (s) state = s;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {}
}

// Persist migrated shape once at boot
write();

export const store = {
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
    write();
  },
  get readerWidth() {
    return state.readerWidth;
  },
  setReaderWidth(n) {
    state.readerWidth = Math.min(1400, Math.max(400, +n || 800));
    write();
    return state.readerWidth;
  },
  get sortNewest() {
    return state.sortNewest;
  },
  setSortNewest(v) {
    state.sortNewest = !!v;
    write();
  },
  get trayOpen() {
    return state.trayOpen;
  },
  setTrayOpen(v) {
    state.trayOpen = !!v;
    write();
  },
  get dismissedJobs() {
    return new Set(state.dismissedJobs);
  },
  dismissJob(id) {
    const set = new Set(state.dismissedJobs);
    set.add(id);
    state.dismissedJobs = [...set].slice(-200);
    write();
  },
  undismissJob(id) {
    state.dismissedJobs = state.dismissedJobs.filter((x) => x !== id);
    write();
  },
};
