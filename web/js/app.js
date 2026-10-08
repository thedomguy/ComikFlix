import { $ } from "./dom.js";
import { store } from "./store.js";
import { createRouter } from "./router.js";
import { initIngestUI, toast } from "./ingest-ui.js";
import { BASE, withBase, fixLibrary } from "./paths.js";
import { initScreen } from "./screen.js";

let library = [];

async function refreshLibrary() {
  try {
    library = fixLibrary(await (await fetch(withBase("/api/library"))).json());
  } catch {
    return;
  }
  if (!location.hash.startsWith("#/read")) router.route();
}

const router = createRouter({
  getLibrary: () => library,
  refreshLibrary,
});

function updateOfflineBanner() {
  const el = $("#offline");
  if (!el) return;
  el.classList.toggle("hidden", navigator.onLine);
}

function initNav() {
  const nav = $("#nav");
  const search = $("#search");
  const toggle = $("#search-toggle");
  window.addEventListener("scroll", () => nav.classList.toggle("solid", scrollY > 40), { passive: true });
  search.addEventListener("input", () => {
    if (location.hash && location.hash !== "#/") location.hash = "#/";
    else router.route();
  });
  toggle?.addEventListener("click", () => {
    nav.classList.toggle("search-open");
    if (nav.classList.contains("search-open")) search.focus();
  });
  window.addEventListener("online", updateOfflineBanner);
  window.addEventListener("offline", updateOfflineBanner);
  updateOfflineBanner();
}

function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  const ok = location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (!ok) return;
  navigator.serviceWorker.register(withBase("/sw.js"), BASE ? { scope: `${BASE}/` } : undefined).catch(() => {});
}

// Install button: Chromium hands us an install prompt via beforeinstallprompt; iOS
// Safari never does, so there the button explains Share → Add to Home Screen.
function initInstall() {
  const btn = $("#installbtn");
  const standalone =
    matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (!btn || standalone) return;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let deferred = null;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    btn.classList.remove("hidden");
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    btn.classList.add("hidden");
  });
  if (ios) btn.classList.remove("hidden");

  btn.addEventListener("click", async () => {
    if (deferred) {
      deferred.prompt();
      await deferred.userChoice;
      // A prompt event is single-use; Chromium re-fires beforeinstallprompt if it allows another.
      deferred = null;
      btn.classList.add("hidden");
    } else if (ios) {
      toast("Tap Share, then “Add to Home Screen”");
    }
  });
}

// ---- login ----
let loginShown = false;

async function showLogin(me) {
  if (loginShown) return;
  loginShown = true;
  document.documentElement.classList.remove("boot-read");
  if (!me) me = await realFetch(withBase("/api/me")).then((r) => r.json()).catch(() => ({}));
  const pinLen = me.pin || 0;
  const box = $("#login");
  const form = $("#login-form");
  const pin = $("#login-pin");
  const eye = $("#login-eye");
  const err = $("#login-err");

  async function submit() {
    err.textContent = "";
    if (!pin.value) return pin.focus();
    const res = await realFetch(withBase("/api/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: pin.value, base: BASE }),
    }).catch(() => null);
    if (res?.ok) return location.reload();
    err.textContent = (await res?.json().catch(() => null))?.error || "Could not sign in";
    pin.value = "";
    pin.focus();
  }

  eye.addEventListener("click", () => {
    const show = pin.type === "password";
    pin.type = show ? "text" : "password";
    eye.classList.toggle("on", show);
    eye.setAttribute("aria-label", show ? "Hide PIN" : "Show PIN");
    eye.title = eye.getAttribute("aria-label");
    pin.focus();
  });
  // Digits only; sign in as soon as the last digit is typed.
  pin.addEventListener("input", () => {
    pin.value = pin.value.replace(/\D/g, "").slice(0, pinLen || 8);
    if (pinLen && pin.value.length === pinLen) submit();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });
  box.classList.remove("hidden");
  pin.focus();
}

// Any API call that comes back 401 (session expired / signed out) brings up the login.
const realFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await realFetch(...args);
  if (res.status === 401) showLogin();
  return res;
};

function showLibraryError() {
  $("#home").textContent = "";
  $("#home").append(
    Object.assign(document.createElement("div"), {
      className: "empty",
      textContent: "Could not load the library.",
    })
  );
}

async function boot() {
  try {
    const me = await (await realFetch(withBase("/api/me"))).json();
    if (me.auth && !me.authed) return showLogin(me);
  } catch {
    /* offline: fall through to cached library */
  }
  initNav();
  initInstall();
  initIngestUI({
    refreshLibrary,
    onRunningChange: () => {
      if (location.hash.startsWith("#/series")) router.route();
    },
  });
  registerSW();

  // Settings + progress must be ready before any route that reads the store;
  // the library fetch runs alongside so a reader deep link waits on one round-trip, not two.
  const libraryReq = fetch(withBase("/api/library")).then((r) => r.json());

  try {
    await store.bootstrap();
    library = fixLibrary(await libraryReq);
    router.route();
    initScreen(() => library);
  } catch {
    document.documentElement.classList.remove("boot-read");
    showLibraryError();
  }
}

boot();
