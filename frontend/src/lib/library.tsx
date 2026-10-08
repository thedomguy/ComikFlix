import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
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
  return list.map((s) => ({
    ...s,
    poster: withBase(s.poster) ?? null,
    backdrop: withBase(s.backdrop) ?? null,
  }));
}

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [library, setLibrary] = useState<Series[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressVersion, setProgressVersion] = useState(0);
  const ref = useRef<Series[]>([]);

  const refresh = useCallback(async () => {
    try {
      const data = fixLibrary(await api<Series[]>("/api/library"));
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

  return <Ctx.Provider value={{ library, ready, error, refresh, bySlug, progressVersion }}>{children}</Ctx.Provider>;
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
