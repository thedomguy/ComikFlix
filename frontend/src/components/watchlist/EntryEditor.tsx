import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { bg, thumb } from "../../lib/format";
import { startIngest, useIngestJobs } from "../../lib/ingest";
import { useLibrary } from "../../lib/library";
import { toast } from "../../lib/toast";
import type { WatchEntry, WatchStatus } from "../../lib/types";
import {
  STATUSES,
  STATUS_LABEL,
  addEntry,
  canComplete,
  refreshEntry,
  removeEntry,
  seriesStatusOf,
  suggestFor,
  updateEntry,
  type EntryInput,
} from "../../lib/watchlist";
import { IconCloud } from "../icons";
import { Stars } from "../Stars";
import "../../styles/watchlist.css";

/** What a new entry starts from: an Asura series (library or catalogue) or a typed title. */
export interface Draft {
  asura?: string;
  title: string;
  cover?: string | null;
  series_status?: string | null;
  in_library?: boolean;
}

const SERIES_STATUS = ["", "ongoing", "hiatus", "completed", "dropped"];
const TYPES = ["", "manhwa", "manga", "manhua", "webtoon", "comic", "novel", "other"];
const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());
const errText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

function useModal(onClose: () => void) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      removeEventListener("keydown", onKey);
    };
  }, [onClose]);
}

/** Rendered into <body>: the screen's slide animation (transform) would otherwise trap the
 *  sheet under the mobile tab bar. */
export function Modal({ onClose, label, children }: { onClose: () => void; label: string; children: ReactNode }) {
  useModal(onClose);
  return createPortal(
    <div className="modal wl-modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet wl-sheet" role="dialog" aria-modal="true" aria-label={label}>
        <button className="close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Status picker: Completed is disabled while the series is still publishing. */
function StatusPicker({ value, onPick, completable, busy }: { value: WatchStatus; onPick: (s: WatchStatus) => void; completable: boolean; busy?: boolean }) {
  return (
    <div className="wl-status" role="radiogroup" aria-label="Status">
      {STATUSES.map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={value === s}
          className={value === s ? "on" : ""}
          disabled={busy || (s === "completed" && !completable && value !== "completed")}
          onClick={() => value !== s && onPick(s)}
        >
          {STATUS_LABEL[s]}
        </button>
      ))}
    </div>
  );
}

function Head({ title, cover, sub, inLibrary }: { title: string; cover: string | null | undefined; sub: string; inLibrary: boolean }) {
  return (
    <div className="wl-head">
      <span className="wl-cover" style={{ backgroundImage: bg(thumb(cover, 200)) }}>
        {!cover && <span>{title.slice(0, 1)}</span>}
      </span>
      <div className="wl-head-text">
        <h2>{title}</h2>
        <small>
          {sub}
          {!inLibrary && (
            <span className="wl-nodl" title="Not downloaded">
              <IconCloud /> Not downloaded
            </span>
          )}
        </small>
      </div>
    </div>
  );
}

const subLine = (series_status: string | null | undefined, extra: (string | null | undefined | false)[] = []) =>
  [series_status ? cap(series_status) : "Status unknown", ...extra].filter(Boolean).join(" · ");

/** Fields only manual entries have (Asura entries take them from the source). */
function DetailsFields({ v, set }: { v: EntryInput; set: (p: EntryInput) => void }) {
  return (
    <div className="wl-details">
      <label>
        Series status
        <select value={v.series_status || ""} onChange={(e) => set({ series_status: e.target.value || null })}>
          {SERIES_STATUS.map((s) => (
            <option key={s} value={s}>
              {s ? cap(s) : "Unknown"}
            </option>
          ))}
        </select>
      </label>
      <label>
        Type
        <select value={v.type || ""} onChange={(e) => set({ type: e.target.value || null })}>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t ? cap(t) : "—"}
            </option>
          ))}
        </select>
      </label>
      <label>
        Chapters out
        <input
          type="number"
          inputMode="numeric"
          min={0}
          value={v.chapters_total ?? ""}
          onChange={(e) => set({ chapters_total: e.target.value ? Number(e.target.value) : null })}
        />
      </label>
      <label>
        Author
        <input value={v.author || ""} onChange={(e) => set({ author: e.target.value || null })} />
      </label>
      <label className="full">
        Cover image URL
        <input type="url" inputMode="url" placeholder="https://…" value={v.cover_url || ""} onChange={(e) => set({ cover_url: e.target.value || null })} />
      </label>
      <label className="full">
        Link (where to read or look it up)
        <input type="url" inputMode="url" placeholder="https://…" value={v.source_url || ""} onChange={(e) => set({ source_url: e.target.value || null })} />
      </label>
    </div>
  );
}

/** Add a new entry from a Draft. */
export function NewEntry({ draft, onClose, onDone }: { draft: Draft; onClose: () => void; onDone: (e: WatchEntry) => void }) {
  const manual = !draft.asura;
  const [title, setTitle] = useState(draft.title);
  const [status, setStatus] = useState<WatchStatus>("reading");
  const [rating, setRating] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [details, setDetails] = useState<EntryInput>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const seriesStatus = manual ? details.series_status : draft.series_status;
  const completable = !seriesStatus || !["ongoing", "hiatus"].includes(seriesStatus);
  const pickedStatus = status === "completed" && !completable ? "reading" : status;

  const save = async () => {
    if (manual && !title.trim()) return setErr("Give it a title.");
    setBusy(true);
    setErr("");
    try {
      const body: EntryInput = { status: pickedStatus, rating, notes: notes.trim() || null };
      const entry = await addEntry(manual ? { ...body, ...details, title: title.trim() } : { ...body, asura: draft.asura });
      toast(`Added ${entry.title} to ${STATUS_LABEL[entry.status]}`);
      onDone(entry);
    } catch (e) {
      setErr(errText(e, "Could not add it"));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label="Add to watch list">
      {manual ? (
        <div className="wl-form">
          <h2 className="wl-title">Add to Watch List</h2>
          <label className="full">
            Title
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
        </div>
      ) : (
        <Head title={draft.title} cover={draft.cover} sub={subLine(draft.series_status, ["Asura Scans"])} inLibrary={!!draft.in_library} />
      )}
      <div className="wl-form">
        <StatusPicker value={pickedStatus} onPick={setStatus} completable={completable} />
        {!completable && <p className="wl-hint">Still {seriesStatus}: it can be Completed once the series ends.</p>}
        <div className="wl-rate">
          <span>Your rating</span>
          <Stars value={rating} onChange={setRating} size={30} label="Your rating" />
        </div>
        <label className="full">
          Notes
          <textarea rows={3} maxLength={2000} placeholder="Private notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {manual && <DetailsFields v={details} set={(p) => setDetails((d) => ({ ...d, ...p }))} />}
        {!manual && !draft.in_library && <p className="wl-hint">Only its details are saved. Nothing is downloaded.</p>}
        <button className="btn play wl-save" disabled={busy} onClick={save}>
          {busy ? "Adding…" : "Add to Watch List"}
        </button>
        <div className="err" role="alert">
          {err}
        </div>
      </div>
    </Modal>
  );
}

/** Edit an existing entry: status and rating save on tap; notes and details with Save. */
export function EditEntry({ entry, onClose }: { entry: WatchEntry; onClose: () => void }) {
  const { bySlug, refresh } = useLibrary();
  const jobs = useIngestJobs();
  const s = entry.in_library ? bySlug(entry.asura_slug || undefined) : undefined;
  const [notes, setNotes] = useState(entry.notes || "");
  const [details, setDetails] = useState<EntryInput>({});
  const [editing, setEditing] = useState(false);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const manual = entry.source === "manual";
  const seriesStatus = seriesStatusOf(entry, s);
  const completable = canComplete(entry, s);
  const suggestion = suggestFor(entry, s);
  const downloading = !!entry.asura_slug && jobs.some((j) => j.slug === entry.asura_slug && j.state === "running");

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(errText(e, fallback));
    }
    setBusy(false);
  };
  const patch = (data: EntryInput, fallback = "Could not save") => run(() => updateEntry(entry.id, data), fallback);

  const startEdit = () => {
    setDetails({
      title: entry.title,
      series_status: entry.series_status,
      type: entry.type,
      chapters_total: entry.chapters_total,
      author: entry.author,
      cover_url: entry.cover_url,
      source_url: entry.source_url,
    });
    setEditing(true);
  };

  const progress = s
    ? entry.progress
      ? `Ch. ${entry.progress.chapter} · ${entry.progress.read_count}/${entry.chapters_total ?? s.chapters.length} read`
      : `${s.chapters.length} chapters downloaded`
    : entry.chapters_total
      ? `${entry.chapters_total} chapters`
      : null;

  return (
    <Modal onClose={onClose} label={entry.title}>
      <Head
        title={entry.title}
        cover={s?.poster || entry.cover_url}
        sub={subLine(seriesStatus, [entry.type && cap(entry.type), progress, manual ? "Added by hand" : null])}
        inLibrary={entry.in_library}
      />
      <div className="wl-form">
        {suggestion && (
          <div className="wl-suggest">
            <span>{suggestion.reason}</span>
            <button disabled={busy} onClick={() => patch({ status: suggestion.status })}>
              Move to {STATUS_LABEL[suggestion.status]}
            </button>
          </div>
        )}
        <StatusPicker value={entry.status} onPick={(st) => patch({ status: st })} completable={completable} busy={busy} />
        {!completable && entry.status !== "completed" && <p className="wl-hint">Still {seriesStatus}: it can be Completed once the series ends.</p>}
        <div className="wl-rate">
          <span>Your rating</span>
          <Stars value={entry.rating} onChange={(r) => patch({ rating: r })} size={30} label="Your rating" />
        </div>
        <label className="full">
          Notes
          <textarea rows={3} maxLength={2000} placeholder="Private notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {notes !== (entry.notes || "") && (
          <button className="wl-small" disabled={busy} onClick={() => patch({ notes: notes.trim() || null })}>
            Save notes
          </button>
        )}

        {manual && editing && (
          <>
            <label className="full">
              Title
              <input value={details.title || ""} onChange={(e) => setDetails((d) => ({ ...d, title: e.target.value }))} />
            </label>
            <DetailsFields v={details} set={(p) => setDetails((d) => ({ ...d, ...p }))} />
            <div className="wl-row">
              <button className="wl-small primary" disabled={busy} onClick={() => patch(details).then(() => setEditing(false))}>
                Save details
              </button>
              <button className="wl-small" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </>
        )}

        <div className="wl-actions">
          {s && (
            <a className="wl-small primary" href={`#/series/${s.slug}`}>
              Open in library
            </a>
          )}
          {entry.asura_slug && !entry.in_library && (
            <button
              className="wl-small"
              disabled={busy || downloading}
              onClick={() =>
                run(async () => {
                  await startIngest({ series: entry.asura_slug!, start_chapter: 1 });
                  toast(`Downloading ${entry.title} in the background`);
                  refresh();
                }, "Could not start the download")
              }
            >
              {downloading ? "Downloading…" : "Download"}
            </button>
          )}
          {entry.source_url && (
            <a className="wl-small" href={entry.source_url} target="_blank" rel="noreferrer">
              Visit {hostOf(entry.source_url)}
            </a>
          )}
          {entry.source === "asura" && (
            <button className="wl-small" disabled={busy} onClick={() => run(() => refreshEntry(entry.id), "Could not refresh")}>
              Refresh info
            </button>
          )}
          {manual && !editing && (
            <button className="wl-small" onClick={startEdit}>
              Edit details
            </button>
          )}
        </div>

        {manual ? (
          <div className="wl-link">
            <label className="full">
              Found it on Asura Scans? Link it
              <span className="wl-row">
                <input placeholder="Asura URL or slug" value={link} onChange={(e) => setLink(e.target.value)} spellCheck={false} />
                <button className="wl-small" disabled={busy || !link.trim()} onClick={() => patch({ asura: link.trim() }, "Could not link it").then(() => setLink(""))}>
                  Link
                </button>
              </span>
            </label>
          </div>
        ) : (
          !entry.in_library && (
            <button className="wl-linkbtn" disabled={busy} onClick={() => patch({ asura: null })}>
              Unlink from Asura (keep as a hand-made entry)
            </button>
          )
        )}

        <div className="wl-remove">
          {confirmRemove ? (
            <>
              <span>Remove from your watch list?</span>
              <button className="wl-small danger" disabled={busy} onClick={() => run(async () => { await removeEntry(entry.id); toast(`Removed ${entry.title}`); onClose(); }, "Could not remove it")}>
                Remove
              </button>
              <button className="wl-small" onClick={() => setConfirmRemove(false)}>
                Keep
              </button>
            </>
          ) : (
            <button className="wl-linkbtn danger" onClick={() => setConfirmRemove(true)}>
              Remove from Watch List
            </button>
          )}
        </div>
        <div className="err" role="alert">
          {err}
        </div>
      </div>
    </Modal>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "link";
  }
}
