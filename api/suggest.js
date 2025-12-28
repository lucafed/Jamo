// /api/suggest.js  (Node / Vercel)
// Richiede env ORS_API_KEY (opzionale: se manca, usa solo stime)
// Supporta: car, walk, bike, train, bus, plane
// Supporta type: mix | places | nature

const ORS_BASE = "https://api.openrouteservice.org";
const OVERPASS = "https://overpass-api.de/api/interpreter";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function mapsUrl(lat, lng, name) {
  const q = encodeURIComponent(name || `${lat},${lng}`);
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function makeId(name, lat, lng) {
  return `${(name||"place").toLowerCase().replace(/\s+/g,"_")}@${lat.toFixed(5)},${lng.toFixed(5)}`;
}

/* -----------------------
   MODE: profiles + speed
   ----------------------- */

function modeProfile(mode) {
  if (mode === "walk") return "foot-walking";
  if (mode === "bike") return "cycling-regular";
  // per train/bus/plane usiamo comunque driving-car per eventuale ORS check
  return "driving-car";
}

function avgSpeedKmh(mode) {
  if (mode === "walk") return 4.5;
  if (mode === "bike") return 15;
  if (mode === "car") return 70;

  // PLAUSIBILE (non orari reali):
  if (mode === "train") return 95;
  if (mode === "bus") return 65;
  if (mode === "plane") return 650;

  return 70;
}

// Buffer porta-a-porta (minuti): accesso + attese
function modeBufferMin(mode) {
  if (mode === "train") return 18;
  if (mode === "bus") return 12;
  if (mode === "plane") return 90;
  return 0;
}

/* -----------------------
   fetch helper
   ----------------------- */
async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: r.ok, status: r.status, data };
}

/* -----------------------
   ORS isochrone (optional)
   ----------------------- */
async function orsIsochronePolygon(lat, lng, seconds, profile, apiKey) {
  const range = clamp(seconds, 60, 3600);
  const url = `${ORS_BASE}/v2/isochrones/${profile}`;
  const body = { locations: [[lng, lat]], range: [range] };

  const { ok, status, data } = await fetchJson(url, {
    method: "POST",
    headers: {
      "Authorization": apiKey,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(body),
  });

  if (!ok) {
    const err = data?.error || data?.message || data?.details || "ORS error";
    throw new Error(`${err} (status ${status})`);
  }
  return data;
}

/* -----------------------
   Overpass query by type
   ----------------------- */
function buildOverpassQuery(type, lat, lng, radiusMeters) {
  const r = Math.round(radiusMeters);

  const qPlaces = `
    (
      node["place"~"^(city|town|village|hamlet)$"](around:${r},${lat},${lng});
      way["place"~"^(city|town|village|hamlet)$"](around:${r},${lat},${lng});
      relation["place"~"^(city|town|village|hamlet)$"](around:${r},${lat},${lng});
    );
  `;

  const qNature = `
    (
      node["waterway"="waterfall"](around:${r},${lat},${lng});
      node["natural"="peak"](around:${r},${lat},${lng});
      way["boundary"="national_park"](around:${r},${lat},${lng});
      relation["boundary"="national_park"](around:${r},${lat},${lng});
      node["leisure"="nature_reserve"](around:${r},${lat},${lng});
      way["leisure"="nature_reserve"](around:${r},${lat},${lng});
      relation["leisure"="nature_reserve"](around:${r},${lat},${lng});
    );
  `;

  const qMix = `(${qPlaces} ${qNature});`;

  const pick = (type === "places") ? qPlaces : (type === "nature") ? qNature : qMix;

  return `
    [out:json][timeout:25];
    ${pick}
    out center 220;
  `.trim();
}

async function overpassFetch(type, lat, lng, radiusMeters) {
  const query = buildOverpassQuery(type, lat, lng, radiusMeters);
  const { ok, status, data } = await fetchJson(OVERPASS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: "data=" + encodeURIComponent(query)
  });
  if (!ok) throw new Error(`Overpass error (status ${status})`);

  const elements = data?.elements || [];
  const out = [];

  for (const el of elements) {
    const name = el.tags?.name;
    if (!name) continue;

    const c = el.type === "node"
      ? { lat: el.lat, lon: el.lon }
      : el.center ? { lat: el.center.lat, lon: el.center.lon } : null;

    if (!c) continue;

    out.push({
      name,
      lat: c.lat,
      lng: c.lon,
      tags: el.tags || {}
    });
  }

  return uniqBy(out, p => `${p.name.toLowerCase()}_${p.lat.toFixed(3)}_${p.lng.toFixed(3)}`);
}

/* -----------------------
   pick best + alts
   ----------------------- */
function chooseTopAndAlternatives(candidates, targetMinutes) {
  const scored = candidates.map(c => {
    const diff = Math.abs(c.eta_min - targetMinutes);

    // NON buttiamo via troppo vicino: solo una lieve penalità
    const tooClose = c.eta_min < Math.max(10, targetMinutes * 0.25) ? 6 : 0;

    return { ...c, score: diff + tooClose };
  }).sort((a,b)=>a.score-b.score);

  const top = scored[0] || null;
  const alternatives = [];
  for (let i=1; i<scored.length && alternatives.length<3; i++){
    const a = scored[i];
    if (!top) break;
    if (Math.abs(a.eta_min - top.eta_min) < 6) continue;
    alternatives.push(a);
  }
  return { top, alternatives };
}

module.exports = async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const minutes = parseInt(req.query.minutes || "60", 10);
    const mode = (req.query.mode || "car").toLowerCase();
    const type = (req.query.type || "mix").toLowerCase(); // <-- supporto tipo meta
    const visitedRaw = (req.query.visited || "").trim();
    const visited = visitedRaw ? visitedRaw.split(",").map(s=>s.trim()).filter(Boolean) : [];

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return json(res, 400, { error: "Parametri mancanti: lat,lng" });
    }

    const mins = clamp(minutes, 15, 360);
    const targetSeconds = mins * 60;

    const speed = avgSpeedKmh(mode);
    const buffer = modeBufferMin(mode);
    const profile = modeProfile(mode);

    let engine = "ESTIMATE";
    let radiusKm = (mins * speed) / 60; // stima raggio “grezzo”

    // se ho buffer, riduco raggio utile (tempo disponibile per il viaggio vero)
    const usable = Math.max(10, mins - buffer);
    radiusKm = (usable * speed) / 60;

    // ORS solo fino a 60 minuti (range 3600), opzionale
    const apiKey = process.env.ORS_API_KEY;
    if (apiKey && targetSeconds <= 3600 && (mode === "car" || mode === "walk" || mode === "bike")) {
      try {
        await orsIsochronePolygon(lat, lng, targetSeconds, profile, apiKey);
        engine = "ORS_OK";
      } catch {
        engine = "ESTIMATE_FALLBACK";
      }
    } else {
      engine = apiKey ? "ORS_LIMIT_OR_MODE" : "NO_ORS_KEY";
    }

    // radius: min/max
    let radiusMeters = clamp(radiusKm * 1000, 7000, 300000);

    // 1) prima query
    let places = await overpassFetch(type, lat, lng, radiusMeters);

    // 2) fallback se pochi
    if (places.length < 25) {
      radiusMeters = clamp(radiusMeters * 1.4, 7000, 300000);
      const more = await overpassFetch(type, lat, lng, radiusMeters);
      places = uniqBy([...places, ...more], p => `${p.name.toLowerCase()}_${p.lat.toFixed(3)}_${p.lng.toFixed(3)}`);
    }

    // 3) se ancora pochi, forzo MIX (così non è mai vuoto)
    if (places.length < 10 && type !== "mix") {
      const mix = await overpassFetch("mix", lat, lng, radiusMeters);
      places = uniqBy([...places, ...mix], p => `${p.name.toLowerCase()}_${p.lat.toFixed(3)}_${p.lng.toFixed(3)}`);
    }

    // candidates con eta plausibile
    let candidates = places.map(p => {
      const d = haversineKm(lat, lng, p.lat, p.lng);
      const etaTravel = (d / speed) * 60;
      const etaTotal = etaTravel + buffer;

      return {
        id: makeId(p.name, p.lat, p.lng),
        name: p.name,
        lat: p.lat,
        lng: p.lng,
        distance_km: d,
        eta_min: etaTotal,
        maps_url: mapsUrl(p.lat, p.lng, p.name),
        tags: p.tags
      };
    });

    // filtro “morbido”
    const maxMin = mins * 1.35;
    const minMin = 8;

    candidates = candidates
      .filter(c => c.eta_min <= maxMin && c.eta_min >= minMin)
      .filter(c => !visited.includes(c.id));

    // se zero candidati, allargo ancora (ultima chance)
    if (!candidates.length) {
      candidates = places.map(p => {
        const d = haversineKm(lat, lng, p.lat, p.lng);
        const etaTravel = (d / speed) * 60;
        const etaTotal = etaTravel + buffer;
        return {
          id: makeId(p.name, p.lat, p.lng),
          name: p.name,
          lat: p.lat,
          lng: p.lng,
          distance_km: d,
          eta_min: etaTotal,
          maps_url: mapsUrl(p.lat, p.lng, p.name),
          tags: p.tags
        };
      }).filter(c => c.eta_min >= 6).filter(c => !visited.includes(c.id));
    }

    if (!candidates.length) {
      return json(res, 200, {
        top: null,
        alternatives: [],
        mode,
        type,
        engine,
        source: "Overpass",
        message: "Nessun luogo trovato. Prova ad aumentare il tempo."
      });
    }

    // scelgo top + alternative
    const { top, alternatives } = chooseTopAndAlternatives(candidates, mins);

    return json(res, 200, {
      top,
      alternatives,
      mode,
      type,
      engine,
      source: "Overpass (places+nature, fallback attivo)"
    });

  } catch (e) {
    return json(res, 500, { error: "Server error", details: { error: e.message } });
  }
};
