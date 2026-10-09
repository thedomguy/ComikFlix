import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { bg } from "../lib/format";
import { progressOf, resumeTarget, unreadCount } from "../lib/series";
import type { Series } from "../lib/types";

/** Netflix-style preview that pops over a card on desktop hover: banner, Continue / chapters /
 *  details buttons, current chapter, unread count, progress and genres. */
export function HoverCard({ s, anchor, onClose }: { s: Series; anchor: DOMRect; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const p = progressOf(s.slug);
  const r = resumeTarget(s);
  const idx = s.chapters.findIndex((c) => c.id === r.chapter);
  const unread = p ? unreadCount(s) : 0;
  const done = !!p && (p.read || []).includes(p.chapter) && p.chapter === r.chapter;
  const frac = p && p.chapter === r.chapter && !done ? Math.max(0, Math.min(1, p.frac || 0)) : 0;

  // Centre over the card, ~1.6x wider, kept inside the viewport.
  useLayoutEffect(() => {
    const width = Math.max(300, Math.min(380, anchor.width * 1.65));
    const h = box.current?.offsetHeight || 340;
    const left = Math.min(innerWidth - width - 12, Math.max(12, anchor.left + anchor.width / 2 - width / 2));
    const top = Math.min(innerHeight - h - 12, Math.max(12, anchor.top + anchor.height / 2 - h / 2));
    setPos({ left, top, width });
  }, [anchor]);

  // Any scroll (page or a row) moves the card out from under it: close.
  useEffect(() => {
    const close = () => onClose();
    addEventListener("scroll", close, { capture: true, passive: true });
    addEventListener("resize", close);
    return () => {
      removeEventListener("scroll", close, { capture: true });
      removeEventListener("resize", close);
    };
  }, [onClose]);

  const go = (hash: string) => {
    onClose();
    location.hash = hash;
  };

  return createPortal(
    <div
      ref={box}
      className={`hovercard${pos ? " in" : ""}`}
      style={pos ? { left: pos.left, top: pos.top, width: pos.width } : { left: -9999, top: 0, width: 340 }}
      onMouseLeave={onClose}
      // React bubbles portal events to the card underneath; its click would navigate too.
      onClick={(e) => e.stopPropagation()}
    >
      <div className="hc-art" style={{ backgroundImage: bg(s.backdrop || s.poster) }} onClick={() => go(`#/series/${s.slug}`)}>
        <b>{s.title}</b>
      </div>
      <div className="hc-body">
        <div className="hc-actions">
          <button className="hc-btn play" title={`${r.label} chapter ${r.chapter}`} onClick={() => go(`#/read/${s.slug}/${r.chapter}`)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" fill="currentColor" /></svg>
          </button>
          <button className="hc-btn" title="Chapters" onClick={() => go(`#/series/${s.slug}`)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
          <button className="hc-btn more" title="More info" onClick={() => go(`#/series/${s.slug}`)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
        <div className="hc-line">
          <b>{r.label === "Continue" ? `Ch. ${r.chapter}` : "Start reading"}</b>
          {s.status && <span className="hc-pill">{s.status}</span>}
          {unread > 0 && <span className="hc-muted">{unread} unread</span>}
        </div>
        {p && (
          <div className="hc-progress">
            <div className="hc-bar">
              <span style={{ width: `${frac * 100}%` }} />
            </div>
            <span className="hc-muted">
              {idx + 1} of {s.chapters.length}
            </span>
          </div>
        )}
        {s.genres.length > 0 && <div className="hc-genres">{s.genres.slice(0, 4).join(" • ")}</div>}
      </div>
    </div>,
    document.body
  );
}
