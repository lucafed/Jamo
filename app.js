/* Jamo app.js v3.0
   Modes:
   - car / walk / bike : come prima (ORS isochrone <=60, fallback destination)
   - train / bus / plane: intermodale gratuito e plausibile:
       auto -> hub (stazione/autostazione/aeroporto) + buffer + tratta stimata + auto -> destinazione
   Style:
   - known: più conosciuti
   - hidden: chicche (validate con POI)
*/

const UI = {
  timeSelect: document.getElementById("timeSelect"),
  modeSelect: document.getElementById("modeSelect"),
  styleSelect: document.getElementById("styleSelect"),
  goBtn: document.getElementById("goBtn"),
  status: document.getElementById("status"),
  result: document.getElementById("result"),
  placeName: document.getElementById("placeName"),
  placeMeta: document.getElementById("placeMeta"),
  mapsLink: document.getElementById("mapsLink"),
  visitedBtn: document.getElementById("visitedBtn"),
  altList: document.getElementById("altList"),
  footerInfo: document.getElementById("footerInfo"),
};

const APP_VERSION = "3.0";
const VISITED_KEY = "jamo_visited_v1";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];

const ORS_MAX_RANGE_SEC = 3600;

// ORS profiles only for walk/bike/car directions/iso
const MODE_TO_ORS_PROFILE = {
  car: "driving-car",
  walk: "foot-walking",
  bike: "cycling-regular",
};

// labels
const MODE_LABEL = {
  car: "Auto",
  walk: "A piedi",
  bike: "Bici",
  train: "Treno",
  bus: "Bus",
  plane: "Aereo",
};

const STYLE_LABEL = {
  known: "Più conosciuti",
  hidden: "Chicche",
};

// fallback speeds (km/h) for rough distance->time if ORS directions not available
const SPEED_KMH = {
  car: 65,
  walk: 4.5,
  bike: 16,
  train: 95,
  bus: 60,
  plane: 750,
};

// intermodal buffers (minutes)
const BUFFERS_MIN = {
  train: 18,  // arrivare prima / attesa
  bus: 12,
  plane: 95,  // check-in + sicurezza
};

// minimal “flight viability”: se troppo vicino, meglio evitare
const MIN_FLIGHT_DISTANCE_KM = 120;

// ---------------- UI helpers ----------------
function setStatus(msg, type = "") {
  UI.status.textContent = msg;
  UI.status.className = "status" + (type ? " " + type : "");
}

function showResult(show) {
  UI.result.classList.toggle("hidden", !show);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[m]));
}

function fmtMinutes(min) {
  if (!isFinite(min)) return "—";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

function formatDistanceKm(meters) {
  const km = meters / 1000;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

function googleMapsLink(lat, lon, label) {
  const q = encodeURIComponent(label ? `${label} (${lat},${lon})` : `${lat},${lon}`);
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const toRad = (x) => (x * Math.PI) / 180;
  const a =
    Math.sin((toRad(lat2 - lat1)) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin((toRad(lon2 - lon1)) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function kmFromMeters(m) { return m / 1000; }

// ---------------- visited ----------------
function loadVisitedSet() {
  try {
    const raw = localStorage.getItem(VISITED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveVisitedSet(set) {
  try { localStorage.setItem(VISITED_KEY, JSON.stringify([...set])); } catch {}
}

function placeId(p) {
  return `${p.osmType}:${p.osmId}`;
}

// ---------------- fetch helpers ----------------
async function fetchJson(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const txt = await res.text();
    let data;
    try { data = JSON.parse(txt); } catch { data = txt; }
    if (!res.ok) {
      const err = new Error(typeof data === "string" ? data : JSON.stringify(data));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

async function overpassQuery(query) {
  let lastErr = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const data = await fetchJson(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: "data=" + encodeURIComponent(query),
      }, 25000);
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Overpass failed");
}

// ---------------- GPS ----------------
function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocalizzazione non supportata"));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        acc: pos.coords.accuracy,
      }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  });
}

// ---------------- ORS APIs on Vercel ----------------
async function getIsochroneORS({ lat, lon, mode, minutes }) {
  const profile = MODE_TO_ORS_PROFILE[mode] || "driving-car";
  const seconds = Math.round(minutes * 60);
  const payload = { profile, locations: [[lon, lat]], range: [seconds] };
  return fetchJson("/api/isochrone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, 25000);
}

async function getDirectionsDurationSec({ from, to, mode }) {
  // for intermodal first/last mile ALWAYS car (as you requested)
  const profile = MODE_TO_ORS_PROFILE[mode] || "driving-car";
  try {
    const data = await fetchJson("/api/directions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile,
        coordinates: [
          [from.lon, from.lat],
          [to.lon, to.lat],
        ],
      }),
    }, 25000);

    const sec = data?.features?.[0]?.properties?.summary?.duration;
    return (typeof sec === "number" && isFinite(sec)) ? sec : null;
  } catch {
    return null;
  }
}

// ---------------- iso bbox ----------------
function bboxFromGeoJSON(geojson) {
  const feat = geojson?.features?.[0];
  const geom = feat?.geometry;
  if (!geom) return null;

  const coords = geom.type === "Polygon"
    ? geom.coordinates
    : (geom.type === "MultiPolygon" ? geom.coordinates.flat() : null);

  if (!coords) return null;

  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const ring of coords) {
    for (const [lon, lat] of ring) {
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
    }
  }
  return { minLat, minLon, maxLat, maxLon };
}

// ---------------- places ----------------
function isPlaceElement(el) {
  const place = el.tags?.place;
  return ["city", "town", "village", "hamlet", "suburb", "neighbourhood"].includes(place);
}

function elementToPlace(el) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags["int_name"];
  if (!name) return null;

  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return null;

  const pop = parseInt(tags.population || "0", 10);
  const isKnown = Boolean(tags.wikipedia || tags.wikidata);

  return {
    osmType: el.type,
    osmId: el.id,
    name,
    lat, lon,
    place: tags.place || "place",
    population: Number.isFinite(pop) ? pop : 0,
    isKnown,
    tags,
  };
}

function dedupePlaces(arr) {
  const seen = new Set();
  const out = [];
  for (const p of arr) {
    const key = `${p.name.toLowerCase()}_${Math.round(p.lat*1000)}_${Math.round(p.lon*1000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function scorePlace(p, origin, style) {
  const d = haversineMeters(origin.lat, origin.lon, p.lat, p.lon);
  const knownBonus = p.isKnown ? 80 : 0;
  const popBonus = Math.min(40, Math.log10((p.population || 0) + 10) * 12);
  const tooClosePenalty = d < 3500 ? 45 : 0;

  let styleBias = 0;
  if (style === "known") styleBias = knownBonus + 8;
  if (style === "hidden") styleBias = p.isKnown ? -60 : 18;

  return (knownBonus + popBonus + styleBias) - tooClosePenalty + (Math.random() * 10);
}

function pickMainAndAlternatives(candidates, origin, visitedSet, style) {
  const filtered = candidates.filter(p => !visitedSet.has(placeId(p)));
  const pool = filtered.length ? filtered : candidates;

  const ranked = pool
    .map(p => ({ p, score: scorePlace(p, origin, style) }))
    .sort((a, b) => b.score - a.score)
    .map(x => x.p);

  return { main: ranked[0] || null, alts: ranked.slice(1, 4) };
}

// ---------------- POI “cosa vedere” ----------------
function classifyPoi(tags) {
  const t = tags || {};
  if (t.tourism === "museum") return 9;
  if (t.historic) return 8;
  if (t.tourism === "attraction") return 7;
  if (t.natural) return 7;
  if (t.leisure) return 6;
  if (t.tourism) return 5;
  return 3;
}

async function getThingsToDo(lat, lon) {
  const radius = 6000;
  const query = `
  [out:json][timeout:18];
  (
    node(around:${radius},${lat},${lon})["tourism"];
    node(around:${radius},${lat},${lon})["historic"];
    node(around:${radius},${lat},${lon})["natural"];
    node(around:${radius},${lat},${lon})["leisure"];
    way(around:${radius},${lat},${lon})["tourism"];
    way(around:${radius},${lat},${lon})["historic"];
    way(around:${radius},${lat},${lon})["natural"];
    way(around:${radius},${lat},${lon})["leisure"];
    relation(around:${radius},${lat},${lon})["tourism"];
    relation(around:${radius},${lat},${lon})["historic"];
    relation(around:${radius},${lat},${lon})["natural"];
  );
  out tags center 80;
  `;

  const data = await overpassQuery(query);
  const els = data?.elements || [];

  const list = [];
  for (const el of els) {
    const tags = el.tags || {};
    const name = tags.name || tags["name:it"] || tags["int_name"];
    if (!name) continue;

    const lat2 = el.lat ?? el.center?.lat;
    const lon2 = el.lon ?? el.center?.lon;
    if (typeof lat2 !== "number" || typeof lon2 !== "number") continue;

    list.push({ name, rank: classifyPoi(tags), dist: haversineMeters(lat, lon, lat2, lon2) });
  }

  list.sort((a, b) => (b.rank - a.rank) || (a.dist - b.dist));

  const seen = new Set();
  const out = [];
  for (const p of list) {
    const k = p.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
    if (out.length >= 8) break;
  }
  return out;
}

// ---------------- HUBS (train/bus/plane) ----------------
function hubQuery(type, lat, lon, radiusM) {
  // pick stronger tags first
  if (type === "train") {
    return `
    [out:json][timeout:18];
    (
      node(around:${radiusM},${lat},${lon})["railway"="station"];
      node(around:${radiusM},${lat},${lon})["public_transport"="station"];
      way(around:${radiusM},${lat},${lon})["railway"="station"];
      relation(around:${radiusM},${lat},${lon})["railway"="station"];
    );
    out tags center 50;
    `;
  }
  if (type === "bus") {
    return `
    [out:json][timeout:18];
    (
      node(around:${radiusM},${lat},${lon})["amenity"="bus_station"];
      node(around:${radiusM},${lat},${lon})["highway"="bus_stop"];
      way(around:${radiusM},${lat},${lon})["amenity"="bus_station"];
    );
    out tags center 50;
    `;
  }
  // plane
  return `
  [out:json][timeout:18];
  (
    node(around:${radiusM},${lat},${lon})["aeroway"~"aerodrome|airport"];
    way(around:${radiusM},${lat},${lon})["aeroway"~"aerodrome|airport"];
    relation(around:${radiusM},${lat},${lon})["aeroway"~"aerodrome|airport"];
  );
  out tags center 50;
  `;
}

function elementToHub(el) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags["int_name"] || "Hub";
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  return { name, lat, lon };
}

async function findNearestHub(type, origin) {
  // widen search progressively
  const radii = type === "plane" ? [80000, 150000, 250000] : [30000, 60000, 120000];
  for (const r of radii) {
    const data = await overpassQuery(hubQuery(type, origin.lat, origin.lon, r));
    const hubs = (data?.elements || []).map(elementToHub).filter(Boolean);
    if (hubs.length) {
      hubs.sort((a, b) =>
        haversineMeters(origin.lat, origin.lon, a.lat, a.lon) -
        haversineMeters(origin.lat, origin.lon, b.lat, b.lon)
      );
      return hubs[0];
    }
  }
  return null;
}

async function findHubNearDestination(type, dest) {
  // small radius near destination
  const r = type === "plane" ? 60000 : 12000;
  const data = await overpassQuery(hubQuery(type, dest.lat, dest.lon, r));
  const hubs = (data?.elements || []).map(elementToHub).filter(Boolean);
  if (!hubs.length) return null;
  hubs.sort((a, b) =>
    haversineMeters(dest.lat, dest.lon, a.lat, a.lon) -
    haversineMeters(dest.lat, dest.lon, b.lat, b.lon)
  );
  return hubs[0];
}

// ---------------- core: candidates from destination.js ----------------
async function getCandidatesFromDestination(origin, radiusKm) {
  const data = await fetchJson(`/api/destination?lat=${encodeURIComponent(origin.lat)}&lon=${encodeURIComponent(origin.lon)}&radiusKm=${encodeURIComponent(radiusKm)}`, {}, 25000);

  // destination.js returns only nodes with tags
  const candidates = (data?.elements || []).map(el => {
    const tags = el.tags || {};
    const name = tags.name || tags["name:it"];
    if (!name || typeof el.lat !== "number" || typeof el.lon !== "number") return null;
    const pop = parseInt(tags.population || "0", 10);
    const isKnown = Boolean(tags.wikipedia || tags.wikidata);

    return {
      osmType: el.type || "node",
      osmId: el.id,
      name,
      lat: el.lat,
      lon: el.lon,
      place: tags.place || (tags.boundary ? "park" : tags.natural ? "natural" : "place"),
      population: Number.isFinite(pop) ? pop : 0,
      isKnown,
      tags,
    };
  }).filter(Boolean);

  return dedupePlaces(candidates).slice(0, 90);
}

// ---------------- find places (all modes) ----------------
async function findPlaces({ origin, mode, minutes, style }) {
  const visited = loadVisitedSet();
  let candidates = [];
  let used = "DESTINATION";

  // For train/bus/plane we ALWAYS use destination.js + hub filtering
  const intermodal = (mode === "train" || mode === "bus" || mode === "plane");

  if (!intermodal) {
    // car/walk/bike: try ORS isochrone <=60
    const seconds = Math.round(minutes * 60);
    if (seconds <= ORS_MAX_RANGE_SEC) {
      try {
        used = "ORS_ISOCHRONE";
        const geo = await getIsochroneORS({ lat: origin.lat, lon: origin.lon, mode, minutes });
        const bbox = bboxFromGeoJSON(geo);
        if (!bbox) throw new Error("No bbox");

        const q = `
        [out:json][timeout:22];
        (
          node(${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon})["place"~"city|town|village|hamlet|suburb|neighbourhood"];
          way(${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon})["place"~"city|town|village|hamlet|suburb|neighbourhood"];
          relation(${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon})["place"~"city|town|village|hamlet|suburb|neighbourhood"];
        );
        out tags center 140;
        `;
        const data = await overpassQuery(q);
        candidates = (data?.elements || []).filter(isPlaceElement).map(elementToPlace).filter(Boolean);
      } catch {
        candidates = [];
        used = "DESTINATION";
      }
    }

    // fallback destination
    if (!candidates.length) {
      const radiusKm = Math.max(5, Math.min(1200, Math.round((SPEED_KMH[mode] || 50) * (minutes / 60))));
      candidates = await getCandidatesFromDestination(origin, radiusKm);
    }

    // chicche validation
    if (style === "hidden") {
      const sample = candidates.slice(0, 28);
      const checked = [];
      for (const p of sample) {
        if (p.isKnown) continue;
        try {
          const pois = await getThingsToDo(p.lat, p.lon);
          if (pois.length >= 2) checked.push(p);
        } catch {
          checked.push(p);
        }
      }
      if (checked.length >= 6) candidates = checked;
    }

    const { main, alts } = pickMainAndAlternatives(candidates, origin, visited, style);
    return { used, main, alts, visited, intermodalDetails: null };
  }

  // ---------- intermodal train/bus/plane ----------
  const hubType = mode; // "train" | "bus" | "plane"

  // 1) nearest departure hub
  const depHub = await findNearestHub(hubType, origin);
  if (!depHub) {
    return { used: "NO_HUB", main: null, alts: [], visited, intermodalDetails: { reason: "No departure hub" } };
  }

  // 2) access time origin->depHub by car
  const accessSec = await getDirectionsDurationSec({ from: origin, to: depHub, mode: "car" }) ??
    estimateCarSeconds(origin, depHub);

  // 3) compute search radius based on total time (we fetch candidates broadly then filter)
  const totalMinutes = minutes;
  const approxRangeKm = Math.max(50, Math.min(1200, Math.round((SPEED_KMH[hubType] || 80) * (totalMinutes / 60) * 1.2)));
  candidates = await getCandidatesFromDestination(origin, approxRangeKm);
  used = "DESTINATION+INTERMODAL";

  // 4) filter candidates by: must have arrival hub near destination (station/bus/airport)
  //    and total travel time <= selected minutes (with buffers)
  const bufferSec = (BUFFERS_MIN[hubType] || 15) * 60;

  // For performance: only evaluate first N candidates (scored rough first)
  const roughRanked = candidates
    .map(p => ({ p, rough: scorePlace(p, origin, style) }))
    .sort((a, b) => b.rough - a.rough)
    .slice(0, 28)
    .map(x => x.p);

  const evaluated = [];

  for (const dest of roughRanked) {
    // aereo: skip too near
    if (hubType === "plane") {
      const dkm = kmFromMeters(haversineMeters(depHub.lat, depHub.lon, dest.lat, dest.lon));
      if (dkm < MIN_FLIGHT_DISTANCE_KM) continue;
    }

    const arrHub = await findHubNearDestination(hubType, dest);
    if (!arrHub) continue;

    // main leg estimate between hubs
    const mainLegSec = estimateMainLegSeconds(hubType, depHub, arrHub);

    // egress time arrHub->destination by car
    const egressSec = await getDirectionsDurationSec({ from: arrHub, to: dest, mode: "car" }) ??
      estimateCarSeconds(arrHub, dest);

    const totalSec = accessSec + bufferSec + mainLegSec + egressSec;

    // accept if within selected time (with small tolerance)
    if (totalSec <= (minutes * 60) + 12 * 60) {
      evaluated.push({
        dest,
        totalSec,
        accessSec,
        mainLegSec,
        egressSec,
        depHub,
        arrHub,
      });
    }
    if (evaluated.length >= 14) break; // enough
  }

  if (!evaluated.length) {
    return {
      used: "NO_MATCH",
      main: null,
      alts: [],
      visited,
      intermodalDetails: { depHub, accessSec, bufferSec }
    };
  }

  // sort by: known/chicche preference + closeness to time
  evaluated.sort((a, b) => {
    const aScore = scorePlace(a.dest, origin, style) - Math.abs((minutes*60) - a.totalSec) / 60;
    const bScore = scorePlace(b.dest, origin, style) - Math.abs((minutes*60) - b.totalSec) / 60;
    return bScore - aScore;
  });

  // convert to main/alts, apply visited filter
  const visitedSet = visited;
  const pool = evaluated.map(x => ({
    ...x.dest,
    _intermodal: x
  }));

  const filtered = pool.filter(p => !visitedSet.has(placeId(p)));
  const finalPool = filtered.length ? filtered : pool;

  const main = finalPool[0] || null;
  const alts = finalPool.slice(1, 4);

  return {
    used,
    main,
    alts,
    visited,
    intermodalDetails: { depHub, accessSec, bufferSec }
  };
}

// ---------------- estimators ----------------
function estimateCarSeconds(a, b) {
  const distKm = kmFromMeters(haversineMeters(a.lat, a.lon, b.lat, b.lon));
  const speed = SPEED_KMH.car;
  const factor = 1.25;
  return (distKm / speed) * 3600 * factor;
}

function estimateMainLegSeconds(type, hubA, hubB) {
  const distKm = kmFromMeters(haversineMeters(hubA.lat, hubA.lon, hubB.lat, hubB.lon));
  if (type === "plane") {
    // flight time + taxi/decollo/atterraggio
    const cruise = (distKm / SPEED_KMH.plane) * 3600;
    return cruise + (25 * 60);
  }
  if (type === "train") {
    const factor = 1.2; // rete ferroviaria / fermate
    return (distKm / SPEED_KMH.train) * 3600 * factor;
  }
  // bus
  const factor = 1.25; // deviazioni / fermate
  return (distKm / SPEED_KMH.bus) * 3600 * factor;
}

// ---------------- render ----------------
async function renderMain(main, origin, mode, minutes, used, style, visitedSet) {
  if (!main) {
    showResult(false);
    if (used === "NO_HUB") {
      setStatus("❌ Non trovo una stazione/autostazione/aeroporto vicino a te. Prova Auto oppure aumenta il tempo.", "err");
    } else if (used === "NO_MATCH") {
      setStatus("❌ Non trovo mete coerenti col tempo usando questo mezzo. Aumenta il tempo o prova un altro mezzo.", "err");
    } else {
      setStatus("❌ Non trovo mete. Prova a cambiare tempo o mezzo e riprova.", "err");
    }
    return;
  }

  showResult(true);

  const distM = haversineMeters(origin.lat, origin.lon, main.lat, main.lon);
  const kind = main.isKnown ? "⭐ più conosciuto" : "✨ chicca";
  const badgeStyle = style === "known" ? "Più conosciuti" : "Chicche";

  UI.placeName.textContent = main.name;
  UI.mapsLink.href = googleMapsLink(main.lat, main.lon, main.name);

  // compute ETA for display
  let etaMin = null;

  if (mode === "car" || mode === "walk" || mode === "bike") {
    const sec = await getDirectionsDurationSec({ from: origin, to: main, mode: mode === "car" ? "car" : mode });
    if (typeof sec === "number") etaMin = sec / 60;
    else {
      const speed = SPEED_KMH[mode] || 50;
      const factor = mode === "car" ? 1.25 : mode === "bike" ? 1.18 : 1.10;
      etaMin = (distM / 1000) / speed * 60 * factor;
    }
  } else {
    // intermodal: we attached breakdown in _intermodal
    const info = main._intermodal;
    if (info?.totalSec) etaMin = info.totalSec / 60;
  }

  const within = (etaMin != null) ? (etaMin <= minutes + 12) : true;
  const badge = within ? "✅" : "⚠️";

  UI.placeMeta.textContent =
    `${badge} ${kind}\n` +
    `Mezzo: ${MODE_LABEL[mode]}\n` +
    `Stile: ${badgeStyle}\n` +
    `Tipo: ${main.place}\n` +
    `Distanza (aria) ~ ${formatDistanceKm(distM)}\n` +
    `Tempo stimato: ${fmtMinutes(etaMin)} (scelto: ${fmtMinutes(minutes)})`;

  // If intermodal, show breakdown
  if (main._intermodal) {
    const x = main._intermodal;
    UI.placeMeta.textContent +=
      `\n\nDettaglio (porta-a-porta):\n` +
      `• Auto → hub: ${fmtMinutes(x.accessSec/60)}\n` +
      `• Attesa/controlli: ${fmtMinutes((BUFFERS_MIN[mode]||15))}\n` +
      `• Tratta ${MODE_LABEL[mode]}: ${fmtMinutes(x.mainLegSec/60)}\n` +
      `• Auto → meta: ${fmtMinutes(x.egressSec/60)}\n` +
      `Hub partenza: ${x.depHub?.name || "—"}\n` +
      `Hub arrivo: ${x.arrHub?.name || "—"}`;
  }

  // visited toggle
  const id = placeId(main);
  const already = visitedSet.has(id);
  UI.visitedBtn.textContent = already ? "✅ Già visitato (clicca per togliere)" : "✅ Segna come “già visitato”";
  UI.visitedBtn.onclick = () => {
    const v = loadVisitedSet();
    if (v.has(id)) v.delete(id); else v.add(id);
    saveVisitedSet(v);
    UI.visitedBtn.textContent = v.has(id) ? "✅ Già visitato (clicca per togliere)" : "✅ Segna come “già visitato”";
    setStatus(v.has(id) ? `Salvato: "${main.name}" è visitato.` : `Ok: "${main.name}" rimosso dai visitati.`, "ok");
  };

  // POI main
  setStatus(`✅ Trovato: ${main.name}\nCarico “cosa vedere”…`, "ok");
  try {
    const pois = await getThingsToDo(main.lat, main.lon);
    if (pois.length) {
      UI.placeMeta.textContent += `\n\nCosa vedere / fare:\n` + pois.slice(0, 6).map(p => `• ${p.name}`).join("\n");
    } else {
      UI.placeMeta.textContent += `\n\nCosa vedere / fare:\n• Centro storico\n• Passeggiata / belvedere\n• Piazza principale`;
    }
  } catch {
    UI.placeMeta.textContent += `\n\nCosa vedere / fare:\n• Centro storico\n• Passeggiata / belvedere\n• Piazza principale`;
  }

  UI.footerInfo.textContent = `Versione ${APP_VERSION} • ${MODE_LABEL[mode]} • ${STYLE_LABEL[style]} • ${used}`;
}

async function renderAlternatives(alts, origin) {
  UI.altList.innerHTML = "";
  if (!alts || !alts.length) {
    UI.altList.innerHTML = `<div class="alt-item">Nessuna alternativa trovata.</div>`;
    return;
  }

  for (let i = 0; i < alts.length; i++) {
    const a = alts[i];
    const distM = haversineMeters(origin.lat, origin.lon, a.lat, a.lon);

    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `
      <div class="name">${escapeHtml(a.name)} ${a.isKnown ? "⭐" : "✨"}</div>
      <div class="mini">Tipo: ${escapeHtml(a.place)} • distanza (aria) ~ ${formatDistanceKm(distM)}</div>
      <div style="margin-top:8px">
        <a class="linkbtn" href="${googleMapsLink(a.lat, a.lon, a.name)}" target="_blank" rel="noopener">Apri</a>
      </div>
      <div id="altPoi${i}" class="mini" style="margin-top:10px">Carico cosa vedere…</div>
    `;
    UI.altList.appendChild(div);

    try {
      const pois = await getThingsToDo(a.lat, a.lon);
      const el = document.getElementById(`altPoi${i}`);
      if (!el) continue;
      if (pois.length) {
        el.innerHTML = `<b>Cosa vedere:</b><br>` + pois.slice(0, 3).map(p => `• ${escapeHtml(p.name)}`).join("<br>");
      } else {
        el.textContent = "Cosa vedere: centro / belvedere / passeggiata.";
      }
    } catch {
      const el = document.getElementById(`altPoi${i}`);
      if (el) el.textContent = "Cosa vedere: (non disponibile ora, riprova).";
    }
  }
}

// ---------------- main click ----------------
UI.goBtn.addEventListener("click", async () => {
  UI.goBtn.disabled = true;
  showResult(false);

  const minutes = parseInt(UI.timeSelect.value, 10) || 60;
  const mode = UI.modeSelect.value || "car";
  const style = UI.styleSelect ? UI.styleSelect.value : "known";

  setStatus("📍 Prendo la posizione GPS…");
  try {
    const origin = await getCurrentPosition();
    setStatus("🔎 Cerco mete…");

    const { used, main, alts, visited } = await findPlaces({ origin, mode, minutes, style });

    await renderMain(main, origin, mode, minutes, used, style, visited);
    await renderAlternatives(alts, origin);

    setStatus("✅ Fatto. Premi di nuovo per un’altra idea.", "ok");
  } catch (e) {
    const msg = e?.data?.error || e?.message || String(e);
    setStatus(`❌ Errore: ${msg}`, "err");
  } finally {
    UI.goBtn.disabled = false;
  }
});

// init
setStatus("Pronto. Premi il bottone: Jamo userà il GPS.");
