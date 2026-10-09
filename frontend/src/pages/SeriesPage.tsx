import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { bg, fmtDate, fmtSize } from "../lib/format";
import { startIngest, useIngestJobs } from "../lib/ingest";
import { useLibrary } from "../lib/library";
import { progressOf, resumeTarget, totalPages } from "../lib/series";
import { store } from "../lib/store";
import { toast } from "../lib/toast";
import type { ReleaseForecast, Series } from "../lib/types";

/** Start chapter for "check for updates": the last owned chapter, or 1. */
function updateStartChapter(s: Series) {
  const max = s.chapters.reduce((m, c) => Math.max(m, parseFloat(c.id) || 0), 0);
  return Number.isFinite(max) && max > 0 ? max : 1;
}

/** API/ISO date -> YYYY-MM-DD for <input type="date">. */
function toDateInput(val: string | null) {
  if (!val) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(val)) return val.slice(0, 10);
  const d = new Date(val);
  if (isNaN(+d)) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nextReleaseLabel(nr: ReleaseForecast) {
  const t = Date.parse(nr.next_expected);
  if (isNaN(t)) return null;
  const days = Math.round((t - Date.now()) / 864e5);
  const rel = days > 1 ? `in ${days} days` : days === 1 ? "tomorrow" : days === 0 ? "today" : "overdue";
  return `~${fmtDate(nr.next_expected)} (${rel}) · about every ${nr.interval_days} days`;
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
  jobs: { slug: string; state: string }[];
  refresh: () => Promise<void>;
  progressVersion: number;
}) {
  const r = resumeTarget(s);
  const updating = jobs.some((j) => j.slug === s.slug && j.state === "running");
  const missing = s.remote_total != null ? Math.max(0, s.remote_total - s.chapters.length) : 0;
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
          <button
            className="btn info"
            disabled={updating}
            onClick={async () => {
              try {
                await startIngest({ series: s.slug, start_chapter: updateStartChapter(s) });
                toast("Checking for new chapters in the background");
              } catch (e) {
                toast(e instanceof Error ? e.message : "Could not start the update");
              }
            }}
          >
            {updating ? "⟳ Updating…" : missing ? `⟳ Update (${missing} new)` : "⟳ Check for new chapters"}
          </button>
        </div>
      </div>
      <div className="body">
        <div className="cols">
          <div>
            <div className="meta">
              <span className="pill">{(s.status || "ongoing").replace(/^./, (c) => c.toUpperCase())}</span>
              <span>{s.chapters.length} chapters</span>
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
            <ReleaseDate s={s} refresh={refresh} />
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
                  {new URL(s.source_url).hostname}
                </a>
              </div>
            )}
          </div>
        </div>
        <ChapterList s={s} progressVersion={progressVersion} />
      </div>
    </div>
  );
}

function ReleaseDate({ s, refresh }: { s: Series; refresh: () => Promise<void> }) {
  const [value, setValue] = useState(toDateInput(s.release_date));
  const [hint, setHint] = useState<{ text: string; cls: string }>({ text: s.release_date ? fmtDate(s.release_date) : "", cls: "" });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const release_date = value || null;
    setSaving(true);
    setHint({ text: "Saving…", cls: "" });
    try {
      await api(`/api/series/${encodeURIComponent(s.slug)}`, { method: "PATCH", json: { release_date } });
      setHint({ text: release_date ? fmtDate(release_date) : "Cleared", cls: "ok" });
      toast("Release date updated");
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
      <div className="release-label">Release date:</div>
      <div className="release-edit">
        <input type="date" className="release-input" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Release date" />
        <button type="button" className="release-save" disabled={saving} onClick={save}>
          Save
        </button>
        <span className={`release-hint${hint.cls ? ` ${hint.cls}` : ""}`}>{hint.text}</span>
      </div>
    </div>
  );
}

function ChapterList({ s, progressVersion }: { s: Series; progressVersion: number }) {
  const [query, setQuery] = useState("");
  const [newest, setNewest] = useState<boolean>(store.sortNewest);

  const rows = useMemo(() => {
    void progressVersion;
    const q = query.trim().toLowerCase();
    const idq = q.replace(/^ch(apter)?\.?\s*/, "");
    const match = (id: string, date: string | null) =>
      !q || id.startsWith(idq) || (/[a-z]/.test(q) && !!date && fmtDate(date).toLowerCase().includes(q));
    const list = [...s.chapters].sort((a, b) => parseFloat(a.id) - parseFloat(b.id));
    if (newest) list.reverse();
    return list.filter((c) => match(c.id, c.date));
  }, [s, query, newest, progressVersion]);

  const p = progressOf(s.slug);
  const read = useMemo(() => new Set(p?.read || []), [p]); // O(1) per row (saves replace `p`)
  return (
    <>
      <div className="chhead">
        <h3>{query.trim() ? `${rows.length} of ${s.chapters.length} Chapters` : `${s.chapters.length} Chapters`}</h3>
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
