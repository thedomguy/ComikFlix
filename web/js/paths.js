/** Public URL prefix when reverse-proxied under a subpath (e.g. /readers). Empty at site root. */
export const BASE = (() => {
  const dir = new URL(".", import.meta.url).pathname; // /readers/js/ or /js/
  return dir.replace(/\/js\/?$/, "").replace(/\/$/, "");
})();

/** Prefix a root-absolute path (/api/..., /media/...) with BASE. */
export function withBase(path) {
  if (!path || !path.startsWith("/") || path.startsWith("//")) return path;
  if (BASE && (path === BASE || path.startsWith(`${BASE}/`))) return path;
  return `${BASE}${path}`;
}

/** Rewrite page src URLs so they stay under the subpath when proxied. */
export function fixPages(pages) {
  return (pages || []).map((p) => ({ ...p, src: withBase(p.src) }));
}

/** Rewrite library media URLs so they stay under the subpath. */
export function fixLibrary(library) {
  return (library || []).map((s) => ({
    ...s,
    poster: withBase(s.poster),
    backdrop: withBase(s.backdrop),
    chapters: (s.chapters || []).map((c) => ({
      ...c,
      pages: c.pages ? fixPages(c.pages) : c.pages,
    })),
  }));
}
