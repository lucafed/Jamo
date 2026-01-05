/* sw.js — Jamo (safe cache) — v7
   - Never cache /api, app.js, style.css
   - Network-first for freshness
   - Cache only static assets + /data/*.json for offline
   - API fallback: never crash fetch (return ok:false JSON)
*/

const CACHE_NAME = "jamo-cache-v7"; // <-- cambia ad ogni deploy

const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/style.css",
  // aggiungi icone se esistono davvero:
  // "/icons/icon-192.png",
  // "/icons/icon-512.png",
];

// Install
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        await Promise.allSettled(STATIC_ASSETS.map((u) => cache.add(u)));
      } catch {}
    })()
  );
});

// Activate
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())));
    await self.clients.claim();
  })());
});

// Helpers
function isBypass(url) {
  // mai cache: API + app + css (anche con querystring)
  if (url.pathname.startsWith("/api/")) return true;
  if (url.pathname === "/app.js" || url.pathname.startsWith("/app.js")) return true;
  if (url.pathname === "/style.css" || url.pathname.startsWith("/style.css")) return true;
  return false;
}

function isDataFile(url) {
  return url.pathname.startsWith("/data/") && url.pathname.endsWith(".json");
}

function isStaticAsset(url) {
  return STATIC_ASSETS.includes(url.pathname);
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // stesso origin only
  if (url.origin !== self.location.origin) return;

  // ✅ Bypass totale per API e file “sempre fresh”
  if (isBypass(url)) {
    // API: non deve MAI far crashare la fetch → fallback JSON
    if (url.pathname.startsWith("/api/")) {
      event.respondWith(
        fetch(req).catch(() =>
          jsonResponse({ ok: false, error: "Network error (api)" }, 200)
        )
      );
      return;
    }

    // app.js / style.css: network-only, ma se offline prova cache (best effort)
    event.respondWith(
      fetch(req).catch(async () => {
        const cached = await caches.match(req);
        return cached || new Response("", { status: 504 });
      })
    );
    return;
  }

  // ✅ Network-first per tutto il resto, con caching selettivo
  event.respondWith((async () => {
    try {
      const net = await fetch(req);

      // cache solo se ok e se è static o data json
      if (net && net.ok && (isDataFile(url) || isStaticAsset(url))) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, net.clone()).catch(() => {});
      }
      return net;
    } catch (e) {
      // Offline fallback: prova cache
      const cached = await caches.match(req);
      if (cached) return cached;

      // se html, prova index
      const accept = req.headers.get("accept") || "";
      if (accept.includes("text/html")) {
        const cachedIndex = await caches.match("/index.html");
        if (cachedIndex) return cachedIndex;
      }

      return new Response("", { status: 504 });
    }
  })());
});
