// Global download UI: the "Add a comic" dialog and the bottom-right downloads tray.
// Also watches jobs so the library refreshes (and a toast shows) when downloads land.
import { useEffect, useReducer, useRef } from "react";
import { useLibrary } from "../lib/library";
import { useIngestJobs, type LiveJob } from "../lib/ingest";
import { store } from "../lib/store";
import { toast } from "../lib/toast";
import { AddComicModal } from "./ingest/AddComicModal";
import { TrayJob } from "./ingest/TrayJob";
import "../styles/ingest.css";

const doneCount = (jobs: LiveJob[]) =>
  jobs.reduce((n, j) => n + Object.values(j.chapters).filter((c) => c.state === "done").length, 0);

function endMessage(j: LiveJob) {
  const name = j.title || j.slug;
  const fetched = Object.values(j.chapters).filter((c) => c.state === "done").length;
  const failed = Object.values(j.chapters).filter((c) => c.state === "failed").length;
  if (j.state === "done") return fetched ? `${name}: ${fetched} chapter${fetched === 1 ? "" : "s"} downloaded` : `${name} is up to date`;
  if (j.state === "partial") return `${name}: ${fetched} downloaded, ${failed} failed`;
  if (j.state === "error") return `${name}: download failed${j.error ? ` (${j.error})` : ""}`;
  if (j.state === "cancelled") return `${name}: download cancelled`;
  return null;
}

/** Refresh the library when a job ends, and mid-run (throttled) as chapters land. */
function useJobWatcher(jobs: LiveJob[]) {
  const { refresh } = useLibrary();
  const prevRunning = useRef<Set<string> | null>(null);
  const doneSeen = useRef(0);
  const lastRefresh = useRef(0);

  useEffect(() => {
    const running = new Set(jobs.filter((j) => j.state === "running").map((j) => j.id));
    const done = doneCount(jobs);
    if (prevRunning.current === null) {
      // First data: nothing has "ended" yet, just remember where we are.
      if (jobs.length || running.size) {
        prevRunning.current = running;
        doneSeen.current = done;
      }
      return;
    }
    const ended = jobs.filter((j) => prevRunning.current!.has(j.id) && j.state !== "running");
    prevRunning.current = running;
    if (ended.length || (done > doneSeen.current && Date.now() - lastRefresh.current > 3000)) {
      doneSeen.current = done;
      lastRefresh.current = Date.now();
      void refresh();
    }
    for (const j of ended) {
      const msg = endMessage(j);
      if (msg) toast(msg);
    }
  }, [jobs, refresh]);
}

export default function IngestHost({ addOpen, onCloseAdd }: { addOpen: boolean; onCloseAdd: () => void }) {
  const jobs = useIngestJobs();
  const [, rerender] = useReducer((n: number) => n + 1, 0); // store settings don't notify
  useJobWatcher(jobs);

  const dismissed = store.dismissedJobs as Set<string>;
  const shown = jobs.filter((j) => !dismissed.has(j.id));
  const open = store.trayOpen;
  const running = shown.filter((j) => j.state === "running").length;

  return (
    <>
      {addOpen && <AddComicModal onClose={onCloseAdd} />}
      {shown.length > 0 && (
        <div className={`tray${open ? "" : " min"}`}>
          <div
            className="thead"
            role="button"
            tabIndex={0}
            aria-expanded={open}
            onClick={() => {
              store.setTrayOpen(!open);
              rerender();
            }}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), e.currentTarget.click())}
          >
            <b>Downloads</b>
            {running > 0 && <span className="run">{running} running</span>}
            <a className="tray-all" href="#/downloads" onClick={(e) => e.stopPropagation()}>
              History
            </a>
            <span className="chev">{open ? "▾" : "▴"}</span>
          </div>
          <div className="tbody">
            {shown.map((j) => (
              <TrayJob
                key={j.id}
                j={j}
                onDismiss={() => {
                  store.dismissJob(j.id);
                  rerender();
                }}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
