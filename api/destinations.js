// /api/destinations.js — Jamo LIVE destinations (Overpass) — v3.1.2 FINAL
// LIVE → schema Jamo (compatibile con macro offline)

const TTL_MS = 1000 * 60 * 15;
const cache = new Map();

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

function now() { return Date.now(); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
const asNum = (x) => Number.isFinite(Number(x)) ? Number(x) : null;

function normCat(c) {
  const s = String(c || "ovunque").toLowerCase().trim();
  return [
    "ovunque","family","relax","natura","storia",
    "mare","borghi","citta","montagna"
  ].includes(s) ? s : "ovunque";
}

// ---------------- OSM → JAMO MAPPING ----------------
function mapToJamoPlace(el, cat) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"];
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (!name || !lat || !lon) return null;

  const outTags = new Set();
  let type = cat;

  // family
  if (tags.tourism === "zoo" || tags.tourism === "aquarium") outTags.add("family");
  if (tags.leisure === "water_park") outTags.add("water_park");
  if (tags.leisure === "playground") outTags.add("kids");

  // natura
  if (tags.natural) outTags.add("natura");
  if (tags.natural === "beach") type = "mare";

  // storia
  if (tags.historic || tags.tourism === "museum") {
    outTags.add("storia");
    if (cat === "ovunque") type = "storia";
  }

  // borghi / città
  if (tags.place === "village" || tags.place === "hamlet") type = "borghi";
  if (tags.place === "town" || tags.place === "city") type = "citta";

  return {
    id: `live_${el.type}_${el.id}`,
    name: String(name).trim(),
    lat: Number(lat),
    lon: Number(lon),
    type,
    visibility: "conosciuta",
    tags: Array.from(outTags),
    beauty_score: 0.72,
    country: tags["addr:country"] || "",
    area: ""
  };
}

// ---------------- OVERPASS UTILS ----------------
function overpassBody(q) {
  return `data=${encodeURIComponent(q)}`;
}

async function fetchWithTimeout(url, body, timeout = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// ---------------- MAIN HANDLER ----------------
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  try {
    const lat = asNum(req.query.lat);
    const lon = asNum(req.query.lon);
    const radiusKm = clamp(asNum(req.query.radiusKm) ?? 60, 5, 300);
    const cat = normCat(req.query.cat);

    if (!lat || !lon) {
      return res.status(400).json({ ok: false, error: "Missing lat/lon" });
    }

    const key = `${cat}:${radiusKm}:${lat.toFixed(2)}:${lon.toFixed(2)}`;
    const hit = cache.get(key);
    if (hit && now() - hit.ts < TTL_MS) {
      return res.status(200).json(hit.data);
    }

    const radiusM = radiusKm * 1000;
    const query = `
[out:json][timeout:12];
(
  node(${radiusM},${lat},${lon});
);
out tags center 800;
    `.trim();

    let raw = null;
    for (const ep of OVERPASS_ENDPOINTS) {
      try {
        raw = await fetchWithTimeout(ep, overpassBody(query));
        if (raw?.elements?.length) break;
      } catch {}
    }

    const places = (raw?.elements || [])
      .map(el => mapToJamoPlace(el, cat))
      .filter(Boolean);

    const data = {
      ok: true,
      data: { elements: places },
      meta: {
        requestedCat: cat,
        usedCat: cat,
        radiusKm,
        count: places.length,
        source: "live"
      }
    };

    cache.set(key, { ts: now(), data });
    return res.status(200).json(data);

  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e.message || e) });
  }
}
