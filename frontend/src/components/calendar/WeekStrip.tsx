import { EventTile } from "./EventItem";
import { relDay, type DayItem } from "./util";

/** "This week": what's coming in the next 7 days (incl. overdue) and what came out in the last 7. */
export function WeekStrip({ upcoming, recent, today }: { upcoming: DayItem[]; recent: DayItem[]; today: Date }) {
  return (
    <section className="cal-week" aria-label="This week">
      <div className="cal-week-col">
        <h2>Coming up · next 7 days</h2>
        {upcoming.length ? (
          <div className="cal-track">
            {upcoming.map((it) => (
              <EventTile key={it.key} it={it} when={relDay(it.date, today)} />
            ))}
          </div>
        ) : (
          <p className="cal-none">Nothing expected this week.</p>
        )}
      </div>
      <div className="cal-week-col">
        <h2>Out · last 7 days</h2>
        {recent.length ? (
          <div className="cal-track">
            {recent.map((it) => (
              <EventTile key={it.key} it={it} when={relDay(it.date, today)} />
            ))}
          </div>
        ) : (
          <p className="cal-none">No new chapters this week.</p>
        )}
      </div>
    </section>
  );
}
