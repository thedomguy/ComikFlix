import { useMemo, useState } from "react";
import { api } from "../../lib/api";
import { bg } from "../../lib/format";
import { searchLibrary } from "../../lib/filters";
import { useLibrary } from "../../lib/library";
import type { CatalogHit, WatchEntry } from "../../lib/types";
import { STATUS_LABEL, entryForSlug, useWatchlist } from "../../lib/watchlist";
import { IconCloud } from "../icons";
import { Modal, NewEntry, type Draft } from "./EntryEditor";

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Pick what to add: a library series, an Asura series (not downloaded), or any title by hand.
 *  Anything already on the list opens its entry instead (onOpen). */
export function AddEntry({ onClose, onOpen, initial = "" }: { onClose: () => void; onOpen: (e: WatchEntry) => void; initial?: string }) {
  const { library } = useLibrary();
  const { entries } = useWatchlist();
  const [q, setQ] = useState(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [cat, setCat] = useState<{ for: string; state: "idle" | "loading" | "error"; hits: CatalogHit[]; error?: string }>({
    for: "",
    state: "idle",
    hits: [],
  });
  const query = q.trim();

  const byTitle = useMemo(() => {
    const m = new Map<string, WatchEntry>();
    for (const e of entries) for (const t of [e.title, ...e.alt_titles]) m.set(norm(t), e);
    return m;
  }, [entries]);

  const libHits = useMemo(() => (query ? searchLibrary(library, query).slice(0, 8).map((r) => r.s) : []), [library, query]);
  const asuraHits = cat.for === query ? cat.hits.filter((h) => !libHits.some((s) => s.slug === h.slug)) : [];
  const exact = byTitle.get(norm(query));

  const searchAsura = async () => {
    const forQ = query;
    setCat({ for: forQ, state: "loading", hits: [] });
    try {
      const hits = await api<CatalogHit[]>(`/api/catalog?q=${encodeURIComponent(forQ)}`);
      setCat((c) => (c.for === forQ ? { for: forQ, state: "idle", hits } : c));
    } catch (e) {
      setCat((c) => (c.for === forQ ? { for: forQ, state: "error", hits: [], error: e instanceof Error ? e.message : "failed" } : c));
    }
  };

  if (draft) return <NewEntry draft={draft} onClose={onClose} onDone={onOpen} />;

  const Onlist = ({ e }: { e: WatchEntry }) => <span className="wl-pick-on">On list · {STATUS_LABEL[e.status]}</span>;

  return (
    <Modal onClose={onClose} label="Add to watch list">
      <div className="wl-form">
        <h2 className="wl-title">Add to Watch List</h2>
        <input
          className="wl-search"
          type="search"
          autoFocus
          placeholder="Title of any series"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && query.length >= 2 && cat.for !== query && searchAsura()}
          aria-label="Title"
        />
        {query && (
          <div className="wl-picks">
            {libHits.map((s) => {
              const on = entryForSlug(s.slug);
              return (
                <button
                  key={s.slug}
                  className="wl-pick"
                  onClick={() =>
                    on ? onOpen(on) : setDraft({ asura: s.slug, title: s.title, cover: s.poster, series_status: s.status, in_library: true })
                  }
                >
                  <span className="wl-pick-cover" style={{ backgroundImage: bg(s.poster) }} />
                  <span className="wl-pick-text">
                    <b>{s.title}</b>
                    <small>In your library · {s.status || "status unknown"}</small>
                  </span>
                  {on && <Onlist e={on} />}
                </button>
              );
            })}
            {asuraHits.map((h) => {
              const on = entryForSlug(h.slug);
              return (
                <button key={h.slug} className="wl-pick" onClick={() => (on ? onOpen(on) : setDraft({ asura: h.slug, title: h.title }))}>
                  <span className="wl-pick-cover none">
                    <IconCloud />
                  </span>
                  <span className="wl-pick-text">
                    <b>{h.title}</b>
                    <small>Asura Scans · not downloaded</small>
                  </span>
                  {on && <Onlist e={on} />}
                </button>
              );
            })}
            {query.length >= 2 && cat.for !== query && (
              <button className="wl-pick" onClick={searchAsura}>
                <span className="wl-pick-cover none">⌕</span>
                <span className="wl-pick-text">
                  <b>Search Asura Scans for “{query}”</b>
                  <small>Adds its details only; nothing is downloaded</small>
                </span>
              </button>
            )}
            {cat.for === query && cat.state === "loading" && <p className="wl-hint">Searching Asura Scans…</p>}
            {cat.for === query && cat.state === "error" && <p className="wl-hint err">Couldn’t search Asura Scans ({cat.error}).</p>}
            {cat.for === query && cat.state === "idle" && !asuraHits.length && <p className="wl-hint">Nothing else on Asura Scans for “{query}”.</p>}
            {exact ? (
              <button className="wl-pick" onClick={() => onOpen(exact)}>
                <span className="wl-pick-cover none">✓</span>
                <span className="wl-pick-text">
                  <b>{exact.title}</b>
                  <small>Already on your watch list</small>
                </span>
                <Onlist e={exact} />
              </button>
            ) : (
              <button className="wl-pick" onClick={() => setDraft({ title: query })}>
                <span className="wl-pick-cover none">+</span>
                <span className="wl-pick-text">
                  <b>Add “{query}” by hand</b>
                  <small>For series that aren’t on Asura Scans</small>
                </span>
              </button>
            )}
          </div>
        )}
        {!query && <p className="wl-hint">Search your library and Asura Scans, or add any title by hand.</p>}
      </div>
    </Modal>
  );
}
