// /api/suggest.js (Vercel Node) — SEA SMART
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

function modeProfile(mode) {
  if (mode === "walk") return "foot-walking";
  if (mode === "bike") return "cycling-regular";
  return "driving-car";
}

function avgSpeedKmh(mode) {
  if (mode === "walk") return 4.5;
  if (mode === "bike") return 15;
  if (mode === "car") return 70;
  if (mode === "train") return 95;
  if (mode === "bus") return 65;
  if (mode === "plane") return 650;
  return 70;
}

function modeBufferMin(mode) {
  if (mode === "train") return 18;
  if (mode === "bus") return 12;
  if (mode === "plane") return 90;
  return 0;
}

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: r.ok, status: r.status, data };
}

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
   Overpass query blocks
   ----------------------- */

function qPlaces(r, lat, lng) {
  return `
  (
    node["place"~"^(city|town|village|hamlet)$"](around:${r},${lat},${lng});
    way["place"~"^(city|town|village|hamlet)$"](around:${r},${lat},${lng});
    relation["place"~"^(city|town|village|hamlet)$"](around:${r},${lat},${lng});
  );`;
}

function qNature(r, lat, lng) {
  return `
  (
    node["waterway"="waterfall"](around:${r},${lat},${lng});
    node["natural"~"^(peak|wood|heath|scrub)$"](around:${r},${lat},${lng});
    way["boundary"="national_park"](around:${r},${lat},${lng});
    relation["boundary"="national_park"](around:${r},${lat},${lng});
    node["leisure"="nature_reserve"](around:${r},${lat},${lng});
    way["leisure"="nature_reserve"](around:${r},${lat},${lng});
    relation["leisure"="nature_reserve"](around:${r},${lat},${lng});
  );`;
}

// extra category (opzionale)
function qCategoryExtra(category, r, lat, lng) {
  const c = String(category || "").toLowerCase().trim();
  if (!c) return "";

  if (c === "sea") {
    // primo livello: cose marittime dirette
    return `
    (
      node["natural"="beach"](around:${r},${lat},${lng});
      way["natural"="beach"](around:${r},${lat},${lng});
      way["natural"="coastline"](around:${r},${lat},${lng});
      node["place"~"^(town|village|city)$"]["seaside"="yes"](around:${r},${lat},${lng});
    );`;
  }

  if (c === "mountain") {
    return `
    (
      node["natural"="peak"](around:${r},${lat},${lng});
      node["place"~"^(town|village|city)$"]["ele"~"^[0-9]{3,}$"](around:${r},${lat},${lng});
    );`;
  }

  if (c === "city") {
    return `
    (
      node["place"~"^(city|town)$"](around:${r},${lat},${lng});
      way["place"~"^(city|town)$"](around:${r},${lat},${lng});
      relation["place"~"^(city|town)$"](around:${r},${lat},${lng});
    );`;
  }

  if (c === "villages") {
    return `
    (
      node["place"~"^(village|hamlet)$"](around:${r},${lat},${lng});
      way["place"~"^(village|hamlet)$"](around:${r},${lat},${lng});
      relation["place"~"^(village|hamlet)$"](around:${r},${lat},${lng});
    );`;
  }

  if (c === "kids") {
    return `
    (
      node["tourism"~"^(zoo|theme_park)$"](around:${r},${lat},${lng});
      way["tourism"~"^(zoo|theme_park)$"](around:${r},${lat},${lng});
      node["leisure"~"^(park|playground|water_park)$"](around:${r},${lat},${lng});
      way["leisure"~"^(park|playground|water_park)$"](around:${r},${lat},${lng});
    );`;
  }

  if (c === "relax") {
    return `
    (
      node["leisure"="park"](around:${r},${lat},${lng});
      way["leisure"="park"](around:${r},${lat},${lng});
      node["tourism"="spa"](around:${r},${lat},${lng});
      way["tourism"="spa"](around:${r},${lat},${lng});
    );`;
  }

  if (c === "food") {
    return `
    (
      node["tourism"="winery"](around:${r},${lat},${lng});
      way["tourism"="winery"](around:${r},${lat},${lng});
      node["amenity"~"^(restaurant|cafe)$"](around:${r},${lat},${lng});
      way["amenity"~"^(restaurant|cafe)$"](around:${r},${lat},${lng});
    );`;
  }

  if (c === "culture") {
    return `
    (
      node["tourism"~"^(museum|gallery|attraction)$"](around:${r},${lat},${lng});
      way["tourism"~"^(museum|gallery|attraction)$"](around:${r},${lat},${lng});
      node["historic"](around:${r},${lat},${lng});
      way["historic"](around:${r},${lat},${lng});
    );`;
  }

  return "";
}

// SEA SMART fallback: se l’utente vuole mare e vicino non c’è,
// faccio una query “solo mare” più aggressiva con raggio più grande.
function qSeaOnly(r, lat, lng) {
  return `
  (
    node["natural"="beach"](around:${r},${lat},${lng});
    way["natural"="beach"](around:${r},${lat},${lng});
    way["natural"="coastline"](around:${r},${lat},${lng});
    node["place"~"^(town|village|city)$"]["seaside"="yes"](around:${r},${lat},${lng});
    node["tourism"="attraction"]["attraction"="beach"](around:${r},${lat},${lng});
  );`;
}

function buildOverpassQuery(type, category, lat, lng, radiusMeters) {
  const r = Math.round(radiusMeters);
  const base = (type === "nature") ? qNature(r, lat, lng) : qPlaces(r, lat, lng);
  const extra = qCategoryExtra(category, r, lat, lng);

  return `
    [out:json][timeout:25];
    (
      ${base}
      ${extra}
    );
    out center 220;
  `.trim();
}

async function overpassFetchQuery(query) {
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

    out.push({ name, lat: c.lat, lng: c.lon, tags: el.tags || {} });
  }

  return uniqBy(out, p => `${p.name.toLowerCase()}_${p.lat.toFixed(3)}_${p.lng.toFixed(3)}`);
}

async function overpassFetch(type, category, lat, lng, radiusMeters) {
  const query = buildOverpassQuery(type, category, lat, lng, radiusMeters);
  return await overpassFetchQuery(query);
}

/* -----------------------
   choose best + alts
   ----------------------- */

function chooseTopAndAlternatives(candidates, targetMinutes) {
  const scored = candidates.map(c => {
    const diff = Math.abs(c.eta_min - targetMinutes);
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

    const mode = String(req.query.mode || "car").toLowerCase();
    const typeRaw = String(req.query.type || "places").toLowerCase();
    const type = (typeRaw === "nature") ? "nature" : "places"; // NO MIX

    const category = String(req.query.category || "").toLowerCase().trim(); // facoltativa

    const visitedRaw = String(req.query.visited || "").trim();
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
    const usable = Math.max(10, mins - buffer);
    let radiusKm = (usable * speed) / 60;

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

    // raggio base
    let radiusMeters = clamp(radiusKm * 1000, 7000, 300000);

    // 1) fetch normale
    let places = await overpassFetch(type, category, lat, lng, radiusMeters);

    // 2) fallback: allarga se pochi
    if (places.length < 25) {
      const more = await overpassFetch(type, category, lat, lng, clamp(radiusMeters * 1.4, 7000, 300000));
      places = uniqBy([...places, ...more], p => `${p.name.toLowerCase()}_${p.lat.toFixed(3)}_${p.lng.toFixed(3)}`);
    }

    // 3) SEA SMART: se category=sea e ancora pochi risultati “marini”, faccio un tentativo aggressivo
    let seaHint = null;
    if (category === "sea") {
      // cerco quanti “marini” ho (euristica: beach/coastline/seaside)
      const seaish = places.filter(p => {
        const t = p.tags || {};
        return t.natural === "beach" || t.natural === "coastline" || t.seaside === "yes";
      });

      if (seaish.length < 6) {
        // aumento il raggio ma con limite massimo coerente col tempo
        const seaRadiusMeters = clamp(radiusMeters * 2.2, 25000, 500000);

        const seaQuery = `
          [out:json][timeout:25];
          ${qSeaOnly(Math.round(seaRadiusMeters), lat, lng)}
          out center 240;
        `.trim();

        const seaPlaces = await overpassFetchQuery(seaQuery);
        places = uniqBy([...places, ...seaPlaces], p => `${p.name.toLowerCase()}_${p.lat.toFixed(3)}_${p.lng.toFixed(3)}`);

        // se anche così non ho roba da mare, dico chiaramente che il mare è lontano
        const afterSea = places.filter(p => {
          const t = p.tags || {};
          return t.natural === "beach" || t.natural === "coastline" || t.seaside === "yes";
        });

        if (afterSea.length === 0) {
          // stima minima: ipotizzo che il mare più vicino sia ~150km (euristica)
          const approxMinHours = Math.max(2, Math.round((150 / 70) * 10) / 10);
          seaHint = `Per il mare, da qui spesso servono ~${approxMinHours}h in auto. Prova ad aumentare il tempo.`;
        }
      }
    }

    // candidates
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

    const maxMin = mins * 1.35;

    candidates = candidates
      .filter(c => c.eta_min <= maxMin && c.eta_min >= 6)
      .filter(c => !visited.includes(c.id));

    // ultima chance: niente filtro max
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
        mode, type, category,
        engine,
        source: "Overpass",
        message: seaHint || "Nessun luogo trovato. Prova ad aumentare il tempo."
      });
    }

    const { top, alternatives } = chooseTopAndAlternatives(candidates, mins);

    return json(res, 200, {
      top,
      alternatives,
      mode, type, category,
      engine,
      source: "Overpass (SEA SMART attivo)"
    });

  } catch (e) {
    return json(res, 500, { error: "Server error", details: { error: e.message } });
  }
};
