/* Comicflix service worker — shell cache-first, library network-first, media on visit. */
const VERSION = "comicflix-v3";
const SHELL = [
  "/",
  "/index.html",
  "/css/app.css",
  "/js/app.js",
  "/js/store.js",
  "/js/dom.js",
  "/js/home.js",
  "/js/detail.js",
  "/js/reader.js",
  "/js/ingest-ui.js",
  "/js/router.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
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

  if (url.pathname.startsWith("/api/ingest")) return; // network only

  if (url.pathname === "/api/library") {
    event.respondWith(networkFirst(event.request, VERSION));
    return;
  }

  if (url.pathname.startsWith("/media/")) {
    event.respondWith(cacheFirst(event.request, VERSION));
    return;
  }

  // App shell & static assets
  if (
    url.pathname === "/" ||
    url.pathname.startsWith("/css/") ||
    url.pathname.startsWith("/js/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname.endsWith(".webmanifest") ||
    url.pathname === "/index.html"
  ) {
    event.respondWith(cacheFirst(event.request, VERSION));
  }
});
