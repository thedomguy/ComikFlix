import { useEffect, useState } from "react";
import { withBase } from "../lib/paths";
import { setRemoteTarget, useRemoteTarget } from "../lib/remoteTarget";
import "../styles/remote.css";

const STALE_S = 60; // screens heartbeat every 20s
const POLL_MS = 5000;

interface ScreenInfo {
  id: string;
  name?: string;
  updated: number;
  state?: { view?: string; title?: string | null; chapter?: string | null } | null;
}

interface Status {
  online: boolean;
  line: string;
}

function statusOf(s: ScreenInfo | undefined): Status {
  if (!s || Date.now() / 1000 - s.updated >= STALE_S) return { online: false, line: "Screen offline" };
  const st: NonNullable<ScreenInfo["state"]> = s.state || {};
  if (st.view === "read" && st.title) return { online: true, line: `${st.title}${st.chapter ? ` · Ch. ${st.chapter}` : ""}` };
  if (st.view === "series" && st.title) return { online: true, line: `Showing ${st.title}` };
  return { online: true, line: "Nothing playing — pick a comic" };
}

/** "Controlling <screen>" pill shown on browse pages while remote mode is on (App renders it).
 *  Tap: back to the controls. ✕: leave remote mode. Polls the screen list (server copy of the
 *  screen's state) every few seconds while this tab is visible. */
export default function RemoteBanner() {
  const target = useRemoteTarget();
  const id = target?.id;
  const [status, setStatus] = useState<Status | null>(null);

  // Room at the bottom of the page so the pill never hides the last row.
  useEffect(() => {
    if (!id) return;
    document.body.classList.add("has-remote-banner");
    return () => document.body.classList.remove("has-remote-banner");
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setStatus(null);
    const refresh = async () => {
      if (document.hidden) return;
      try {
        const list = (await (await fetch(withBase("/api/remote/screens"))).json()) as ScreenInfo[];
        if (alive && Array.isArray(list)) setStatus(statusOf(list.find((s) => s.id === id)));
      } catch {
        /* offline: keep the last line */
      }
    };
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [id]);

  if (!target) return null;
  const off = status ? !status.online : false;
  return (
    <div className={`rc-banner${off ? " off" : ""}`} role="region" aria-label="Remote control">
      <button
        className="rc-banner-main"
        onClick={() => {
          navigator.vibrate?.(8);
          location.hash = `#/remote/${target.id}`;
        }}
      >
        <span className="rc-banner-dot" aria-hidden="true" />
        <span className="rc-banner-txt">
          <b>Controlling {target.name}</b>
          <small>{status ? status.line : "Open a comic to play it there"}</small>
        </span>
        <svg className="rc-banner-go" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9.5 5.5 16 12l-6.5 6.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button className="rc-banner-x" aria-label={`Stop controlling ${target.name}`} title="Stop controlling" onClick={() => setRemoteTarget(null)}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
