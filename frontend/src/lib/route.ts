import { useEffect, useState } from "react";

/** Hash routes (kept from the original app; Jarvis and the remote send these):
 *  #/  #/library  #/search?q=  #/calendar[/YYYY-MM]  #/series/<slug>  #/read/<slug>/<chapter>
 *  #/remote[/<screenId>]  #/downloads */
export interface Route {
  view: string; // "" (home), "library", "search", "calendar", "series", "read", "remote", "downloads"
  parts: string[]; // path segments after the view, decoded
  query: URLSearchParams;
}

export function parseHash(hash = location.hash): Route {
  const raw = hash.replace(/^#/, "");
  const [path, qs = ""] = raw.split("?");
  const segs = path.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  return { view: segs[0] || "", parts: segs.slice(1), query: new URLSearchParams(qs) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash());
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function go(hash: string) {
  location.hash = hash;
}

export const isMobile = () => window.matchMedia("(max-width: 700px)").matches;
