import { useEffect, useMemo, useState } from "react";
import { ago, bg, fmtDate } from "../lib/format";
import {
  activeFilterCount,
  DEFAULT_VIEW,
  facets,
  filterLibrary,
  libraryQueryString,
  parseLibraryQuery,
  sortLibrary,
  SORTS,
  type LibraryView,
  type SortKey,
} from "../lib/filters";
import { useLibrary } from "../lib/library";
import { latestChapter, progressOf, unreadCount } from "../lib/series";
import type { Series } from "../lib/types";
import { SeriesCard } from "../components/SeriesCard";
import { FilterPanel } from "../components/library/FilterPanel";
import "../styles/library.css";

/** #/library — every series with text filter, facets, sorting and grid/list views.
 *  The view lives in the hash query so it can be linked; edits use replaceState. */
export default function LibraryPage({ query }: { query: URLSearchParams }) {
  const { library, progressVersion } = useLibrary();
  const [v, setV] = useState<LibraryView>(() => parseLibraryQuery(query));
  const [drawer, setDrawer] = useState(false);

  // A real navigation to another #/library?... link resets the view to that link.
  const qs = query.toString();
  useEffect(() => setV(parseLibraryQuery(new URLSearchParams(qs))), [qs]);

  const update = (patch: Partial<LibraryView>) =>
    setV((cur) => {
      const next = { ...cur, ...patch };
      history.replaceState(null, "", `#/library${libraryQueryString(next)}`);
      return next;
    });

  const opts = useMemo(() => facets(library), [library]);
  const shown = useMemo(() => {
    void progressVersion;
    return sortLibrary(filterLibrary(library, v), v.sort);
  }, [library, v, progressVersion]);
  const nFilters = activeFilterCount(v);

  return (
    <main className="lib">
      <header className="lib-head">
        <h1>Library</h1>
        <span className="lib-count">
          {shown.length === library.length ? `${library.length} series` : `${shown.length} of ${library.length} series`}
        </span>
      </header>

      <div className="lib-bar">
        <input
          className="lib-q"
          type="search"
          placeholder="Filter by title, author, genre…"
          value={v.q}
          onChange={(e) => update({ q: e.target.value })}
          aria-label="Filter library"
        />
        <select className="lib-sort" value={v.sort} onChange={(e) => update({ sort: e.target.value as SortKey })} aria-label="Sort">
          {SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <div className="lib-seg" role="group" aria-label="View">
          <button className={v.view === "grid" ? "on" : ""} aria-pressed={v.view === "grid"} onClick={() => update({ view: "grid" })} title="Grid">
            ▦
          </button>
          <button className={v.view === "list" ? "on" : ""} aria-pressed={v.view === "list"} onClick={() => update({ view: "list" })} title="List">
            ☰
          </button>
        </div>
        <button className="lib-filters-btn" onClick={() => setDrawer(true)}>
          Filters{nFilters ? ` (${nFilters})` : ""}
        </button>
      </div>

      <div className="lib-body">
        <aside className={`lib-side${drawer ? " open" : ""}`} onClick={(e) => e.target === e.currentTarget && setDrawer(false)}>
          <div className="lib-side-inner">
            <div className="lib-side-head">
              <b>Filters</b>
              {(nFilters > 0 || v.q) && (
                <button className="lib-linkbtn" onClick={() => update({ ...DEFAULT_VIEW, sort: v.sort, view: v.view })}>
                  Clear filters
                </button>
              )}
            </div>
            <FilterPanel v={v} facets={opts} onChange={update} />
            <button className="lib-show" onClick={() => setDrawer(false)}>
              Show {shown.length} result{shown.length === 1 ? "" : "s"}
            </button>
          </div>
        </aside>

        <section className="lib-results">
          {!shown.length ? (
            <div className="lib-empty">
              <p>No series match these filters.</p>
              <button className="lib-linkbtn" onClick={() => update({ ...DEFAULT_VIEW, sort: v.sort, view: v.view })}>
                Clear filters
              </button>
            </div>
          ) : v.view === "grid" ? (
            <div className="lib-grid">
              {shown.map((s) => (
                <SeriesCard key={s.slug} s={s} />
              ))}
            </div>
          ) : (
            <ListView list={shown} sort={v.sort} onSort={(sort) => update({ sort })} />
          )}
        </section>
      </div>
    </main>
  );
}

function ListView({ list, sort, onSort }: { list: Series[]; sort: SortKey; onSort: (s: SortKey) => void }) {
  const th = (label: string, key?: SortKey) =>
    key ? (
      <button className={`lib-th${sort === key ? " on" : ""}`} onClick={() => onSort(key)}>
        {label}
      </button>
    ) : (
      <span className="lib-th">{label}</span>
    );
  return (
    <div className="lib-list">
      <div className="lib-row lib-row-h">
        <span />
        {th("Title", "title")}
        {th("Status")}
        {th("Chapters", "chapters")}
        {th("Unread", "unread")}
        {th("Last read", "recent")}
        {th("Latest", "latest")}
        {th("Rating", "rating")}
      </div>
      {list.map((s) => {
        const p = progressOf(s.slug);
        const last = latestChapter(s);
        return (
          <a key={s.slug} className="lib-row" href={`#/series/${s.slug}`}>
            <span className="lib-cover" style={{ backgroundImage: bg(s.poster) }} />
            <span className="lib-title">
              <b>{s.title}</b>
              <small>{[s.type, (s.genres || []).slice(0, 3).join(", ")].filter(Boolean).join(" · ")}</small>
            </span>
            <span className="lib-c lib-status">{s.status || "—"}</span>
            <span className="lib-c">{s.chapters.length}</span>
            <span className="lib-c">{p ? unreadCount(s) : "—"}</span>
            <span className="lib-c">{p ? ago(p.at) : "Not started"}</span>
            <span className="lib-c">{last?.date ? `Ch. ${last.id} · ${fmtDate(last.date)}` : last ? `Ch. ${last.id}` : "—"}</span>
            <span className="lib-c">{s.rating ? `★ ${Number(s.rating).toFixed(1)}` : "—"}</span>
          </a>
        );
      })}
    </div>
  );
}
