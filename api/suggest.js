// /api/suggest.js (Vercel / Node)
// GET /api/suggest?lat=..&lng=..&minutes=60&mode=car&style=known|gems&category=any|city|sea|mountain|kids&visited=...

const OVERPASS_POOL = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function clamp(n, a, b) {
  n = Number(n);
  if (!Number.isFinite(n)) return a;
  return Math.max(a, Math.min(b, n));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toRad(x) { return (x * Math.PI) / 180; }
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function mapsUrl(lat, lng, name) {
  const q = encodeURIComponent(name || `${lat},${lng}`);
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function makeId(name, lat, lng) {
  return `${(name||"place").toLowerCase().replace(/\s+/g,"_")}@${lat.toFixed(5)},${lng.toFixed(5)}`;
}

function avgSpeedKmh(mode) {
  if (mode === "walk") return 4.5;
  if (mode === "bike") return 15;
  if (mode === "bus") return 55;
  if (mode === "train") return 90;
  if (mode === "plane") return 500;
  return 70; // car
}

async function overpassRequest(query, attempts = 2) {
  for (let a = 0; a < attempts; a++) {
    for (const base of OVERPASS_POOL) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 12000);
        const r = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body: "data=" + encodeURIComponent(query),
          signal: ctrl.signal
        }).finally(() => clearTimeout(t));

        const text = await r.text();
        if (!r.ok) {
          if ([429,502,503,504].includes(r.status)) continue;
          throw new Error(`Overpass error (${r.status})`);
        }
        return JSON.parse(text);
      } catch {
        continue;
      }
    }
    await sleep(250 * (a + 1));
  }
  const err = new Error("Overpass error (status 504)");
  err.code = 504;
  throw err;
}

// Costruiamo query SOLO "mete" (no ristoranti, no POI)
// + in base alla category aggiungiamo filtri “tema” senza mix
function buildDestQuery({ lat, lng, radiusM, category }) {
  const r = Math.round(radiusM);

  // mete principali SEMPRE: place
  const places = `
    node(around:${r},${lat},${lng})["place"~"^(city|town|village)$"];
    way(around:${r},${lat},${lng})["place"~"^(city|town|village)$"];
    relation(around:${r},${lat},${lng})["place"~"^(city|town|village)$"];
  `;

  // “tema”: serve solo a filtrare zone coerenti, ma la meta resta “place”
  // NB: non scegliamo “spiaggia” come meta, scegliamo un paese/città vicino al mare ecc.
  const theme = {
    any: ``,
    city: ``,
    sea: `
      node(around:${r},${lat},${lng})["natural"="beach"];
      way(around:${r},${lat},${lng})["natural"="beach"];
    `,
    mountain: `
      node(around:${r},${lat},${lng})["natural"="peak"];
      node(around:${r},${lat},${lng})["waterway"="waterfall"];
      way(around:${r},${lat},${lng})["leisure"="nature_reserve"];
      relation(around:${r},${lat},${lng})["boundary"="national_park"];
    `,
    kids: `
      node(around:${r},${lat},${lng})["leisure"="playground"];
      node(around:${r},${lat},${lng})["tourism"="theme_park"];
      node(around:${r},${lat},${lng})["amenity"="zoo"];
      node(around:${r},${lat},${lng})["amenity"="aquarium"];
    `
  };

  const extra = theme[category] || theme.any;

  // Nota: facciamo 2 gruppi: theme markers e places.
  // Se c’è theme, filtriamo places restituendo solo quelli vicini ai marker (post-processing).
  return `
[out:json][timeout:22];
(
  ${places}
  ${extra}
);
out center tags 400;
`.trim();
}

function normalizeElements(data) {
  const els = data?.elements || [];
  const out = [];
  for (const el of els) {
    const tags = el.tags || {};
    const name = tags.name || tags["name:it"];
    if (!name) continue;

    // coordinate:
    const c =
      el.type === "node"
        ? { lat: el.lat, lng: el.lon }
        : el.center
          ? { lat: el.center.lat, lng: el.center.lon }
          : null;
    if (!c) continue;

    out.push({
      type: el.type,
      name,
      lat: c.lat,
      lng: c.lng,
      tags
    });
  }
  return out;
}

function isPlace(el) {
  const p = el.tags?.place;
  return p === "city" || p === "town" || p === "village";
}

function isThemeMarker(el, category) {
  const t = el.tags || {};
  if (category === "sea") return t.natural === "beach";
  if (category === "mountain") return t.natural === "peak" || t.waterway === "waterfall" || t.leisure === "nature_reserve" || t.boundary === "national_park";
  if (category === "kids") return t.leisure === "playground" || t.tourism === "theme_park" || t.amenity === "zoo" || t.amenity === "aquarium";
  return false;
}

// dedup forte: stesso nome (case-insensitive) o troppo vicini (<2km)
function dedupStrong(arr) {
  const out = [];
  for (const x of arr) {
    const nameKey = x.name.trim().toLowerCase();
    let dup = false;
    for (const y of out) {
      if (y.name.trim().toLowerCase() === nameKey) { dup = true; break; }
      const d = haversineKm(x.lat, x.lng, y.lat, y.lng);
      if (d < 2.0) { dup = true; break; }
    }
    if (!dup) out.push(x);
  }
  return out;
}

// ranking “conosciuti” vs “chicche”
function scorePlace(place, style) {
  const t = place.tags || {};
  const placeType = t.place || "";
  const pop = Number(t.population || 0);
  const hasWiki = !!(t.wikidata || t.wikipedia);

  let s = 0;

  if (style === "known") {
    // più conosciuti: city/town + popolazione + wiki
    if (placeType === "city") s += 60;
    if (placeType === "town") s += 40;
    if (placeType === "village") s += 10;
    if (hasWiki) s += 35;
    if (pop) s += Math.min(40, Math.log10(pop + 1) * 10);
  } else {
    // chicche: village/town piccoli + wiki/natura nei tag “is_in” non affidabile,
    // quindi facciamo preferire: village + wiki + no city
    if (placeType === "village") s += 55;
    if (placeType === "town") s += 20;
    if (placeType === "city") s -= 20;
    if (hasWiki) s += 30;
    if (pop) s += Math.min(15, Math.log10(pop + 1) * 4);
  }

  // bonus nome “non generico”
  if ((place.name || "").length > 4) s += 5;

  return s;
}

function pickTopAndAlternatives(cands, minutes) {
  // preferisco eta vicina al target ma non troppo corta
  const target = minutes;
  const minOk = Math.max(10, target * 0.35);
  const maxOk = target * 1.25;

  const scored = cands.map(c => {
    const diff = Math.abs(c.eta_min - target);
    const tooClose = c.eta_min < minOk ? 25 : 0;
    const tooFar = c.eta_min > maxOk ? 20 : 0;
    return { ...c, _fit: diff + tooClose + tooFar };
  }).sort((a,b) => a._fit - b._fit);

  const top = scored[0] || null;
  const alternatives = [];
  for (let i = 1; i < scored.length && alternatives.length < 3; i++) {
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

    const mode = String(req.query.mode || "car").toLowerCase();
    const style = String(req.query.style || "known").toLowerCase(); // known|gems
    const category = String(req.query.category || "any").toLowerCase(); // any|city|sea|mountain|kids

    const visitedRaw = String(req.query.visited || "").trim();
    const visited = visitedRaw ? visitedRaw.split(",").map(s => s.trim()).filter(Boolean) : [];

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return json(res, 400, { error: "Parametri mancanti: lat,lng" });
    }

    const mins = clamp(minutes, 15, 360);
    const speed = avgSpeedKmh(mode);

    // raggio stimato (non ORS): più stabile
    const radiusKm = (mins * speed) / 60;
    const radiusM = clamp(radiusKm * 1000, 8000, 350000); // 8 km - 350 km

    const q = buildDestQuery({ lat, lng, radiusM, category });
    const data = await overpassRequest(q, 2);

    const all = normalizeElements(data);

    const places = all.filter(isPlace);

    // se category != any/city: teniamo solo places “vicini” ai marker tema
    let filteredPlaces = places;
    if (category !== "any" && category !== "city") {
      const markers = all.filter(el => isThemeMarker(el, category));
      if (markers.length) {
        filteredPlaces = places.filter(p => {
          // almeno un marker entro 18km dal place (aggiustabile)
          for (const m of markers) {
            const d = haversineKm(p.lat, p.lng, m.lat, m.lng);
            if (d <= 18) return true;
          }
          return false;
        });
      }
      // se nessun marker trovato, NON blocco tutto: torno ai places normali
    }

    // candidates con eta + score + filtri visited
    let candidates = filteredPlaces.map(p => {
      const d = haversineKm(lat, lng, p.lat, p.lng);
      const eta = (d / speed) * 60;
      const id = makeId(p.name, p.lat, p.lng);
      return {
        id,
        name: p.name,
        lat: p.lat,
        lng: p.lng,
        distance_km: d,
        eta_min: eta,
        maps_url: mapsUrl(p.lat, p.lng, p.name),
        _score: scorePlace(p, style)
      };
    })
    .filter(c => !visited.includes(c.id))
    .filter(c => c.eta_min >= Math.max(8, mins * 0.30) && c.eta_min <= mins * 1.35)
    .sort((a,b) => b._score - a._score);

    // dedup forte + taglio top N
    candidates = dedupStrong(candidates).slice(0, 60);

    if (!candidates.length) {
      return json(res, 200, {
        top: null,
        alternatives: [],
        mode, style, category,
        engine: "OVERPASS",
        message: "Nessuna meta trovata con questi filtri. Prova ad aumentare il tempo o cambia categoria."
      });
    }

    const { top, alternatives } = pickTopAndAlternatives(candidates, mins);

    return json(res, 200, {
      top,
      alternatives,
      mode, style, category,
      engine: "OVERPASS",
      source: "Overpass(place=city|town|village)"
    });

  } catch (e) {
    // messaggio più amichevole per 504
    const msg = String(e?.message || e);
    if (msg.includes("504")) {
      return json(res, 200, {
        top: null,
        alternatives: [],
        message: "Overpass è lento/giù in questo momento (504). Riprova tra poco o cambia filtri."
      });
    }
    return json(res, 500, { error: "Server error", details: { error: msg } });
  }
};
