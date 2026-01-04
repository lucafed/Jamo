/* sw.js — Jamo (safe cache)
   - Never cache app.js / css / api
   - Network-first for freshness
   - Cache only static assets for offline
*/

const CACHE_NAME = "jamo-cache-v6"; // <-- cambia numero ad ogni deploy

const STATIC_ASSETS = [
  "/",               // index
  "/index.html",
  "/manifest.webmanifest",
  "/style.css",
  // icone se le hai (aggiungi i path reali se esistono)
  // "/icons/icon-192.png",
  // "/icons/icon-512.png",
];

// Install
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
});

// Activate
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // pulizia vecchie cache
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())));
    await self.clients.claim();
  })());
});

// Helpers
function isBypass(url) {
  // NON cacheare mai queste risorse (sempre rete)
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname === "/app.js" ||
    url.pathname.startsWith("/app.js") ||
    url.pathname === "/style.css" ||
    url.pathname.startsWith("/style.css")
  );
}

function isDataFile(url) {
  return url.pathname.startsWith("/data/") && url.pathname.endsWith(".json");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Solo stesso origin
  if (url.origin !== self.location.origin) return;

  // Bypass totale per API e file “sempre fresh”
  if (isBypass(url)) {
    event.respondWith(fetch(req));
    return;
  }

  // Network-first per tutto (così non rimani mai “indietro”)
  event.respondWith((async () => {
    try {
      const net = await fetch(req);
      // Cache solo se è una risposta ok e se è roba statica o /data/*.json
      if (net && net.ok && (isDataFile(url) || STATIC_ASSETS.includes(url.pathname))) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, net.clone()).catch(() => {});
      }
      return net;
    } catch (e) {
      // Offline fallback: prova cache
      const cached = await caches.match(req);
      if (cached) return cached;

      // Se è una pagina, prova index
      if (req.headers.get("accept")?.includes("text/html")) {
        const cachedIndex = await caches.match("/index.html");
        if (cachedIndex) return cachedIndex;
      }

      throw e;
    }
  })());
});
