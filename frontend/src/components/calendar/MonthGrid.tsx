import { dayKey } from "../../lib/format";
import { EventChip } from "./EventItem";
import { addDays, longDay, type DayItem, type EventStyle } from "./util";

const MAX_CHIPS = 3;
const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: "short" }), // 2024-01-01 is a Monday
);
const DOT_ORDER: EventStyle[] = ["overdue", "manual", "forecast", "released"];

interface Props {
  m0: number;
  from: Date;
  days: number;
  byDay: Map<string, DayItem[]>;
  todayKey: string;
  selected: string | null;
  onSelect: (key: string) => void;
}

/** Mon–Sun month grid. Desktop cells list chips (collapsing to "+N more"); on mobile the CSS
 *  swaps chips for per-kind dots + a count, and tapping a day opens its list below. */
export function MonthGrid({ m0, from, days, byDay, todayKey, selected, onSelect }: Props) {
  const cells = Array.from({ length: days }, (_, i) => addDays(from, i));
  return (
    <div className="cal-grid">
      {WEEKDAYS.map((w) => (
        <div key={w} className="cal-wd">
          {w}
        </div>
      ))}
      {cells.map((d) => {
        const k = dayKey(d);
        const items = byDay.get(k) || [];
        const over = items.length > MAX_CHIPS;
        const shown = over ? items.slice(0, MAX_CHIPS - 1) : items;
        const styles = new Set(items.map((it) => it.style));
        const cls = [
          "cal-cell",
          d.getMonth() !== m0 && "out",
          k === todayKey && "today",
          k === selected && "sel",
          items.length > 0 && "has",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div key={k} className={cls} onClick={() => onSelect(k)}>
            <button
              className="cal-num"
              aria-label={`${longDay(d)}: ${items.length ? `${items.length} release${items.length === 1 ? "" : "s"}` : "no releases"}`}
              aria-pressed={k === selected}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(k);
              }}
            >
              {d.getDate()}
            </button>
            {items.length > 0 && (
              <>
                <div className="cal-chips">
                  {shown.map((it) => (
                    <EventChip key={it.key} it={it} />
                  ))}
                  {over && (
                    <button
                      className="cal-more"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(k);
                      }}
                    >
                      +{items.length - shown.length} more
                    </button>
                  )}
                </div>
                <div className="cal-dots" aria-hidden="true">
                  {DOT_ORDER.filter((s) => styles.has(s)).map((s) => (
                    <span key={s} className={`cal-dot cal-${s}`} />
                  ))}
                  {items.length > 1 && <span>{items.length}</span>}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
