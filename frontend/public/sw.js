/* Comicflix service worker (React build). Asset names are content-hashed, so nothing is
   precached by name: the shell and assets are network-first (cache = offline fallback, so a
   deploy shows up on a normal reload), media cache-first. */
const VERSION = "comicflix-react-v1";
const BASE = self.location.pathname.replace(/\/sw\.js$/, "");

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll([`${BASE}/`])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
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

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone()).catch(() => {});
  return res;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  const path = url.pathname.slice(BASE.length) || "/";
  if (path === "/api/library") return event.respondWith(networkFirst(event.request));
  if (path.startsWith("/media/") || path.startsWith("/api/r2/")) return event.respondWith(cacheFirst(event.request));
  if (path.startsWith("/api/")) return; // live data: never cached
  event.respondWith(networkFirst(event.request)); // shell, assets, icons, manifest
});
