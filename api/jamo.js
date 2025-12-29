// /api/jamo.js — ONE API (Hobby-friendly) ✅
// - Auto/Walk/Bike: OSM (Overpass) FIRST -> trova SEMPRE mete vicine
// - Plane/Train/Bus: dataset hub (public/data) + stima route + hub/segmenti
// - Curated enrichment: se matcha, usa why / what_to_do / what_to_eat
// - Hard cap tempo: niente mete assurde fuori scala
// POST {
//   origin:{lat,lon,label?},
//   minutes:number,
//   mode:"car"|"walk"|"bike"|"train"|"bus"|"plane",
//   style:"known"|"gems",
//   category:string,
//   excludeIds?:string[],
//   limit?:number
// }

import fs from "fs";
import path from "path";

function readJsonFromPublicData(filename) {
  const p = path.join(process.cwd(), "public", "data", filename);
  return JSON.parse(fs.readFileSync(p, "utf8"));
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

function avgSpeedKmh(mode) {
  if (mode === "walk") return 4.2;
  if (mode === "bike") return 14;
  return 70; // car default
}

function estimateEtaMinutes(origin, lat, lon, mode) {
  const km = haversineKm(origin.lat, origin.lon, lat, lon);
  const speed = avgSpeedKmh(mode);
  const eta = (km / speed) * 60;
  return { km, eta };
}

function hardCaps(minutes, mode) {
  const m = canonicalMode(mode);
  // cap tempo: non oltre (minutes * factor)
  const factor =
    m === "walk" ? 1.15 :
    m === "bike" ? 1.25 :
    1.35; // car
  const hardCapMin = Math.max(8, minutes * factor);

  // cap km coerente (haversine sottostima strade)
  const speed = avgSpeedKmh(m === "walk" || m === "bike" ? m : "car");
  const hardCapKm = (speed * (minutes / 60)) * 1.7;

  return { hardCapMin, hardCapKm };
}

function buildIdFromOSM(name, lat, lon, kind = "osm") {
  const base = normName(name).slice(0, 64).replace(/\s+/g, "_");
  const a = Number.isFinite(lat) ? lat.toFixed(4) : "x";
  const o = Number.isFinite(lon) ? lon.toFixed(4) : "y";
  return `${kind}_${base}_${a}_${o}`;
}

/* -------------------------
   Overpass (OSM) — server-side
------------------------- */
async function overpass(query) {
  const url = "https://overpass-api.de/api/interpreter";
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "data=" + encodeURIComponent(query)
  });

  const txt = await r.text();
  if (!r.ok) throw new Error(`Overpass ${r.status}: ${txt.slice(0, 140)}`);

  try { return JSON.parse(txt); }
  catch { throw new Error(`Overpass non-JSON: ${txt.slice(0, 140)}`); }
}

function overpassQuery(category, style, lat, lon, radiusKm) {
  const r = Math.round(radiusKm * 1000);

  // IMPORTANT: "mare" non deve MAI tornare città inland
  if (category === "mare") {
    return `
      [out:json][timeout:25];
      (
        node(around:${r},${lat},${lon})["natural"="beach"]["name"];
        way(around:${r},${lat},${lon})["natural"="beach"]["name"];
        node(around:${r},${lat},${lon})["tourism"="beach_resort"]["name"];
        way(around:${r},${lat},${lon})["tourism"="beach_resort"]["name"];
      );
      out center 80;
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
        node(around:${r},${lat},${lon})["natural"="spring"]["name"];
        node(around:${r},${lat},${lon})["leisure"="park"]["name"];
        way(around:${r},${lat},${lon})["leisure"="park"]["name"];
        node(around:${r},${lat},${lon})["tourism"="viewpoint"]["name"];
        way(around:${r},${lat},${lon})["tourism"="viewpoint"]["name"];
      );
      out center 150;
    `;
  }

  if (category === "relax") {
    return `
      [out:json][timeout:25];
      (
        node(around:${r},${lat},${lon})["amenity"="spa"]["name"];
        way(around:${r},${lat},${lon})["amenity"="spa"]["name"];
        node(around:${r},${lat},${lon})["natural"="hot_spring"]["name"];
        node(around:${r},${lat},${lon})["leisure"="park"]["name"];
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
        node(around:${r},${lat},${lon})["leisure"="park"]["name"];
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
          node(around:${r},${lat},${lon})["historic"~"castle|ruins"]["name"];
          node(around:${r},${lat},${lon})["tourism"="viewpoint"]["name"];
          way(around:${r},${lat},${lon})["tourism"="viewpoint"]["name"];
          node(around:${r},${lat},${lon})["tourism"="attraction"]["name"];
        );
        out center 150;
      `;
    }
    // known
    return `
      [out:json][timeout:25];
      (
        node(around:${r},${lat},${lon})["place"~"city|town"]["name"];
      );
      out center 120;
    `;
  }

  // fallback generale
  return `
    [out:json][timeout:25];
    (
      node(around:${r},${lat},${lon})["tourism"="attraction"]["name"];
      node(around:${r},${lat},${lon})["tourism"="viewpoint"]["name"];
      way(around:${r},${lat},${lon})["tourism"="viewpoint"]["name"];
      node(around:${r},${lat},${lon})["leisure"="park"]["name"];
      way(around:${r},${lat},${lon})["leisure"="park"]["name"];
    );
    out center 140;
  `;
}

function osmTypeFromTags(tags) {
  const t = tags || {};
  if (t.natural === "beach" || t.tourism === "beach_resort") return "mare";
  if (t.natural === "peak") return "montagna";
  if (t.amenity === "spa" || t.natural === "hot_spring") return "relax";
  if (t.tourism === "theme_park" || t.leisure === "playground") return "bambini";
  if (t.place === "city" || t.place === "town") return "citta";
  if (t.place === "village" || t.place === "hamlet") return "borgo";
  return "natura";
}

function placeRank(tags) {
  const p = tags?.place;
  if (p === "city") return 3;
  if (p === "town") return 2;
  if (p === "village") return 1;
  if (p === "hamlet") return 0;
  return 1; // default “medio”
}

function osmToPlace(el, mainCategory) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags["name:en"];
  if (!name) return null;

  let lat = el.lat, lon = el.lon;
  if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && el.center) {
    lat = el.center.lat;
    lon = el.center.lon;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const inferred = osmTypeFromTags(tags);

  // sicurezza mare: solo mare vero
  if (mainCategory === "mare" && inferred !== "mare") return null;

  return {
    id: buildIdFromOSM(name, lat, lon, "osm"),
    name,
    country: "",
    type: inferred,
    visibility: "chicca",
    lat,
    lng: lon,
    _rank: placeRank(tags),
    _tags: tags
  };
}

/* -------------------------
   Curated enrichment
------------------------- */
function curatedIndex(curatedPlaces) {
  const byId = new Map();
  const byNameCountry = new Map();
  for (const p of curatedPlaces) {
    if (p?.id) byId.set(p.id, p);
    const key = `${normName(p?.name)}|${norm(p?.country)}`;
    if (p?.name) byNameCountry.set(key, p);
  }
  return { byId, byNameCountry };
}

function enrichFromCurated(base, curatedHit, category, style, etaMin) {
  const out = { ...base };

  if (curatedHit) {
    out.country = curatedHit.country || out.country || "";
    out.type = norm(curatedHit.type) || out.type;
    out.visibility = norm(curatedHit.visibility) || out.visibility;

    out.tags = Array.isArray(curatedHit.tags) ? curatedHit.tags : [];
    out.vibes = Array.isArray(curatedHit.vibes) ? curatedHit.vibes : [];
    out.best_when = Array.isArray(curatedHit.best_when) ? curatedHit.best_when : [];

    out.why = Array.isArray(curatedHit.why) ? curatedHit.why : [];
    out.what_to_do = Array.isArray(curatedHit.what_to_do) ? curatedHit.what_to_do : [];
    out.what_to_eat = Array.isArray(curatedHit.what_to_eat) ? curatedHit.what_to_eat : [];
    return out;
  }

  // fallback copy “smart”
  const why = [];
  const cat = category;

  if (cat === "mare") why.push("Hai scelto mare: spiaggia/costa vera, niente città inland.");
  else if (cat === "montagna") why.push("Hai scelto montagna: panorama e aria pulita senza complicarti la vita.");
  else if (cat === "natura") why.push("Hai scelto natura: verde + passeggiata facile a portata di tempo.");
  else if (cat === "relax") why.push("Hai scelto relax: spot perfetto per staccare e ricaricare.");
  else if (cat === "bambini") why.push("Hai scelto kids: posto semplice, zero stress.");
  else why.push(style === "gems" ? "Chicca vicina: meno caos, più atmosfera." : "Scelta solida: facile e senza sbatti.");

  if (Number.isFinite(etaMin)) why.push(`Coerente col tempo: circa ${Math.round(etaMin)} min (stima).`);

  out.why = why.slice(0, 4);

  // do/eat generic
  out.what_to_do = (cat === "mare")
    ? ["Passeggiata sul lungomare", "Tramonto", "Gelato/aperitivo vista", "Relax in spiaggia"]
    : (cat === "montagna")
      ? ["Belvedere / viewpoint", "Passeggiata breve", "Caffè panoramico", "Foto"]
      : (cat === "relax")
        ? ["Parco e camminata lenta", "Spa/terme se disponibili", "Cena tranquilla", "Stop telefonino 1 ora"]
        : (cat === "bambini")
          ? ["Parco giochi / parco", "Attività semplice", "Merenda facile", "Passeggiata breve"]
          : ["Passeggiata nel centro", "Punto panoramico", "Caffè", "Giretto senza fretta"];

  out.what_to_eat = (cat === "mare")
    ? ["Pesce / fritto", "Gelato", "Aperitivo", "Dolce locale"]
    : ["Specialità locale", "Dolce tipico", "Aperitivo", "Qualcosa di caldo se fa freddo"];

  return out;
}

/* -------------------------
   Scoring (OSM / Curated)
------------------------- */
function scorePlace(p, minutes, style, mainCategory) {
  const eta = p.eta_min;
  const km = p.distance_km;

  // vicino e coerente col tempo
  const timeFit = clamp(1 - (Math.abs(eta - minutes) / Math.max(18, minutes * 0.9)), 0, 1);
  const nearFit = clamp(1 - (eta / Math.max(20, minutes * 1.25)), 0, 1);

  // gems: preferisci piccoli (rank basso) e chicca
  const rank = Number.isFinite(p._rank) ? p._rank : 1;
  const smallBonus = style === "gems" ? clamp(1 - (rank / 3), 0, 1) : clamp(rank / 3, 0, 1);

  // mare: bonus se davvero mare e vicino (già filtrato) — ok
  const catBonus = mainCategory === "mare" && norm(p.type) === "mare" ? 0.08 : 0;

  const vis = norm(p.visibility);
  const styleBoost =
    style === "gems"
      ? (vis === "chicca" ? 1 : 0.85)
      : (vis === "conosciuta" ? 1 : 0.9);

  // penalità se troppo lontano (anti “Parigi in auto” anche se qualcosa sfugge)
  const tooFarPenalty = eta > minutes * 1.35 ? 0.35 : 0;

  return (0.46 * nearFit) + (0.28 * timeFit) + (0.18 * styleBoost) + (0.08 * smallBonus) + catBonus - tooFarPenalty;
}

/* -------------------------
   Public transport engine (dataset hubs)
------------------------- */
function nearestHub(hubs, lat, lon) {
  let best = null, bestKm = Infinity;
  for (const h of hubs) {
    const hLat = Number(h.lat);
    const hLon = Number(h.lon);
    if (!Number.isFinite(hLat) || !Number.isFinite(hLon)) continue;
    const km = haversineKm(lat, lon, hLat, hLon);
    if (km < bestKm) { bestKm = km; best = h; }
  }
  return { hub: best, km: bestKm };
}
function estAccessMinutes(km, speedKmh, minM = 10, maxM = 240) {
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
  return 9999;
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

    const oh = oA.hub.code || oA.hub.name;
    const dh = dA.hub.code || dA.hub.name;

    // evita “Verona -> Verona”
    if (norm(oh) && norm(dh) && norm(oh) === norm(dh)) return null;

    return {
      originHub: { ...oA.hub },
      destinationHub: { ...dA.hub },
      segments: [
        { kind: "access", label: `Verso ${oA.hub.name} (${oA.hub.code || "?"})`, minutes: accessMin },
        { kind: "main", label: `Volo ${(oA.hub.code || "?")} → ${(dA.hub.code || "?")}`, minutes: flightMin },
        { kind: "egress", label: `Dall’aeroporto a ${dest.name}`, minutes: egressMin }
      ],
      totalMinutes
    };
  }

  // train/bus: stazioni
  const oS = nearestHub(stations, oLat, oLon);
  const dS = nearestHub(stations, dLat, dLon);
  if (!oS.hub || !dS.hub) return null;

  const accessMin = estAccessMinutes(oS.km, 35, 8, 160);
  const mainKm = haversineKm(oS.hub.lat, oS.hub.lon, dS.hub.lat, dS.hub.lon);
  const mainMin = estMainMinutes(mode, mainKm);
  const egressMin = estAccessMinutes(dS.km, 30, 6, 160);
  const totalMinutes = accessMin + mainMin + egressMin;

  const oh = oS.hub.code || oS.hub.name;
  const dh = dS.hub.code || dS.hub.name;
  if (norm(oh) && norm(dh) && norm(oh) === norm(dh)) return null;

  return {
    originHub: { ...oS.hub },
    destinationHub: { ...dS.hub },
    segments: [
      { kind: "access", label: `Verso ${oS.hub.name}`, minutes: accessMin },
      { kind: "main", label: `${mode === "train" ? "Treno" : "Bus"} ${oS.hub.name} → ${dS.hub.name}`, minutes: mainMin },
      { kind: "egress", label: `Dalla stazione a ${dest.name}`, minutes: egressMin }
    ],
    totalMinutes
  };
}

function transportBookingLinks({ mode, originLabel, destName }) {
  const o = encodeURIComponent(originLabel || "");
  const d = encodeURIComponent(destName || "");
  // Placeholder: tu dopo ci metti affiliate veri
  if (mode === "plane") {
    return [
      { kind: "buy", label: "✈️ Cerca voli (affiliate)", url: `https://example.com/flights?from=${o}&to=${d}` }
    ];
  }
  if (mode === "train") {
    return [
      { kind: "buy", label: "🚆 Cerca treni (affiliate)", url: `https://example.com/trains?from=${o}&to=${d}` }
    ];
  }
  if (mode === "bus") {
    return [
      { kind: "buy", label: "🚌 Cerca bus (affiliate)", url: `https://example.com/bus?from=${o}&to=${d}` }
    ];
  }
  return [];
}

/* -------------------------
   Handler
------------------------- */
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
    const limit = clamp(Number(body.limit) || 20, 6, 30);

    const oLat = Number(origin.lat);
    const oLon = Number(origin.lon);
    const originLabel = origin.label || "";

    if (!Number.isFinite(oLat) || !Number.isFinite(oLon)) {
      return res.status(400).json({ error: "origin must be {lat, lon}", got: origin });
    }
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return res.status(400).json({ error: "minutes must be positive number" });
    }

    const originObj = { lat: oLat, lon: oLon, label: originLabel };
    const mainCategory = (() => {
      if (allowedTypes.includes("mare")) return "mare";
      if (allowedTypes.includes("montagna")) return "montagna";
      if (allowedTypes.includes("natura")) return "natura";
      if (allowedTypes.includes("relax")) return "relax";
      if (allowedTypes.includes("bambini")) return "bambini";
      if (allowedTypes.includes("citta") && allowedTypes.includes("borgo")) return "citta_borghi";
      if (allowedTypes.includes("citta")) return "citta";
      if (allowedTypes.includes("borgo")) return "borgo";
      return "citta_borghi";
    })();

    // Load curated
    const curated = readJsonFromPublicData("curated.json");
    const curatedPlaces = Array.isArray(curated?.places) ? curated.places : [];
    const idx = curatedIndex(curatedPlaces);

    /* =========================
       PUBLIC TRANSPORT (plane/train/bus)
       -> usa dataset hubs + destinations
    ========================= */
    if (mode === "plane" || mode === "train" || mode === "bus") {
      const airports = readJsonFromPublicData("curated_airports_eu_uk.json");
      const stations = readJsonFromPublicData("curated_stations_eu_uk.json");
      const destinations = readJsonFromPublicData("curated_destinations_eu_uk.json");

      if (!Array.isArray(airports) || !Array.isArray(stations) || !Array.isArray(destinations)) {
        return res.status(500).json({ error: "Hubs/destinations JSON must be arrays in public/data" });
      }

      // build candidates
      const list = [];
      for (const d of destinations) {
        const dest = {
          id: d.id || buildIdFromOSM(d.name, Number(d.lat), Number(d.lon), "dest"),
          name: d.name,
          country: d.country || "",
          lat: Number(d.lat),
          lon: Number(d.lon)
        };
        if (!dest.name || !Number.isFinite(dest.lat) || !Number.isFinite(dest.lon)) continue;
        if (excludeIds.has(dest.id)) continue;

        // anti “sei già lì”
        const kmToDest = haversineKm(originObj.lat, originObj.lon, dest.lat, dest.lon);
        if (kmToDest < 35) continue;

        const route = buildRoute({
          mode,
          origin: originObj,
          dest,
          airports,
          stations
        });
        if (!route) continue;

        // hard cap: NON oltre troppo (per evitare assurdità)
        const cap = minutes * 1.35;
        if (route.totalMinutes > cap) continue;

        const nameFull = `${dest.name}${dest.country ? `, ${dest.country}` : ""}`;
        const { km } = estimateEtaMinutes(originObj, dest.lat, dest.lon, "car"); // solo per info distanza

        // prova a matchare curated per arricchire (name+country)
        const curatedHit = idx.byNameCountry.get(`${normName(dest.name)}|${norm(dest.country)}`) || null;

        const base = {
          id: dest.id,
          name: nameFull,
          country: dest.country,
          type: curatedHit ? norm(curatedHit.type) : "citta",
          visibility: style === "gems" ? "chicca" : "conosciuta",
          lat: dest.lat,
          lng: dest.lon,
          eta_min: route.totalMinutes,
          distance_km: km,
          hubSummary: `${route.originHub.code || route.originHub.name} → ${route.destinationHub.code || route.destinationHub.name}`,
          segments: route.segments,
          booking_links: transportBookingLinks({ mode, originLabel, destName: dest.name }),
          _rank: curatedHit ? 2 : 2
        };

        const enriched = enrichFromCurated(base, curatedHit, mainCategory, style, base.eta_min);
        enriched._score = clamp(
          (0.70 * clamp(1 - (Math.abs(enriched.eta_min - minutes) / Math.max(25, minutes)), 0, 1)) +
          (0.30 * clamp(1 - (enriched.distance_km / 1800), 0, 1)),
          0,
          1
        );

        list.push(enriched);
      }

      list.sort((a, b) => b._score - a._score);

      const top = list[0] || null;
      const alternatives = list.slice(1, 3);

      return res.status(200).json({
        ok: true,
        top,
        alternatives,
        debug: { mode, minutes, mainCategory, candidates: list.length }
      });
    }

    /* =========================
       AUTO/WALK/BIKE
       -> OSM FIRST + curated enrichment
       -> sempre: prova radius progressivo finché trova
    ========================= */
    const { hardCapMin, hardCapKm } = hardCaps(minutes, mode);

    // radius base (vicino davvero)
    const speed = avgSpeedKmh(mode);
    const baseRadiusKm = clamp((speed * (minutes / 60)) * 1.25, mode === "walk" ? 2 : 5, 220);

    // prova progressiva (se a 30 min non trova subito, allarghiamo un filo, ma non “Parigi”)
    const radii = [
      baseRadiusKm,
      Math.min(baseRadiusKm * 1.4, 250),
      Math.min(baseRadiusKm * 1.9, 300)
    ];

    let osmPlaces = [];
    let usedRadius = radii[0];

    for (const r of radii) {
      usedRadius = r;
      const q = overpassQuery(mainCategory, style, originObj.lat, originObj.lon, r);
      const data = await overpass(q);
      const els = Array.isArray(data?.elements) ? data.elements : [];

      const mapped = els
        .map(el => osmToPlace(el, mainCategory))
        .filter(Boolean)
        .filter(p => !excludeIds.has(p.id))
        .filter(p => {
          // anti “stessa città”
          if (originLabel && normName(p.name) === normName(originLabel)) return false;
          return true;
        });

      if (mapped.length >= 6) { osmPlaces = mapped; break; }
      osmPlaces = mapped; // tieni comunque
      if (osmPlaces.length >= 3) break;
    }

    // se proprio Overpass torna poco, fallback: prova città/borghi generico (solo se non mare)
    if (osmPlaces.length < 3 && mainCategory !== "mare") {
      const q2 = overpassQuery("citta_borghi", style, originObj.lat, originObj.lon, Math.min(usedRadius * 1.2, 320));
      const data2 = await overpass(q2);
      const els2 = Array.isArray(data2?.elements) ? data2.elements : [];
      const more = els2
        .map(el => osmToPlace(el, "citta_borghi"))
        .filter(Boolean)
        .filter(p => !excludeIds.has(p.id));
      osmPlaces = [...osmPlaces, ...more];
    }

    // dedupe by name
    const nameSeen = new Set();
    const unique = [];
    for (const p of osmPlaces) {
      const key = normName(p.name);
      if (!key || nameSeen.has(key)) continue;
      nameSeen.add(key);
      unique.push(p);
    }

    // compute eta + hard caps
    let candidates = unique
      .map(p => {
        const { km, eta } = estimateEtaMinutes(originObj, p.lat, p.lng, mode);
        return { ...p, distance_km: km, eta_min: eta };
      })
      .filter(p => p.distance_km >= 1.2) // evita “sei già lì”
      .filter(p => p.distance_km <= hardCapKm * 1.15) // km hard-ish
      .filter(p => p.eta_min <= hardCapMin * 1.20);   // tempo hard-ish

    // se ancora poco, rilassa SOLO un filo il cap tempo (ma mai oltre x1.65)
    if (candidates.length < 3) {
      const softCap = minutes * 1.65;
      candidates = unique
        .map(p => {
          const { km, eta } = estimateEtaMinutes(originObj, p.lat, p.lng, mode);
          return { ...p, distance_km: km, eta_min: eta };
        })
        .filter(p => p.distance_km >= 1.2)
        .filter(p => p.eta_min <= softCap);
    }

    // category strict: mare SOLO mare (già filtrato, ma doppia sicurezza)
    if (mainCategory === "mare") {
      candidates = candidates.filter(p => norm(p.type) === "mare");
    }

    // enrichment: prova match curated (solo se esiste)
    const enriched = candidates
      .slice(0, limit)
      .map(p => {
        const curatedHit = idx.byNameCountry.get(`${normName(p.name)}|`) || null; // country spesso mancante OSM
        const base = {
          ...p,
          type: norm(p.type),
          visibility: "chicca",
          tags: [],
          vibes: [],
          best_when: [],
          why: [],
          what_to_do: [],
          what_to_eat: []
        };
        const e = enrichFromCurated(base, curatedHit, mainCategory, style, p.eta_min);
        e._score = scorePlace({ ...e, _rank: p._rank }, minutes, style, mainCategory);
        return e;
      });

    enriched.sort((a, b) => b._score - a._score);

    const top = enriched[0] || null;

    // alternatives: diverse per nome
    const alts = [];
    const used = new Set(top ? [normName(top.name)] : []);
    for (const c of enriched.slice(1)) {
      if (alts.length >= 2) break;
      const k = normName(c.name);
      if (used.has(k)) continue;
      used.add(k);
      alts.push(c);
    }
    // fallback: se alts <2, prendi comunque
    if (alts.length < 2) {
      for (const c of enriched.slice(1)) {
        if (alts.length >= 2) break;
        if (!alts.find(x => x.id === c.id)) alts.push(c);
      }
    }

    return res.status(200).json({
      ok: true,
      top,
      alternatives: alts,
      debug: {
        mode, minutes, mainCategory,
        radiusKmUsed: Math.round(usedRadius),
        hardCapMin: Math.round(hardCapMin),
        hardCapKm: Math.round(hardCapKm),
        found: enriched.length
      }
    });

  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
      hint: "Se Overpass va lento: riprova. È un servizio pubblico e può throttling."
    });
  }
                                              }
