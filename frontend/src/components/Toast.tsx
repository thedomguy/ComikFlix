import { useEffect, useState } from "react";

export function Toast() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let t = 0;
    const on = (e: Event) => {
      setMsg((e as CustomEvent<string>).detail);
      clearTimeout(t);
      t = window.setTimeout(() => setMsg(null), 3500);
    };
    window.addEventListener("comikflix:toast", on);
    return () => window.removeEventListener("comikflix:toast", on);
  }, []);
  return msg ? <div className="toast">{msg}</div> : null;
}
