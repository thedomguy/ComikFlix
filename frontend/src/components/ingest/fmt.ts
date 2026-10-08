// Small formatters shared by the downloads tray and the #/downloads history (times are epoch seconds).

/** "42s", "3m 05s". */
export function fmtDur(sec: number) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  return m ? `${m}m ${String(sec % 60).padStart(2, "0")}s` : `${sec}s`;
}

/** "42s", "3m 5s", "1h 12m" (history cards; long jobs read better in hours). */
export function fmtSpan(a: number, b: number) {
  const s = Math.max(0, Math.round(b - a));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const fmtTime = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour12: false });

const CLIENT_LABEL: Record<string, string> = {
  "claude-ai": "Claude",
  claude: "Claude",
  "claude-code": "Claude Code",
  chatgpt: "ChatGPT",
  openai: "ChatGPT",
  cursor: "Cursor",
};

/** "app" | "jarvis:claude-code" | "<via>:<client>" -> a readable tag. */
export function sourceLabel(source: string | null | undefined) {
  if (!source || source === "app") return "App";
  const [via, client] = source.split(":");
  const who = client ? CLIENT_LABEL[client] || client : null;
  return via === "jarvis" ? `Jarvis${who ? ` · ${who}` : ""}` : who ? `${via} · ${who}` : via;
}
