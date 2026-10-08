import { bg } from "../../lib/format";
import { chapterLabel, itemHref, STYLE_LABEL, type DayItem, type EventStyle } from "./util";

function badge(it: DayItem) {
  return it.style === "overdue" && it.manual ? "Overdue · set by you" : STYLE_LABEL[it.style];
}

function tip(it: DayItem) {
  const n = it.chapters.length;
  return `${it.title} — ${chapterLabel(it.chapters)}${n > 1 ? ` (${n} chapters)` : ""} · ${badge(it)}`;
}

/** Full row: day lists and the agenda. */
export function EventRow({ it, when }: { it: DayItem; when?: string }) {
  return (
    <a className={`cal-ev cal-${it.style}`} href={itemHref(it)} title={tip(it)}>
      <span className="cal-cover" style={{ backgroundImage: bg(it.poster) }} />
      <span className="cal-ev-text">
        <b>{it.title}</b>
        <span>
          {chapterLabel(it.chapters)}
          {when && <> · {when}</>}
        </span>
      </span>
      <span className="cal-badge">{badge(it)}</span>
    </a>
  );
}

/** Compact chip inside a month-grid cell (desktop). */
export function EventChip({ it }: { it: DayItem }) {
  return (
    <a className={`cal-chip cal-${it.style}`} href={itemHref(it)} title={tip(it)} onClick={(e) => e.stopPropagation()}>
      <span className="cal-cover" style={{ backgroundImage: bg(it.poster) }} />
      <span className="cal-chip-text">
        <b>{it.title}</b>
        <span>{chapterLabel(it.chapters)}</span>
      </span>
    </a>
  );
}

/** Poster tile for the "This week" strip. */
export function EventTile({ it, when }: { it: DayItem; when: string }) {
  return (
    <a className={`cal-tile cal-${it.style}`} href={itemHref(it)} title={tip(it)}>
      <span className="cal-tile-poster" style={{ backgroundImage: bg(it.poster) }}>
        <span className="cal-badge">{badge(it)}</span>
      </span>
      <b>{it.title}</b>
      <span>
        {chapterLabel(it.chapters)} · {when}
      </span>
    </a>
  );
}

const LEGEND: { style: EventStyle; text: string }[] = [
  { style: "released", text: "Released" },
  { style: "manual", text: "Set by you" },
  { style: "forecast", text: "Expected" },
  { style: "overdue", text: "Overdue (expected, not out yet)" },
];

export function Legend() {
  return (
    <ul className="cal-legend" aria-label="Legend">
      {LEGEND.map((l) => (
        <li key={l.style}>
          <i className={`cal-swatch cal-${l.style}`} />
          {l.text}
        </li>
      ))}
    </ul>
  );
}
