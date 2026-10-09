import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { thumb } from "./format";
import { withBase } from "./paths";
import { store } from "./store";
import type { Series } from "./types";

interface LibraryState {
  library: Series[];
  ready: boolean;
  error: string | null;
  /** Re-fetch /api/library (after an ingest, a release-date edit, ...). */
  refresh: () => Promise<void>;
  bySlug: (slug: string | undefined) => Series | undefined;
  /** Bumped whenever progress is saved; read it in a component to re-render on progress. */
  progressVersion: number;
}

const Ctx = createContext<LibraryState | null>(null);

function fixLibrary(list: Series[]): Series[] {
  return list.map((s) => {
    // Parse chapter dates once here; series.ts (unread/new counts, sorting, calendar) reads `ts`.
    // The list is fresh JSON, so filling the field in place is safe.
    for (const c of s.chapters) c.ts = c.date ? Date.parse(c.date) || 0 : 0;
    return {
      ...s,
      // Covers go through the CDN resizer (cards ~190px wide, hero/banner full width).
      poster: thumb(withBase(s.poster), 400) ?? null,
      backdrop: thumb(withBase(s.backdrop), 1280) ?? null,
    };
  });
}

const fetchLibrary = async () => fixLibrary(await api<Series[]>("/api/library"));

/** Library request started at boot (main.tsx), consumed by LibraryProvider's first refresh(). */
let early: Promise<Series[] | null> | null = null;

/** Start /api/library and the settings/progress bootstrap right away, in parallel with App's
 *  /api/me check, instead of after it. A 401 still opens the login (api() fires LOGIN_EVENT). */
export function preloadLibrary() {
  if (early) return;
  early = fetchLibrary().catch(() => null); // failed: the provider fetches again (and reports the error)
  void store.bootstrap();
}

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [library, setLibrary] = useState<Series[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressVersion, setProgressVersion] = useState(0);
  const ref = useRef<Series[]>([]);

  const refresh = useCallback(async () => {
    try {
      const pre = early;
      early = null; // only the first refresh may use the boot request; later ones refetch
      const data = (pre && (await pre)) || (await fetchLibrary());
      ref.current = data;
      setLibrary(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the library");
    }
  }, []);

  useEffect(() => {
    // Settings + progress must be ready before any page reads the store.
    Promise.all([store.bootstrap(), refresh()]).finally(() => setReady(true));
    const onProgress = () => setProgressVersion((v) => v + 1);
    window.addEventListener("comikflix:progress", onProgress);
    return () => window.removeEventListener("comikflix:progress", onProgress);
  }, [refresh]);

  const bySlug = useCallback((slug: string | undefined) => ref.current.find((s) => s.slug === slug), []);

  const value = useMemo(
    () => ({ library, ready, error, refresh, bySlug, progressVersion }),
    [library, ready, error, refresh, bySlug, progressVersion],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLibrary() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLibrary outside LibraryProvider");
  return v;
}

/** Current library for non-React code (screen.js). */
export let libraryRef: { current: Series[] } = { current: [] };
export function LibraryRefSync() {
  const { library } = useLibrary();
  libraryRef.current = library;
  return null;
}
