import { useLayoutEffect, useRef, useState } from "react";
import { cancelJob, retryJob, type LiveJob } from "../../lib/ingest";
import { toast } from "../../lib/toast";
import { fmtDur, fmtTime } from "./fmt";

const LABEL: Record<string, string> = { running: "Running", done: "Complete", cancelled: "Cancelled", error: "Failed" };

async function retry(id: string, chapter?: string) {
  try {
    await retryJob(id, chapter);
  } catch (e) {
    toast(e instanceof Error ? e.message : "Retry failed");
  }
}

/** One job in the downloads tray: progress, per-chapter chips, retry/cancel, live log. */
export function TrayJob({ j, onDismiss }: { j: LiveJob; onDismiss: () => void }) {
  const [logOpen, setLogOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // follow the log tail unless the user scrolled up

  const chs = Object.entries(j.chapters);
  const wanted = chs.filter(([, c]) => c.state !== "locked");
  const finished = wanted.filter(([, c]) => c.state === "done" || c.state === "cached" || c.state === "failed").length;
  const failed = chs.filter(([, c]) => c.state === "failed");
  const queued = chs.filter(([, c]) => c.state === "queued");
  const running = chs.find(([, c]) => c.state === "running");
  const isRunning = j.state === "running";
  const dur = fmtDur((j.finished || Date.now() / 1000) - j.started);
  const label = j.state === "partial" ? `${failed.length} failed` : LABEL[j.state] || j.state;
  const pct = wanted.length ? (100 * finished) / wanted.length : isRunning ? 0 : 100;

  const note = running
    ? `Chapter ${running[0]}: ${running[1].done}/${running[1].total || "?"} images · ${finished}/${wanted.length} chapters`
    : j.state === "error"
      ? j.error
      : failed.length
        ? `${failed.length} failed: ` +
          failed
            .slice(0, 3)
            .map(([n, c]) => `Ch. ${n} (${c.error})`)
            .join(", ") +
          (failed.length > 3 ? "…" : "")
        : [j.stage, wanted.length ? `${finished}/${wanted.length} chapters` : ""].filter(Boolean).join(" · ");

  const canRetry = !isRunning && (failed.length > 0 || queued.length > 0 || (j.state === "error" && !chs.length));
  const retryLabel =
    j.state === "cancelled" && !failed.length ? "Resume" : failed.length ? "Retry failed" : queued.length ? "Resume" : "Retry";

  const lines = j.log;
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, logOpen]);

  return (
    <div className="job">
      <div className="top">
        <b>{j.title || j.slug}</b>
        <span className={`state ${j.state}`}>
          {label} · {dur}
        </span>
        {!isRunning && (
          <button className="x" title="Hide" aria-label="Hide" onClick={onDismiss}>
            ×
          </button>
        )}
      </div>
      <div className="meter">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="note">{note}</div>
      {chs.length > 0 && (
        <div className="chips">
          {chs.map(([n, c]) => (
            <span
              key={n}
              className={`chip ${c.state}`}
              title={
                c.state === "failed"
                  ? `${c.error} (click to retry)`
                  : c.state === "done" && c.finished && c.started
                    ? `${c.pages} pages in ${fmtDur(c.finished - c.started)}`
                    : c.state
              }
              onClick={c.state === "failed" ? () => retry(j.id, n) : undefined}
            >
              {n}
            </span>
          ))}
        </div>
      )}
      <div className="actions">
        {isRunning && (
          <button onClick={() => cancelJob(j.id).catch((e: Error) => toast(e.message || "Could not cancel"))}>Cancel</button>
        )}
        {canRetry && (
          <button className="primary" onClick={() => retry(j.id)}>
            {retryLabel}
          </button>
        )}
        <button
          onClick={() => {
            stick.current = true;
            setLogOpen((o) => !o);
          }}
        >
          {logOpen ? "Hide log" : "Show log"}
        </button>
      </div>
      {logOpen && (
        <div
          className="log"
          ref={logRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 12;
          }}
        >
          {lines.map((l, i) => (
            <div key={i} className={`ln ${l.level}`}>
              <span>{fmtTime(l.t)}</span>
              {l.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
