// "Remote mode": the screen this tab is controlling. While set, the app is used normally to
// browse, but opening a chapter plays it on that screen (App intercepts #/read/...) and
// brings up the remote controls. Per tab (sessionStorage), cleared by "Stop".
import { useEffect, useState } from "react";
import { withBase } from "./paths";

export interface RemoteTarget {
  id: string;
  name: string;
}

const KEY = "comikflix:remote-target";
const EVENT = "comikflix:remote-target";

export function getRemoteTarget(): RemoteTarget | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || "null");
    return v && typeof v.id === "string" ? { id: v.id, name: String(v.name || "Screen") } : null;
  } catch {
    return null;
  }
}

export function setRemoteTarget(t: RemoteTarget | null) {
  try {
    if (t) sessionStorage.setItem(KEY, JSON.stringify(t));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked: remote mode lasts only for this page view */
  }
  dispatchEvent(new Event(EVENT));
}

export function useRemoteTarget() {
  const [t, setT] = useState(getRemoteTarget);
  useEffect(() => {
    const on = () => setT(getRemoteTarget());
    addEventListener(EVENT, on);
    return () => removeEventListener(EVENT, on);
  }, []);
  return t;
}

/** Fire-and-forget command through the server (used when no direct channel is open). */
export function sendRemote(id: string, cmd: Record<string, unknown>) {
  return fetch(withBase("/api/remote/cmd"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, cmd }),
  }).catch(() => {});
}
