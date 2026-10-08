/* Comicflix service worker — shell + library network-first (cache is the offline
   fallback, so deploys show up on a normal reload), media cache-first on visit. */
const VERSION = "comicflix-v25";
const BASE = self.location.pathname.replace(/\/sw\.js$/, "");
const p = (path) => `${BASE}${path}`;
const SHELL = [
  p("/"),
  p("/index.html"),
  p("/css/app.css"),
  p("/js/app.js"),
  p("/js/paths.js"),
  p("/js/store.js"),
  p("/js/dom.js"),
  p("/js/home.js"),
  p("/js/detail.js"),
  p("/js/reader.js"),
  p("/js/ingest-ui.js"),
  p("/js/router.js"),
  p("/js/screen.js"),
  p("/js/remote.js"),
  p("/js/rtc.js"),
  p("/js/downloads.js"),
  p("/manifest.webmanifest"),
  p("/icons/icon-192.png"),
  p("/icons/icon-512.png"),
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() =>
      self.clients.claim()
    )
  );
});

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) {
    try {
      await cache.put(request, res.clone());
    } catch {
      /* quota — ignore */
    }
  }
  return res;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;
  const under = (prefix) => path === `${BASE}${prefix}` || path.startsWith(`${BASE}${prefix}`);

  // Settings / progress / ingest / series mutations — network only (no stale cache).
  if (
    under("/api/ingest") ||
    under("/api/settings") ||
    under("/api/progress") ||
    under("/api/series")
  ) {
    return;
  }

  if (path === p("/api/library")) {
    event.respondWith(networkFirst(event.request, VERSION));
    return;
  }

  if (under("/media/") || under("/api/r2/")) {
    event.respondWith(cacheFirst(event.request, VERSION));
    return;
  }

  // App shell & static assets — network-first so a deploy never needs a hard refresh
  if (
    path === p("/") ||
    under("/css/") ||
    under("/js/") ||
    under("/icons/") ||
    path.endsWith(".webmanifest") ||
    path === p("/index.html")
  ) {
    event.respondWith(networkFirst(event.request, VERSION));
  }
});
