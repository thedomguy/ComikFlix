import { $ } from "./dom.js";
import { store } from "./store.js";
import { createRouter } from "./router.js";
import { initIngestUI } from "./ingest-ui.js";
import { BASE, withBase, fixLibrary } from "./paths.js";

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
  initNav();
  initIngestUI({
    refreshLibrary,
    onRunningChange: () => {
      if (location.hash.startsWith("#/series")) router.route();
    },
  });
  registerSW();

  // Settings + progress must be ready before any route that reads the store.
  await store.bootstrap();

  try {
    const data = await (await fetch(withBase("/api/library"))).json();
    library = fixLibrary(data);
    router.route();
  } catch {
    showLibraryError();
  }
}

boot();
