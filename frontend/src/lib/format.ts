export const bg = (url: string | null | undefined) => (url ? `url("${url}")` : undefined);

/** Kill switch for the cover resizer below (false: always load the original image). */
const RESIZE = true;
const ASURA_CDN = "https://cdn.asurascans.com/";

/** Cover/backdrop thumbnail through Asura's Cloudflare image resizer (~160 KB -> ~40 KB).
 *  Other URLs (R2, ...) pass through unchanged. Not for reader pages. */
export function thumb(url: string, w: number): string;
export function thumb(url: string | null | undefined, w: number): string | null | undefined;
export function thumb(url: string | null | undefined, w: number) {
  if (!RESIZE || !url || !url.startsWith(ASURA_CDN) || url.includes("/cdn-cgi/")) return url;
  return `${ASURA_CDN}cdn-cgi/image/width=${w},quality=75,format=auto/${url.slice(ASURA_CDN.length)}`;
}

export function fmtSize(n: number | null | undefined) {
  if (n == null || !(n >= 0)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** One shared formatter: toLocaleDateString builds a new one on every call (slow in long lists). */
const DATE_FMT = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

export function fmtDate(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(+d) ? "" : DATE_FMT.format(d);
}

/** "3h ago", "2d ago", or a date for older. */
export function ago(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d ago`;
  return DATE_FMT.format(new Date(ms));
}

/** Local YYYY-MM-DD for a Date (calendar keys). */
export function dayKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
