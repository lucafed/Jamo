/* Jamo — sw.js v2 (SAFE CACHE)
 * Goals:
 * - NEVER cache /api (LIVE must be fresh)
 * - Cache static assets (app.js, style.css, index.html) with SWR
 * - Cache /data with SWR (fast + updates)
 * - Easy bust: bump SW_VERSION
 */

const SW_VERSION = "jamo-sw-v2.0.0";
const STATIC_CACHE = `static-${SW_VERSION}`;
const DATA_CACHE   = `data-${SW_VERSION}`;

const STATIC_ASSETS = [
  "/",            // optional (depends on hosting)
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    // Best effort: some hosts don't allow caching "/" directly
    await Promise.allSettled(STATIC_ASSETS.map((u) => cache.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.map((k) => {
        if (k !== STATIC_CACHE && k !== DATA_CACHE) return caches.delete(k);
      })
    );
    await self.clients.claim();
  })());
});

function isApi(reqUrl) {
  return reqUrl.pathname.startsWith("/api/");
}
function isData(reqUrl) {
  return reqUrl.pathname.startsWith("/data/");
}
function isStatic(reqUrl) {
  // treat these as static-ish assets (including cache-busted)
  return (
    reqUrl.pathname === "/" ||
    reqUrl.pathname === "/index.html" ||
    reqUrl.pathname === "/app.js" ||
    reqUrl.pathname === "/style.css" ||
    reqUrl.pathname === "/manifest.webmanifest" ||
    reqUrl.pathname.endsWith(".png") ||
    reqUrl.pathname.endsWith(".jpg") ||
    reqUrl.pathname.endsWith(".jpeg") ||
    reqUrl.pathname.endsWith(".webp") ||
    reqUrl.pathname.endsWith(".svg") ||
    reqUrl.pathname.endsWith(".ico")
  );
}

// Stale-while-revalidate
async function swr(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((resp) => {
      // only cache ok responses
      if (resp && resp.ok) cache.put(request, resp.clone());
      return resp;
    })
    .catch(() => null);

  // Return cached immediately if present, else wait network
  return cached || (await fetchPromise) || new Response("", { status: 504 });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Only handle same-origin
  if (url.origin !== self.location.origin) return;

  // ✅ 1) NEVER cache API (LIVE)
  if (isApi(url)) {
    event.respondWith(fetch(req).catch(() => new Response(JSON.stringify({
      ok: false,
      error: "Network error (api)",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    return;
  }

  // ✅ 2) Cache /data with SWR
  if (isData(url)) {
    event.respondWith(swr(req, DATA_CACHE));
    return;
  }

  // ✅ 3) Cache static with SWR
  if (isStatic(url)) {
    event.respondWith(swr(req, STATIC_CACHE));
    return;
  }

  // Default: network-first (no cache)
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
