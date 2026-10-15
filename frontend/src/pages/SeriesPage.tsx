import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { bg, fmtDate, fmtSize } from "../lib/format";
import { startIngest, useIngestJobs, watchJob, type LiveJob } from "../lib/ingest";
import { useLibrary } from "../lib/library";
import { WEEKDAYS, chapterCount, dayTs, progressOf, resumeTarget, totalPages } from "../lib/series";
import { store } from "../lib/store";
import { toast } from "../lib/toast";
import type { ReleaseForecast, Series } from "../lib/types";
import { WatchControl } from "../components/watchlist/WatchControl";

/** Start chapter for "check for updates": the last owned chapter, or 1. */
function updateStartChapter(s: Series) {
  const max = s.chapters.reduce((m, c) => Math.max(m, parseFloat(c.id) || 0), 0);
  return Number.isFinite(max) && max > 0 ? max : 1;
}

function nextReleaseLabel(nr: ReleaseForecast) {
  const t = dayTs(nr.next_expected);
  if (isNaN(t)) return null;
  const days = Math.round((t - Date.now()) / 864e5);
  const rel = days > 1 ? `in ${days} days` : days === 1 ? "tomorrow" : days === 0 ? "today" : "overdue";
  return `~${fmtDate(new Date(t).toISOString())} (${rel}) · every ${WEEKDAYS[nr.release_day]}`;
}

/** #/series/<slug>: a modal over the home page on desktop, a full page on mobile. */
export default function SeriesPage({ slug, mode }: { slug: string; mode: "page" | "modal" }) {
  const { bySlug, refresh, progressVersion } = useLibrary();
  const s = bySlug(slug);
  const jobs = useIngestJobs();
  const close = () => (location.hash = "#/");

  useEffect(() => {
    if (mode !== "modal") {
      window.scrollTo(0, 0);
      return;
    }
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      removeEventListener("keydown", onKey);
    };
  }, [mode]);

  if (!s) return null;
  const sheet = <Sheet s={s} mode={mode} close={close} jobs={jobs} refresh={refresh} progressVersion={progressVersion} />;
  if (mode === "page") return <main className="series-page">{sheet}</main>;
  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && close()}>
      {sheet}
    </div>
  );
}

function Sheet({
  s,
  mode,
  close,
  jobs,
  refresh,
  progressVersion,
}: {
  s: Series;
  mode: "page" | "modal";
  close: () => void;
  jobs: LiveJob[];
  refresh: () => Promise<void>;
  progressVersion: number;
}) {
  const r = resumeTarget(s);
  // Finished series aren't checked for new chapters (set the status back to ongoing to resume).
  const ended = ["completed", "dropped"].includes((s.status || "").toLowerCase());
  const updating = jobs.some((j) => j.slug === s.slug && j.state === "running");
  const upToDate = useUpToDate(s.slug, jobs);
  const missing = s.remote_total != null ? Math.max(0, s.remote_total - s.chapters.length - (s.pending?.length || 0)) : 0;
  const nextRel = (s.status || "").toLowerCase() === "ongoing" && s.next_release ? nextReleaseLabel(s.next_release) : null;
  const alts = (s.alt_titles || []).slice(0, 3).join(" • ");

  return (
    <div className="sheet">
      <button className="close" onClick={close} aria-label={mode === "page" ? "Back" : "Close"}>
        {mode === "page" ? "← Back" : "✕"}
      </button>
      <div className="banner" style={{ backgroundImage: bg(s.backdrop) }}>
        <div>
          <h1>{s.title}</h1>
          <button className="btn play" onClick={() => (location.hash = `#/read/${s.slug}/${r.chapter}`)}>
            ▶ {r.label}
            {r.label === "Continue" ? ` Ch. ${r.chapter}` : ""}
          </button>
          {!ended && (
            <button
              className="btn info"
              disabled={updating}
              onClick={async () => {
                try {
                  const job = await startIngest({ series: s.slug, start_chapter: updateStartChapter(s) });
                  watchJob(job.id, "sync");
                } catch (e) {
                  toast(e instanceof Error ? e.message : "Could not start the update");
                }
              }}
            >
              {updating ? (
                <>
                  <span className="spin">⟳</span> Syncing…
                </>
              ) : upToDate ? (
                "✓ Up to date"
              ) : missing ? (
                `⟳ Update (${missing} new)`
              ) : (
                "⟳ Check for new chapters"
              )}
            </button>
          )}
        </div>
      </div>
      <div className="body">
        <WatchControl s={s} />
        <div className="cols">
          <div>
            <div className="meta">
              <span className="pill">{(s.status || "ongoing").replace(/^./, (c) => c.toUpperCase())}</span>
              <span>{chapterCount(s)} chapters</span>
              <span>{totalPages(s)} pages</span>
              {s.size ? <span>{fmtSize(s.size)}</span> : null}
              {s.rating ? <span>★ {Number(s.rating).toFixed(1)}</span> : null}
            </div>
            <p className="desc">{s.description || "No description yet. Use Update to fetch it from the source."}</p>
          </div>
          <div className="facts">
            {s.author && (
              <div>
                Author: <span>{s.author}</span>
              </div>
            )}
            {s.artist && (
              <div>
                Artist: <span>{s.artist}</span>
              </div>
            )}
            {s.type && (
              <div>
                Type: <span>{s.type}</span>
              </div>
            )}
            {s.genres.length > 0 && (
              <div>
                Genres: <span>{s.genres.join(", ")}</span>
              </div>
            )}
            <ReleaseDay s={s} refresh={refresh} />
            {nextRel && (
              <div>
                Next chapter: <span>{nextRel}</span>
              </div>
            )}
            {alts && (
              <div>
                Also known as: <span>{alts}</span>
              </div>
            )}
            {s.source_url && (
              <div>
                Source:{" "}
                <a href={s.source_url} target="_blank" rel="noreferrer">
                  {s.source === "mgeko" ? "mgeko" : "Asura Scans"}
                </a>
              </div>
            )}
          </div>
        </div>
        <ChapterList s={s} progressVersion={progressVersion} refresh={refresh} />
      </div>
    </div>
  );
}

/** True for a few seconds after this series' sync ends with no new chapters (the progress
 *  window only opens when a sync finds some). */
function useUpToDate(slug: string, jobs: LiveJob[]) {
  const [shown, setShown] = useState<string | null>(null);
  const last = jobs.find((j) => j.slug === slug); // newest first
  const nothingNew =
    !!last &&
    last.state === "done" &&
    Date.now() / 1000 - (last.finished || 0) < 10 &&
    !Object.values(last.chapters).some((c) => c.state !== "cached" && c.state !== "locked");
  const id = nothingNew ? last!.id : null;
  useEffect(() => {
    if (!id) return;
    setShown(id);
    const t = setTimeout(() => setShown(null), 4000);
    return () => clearTimeout(t);
  }, [id]);
  return !!id && shown === id;
}

/** The weekday chapters come out; unset, the latest chapter's weekday counts (server.next_release). */
function ReleaseDay({ s, refresh }: { s: Series; refresh: () => Promise<void> }) {
  const [value, setValue] = useState(s.release_day == null ? "" : String(s.release_day));
  const [hint, setHint] = useState<{ text: string; cls: string }>({ text: "", cls: "" });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const release_day = value === "" ? null : Number(value);
    setSaving(true);
    setHint({ text: "Saving…", cls: "" });
    try {
      await api(`/api/series/${encodeURIComponent(s.slug)}`, { method: "PATCH", json: { release_day } });
      setHint({ text: release_day == null ? "Cleared" : `Every ${WEEKDAYS[release_day]}`, cls: "ok" });
      toast("Release day updated");
      refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not save";
      setHint({ text: msg, cls: "err" });
      toast(msg);
    }
    setSaving(false);
  };

  return (
    <div className="release-row">
      <div className="release-label">Release day:</div>
      <div className="release-edit">
        <select className="release-input" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Release day">
          <option value="">Same as latest chapter</option>
          {WEEKDAYS.map((d, i) => (
            <option key={d} value={i}>
              {d}
            </option>
          ))}
        </select>
        <button type="button" className="release-save" disabled={saving} onClick={save}>
          Save
        </button>
        <span className={`release-hint${hint.cls ? ` ${hint.cls}` : ""}`}>{hint.text}</span>
      </div>
    </div>
  );
}

/** "Click to add": fetch a listed chapter's page URLs now; it then shows like any other. */
async function addChapter(s: Series, id: string, refresh: () => Promise<void>) {
  const r = await api<{ page_count: number }>(
    `/api/series/${encodeURIComponent(s.slug)}/chapters/${encodeURIComponent(id)}/add`,
    { method: "POST", json: {} }
  );
  await refresh();
  toast(`Chapter ${id} added (${r.page_count} pages)`);
}

function ChapterList({ s, progressVersion, refresh }: { s: Series; progressVersion: number; refresh: () => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [newest, setNewest] = useState<boolean>(store.sortNewest);
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const pending = s.pending || [];

  const rows = useMemo(() => {
    void progressVersion;
    const q = query.trim().toLowerCase();
    const idq = q.replace(/^ch(apter)?\.?\s*/, "");
    const match = (id: string, date: string | null) =>
      !q || id.startsWith(idq) || (/[a-z]/.test(q) && !!date && fmtDate(date).toLowerCase().includes(q));
    const list: { id: string; date: string | null; page_count?: number; pages?: unknown[]; toAdd?: boolean }[] = [
      ...s.chapters,
      ...pending.map((c) => ({ ...c, toAdd: true })),
    ].sort((a, b) => parseFloat(a.id) - parseFloat(b.id));
    if (newest) list.reverse();
    return list.filter((c) => match(c.id, c.date));
  }, [s, query, newest, progressVersion]);
  const total = s.chapters.length + pending.length;

  const add = async (id: string) => {
    if (adding.has(id)) return;
    setAdding((a) => new Set(a).add(id));
    try {
      await addChapter(s, id, refresh);
    } catch (e) {
      toast(e instanceof Error ? e.message : `Could not add chapter ${id}`);
    } finally {
      setAdding((a) => {
        const next = new Set(a);
        next.delete(id);
        return next;
      });
    }
  };

  const p = progressOf(s.slug);
  const read = useMemo(() => new Set(p?.read || []), [p]); // O(1) per row (saves replace `p`)
  return (
    <>
      <div className="chhead">
        <h3>
          {query.trim() ? `${rows.length} of ${total} Chapters` : `${total} Chapters`}
          {pending.length ? <small className="chpending"> · {pending.length} to add</small> : null}
        </h3>
        <button
          className="sortbtn"
          title="Toggle sort order"
          onClick={() => {
            store.setSortNewest(!newest);
            setNewest(!newest);
          }}
        >
          {newest ? "↓ Newest" : "↑ Oldest"}
        </button>
      </div>
      <input
        className="chsearch"
        type="search"
        placeholder="Search chapters..."
        autoComplete="off"
        aria-label="Search chapters"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className="chapters">
        {rows.length ? (
          rows.map((c) => {
            const done = read.has(c.id);
            const cur = p?.chapter === c.id && !done;
            const date = c.date ? fmtDate(c.date) : "";
            if (c.toAdd) {
              const busy = adding.has(c.id);
              return (
                <li key={c.id} className="toadd" onClick={() => add(c.id)}>
                  <div className="num">{c.id}</div>
                  <div className="t">
                    Chapter {c.id}
                    <small>{date || "Not added yet"}</small>
                  </div>
                  <div className={`badge${done ? " done" : ""}`}>
                    {done ? "✓ Read · " : ""}
                    <span className="addlbl">{busy ? "Adding…" : "+ Click to add"}</span>
                  </div>
                </li>
              );
            }
            const meta = `${c.page_count || c.pages?.length || 0} pages${date ? ` · ${date}` : ""}`;
            return (
              <li key={c.id} onClick={() => (location.hash = `#/read/${s.slug}/${c.id}`)}>
                <div className="num">{c.id}</div>
                <div className="t">
                  Chapter {c.id}
                  <small>{meta}</small>
                </div>
                <div className={`badge${done ? " done" : ""}`}>{done ? "✓ Read" : cur && p ? `${Math.round(p.frac * 100)}%` : ""}</div>
              </li>
            );
          })
        ) : (
          <li className="none">No chapters match</li>
        )}
      </ul>
    </>
  );
}
