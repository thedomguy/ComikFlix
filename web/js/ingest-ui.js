import { $, h, fmtDur, fmtTime } from "./dom.js";
import { store } from "./store.js";

let ingestTimer = null;
let ingestJobs = [];
let doneSeen = null;
let lastRefresh = 0;
let runningSig = "";
let prevRunning = new Set();
let toastTimer = null;
const jobEls = new Map();

const post = (url, body) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

export function getIngestJobs() {
  return ingestJobs;
}

export function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

export async function startIngest(series, latest) {
  const res = await post("/api/ingest", { series, latest: latest || null });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: body.error || "Could not start the download" };
  store.setTrayOpen(true);
  store.undismissJob(body.id);
  pollIngest();
  return { job: body };
}

async function retryJob(id, chapter) {
  const res = await post(`/api/ingest/${id}/retry`, chapter != null ? { chapter: String(chapter) } : {});
  if (!res.ok) toast((await res.json().catch(() => ({}))).error || "Retry failed");
  store.setTrayOpen(true);
  pollIngest();
}

function makeJobEl(id) {
  const r = { chipEls: new Map(), lastSig: null, logOpen: false };
  r.title = h("b");
  r.state = h("span", { class: "state" });
  r.x = h("button", {
    class: "x",
    title: "Hide",
    onclick: () => {
      store.dismissJob(id);
      renderTray();
    },
  }, "×");
  r.bar = h("i");
  r.status = h("div", { class: "note" });
  r.chips = h("div", { class: "chips" });
  r.cancel = h("button", { onclick: () => post(`/api/ingest/${id}/cancel`).then(pollIngest) }, "Cancel");
  r.retry = h("button", { class: "primary", onclick: () => retryJob(id) }, "Retry");
  r.logbtn = h("button", {
    onclick: () => {
      r.logOpen = !r.logOpen;
      r.log.classList.toggle("hidden", !r.logOpen);
      r.logbtn.textContent = r.logOpen ? "Hide log" : "Show log";
      r.log.scrollTop = r.log.scrollHeight;
    },
  }, "Show log");
  r.log = h("div", { class: "log hidden" });
  r.el = h(
    "div",
    { class: "job" },
    h("div", { class: "top" }, r.title, r.state, r.x),
    h("div", { class: "meter" }, r.bar),
    r.status,
    r.chips,
    h("div", { class: "actions" }, r.cancel, r.retry, r.logbtn),
    r.log
  );
  return r;
}

function syncLog(r, lines) {
  const sig = (l) => `${l.t}|${l.msg}`;
  let start = 0;
  if (r.lastSig) {
    const i = lines.map(sig).lastIndexOf(r.lastSig);
    if (i === -1) r.log.replaceChildren();
    else start = i + 1;
  }
  const stick = r.log.scrollHeight - r.log.scrollTop - r.log.clientHeight < 12;
  for (const l of lines.slice(start)) {
    r.log.append(h("div", { class: `ln ${l.level}` }, h("span", {}, fmtTime(l.t)), l.msg));
  }
  if (lines.length) r.lastSig = sig(lines[lines.length - 1]);
  if (stick) r.log.scrollTop = r.log.scrollHeight;
}

function updateJobEl(r, j) {
  const chs = Object.entries(j.chapters);
  const wanted = chs.filter(([, c]) => c.state !== "locked");
  const finished = wanted.filter(([, c]) => ["done", "cached", "failed"].includes(c.state)).length;
  const failed = chs.filter(([, c]) => c.state === "failed");
  const queued = chs.filter(([, c]) => c.state === "queued");
  const running = chs.find(([, c]) => c.state === "running");
  const dur = fmtDur((j.finished || Date.now() / 1000) - j.started);
  const label =
    { running: "Running", done: "Complete", partial: `${failed.length} failed`, cancelled: "Cancelled", error: "Failed" }[
      j.state
    ] || j.state;

  r.title.textContent = j.title || j.slug;
  r.state.textContent = `${label} · ${dur}`;
  r.state.className = `state ${j.state}`;
  r.bar.style.width = `${wanted.length ? (100 * finished) / wanted.length : j.state === "running" ? 0 : 100}%`;
  r.status.textContent = running
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

  for (const [n, c] of chs) {
    let chip = r.chipEls.get(n);
    if (!chip) {
      chip = h("span", { class: "chip", onclick: () => chip.classList.contains("failed") && retryJob(j.id, n) }, n);
      r.chipEls.set(n, chip);
      r.chips.append(chip);
    }
    chip.className = `chip ${c.state}`;
    chip.title =
      c.state === "failed"
        ? `${c.error} (click to retry)`
        : c.state === "done" && c.finished && c.started
          ? `${c.pages} pages in ${fmtDur(c.finished - c.started)}`
          : c.state;
  }
  r.chips.classList.toggle("hidden", !chs.length);
  const isRunning = j.state === "running";
  r.cancel.classList.toggle("hidden", !isRunning);
  r.x.classList.toggle("hidden", isRunning);
  const canRetry = !isRunning && (failed.length || queued.length || (j.state === "error" && !chs.length));
  r.retry.classList.toggle("hidden", !canRetry);
  r.retry.textContent =
    j.state === "cancelled" && !failed.length ? "Resume" : failed.length ? "Retry failed" : queued.length ? "Resume" : "Retry";
  syncLog(r, j.log || []);
}

export function renderTray() {
  const tray = $("#tray");
  const body = $("#tbody");
  const dismissed = store.dismissedJobs;
  const jobs = ingestJobs.filter((j) => !dismissed.has(j.id));
  tray.classList.toggle("hidden", !jobs.length);
  tray.classList.toggle("min", !store.trayOpen);
  const running = jobs.filter((j) => j.state === "running").length;
  $("#thead").replaceChildren(
    ...[
      h("b", {}, "Downloads"),
      running ? h("span", { class: "run" }, `${running} running`) : null,
      h("span", { class: "chev" }, store.trayOpen ? "▾" : "▴"),
    ].filter(Boolean)
  );

  const keep = new Set(jobs.map((j) => j.id));
  for (const [id, r] of jobEls) {
    if (!keep.has(id)) {
      r.el.remove();
      jobEls.delete(id);
    }
  }
  for (const j of jobs) {
    if (!jobEls.has(j.id)) jobEls.set(j.id, makeJobEl(j.id));
    updateJobEl(jobEls.get(j.id), j);
  }
  const want = jobs.map((j) => jobEls.get(j.id).el);
  if (want.some((el, i) => body.children[i] !== el) || body.children.length !== want.length) {
    body.replaceChildren(...want);
  }
}

export function openAdd() {
  const modal = $("#ingest");
  const series = h("input", {
    id: "ing-series",
    placeholder: "series slug or asurascans.com comic URL",
    autocomplete: "off",
    spellcheck: "false",
  });
  const upto = h("input", { id: "ing-upto", type: "number", min: 1, placeholder: "all" });
  const err = h("div", { class: "err" });
  const go = h("button", { class: "btn play", type: "submit" }, "Add & download");
  const close = () => {
    modal.classList.add("hidden");
    document.body.style.overflow =
      location.hash.startsWith("#/series") || location.hash.startsWith("#/read") ? "hidden" : "";
  };
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        go.disabled = true;
        err.textContent = "";
        const res = await startIngest(series.value, upto.value ? parseInt(upto.value, 10) : null);
        go.disabled = false;
        if (res.error) err.textContent = res.error;
        else close();
      },
    },
    h("div", {}, h("label", { for: "ing-series" }, "Series slug or URL"), series),
    h("div", {}, h("label", { for: "ing-upto" }, "Up to chapter (optional)"), upto),
    go
  );
  modal.replaceChildren(
    h(
      "div",
      { class: "sheet ingest" },
      h("button", { class: "close", onclick: close, "aria-label": "Close" }, "✕"),
      h("h2", {}, "Add a comic"),
      h(
        "p",
        { class: "hint" },
        "Reads the series info (title, synopsis, genres, chapters) and downloads every available chapter in the background. Chapters you already have are skipped."
      ),
      form,
      err
    )
  );
  modal.onclick = (e) => {
    if (e.target === modal) close();
  };
  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  series.focus();
}

let pollFn = null;

function pollIngest() {
  pollFn?.();
}

export function initIngestUI({ refreshLibrary, onRunningChange }) {
  $("#thead").addEventListener("click", () => {
    store.setTrayOpen(!store.trayOpen);
    renderTray();
  });
  $("#addbtn").addEventListener("click", openAdd);

  pollFn = async function poll() {
    clearTimeout(ingestTimer);
    try {
      ingestJobs = await (await fetch("/api/ingest")).json();
    } catch {
      ingestTimer = setTimeout(poll, 3000);
      return;
    }
    if (doneSeen === null) {
      ingestJobs.filter((j) => j.state === "done" || j.state === "cancelled").forEach((j) => store.dismissJob(j.id));
    }
    renderTray();

    const running = ingestJobs.filter((j) => j.state === "running");
    const doneNow = ingestJobs.reduce(
      (n, j) => n + Object.values(j.chapters).filter((c) => c.state === "done").length,
      0
    );
    const ended = [...prevRunning].some((id) => !running.some((j) => j.id === id));
    prevRunning = new Set(running.map((j) => j.id));
    if (doneSeen === null) doneSeen = doneNow;
    else if (ended || (doneNow > doneSeen && Date.now() - lastRefresh > 3000)) {
      doneSeen = doneNow;
      lastRefresh = Date.now();
      refreshLibrary();
    }

    const sig = running.map((j) => j.slug).sort().join(",");
    if (sig !== runningSig) {
      runningSig = sig;
      onRunningChange?.();
    }
    if (running.length) ingestTimer = setTimeout(poll, 1000);
  };

  pollFn();
}
