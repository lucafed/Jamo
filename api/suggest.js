// /api/suggest.js  (Node / Vercel)
// Ultra-stabile: Overpass pool + retry + shrink radius + Fallback Wikidata (posti "conosciuti" veri)

const ORS_BASE = "https://api.openrouteservice.org";

// Overpass pool esteso (più possibilità che almeno uno risponda)
const OVERPASS_POOL = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];

const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=900");
  res.end(JSON.stringify(body));
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
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

function modeProfile(mode) {
  if (mode === "walk") return "foot-walking";
  if (mode === "bike") return "cycling-regular";
  return "driving-car";
}

function avgSpeedKmh(mode) {
  if (mode === "walk") return 4.5;
  if (mode === "bike") return 15;
  if (mode === "bus") return 70;
  if (mode === "train") return 95;
  if (mode === "plane") return 550; // solo stima raggio (non routing)
  return 65;
}

async function fetchText(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: r.ok, status: r.status, data, text };
}

async function orsIsochroneCheck(lat, lng, seconds, profile, apiKey) {
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
    body: JSON.stringify(body)
  });

  if (!ok) throw new Error(`${data?.error || "ORS error"} (status ${status})`);
  return true;
}

/* =========================
   OVERPASS: fallback + retry
   ========================= */

async function overpassRequest(query, attempts = 2) {
  for (let a = 0; a < attempts; a++) {
    for (const base of OVERPASS_POOL) {
      try {
        const { ok, status, text } = await fetchText(base, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body: "data=" + encodeURIComponent(query)
        });

        if (!ok) {
          const retryable = [429, 502, 503, 504].includes(status);
          if (retryable) continue;
          throw new Error(`Overpass error (status ${status})`);
        }

        return JSON.parse(text);
      } catch {
        continue;
      }
    }
    await new Promise(r => setTimeout(r, 250 * (a + 1)));
  }
  throw new Error("Overpass error (status 504)");
}

/* =========================
   WIKIDATA fallback (posti noti)
   ========================= */

function wikidataQuery(lat, lng, radiusKm) {
  // Posti abitati: city/town/village (Q515) + label in italiano, popolazione se presente.
  // Ordina per popolazione (desc) -> "più conosciuti" veri
  const r = clamp(radiusKm, 5, 250);
  return `
SELECT ?item ?itemLabel ?lat ?lon ?pop WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${lng} ${lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${r}" .
  }
  ?item wdt:P31/wdt:P279* wd:Q515 .
  OPTIONAL { ?item wdt:P1082 ?pop . }
  BIND(geof:latitude(?coord) AS ?lat)
  BIND(geof:longitude(?coord) AS ?lon)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "it,en". }
}
ORDER BY DESC(?pop)
LIMIT 40
`.trim();
}

async function wikidataPlaces(lat, lng, radiusKm) {
  const q = wikidataQuery(lat, lng, radiusKm);
  const url = `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(q)}`;

  const { ok, status, data } = await fetchJson(url, {
    headers: {
      "Accept": "application/sparql-results+json",
      "User-Agent": "Jamo/1.0 (Vercel; contact: none)"
    }
  });

  if (!ok) throw new Error(`Wikidata error (status ${status})`);

  const rows = data?.results?.bindings || [];
  return rows
    .map(r => ({
      name: r.itemLabel?.value,
      lat: Number(r.lat?.value),
      lng: Number(r.lon?.value),
      pop: Number(r.pop?.value || 0)
    }))
    .filter(x => x.name && Number.isFinite(x.lat) && Number.isFinite(x.lng));
}

/* =========================
   Query builder Overpass (leggero)
   ========================= */

function buildOverpassQuery({ lat, lng, radiusMeters, type, style }) {
  const r = Math.round(radiusMeters);
  const t = (type || "places").toLowerCase();
  const s = (style || "known").toLowerCase();

  // Query molto più leggera: solo node (più veloce)
  // Known: city/town (+ village solo se wikidata/wikipedia)
  // Gems: town/village con wiki (più “vero”)
  let inner = "";

  if (t === "places") {
    if (s === "gems") {
      inner = `
(
  node["place"~"^(town|village)$"][("wikidata"|"wikipedia")](around:${r},${lat},${lng});
);
`.trim();
    } else {
      inner = `
(
  node["place"~"^(city|town)$"](around:${r},${lat},${lng});
  node["place"="village"][("wikidata"|"wikipedia"|"population")](around:${r},${lat},${lng});
);
`.trim();
    }
  } else {
    // natura generica (veloce)
    inner = `
(
  node["natural"="beach"](around:${r},${lat},${lng});
  node["waterway"="waterfall"](around:${r},${lat},${lng});
  node["natural"="peak"](around:${r},${lat},${lng});
  node["tourism"="viewpoint"](around:${r},${lat},${lng});
  node["leisure"="nature_reserve"](around:${r},${lat},${lng});
);
`.trim();
  }

  return `
[out:json][timeout:18];
${inner}
out tags qt 70;
`.trim();
}

function extractCandidates(data) {
  const elements = data?.elements || [];
  const out = [];

  for (const el of elements) {
    const tags = el.tags || {};
    const name = tags.name || tags["name:it"];
    if (!name) continue;
    if (el.type !== "node") continue;

    out.push({
      name,
      lat: el.lat,
      lng: el.lon,
      tags
    });
  }

  return uniqBy(out, p => `${p.name.toLowerCase()}_${p.lat.toFixed(3)}_${p.lng.toFixed(3)}`);
}

function rankCandidates(cands, { style, type }) {
  const s = (style || "known").toLowerCase();
  const t = (type || "places").toLowerCase();

  const score = (p) => {
    const tags = p.tags || {};
    const hasWiki = !!(tags.wikidata || tags.wikipedia);
    const pop = Number(tags.population || 0) || 0;
    const place = tags.place || "";

    let base = 0;

    if (t === "places") {
      if (place === "city") base += 60;
      else if (place === "town") base += 45;
      else if (place === "village") base += 25;
      else base += 5;

      if (hasWiki) base += 35;
      if (pop > 0) base += Math.min(25, Math.log10(pop + 1) * 6);

      if (s === "gems") {
        if (place === "city") base -= 25;
        if (place === "village") base += 12;
        if (pop > 250000) base -= 20;
      }
    } else {
      if (tags.natural === "beach") base += 55;
      if (tags.waterway === "waterfall") base += 60;
      if (tags.natural === "peak") base += 55;
      if (tags.tourism === "viewpoint") base += 45;
      if (hasWiki) base += 8;
    }

    return base;
  };

  return cands
    .map(p => ({ ...p, _rank: score(p) }))
    .sort((a, b) => b._rank - a._rank);
}

function chooseTopAndAlternatives(candidates, targetMinutes) {
  const scored = candidates.map(c => {
    const diff = Math.abs(c.eta_min - targetMinutes);
    const tooClose = c.eta_min < Math.max(10, targetMinutes * 0.35) ? 18 : 0;
    return { ...c, _fit: diff + tooClose };
  }).sort((a, b) => a._fit - b._fit);

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

/* =========================
   Handler
   ========================= */

module.exports = async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const minutes = parseInt(req.query.minutes || "60", 10);

    const mode = String(req.query.mode || "car").toLowerCase();
    const style = String(req.query.style || "known").toLowerCase();
    const type = String(req.query.type || "places").toLowerCase(); // places | nature

    const visitedRaw = String(req.query.visited || "").trim();
    const visited = visitedRaw ? visitedRaw.split(",").map(s => s.trim()).filter(Boolean) : [];

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return json(res, 400, { error: "Parametri mancanti: lat,lng" });
    }

    const mins = clamp(minutes, 15, 360);
    const speed = avgSpeedKmh(mode);

    // raggio stimato (cap forte per non uccidere gli endpoint)
    let radiusKm = clamp((mins * speed) / 60, 8, mode === "plane" ? 180 : 140);

    let engine = "ESTIMATE";
    const apiKey = process.env.ORS_API_KEY;
    const routableMode = ["car", "walk", "bike"].includes(mode);

    if (apiKey && routableMode && mins * 60 <= 3600) {
      try {
        await orsIsochroneCheck(lat, lng, mins * 60, modeProfile(mode), apiKey);
        engine = "ORS_OK";
      } catch {
        engine = "ORS_FALLBACK";
      }
    } else {
      engine = apiKey ? "ORS_LIMIT_FALLBACK" : "NO_ORS_KEY";
    }

    // Tentativi: shrink radius se Overpass è lento
    const radiusSteps = [1.0, 0.75, 0.55, 0.4];
    let data = null;

    for (const k of radiusSteps) {
      const rM = clamp(Math.round(radiusKm * 1000 * k), 6000, 180000);
      const query = buildOverpassQuery({ lat, lng, radiusMeters: rM, type, style });
      try {
        data = await overpassRequest(query, 2);
        break;
      } catch {
        data = null;
      }
    }

    // ✅ Fallback: se Overpass KO e type=places -> Wikidata (molto stabile)
    if (!data && type === "places") {
      try {
        const wd = await wikidataPlaces(lat, lng, radiusKm);
        if (!wd.length) {
          return json(res, 200, {
            top: null, alternatives: [],
            mode, style, type,
            engine,
            source: "Wikidata",
            message: "Non ho trovato mete in Wikidata con questi filtri."
          });
        }

        // Trasforma in candidates
        let candidates = wd.map(p => {
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
            _rank: Math.log10((p.pop || 1) + 10) * 10 // ranking by pop
          };
        });

        const maxMin = mins * 1.25;
        const minMin = Math.max(8, mins * 0.35);

        candidates = candidates
          .filter(c => c.eta_min <= maxMin && c.eta_min >= minMin)
          .filter(c => !visited.includes(c.id))
          .sort((a, b) => (b._rank - a._rank));

        if (!candidates.length) {
          return json(res, 200, {
            top: null, alternatives: [],
            mode, style, type,
            engine,
            source: "Wikidata",
            message: "Nessuna meta valida con questi filtri. Aumenta tempo o cambia mezzo."
          });
        }

        const { top, alternatives } = chooseTopAndAlternatives(candidates.slice(0, 50), mins);

        return json(res, 200, {
          top, alternatives,
          mode, style, type,
          engine,
          source: "Wikidata(fallback)"
        });

      } catch {
        // se pure Wikidata fallisce
        return json(res, 200, {
          top: null,
          alternatives: [],
          mode, style, type,
          engine,
          source: "Overpass+Wikidata",
          message: "Servizi esterni lenti/giù. Riprova tra poco."
        });
      }
    }

    // Se Overpass KO e non posso usare fallback
    if (!data) {
      return json(res, 200, {
        top: null,
        alternatives: [],
        mode, style, type,
        engine,
        source: "Overpass(pool)",
        message: "Overpass è lento/giù in questo momento (504). Riprova tra poco o cambia filtri."
      });
    }

    // Overpass OK
    let places = extractCandidates(data);
    places = rankCandidates(places, { style, type });

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
        _rank: p._rank
      };
    });

    const maxMin = mins * 1.20;
    const minMin = Math.max(8, mins * 0.35);

    candidates = candidates
      .filter(c => c.eta_min <= maxMin && c.eta_min >= minMin)
      .filter(c => !visited.includes(c.id))
      .sort((a, b) => (b._rank - a._rank));

    if (!candidates.length) {
      return json(res, 200, {
        top: null, alternatives: [],
        mode, style, type,
        engine,
        source: "Overpass(pool)",
        message: "Nessuna meta valida con questi filtri. Aumenta tempo o cambia filtri."
      });
    }

    const { top, alternatives } = chooseTopAndAlternatives(candidates.slice(0, 60), mins);

    return json(res, 200, {
      top, alternatives,
      mode, style, type,
      engine,
      source: "Overpass(pool)"
    });

  } catch (e) {
    return json(res, 500, { error: "Server error", details: { error: e.message } });
  }
};
