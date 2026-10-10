import { useEffect, useMemo, useState } from "react";
import { bg, thumb } from "../lib/format";
import { useLibrary } from "../lib/library";
import { toast } from "../lib/toast";
import type { WatchEntry, WatchStatus } from "../lib/types";
import { STATUSES, STATUS_LABEL, entryById, seriesStatusOf, suggestFor, updateEntry, useWatchlist } from "../lib/watchlist";
import { IconCloud } from "../components/icons";
import { Stars } from "../components/Stars";
import { AddEntry } from "../components/watchlist/AddEntry";
import { EditEntry } from "../components/watchlist/EntryEditor";
import "../styles/library.css";

type Sort = "updated" | "rating" | "title" | "added";
const SORTS: { key: Sort; label: string }[] = [
  { key: "updated", label: "Recently changed" },
  { key: "rating", label: "Your rating" },
  { key: "title", label: "Title" },
  { key: "added", label: "Recently added" },
];
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** #/list[?status=&sort=] and #/list/<id> (that entry's editor open), #/list/new (add). */
export default function WatchlistPage({ id, query }: { id?: string; query: URLSearchParams }) {
  const { entries, ready, error } = useWatchlist();
  const { bySlug, progressVersion } = useLibrary();
  const [status, setStatus] = useState<WatchStatus>(() => (STATUSES as string[]).includes(query.get("status") || "") ? (query.get("status") as WatchStatus) : "reading");
  const [sort, setSort] = useState<Sort>(() => (SORTS.some((s) => s.key === query.get("sort")) ? (query.get("sort") as Sort) : "updated"));
  const [q, setQ] = useState("");

  // A real navigation to another #/list?... link (Home's "Watch List →", Back) resets the view.
  const qStatus = query.get("status");
  const qSort = query.get("sort");
  useEffect(() => {
    if (qStatus && (STATUSES as string[]).includes(qStatus)) setStatus(qStatus as WatchStatus);
    if (SORTS.some((s) => s.key === qSort)) setSort(qSort as Sort);
  }, [qStatus, qSort]);

  const setView = (next: { status?: WatchStatus; sort?: Sort }) => {
    const st = next.status ?? status;
    const so = next.sort ?? sort;
    setStatus(st);
    setSort(so);
    history.replaceState(null, "", `#/list?status=${st}${so !== "updated" ? `&sort=${so}` : ""}`);
  };

  const counts = useMemo(() => {
    const c = { reading: 0, plan: 0, completed: 0 } as Record<WatchStatus, number>;
    for (const e of entries) c[e.status]++;
    return c;
  }, [entries]);

  const shown = useMemo(() => {
    void progressVersion; // suggestions follow reading progress
    const words = norm(q).split(" ").filter(Boolean);
    const list = entries.filter(
      (e) => e.status === status && (!words.length || words.every((w) => norm([e.title, ...e.alt_titles, e.notes || ""].join(" ")).includes(w))),
    );
    const by: Record<Sort, (a: WatchEntry, b: WatchEntry) => number> = {
      updated: (a, b) => b.updated_at.localeCompare(a.updated_at),
      added: (a, b) => b.created_at.localeCompare(a.created_at),
      rating: (a, b) => (b.rating || 0) - (a.rating || 0) || a.title.localeCompare(b.title),
      title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
    };
    return list.sort(by[sort]);
  }, [entries, status, sort, q, progressVersion]);

  const close = () => (location.hash = `#/list?status=${status}`);
  const open = (e: WatchEntry) => (location.hash = `#/list/${e.id}`);
  const editing = id && id !== "new" ? entryById(id) : undefined;

  return (
    <main className="wl">
      <header className="wl-top">
        <h1>Watch List</h1>
        <span className="wl-count">{entries.length ? `${entries.length} series` : ""}</span>
        <a className="addbtn wl-add" href="#/list/new">
          + Add to List
        </a>
      </header>

      <div className="wl-tabs" role="tablist" aria-label="Status">
        {STATUSES.map((st) => (
          <button key={st} role="tab" aria-selected={status === st} className={status === st ? "on" : ""} onClick={() => setView({ status: st })}>
            {STATUS_LABEL[st]} <span className="n">{counts[st]}</span>
          </button>
        ))}
      </div>

      <div className="wl-bar">
        <input className="lib-q" type="search" placeholder="Filter by title or notes" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter" />
        <select className="lib-sort" value={sort} onChange={(e) => setView({ sort: e.target.value as Sort })} aria-label="Sort">
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {!ready ? null : error && !entries.length ? (
        <div className="empty">Could not load your watch list ({error}).</div>
      ) : !entries.length ? (
        <div className="empty">
          <h2>Your watch list is empty</h2>
          <p>Add the series you’re reading, have read, or want to read, downloaded or not.</p>
          <a className="btn play" href="#/list/new">
            + Add a series
          </a>
        </div>
      ) : !shown.length ? (
        <p className="wl-none">{q ? "Nothing matches." : `Nothing in ${STATUS_LABEL[status]} yet.`}</p>
      ) : (
        <ul className="wl-list">
          {shown.map((e) => (
            <EntryRow key={e.id} e={e} onOpen={() => open(e)} lib={e.in_library ? bySlug(e.asura_slug || undefined) : undefined} />
          ))}
        </ul>
      )}

      {id === "new" && <AddEntry onClose={close} onOpen={open} />}
      {editing && <EditEntry key={editing.id} entry={editing} onClose={close} />}
      {id && id !== "new" && ready && !editing && <MissingEntry onClose={close} />}
    </main>
  );
}

function MissingEntry({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    toast("That watch list entry no longer exists");
    onClose();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function EntryRow({ e, onOpen, lib }: { e: WatchEntry; onOpen: () => void; lib: ReturnType<ReturnType<typeof useLibrary>["bySlug"]> }) {
  const [busy, setBusy] = useState(false);
  const suggestion = suggestFor(e, lib);
  const ss = seriesStatusOf(e, lib);
  const cover = lib?.poster || thumb(e.cover_url, 200);
  const total = e.chapters_total ?? lib?.chapters.length ?? null;
  const progress = e.progress?.chapter ? `Ch. ${e.progress.chapter}${total ? ` of ${total}` : ""}` : total ? `${total} ch.` : null;
  return (
    <li className="wl-item" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(ev) => ev.key === "Enter" && onOpen()}>
      <span className="wl-cover" style={{ backgroundImage: bg(cover) }}>
        {!cover && <span>{e.title.slice(0, 1)}</span>}
      </span>
      <span className="wl-item-text">
        <b>
          {e.title}
          {!e.in_library && (
            <span className="wl-nodl-ico" title="Not downloaded" aria-label="Not downloaded">
              <IconCloud />
            </span>
          )}
        </b>
        <small>{[ss ? ss.replace(/^./, (c) => c.toUpperCase()) : null, e.type, progress].filter(Boolean).join(" · ")}</small>
        {e.rating ? <Stars value={e.rating} size={14} /> : <small className="wl-unrated">Not rated</small>}
        {e.notes && <small className="wl-notes">{e.notes}</small>}
        {suggestion && (
          <button
            className="wl-chip"
            disabled={busy}
            onClick={async (ev) => {
              ev.stopPropagation();
              setBusy(true);
              try {
                await updateEntry(e.id, { status: suggestion.status });
                toast(`${e.title} moved to ${STATUS_LABEL[suggestion.status]}`);
              } catch (err) {
                toast(err instanceof Error ? err.message : "Could not move it");
              }
              setBusy(false);
            }}
          >
            {suggestion.reason} · Move to {STATUS_LABEL[suggestion.status]}
          </button>
        )}
      </span>
    </li>
  );
}
