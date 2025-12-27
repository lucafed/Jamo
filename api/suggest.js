// /api/suggest.js  (Node / Vercel)
// NOTE: richiede env ORS_API_KEY

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
  return `https://www.google.com/maps/search/?api=1&query=${q}&query_place_id=`;
}

function makeId(name, lat, lng) {
  return `${(name||"place").toLowerCase().replace(/\s+/g,"_")}@${lat.toFixed(5)},${lng.toFixed(5)}`;
}

function modeProfile(mode) {
  // ORS profiles
  if (mode === "walk") return "foot-walking";
  if (mode === "bike") return "cycling-regular";
  return "driving-car";
}

function avgSpeedKmh(mode) {
  if (mode === "walk") return 4.5;
  if (mode === "bike") return 15;
  return 70; // auto media (stima)
}

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: r.ok, status: r.status, data };
}

async function orsIsochronePolygon(lat, lng, seconds, profile, apiKey) {
  // ORS isochrones range max (nel tuo screenshot): 3600 sec
  const range = clamp(seconds, 60, 3600);

  const url = `${ORS_BASE}/v2/isochrones/${profile}`;
  const body = {
    locations: [[lng, lat]],
    range: [range],
  };

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
  // ritorna geojson con polygon
  return data;
}

async function overpassPlacesAround(lat, lng, radiusMeters) {
  // cerchiamo LUOGHI (non attrazioni)
  // place=city|town|village|hamlet|suburb|neighbourhood
  const r = Math.round(radiusMeters);

  const query = `
    [out:json][timeout:25];
    (
      node["place"~"^(city|town|village|hamlet|suburb|neighbourhood)$"](around:${r},${lat},${lng});
      way["place"~"^(city|town|village|hamlet|suburb|neighbourhood)$"](around:${r},${lat},${lng});
      relation["place"~"^(city|town|village|hamlet|suburb|neighbourhood)$"](around:${r},${lat},${lng});
    );
    out center 120;
  `.trim();

  const { ok, status, data } = await fetchJson(OVERPASS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: "data=" + encodeURIComponent(query)
  });

  if (!ok) {
    throw new Error(`Overpass error (status ${status})`);
  }

  const elements = data?.elements || [];
  const places = [];

  for (const el of elements) {
    const name = el.tags?.name;
    if (!name) continue;

    const c = el.type === "node"
      ? { lat: el.lat, lon: el.lon }
      : el.center ? { lat: el.center.lat, lon: el.center.lon } : null;

    if (!c) continue;

    places.push({
      name,
      lat: c.lat,
      lng: c.lon,
      place: el.tags?.place || "place"
    });
  }

  // pulizia / unici
  return uniqBy(places, p => `${p.name.toLowerCase()}_${p.lat.toFixed(3)}_${p.lng.toFixed(3)}`);
}

function chooseTopAndAlternatives(candidates, targetMinutes) {
  // punteggio: preferisco vicino al tempo target (né troppo vicino né troppo lontano)
  const scored = candidates.map(c => {
    const diff = Math.abs(c.eta_min - targetMinutes);
    const penaltyTooClose = c.eta_min < Math.max(10, targetMinutes*0.35) ? 18 : 0;
    const score = diff + penaltyTooClose;
    return { ...c, score };
  }).sort((a,b)=>a.score-b.score);

  const top = scored[0] || null;

  // alternative: prendo le successive ma non troppo simili
  const alternatives = [];
  for (let i=1; i<scored.length && alternatives.length<3; i++){
    const a = scored[i];
    if (!top) break;
    if (Math.abs(a.eta_min - top.eta_min) < 8) continue;
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
    const visitedRaw = (req.query.visited || "").trim();
    const visited = visitedRaw ? visitedRaw.split(",").map(s=>s.trim()).filter(Boolean) : [];

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return json(res, 400, { error: "Parametri mancanti: lat,lng" });
    }

    const mins = clamp(minutes, 15, 360);
    const targetSeconds = mins * 60;

    const speed = avgSpeedKmh(mode);
    const profile = modeProfile(mode);

    let engine = "ESTIMATE";
    let radiusKm = (mins * speed) / 60; // stima raggio

    // ORS solo fino a 60 minuti (limite range 3600)
    const apiKey = process.env.ORS_API_KEY;
    if (apiKey && targetSeconds <= 3600) {
      try {
        await orsIsochronePolygon(lat, lng, targetSeconds, profile, apiKey);
        // (per ora usiamo ORS per validare che la key funzioni e che il profilo sia ok)
        engine = "ORS_OK";
      } catch (e) {
        // se ORS fallisce, continuiamo con estimate
        engine = "ESTIMATE_FALLBACK";
      }
    } else {
      engine = apiKey ? "ORS_LIMIT_FALLBACK" : "NO_ORS_KEY";
    }

    // raggio metri: metto un minimo e un max ragionevole
    const radiusMeters = clamp(radiusKm * 1000, 5000, 250000); // 5 km - 250 km

    // prendo luoghi da Overpass
    const places = await overpassPlacesAround(lat, lng, radiusMeters);

    // trasformo in candidates con distanza + eta (stima)
    let candidates = places.map(p => {
      const d = haversineKm(lat, lng, p.lat, p.lng);
      const eta = (d / speed) * 60;
      return {
        id: makeId(p.name, p.lat, p.lng),
        name: p.name,
        lat: p.lat,
        lng: p.lng,
        distance_km: d,
        eta_min: eta,
        maps_url: mapsUrl(p.lat, p.lng, p.name),
      };
    });

    // filtro: coerenti col tempo (con tolleranza)
    const maxMin = mins * 1.15;
    const minMin = Math.max(8, mins * 0.35);

    candidates = candidates
      .filter(c => c.eta_min <= maxMin && c.eta_min >= minMin)
      .filter(c => !visited.includes(c.id))
      .sort((a,b)=>a.eta_min-b.eta_min);

    // se troppo pochi, allargo tolleranza (senza impazzire)
    if (candidates.length < 4) {
      const relaxedMax = mins * 1.35;
      candidates = places.map(p => {
        const d = haversineKm(lat, lng, p.lat, p.lng);
        const eta = (d / speed) * 60;
        return {
          id: makeId(p.name, p.lat, p.lng),
          name: p.name,
          lat: p.lat,
          lng: p.lng,
          distance_km: d,
          eta_min: eta,
          maps_url: mapsUrl(p.lat, p.lng, p.name),
        };
      })
      .filter(c => c.eta_min <= relaxedMax && c.eta_min >= 8)
      .filter(c => !visited.includes(c.id));
    }

    // niente candidati -> risposta pulita (no crash in UI)
    if (!candidates.length) {
      return json(res, 200, {
        top: null,
        alternatives: [],
        mode,
        engine,
        source: "Overpass(place=*)",
        message: "Nessun luogo raggiungibile col tempo selezionato."
      });
    }

    // scelgo top + alternative
    const { top, alternatives } = chooseTopAndAlternatives(candidates, mins);

    return json(res, 200, {
      top,
      alternatives,
      mode,
      engine,
      source: "Overpass(place=city|town|village|hamlet|suburb|neighbourhood)"
    });

  } catch (e) {
    return json(res, 500, { error: "Server error", details: { error: e.message } });
  }
};
