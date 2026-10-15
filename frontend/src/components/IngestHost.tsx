// Global ingest UI: the "Add a comic" dialog and the progress window for a job started here.
// Also watches jobs so the library refreshes as chapters land and when a job ends.
import { useEffect, useRef } from "react";
import { useLibrary } from "../lib/library";
import { useIngestJobs, type LiveJob } from "../lib/ingest";
import { AddComicModal } from "./ingest/AddComicModal";
import { JobWindow } from "./ingest/JobWindow";
import "../styles/ingest.css";

const doneCount = (jobs: LiveJob[]) =>
  jobs.reduce((n, j) => n + Object.values(j.chapters).filter((c) => c.state === "done").length, 0);

/** Mid-download library refreshes at most this often (a job ending always refreshes). */
const MID_RUN_REFRESH_MS = 20000;

/** Refresh the library when a job ends, and mid-run (throttled, visible tab only) as chapters land. */
function useJobWatcher(jobs: LiveJob[]) {
  const { refresh } = useLibrary();
  const prevRunning = useRef<Set<string> | null>(null);
  const doneSeen = useRef(0);
  const lastRefresh = useRef(0);
  const movedSeen = useRef(new Set<string>());

  useEffect(() => {
    // The source moved a series to a new slug: reload, then move an open page there with it.
    for (const j of jobs) {
      const old = j.moved_from;
      if (!old || movedSeen.current.has(j.id)) continue;
      movedSeen.current.add(j.id);
      const parts = location.hash.split("/");
      if (parts[2] !== old) continue;
      void refresh().then(() => {
        if (location.hash.split("/")[2] === old) location.replace([...parts.slice(0, 2), j.slug, ...parts.slice(3)].join("/"));
      });
    }

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
    const midRun = done > doneSeen.current && !document.hidden && Date.now() - lastRefresh.current > MID_RUN_REFRESH_MS;
    if (ended.length || midRun) {
      doneSeen.current = done;
      lastRefresh.current = Date.now();
      void refresh();
    }
  }, [jobs, refresh]);
}

export default function IngestHost({ addOpen, onCloseAdd }: { addOpen: boolean; onCloseAdd: () => void }) {
  useJobWatcher(useIngestJobs());
  return (
    <>
      {addOpen && <AddComicModal onClose={onCloseAdd} />}
      <JobWindow />
    </>
  );
}
