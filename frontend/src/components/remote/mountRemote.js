// Remote control: drive another signed-in tab (a "screen", see screen.js) from this one.
//   #/remote        pick a screen; picking one turns on remote mode (lib/remoteTarget.ts):
//                   the app is then browsed normally and opening a chapter plays it there
//   #/remote/<id>   control it: trackpad, paging, auto-scroll, chapter, live page preview
// Commands and state use a direct WebRTC data channel to the screen when it connects
// (same Wi-Fi: no round trip through the server), else HTTP via the server.
import { h, bg } from "../../lib/dom";
import { withBase } from "../../lib/paths";
import { screenId } from "../../lib/screen";
import { newPeer, gathered, signal } from "../../lib/rtc";
import { getRemoteTarget, setRemoteTarget } from "../../lib/remoteTarget";
import { byReadingOrder, resumeTarget } from "../../lib/series";

const STALE_S = 60; // screens heartbeat every 20s
const PAD_GAIN = 2.2; // one full drag of the pad scrolls ~2 screens
const SPEED_MIN = 10;
const SPEED_MAX = 1000;
const SPEED_STEP = 10;
const HINT_KEY = "comikflix:remote-hint-seen";

function httpSend(id, cmd) {
  return fetch(withBase("/api/remote/cmd"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, cmd }),
  }).catch(() => {});
}

const buzz = () => {
  try {
    navigator.vibrate?.(8);
  } catch {
    /* not allowed here */
  }
};

const clampSpeed = (v) => Math.max(SPEED_MIN, Math.min(SPEED_MAX, Math.round(v / SPEED_STEP) * SPEED_STEP));

// ---- icons ----
const S = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  back: `<path d="M14.5 5.5 8 12l6.5 6.5" ${S} stroke-width="2.4"/>`,
  fwd: `<path d="M9.5 5.5 16 12l-6.5 6.5" ${S} stroke-width="2.2"/>`,
  chev: `<path d="M7 10l5 5 5-5" ${S} stroke-width="2.2"/>`,
  prevCh: `<path d="M6 5.5v13" ${S} stroke-width="2.4"/><path d="M18 6.5v11L9.5 12z" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>`,
  nextCh: `<path d="M18 5.5v13" ${S} stroke-width="2.4"/><path d="M6 6.5v11l8.5-5.5z" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>`,
  up: `<path d="M5.5 15.5 12 9l6.5 6.5" ${S} stroke-width="2.6"/>`,
  down: `<path d="M5.5 8.5 12 15l6.5-6.5" ${S} stroke-width="2.6"/>`,
  play: `<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>`,
  pause: `<rect x="6.5" y="5" width="4" height="14" rx="1.3" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.3" fill="currentColor"/>`,
  minus: `<path d="M6 12h12" ${S} stroke-width="2.4"/>`,
  plus: `<path d="M12 6v12M6 12h12" ${S} stroke-width="2.4"/>`,
  drag: `<path d="M12 4v16M8 7.5 12 4l4 3.5M8 16.5l4 3.5 4-3.5" ${S} stroke-width="1.8"/>`,
  screen: `<rect x="3" y="4.5" width="18" height="12" rx="2" ${S} stroke-width="1.8"/><path d="M8 20h8M12 16.5V20" ${S} stroke-width="1.8"/>`,
};
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "rc-ico");
  svg.innerHTML = ICONS[name];
  return svg;
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

/** Press-and-hold repeats `fn` (speed − / +). Returns a stop function for cleanup. */
function holdRepeat(el, fn) {
  let t = 0;
  const stop = () => {
    clearTimeout(t);
    clearInterval(t);
    t = 0;
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    stop();
    buzz();
    fn();
    t = setTimeout(() => (t = setInterval(fn, 70)), 420);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) el.addEventListener(ev, stop);
  el.addEventListener("click", (e) => e.detail === 0 && fn()); // keyboard activation
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  return stop;
}

// ---------------------------------------------------------------- screen list

function renderList(root, getLibrary) {
  const list = h("div", { class: "rc-list" }, h("div", { class: "rc-empty" }, h("span", {}, "Looking for screens…")));
  const target = getRemoteTarget();
  root.replaceChildren(
    h(
      "div",
      { class: "rc-page" },
      h(
        "header",
        { class: "rc-list-head" },
        h("button", { class: "rc-iconbtn", "aria-label": "Back", onclick: () => (location.hash = "#/") }, icon("back")),
        h("h1", {}, "Remote")
      ),
      h("p", { class: "rc-lead" }, "Pick a screen to control. Then browse comics here — whatever you open plays on that screen."),
      list,
      target
        ? h(
            "button",
            {
              class: "rc-ghost",
              onclick: () => {
                buzz();
                setRemoteTarget(null);
                location.hash = "#/";
              },
            },
            `Stop controlling ${target.name}`
          )
        : null
    )
  );

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
          { class: "rc-empty" },
          h("div", { class: "rc-card-ico" }, icon("screen")),
          h("b", {}, "No screens online"),
          h("span", {}, "Open the app on your laptop (signed in, tab visible) and it will show up here.")
        )
      );
      return;
    }
    const current = getRemoteTarget()?.id;
    list.replaceChildren(
      ...screens.map((s) => {
        const away = s.state?.visible === false;
        const txt = describe(s.state, getLibrary());
        return h(
          "button",
          {
            class: `rc-screen${s.id === current ? " current" : ""}`,
            onclick: () => {
              buzz();
              setRemoteTarget({ id: s.id, name: s.name || "Screen" });
              location.hash = `#/remote/${s.id}`;
            },
          },
          h("span", { class: `rc-screen-ico${away ? " idle" : ""}` }, icon("screen"), h("i")),
          h(
            "span",
            { class: "rc-screen-txt" },
            h("b", {}, s.name || "Screen"),
            h("small", {}, away ? `In background · ${txt}` : txt)
          ),
          s.id === current ? h("span", { class: "rc-badge" }, "Controlling") : null,
          h("span", { class: "rc-go" }, icon("fwd"))
        );
      })
    );
  }
  refresh();
  // Poll only while this tab is visible; catch up as soon as it comes back.
  const timer = setInterval(() => !document.hidden && refresh(), 3000);
  const onVis = () => !document.hidden && refresh();
  document.addEventListener("visibilitychange", onVis);
  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVis);
  };
}

// ---------------------------------------------------------------- controls

function renderControl(root, id, getLibrary) {
  let st = null;
  let online = false;
  let wentAway = false; // the screen was seen and then went away (vs. still connecting)
  const saved = getRemoteTarget();
  let name = saved?.id === id ? saved.name : "Screen";

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

  const press = (fn) => () => {
    buzz();
    fn();
  };
  const go = (hash) => (location.hash = hash);

  // ---- top bar ----
  const nameTxt = h("span", {}, name);
  const linkTxt = h("span", {}, "");
  const link = h("span", { class: "rc-link" }, h("i"), linkTxt);
  const top = h(
    "header",
    { class: "rc-top" },
    h("button", { class: "rc-browse", onclick: press(() => go("#/")) }, icon("back"), h("span", {}, "Browse")),
    h("button", { class: "rc-name", title: "Switch screen", onclick: press(() => go("#/remote")) }, nameTxt, icon("chev")),
    link,
    h(
      "button",
      {
        class: "rc-stop",
        onclick: press(() => {
          setRemoteTarget(null);
          go("#/");
        }),
      },
      "Stop"
    )
  );

  // ---- now playing ----
  const thumbImg = h("img", { alt: "", decoding: "async", class: "hidden" });
  const thumb = h("button", { class: "rc-thumb", "aria-label": "Show the current page", onclick: () => openPreview() }, thumbImg);
  const nowTitle = h("b", {}, "Connecting…");
  const nowSub = h("small", {}, "");
  const chapLabel = h("span", {}, "Ch.");
  const chapSel = h("select", { "aria-label": "Chapter" });
  const chapPick = h("label", { class: "rc-chap hidden", title: "Jump to chapter" }, chapLabel, icon("chev"), chapSel);
  chapSel.addEventListener("change", () => {
    if (!st?.slug || !chapSel.value) return;
    buzz();
    chapLabel.textContent = `Ch. ${chapSel.value}`;
    send(id, { type: "go", hash: `#/read/${st.slug}/${chapSel.value}` });
  });
  const now = h(
    "div",
    { class: "rc-now" },
    thumb,
    h("button", { class: "rc-now-txt", onclick: () => openPreview() }, nowTitle, nowSub),
    chapPick
  );

  // ---- seek ----
  const seek = h("input", { type: "range", min: 0, max: 1000, value: 0, class: "rc-range rc-seek", "aria-label": "Position in chapter" });
  const seekFill = () => seek.style.setProperty("--fill", `${seek.value / 10}%`);
  let seeking = false;
  seek.addEventListener("pointerdown", () => (seeking = true));
  seek.addEventListener("input", () => {
    seekFill();
    send(id, { type: "seek", frac: seek.value / 1000 });
  });
  seek.addEventListener("change", () => (seeking = false));
  // A tap that doesn't move the thumb fires no "change": let state drive the bar again.
  seek.addEventListener("pointerup", () => setTimeout(() => (seeking = false), 600));

  // ---- trackpad ----
  let hintSeen = false;
  try {
    hintSeen = localStorage.getItem(HINT_KEY) === "1";
  } catch {
    /* storage blocked */
  }
  const hint = h(
    "div",
    { class: `rc-hint${hintSeen ? " gone" : ""}` },
    icon("drag"),
    h("b", {}, "Trackpad"),
    h("span", {}, "Drag to scroll · flick to glide"),
    h("span", {}, "Double-tap to play / pause")
  );
  const padBadge = h("div", { class: "rc-pad-badge" }, "Auto-scroll");
  const touchDot = h("div", { class: "rc-touch" });
  const flash = h("div", { class: "rc-flash" });
  const pad = h("div", { class: "rc-pad", "aria-label": "Trackpad" }, hint, padBadge, touchDot, flash);
  let lastY = 0;
  let acc = 0;
  let flushTimer = 0;
  let samples = [];
  let padRect = null;
  let texY = 0;
  let down = null; // { x, y, t, moved } for tap detection
  let lastTap = 0;
  const flush = () => {
    flushTimer = 0;
    if (!acc) return;
    send(id, { type: "scroll", dy: (acc / pad.clientHeight) * PAD_GAIN });
    acc = 0;
  };
  const moveDot = (e) => {
    if (!padRect) return;
    touchDot.style.transform = `translate(${e.clientX - padRect.left}px, ${e.clientY - padRect.top}px)`;
  };
  const hideHint = () => {
    if (hintSeen) return;
    hintSeen = true;
    hint.classList.add("gone");
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      /* storage blocked */
    }
  };
  pad.addEventListener("pointerdown", (e) => {
    pad.setPointerCapture(e.pointerId);
    lastY = e.clientY;
    samples = [{ y: e.clientY, t: e.timeStamp }];
    pad.classList.add("active");
    padRect = pad.getBoundingClientRect();
    moveDot(e);
    touchDot.classList.add("on");
    down = { x: e.clientX, y: e.clientY, t: e.timeStamp, moved: false };
  });
  pad.addEventListener("pointermove", (e) => {
    if (!pad.hasPointerCapture(e.pointerId)) return;
    acc += lastY - e.clientY; // finger up = scroll down, like touch scrolling
    texY += e.clientY - lastY; // the texture follows the finger
    pad.style.setProperty("--tex-y", `${texY}px`);
    lastY = e.clientY;
    moveDot(e);
    if (down && !down.moved && Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 10) {
      down.moved = true;
      hideHint();
    }
    samples.push({ y: e.clientY, t: e.timeStamp });
    samples = samples.filter((s) => e.timeStamp - s.t < 100);
    // Direct channel: every frame. Via the server: ~20 updates/s.
    if (!flushTimer) flushTimer = setTimeout(flush, direct() ? 16 : 50);
  });
  const release = (e) => {
    pad.classList.remove("active");
    touchDot.classList.remove("on");
    clearTimeout(flushTimer);
    flush();
    const first = samples[0];
    const last = samples[samples.length - 1];
    samples = [];
    const tap = down && !down.moved && e.type === "pointerup" && e.timeStamp - down.t < 280;
    down = null;
    if (tap) {
      if (lastTap && e.timeStamp - lastTap < 350) {
        lastTap = 0;
        hideHint();
        togglePlay();
      } else lastTap = e.timeStamp;
      return;
    }
    lastTap = 0;
    if (!first || !last || last.t - first.t < 10 || e.timeStamp - last.t > 80) return;
    const v = (first.y - last.y) / ((last.t - first.t) / 1000); // px/s, up = positive
    if (Math.abs(v) > 300) send(id, { type: "fling", v: (v / pad.clientHeight) * PAD_GAIN });
  };
  pad.addEventListener("pointerup", release);
  pad.addEventListener("pointercancel", release);
  pad.addEventListener("contextmenu", (e) => e.preventDefault());

  // ---- play / pause (optimistic: the screen's confirmation can lag ~1s over HTTP) ----
  let localPlay = null; // { on, until }
  const playing = () => (localPlay && performance.now() < localPlay.until ? localPlay.on : !!st?.autoplay);
  function togglePlay() {
    const on = !playing();
    localPlay = { on, until: performance.now() + 1500 };
    send(id, { type: "autoplay", on });
    buzz();
    flash.replaceChildren(icon(on ? "play" : "pause"));
    flash.classList.remove("go");
    void flash.offsetWidth; // restart the animation
    flash.classList.add("go");
    render();
  }

  // ---- transport ----
  const tbtn = (label, ic, fn) => h("button", { class: "rc-t", title: label, "aria-label": label, onclick: press(fn) }, icon(ic));
  const prevBtn = tbtn("Previous chapter", "prevCh", () => send(id, { type: "chapter", dir: -1 }));
  const upBtn = tbtn("Page up", "up", () => send(id, { type: "page", dir: -1 }));
  const playBtn = h("button", { class: "rc-t rc-play", title: "Play / pause", "aria-label": "Play", onclick: () => togglePlay() }, icon("play"));
  let playIcon = "play";
  const downBtn = tbtn("Page down", "down", () => send(id, { type: "page", dir: 1 }));
  const nextBtn = tbtn("Next chapter", "nextCh", () => send(id, { type: "chapter", dir: 1 }));
  const transport = h("div", { class: "rc-transport" }, prevBtn, upBtn, playBtn, downBtn, nextBtn);

  // ---- speed ----
  const speedNum = h("b", {}, "–");
  const speedVal = h("span", { class: "rc-speed-val" }, speedNum, h("small", {}, "px/s"));
  const speed = h("input", { type: "range", min: SPEED_MIN, max: SPEED_MAX, step: SPEED_STEP, class: "rc-range", "aria-label": "Auto-scroll speed" });
  let speedTouched = 0;
  const showSpeed = (v) => {
    speed.value = String(v);
    speedNum.textContent = String(v);
    padBadge.textContent = `Auto-scroll · ${v} px/s`;
    speed.style.setProperty("--fill", `${((v - SPEED_MIN) / (SPEED_MAX - SPEED_MIN)) * 100}%`);
  };
  const setSpeed = (v) => {
    speedTouched = performance.now();
    showSpeed(v);
    send(id, { type: "speed", value: v });
  };
  speed.addEventListener("input", () => setSpeed(+speed.value));
  const nudge = (d) => {
    const v = clampSpeed(+speed.value + d);
    if (v !== +speed.value || speedNum.textContent !== String(v)) setSpeed(v);
  };
  const minusBtn = h("button", { class: "rc-step", title: "Slower", "aria-label": "Slower" }, icon("minus"));
  const plusBtn = h("button", { class: "rc-step", title: "Faster", "aria-label": "Faster" }, icon("plus"));
  const stopHolds = [holdRepeat(minusBtn, () => nudge(-SPEED_STEP)), holdRepeat(plusBtn, () => nudge(SPEED_STEP))];
  const speedRow = h("div", { class: "rc-speed" }, minusBtn, speed, plusBtn, speedVal);

  const controls = h("div", { class: "rc-controls" }, transport, speedRow);

  // ---- idle / offline cards ----
  const idleTitle = h("b", {}, "");
  const idleSub = h("span", {}, "");
  const contTxt = h("span", {}, "");
  let contHash = "";
  const contBtn = h(
    "button",
    { class: "rc-primary hidden", onclick: press(() => contHash && send(id, { type: "go", hash: contHash })) },
    icon("play"),
    contTxt
  );
  const idle = h(
    "div",
    { class: "rc-card hidden" },
    h("div", { class: "rc-card-ico" }, icon("screen")),
    idleTitle,
    idleSub,
    contBtn,
    h("button", { class: "rc-secondary", onclick: press(() => go("#/")) }, "Browse comics")
  );
  const offTitle = h("b", {}, "");
  const offline = h(
    "div",
    { class: "rc-card hidden" },
    h("div", { class: "rc-spin" }),
    offTitle,
    h("span", {}, "Keep the app open and visible on that screen — this reconnects by itself."),
    h(
      "div",
      { class: "rc-card-row" },
      h("button", { class: "rc-secondary", onclick: press(() => go("#/remote")) }, "Switch screen"),
      h("button", { class: "rc-secondary", onclick: press(() => go("#/")) }, "Browse")
    )
  );
  const stage = h("main", { class: "rc-stage" }, pad, idle, offline);

  // ---- large preview of the current page ----
  const bigImg = h("img", { alt: "Current page" });
  const bigCap = h("span", {}, "");
  const overlay = h(
    "div",
    { class: "rc-preview hidden", role: "dialog", "aria-label": "Current page", onclick: () => closePreview() },
    bigImg,
    h("div", { class: "rc-preview-cap" }, bigCap, h("span", {}, "Tap to close"))
  );
  let previewOpen = false;
  function openPreview() {
    if (!online || st?.view !== "read" || !st.pageSrc) return;
    buzz();
    previewOpen = true;
    overlay.classList.remove("hidden");
    render();
  }
  function closePreview() {
    previewOpen = false;
    overlay.classList.add("hidden");
  }

  root.replaceChildren(h("div", { class: "rc-col" }, top, now, seek, stage, controls), overlay);

  // ---- render ----
  let chapFor = "";
  function fillChapters() {
    const s = getLibrary().find((x) => x.slug === st.slug);
    const key = `${st.slug}|${s?.chapters?.length || 0}`;
    if (key !== chapFor) {
      chapFor = key;
      chapSel.replaceChildren(...(s?.chapters || []).map((c) => h("option", { value: c.id }, `Chapter ${c.id}`)));
    }
    if (document.activeElement !== chapSel && st.chapter && chapSel.value !== st.chapter) chapSel.value = st.chapter;
    chapLabel.textContent = st.chapter ? `Ch. ${st.chapter}` : "Ch.";
  }

  let idleFor = null;
  function fillIdle() {
    const key = `${st?.view}|${st?.slug}|${name}`;
    if (key === idleFor) return;
    idleFor = key;
    idleTitle.textContent = `Nothing playing on ${name}`;
    idleSub.textContent = st?.view === "series" && st.title ? `It's showing ${st.title}.` : "Pick something to read — it opens there.";
    // The series on screen if any, else the one you read most recently.
    const lib = getLibrary().filter((s) => s.chapters?.length);
    const s = (st?.slug && lib.find((x) => x.slug === st.slug)) || [...lib].sort(byReadingOrder)[0];
    if (!s) {
      contHash = "";
      contBtn.classList.add("hidden");
      return;
    }
    const r = resumeTarget(s);
    contHash = `#/read/${s.slug}/${r.chapter}`;
    contTxt.textContent = `${r.label} ${s.title} · Ch. ${r.chapter}`;
    contBtn.classList.remove("hidden");
  }

  let thumbFor = "";
  function render() {
    const reading = online && st?.view === "read";
    root.classList.toggle("rc-reading", reading);
    pad.classList.toggle("hidden", !reading);
    controls.classList.toggle("hidden", !reading);
    seek.classList.toggle("invisible", !reading);
    chapPick.classList.toggle("hidden", !reading);
    idle.classList.toggle("hidden", !online || reading);
    offline.classList.toggle("hidden", online);
    if (!reading && previewOpen) closePreview();

    nameTxt.textContent = name;
    const d = direct();
    linkTxt.textContent = !online ? "Offline" : d ? "Direct" : "Via server";
    link.classList.toggle("direct", online && d);
    link.classList.toggle("off", !online);
    link.title = !online ? "Screen not connected" : d ? "Direct connection (same network)" : "Commands go through the server";

    if (!online) {
      offTitle.textContent = wentAway ? `Waiting for ${name}…` : `Connecting to ${name}…`;
      nowTitle.textContent = st?.title || name;
      nowSub.textContent = wentAway ? "Screen offline" : "Connecting…";
    }
    if (!st) return;

    // thumbnail: the current page while reading, else the poster
    const src = reading ? st.pageSrc || "" : "";
    if (src !== thumbFor) {
      thumbFor = src;
      if (src) thumbImg.src = src;
      else thumbImg.removeAttribute("src");
      thumbImg.classList.toggle("hidden", !src);
    }
    thumb.style.backgroundImage = !src && st.poster ? bg(st.poster) : "";
    thumb.classList.toggle("empty", !src && !st.poster);
    if (!online) return;

    nowTitle.textContent = st.title || name;
    if (!reading) {
      nowSub.textContent = describe(st, getLibrary());
      fillIdle();
      return;
    }
    idleFor = null;
    nowSub.textContent = `Page ${st.page || "–"} of ${st.pages || "–"} · ${Math.round((st.frac || 0) * 100)}%`;
    fillChapters();
    if (!seeking) {
      seek.value = String(Math.round((st.frac || 0) * 1000));
      seekFill();
    }
    const on = playing();
    if (playIcon !== (on ? "pause" : "play")) {
      playIcon = on ? "pause" : "play";
      playBtn.replaceChildren(icon(playIcon));
      playBtn.setAttribute("aria-label", on ? "Pause" : "Play");
    }
    playBtn.classList.toggle("on", on);
    pad.classList.toggle("playing", on);
    prevBtn.disabled = !st.prev;
    nextBtn.disabled = !st.next;
    if (st.speed && document.activeElement !== speed && performance.now() - speedTouched > 1500) showSpeed(st.speed);
    if (previewOpen) {
      if (st.pageSrc && bigImg.getAttribute("src") !== st.pageSrc) bigImg.src = st.pageSrc;
      bigCap.textContent = `Page ${st.page || "–"} of ${st.pages || "–"}`;
    }
  }

  function applyState(state) {
    online = true;
    st = state || {};
    render();
  }

  // ---- keyboard (controlling from a laptop) ----
  const onKey = (e) => {
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === "Escape" && previewOpen) return closePreview();
    if (!(online && st?.view === "read") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === " " && tag !== "BUTTON") {
      e.preventDefault();
      togglePlay();
    } else if (e.key === "ArrowDown" || e.key === "PageDown") {
      e.preventDefault();
      send(id, { type: "page", dir: 1 });
    } else if (e.key === "ArrowUp" || e.key === "PageUp") {
      e.preventDefault();
      send(id, { type: "page", dir: -1 });
    } else if (e.key === "ArrowRight" && st.next) send(id, { type: "chapter", dir: 1 });
    else if (e.key === "ArrowLeft" && st.prev) send(id, { type: "chapter", dir: -1 });
  };
  window.addEventListener("keydown", onKey);

  // Opening a screen's controls (old link, history) means controlling it: remote mode on.
  if (saved?.id !== id) {
    setRemoteTarget({ id, name });
    fetch(withBase("/api/remote/screens"))
      .then((r) => r.json())
      .then((screens) => {
        const s = Array.isArray(screens) && screens.find((x) => x.id === id);
        if (!closed && s?.name && getRemoteTarget()?.id === id) {
          name = s.name;
          setRemoteTarget({ id, name });
          idleFor = null;
          render();
        }
      })
      .catch(() => {});
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
    wentAway = true;
    dropPeer();
  });
  render();

  return () => {
    closed = true;
    es.close();
    dropPeer();
    clearTimeout(flushTimer);
    stopHolds.forEach((f) => f());
    window.removeEventListener("keydown", onKey);
  };
}

/** Mount the remote into `root` (the screen list, or the controls for screen `id`).
 *  @param {HTMLElement} root  @param {() => any[]} getLibrary  @param {string | undefined} id
 *  @returns {() => void} cleanup */
export function mountRemote(root, getLibrary, id) {
  document.body.style.overflow = "hidden";
  root.classList.add("rc-root");
  const stop = id ? renderControl(root, id, getLibrary) : renderList(root, getLibrary);
  return () => {
    stop();
    root.replaceChildren();
    root.classList.remove("rc-reading");
    document.body.style.overflow = "";
  };
}
