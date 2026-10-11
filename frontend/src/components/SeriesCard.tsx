import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { bg } from "../lib/format";
import { HoverCard } from "./HoverCard";
import { chapterCount, lastListedId, newSinceRead, progressOf, resumeTarget, unreadCount } from "../lib/series";
import type { Series } from "../lib/types";

/** Poster card used by home rows, the library grid and search. Shows reading progress and,
 *  for started series, unread / new-chapter badges. */
export function SeriesCard({ s, onClick, titleOnly }: { s: Series; onClick?: () => void; titleOnly?: boolean }) {
  const p = progressOf(s.slug);
  const unread = p ? unreadCount(s) : 0;
  const fresh = p ? newSinceRead(s) : 0;
  const total = chapterCount(s);
  const hover = useHoverPreview();
  return (
    <div
      className="card"
      onMouseEnter={hover.enter}
      onMouseLeave={hover.leave}
      role="link"
      tabIndex={0}
      style={{ backgroundImage: bg(s.poster) }}
      onClick={onClick ?? (() => (location.hash = `#/series/${s.slug}`))}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLElement).click()}
    >
      {titleOnly ? null : fresh > 0 ? (
        <span className="card-badge new">{fresh} new</span>
      ) : unread > 0 ? (
        <span className="card-badge">{unread} unread</span>
      ) : null}
      <div className="cap">
        <b>{s.title}</b>
        {!titleOnly && <span>{p ? `Ch. ${resumeTarget(s).chapter} of ${lastListedId(s)}` : `${total} chapter${total === 1 ? "" : "s"}`}</span>}
      </div>
      {p && <div className="bar" style={{ width: `${Math.min(100, Math.round((100 * (p.read?.length || 0)) / total))}%` }} />}
      {hover.rect && <HoverCard s={s} anchor={hover.rect} onClose={hover.close} />}
    </div>
  );
}

const HOVER_DELAY = 400; // ms resting on a card before the preview opens
const finePointer = () => matchMedia("(hover: hover) and (pointer: fine)").matches;

/** Desktop-only hover preview: opens after a short rest; the preview closes itself when the
 *  pointer leaves it (it covers the card, so the card's own mouseleave fires right away). */
function useHoverPreview() {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const timer = useRef(0);
  const enter = useCallback((e: MouseEvent<HTMLElement>) => {
    if (!finePointer()) return;
    const el = e.currentTarget;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setRect(el.getBoundingClientRect()), HOVER_DELAY);
  }, []);
  const leave = useCallback(() => clearTimeout(timer.current), []);
  const close = useCallback(() => {
    clearTimeout(timer.current);
    setRect(null);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { rect, enter, leave, close };
}
