// sw.js — Jamo PWA cache strategy (fix "stale CSS/JS forever")
const VERSION = "jamo-v3"; // <- aumenta quando fai cambi grossi
const STATIC_CACHE = `${VERSION}-static`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

// Asset di base (solo quelli veramente "core")
const CORE_ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((k) => {
          if (k !== STATIC_CACHE && k !== RUNTIME_CACHE) return caches.delete(k);
          return null;
        })
      )
    )
  );
  self.clients.claim();
});

// Helpers
function isHTML(req) {
  return req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
}
function isStatic(reqUrl) {
  return (
    reqUrl.pathname.endsWith(".css") ||
    reqUrl.pathname.endsWith(".js") ||
    reqUrl.pathname.endsWith(".webmanifest") ||
    reqUrl.pathname.endsWith(".png") ||
    reqUrl.pathname.endsWith(".svg") ||
    reqUrl.pathname.endsWith(".jpg") ||
    reqUrl.pathname.endsWith(".jpeg") ||
    reqUrl.pathname.endsWith(".webp") ||
    reqUrl.pathname.endsWith(".ico")
  );
}

// Strategy 1: Network-first per HTML (evita "index vecchio" che rompe tutto)
async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const fresh = await fetch(request);
    // cache solo risposte ok
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(request);
    return cached || caches.match("/index.html");
  }
}

// Strategy 2: Stale-while-revalidate per static (CSS/JS/icons)
async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((fresh) => {
      if (fresh && fresh.ok) cache.put(request, fresh.clone());
      return fresh;
    })
    .catch(() => null);

  // rispondi subito col cached se c’è, intanto aggiorna in background
  return cached || (await fetchPromise) || cached;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // solo stessa origin
  if (url.origin !== self.location.origin) return;

  // HTML: network-first
  if (isHTML(req)) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Static: stale-while-revalidate
  if (isStatic(url)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Default: cache-first semplice (runtime)
  event.respondWith(
    caches.open(RUNTIME_CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      if (cached) return cached;
      const fresh = await fetch(req);
      if (fresh && fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    })
  );
});
