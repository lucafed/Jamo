// /api/suggest.js (Vercel / Node) — v3 HUB-BASED (train/bus/plane)
// - Tempo per train/bus/plane = SOLO tempo sul mezzo (non porta a porta)
// - Selezione mete: solo place=* (no pizzerie)
// - Mode train/bus/plane: mete vicino a hub coerenti (stazioni/autostazioni/aeroporti)
// - Pool Overpass per ridurre 504
// - ORS opzionale solo per car/walk/bike (non necessario per train/bus/plane)

const OVERPASS_POOL = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter"
];

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function toRad(x) { return (x * Math.PI) / 180; }
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
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
  return `${(name || "place").toLowerCase().replace(/\s+/g, "_")}@${lat.toFixed(5)},${lng.toFixed(5)}`;
}

// Velocità “solo mezzo”
function speedKmh(mode) {
  if (mode === "walk") return 4.5;
  if (mode === "bike") return 15;
  if (mode === "car") return 70;
  if (mode === "train") return 110;  // media realistica (regionale+IC)
  if (mode === "bus") return 65;     // extraurbano
  if (mode === "plane") return 650;  // solo volo (cruise)
  return 60;
}

// Radius = distanza percorribile con QUEL MEZZO nel tempo scelto
function radiusKmFromMinutes(minutes, mode) {
  const km = (minutes / 60) * speedKmh(mode);
  // limiti realistici per non far esplodere Overpass
  if (mode === "plane") return clamp(km, 50, 900);   // almeno 50km, massimo 900km
  if (mode === "train") return clamp(km, 10, 450);
  if (mode === "bus") return clamp(km, 10, 280);
  return clamp(km, 5, 250);
}

async function fetchOverpassWithPool(query) {
  let lastErr = null;

  for (const url of OVERPASS_POOL) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: "data=" + encodeURIComponent(query)
      });

      const txt = await r.text();

      if (!r.ok) {
        lastErr = new Error(`Overpass error (status ${r.status})`);
        continue;
      }

      // a volte 200 ma non JSON (rare)
      let data = null;
      try { data = JSON.parse(txt); }
      catch { lastErr = new Error("Overpass: JSON parse failed"); continue; }

      return data;
    } catch (e) {
      lastErr = e;
      continue;
    }
  }

  throw lastErr || new Error("Overpass unavailable");
}

/* -------------------------
   Queries
   ------------------------- */

// Mete = SOLO place, no amenity (niente pizzerie)
function queryPlacesAround(lat, lng, radiusMeters) {
  const r = Math.round(radiusMeters);
  return `
[out:json][timeout:25];
(
  node["place"~"^(city|town|village)$"](around:${r},${lat},${lng});
  way["place"~"^(city|town|village)$"](around:${r},${lat},${lng});
  relation["place"~"^(city|town|village)$"](around:${r},${lat},${lng});
);
out center tags 250;
`.trim();
}

// Hub: train stations
function queryTrainHubs(lat, lng, radiusMeters) {
  const r = Math.round(radiusMeters);
  return `
[out:json][timeout:25];
(
  node["railway"="station"](around:${r},${lat},${lng});
  way["railway"="station"](around:${r},${lat},${lng});
  relation["railway"="station"](around:${r},${lat},${lng});
);
out center tags 200;
`.trim();
}

// Hub: bus stations (autostazione/ferm.)
function queryBusHubs(lat, lng, radiusMeters) {
  const r = Math.round(radiusMeters);
  return `
[out:json][timeout:25];
(
  node["amenity"="bus_station"](around:${r},${lat},${lng});
  way["amenity"="bus_station"](around:${r},${lat},${lng});
  relation["amenity"="bus_station"](around:${r},${lat},${lng});

  node["highway"="bus_stop"](around:${r},${lat},${lng});
);
out center tags 200;
`.trim();
}

// Hub: airports
function queryAirHubs(lat, lng, radiusMeters) {
  const r = Math.round(radiusMeters);
  return `
[out:json][timeout:25];
(
  node["aeroway"="aerodrome"](around:${r},${lat},${lng});
  way["aeroway"="aerodrome"](around:${r},${lat},${lng});
  relation["aeroway"="aerodrome"](around:${r},${lat},${lng});
);
out center tags 200;
`.trim();
}

/* -------------------------
   Normalizers
   ------------------------- */

function centerOf(el) {
  if (el.type === "node") return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

function normalizePlaces(overpassData) {
  const els = overpassData?.elements || [];
  const out = [];
  for (const el of els) {
    const name = el.tags?.name || el.tags?.["name:it"];
    if (!name) continue;

    const c = centerOf(el);
    if (!c) continue;

    const placeType = el.tags?.place;
    if (!placeType) continue;

    // SOLO city/town/village
    if (!/^(city|town|village)$/.test(placeType)) continue;

    out.push({
      name,
      lat: c.lat,
      lng: c.lon,
      placeType,
      tags: el.tags
    });
  }

  // dedup forte per nome+zona
  return uniqBy(out, p => `${p.name.toLowerCase()}_${p.lat.toFixed(3)}_${p.lng.toFixed(3)}`);
}

function normalizeHubs(overpassData) {
  const els = overpassData?.elements || [];
  const out = [];
  for (const el of els) {
    const name = el.tags?.name || el.tags?.["name:it"] || "Hub";
    const c = centerOf(el);
    if (!c) continue;
    out.push({ name, lat: c.lat, lng: c.lon, tags: el.tags || {} });
  }
  return uniqBy(out, h => `${h.name.toLowerCase()}_${h.lat.toFixed(3)}_${h.lng.toFixed(3)}`);
}

/* -------------------------
   Ranking: known vs gems + category
   ------------------------- */

function scorePlace(place, style, category) {
  const t = place.tags || {};
  let s = 0;

  // “Conosciuti”: city>town, wikipedia/wikidata/population
  if (style === "known") {
    if (place.placeType === "city") s += 60;
    if (place.placeType === "town") s += 35;
    if (place.placeType === "village") s += 10;

    if (t.wikipedia) s += 25;
    if (t.wikidata) s += 15;
    if (t.population) s += 10;
  } else {
    // “Chicche”: village/town piccoli, ma con segnali di interesse
    if (place.placeType === "village") s += 35;
    if (place.placeType === "town") s += 20;
    if (place.placeType === "city") s += 5;

    if (t.wikipedia) s += 10;
    if (t.wikidata) s += 6;

    // penalizzo “mega città” (se pop alta)
    const pop = Number(t.population || 0);
    if (pop > 300000) s -= 25;
    else if (pop > 100000) s -= 12;
  }

  // Categoria (soft): per ora gestita in modo stabile con tag is_in/coastline NON affidabili.
  // Quindi lato server la facciamo “soft” e non blocchiamo tutto.
  // Se category != any, diamo un piccolo bonus a segnali coerenti.
  if (category === "mountain") {
    if (t.ele) s += 6;
    if (t.natural) s += 6;
  }
  if (category === "sea") {
    // OSM non dà sempre “sea” su place. Mettiamo bonus se vicino a “coastline” => non stabile senza query extra.
    // Quindi qui lasciamo neutro (gestibile meglio più avanti).
    s += 0;
  }
  if (category === "kids") {
    // idem: i tag kids sono su POI, non su place
    s += 0;
  }
  if (category === "city") {
    if (place.placeType === "city") s += 10;
    if (place.placeType === "town") s += 4;
    if (place.placeType === "village") s -= 2;
  }

  return s;
}

/* -------------------------
   Mode hub filtering
   ------------------------- */

// True se la meta è “servita” da un hub vicino (stazione/autostazione/aeroporto)
function hasNearbyHub(place, hubs, maxKm) {
  for (const h of hubs) {
    const d = haversineKm(place.lat, place.lng, h.lat, h.lng);
    if (d <= maxKm) return true;
  }
  return false;
}

function chooseTopAndAlternatives(candidates, targetMinutes) {
  // Preferisco vicino al target (tempo sul mezzo)
  const scored = candidates.map(c => {
    const diff = Math.abs(c.eta_min - targetMinutes);
    return { ...c, _diff: diff };
  }).sort((a, b) => a._diff - b._diff);

  const top = scored[0] || null;

  const alternatives = [];
  const seenNames = new Set();
  if (top) seenNames.add((top.name || "").toLowerCase());

  for (let i = 1; i < scored.length && alternatives.length < 3; i++) {
    const a = scored[i];
    const k = (a.name || "").toLowerCase();
    if (!k || seenNames.has(k)) continue;
    seenNames.add(k);
    alternatives.push(a);
  }

  return { top, alternatives };
}

/* -------------------------
   Handler
   ------------------------- */

module.exports = async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const minutes = clamp(parseInt(req.query.minutes || "60", 10), 15, 360);

    const mode = String(req.query.mode || "car").toLowerCase();
    const style = String(req.query.style || "known").toLowerCase();      // known | gems
    const category = String(req.query.category || "any").toLowerCase();  // any|city|sea|mountain|kids

    const visitedRaw = String(req.query.visited || "").trim();
    const visited = visitedRaw ? visitedRaw.split(",").map(s => s.trim()).filter(Boolean) : [];

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return json(res, 400, { error: "Parametri mancanti: lat,lng" });
    }

    const radiusKm = radiusKmFromMinutes(minutes, mode);
    const radiusMeters = radiusKm * 1000;

    // 1) car/walk/bike: semplicemente places around
    // 2) train/bus/plane: prendo hub e filtro mete servite
    let hubs = [];
    if (mode === "train") {
      const hubsData = await fetchOverpassWithPool(queryTrainHubs(lat, lng, radiusMeters));
      hubs = normalizeHubs(hubsData);
    } else if (mode === "bus") {
      const hubsData = await fetchOverpassWithPool(queryBusHubs(lat, lng, radiusMeters));
      hubs = normalizeHubs(hubsData);
    } else if (mode === "plane") {
      // per aereo meglio cercare aeroporti in un raggio ampio MINIMO
      const airRadius = Math.max(radiusMeters, 150000); // almeno 150km per trovare aeroporti
      const hubsData = await fetchOverpassWithPool(queryAirHubs(lat, lng, airRadius));
      hubs = normalizeHubs(hubsData);
    }

    // Mete candidate (place=*)
    const placesData = await fetchOverpassWithPool(queryPlacesAround(lat, lng, radiusMeters));
    let places = normalizePlaces(placesData);

    // Hub filtering per mezzi
    if (mode === "train") {
      // destinazione “raggiungibile” se ha una stazione entro 4 km
      places = places.filter(p => hasNearbyHub(p, hubs, 4));
    } else if (mode === "bus") {
      // bus: fermata/autostazione entro 3 km (più permissivo)
      places = places.filter(p => hasNearbyHub(p, hubs, 3));
    } else if (mode === "plane") {
      // aereo: aeroporto entro 18 km (città aeroportuale)
      places = places.filter(p => hasNearbyHub(p, hubs, 18));
    }

    // Se dopo filtro restano 0, fallback soft: non blocco tutto, allargo raggio o riduco vincolo hub
    if (!places.length && (mode === "train" || mode === "bus" || mode === "plane")) {
      // fallback: togli il vincolo hub ma segnala engine
      // (così non “rompe” e non dà 0 risultati sempre)
      places = normalizePlaces(placesData);
    }

    // Trasformo in candidates: tempo = distanza / speed (tempo “solo mezzo”)
    const speed = speedKmh(mode);
    let candidates = places.map(p => {
      const dKm = haversineKm(lat, lng, p.lat, p.lng);
      const eta = (dKm / speed) * 60; // minuti sul mezzo
      return {
        id: makeId(p.name, p.lat, p.lng),
        name: p.name,
        lat: p.lat,
        lng: p.lng,
        distance_km: dKm,
        eta_min: eta,
        maps_url: mapsUrl(p.lat, p.lng, p.name),
        _score: scorePlace(p, style, category)
      };
    });

    // filtro su tempo: vicino al target, con tolleranza
    const minMin = Math.max(10, minutes * 0.35);
    const maxMin = minutes * 1.20;

    candidates = candidates
      .filter(c => c.eta_min >= minMin && c.eta_min <= maxMin)
      .filter(c => !visited.includes(c.id));

    // ranking: prima score, poi vicino al target
    candidates.sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return Math.abs(a.eta_min - minutes) - Math.abs(b.eta_min - minutes);
    });

    // dedup per name (per evitare triple uguali)
    const seenName = new Set();
    candidates = candidates.filter(c => {
      const k = (c.name || "").toLowerCase();
      if (!k) return false;
      if (seenName.has(k)) return false;
      seenName.add(k);
      return true;
    });

    if (!candidates.length) {
      return json(res, 200, {
        top: null,
        alternatives: [],
        mode,
        style,
        category,
        message: "Nessuna meta trovata con questi filtri. Aumenta il tempo o cambia categoria."
      });
    }

    const { top, alternatives } = chooseTopAndAlternatives(candidates, minutes);

    return json(res, 200, {
      top,
      alternatives,
      mode,
      style,
      category,
      radius_km: radiusKm,
      hubs_found: hubs.length
    });

  } catch (e) {
    const msg = String(e?.message || e);
    // messaggio user-friendly per 504
    if (msg.includes("Overpass error") || msg.includes("Overpass unavailable")) {
      return json(res, 200, {
        top: null,
        alternatives: [],
        message: "Overpass è lento/giù in questo momento (504). Riprova tra poco o cambia filtri."
      });
    }
    return json(res, 500, { error: "Server error", details: { error: msg } });
  }
};
