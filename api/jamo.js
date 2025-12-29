// /api/jamo.js — ONE API to rule them all (Vercel Hobby friendly)
// POST {
//   origin:{lat,lon,label?},
//   minutes:number,
//   mode:"car"|"walk"|"bike"|"train"|"bus"|"plane" (accetta anche IT: auto/aereo/treno),
//   style:"known"|"gems",
//   category:string,
//   excludeIds?:string[]
// }
// Returns { ok:true, top:{...}, alternatives:[...], debug?:... }

import fs from "fs";
import path from "path";

/* -------------------------
   File helpers (public/data)
------------------------- */
function readJsonFromPublicData(filename) {
  const p = path.join(process.cwd(), "public", "data", filename);
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

/* -------------------------
   Basic utils
------------------------- */
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
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();
}
function normName(s) {
  return norm(s).replace(/[^a-z0-9]+/g, " ").trim();
}

/* -------------------------
   Mode mapping (IT/EN -> canonical)
------------------------- */
function canonicalMode(raw) {
  const m = norm(raw);
  if (["car","auto","macchina"].includes(m)) return "car";
  if (["walk","piedi","a piedi"].includes(m)) return "walk";
  if (["bike","bici","bicicletta"].includes(m)) return "bike";
  if (["plane","aereo","volo"].includes(m)) return "plane";
  if (["train","treno"].includes(m)) return "train";
  if (["bus","pullman"].includes(m)) return "bus";
  return "car";
}

function avgSpeedKmh(mode) {
  if (mode === "walk") return 4.5;
  if (mode === "bike") return 15;
  return 70; // car default
}

/* -------------------------
   Category mapping
------------------------- */
function allowedTypesFromCategory(categoryRaw) {
  const c = norm(categoryRaw);
  if (c.includes("borgh") && c.includes("citt")) return ["citta", "borgo"];
  if (c === "citta_borghi") return ["citta", "borgo"];
  if (c === "citta" || c === "città" || c === "city") return ["citta"];
  if (c === "borgo" || c === "borghi") return ["borgo"];
  if (c === "mare") return ["mare"];
  if (c === "montagna") return ["montagna"];
  if (c === "natura") return ["natura"];
  if (c === "relax") return ["relax"];
  if (c === "bambini") return ["bambini"];
  return [c];
}

function buildIdFromName(name, lat, lon) {
  const base = normName(name).slice(0, 60).replace(/\s+/g, "_");
  const a = Number.isFinite(lat) ? lat.toFixed(4) : "x";
  const o = Number.isFinite(lon) ? lon.toFixed(4) : "y";
  return `osm_${base}_${a}_${o}`;
}

/* -------------------------
   HARD CAPS: vicino davvero
   - Non oltre il tempo scelto “in modo assurdo”
------------------------- */
function hardCaps(minutes, mode) {
  // cap tempo: 30-45 min devono rimanere davvero locali
  // consento un piccolo +25% per imprecisione (linea d’aria vs strada)
  const hardCapMin = minutes * 1.25;

  // cap km coerente: velocità * ore * fattore (haversine sottostima)
  const speed = avgSpeedKmh(mode === "walk" || mode === "bike" ? mode : "car");
  const hardCapKm = (speed * (minutes / 60)) * 1.6;

  return { hardCapMin, hardCapKm };
}

/* -------------------------
   Overpass
------------------------- */
async function overpass(query, timeoutMs = 18000) {
  const url = "https://overpass-api.de/api/interpreter";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: "data=" + encodeURIComponent(query),
      signal: ctrl.signal
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`Overpass ${r.status}: ${txt.slice(0, 120)}`);
    return JSON.parse(txt);
  } finally {
    clearTimeout(t);
  }
}

function pickRadiusKm(minutes, mode) {
  // per tempi piccoli NON allarghiamo troppo
  const speed = avgSpeedKmh(mode);
  const km = (speed * (minutes / 60)) * 1.1;
  return clamp(km, mode === "walk" ? 2 : 5, mode === "bike" ? 18 : 140);
}

function overpassQueryFor(category, lat, lon, radiusKm, style) {
  const r = Math.round(radiusKm * 1000);

  if (category === "mare") {
    return `
      [out:json][timeout:25];
      (
        node(around:${r},${lat},${lon})["natural"="beach"]["name"];
        way(around:${r},${lat},${lon})["natural"="beach"]["name"];
        node(around:${r},${lat},${lon})["tourism"="beach_resort"]["name"];
        way(around:${r},${lat},${lon})["tourism"="beach_resort"]["name"];
        node(around:${r},${lat},${lon})["place"="island"]["name"];
      );
      out center 120;
    `;
  }

  if (category === "montagna") {
    return `
      [out:json][timeout:25];
      (
        node(around:${r},${lat},${lon})["natural"="peak"]["name"];
        node(around:${r},${lat},${lon})["tourism"="viewpoint"]["name"];
        way(around:${r},${lat},${lon})["tourism"="viewpoint"]["name"];
      );
      out center 120;
    `;
  }

  if (category === "natura") {
    return `
      [out:json][timeout:25];
      (
        node(around:${r},${lat},${lon})["waterway"="waterfall"]["name"];
        node(around:${r},${lat},${lon})["natural"="wood"]["name"];
        way(around:${r},${lat},${lon})["natural"="wood"]["name"];
        node(around:${r},${lat},${lon})["natural"="spring"]["name"];
        node(around:${r},${lat},${lon})["tourism"="viewpoint"]["name"];
        way(around:${r},${lat},${lon})["leisure"="park"]["name"];
      );
      out center 140;
    `;
  }

  if (category === "relax") {
    return `
      [out:json][timeout:25];
      (
        node(around:${r},${lat},${lon})["amenity"="spa"]["name"];
        way(around:${r},${lat},${lon})["amenity"="spa"]["name"];
        node(around:${r},${lat},${lon})["natural"="hot_spring"]["name"];
        way(around:${r},${lat},${lon})["leisure"="park"]["name"];
      );
      out center 120;
    `;
  }

  if (category === "bambini") {
    return `
      [out:json][timeout:25];
      (
        node(around:${r},${lat},${lon})["tourism"="theme_park"]["name"];
        way(around:${r},${lat},${lon})["tourism"="theme_park"]["name"];
        node(around:${r},${lat},${lon})["leisure"="playground"]["name"];
        way(around:${r},${lat},${lon})["leisure"="playground"]["name"];
        way(around:${r},${lat},${lon})["leisure"="park"]["name"];
      );
      out center 120;
    `;
  }

  // città/borghi
  if (category === "citta" || category === "borgo" || category === "citta_borghi") {
    if (style === "gems") {
      return `
        [out:json][timeout:25];
        (
          node(around:${r},${lat},${lon})["place"~"village|hamlet|town"]["name"];
          node(around:${r},${lat},${lon})["historic"="castle"]["name"];
          node(around:${r},${lat},${lon})["tourism"="viewpoint"]["name"];
          way(around:${r},${lat},${lon})["tourism"="viewpoint"]["name"];
        );
        out center 160;
      `;
    }
    return `
      [out:json][timeout:25];
      (
        node(around:${r},${lat},${lon})["place"~"city|town"]["name"];
      );
      out center 120;
    `;
  }

  // fallback generico: attraction/viewpoint
  return `
    [out:json][timeout:25];
    (
      node(around:${r},${lat},${lon})["tourism"="attraction"]["name"];
      node(around:${r},${lat},${lon})["tourism"="viewpoint"]["name"];
      way(around:${r},${lat},${lon})["tourism"="viewpoint"]["name"];
    );
    out center 120;
  `;
}

function osmElementToPlace(el) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags["name:en"];
  if (!name) return null;

  let lat = el.lat;
  let lon = el.lon;
  if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && el.center) {
    lat = el.center.lat;
    lon = el.center.lon;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  let type = "natura";
  if (tags.natural === "beach" || tags.tourism === "beach_resort" || tags.place === "island") type = "mare";
  if (tags.place === "city" || tags.place === "town") type = "citta";
  if (tags.place === "village" || tags.place === "hamlet") type = "borgo";
  if (tags.natural === "peak") type = "montagna";
  if (tags.amenity === "spa" || tags.natural === "hot_spring") type = "relax";
  if (tags.tourism === "theme_park" || tags.leisure === "playground") type = "bambini";

  return {
    id: buildIdFromName(name, lat, lon),
    name,
    country: "",
    type,
    visibility: "chicca",
    lat,
    lng: lon,
    tags: [],
    vibes: [],
    best_when: [],
    why: [],
    what_to_do: [],
    what_to_eat: []
  };
}

/* -------------------------
   Enrichment + scoring (auto-like)
------------------------- */
function enrichPlace(place, category, style, origin, minutes, mode) {
  const km = haversineKm(origin.lat, origin.lon, place.lat, place.lng);
  const speed = avgSpeedKmh(mode === "walk" || mode === "bike" ? mode : "car");
  const eta = (km / speed) * 60;

  const isGems = style === "gems";
  const cat = category;

  const why = Array.isArray(place.why) && place.why.length ? place.why : [];
  const whatToDo = Array.isArray(place.what_to_do) && place.what_to_do.length ? place.what_to_do : [];
  const whatToEat = Array.isArray(place.what_to_eat) && place.what_to_eat.length ? place.what_to_eat : [];

  const genWhy = [];
  if (!why.length) {
    if (cat === "mare") genWhy.push("Hai scelto mare: qui trovi spiaggia/costa vicina e facile.");
    else if (cat === "montagna") genWhy.push("Hai scelto montagna: panorama e aria fresca senza sbatti.");
    else if (cat === "relax") genWhy.push("Hai scelto relax: posto perfetto per staccare e ricaricare.");
    else if (cat === "natura") genWhy.push("Hai scelto natura: passeggiata e scorci belli a portata di tempo.");
    else if (cat === "bambini") genWhy.push("Hai scelto kids: attività semplice, zero stress.");
    else genWhy.push(isGems ? "Chicca vicina: più piccola, più carina, meno caos." : "Opzione solida e facile per oggi.");
    genWhy.push(`Coerente col tempo: ~${Math.round(eta)} min (stima).`);
  }

  const genDo = [];
  if (!whatToDo.length) {
    if (cat === "mare") genDo.push("Passeggiata in spiaggia", "Tramonto", "Aperitivo vista");
    else if (cat === "montagna") genDo.push("Belvedere", "Passeggiata breve", "Rifugio / bar panoramico");
    else if (cat === "relax") genDo.push("Spa/terme (se presenti)", "Parco e camminata lenta", "Cena tranquilla");
    else if (cat === "natura") genDo.push("Sentiero facile", "Punto panoramico", "Picnic se il meteo regge");
    else if (cat === "bambini") genDo.push("Parco giochi / parco", "Attività semplice", "Merenda");
    else genDo.push("Passeggiata nel centro", "Punto panoramico", "Caffè e giro slow");
  }

  const genEat = [];
  if (!whatToEat.length) {
    if (cat === "mare") genEat.push("Pesce / fritto", "Gelato", "Aperitivo");
    else genEat.push("Specialità locale", "Dolce tipico", "Aperitivo in centro");
  }

  return {
    ...place,
    distance_km: km,
    eta_min: eta,
    why: why.length ? why : genWhy,
    what_to_do: whatToDo.length ? whatToDo : genDo,
    what_to_eat: whatToEat.length ? whatToEat : genEat
  };
}

function scorePlace(p, origin, minutes, style, category) {
  const km = p.distance_km ?? haversineKm(origin.lat, origin.lon, p.lat, p.lng);
  const eta = p.eta_min ?? (km / avgSpeedKmh("car")) * 60;

  const t = clamp(1 - (Math.abs(eta - minutes) / Math.max(18, minutes * 0.9)), 0, 1);
  const near = clamp(1 - (eta / (minutes * 1.20)), 0, 1);

  const isCity = norm(p.type) === "citta";
  // gems: penalizza città grandi se non stai cercando “solo città”
  const bigCityPenalty = (style === "gems" && isCity && category !== "citta") ? 0.30 : 0;

  const styleBoost = style === "gems"
    ? (norm(p.visibility) === "chicca" ? 1 : 0.85)
    : (norm(p.visibility) === "conosciuta" ? 1 : 0.9);

  return (0.55 * near) + (0.30 * t) + (0.15 * styleBoost) - bigCityPenalty;
}

function isSamePlace(aName, bLabel) {
  const an = normName(aName);
  const bl = normName(bLabel);
  return an && bl && an === bl;
}

/* -------------------------
   PLAN-LIKE (local JSON hubs/destinations)
   - Niente API esterne: legge da public/data
   - Ritorna route con hub e segments (stima)
------------------------- */
function nearestHub(hubs, lat, lon) {
  let best = null;
  let bestKm = Infinity;
  for (const h of hubs) {
    const hLat = Number(h.lat);
    const hLon = Number(h.lon);
    if (!Number.isFinite(hLat) || !Number.isFinite(hLon)) continue;
    const km = haversineKm(lat, lon, hLat, hLon);
    if (km < bestKm) { bestKm = km; best = h; }
  }
  return { hub: best, km: bestKm };
}
function estAccessMinutes(km, speedKmh, minM, maxM) {
  const m = (km / speedKmh) * 60 + 10;
  return Math.round(clamp(m, minM, maxM));
}
function estMainMinutes(mode, km) {
  if (mode === "plane") {
    const cruise = 820;
    const m = (km / cruise) * 60 + 55;
    return Math.round(clamp(m, 60, 2400));
  }
  if (mode === "train") {
    const avg = 140;
    const m = (km / avg) * 60 + 12;
    return Math.round(clamp(m, 30, 2400));
  }
  if (mode === "bus") {
    const avg = 85;
    const m = (km / avg) * 60 + 12;
    return Math.round(clamp(m, 35, 3000));
  }
  const avg = 70;
  return Math.round((km / avg) * 60);
}
function buildRoute({ mode, origin, dest, airports, stations }) {
  const oLat = origin.lat, oLon = origin.lon;
  const dLat = dest.lat, dLon = dest.lon;

  if (mode === "plane") {
    const oA = nearestHub(airports, oLat, oLon);
    const dA = nearestHub(airports, dLat, dLon);
    if (!oA.hub || !dA.hub) return null;

    const accessMin = estAccessMinutes(oA.km, 70, 20, 320);
    const flightKm = haversineKm(oA.hub.lat, oA.hub.lon, dA.hub.lat, dA.hub.lon);
    const flightMin = estMainMinutes("plane", flightKm);
    const egressMin = estAccessMinutes(dA.km, 55, 10, 220);
    const totalMinutes = accessMin + flightMin + egressMin;

    return {
      originHub: { ...oA.hub },
      destinationHub: { ...dA.hub },
      segments: [
        { kind: "access", label: `Verso ${oA.hub.name} (${oA.hub.code || "?"})`, minutes: accessMin },
        { kind: "main", label: `Volo ${(oA.hub.code || "?")} → ${(dA.hub.code || "?")}`, minutes: flightMin },
        { kind: "egress", label: `Dall’aeroporto a ${dest.name}`, minutes: egressMin }
      ],
      totalMinutes,
      confidence: "estimated"
    };
  }

  // train/bus: stations
  const oS = nearestHub(stations, oLat, oLon);
  const dS = nearestHub(stations, dLat, dLon);
  if (!oS.hub || !dS.hub) return null;

  const accessMin = estAccessMinutes(oS.km, 35, 8, 160);
  const mainKm = haversineKm(oS.hub.lat, oS.hub.lon, dS.hub.lat, dS.hub.lon);
  const mainMin = estMainMinutes(mode, mainKm);
  const egressMin = estAccessMinutes(dS.km, 30, 6, 160);
  const totalMinutes = accessMin + mainMin + egressMin;

  return {
    originHub: { ...oS.hub },
    destinationHub: { ...dS.hub },
    segments: [
      { kind: "access", label: `Verso ${oS.hub.name}`, minutes: accessMin },
      { kind: "main", label: `${mode === "train" ? "Treno" : "Bus"} ${oS.hub.name} → ${dS.hub.name}`, minutes: mainMin },
      { kind: "egress", label: `Dalla stazione a ${dest.name}`, minutes: egressMin }
    ],
    totalMinutes,
    confidence: "estimated"
  };
}

function buildPlanCandidates({ originObj, minutes, mode, style, excludeIds, originLabel }) {
  // local JSON
  const airports = readJsonFromPublicData("curated_airports_eu_uk.json");
  const stations = readJsonFromPublicData("curated_stations_eu_uk.json");
  const destinations = readJsonFromPublicData("curated_destinations_eu_uk.json");

  const originNorm = normName(originLabel || "");

  const out = [];
  for (const d of destinations) {
    const dest = {
      id: d.id,
      name: d.name,
      country: d.country,
      lat: Number(d.lat),
      lon: Number(d.lon)
    };
    if (!dest.id || !dest.name || !Number.isFinite(dest.lat) || !Number.isFinite(dest.lon)) continue;
    if (excludeIds.has(dest.id)) continue;

    // anti “sei già lì”
    if (originNorm && normName(dest.name) === originNorm) continue;

    const kmToDest = haversineKm(originObj.lat, originObj.lon, dest.lat, dest.lon);
    if (kmToDest < 35) continue; // anti Verona->Verona

    const route = buildRoute({ mode, origin: originObj, dest, airports, stations });
    if (!route) continue;

    if (route.totalMinutes <= minutes) {
      const oh = route.originHub?.code || route.originHub?.name || "";
      const dh = route.destinationHub?.code || route.destinationHub?.name || "";
      if (norm(oh) && norm(dh) && norm(oh) === norm(dh)) continue; // stesso hub

      out.push({
        id: dest.id,
        name: `${dest.name}${dest.country ? `, ${dest.country}` : ""}`,
        country: dest.country || "",
        type: "trasporto",
        visibility: style === "gems" ? "chicca" : "conosciuta",
        lat: dest.lat,
        lng: dest.lon,
        distance_km: kmToDest,
        eta_min: route.totalMinutes,
        originHub: route.originHub,
        destinationHub: route.destinationHub,
        segments: route.segments,
        summary: `${mode.toUpperCase()}: ${oh} → ${dh} • ${route.totalMinutes} min`,
        why: [
          `Arrivi entro ${minutes} min (stima realistica).`,
          style === "gems" ? "Sto privilegiando mete più “da chicca” (meno mainstream)." : "Sto privilegiando mete più conosciute e “sicure”.",
          `Hub: ${oh} → ${dh}`
        ],
        what_to_do: [],
        what_to_eat: []
      });
    }
  }

  // scoring: vicino al target + un po’ di preferenza per non troppo lontano
  out.forEach(p => {
    const tScore = clamp(1 - (Math.abs(p.eta_min - minutes) / Math.max(20, minutes * 0.9)), 0, 1);
    const kScore = clamp(1 - (p.distance_km / 1800), 0, 1);
    p._score = (0.65 * tScore) + (0.35 * kScore);
  });
  out.sort((a,b)=>b._score - a._score);

  return out.slice(0, 25);
}

/* -------------------------
   Output formatter
------------------------- */
function outPlace(p) {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    visibility: p.visibility,
    lat: p.lat,
    lng: p.lng,
    eta_min: Math.round(Number(p.eta_min) || 0),
    distance_km: Math.round(Number(p.distance_km) || 0),

    // PT details (if any)
    originHub: p.originHub || null,
    destinationHub: p.destinationHub || null,
    segments: Array.isArray(p.segments) ? p.segments : [],
    summary: p.summary || null,

    why: (p.why || []).slice(0, 4),
    what_to_do: (p.what_to_do || []).slice(0, 6),
    what_to_eat: (p.what_to_eat || []).slice(0, 5),

    tags: p.tags || [],
    vibes: p.vibes || [],
    best_when: p.best_when || []
  };
}

/* =========================
   HANDLER
========================= */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const body = req.body || {};
    const origin = body.origin || {};
    const minutes = Number(body.minutes);
    const mode = canonicalMode(body.mode || "car");
    const style = norm(body.style || "known"); // known | gems
    const categoryRaw = body.category ?? "citta_borghi";
    const allowedTypes = allowedTypesFromCategory(categoryRaw);
    const excludeIds = new Set(Array.isArray(body.excludeIds) ? body.excludeIds : []);

    const oLat = Number(origin.lat);
    const oLon = Number(origin.lon);
    if (!Number.isFinite(oLat) || !Number.isFinite(oLon)) {
      return res.status(400).json({ error: "origin must be {lat, lon}", got: origin });
    }
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return res.status(400).json({ error: "minutes must be a positive number" });
    }

    const originLabel = origin.label || "";
    const originObj = { lat: oLat, lon: oLon, label: originLabel };

    /* ========= PUBLIC TRANSPORT ========= */
    if (mode === "plane" || mode === "train" || mode === "bus") {
      const candidates = buildPlanCandidates({
        originObj,
        minutes,
        mode,
        style,
        excludeIds,
        originLabel
      });

      if (!candidates.length) {
        return res.status(200).json({
          ok: true,
          top: null,
          alternatives: [],
          message: "Nessuna meta trovata con questo mezzo e tempo. Aumenta i minuti.",
          debug: { minutes, mode, style }
        });
      }

      const top = candidates[0];
      const alts = candidates.slice(1, 3);

      return res.status(200).json({
        ok: true,
        top: outPlace(top),
        alternatives: alts.map(outPlace),
        debug: {
          minutes, mode, style,
          source: "plan_local_json",
          count: candidates.length
        }
      });
    }

    /* ========= AUTO / WALK / BIKE ========= */
    const categoryMain =
      allowedTypes.includes("mare") ? "mare" :
      allowedTypes.includes("montagna") ? "montagna" :
      allowedTypes.includes("natura") ? "natura" :
      allowedTypes.includes("relax") ? "relax" :
      allowedTypes.includes("bambini") ? "bambini" :
      (allowedTypes.includes("citta") && allowedTypes.includes("borgo")) ? "citta_borghi" :
      allowedTypes.includes("borgo") ? "borgo" :
      allowedTypes.includes("citta") ? "citta" :
      (allowedTypes[0] || "citta_borghi");

    const { hardCapMin, hardCapKm } = hardCaps(minutes, mode);

    // 1) curated baseline
    const curated = readJsonFromPublicData("curated.json");
    const curatedPlaces = Array.isArray(curated?.places) ? curated.places : [];

    let curatedCandidates = curatedPlaces
      .map(p => ({
        ...p,
        type: norm(p.type),
        visibility: norm(p.visibility),
        lat: Number(p.lat),
        lng: Number(p.lng)
      }))
      .filter(p =>
        p.id && p.name &&
        Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
        !excludeIds.has(p.id)
      )
      .filter(p => {
        // categoria stretta: mare = solo mare (mai Milano)
        if (categoryMain === "mare") return norm(p.type) === "mare";
        // combo/singoli
        return allowedTypes.includes(norm(p.type));
      })
      .map(p => enrichPlace(p, categoryMain, style, originObj, minutes, mode))
      .filter(p => {
        if (originLabel && isSamePlace(p.name, originLabel)) return false;
        if (p.distance_km < 2) return false;
        // HARD CAPS
        if (p.eta_min > hardCapMin) return false;
        if (p.distance_km > hardCapKm) return false;
        return true;
      });

    // 2) OSM fallback (serve per “30/45 min ovunque”)
    const radiusKm = pickRadiusKm(minutes, mode);

    let osmCandidates = [];
    const needFallback = curatedCandidates.length < 3;

    if (needFallback) {
      const q = overpassQueryFor(categoryMain, originObj.lat, originObj.lon, radiusKm, style);

      try {
        const data = await overpass(q);
        const els = Array.isArray(data?.elements) ? data.elements : [];

        osmCandidates = els
          .map(osmElementToPlace)
          .filter(Boolean)
          .filter(p => !excludeIds.has(p.id))
          .map(p => enrichPlace(p, categoryMain, style, originObj, minutes, mode))
          .filter(p => {
            if (originLabel && isSamePlace(p.name, originLabel)) return false;
            if (p.distance_km < 2) return false;

            // categoria mare blindata anche qui
            if (categoryMain === "mare" && norm(p.type) !== "mare") return false;

            // HARD CAPS sempre
            if (p.eta_min > hardCapMin) return false;
            if (p.distance_km > hardCapKm) return false;

            return true;
          });
      } catch (e) {
        // Overpass down/timeout → non crashare
        osmCandidates = [];
      }
    }

    // 3) merge + de-dup
    const mergedMap = new Map();
    for (const p of [...curatedCandidates, ...osmCandidates]) {
      if (!p?.id) continue;
      if (mergedMap.has(p.id)) continue;
      mergedMap.set(p.id, p);
    }
    let merged = [...mergedMap.values()];

    // se mare e non trovi nulla: NON cambiare categoria, restituisci messaggio chiaro
    if (categoryMain === "mare" && !merged.length) {
      return res.status(200).json({
        ok: true,
        top: null,
        alternatives: [],
        message: "Non trovo mare vicino entro il tempo scelto. Aumenta i minuti oppure cambia categoria.",
        debug: { minutes, mode, style, categoryMain, radiusKm: Math.round(radiusKm) }
      });
    }

    if (!merged.length) {
      return res.status(200).json({
        ok: true,
        top: null,
        alternatives: [],
        message: "Nessuna meta trovata: prova ad aumentare i minuti o cambia categoria.",
        debug: { minutes, mode, style, categoryMain, radiusKm: Math.round(radiusKm) }
      });
    }

    // 4) score + sort
    merged.forEach(p => { p._score = scorePlace(p, originObj, minutes, style, categoryMain); });
    merged.sort((a, b) => b._score - a._score);

    const top = merged[0];

    // alternatives: evita nome uguale
    const usedNames = new Set([normName(top.name)]);
    const alternatives = [];
    for (const c of merged.slice(1)) {
      if (alternatives.length >= 2) break;
      const n = normName(c.name);
      if (usedNames.has(n)) continue;
      usedNames.add(n);
      alternatives.push(c);
    }
    // se ancora poche, prendi comunque (ma non 0)
    if (alternatives.length < 2) {
      for (const c of merged.slice(1)) {
        if (alternatives.length >= 2) break;
        if (!alternatives.find(x => x.id === c.id)) alternatives.push(c);
      }
    }

    return res.status(200).json({
      ok: true,
      top: outPlace(top),
      alternatives: alternatives.map(outPlace),
      debug: {
        minutes, mode, style,
        categoryMain,
        allowedTypes,
        hardCapMin: Math.round(hardCapMin),
        hardCapKm: Math.round(hardCapKm),
        radiusKm: Math.round(radiusKm),
        curatedCount: curatedCandidates.length,
        osmCount: osmCandidates.length
      }
    });
  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
      hint: "Controlla che public/data/curated.json e i file hubs/destinations esistano. Overpass può andare in timeout: è gestito.",
      debug: { cwd: process.cwd() }
    });
  }
      }
