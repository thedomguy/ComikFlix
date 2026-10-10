import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api } from "../lib/api";
import { bg } from "../lib/format";
import { findChapter, parseChapterQuery, searchLibrary } from "../lib/filters";
import { startIngest } from "../lib/ingest";
import { useLibrary } from "../lib/library";
import { byReadingOrder, progressOf, resumeTarget, unreadCount } from "../lib/series";
import { toast } from "../lib/toast";
import type { CatalogHit, Series } from "../lib/types";
import { NewEntry, type Draft } from "../components/watchlist/EntryEditor";
import { STATUS_LABEL, entryForSlug, useWatchlist } from "../lib/watchlist";
import "../styles/search.css";

const RECENT_KEY = "comikflix:recent-searches";

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

function saveRecent(q: string) {
  try {
    const list = [q, ...loadRecent().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage blocked: just don't remember */
  }
}

/** A selectable result: keyboard navigation walks these in order. */
interface Item {
  key: string;
  group: "library" | "chapters" | "catalog";
  open: () => void;
  node: ReactNode;
}

/** Asura results exist only for the query the user explicitly searched (`for`). */
type Catalog = { state: "idle" | "loading" | "error"; for: string; hits: CatalogHit[]; error?: string };

/** #/search?q= — library, chapters and the Asura catalogue in one box ("/" from anywhere). */
export default function SearchPage({ q: initial }: { q: string }) {
  const { library, progressVersion } = useLibrary();
  const [q, setQ] = useState(initial);
  const [active, setActive] = useState(0);
  const [catalog, setCatalog] = useState<Catalog>({ state: "idle", for: "", hits: [] });
  const [added, setAdded] = useState<Record<string, "adding" | "added">>({});
  const [listDraft, setListDraft] = useState<Draft | null>(null);
  const { entries } = useWatchlist();
  const input = useRef<HTMLInputElement>(null);
  const query = q.trim();

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    history.replaceState(null, "", query ? `#/search?q=${encodeURIComponent(query)}` : "#/search");
    setActive(0);
  }, [query]);

  // Asura Scans is only searched when asked (button / Enter on it), never while typing.
  const searchAsura = () => {
    if (query.length < 2) return;
    const forQ = query;
    setCatalog({ state: "loading", for: forQ, hits: [] });
    api<CatalogHit[]>(`/api/catalog?q=${encodeURIComponent(forQ)}`)
      .then((hits) => setCatalog((c) => (c.for === forQ ? { state: "idle", for: forQ, hits } : c)))
      .catch((e) =>
        setCatalog((c) =>
          c.for === forQ ? { state: "error", for: forQ, hits: [], error: e instanceof Error ? e.message : "Search failed" } : c
        )
      );
  };
  const asuraDone = catalog.for === query && catalog.state === "idle";

  const owned = useMemo(() => new Set(library.map((s) => s.slug)), [library]);

  const items = useMemo<Item[]>(() => {
    void progressVersion;
    if (!query) return [];
    const out: Item[] = [];
    const remember = () => saveRecent(query);

    // Chapters: "sword sense 52" -> that chapter of the best-matching series.
    const cq = parseChapterQuery(query);
    if (cq) {
      for (const { s } of searchLibrary(library, cq.rest, 0.45).slice(0, 3)) {
        const c = findChapter(s, cq.num);
        if (!c) continue;
        out.push({
          key: `ch:${s.slug}:${c.id}`,
          group: "chapters",
          open: () => {
            remember();
            location.hash = `#/read/${s.slug}/${c.id}`;
          },
          node: <Row s={s} title={`${s.title} · Chapter ${c.id}`} sub={c.date ? new Date(c.date).toLocaleDateString() : "Open chapter"} />,
        });
      }
    }

    const hits = searchLibrary(library, cq && out.length ? cq.rest : query).slice(0, 12);
    // Started series in the results also get a direct "Continue" entry.
    for (const { s } of hits.slice(0, 3)) {
      if (!progressOf(s.slug) || unreadCount(s) === 0) continue;
      const r = resumeTarget(s);
      if (out.some((i) => i.key === `ch:${s.slug}:${r.chapter}`)) continue;
      out.push({
        key: `cont:${s.slug}`,
        group: "chapters",
        open: () => {
          remember();
          location.hash = `#/read/${s.slug}/${r.chapter}`;
        },
        node: <Row s={s} title={`Continue ${s.title}`} sub={`Chapter ${r.chapter}`} />,
      });
    }
    for (const { s } of hits) {
      out.push({
        key: `s:${s.slug}`,
        group: "library",
        open: () => {
          remember();
          location.hash = `#/series/${s.slug}`;
        },
        node: (
          <Row
            s={s}
            title={s.title}
            sub={[s.status, `${s.chapters.length} chapters`, progressOf(s.slug) ? `${unreadCount(s)} unread` : null].filter(Boolean).join(" · ")}
          />
        ),
      });
    }

    if (query.length >= 2 && catalog.for !== query) {
      out.push({
        key: "asura-search",
        group: "catalog",
        open: searchAsura,
        node: (
          <div className="sr-row">
            <span className="sr-cover sr-cover-none">⌕</span>
            <span className="sr-text">
              <b>Search Asura Scans for “{query}”</b>
              <small>Find comics that aren’t in your library yet</small>
            </span>
          </div>
        ),
      });
    }
    for (const h of (catalog.for === query ? catalog.hits : []).filter((h) => !owned.has(h.slug)).slice(0, 8)) {
      const state = added[h.slug];
      const onList = entryForSlug(h.slug);
      const add = async () => {
        if (state) return;
        remember();
        setAdded((a) => ({ ...a, [h.slug]: "adding" }));
        try {
          await startIngest({ series: h.slug, start_chapter: 1 });
          setAdded((a) => ({ ...a, [h.slug]: "added" }));
          toast(`Adding ${h.title} — downloading in the background`);
        } catch (e) {
          setAdded((a) => {
            const { [h.slug]: _, ...rest } = a;
            return rest;
          });
          toast(e instanceof Error ? e.message : "Could not add it");
        }
      };
      out.push({
        key: `cat:${h.slug}`,
        group: "catalog",
        open: add,
        node: (
          <div className="sr-row">
            <span className="sr-cover sr-cover-none">+</span>
            <span className="sr-text">
              <b>{h.title}</b>
              <small>Asura Scans · not in your library</small>
            </span>
            {onList ? (
              <a className="sr-listed" href={`#/list/${onList.id}`} onClick={(e) => e.stopPropagation()}>
                {STATUS_LABEL[onList.status]}
              </a>
            ) : (
              <button
                className="sr-list"
                title="Add to your watch list without downloading"
                onClick={(e) => {
                  e.stopPropagation();
                  setListDraft({ asura: h.slug, title: h.title });
                }}
              >
                + List
              </button>
            )}
            {state === "added" ? (
              <a className="sr-added" href="#/downloads" onClick={(e) => e.stopPropagation()}>
                Added — downloading ›
              </a>
            ) : (
              <span className="sr-add">{state === "adding" ? "Adding…" : "Download"}</span>
            )}
          </div>
        ),
      });
    }
    return out;
  }, [query, library, catalog, owned, added, progressVersion, entries]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      items[active]?.open();
    } else if (e.key === "Escape") {
      if (q) setQ("");
      else history.back();
    }
  };

  useEffect(() => {
    document.querySelector(".sr-item.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const groups: { id: Item["group"]; label: string }[] = [
    { id: "chapters", label: "Chapters" },
    { id: "library", label: "Your library" },
    { id: "catalog", label: "Add from Asura Scans" },
  ];

  return (
    <main className="sr">
      <div className="sr-box">
        <input
          ref={input}
          className="sr-input"
          type="search"
          placeholder="Search comics, chapters (e.g. “sword sense 52”), or Asura Scans"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          aria-label="Search"
          autoComplete="off"
        />
      </div>

      {!query ? (
        <EmptyState library={library} onPick={setQ} />
      ) : (
        <div className="sr-results">
          {groups.map((g) => {
            const list = items.filter((i) => i.group === g.id);
            const catalogNote =
              g.id === "catalog" && catalog.for === query
                ? catalog.state === "loading"
                  ? <p className="sr-note">Searching Asura Scans…</p>
                  : catalog.state === "error"
                    ? (
                        <p className="sr-note err">
                          Couldn’t search Asura Scans ({catalog.error}).{" "}
                          <button className="sr-linkbtn" onClick={searchAsura}>Retry</button>
                        </p>
                      )
                    : asuraDone && !list.length
                      ? <p className="sr-note">Nothing new on Asura Scans for “{query}”.</p>
                      : null
                : null;
            if (!list.length && !catalogNote) return null;
            return (
              <section key={g.id} className="sr-group">
                <h2>{g.label}</h2>
                {list.map((it) => {
                  const idx = items.indexOf(it);
                  return (
                    <div
                      key={it.key}
                      className={`sr-item${idx === active ? " active" : ""}`}
                      role="button"
                      tabIndex={-1}
                      onMouseEnter={() => setActive(idx)}
                      onClick={it.open}
                    >
                      {it.node}
                    </div>
                  );
                })}
                {catalogNote}
              </section>
            );
          })}
          {!items.some((i) => i.group !== "catalog") && <p className="sr-note">No matches in your library.</p>}
        </div>
      )}
      {listDraft && <NewEntry draft={listDraft} onClose={() => setListDraft(null)} onDone={() => setListDraft(null)} />}
    </main>
  );
}

function Row({ s, title, sub }: { s: Series; title: string; sub: string }) {
  return (
    <div className="sr-row">
      <span className="sr-cover" style={{ backgroundImage: bg(s.poster) }} />
      <span className="sr-text">
        <b>{title}</b>
        <small>{sub}</small>
      </span>
    </div>
  );
}

function EmptyState({ library, onPick }: { library: Series[]; onPick: (q: string) => void }) {
  const recent = loadRecent();
  const reading = library
    .filter((s) => progressOf(s.slug))
    .sort(byReadingOrder)
    .slice(0, 6);
  return (
    <div className="sr-empty">
      {recent.length > 0 && (
        <section className="sr-group">
          <h2>Recent searches</h2>
          <div className="sr-chips">
            {recent.map((r) => (
              <button key={r} className="sr-chip" onClick={() => onPick(r)}>
                {r}
              </button>
            ))}
          </div>
        </section>
      )}
      {reading.length > 0 && (
        <section className="sr-group">
          <h2>Continue reading</h2>
          {reading.map((s) => {
            const r = resumeTarget(s);
            return (
              <a key={s.slug} className="sr-item" href={`#/read/${s.slug}/${r.chapter}`}>
                <Row s={s} title={s.title} sub={`Chapter ${r.chapter}`} />
              </a>
            );
          })}
        </section>
      )}
      <section className="sr-group">
        <h2>Go to</h2>
        <div className="sr-chips">
          <a className="sr-chip" href="#/library">Library</a>
          <a className="sr-chip" href="#/calendar">Release calendar</a>
          <a className="sr-chip" href="#/downloads">Downloads</a>
        </div>
      </section>
    </div>
  );
}
