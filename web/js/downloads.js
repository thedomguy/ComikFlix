// #/downloads: every download attempt ever, from any source (the app, or Jarvis on behalf
// of ChatGPT / Claude / Claude Code / Cursor ...), with tags and live progress.
import { h } from "./dom.js";
import { withBase } from "./paths.js";

const POLL_MS = 3000;
const IDLE_POLL_MS = 15000;
const STATE_LABEL = {
  running: "Running",
  done: "Done",
  partial: "Some failed",
  cancelled: "Cancelled",
  error: "Error",
  interrupted: "Interrupted",
};
const CLIENT_LABEL = {
  "claude-ai": "Claude",
  claude: "Claude",
  "claude-code": "Claude Code",
  chatgpt: "ChatGPT",
  openai: "ChatGPT",
  cursor: "Cursor",
};

let stop = null;

export function closeDownloads() {
  if (stop) {
    stop();
    stop = null;
  }
}

function sourceLabel(source) {
  if (!source || source === "app") return "App";
  const [via, client] = source.split(":");
  const who = client ? CLIENT_LABEL[client] || client : null;
  return via === "jarvis" ? `Jarvis${who ? ` · ${who}` : ""}` : who ? `${via} · ${who}` : via;
}

function ago(t) {
  const s = Math.max(0, Date.now() / 1000 - t);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function dur(a, b) {
  const s = Math.max(0, Math.round(b - a));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function card(j, inLibrary) {
  const c = j.counts || {};
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  const handled = (c.done || 0) + (c.cached || 0) + (c.failed || 0) + (c.locked || 0);
  const parts = [
    c.done ? `${c.done} fetched` : null,
    c.cached ? `${c.cached} already had` : null,
    c.failed ? `${c.failed} failed` : null,
    c.locked ? `${c.locked} locked` : null,
  ].filter(Boolean);
  const title = j.title || j.slug.replace(/-[0-9a-f]{8}$/, "").replace(/-/g, " ");
  return h(
    "div",
    { class: `dl-card ${j.state}` },
    h(
      "div",
      { class: "dl-top" },
      inLibrary ? h("a", { class: "dl-title", href: `#/series/${j.slug}` }, title) : h("span", { class: "dl-title" }, title),
      h("span", { class: `dl-state ${j.state}` }, STATE_LABEL[j.state] || j.state)
    ),
    h(
      "div",
      { class: "dl-tags" },
      h("span", { class: "dl-tag src" }, sourceLabel(j.source)),
      ...(j.tags || []).filter((t) => !t.startsWith("via:") && !t.startsWith("client:")).map((t) => h("span", { class: "dl-tag" }, t))
    ),
    h(
      "div",
      { class: "dl-meta" },
      `${ago(j.started)} · from ch. ${j.start_chapter}${j.latest ? ` to ${j.latest}` : ""}`,
      j.finished ? ` · took ${dur(j.started, j.finished)}` : j.state === "running" ? ` · ${dur(j.started, Date.now() / 1000)} so far` : ""
    ),
    j.state === "running"
      ? h(
          "div",
          { class: "dl-progress" },
          h("div", { class: "dl-bar" }, h("span", { style: { width: `${total ? (handled / total) * 100 : 0}%` } })),
          h("small", {}, `${j.stage || "Working"}${total ? ` · ${handled}/${total} chapters` : ""}`)
        )
      : null,
    parts.length ? h("div", { class: "dl-counts" }, parts.join(" · ")) : null,
    j.error ? h("div", { class: "dl-error" }, j.error) : null,
    j.failed?.length ? h("div", { class: "dl-error" }, `Failed chapters: ${j.failed.join(", ")}`) : null,
    j.log?.length
      ? h(
          "details",
          { class: "dl-log" },
          h("summary", {}, "Log"),
          h("pre", {}, j.log.map((l) => `${new Date(l.t * 1000).toLocaleTimeString([], { hour12: false })}  ${l.msg}`).join("\n"))
        )
      : null
  );
}

export function renderDownloads(root, getLibrary) {
  closeDownloads();
  let filter = "all";
  let jobs = [];
  let timer = 0;
  let alive = true;
  const openLogs = new Set(); // keep expanded logs open across refreshes

  const filters = h("div", { class: "dl-filters" });
  const list = h("div", { class: "dl-list" }, h("p", { class: "dl-empty" }, "Loading…"));
  root.replaceChildren(
    h(
      "div",
      { class: "dl-page" },
      h("div", { class: "dl-head" }, h("h1", {}, "Downloads"), h("p", {}, "Every download attempt, from the app or through Jarvis.")),
      filters,
      list
    )
  );

  function matches(j) {
    if (filter === "all") return true;
    if (filter === "running") return j.state === "running";
    if (filter === "problems") return ["partial", "error", "interrupted", "cancelled"].includes(j.state);
    return j.source === filter;
  }

  function render() {
    const sources = [...new Set(jobs.map((j) => j.source || "app"))];
    const opts = [
      ["all", `All (${jobs.length})`],
      ["running", `Running (${jobs.filter((j) => j.state === "running").length})`],
      ["problems", "Problems"],
      ...sources.map((s) => [s, sourceLabel(s)]),
    ];
    filters.replaceChildren(
      ...opts.map(([v, label]) =>
        h("button", { class: `dl-filter${filter === v ? " on" : ""}`, onclick: () => ((filter = v), render()) }, label)
      )
    );
    for (const d of list.querySelectorAll("details[open]")) openLogs.add(d.dataset.id);
    const lib = new Set(getLibrary().map((s) => s.slug));
    const shown = jobs.filter(matches);
    list.replaceChildren(
      ...(shown.length
        ? shown.map((j) => {
            const el = card(j, lib.has(j.slug));
            const d = el.querySelector("details");
            if (d) {
              d.dataset.id = j.id;
              d.open = openLogs.has(j.id);
              d.addEventListener("toggle", () => (d.open ? openLogs.add(j.id) : openLogs.delete(j.id)));
            }
            return el;
          })
        : [h("p", { class: "dl-empty" }, jobs.length ? "Nothing matches this filter." : "No downloads yet.")])
    );
  }

  async function load() {
    try {
      const res = await fetch(withBase("/api/downloads"));
      if (res.ok) jobs = await res.json();
    } catch {
      /* offline: keep what we have */
    }
    if (!alive) return;
    render();
    // Fast while something runs; slower otherwise so new downloads (e.g. from Jarvis) still appear.
    timer = setTimeout(load, jobs.some((j) => j.state === "running") ? POLL_MS : IDLE_POLL_MS);
  }
  load();

  stop = () => {
    alive = false;
    clearTimeout(timer);
  };
}
