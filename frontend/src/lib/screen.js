// Makes this tab a "screen" another signed-in device can drive (see remote.js).
// Commands arrive over a direct WebRTC data channel when one is up (same Wi-Fi), else
// over the SSE stream. State goes to connected remotes over their channels (~15/s);
// the server only gets it on view changes and a heartbeat, so the screen list stays fresh.
import { withBase } from "./paths";
import { newPeer, gathered, signal } from "./rtc";

const ID_KEY = "comicflix-screen-id";
const HEARTBEAT_MS = 20000; // remotes treat a screen silent for ~60s as gone
const CHANNEL_MS = 66; // state over a data channel: ~15/s
const SERVER_MS = 1000; // state over HTTP when no channel is open: 1/s

export const screenId = (() => {
  let id = null;
  try {
    id = sessionStorage.getItem(ID_KEY);
    if (!id) sessionStorage.setItem(ID_KEY, (id = crypto.randomUUID().slice(0, 12)));
  } catch {
    id = crypto.randomUUID().slice(0, 12);
  }
  return id;
})();

function deviceName() {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? "Android"
    : /iPhone|iPad/.test(ua) ? "iOS"
    : /Mac OS X/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows"
    : /CrOS/.test(ua) ? "ChromeOS"
    : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = navigator.brave ? "Brave"
    : /Edg\//.test(ua) ? "Edge"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${browser} on ${os}`;
}

let source = null;
let bridge = null; // set by the reader while a chapter is open
let getLibrary = () => [];
let beat = 0;
let lastView = "";
const peers = new Map(); // remote id -> { pc, channel }

/** The reader registers { state(), handle(cmd) } while open; null when it closes. */
export function setReaderBridge(b) {
  bridge = b;
  notifyState();
}

function snapshot() {
  const [, view = "", slug, chapter] = decodeURIComponent(location.hash).split("/");
  const s = slug && getLibrary().find((x) => x.slug === slug);
  return {
    view: view || "home",
    slug: s?.slug || null,
    title: s?.title || null,
    poster: s?.poster || null,
    chapter: view === "read" ? chapter : null,
    visible: document.visibilityState === "visible",
    ...(bridge && view === "read" ? bridge.state() : {}),
  };
}

function openChannels() {
  return [...peers.values()].filter((p) => p.channel?.readyState === "open");
}

// ---- state out: channels at ~15/s, server on change / heartbeat / fallback ----

function postServer(state = snapshot()) {
  if (!source) return;
  lastView = `${state.view}|${state.slug}|${state.chapter}`;
  fetch(withBase("/api/remote/state"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: screenId, state }),
  }).catch(() => {});
}

let timer = 0;
let lastFlush = 0;
function flush() {
  timer = 0;
  lastFlush = performance.now();
  const state = snapshot();
  const channels = openChannels();
  const msg = JSON.stringify({ type: "state", state });
  for (const p of channels) p.channel.send(msg);
  const view = `${state.view}|${state.slug}|${state.chapter}`;
  // The server copy feeds the screen list; only refresh it when the view changes,
  // or (no direct channel) as the fallback feed for remotes.
  if (view !== lastView || !channels.length) postServer(state);
}

/** Called on scroll, autoplay, navigation...; coalesced to the rates above. */
export function notifyState() {
  if (!source || timer) return;
  const every = openChannels().length ? CHANNEL_MS : SERVER_MS;
  timer = setTimeout(flush, Math.max(0, every - (performance.now() - lastFlush)));
}

// ---- commands in ----

function handle(cmd) {
  if (cmd.type === "signal") return onSignal(cmd.from, cmd.data);
  if (cmd.type === "go" && typeof cmd.hash === "string" && cmd.hash.startsWith("#/")) {
    location.hash = cmd.hash;
  } else if (bridge) {
    bridge.handle(cmd);
  }
}

function closePeer(rid) {
  const p = peers.get(rid);
  if (!p) return;
  peers.delete(rid);
  p.channel?.close();
  p.pc.close();
}

/** A remote offered a direct channel: answer it. */
async function onSignal(rid, data) {
  if (data?.type !== "offer" || typeof rid !== "string") return;
  closePeer(rid);
  const pc = newPeer();
  const peer = { pc, channel: null };
  peers.set(rid, peer);
  pc.ondatachannel = (e) => {
    const ch = (peer.channel = e.channel);
    ch.onopen = () => {
      ch.send(JSON.stringify({ type: "state", state: snapshot() }));
    };
    ch.onmessage = (m) => {
      try {
        handle(JSON.parse(m.data));
      } catch {
        /* malformed */
      }
    };
    ch.onclose = () => peers.get(rid) === peer && closePeer(rid);
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(pc.connectionState) && peers.get(rid) === peer) closePeer(rid);
  };
  try {
    await pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    signal({ screen: screenId, remote: rid, toScreen: false, data: { type: "answer", sdp: pc.localDescription.sdp } });
  } catch {
    closePeer(rid);
  }
}

// ---- connection lifecycle ----

function connect() {
  if (source) return;
  const url = withBase(`/api/remote/screen?id=${screenId}&name=${encodeURIComponent(deviceName())}`);
  source = new EventSource(url);
  source.addEventListener("hello", () => postServer());
  source.addEventListener("cmd", (e) => {
    try {
      handle(JSON.parse(e.data));
    } catch {
      /* malformed command */
    }
  });
  beat = setInterval(() => postServer(), HEARTBEAT_MS);
}

function disconnect() {
  source?.close();
  source = null;
  clearInterval(beat);
  clearTimeout(timer);
  timer = 0;
  for (const rid of [...peers.keys()]) closePeer(rid);
}

/** Only visible tabs are screens (you can't watch a hidden one, and over HTTP/1.1 each
 *  open stream eats one of the browser's ~6 connections per host). A tab acting as a
 *  remote is not itself a screen. */
function sync() {
  if (location.hash.startsWith("#/remote") || document.visibilityState !== "visible") disconnect();
  else {
    connect();
    notifyState();
  }
}

export function initScreen(libraryGetter) {
  getLibrary = libraryGetter;
  window.addEventListener("hashchange", sync);
  document.addEventListener("visibilitychange", sync);
  sync();
}
