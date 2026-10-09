import { useLayoutEffect, useRef } from "react";
import { libraryRef } from "../lib/library";
import { mountRemote } from "../components/remote/mountRemote";
import "../styles/remote.css";

/** #/remote (pick a screen) and #/remote/<id> (control it). App keys this by id. */
export default function RemotePage({ screen }: { screen?: string }) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!root.current) return;
    return mountRemote(root.current, () => libraryRef.current, screen);
  }, [screen]);
  return <div className="rc-root" ref={root} />;
}
