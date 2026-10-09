/** Public URL prefix when served under a subpath (nginx: /readers). Empty at the site root.
 *  Derived from the page URL (the bundle lives in /assets/, so import.meta.url won't do). */
export const BASE = location.pathname.replace(/\/[^/]*$/, "").replace(/\/$/, "");

/** Prefix a root-absolute path (/api/..., /assets/...) with BASE. */
export function withBase(path: string): string;
export function withBase(path: string | null | undefined): string | null | undefined;
export function withBase(path: string | null | undefined) {
  if (!path || !path.startsWith("/") || path.startsWith("//")) return path;
  if (BASE && (path === BASE || path.startsWith(`${BASE}/`))) return path;
  return `${BASE}${path}`;
}
