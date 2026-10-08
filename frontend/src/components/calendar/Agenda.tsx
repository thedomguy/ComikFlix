import { EventRow } from "./EventItem";
import { fromDayKey, longDay, relDay, type DayItem } from "./util";

export const dayAnchor = (k: string) => `cal-day-${k}`;

function DayHeading({ k, today }: { k: string; today: Date }) {
  const d = fromDayKey(k);
  const rel = relDay(d, today);
  const near = rel === "Today" || rel === "Tomorrow" || rel === "Yesterday";
  return (
    <h3 className="cal-day-h">
      {near && <em>{rel}</em>}
      {longDay(d)}
    </h3>
  );
}

/** The list for one day (below the grid, or one agenda group). */
export function DayList({ k, items, today, id }: { k: string; items: DayItem[]; today: Date; id?: string }) {
  return (
    <section className="cal-day" id={id}>
      <DayHeading k={k} today={today} />
      {items.length ? (
        <div className="cal-list">
          {items.map((it) => (
            <EventRow key={it.key} it={it} />
          ))}
        </div>
      ) : (
        <p className="cal-none">Nothing on this day.</p>
      )}
    </section>
  );
}

/** Day-grouped list for the month. Today always gets a group so "Today" has somewhere to land. */
export function Agenda({ keys, byDay, today, todayKey }: { keys: string[]; byDay: Map<string, DayItem[]>; today: Date; todayKey: string }) {
  return (
    <div className="cal-agenda">
      {keys.map((k) => (
        <div key={k} className={k === todayKey ? "cal-agenda-today" : undefined}>
          <DayList k={k} items={byDay.get(k) || []} today={today} id={dayAnchor(k)} />
        </div>
      ))}
    </div>
  );
}
