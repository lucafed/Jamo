// /api/destinations.js — LIVE destinations via Overpass (FAST + FALLBACK + CACHE) — v3.0
// GET /api/destinations?lat=...&lon=...&radiusKm=...&cat=...
//
// Returns:
// { ok:true, data:{ elements:[...] }, meta:{ cat, radiusKm, endpoint, cached, ms } }
// { ok:false, error:"...", meta:{ ... } }

const TTL_MS = 1000 * 60 * 30; // 30 min cache
const cache = new Map(); // key -> { ts, payload }

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];

function now() { return Date.now(); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function pickQueryByCat(cat) {
  // NOTE: Queries are intentionally "tight" to avoid timeouts.
  // We focus on tourist/attraction objects, not generic POIs.

  // Helpers: we use `nwr` (node/way/relation)
  // around:radius_m,lat,lon
  // out center qt; -> faster response with center for ways/relations

  const baseOut = "out center qt;";

  switch (String(cat || "ovunque").toLowerCase()) {
    case "family":
      return `
        (
          nwr["tourism"="theme_park"](around:R,LA,LO);
          nwr["leisure"="water_park"](around:R,LA,LO);
          nwr["tourism"="zoo"](around:R,LA,LO);
          nwr["tourism"="aquarium"](around:R,LA,LO);
          nwr["tourism"="attraction"](around:R,LA,LO);
          nwr["amenity"="aquarium"](around:R,LA,LO);
          nwr["amenity"="zoo"](around:R,LA,LO);
          nwr["leisure"="swimming_pool"](around:R,LA,LO);
          nwr["leisure"="sports_centre"]["sport"="swimming"](around:R,LA,LO);
          nwr["leisure"="amusement_arcade"](around:R,LA,LO);
          nwr["leisure"="playground"](around:R,LA,LO);
        );
        ${baseOut}
      `;

    case "relax":
      return `
        (
          nwr["amenity"="spa"](around:R,LA,LO);
          nwr["leisure"="spa"](around:R,LA,LO);
          nwr["natural"="hot_spring"](around:R,LA,LO);
          nwr["amenity"="public_bath"](around:R,LA,LO);
          nwr["tourism"="spa"](around:R,LA,LO);
        );
        ${baseOut}
      `;

    case "storia":
      return `
        (
          nwr["tourism"="museum"](around:R,LA,LO);
          nwr["historic"](around:R,LA,LO);
          nwr["historic"="castle"](around:R,LA,LO);
          nwr["historic"="ruins"](around:R,LA,LO);
          nwr["historic"="archaeological_site"](around:R,LA,LO);
          nwr["historic"="monument"](around:R,LA,LO);
          nwr["tourism"="attraction"](around:R,LA,LO);
        );
        ${baseOut}
      `;

    case "natura":
      return `
        (
          nwr["boundary"="national_park"](around:R,LA,LO);
          nwr["leisure"="nature_reserve"](around:R,LA,LO);
          nwr["natural"="peak"](around:R,LA,LO);
          nwr["waterway"="waterfall"](around:R,LA,LO);
          nwr["natural"="waterfall"](around:R,LA,LO);
          nwr["tourism"="viewpoint"](around:R,LA,LO);
          nwr["tourism"="attraction"](around:R,LA,LO);
        );
        ${baseOut}
      `;

    case "mare":
      return `
        (
          nwr["natural"="beach"](around:R,LA,LO);
          nwr["tourism"="viewpoint"](around:R,LA,LO);
          nwr["tourism"="attraction"](around:R,LA,LO);
          nwr["leisure"="marina"](around:R,LA,LO);
        );
        ${baseOut}
      `;

    case "borghi":
      return `
        (
          nwr["place"="village"](around:R,LA,LO);
          nwr["place"="hamlet"](around:R,LA,LO);
          nwr["tourism"="attraction"](around:R,LA,LO);
          nwr["tourism"="viewpoint"](around:R,LA,LO);
          nwr["historic"](around:R,LA,LO);
        );
        ${baseOut}
      `;

    case "citta":
      return `
        (
          nwr["place"="city"](around:R,LA,LO);
          nwr["place"="town"](around:R,LA,LO);
          nwr["tourism"="attraction"](around:R,LA,LO);
          nwr["tourism"="museum"](around:R,LA,LO);
          nwr["historic"](around:R,LA,LO);
        );
        ${baseOut}
      `;

    case "ovunque":
    default:
      return `
        (
          nwr["tourism"="attraction"](around:R,LA,LO);
          nwr["tourism"="viewpoint"](around:R,LA,LO);
          nwr["tourism"="museum"](around:R,LA,LO);
          nwr["historic"](around:R,LA,LO);
          nwr["natural"="beach"](around:R,LA,LO);
          nwr["natural"="peak"](around:R,LA,LO);
          nwr["waterway"="waterfall"](around:R,LA,LO);
          nwr["leisure"="water_park"](around:R,LA,LO);
          nwr["tourism"="theme_park"](around:R,LA,LO);
          nwr["tourism"="zoo"](around:R,LA,LO);
          nwr["tourism"="aquarium"](around:R,LA,LO);
          nwr["amenity"="spa"](around:R,LA,LO);
          nwr["natural"="hot_spring"](around:R,LA,LO);
        );
        ${baseOut}
      `;
  }
}

function buildOverpassQL({ lat, lon, radiusM, cat, maxSize }) {
  // out:json + timeout + maxsize
  const body = pickQueryByCat(cat)
    .replaceAll("R", String(radiusM))
    .replaceAll("LA", String(lat))
    .replaceAll("LO", String(lon));

  const timeout = 22; // seconds (kept moderate; we also enforce fetch timeout)
  const ms = clamp(Number(maxSize) || 64_000_000, 16_000_000, 128_000_000);

  return `
    [out:json][timeout:${timeout}][maxsize:${ms}];
    ${body}
  `;
}

async function fetchWithTimeout(url, { method = "POST", body, timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Accept": "application/json",
        "User-Agent": "Jamo/3.0 (Overpass proxy; Vercel)"
      },
      body,
      signal: ctrl.signal,
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return { ok: false, status: r.status, error: `HTTP ${r.status}`, raw: txt.slice(0, 300) };
    }

    const j = await r.json().catch(() => null);
    if (!j || !Array.isArray(j.elements)) {
      return { ok: false, status: 200, error: "Invalid JSON from Overpass" };
    }
    return { ok: true, status: 200, json: j };

  } catch (e) {
    const isAbort = String(e?.name || "").includes("Abort");
    return { ok: false, status: 0, error: isAbort ? "timeout" : String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

function normalizeElements(j, limit = 900) {
  // Limit + ensure tags/name exist
  const out = [];
  for (const el of (j?.elements || [])) {
    if (!el) continue;
    const tags = el.tags || {};
    const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";
    if (!String(name || "").trim()) continue;

    // must have coordinates (node) OR center (way/relation)
    const lat = Number(el.lat ?? el.center?.lat);
    const lon = Number(el.lon ?? el.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    out.push(el);
    if (out.length >= limit) break;
  }
  return out;
}

export default async function handler(req, res) {
  const t0 = now();

  try {
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "Use GET" });
    }

    const lat = Number(req.query?.lat);
    const lon = Number(req.query?.lon);
    const radiusKm = clamp(Number(req.query?.radiusKm) || 60, 5, 300);
    const cat = String(req.query?.cat || "ovunque").toLowerCase();

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ ok: false, error: "Missing/invalid lat/lon" });
    }

    const radiusM = Math.round(radiusKm * 1000);
    const key = `${cat}:${lat.toFixed(4)}:${lon.toFixed(4)}:${radiusKm}`;

    // cache hit
    const hit = cache.get(key);
    if (hit && (now() - hit.ts) < TTL_MS) {
      return res.status(200).json({
        ok: true,
        data: hit.payload,
        meta: { cat, radiusKm, endpoint: hit.endpoint, cached: true, ms: now() - t0 }
      });
    }

    const ql = buildOverpassQL({ lat, lon, radiusM, cat, maxSize: 64_000_000 });
    const body = `data=${encodeURIComponent(ql)}`;

    // Try endpoints in order with a tight timeout each
    let lastErr = null;
    for (const endpoint of OVERPASS_ENDPOINTS) {
      const r = await fetchWithTimeout(endpoint, { method: "POST", body, timeoutMs: 12000 });
      if (!r.ok) {
        lastErr = { endpoint, ...r };
        continue;
      }

      const elements = normalizeElements(r.json, 900);
      const payload = { ...r.json, elements };

      cache.set(key, { ts: now(), payload, endpoint });

      return res.status(200).json({
        ok: true,
        data: payload,
        meta: { cat, radiusKm, endpoint, cached: false, ms: now() - t0 }
      });
    }

    // all failed
    return res.status(200).json({
      ok: false,
      error: `Overpass error (${lastErr?.error || "unknown"})`,
      meta: {
        cat,
        radiusKm,
        cached: false,
        endpoint: lastErr?.endpoint || "",
        detail: lastErr?.raw || "",
        ms: now() - t0
      }
    });

  } catch (e) {
    return res.status(200).json({
      ok: false,
      error: String(e?.message || e),
      meta: { ms: now() - t0 }
    });
  }
}
