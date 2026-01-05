// /api/destinations.js — Jamo LIVE destinations (Overpass) — v4.0 (ONLINE-FIRST FAMILY)
// Obiettivo: trovare cose "family" vicine (anche non famose), turistiche/visitabili, senza terme/spa.
// Risponde in formato "places" compatibile con app.js normalizePlace (lat/lon/name/type/tags/visibility).

const TTL_MS = 1000 * 60 * 12; // 12 min cache
const cache = new Map(); // key -> { ts, data, meta }

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

function now() { return Date.now(); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function asNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function normCat(c) {
  const s = String(c || "ovunque").toLowerCase().trim();
  // per ora gestiamo bene family + fallback ovunque (ma senza spam)
  const allowed = new Set(["ovunque", "family"]);
  return allowed.has(s) ? s : "ovunque";
}

function cacheKey({ lat, lon, radiusKm, cat }) {
  // arrotondo per migliorare cache (circa ~1km)
  const la = Math.round(lat * 100) / 100;
  const lo = Math.round(lon * 100) / 100;
  const rk = Math.round(radiusKm);
  return `${cat}:${rk}:${la}:${lo}`;
}

function opBody(q) {
  return `data=${encodeURIComponent(q)}`;
}

async function fetchWithTimeout(url, { body, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body,
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json().catch(() => null);
    if (!j) throw new Error("Bad JSON");
    return j;
  } finally {
    clearTimeout(t);
  }
}

function toRad(x) { return (x * Math.PI) / 180; }
function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function around(radiusM, lat, lon) {
  return `around:${radiusM},${lat},${lon}`;
}

// ------------------------------------------------------------
// FAMILY QUERY (mirata + "local friendly")
// ------------------------------------------------------------
// Note:
// - includo POI piccoli: playground (anche piccoli) ma preferisco con name
// - includo avventura/zipline via name regex
// - includo ice_rink, baby park neve, ski-school (best effort)
// - NO spa/terme/hot_spring (li trattiamo come RELAX, non family)
// - uso nwr + out center per way/relation
function buildFamilyQuery(radiusM, lat, lon) {
  const A = around(radiusM, lat, lon);

  return `
[out:json][timeout:20];
(
  // 🎢 Theme parks / amusement
  nwr[tourism=theme_park](${A});

  // 💦 Water parks
  nwr[leisure=water_park](${A});

  // 🦁 Zoo / aquarium
  nwr[tourism=zoo](${A});
  nwr[tourism=aquarium](${A});

  // 🧒 Kids museums / science centers (nome)
  nwr[tourism=museum]["name"~"bambin|kids|children|museo\\s?dei\\s?bambini|children\\s?museum|science\\s?center|planetar",i](${A});
  nwr[tourism=attraction]["name"~"bambin|kids|children|science\\s?center|planetar",i](${A});

  // 🛝 Playgrounds (con nome = priorità alta)
  nwr[leisure=playground]["name"](${A});

  // 🛝 Playgrounds senza nome (bassa priorità, ma utili se sei in zone con pochi POI)
  nwr[leisure=playground](${A});

  // 🌲 Adventure parks / zipline (best effort)
  nwr["name"~"parco\\s?avventura|adventure\\s?park|zip\\s?line|acrobatic|tree\\s?top|parco\\s?acrobatico",i](${A});

  // ⛸️ Ice rink
  nwr[leisure=ice_rink](${A});

  // ❄️ Snow baby parks / sledding / ski school (nome)
  nwr["name"~"baby\\s?park|snow\\s?park|parco\\s?neve|slitt|bob\\s?track|pista\\s?slitt|scuola\\s?sci|ski\\s?school",i](${A});

  // 🎳 Indoor family (solo un po')
  nwr[amenity=cinema](${A});
  nwr[leisure=bowling_alley](${A});
);
out tags center 600;
`.trim();
}

// OVUNQUE (solo POI sensati, non spam)
function buildAnywhereQuery(radiusM, lat, lon) {
  const A = around(radiusM, lat, lon);
  return `
[out:json][timeout:20];
(
  nwr[tourism=attraction](${A});
  nwr[tourism=viewpoint](${A});
  nwr[tourism=museum](${A});
  nwr[historic=castle](${A});
  nwr[natural=waterfall](${A});
  nwr[natural=beach](${A});
  nwr["name"~"castello|rocca|museo|cascata|lago|belvedere|panoram|spiaggia|zoo|acquario|parco\\s?divertimenti|acquapark",i](${A});
);
out tags center 700;
`.trim();
}

// ------------------------------------------------------------
// Map OSM element -> Jamo place
// ------------------------------------------------------------
function normStr(s) {
  return String(s || "").toLowerCase().trim();
}

function isSpaLike(tags, name) {
  const n = normStr(name);
  const t = tags || {};
  return (
    t.amenity === "spa" ||
    t.leisure === "spa" ||
    t.natural === "hot_spring" ||
    t.amenity === "public_bath" ||
    t.thermal === "yes" ||
    n.includes("terme") || n.includes("spa") || n.includes("thermal") || n.includes("benessere")
  );
}

function elementLatLon(el) {
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function tagListCompact(tags) {
  const out = [];
  const pushKV = (k) => { if (tags?.[k] != null) out.push(`${k}=${tags[k]}`); };
  ["tourism","leisure","amenity","sport","natural","historic","information","aerialway","place"].forEach(pushKV);
  return Array.from(new Set(out)).slice(0, 18);
}

function familySubtype(tags, name) {
  const t = tags || {};
  const n = normStr(name);

  if (t.tourism === "theme_park") return "theme_park";
  if (t.leisure === "water_park") return "water_park";
  if (t.tourism === "zoo") return "zoo";
  if (t.tourism === "aquarium") return "aquarium";
  if (t.leisure === "playground") return "playground";
  if (t.leisure === "ice_rink") return "ice_rink";

  if (n.includes("parco avventura") || n.includes("adventure") || n.includes("zip line") || n.includes("zipline") || n.includes("acrobatic"))
    return "adventure_park";

  if (n.includes("baby park") || n.includes("snow park") || n.includes("parco neve") || n.includes("slitt") || n.includes("bob") || n.includes("scuola sci") || n.includes("ski school"))
    return "snow_family";

  if (t.amenity === "cinema") return "cinema";
  if (t.leisure === "bowling_alley") return "bowling";

  return "family";
}

function scoreFamilyPlace(tags, name, km) {
  const t = tags || {};
  const n = normStr(name);

  let s = 0;

  // core family
  if (t.tourism === "theme_park") s += 5.2;
  if (t.leisure === "water_park") s += 5.0;
  if (t.tourism === "zoo") s += 4.6;
  if (t.tourism === "aquarium") s += 4.4;

  // very good local family
  if (t.leisure === "ice_rink") s += 3.6;
  if (t.leisure === "playground") s += 2.6;

  // name-based boosts
  if (/parco\s?avventura|adventure\s?park|zip\s?line|parco\s?acrobatico/i.test(name)) s += 3.8;
  if (/baby\s?park|snow\s?park|parco\s?neve|slitt|bob|scuola\s?sci|ski\s?school/i.test(name)) s += 3.9;
  if (/museo\s?dei\s?bambini|children\s?museum|science\s?center|planetar/i.test(name)) s += 3.7;

  // indoor family (lower)
  if (t.amenity === "cinema") s += 1.2;
  if (t.leisure === "bowling_alley") s += 1.4;

  // prefer named playgrounds
  if (t.leisure === "playground" && String(name || "").trim().length >= 3) s += 0.8;

  // distance penalty (più vicino = meglio)
  // 0km -> 0, 10km -> -0.5, 40km -> -2, 80km -> -4
  s -= clamp(km / 20, 0, 5);

  // anti-noise: nomi troppo generici
  if (n === "playground" || n === "parco giochi") s -= 0.7;

  return Number(s.toFixed(4));
}

function mapElementToJamoPlace(el, cat, originLat, originLon) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";
  if (!name || String(name).trim().length < 2) return null;

  const ll = elementLatLon(el);
  if (!ll) return null;

  // escludi city/town/village/hamlet (non sono "attività family")
  if (tags.place) return null;

  // escludi spa/terme sempre in family
  if (cat === "family" && isSpaLike(tags, name)) return null;

  const km = haversineKm(originLat, originLon, ll.lat, ll.lon);

  const subtype = cat === "family" ? familySubtype(tags, name) : cat;
  const score = cat === "family" ? scoreFamilyPlace(tags, name, km) : Number((1 - Math.min(1, km / 120)).toFixed(4));

  return {
    id: `live_${cat}_${el.type}_${el.id}`,
    name: String(name).trim(),
    lat: ll.lat,
    lon: ll.lon,
    type: cat,                 // IMPORTANT: per il filtro in app.js
    subtype,
    visibility: score >= 4.6 ? "conosciuta" : score >= 3.3 ? "classica" : "chicca",
    beauty_score: clamp(0.65 + (score / 10), 0.55, 0.95),
    tags: tagListCompact(tags),
    live: true,
    source: "overpass_live",
    _km: Number(km.toFixed(3)),
    _score: score,
  };
}

function dedupPlaces(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const k = `${p.name.toLowerCase()}_${p.lat.toFixed(4)}_${p.lon.toFixed(4)}_${p.type}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

// ------------------------------------------------------------
// Overpass runner with retries + multiple endpoints
// ------------------------------------------------------------
async function runOverpassQuery(query, { timeoutMs = 18000 } = {}) {
  const body = opBody(query);
  const notes = [];

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const j = await fetchWithTimeout(endpoint, { body, timeoutMs });
        return { ok: true, endpoint, json: j, notes };
      } catch (e) {
        notes.push(`fail_${endpoint}_a${attempt}:${String(e?.message || e)}`);
        // backoff
        await new Promise(r => setTimeout(r, 600 * attempt));
      }
    }
  }

  return { ok: false, endpoint: "", json: null, notes };
}

// ------------------------------------------------------------
// MAIN HANDLER
// ------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  try {
    const lat = asNum(req.query?.lat);
    const lon = asNum(req.query?.lon);
    const radiusKmReq = clamp(asNum(req.query?.radiusKm) ?? 60, 5, 140);
    const cat = normCat(req.query?.cat);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ ok: false, error: "Missing lat/lon" });
    }

    const key = cacheKey({ lat, lon, radiusKm: radiusKmReq, cat });
    const hit = cache.get(key);
    if (hit && now() - hit.ts < TTL_MS) {
      return res.status(200).json({
        ok: true,
        data: hit.data,
        meta: { ...hit.meta, fromCache: true }
      });
    }

    const started = now();

    // raggio progressivo automatico (se trova poco)
    const stepsKm = [
      radiusKmReq,
      clamp(Math.round(radiusKmReq * 1.35), radiusKmReq, 160),
      clamp(Math.round(radiusKmReq * 1.85), radiusKmReq, 200),
    ];
    const uniqSteps = Array.from(new Set(stepsKm));

    let best = [];
    let usedRadiusKm = radiusKmReq;
    let usedEndpoint = "";
    let notes = [];

    for (const rk of uniqSteps) {
      const radiusM = Math.round(rk * 1000);
      const q = (cat === "family") ? buildFamilyQuery(radiusM, lat, lon) : buildAnywhereQuery(radiusM, lat, lon);

      const r = await runOverpassQuery(q, { timeoutMs: 20000 });
      notes = notes.concat(r.notes || []);

      if (!r.ok || !r.json) continue;

      usedEndpoint = r.endpoint || "";
      usedRadiusKm = rk;

      const els = Array.isArray(r.json.elements) ? r.json.elements : [];
      const mapped = els.map(el => mapElementToJamoPlace(el, cat, lat, lon)).filter(Boolean);
      const dedup = dedupPlaces(mapped);

      // ordina: score desc, poi km asc
      dedup.sort((a, b) => (b._score - a._score) || (a._km - b._km));

      // tieni un massimo per payload
      best = dedup.slice(0, 260);

      // criterio "abbastanza": in family basta già 40 buoni risultati
      const softEnough = (cat === "family") ? 40 : 60;
      if (best.length >= softEnough) break;
    }

    const data = { elements: best };

    const meta = {
      requestedCat: cat,
      usedCat: cat,
      radiusKmRequested: radiusKmReq,
      radiusKmUsed: usedRadiusKm,
      count: best.length,
      endpoint: usedEndpoint,
      elapsedMs: now() - started,
      notes,
      fromCache: false,
    };

    cache.set(key, { ts: now(), data, meta });

    return res.status(200).json({ ok: true, data, meta });

  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
