import { useEffect, useRef } from "react";
import { retryJob, unwatchJob, useIngestJobs, useWatchedJob, type LiveJob } from "../../lib/ingest";
import { useLibrary } from "../../lib/library";
import { toast } from "../../lib/toast";

async function retry(id: string, chapter?: string) {
  try {
    await retryJob(id, chapter);
  } catch (e) {
    toast(e instanceof Error ? e.message : "Retry failed");
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** More new chapters than this (a big import) show as counts only, no chapter numbers. */
const MAX_CHIPS = 30;

/** Floating progress for the one import/sync started on this page. A sync stays out of sight
 *  until it finds new chapters (the series page button shows "checking" and "up to date").
 *  Leaving the page, or "Run in background", closes it; the job carries on in History. */
export function JobWindow() {
  const w = useWatchedJob();
  const jobs = useIngestJobs();
  const { bySlug } = useLibrary();
  const j = w ? jobs.find((x) => x.id === w.id) : undefined;
  const jRef = useRef<LiveJob | undefined>(j);
  jRef.current = j;

  // A new page sends the job to the background, unless it is still this series (opened from
  // here, or the source moved the series and the page followed it to the new slug).
  useEffect(() => {
    if (!w) return;
    const onHash = () => {
      const slug = location.hash.split("/")[2];
      const cur = jRef.current;
      if (!cur || !slug || (slug !== cur.slug && slug !== cur.moved_from)) unwatchJob();
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, [w]);

  const chs = j ? Object.entries(j.chapters).filter(([, c]) => c.state !== "cached" && c.state !== "locked") : [];
  chs.sort(([a], [b]) => parseFloat(a) - parseFloat(b));
  const sync = w?.kind === "sync";
  const ended = !!j && j.state !== "running";

  // A sync that found nothing: no window (the series page button says "Up to date").
  useEffect(() => {
    if (sync && ended && j?.state === "done" && !chs.length) unwatchJob();
  }, [sync, ended, j?.state, chs.length]);

  if (!w || !j) return null;
  if (sync && !chs.length && (!ended || j.state === "done")) return null;

  const title = j.title || bySlug(j.slug)?.title || j.slug;
  const got = chs.filter(([, c]) => c.state === "done").length;
  const failed = chs.filter(([, c]) => c.state === "failed");
  const finished = got + failed.length;
  const running = chs.find(([, c]) => c.state === "running");
  const pct = chs.length ? (100 * finished) / chs.length : ended ? 100 : 0;

  let status: string;
  if (!ended) {
    status = running
      ? `Getting ch. ${running[0]} · ${Math.min(finished + 1, chs.length)} of ${chs.length}`
      : chs.length
        ? `${finished} of ${chs.length} chapters`
        : sync
          ? "Checking the source…"
          : "Reading series info…";
  } else if (j.state === "error") {
    status = `Couldn't ${sync ? "sync" : "import"}${j.error ? `: ${j.error}` : ""}`;
  } else if (failed.length) {
    status = `${got} ${sync ? "new" : "imported"} · ${failed.length} failed (tap one to retry)`;
  } else if (j.state === "cancelled" || j.state === "interrupted") {
    status = `${j.state === "cancelled" ? "Cancelled" : "Interrupted"} · ${got} of ${chs.length} chapters`;
  } else {
    status = sync ? plural(got, "new chapter") : got ? `Imported ${plural(got, "chapter")}` : "Already up to date";
  }

  const stateLabel = !ended ? (sync ? "Syncing" : "Importing") : j.state === "done" ? "Done" : j.state === "error" || failed.length ? "Failed" : "Stopped";
  const stateCls = !ended ? "" : j.state === "done" ? "ok" : "bad";
  const canRetry = ended && (failed.length > 0 || j.state === "error" || j.state === "cancelled" || j.state === "interrupted");
  const chips = chs.length <= MAX_CHIPS ? chs : failed;

  return (
    <div className="jobwin" role="status" aria-live="polite">
      <div className="jw-top">
        <b>{title}</b>
        <span className={`jw-state ${stateCls}`}>{stateLabel}</span>
      </div>
      <div className="jw-meter">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="jw-note">{status}</div>
      {chips.length > 0 && (
        <div className="chips">
          {chips.map(([n, c]) => (
            <span
              key={n}
              className={`chip ${c.state}`}
              title={c.state === "failed" ? `${c.error} (tap to retry)` : c.state}
              onClick={c.state === "failed" ? () => retry(j.id, n) : undefined}
            >
              {n}
            </span>
          ))}
        </div>
      )}
      <div className="jw-actions">
        {!ended ? (
          <>
            <a href="#/downloads">History</a>
            <button className="btn info" onClick={unwatchJob}>
              Run in background
            </button>
          </>
        ) : (
          <>
            {canRetry && (
              <button className="btn info" onClick={() => retry(j.id)}>
                Retry
              </button>
            )}
            {!sync && got > 0 && (
              <button
                className="btn info"
                onClick={() => {
                  unwatchJob();
                  location.hash = `#/series/${j.slug}`;
                }}
              >
                Open
              </button>
            )}
            <button className="btn play" onClick={unwatchJob}>
              Close
            </button>
          </>
        )}
      </div>
    </div>
  );
}
