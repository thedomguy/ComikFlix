/* Comicflix service worker (React build). Nothing is precached by name except the shell.
   - Shell (navigations), manifest, /api/library, /api/watchlist: network-first (cache = offline fallback, so a
     deploy shows up on a normal reload).
   - /assets/ (content-hashed) and /icons/: cache-first. After each fresh shell, cached assets
     that the new HTML (or the JS/CSS it loads) no longer references are dropped.
   - /api/r2/: cache-first. Other /api/: never cached. */
const VERSION = "comicflix-react-v2";
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

/** File name under /assets/ for a cached request URL, or null for anything else. */
function assetName(url) {
  const u = new URL(url);
  if (u.origin !== self.location.origin) return null;
  const path = u.pathname.slice(BASE.length);
  return path.startsWith("/assets/") ? path.slice("/assets/".length) : null;
}

/** Drop cached /assets/* files the current shell no longer uses (old builds). A file counts as
 *  used when the HTML names it, or a used JS/CSS file does (lazy chunks, fonts). */
async function pruneAssets(html) {
  const live = new Set();
  for (const m of html.matchAll(/assets\/([^"'\s?#()<>]+)/g)) live.add(m[1]);
  if (!live.size) return; // not a built shell (dev server, error page): leave the cache alone
  const cache = await caches.open(VERSION);
  const assets = (await cache.keys()).filter((req) => assetName(req.url) !== null);
  let refs = "";
  for (const req of assets) {
    const name = assetName(req.url);
    if (!live.has(name) || !/\.(js|css)$/.test(name)) continue;
    const res = await cache.match(req);
    if (res) refs += await res.text().catch(() => "");
  }
  await Promise.all(
    assets
      .filter((req) => {
        const name = assetName(req.url);
        return !live.has(name) && !refs.includes(name);
      })
      .map((req) => cache.delete(req))
  );
}

/** Network-first shell; a fresh copy also prunes assets left over from older builds. */
async function shell(event) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(event.request);
    if (res.ok) {
      cache.put(event.request, res.clone()).catch(() => {});
      event.waitUntil(
        res.clone().text().then(pruneAssets).catch(() => {})
      );
    }
    return res;
  } catch (err) {
    const cached = (await cache.match(event.request)) || (await cache.match(`${BASE}/`));
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  const path = url.pathname.slice(BASE.length) || "/";
  if (path === "/api/library" || path === "/api/watchlist") return event.respondWith(networkFirst(event.request));
  if (path.startsWith("/api/r2/")) return event.respondWith(cacheFirst(event.request));
  if (path.startsWith("/api/")) return; // live data: never cached
  if (path.startsWith("/assets/") || path.startsWith("/icons/")) return event.respondWith(cacheFirst(event.request));
  if (event.request.mode === "navigate") return event.respondWith(shell(event));
  event.respondWith(networkFirst(event.request)); // manifest, sw-adjacent files, ...
});
