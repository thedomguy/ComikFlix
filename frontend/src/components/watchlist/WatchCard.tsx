import { bg, thumb } from "../../lib/format";
import type { WatchEntry } from "../../lib/types";
import { IconCloud } from "../icons";
import { Stars } from "../Stars";

/** Home-row card for a watch list entry that isn't in the library (opens the entry). */
export function WatchCard({ e }: { e: WatchEntry }) {
  const cover = thumb(e.cover_url, 400);
  return (
    <a className="card wl-card" href={`#/list/${e.id}`} style={{ backgroundImage: bg(cover) }}>
      {!cover && <span className="cover-text">{e.title.slice(0, 1)}</span>}
      <span className="card-ico" title="Not downloaded" aria-label="Not downloaded">
        <IconCloud />
      </span>
      <div className="cap">
        <b>{e.title}</b>
        {e.rating ? <Stars value={e.rating} size={12} /> : <span>{e.chapters_total ? `${e.chapters_total} chapters` : "Not downloaded"}</span>}
      </div>
    </a>
  );
}
