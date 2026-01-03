/* Jamo SW — v6.0
 * Goals:
 * 1) app.js ALWAYS fresh (network-first)
 * 2) API always fresh (network-only)
 * 3) data cached for speed (stale-while-revalidate)
 */

const VERSION = "jamo-sw-v6";
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE  = `${VERSION}-data`;

// Minimal app shell (add more if you want)
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/manifest.webmanifest"
];

// --- install: cache shell ---
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL_ASSETS.map(u => new Request(u, { cache: "reload" })));
    self.skipWaiting();
  })());
});

// --- activate: cleanup old caches ---
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.map(k => {
        if (!k.startsWith("jamo-sw-")) return null;
        if (k === SHELL_CACHE || k === DATA_CACHE) return null;
        return caches.delete(k);
      })
    );
    self.clients.claim();
  })());
});

function isSameOrigin(url) {
  try { return new URL(url).origin === self.location.origin; } catch { return false; }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(req);
    return cached || new Response("", { status: 504, statusText: "Offline" });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);

  const fetchPromise = fetch(req)
    .then((fresh) => {
      if (fresh && fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    })
    .catch(() => null);

  return cached || (await fetchPromise) || new Response("", { status: 504, statusText: "Offline" });
}

async function networkOnly(req) {
  return fetch(req);
}

// --- fetch routing ---
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = req.url;

  // Only GET handled
  if (req.method !== "GET") return;

  // Only same-origin
  if (!isSameOrigin(url)) return;

  const u = new URL(url);

  // 1) app.js must be fresh (network-first)
  if (u.pathname === "/app.js") {
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }

  // 2) API must be fresh (network-only)
  if (u.pathname.startsWith("/api/")) {
    event.respondWith(networkOnly(req));
    return;
  }

  // 3) data files cached (stale-while-revalidate)
  if (u.pathname.startsWith("/data/")) {
    event.respondWith(staleWhileRevalidate(req, DATA_CACHE));
    return;
  }

  // 4) html/css shell (network-first)
  if (u.pathname === "/" || u.pathname.endsWith(".html") || u.pathname.endsWith(".css")) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }

  // 5) everything else: SWR is ok
  event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
});
