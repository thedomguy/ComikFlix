import { useEffect, useMemo, useRef, useState } from "react";
import { dayKey } from "../lib/format";
import { useLibrary } from "../lib/library";
import { go } from "../lib/route";
import { progressOf, releaseEvents, type ReleaseEvent } from "../lib/series";
import { Agenda, DayList, dayAnchor } from "../components/calendar/Agenda";
import { Legend } from "../components/calendar/EventItem";
import { MonthGrid } from "../components/calendar/MonthGrid";
import { WeekStrip } from "../components/calendar/WeekStrip";
import { addDays, fromDayKey, gridRange, groupByDay, monthKey, parseMonth, shiftMonth, type DayItem } from "../components/calendar/util";
import "../styles/calendar.css";

type View = "month" | "agenda";
interface Prefs {
  view: View;
  reading: boolean;
  released: boolean;
  upcoming: boolean;
}

const PREFS_KEY = "comikflix:calendar:v2"; // v2: month (with dots) became the default everywhere

function loadPrefs(): Prefs {
  const def: Prefs = { view: "month", reading: false, released: true, upcoming: true };
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
    if (!raw || typeof raw !== "object") return def;
    return {
      view: raw.view === "month" || raw.view === "agenda" ? raw.view : def.view,
      reading: typeof raw.reading === "boolean" ? raw.reading : def.reading,
      released: typeof raw.released === "boolean" ? raw.released : def.released,
      upcoming: typeof raw.upcoming === "boolean" ? raw.upcoming : def.upcoming,
    };
  } catch {
    return def;
  }
}

/** #/calendar[/YYYY-MM]: released chapters, dates set by the user, and forecasts. */
export default function CalendarPage({ month }: { month?: string }) {
  const { library, progressVersion } = useLibrary();
  const { y, m0 } = parseMonth(month);
  const mk = monthKey(y, m0);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [selected, setSelected] = useState<{ mk: string; k: string } | null>(null);
  const scrollToToday = useRef(false);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* private mode / storage blocked: prefs just don't persist */
    }
  }, [prefs]);
  const set = (p: Partial<Prefs>) => setPrefs((cur) => ({ ...cur, ...p }));

  const todayKey = dayKey(new Date());
  const today = useMemo(() => fromDayKey(todayKey), [todayKey]);

  const range = useMemo(() => gridRange(y, m0), [y, m0]);
  const events = useMemo(() => releaseEvents(library, range.from, range.to), [library, range]);
  const weekEvents = useMemo(() => releaseEvents(library, addDays(today, -7), addDays(today, 8)), [library, today]);

  // progressVersion: "Reading only" must follow progress saved while the page is open.
  const readingOk = useMemo(() => {
    void progressVersion;
    const reading = new Set(library.filter((s) => progressOf(s.slug)).map((s) => s.slug));
    return (e: ReleaseEvent) => !prefs.reading || reading.has(e.slug);
  }, [library, prefs.reading, progressVersion]);

  const byDay = useMemo(
    () => groupByDay(events.filter((e) => readingOk(e) && (e.kind === "released" ? prefs.released : prefs.upcoming))),
    [events, readingOk, prefs.released, prefs.upcoming]
  );

  // The strip always shows both directions; only "Reading only" applies to it.
  const week = useMemo(() => {
    const nowMs = Date.now();
    const up = groupByDay(weekEvents.filter((e) => e.kind !== "released" && readingOk(e)));
    const out = groupByDay(weekEvents.filter((e) => e.kind === "released" && +e.date <= nowMs && readingOk(e)));
    const flat = (m: Map<string, DayItem[]>, desc: boolean) =>
      [...m.keys()].sort((a, b) => (desc ? b.localeCompare(a) : a.localeCompare(b))).flatMap((k) => m.get(k)!);
    return { upcoming: flat(up, false), recent: flat(out, true) };
  }, [weekEvents, readingOk]);

  const inMonth = (k: string) => k.startsWith(`${mk}-`);
  const monthKeys = [...byDay.keys()].filter(inMonth);
  const monthItems = monthKeys.flatMap((k) => byDay.get(k)!);
  const todayInMonth = inMonth(todayKey);
  const agendaKeys = [...new Set([...monthKeys, ...(todayInMonth ? [todayKey] : [])])].sort();
  const sel = selected?.mk === mk ? selected.k : todayInMonth ? todayKey : null;
  const monthEnd = new Date(y, m0 + 1, 1);
  const noForecasts = prefs.upcoming && +monthEnd > Date.now() && !monthItems.some((it) => it.style !== "released");

  useEffect(() => {
    if (!scrollToToday.current) return;
    scrollToToday.current = false;
    requestAnimationFrame(() => document.getElementById(dayAnchor(todayKey))?.scrollIntoView({ block: "start" }));
  }, [mk, prefs.view, todayKey]);

  const goToday = () => {
    const now = new Date();
    const cur = monthKey(now.getFullYear(), now.getMonth());
    setSelected({ mk: cur, k: todayKey });
    if (prefs.view === "agenda") {
      if (cur === mk) document.getElementById(dayAnchor(todayKey))?.scrollIntoView({ block: "start" });
      else scrollToToday.current = true;
    }
    if (cur !== mk) go(`#/calendar/${cur}`);
  };

  const title = new Date(y, m0, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });

  let empty: string | null = null;
  if (!library.length) empty = "Your library is empty — add a series to see its releases here.";
  else if (!prefs.released && !prefs.upcoming) empty = "Released and upcoming are both hidden.";
  else if (!monthItems.length) empty = prefs.reading ? "No releases this month for series you're reading." : "No releases this month.";

  return (
    <main className="cal">
      <header className="cal-head">
        <div className="cal-title">
          <button className="cal-nav" onClick={() => go(`#/calendar/${shiftMonth(y, m0, -1)}`)} aria-label="Previous month">
            ‹
          </button>
          <h1>{title}</h1>
          <button className="cal-nav" onClick={() => go(`#/calendar/${shiftMonth(y, m0, 1)}`)} aria-label="Next month">
            ›
          </button>
          <button className="cal-btn" onClick={goToday}>
            Today
          </button>
        </div>
        <div className="cal-seg" role="group" aria-label="View">
          <button className={prefs.view === "month" ? "on" : ""} aria-pressed={prefs.view === "month"} onClick={() => set({ view: "month" })}>
            Month
          </button>
          <button className={prefs.view === "agenda" ? "on" : ""} aria-pressed={prefs.view === "agenda"} onClick={() => set({ view: "agenda" })}>
            Agenda
          </button>
        </div>
      </header>

      <div className="cal-filters">
        <div className="cal-seg" role="group" aria-label="Series">
          <button className={!prefs.reading ? "on" : ""} aria-pressed={!prefs.reading} onClick={() => set({ reading: false })}>
            All series
          </button>
          <button className={prefs.reading ? "on" : ""} aria-pressed={prefs.reading} onClick={() => set({ reading: true })}>
            Reading only
          </button>
        </div>
        <button className={`cal-toggle${prefs.released ? " on" : ""}`} aria-pressed={prefs.released} onClick={() => set({ released: !prefs.released })}>
          Released
        </button>
        <button className={`cal-toggle${prefs.upcoming ? " on" : ""}`} aria-pressed={prefs.upcoming} onClick={() => set({ upcoming: !prefs.upcoming })}>
          Upcoming
        </button>
      </div>

      {library.length > 0 && <WeekStrip upcoming={week.upcoming} recent={week.recent} today={today} />}

      <Legend />

      {empty && <p className="cal-empty">{empty}</p>}
      {noForecasts && library.length > 0 && (
        <p className="cal-note">
          No expected releases this month. Completed series never get a forecast; ongoing ones need a few dated chapters, or a
          release date set on the series page.
        </p>
      )}

      {prefs.view === "month" ? (
        <>
          <MonthGrid
            m0={m0}
            from={range.from}
            days={range.days}
            byDay={byDay}
            todayKey={todayKey}
            selected={sel}
            onSelect={(k) => setSelected({ mk, k })}
          />
          {sel && <DayList k={sel} items={byDay.get(sel) || []} today={today} />}
        </>
      ) : (
        !empty && <Agenda keys={agendaKeys} byDay={byDay} today={today} todayKey={todayKey} />
      )}
    </main>
  );
}
