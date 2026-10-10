import { useMemo, type ReactNode } from "react";
import { bg, fmtSize } from "../lib/format";
import { useLibrary } from "../lib/library";
import { byReadingOrder, latestDate, newSinceRead, progressOf, releaseEvents, resumeTarget, totalPages, type ReleaseEvent } from "../lib/series";
import { SeriesCard } from "../components/SeriesCard";
import { WatchCard } from "../components/watchlist/WatchCard";
import { useWatchlist } from "../lib/watchlist";
import "../styles/home.css";

const DAY = 86400000;

function Row({ title, link, children }: { title: string; link?: { href: string; label: string }; children: ReactNode }) {
  return (
    <section className="row">
      <h2>
        {title}
        {link && (
          <a className="row-link" href={link.href}>
            {link.label}
          </a>
        )}
      </h2>
      <div className="track">{children}</div>
    </section>
  );
}

function whenLabel(d: Date) {
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / DAY);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

/** #/ — hero (most recently read) and rows built for a growing library. */
export default function HomePage() {
  const { library, progressVersion } = useLibrary();
  const { entries } = useWatchlist();

  // Library-only rows: don't rebuild these (release forecast, sorts) on every progress save.
  const libRows = useMemo(() => {
    const now = new Date();
    // One card per series: its earliest upcoming release this week.
    const week = new Map<string, ReleaseEvent>();
    for (const e of releaseEvents(library, new Date(+now - DAY), new Date(+now + 7 * DAY))) {
      if (e.kind !== "released" && !week.has(e.slug)) week.set(e.slug, e);
    }
    const recent = [...library].sort((a, b) => latestDate(b) - latestDate(a)).slice(0, 20);
    const genres = [...new Set(library.flatMap((s) => s.genres))].sort();
    const byGenre = new Map(genres.map((g) => [g, library.filter((s) => s.genres.includes(g))]));
    const bySlug = new Map(library.map((s) => [s.slug, s]));
    return { week: [...week.values()], recent, genres, byGenre, bySlug };
  }, [library]);

  const rows = useMemo(() => {
    void progressVersion; // progress decides these rows
    const started = library.filter((s) => progressOf(s.slug)).sort(byReadingOrder);
    const fresh = started.filter((s) => newSinceRead(s) > 0);
    return { ...libRows, started, fresh };
  }, [library, libRows, progressVersion]);

  // Watch list "Reading": what the user says they're reading, downloaded or not.
  const reading = useMemo(() => {
    const bySlug = new Map(library.map((s) => [s.slug, s]));
    return entries
      .filter((e) => e.status === "reading")
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((e) => ({ e, s: e.in_library && e.asura_slug ? bySlug.get(e.asura_slug) : undefined }));
  }, [entries, library]);

  if (!library.length) {
    return (
      <main className="home">
        <div className="empty">
          <h2>Your library is empty</h2>
          <p>Use “+ Add” to add a comic from Asura Scans, or search for one.</p>
        </div>
      </main>
    );
  }

  const hero = rows.started[0] || library[0];
  const r = resumeTarget(hero);
  const { bySlug } = rows;

  return (
    <main className="home">
      <header className="hero" style={{ backgroundImage: bg(hero.backdrop) }}>
        <div>
          <h1>{hero.title}</h1>
          <div className="meta">
            <span className="pill">{hero.status || "Ongoing"}</span>
            <span>{hero.chapters.length} chapters</span>
            <span>{totalPages(hero)} pages</span>
            {hero.size ? <span>{fmtSize(hero.size)}</span> : null}
          </div>
          {hero.description && <p>{hero.description}</p>}
          <button className="btn play" onClick={() => (location.hash = `#/read/${hero.slug}/${r.chapter}`)}>
            ▶ {r.label}
          </button>
          <button className="btn info" onClick={() => (location.hash = `#/series/${hero.slug}`)}>
            ⓘ More Info
          </button>
        </div>
      </header>

      <div className="rows">
        {rows.started.length > 0 && (
          <Row title="Continue Reading">
            {rows.started.map((s) => (
              <SeriesCard key={s.slug} s={s} />
            ))}
          </Row>
        )}
        {reading.length > 0 && (
          <Row title="Your Watch List · Reading" link={{ href: "#/list?status=reading", label: "Watch List →" }}>
            {reading.map(({ e, s }) => (s ? <SeriesCard key={e.id} s={s} /> : <WatchCard key={e.id} e={e} />))}
          </Row>
        )}
        {rows.fresh.length > 0 && (
          <Row title="New chapters since you last read">
            {rows.fresh.map((s) => (
              <SeriesCard key={s.slug} s={s} onClick={() => (location.hash = `#/read/${s.slug}/${resumeTarget(s).chapter}`)} />
            ))}
          </Row>
        )}
        {rows.week.length > 0 && (
          <Row title="Releasing this week" link={{ href: "#/calendar", label: "Calendar →" }}>
            {rows.week.map((e) => {
              const s = bySlug.get(e.slug);
              return s ? (
                <div key={e.slug} className="rel-card">
                  <SeriesCard s={s} />
                  <div className={`rel-when ${e.kind}${e.overdue ? " overdue" : ""}`}>
                    <b>{whenLabel(e.date)}</b> · Ch. {e.chapter} · {e.kind === "manual" ? "set by you" : "expected"}
                  </div>
                </div>
              ) : null;
            })}
          </Row>
        )}
        <Row title="Recently updated">
          {rows.recent.map((s) => (
            <SeriesCard key={s.slug} s={s} />
          ))}
        </Row>
        <Row title="All Comics" link={{ href: "#/library", label: "Browse all →" }}>
          {library.map((s) => (
            <SeriesCard key={s.slug} s={s} />
          ))}
        </Row>
        {rows.genres.map((g) => (
          <Row key={g} title={g} link={{ href: `#/library?genre=${encodeURIComponent(g)}`, label: "See all →" }}>
            {(rows.byGenre.get(g) || []).map((s) => (
              <SeriesCard key={s.slug} s={s} />
            ))}
          </Row>
        ))}
      </div>
    </main>
  );
}
