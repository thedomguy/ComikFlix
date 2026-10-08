import { bg } from "../lib/format";
import { newSinceRead, progressOf, unreadCount } from "../lib/series";
import type { Series } from "../lib/types";

/** Poster card used by home rows, the library grid and search. Shows reading progress and,
 *  for started series, unread / new-chapter badges. */
export function SeriesCard({ s, onClick }: { s: Series; onClick?: () => void }) {
  const p = progressOf(s.slug);
  const unread = p ? unreadCount(s) : 0;
  const fresh = p ? newSinceRead(s) : 0;
  return (
    <div
      className="card"
      role="link"
      tabIndex={0}
      style={{ backgroundImage: bg(s.poster) }}
      onClick={onClick ?? (() => (location.hash = `#/series/${s.slug}`))}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLElement).click()}
    >
      {fresh > 0 ? (
        <span className="card-badge new">{fresh} new</span>
      ) : unread > 0 ? (
        <span className="card-badge">{unread} unread</span>
      ) : null}
      <div className="cap">
        <b>{s.title}</b>
        <span>
          {s.chapters.length} chapter{s.chapters.length === 1 ? "" : "s"}
        </span>
      </div>
      {p && <div className="bar" style={{ width: `${Math.round((100 * (p.read?.length || 0)) / s.chapters.length)}%` }} />}
    </div>
  );
}
