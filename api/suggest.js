// /api/suggest.js  (Node / Vercel)
// STABILE: fallback Overpass + retry + query leggere + known/gems + categorie
// Richiede: (facoltativo) env ORS_API_KEY (solo per check profili <= 60min)

const ORS_BASE = "https://api.openrouteservice.org";

// Pool Overpass (se uno va giù, prova gli altri)
const OVERPASS_POOL = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter"
];

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // cache breve per non stressare Overpass
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600");
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
  // Nota: treno/bus/aereo qui sono "stima raggio" (non routing reale)
  if (mode === "walk") return 4.5;
  if (mode === "bike") return 15;
  if (mode === "bus") return 70;
  if (mode === "train") return 95;
  if (mode === "plane") return 550;
  return 65; // auto
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
  // solo check fino a 3600 sec (limite ORS)
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

async function overpassRequest(query, attempts = 3) {
  // Prova endpoint diversi + retry con backoff
  for (let a = 0; a < attempts; a++) {
    for (const base of OVERPASS_POOL) {
      try {
        const { ok, status, text } = await fetchText(base, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body: "data=" + encodeURIComponent(query)
        });

        // 504/429 -> consideriamo "ritentabile"
        if (!ok) {
          const retryable = status === 504 || status === 429 || status === 502 || status === 503;
          if (retryable) continue;
          throw new Error(`Overpass error (status ${status})`);
        }

        const data = JSON.parse(text);
        return data;
      } catch (e) {
        // prova prossimo endpoint
        continue;
      }
    }
    // backoff
    await new Promise(r => setTimeout(r, 250 * (a + 1)));
  }
  throw new Error("Overpass error (status 504)");
}

/* =========================
   QUERY BUILDER (type + category + style)
   ========================= */

function qPlacesKnown(r, lat, lng, hard = false) {
  // "Conosciuti": city/town + (village solo se wiki/wikidata/population)
  // hard=true (treno/aereo/bus) => ancora più stretti
  const villageCond = hard
    ? `["place"="village"]["wikidata"]`
    : `["place"="village"][("wikidata"|"wikipedia"|"population")]`;

  return `
(
  node["place"~"^(city|town)$"](around:${r},${lat},${lng});
  way["place"~"^(city|town)$"](around:${r},${lat},${lng});
  relation["place"~"^(city|town)$"](around:${r},${lat},${lng});

  node${villageCond}(around:${r},${lat},${lng});
  way${villageCond}(around:${r},${lat},${lng});
  relation${villageCond}(around:${r},${lat},${lng});
);
`.trim();
}

function qPlacesGems(r, lat, lng) {
  // "Chicche": village/town con wikidata/wikipedia oppure piccoli luoghi interessanti
  // Evitiamo hamlet/suburb/neighbourhood perché troppo random
  return `
(
  node["place"~"^(town|village)$"][("wikidata"|"wikipedia")](around:${r},${lat},${lng});
  way["place"~"^(town|village)$"][("wikidata"|"wikipedia")](around:${r},${lat},${lng});
  relation["place"~"^(town|village)$"][("wikidata"|"wikipedia")](around:${r},${lat},${lng});
);
`.trim();
}

function qNatureByCategory(r, lat, lng, category) {
  // categorie natura/esperienza
  switch ((category || "").toLowerCase()) {
    case "mare":
      return `
(
  node["natural"="beach"](around:${r},${lat},${lng});
  way["natural"="beach"](around:${r},${lat},${lng});
  node["tourism"="beach_resort"](around:${r},${lat},${lng});
  node["man_made"="lighthouse"](around:${r},${lat},${lng});
  node["tourism"="viewpoint"](around:${r},${lat},${lng});
);
`.trim();

    case "montagna":
      return `
(
  node["natural"="peak"](around:${r},${lat},${lng});
  node["tourism"="viewpoint"](around:${r},${lat},${lng});
  node["tourism"="alpine_hut"](around:${r},${lat},${lng});
  way["natural"="ridge"](around:${r},${lat},${lng});
);
`.trim();

    case "bambini":
      return `
(
  node["tourism"="theme_park"](around:${r},${lat},${lng});
  node["tourism"="zoo"](around:${r},${lat},${lng});
  node["leisure"="playground"](around:${r},${lat},${lng});
  node["tourism"="aquarium"](around:${r},${lat},${lng});
  node["leisure"="park"](around:${r},${lat},${lng});
);
`.trim();

    case "citta":
      // “città” è places (non natura)
      return "";

    default:
      // natura generica
      return `
(
  node["waterway"="waterfall"](around:${r},${lat},${lng});
  node["natural"="peak"](around:${r},${lat},${lng});
  node["tourism"="viewpoint"](around:${r},${lat},${lng});
  node["boundary"="national_park"](around:${r},${lat},${lng});
  node["leisure"="nature_reserve"](around:${r},${lat},${lng});
);
`.trim();
  }
}

function buildOverpassQuery({ lat, lng, radiusMeters, type, category, style, hardKnown }) {
  const r = Math.round(radiusMeters);
  const t = (type || "places").toLowerCase();
  const s = (style || "known").toLowerCase();
  const c = (category || "").toLowerCase();

  // Query leggera e veloce (timeout basso + output limit)
  // NB: out center per way/relation, out per node
  let inner = "";

  if (t === "nature") {
    inner = qNatureByCategory(r, lat, lng, c);
  } else {
    // places
    if (s === "gems") inner = qPlacesGems(r, lat, lng);
    else inner = qPlacesKnown(r, lat, lng, hardKnown);
  }

  if (!inner.trim()) {
    // fallback safe
    inner = qPlacesKnown(r, lat, lng, hardKnown);
  }

  return `
[out:json][timeout:20];
${inner}
out tags center qt 90;
`.trim();
}

/* =========================
   Parsing + Ranking
   ========================= */

function extractCandidates(data) {
  const elements = data?.elements || [];
  const out = [];

  for (const el of elements) {
    const tags = el.tags || {};
    const name = tags.name || tags["name:it"];
    if (!name) continue;

    const c =
      el.type === "node"
        ? { lat: el.lat, lon: el.lon }
        : el.center
          ? { lat: el.center.lat, lon: el.center.lon }
          : null;

    if (!c) continue;

    out.push({
      name,
      lat: c.lat,
      lng: c.lon,
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
      // gerarchia place
      if (place === "city") base += 60;
      else if (place === "town") base += 45;
      else if (place === "village") base += 25;
      else base += 5;

      if (hasWiki) base += 35;
      if (pop > 0) base += Math.min(25, Math.log10(pop + 1) * 6); // pop “soft”
    } else {
      // natura: viewpoint/peak/waterfall ecc.
      if (tags.waterway === "waterfall") base += 60;
      if (tags.natural === "peak") base += 55;
      if (tags.tourism === "viewpoint") base += 45;
      if (tags.natural === "beach") base += 55;
      if (tags.tourism === "theme_park") base += 55;
      if (tags.tourism === "zoo") base += 50;
      if (tags.leisure === "playground") base += 35;
      if (hasWiki) base += 10;
    }

    // stile:
    // known => spingo wiki + city/town
    // gems  => preferisco village/town con wiki (e non city enormi)
    if (s === "gems") {
      if (place === "city") base -= 20;
      if (place === "village") base += 12;
      if (hasWiki) base += 10;
      if (pop > 250000) base -= 20;
    }

    return base;
  };

  return cands
    .map(p => ({ ...p, _rank: score(p) }))
    .sort((a, b) => b._rank - a._rank);
}

function chooseTopAndAlternatives(candidates, targetMinutes) {
  // preferisco vicino al tempo target (ma non troppo vicini)
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
    const category = String(req.query.category || "").toLowerCase(); // mare | montagna | bambini | citta ...

    const visitedRaw = String(req.query.visited || "").trim();
    const visited = visitedRaw ? visitedRaw.split(",").map(s => s.trim()).filter(Boolean) : [];

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return json(res, 400, { error: "Parametri mancanti: lat,lng" });
    }

    const mins = clamp(minutes, 15, 360);
    const speed = avgSpeedKmh(mode);

    // raggio stimato
    let radiusKm = (mins * speed) / 60;

    // cap “ragionevole” per evitare query enormi
    // (aereo a 1h => 550km sarebbe distruttivo per Overpass)
    radiusKm = clamp(radiusKm, 8, mode === "plane" ? 180 : 140);

    let engine = "ESTIMATE";
    const apiKey = process.env.ORS_API_KEY;

    // ORS check SOLO se <= 60 min e mode in [car/walk/bike]
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

    // Per train/bus/plane e per known: "hardKnown" per evitare paesini random
    const hardKnown = (style === "known") && (mode === "train" || mode === "bus" || mode === "plane");

    // Tentativi Overpass: se 504 -> riduci raggio e riprova
    let radiusMeters = Math.round(radiusKm * 1000);
    const radiusSteps = [1.0, 0.8, 0.65, 0.5]; // riduzione progressiva

    let data = null;
    let lastErr = null;

    for (const k of radiusSteps) {
      const rM = clamp(radiusMeters * k, 6000, 200000); // 6km..200km
      const query = buildOverpassQuery({
        lat, lng,
        radiusMeters: rM,
        type,
        category,
        style,
        hardKnown
      });

      try {
        data = await overpassRequest(query, 2);
        radiusMeters = rM;
        break;
      } catch (e) {
        lastErr = e;
        data = null;
      }
    }

    if (!data) {
      // Niente crash UI: ritorno 200 con top=null
      return json(res, 200, {
        top: null,
        alternatives: [],
        mode, style, type, category,
        engine,
        source: "Overpass(pool)",
        message: "Overpass è lento/giù in questo momento (504). Riprova tra poco o cambia filtri."
      });
    }

    // Candidati + ranking
    let places = extractCandidates(data);
    places = rankCandidates(places, { style, type });

    // Trasforma in candidates con distanza + eta
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

    // filtro tempo (tolleranza)
    const maxMin = mins * 1.20;
    const minMin = Math.max(8, mins * 0.35);

    candidates = candidates
      .filter(c => c.eta_min <= maxMin && c.eta_min >= minMin)
      .filter(c => !visited.includes(c.id))
      // ranking prima, poi “fit”
      .sort((a, b) => (b._rank - a._rank));

    // se pochi, allenta (ma senza esplodere)
    if (candidates.length < 5) {
      const relaxedMax = mins * 1.45;
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
          _rank: p._rank
        };
      })
      .filter(c => c.eta_min <= relaxedMax && c.eta_min >= 8)
      .filter(c => !visited.includes(c.id))
      .sort((a, b) => (b._rank - a._rank));
    }

    if (!candidates.length) {
      return json(res, 200, {
        top: null,
        alternatives: [],
        mode, style, type, category,
        engine,
        source: "Overpass(pool)",
        message: "Nessuna meta valida con questi filtri. Aumenta tempo o cambia categoria."
      });
    }

    // scegli top + alternative vicino al target time
    const { top, alternatives } = chooseTopAndAlternatives(candidates.slice(0, 60), mins);

    return json(res, 200, {
      top,
      alternatives,
      mode, style, type, category,
      engine,
      source: "Overpass(pool)",
      radius_km_used: Math.round(radiusMeters / 1000)
    });

  } catch (e) {
    return json(res, 500, { error: "Server error", details: { error: e.message } });
  }
};
