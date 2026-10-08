// Remote control (ported unchanged from the original app, web/js/remote.js): drive another signed-in tab (a "screen", see screen.js) from this one.
//   #/remote        pick a screen
//   #/remote/<id>   control it: trackpad, paging, auto-scroll, chapters, live page preview
// Commands and state use a direct WebRTC data channel to the screen when it connects
// (same Wi-Fi: no round trip through the server), else HTTP via the server.
import { h, bg } from "../../lib/dom";
import { store } from "../../lib/store";
import { withBase } from "../../lib/paths";
import { screenId } from "../../lib/screen";
import { newPeer, gathered, signal } from "../../lib/rtc";

const STALE_S = 60; // screens heartbeat every 20s
const PAD_GAIN = 2.2; // one full drag of the pad scrolls ~2 screens

function httpSend(id, cmd) {
  return fetch(withBase("/api/remote/cmd"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, cmd }),
  }).catch(() => {});
}

function describe(st, lib) {
  if (!st || !st.view) return "Connecting…";
  if (st.view === "read" && st.title) {
    const pct = st.frac != null ? ` · ${Math.round(st.frac * 100)}%` : "";
    return `Reading ${st.title} · Ch. ${st.chapter}${pct}`;
  }
  if (st.view === "series" && st.title) return `Looking at ${st.title}`;
  if (st.view === "remote") return "Remote";
  return lib.length ? "On the library" : "Open";
}

function shell(root, title, onBack, ...kids) {
  root.replaceChildren(
    h(
      "div",
      { class: "rm-head" },
      h("button", { class: "rm-back", onclick: onBack, "aria-label": "Back" }, "←"),
      h("div", { class: "rm-title" }, title)
    ),
    ...kids
  );
}

function renderList(root, getLibrary) {
  const list = h("div", { class: "rm-list" });
  shell(root, "Remote", () => (location.hash = "#/"), h("p", { class: "rm-hint" }, "Pick a screen to control"), list);

  let stopped = false;
  async function refresh() {
    let screens = [];
    try {
      screens = await (await fetch(withBase("/api/remote/screens"))).json();
    } catch {
      /* offline: keep last list */
      return;
    }
    if (stopped) return;
    const now = Date.now() / 1000;
    screens = screens.filter((s) => s.id !== screenId && now - s.updated < STALE_S);
    if (!screens.length) {
      list.replaceChildren(
        h(
          "div",
          { class: "rm-empty" },
          h("b", {}, "No screens online"),
          h("span", {}, "Open Comicflix on your laptop (signed in) and it will show up here.")
        )
      );
      return;
    }
    list.replaceChildren(
      ...screens.map((s) =>
        h(
          "button",
          { class: "rm-screen", onclick: () => (location.hash = `#/remote/${s.id}`) },
          h("span", { class: `rm-dot${s.state?.visible === false ? " idle" : ""}` }),
          h(
            "span",
            { class: "rm-screen-txt" },
            h("b", {}, s.name || "Screen"),
            h("small", {}, s.state?.visible === false ? `In background · ${describe(s.state, getLibrary())}` : describe(s.state, getLibrary()))
          ),
          h("span", { class: "rm-go" }, "›")
        )
      )
    );
  }
  refresh();
  const timer = setInterval(refresh, 3000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function renderControl(root, id, getLibrary) {
  let st = null;
  let online = false;

  // ---- direct channel (WebRTC) with HTTP fallback ----
  let pc = null;
  let channel = null;
  let retry = 0;
  let closed = false;
  const direct = () => channel?.readyState === "open";
  const send = (_id, cmd) => (direct() ? channel.send(JSON.stringify(cmd)) : httpSend(id, cmd));

  function dropPeer() {
    clearTimeout(retry);
    channel?.close();
    pc?.close();
    pc = channel = null;
    render();
  }
  function retryLater() {
    clearTimeout(retry);
    if (!closed && online) retry = setTimeout(startPeer, 5000);
  }
  async function startPeer() {
    if (closed || pc) return;
    const mine = (pc = newPeer());
    const ch = (channel = mine.createDataChannel("remote", { ordered: true }));
    ch.onopen = render;
    ch.onmessage = (m) => {
      try {
        const msg = JSON.parse(m.data);
        if (msg.type === "state") applyState(msg.state);
      } catch {
        /* malformed */
      }
    };
    ch.onclose = () => {
      if (pc === mine) {
        dropPeer();
        retryLater();
      }
    };
    mine.onconnectionstatechange = () => {
      if (mine.connectionState === "failed" && pc === mine) {
        dropPeer();
        retryLater();
      }
    };
    try {
      await mine.setLocalDescription(await mine.createOffer());
      await gathered(mine);
      if (pc !== mine) return;
      signal({ screen: id, remote: screenId, toScreen: true, data: { type: "offer", sdp: mine.localDescription.sdp } });
      // No answer within 8s (old screen tab, signaling lost): stay on HTTP, try again later.
      setTimeout(() => {
        if (pc === mine && !mine.remoteDescription) {
          dropPeer();
          retryLater();
        }
      }, 8000);
    } catch {
      if (pc === mine) dropPeer();
    }
  }

  // ---- now showing ----
  const cover = h("div", { class: "rm-cover" });
  const nowTitle = h("b", {}, "Connecting…");
  const nowSub = h("small", {}, "");
  const preview = h("img", { class: "rm-preview", alt: "Current page" });
  const previewBox = h("div", { class: "rm-preview-box" }, preview);
  const seek = h("input", { type: "range", min: 0, max: 1000, value: 0, class: "rm-seek", "aria-label": "Position" });
  let seeking = false;
  seek.addEventListener("pointerdown", () => (seeking = true));
  seek.addEventListener("input", () => send(id, { type: "seek", frac: seek.value / 1000 }));
  seek.addEventListener("change", () => (seeking = false));

  // ---- trackpad ----
  const pad = h("div", { class: "rm-pad" }, h("span", {}, "Drag to scroll · flick to glide"));
  let lastY = 0;
  let acc = 0;
  let flushTimer = 0;
  let samples = [];
  const flush = () => {
    flushTimer = 0;
    if (!acc) return;
    send(id, { type: "scroll", dy: (acc / pad.clientHeight) * PAD_GAIN });
    acc = 0;
  };
  pad.addEventListener("pointerdown", (e) => {
    pad.setPointerCapture(e.pointerId);
    lastY = e.clientY;
    samples = [{ y: e.clientY, t: e.timeStamp }];
    pad.classList.add("active");
  });
  pad.addEventListener("pointermove", (e) => {
    if (!pad.hasPointerCapture(e.pointerId)) return;
    acc += lastY - e.clientY; // finger up = scroll down, like touch scrolling
    lastY = e.clientY;
    samples.push({ y: e.clientY, t: e.timeStamp });
    samples = samples.filter((s) => e.timeStamp - s.t < 100);
    // Direct channel: every frame. Via the server: ~20 updates/s.
    if (!flushTimer) flushTimer = setTimeout(flush, direct() ? 16 : 50);
  });
  const release = (e) => {
    pad.classList.remove("active");
    clearTimeout(flushTimer);
    flush();
    const first = samples[0];
    const last = samples[samples.length - 1];
    samples = [];
    if (!first || !last || last.t - first.t < 10 || e.timeStamp - last.t > 80) return;
    const v = (first.y - last.y) / ((last.t - first.t) / 1000); // px/s, up = positive
    if (Math.abs(v) > 300) send(id, { type: "fling", v: (v / pad.clientHeight) * PAD_GAIN });
  };
  pad.addEventListener("pointerup", release);
  pad.addEventListener("pointercancel", release);

  // ---- buttons ----
  const prevBtn = h("button", { class: "rm-btn", onclick: () => send(id, { type: "chapter", dir: -1 }) }, "‹ Ch");
  const upBtn = h("button", { class: "rm-btn", onclick: () => send(id, { type: "page", dir: -1 }), "aria-label": "Page up" }, "⇞");
  const playBtn = h("button", { class: "rm-btn play", onclick: () => send(id, { type: "autoplay", on: !st?.autoplay }) }, "▶");
  const downBtn = h("button", { class: "rm-btn", onclick: () => send(id, { type: "page", dir: 1 }), "aria-label": "Page down" }, "⇟");
  const nextBtn = h("button", { class: "rm-btn", onclick: () => send(id, { type: "chapter", dir: 1 }) }, "Ch ›");
  const speedVal = h("span", {}, "");
  const speed = h("input", { type: "range", min: 10, max: 1000, step: 5, "aria-label": "Auto-scroll speed" });
  speed.addEventListener("input", () => {
    speedVal.textContent = `${speed.value} px/s`;
    send(id, { type: "speed", value: +speed.value });
  });

  // ---- open a chapter on the screen ----
  const lib = getLibrary();
  const seriesSel = h(
    "select",
    { "aria-label": "Series" },
    lib.map((s) => h("option", { value: s.slug }, s.title))
  );
  const chapterSel = h("select", { "aria-label": "Chapter" });
  const fillChapters = (chapter) => {
    const s = lib.find((x) => x.slug === seriesSel.value);
    const want = chapter || store.progress(s?.slug)?.chapter;
    chapterSel.replaceChildren(
      ...(s?.chapters || []).map((c) => h("option", { value: c.id, selected: c.id === want }, `Chapter ${c.id}`))
    );
  };
  seriesSel.addEventListener("change", () => fillChapters());
  const openBtn = h(
    "button",
    {
      class: "rm-open",
      onclick: () => send(id, { type: "go", hash: `#/read/${seriesSel.value}/${chapterSel.value}` }),
    },
    "Open on screen"
  );
  const picker = h("details", { class: "rm-picker" }, h("summary", {}, "Open a chapter…"), h("div", { class: "rm-picker-row" }, seriesSel, chapterSel), openBtn);
  // Default to the most recently read series.
  const recent = Object.entries(store.get().progress || {}).sort((a, b) => (b[1].at || 0) - (a[1].at || 0))[0];
  if (recent && lib.some((s) => s.slug === recent[0])) seriesSel.value = recent[0];
  fillChapters();

  const controls = h(
    "div",
    { class: "rm-controls" },
    h("div", { class: "rm-row" }, prevBtn, upBtn, playBtn, downBtn, nextBtn),
    h("label", { class: "rm-speed" }, "Speed ", speedVal, speed)
  );
  const reading = h("div", { class: "rm-reading" }, previewBox, seek, pad, controls);
  const idle = h("div", { class: "rm-idle hidden" }, h("p", {}, "Nothing open on this screen."));
  const status = h("span", { class: "rm-status" }, "");
  const link = h("span", { class: "rm-link" }, "");

  shell(
    root,
    h("span", { class: "rm-now" }, cover, h("span", { class: "rm-now-txt" }, nowTitle, nowSub)),
    () => (location.hash = "#/remote"),
    link,
    status,
    reading,
    idle,
    picker
  );

  function render() {
    const reading_ = online && st?.view === "read";
    reading.classList.toggle("hidden", !reading_);
    idle.classList.toggle("hidden", reading_ || !online);
    status.textContent = online ? "" : "Screen offline — waiting for it to come back…";
    status.classList.toggle("hidden", online);
    link.textContent = !online ? "" : direct() ? "● Direct (same network)" : "○ Via server";
    link.classList.toggle("direct", direct());
    if (!st) return;
    cover.style.backgroundImage = st.poster ? bg(st.poster) : "";
    cover.classList.toggle("hidden", !st.poster);
    nowTitle.textContent = st.title || "Comicflix";
    nowSub.textContent =
      st.view === "read"
        ? `Ch. ${st.chapter} · page ${st.page || "–"}/${st.pages || "–"} · ${Math.round((st.frac || 0) * 100)}%`
        : describe(st, lib);
    if (st.pageSrc && preview.getAttribute("src") !== st.pageSrc) preview.src = st.pageSrc;
    if (!seeking) seek.value = String(Math.round((st.frac || 0) * 1000));
    playBtn.textContent = st.autoplay ? "❚❚" : "▶";
    playBtn.classList.toggle("on", !!st.autoplay);
    prevBtn.disabled = !st.prev;
    nextBtn.disabled = !st.next;
    if (document.activeElement !== speed && st.speed) {
      speed.value = String(st.speed);
      speedVal.textContent = `${st.speed} px/s`;
    }
    if (!reading_ && st.slug && !picker.open) picker.open = true;
  }

  function applyState(state) {
    online = true;
    st = state || {};
    render();
  }

  const es = new EventSource(withBase(`/api/remote/watch?id=${encodeURIComponent(id)}`));
  es.addEventListener("state", (e) => {
    applyState(JSON.parse(e.data).state);
    if (!pc) startPeer();
  });
  es.addEventListener("signal", async (e) => {
    const { to, data } = JSON.parse(e.data);
    if (to !== screenId || data?.type !== "answer" || !pc || pc.remoteDescription) return;
    try {
      await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
    } catch {
      dropPeer();
      retryLater();
    }
  });
  es.addEventListener("gone", () => {
    online = false;
    dropPeer();
  });
  render();

  return () => {
    closed = true;
    es.close();
    dropPeer();
    clearTimeout(flushTimer);
  };
}

/** Mount the remote into `root` (the screen list, or the controls for screen `id`).
 *  @param {HTMLElement} root  @param {() => any[]} getLibrary  @param {string | undefined} id
 *  @returns {() => void} cleanup */
export function mountRemote(root, getLibrary, id) {
  document.body.style.overflow = "hidden";
  const stop = id ? renderControl(root, id, getLibrary) : renderList(root, getLibrary);
  return () => {
    stop();
    root.replaceChildren();
    document.body.style.overflow = "";
  };
}
