// sw.js — v5 (fix: no stale app.js, no stale API)
// Strategy:
// - index.html + app.js + style.css: NETWORK FIRST (always try fresh)
// - /api/* : NETWORK ONLY (never cache API responses)
// - /data/* : STALE-WHILE-REVALIDATE (cache ok, but update in background)

const CACHE_VERSION = "jamo-v5"; // <-- bump this any time you deploy changes
const CORE_ASSETS = [
  "/",              // may map to index.html
  "/index.html",
  "/app.js",
  "/style.css",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await cache.addAll(CORE_ASSETS.map(u => new Request(u, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // delete old caches
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k === CACHE_VERSION ? null : caches.delete(k))));
    await self.clients.claim();
  })());
});

function isApi(reqUrl) {
  return reqUrl.pathname.startsWith("/api/");
}

function isData(reqUrl) {
  return reqUrl.pathname.startsWith("/data/");
}

function isCore(reqUrl) {
  return (
    reqUrl.pathname === "/" ||
    reqUrl.pathname === "/index.html" ||
    reqUrl.pathname === "/app.js" ||
    reqUrl.pathname === "/style.css"
  );
}

// NETWORK FIRST for core assets
async function networkFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error("offline");
  }
}

// STALE WHILE REVALIDATE for data
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((fresh) => {
      if (fresh && fresh.ok) cache.put(request, fresh.clone());
      return fresh;
    })
    .catch(() => null);

  return cached || (await fetchPromise) || new Response("offline", { status: 503 });
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin GET requests
  if (event.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  // ✅ API: never cache (prevents weird “flash then disappear”)
  if (isApi(url)) {
    event.respondWith(fetch(event.request));
    return;
  }

  // ✅ Core assets: network-first (always update)
  if (isCore(url)) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // ✅ Data json: cache ok but refresh
  if (isData(url)) {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }

  // default: try cache, fallback network
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(event.request);
    if (cached) return cached;

    const fresh = await fetch(event.request);
    if (fresh && fresh.ok) cache.put(event.request, fresh.clone());
    return fresh;
  })());
});
