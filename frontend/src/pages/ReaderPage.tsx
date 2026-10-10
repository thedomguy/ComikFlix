import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useLibrary } from "../lib/library";
import { withBase } from "../lib/paths";
import type { Chapter, Page, Series } from "../lib/types";
import { mountReader } from "../components/reader/mountReader";

// Pages fetched this session, so going back to a chapter doesn't refetch its list.
const pageCache = new Map<string, Page[]>();

type Load = { state: "loading" } | { state: "error" } | { state: "ready"; chap: Chapter };

/** #/read/<slug>/<chapter>. App keys this by slug/chapter, so each chapter is a fresh mount. */
export default function ReaderPage({ slug, chapter }: { slug: string; chapter: string }) {
  const { bySlug, refresh } = useLibrary();
  // Read the series once: the library context re-renders on every progress save while
  // reading, and nothing below may restart because of that.
  const [series, setSeries] = useState<Series | undefined>(() => bySlug(slug));
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const root = useRef<HTMLDivElement>(null);
  // A chapter added since this tab loaded the library (another device, or Jarvis opening a
  // "Click to add" chapter): reload the library once before giving up on it.
  const latest = useRef(bySlug);
  latest.current = bySlug;
  const [retried, setRetried] = useState(false);
  // A chapter the source lists but that was never added ("Click to add"), opened from
  // Continue, Next or a remote: add it first, then open it.
  const [adding, setAdding] = useState<"no" | "busy" | "done" | "failed">("no");

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  useEffect(() => {
    const chap = series?.chapters.find((c) => c.id === chapter);
    if (!series || !chap) {
      const fresh = retried ? latest.current(slug) : undefined;
      if (fresh && fresh !== series && fresh.chapters.some((c) => c.id === chapter)) {
        setSeries(fresh);
        return;
      }
      if (!retried) {
        refresh().finally(() => setRetried(true));
        return;
      }
      if (adding === "no" && (fresh || series)?.pending?.some((c) => c.id === chapter)) {
        setAdding("busy");
        api(`/api/series/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(chapter)}/add`, {
          method: "POST",
          json: {},
        })
          .then(() => refresh())
          .then(
            () => setAdding("done"),
            () => setAdding("failed")
          );
        return;
      }
      if (adding === "busy" || adding === "failed") return;
      location.hash = series ? `#/series/${series.slug}` : "#/";
      return;
    }
    const key = `${slug}/${chapter}`;
    const cached = chap.pages?.length ? chap.pages : pageCache.get(key);
    if (cached?.length) {
      setLoad({ state: "ready", chap: { ...chap, pages: cached } });
      return;
    }
    let alive = true;
    api<{ pages: Page[] }>(`/api/series/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(chapter)}`)
      .then((data) => {
        if (!data.pages?.length) throw new Error("no pages");
        const pages = data.pages.map((p) => ({ ...p, src: withBase(p.src) }));
        pageCache.set(key, pages);
        if (alive) setLoad({ state: "ready", chap: { ...chap, pages } });
      })
      .catch(() => alive && setLoad({ state: "error" }));
    return () => {
      alive = false;
    };
  }, [series, slug, chapter, retried, adding]);

  // Layout effect: the reader's cleanup measures the scroll pane to save progress, which
  // only works while its DOM is still attached.
  useLayoutEffect(() => {
    if (load.state !== "ready" || !series || !root.current) return;
    return mountReader(root.current, series, load.chap);
  }, [load, series]);

  return (
    <div className="reader" ref={root}>
      {load.state === "loading" && adding !== "failed" && (
        <div className="empty">{adding === "busy" ? `Adding chapter ${chapter}…` : "Loading chapter…"}</div>
      )}
      {adding === "failed" && <div className="empty">Could not add chapter {chapter}.</div>}
      {load.state === "error" && <div className="empty">Could not load chapter.</div>}
    </div>
  );
}
