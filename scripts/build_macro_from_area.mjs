// scripts/build_macro_from_area.mjs
// Build macro AUTO-ONLY from:
// - bbox places (public/data/bbox/<areaId>.json)
// - POIs (public/data/pois_eu_uk.json)
// - curated destinations (public/data/curated_destinations_eu_uk.json)
//
// Usage:
//   node scripts/build_macro_from_area.mjs it_abruzzo

import fs from "fs";
import path from "path";

const ROOT = process.cwd();

const AREAS_FILE = path.join(ROOT, "public/data/areas.json");
const BBOX_DIR   = path.join(ROOT, "public/data/bbox");
const POIS_FILE  = path.join(ROOT, "public/data/pois_eu_uk.json");
const CURATED    = path.join(ROOT, "public/data/curated_destinations_eu_uk.json");
const OUT_DIR    = path.join(ROOT, "public/data/macros");

const areaId = process.argv[2];
if (!areaId) {
  console.error("❌ Missing area id. Example: node scripts/build_macro_from_area.mjs it_abruzzo");
  process.exit(1);
}

// -------------------- utils --------------------
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const slug = (s) => norm(s).replace(/\s+/g, "_").slice(0, 80);

const haversineKm = (aLat, aLon, bLat, bLon) => {
  const R = 6371;
  const toRad = (x) => x * Math.PI / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function readAreasList() {
  const raw = readJsonSafe(AREAS_FILE, null);
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.areas)) return raw.areas;
  if (Array.isArray(raw.items)) return raw.items;
  return [];
}

function computeBBoxFromPlaces(places) {
  let minLat =  999, maxLat = -999;
  let minLon =  999, maxLon = -999;

  for (const p of places) {
    const lat = Number(p?.lat);
    const lon = Number(p?.lng ?? p?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }

  if (minLat > 90 || maxLat < -90) return null;
  return { minLat, maxLat, minLon, maxLon };
}

function inBBox(lat, lon, bb) {
  if (!bb) return true;
  return lat >= bb.minLat && lat <= bb.maxLat && lon >= bb.minLon && lon <= bb.maxLon;
}

// -------------------- load inputs --------------------
const areas = readAreasList();
const area = areas.find((a) => a?.id === areaId);
if (!area) {
  console.error("❌ Area not found in public/data/areas.json:", areaId);
  process.exit(1);
}

const bboxFile = path.join(BBOX_DIR, `${areaId}.json`);
if (!fs.existsSync(bboxFile)) {
  console.error("❌ BBox file missing:", bboxFile);
  process.exit(1);
}

const bboxJson = readJsonSafe(bboxFile, { places: [] });
const bboxPlaces = Array.isArray(bboxJson?.places) ? bboxJson.places : [];

const poisJson = readJsonSafe(POIS_FILE, { pois: [] });
const poisAll = Array.isArray(poisJson?.pois) ? poisJson.pois : [];

const curatedJson = readJsonSafe(CURATED, { places: [] });
const curatedAll = Array.isArray(curatedJson?.places) ? curatedJson.places : [];

if (!bboxPlaces.length) {
  console.error("❌ No bbox places for:", areaId);
  process.exit(1);
}

// bbox area window (for fast filter)
const areaBBox = computeBBoxFromPlaces(bboxPlaces);

// filter POIs + curated down to this area bbox (fast)
const pois = poisAll.filter((p) => {
  const lat = Number(p?.lat);
  const lon = Number(p?.lng ?? p?.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) && inBBox(lat, lon, areaBBox);
});

const curated = curatedAll.filter((p) => {
  const lat = Number(p?.lat);
  const lon = Number(p?.lon ?? p?.lng);
  return Number.isFinite(lat) && Number.isFinite(lon) && inBBox(lat, lon, areaBBox);
});

// -------------------- classification helpers --------------------
const KW_STORIA = [
  "castello","rocca","fortezza","abbazia","cattedrale","duomo","basilica","chiesa",
  "museo","anfiteatro","teatro","tempio","sito archeologico","archeologico","necropolis",
  "monastero","palazzo","torre","borgo antico","centro storico"
];

const KW_FAMILY = [
  "parco","zoo","acquario","luna park","parco avventura","avventura",
  "theme park","amusement","water park","parco giochi","playground","fattoria","fattoria didattica"
];

function scoreKeywords(nameNorm, list) {
  let s = 0;
  for (const k of list) if (nameNorm.includes(k)) s += 1;
  return s;
}

function tagsFromPoi(poi) {
  // poi.types: ["mare"|"montagna"|"natura"|"relax"|"bambini"]
  const out = new Set();
  const types = Array.isArray(poi?.types) ? poi.types : [];
  for (const t of types) {
    if (t === "mare") out.add("mare");
    if (t === "montagna") out.add("montagna");
    if (t === "natura") out.add("natura");
    if (t === "relax") out.add("relax");
    if (t === "bambini") {
      out.add("bambini");
      out.add("famiglie");
      out.add("family");
    }
  }

  // extra keyword sniffing on POI name
  const n = norm(poi?.name);
  if (scoreKeywords(n, KW_STORIA) > 0) out.add("storia");
  if (scoreKeywords(n, KW_FAMILY) > 0) {
    out.add("bambini"); out.add("famiglie"); out.add("family");
  }

  return out;
}

function tagsFromCurated(p) {
  const out = new Set();
  const tags = Array.isArray(p?.tags) ? p.tags : [];
  for (const t of tags) out.add(String(t).toLowerCase());

  const type = String(p?.type || "").toLowerCase();
  if (type) out.add(type);

  // normalize
  if (out.has("borghi")) out.add("borgo");
  if (out.has("citta")) out.add("citta");
  if (out.has("family")) { out.add("famiglie"); out.add("bambini"); }
  return out;
}

function inferTypeAndTags(basePlace, tagSet, nearbyPois) {
  const pop = Number(basePlace?.population || 0);
  const nameN = norm(basePlace?.name);

  // additional inferred tags from name
  if (scoreKeywords(nameN, KW_STORIA) > 0) tagSet.add("storia");
  if (scoreKeywords(nameN, KW_FAMILY) > 0) { tagSet.add("bambini"); tagSet.add("famiglie"); tagSet.add("family"); }

  // choose macro "type" (this is what app.js uses first)
  // IMPORTANT: app.js expects:
  // - borghi => type "borgo" OR tag "borgo"
  // - family => type "bambini" OR tags include "famiglie"/"bambini"/"family"
  // - citta => type "citta"
  // - storia/mare/montagna/natura/relax => type matching
  let type =
    tagSet.has("mare") ? "mare" :
    tagSet.has("montagna") ? "montagna" :
    tagSet.has("relax") ? "relax" :
    tagSet.has("storia") ? "storia" :
    (tagSet.has("bambini") || tagSet.has("famiglie") || tagSet.has("family")) ? "bambini" :
    tagSet.has("natura") ? "natura" :
    (pop > 35000 ? "citta" : "borgo");

  // ensure borghi tag if small
  if (type === "borgo") tagSet.add("borgo");
  if (type === "citta") tagSet.add("citta");

  // make sure family tags stay for family type
  if (type === "bambini") { tagSet.add("famiglie"); tagSet.add("bambini"); tagSet.add("family"); }

  // ensure nature for outdoors if we have any poi around
  if (!tagSet.size && nearbyPois.length) tagSet.add("natura");

  return type;
}

function beautyScore(tagSet, poiCount, curatedBoost = 0, pop = 0) {
  // base
  let s = 0.66;

  // tag bonuses
  if (tagSet.has("mare")) s += 0.10;
  if (tagSet.has("montagna")) s += 0.09;
  if (tagSet.has("natura")) s += 0.08;
  if (tagSet.has("storia")) s += 0.08;
  if (tagSet.has("relax")) s += 0.06;
  if (tagSet.has("famiglie") || tagSet.has("bambini") || tagSet.has("family")) s += 0.08;
  if (tagSet.has("borgo")) s += 0.05;

  // poi density bonus
  s += Math.min(0.16, Math.log10(1 + Math.max(0, poiCount)) * 0.10);

  // curated boost
  s += clamp(curatedBoost, 0, 0.12);

  // big city slight boost (but not too much)
  if (pop > 120000) s += 0.04;

  return clamp(Number(s.toFixed(3)), 0.45, 1.0);
}

function visibilityFrom(pop, beauty) {
  if (beauty >= 0.88) return "conosciuta";
  if (pop >= 90000) return "conosciuta";
  return "chicca";
}

function topNearbyList(originLat, originLon, nearbyPois, limit = 10) {
  const list = nearbyPois
    .map((po) => {
      const lat = Number(po?.lat);
      const lon = Number(po?.lng ?? po?.lon);
      const km = (Number.isFinite(lat) && Number.isFinite(lon))
        ? haversineKm(originLat, originLon, lat, lon)
        : 9999;
      return {
        name: po?.name,
        types: po?.types || [],
        lat,
        lon,
        km: Number(km.toFixed(2)),
        source: po?.source || "pois"
      };
    })
    .filter(x => x.name && Number.isFinite(x.km))
    .sort((a,b)=> a.km - b.km)
    .slice(0, limit);

  return list;
}

// -------------------- build macro --------------------
//
// Important change vs your old script:
// - NON scartiamo più "posti morti" (tag size 0) => altrimenti perdi borghi/storia/family
// - family deve trovarne TANTI: raggio più grande e tag più permissivi
//
const RADIUS_KM_DEFAULT = 10;   // generale
const RADIUS_KM_FAMILY  = 18;   // family più largo (trovare sempre qualcosa)
const RADIUS_KM_STORIA  = 14;

const places = [];
const seenIds = new Set();

for (const p of bboxPlaces) {
  const name = p?.name;
  const lat = Number(p?.lat);
  const lon = Number(p?.lng ?? p?.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

  const pop = Number(p?.population || 0);

  const nameN = norm(name);

  // dynamic radius
  const kwFamily = scoreKeywords(nameN, KW_FAMILY);
  const kwStoria = scoreKeywords(nameN, KW_STORIA);

  const radiusKm =
    kwFamily > 0 ? RADIUS_KM_FAMILY :
    kwStoria > 0 ? RADIUS_KM_STORIA :
    RADIUS_KM_DEFAULT;

  // nearby pois
  const nearbyPois = pois.filter((po) => {
    const plat = Number(po?.lat);
    const plon = Number(po?.lng ?? po?.lon);
    if (!Number.isFinite(plat) || !Number.isFinite(plon)) return false;
    return haversineKm(lat, lon, plat, plon) <= radiusKm;
  });

  // nearby curated (tight)
  const nearbyCurated = curated.filter((cp) => {
    const clat = Number(cp?.lat);
    const clon = Number(cp?.lon ?? cp?.lng);
    if (!Number.isFinite(clat) || !Number.isFinite(clon)) return false;
    return haversineKm(lat, lon, clat, clon) <= 8;
  });

  // collect tags
  const tags = new Set();

  // from pois
  for (const po of nearbyPois) {
    const t = tagsFromPoi(po);
    for (const x of t) tags.add(x);
  }

  // from curated
  let curatedBoost = 0;
  for (const cp of nearbyCurated) {
    const t = tagsFromCurated(cp);
    for (const x of t) tags.add(x);
    curatedBoost = Math.max(curatedBoost, Number(cp?.beauty_score || 0) >= 0.9 ? 0.10 : 0.06);
  }

  const type = inferTypeAndTags(p, tags, nearbyPois);

  // build "why"
  const poiCount = nearbyPois.length;
  const familyHits = (tags.has("bambini") || tags.has("famiglie") || tags.has("family")) ? 1 : 0;
  const storiaHits = tags.has("storia") ? 1 : 0;

  const why = [];
  if (type === "bambini") why.push("Ideale per una giornata in famiglia");
  if (type === "storia") why.push("Ottima per cultura e storia");
  if (type === "mare") why.push("Perfetta se vuoi mare e spiagge");
  if (type === "montagna") why.push("Natura e panorami di montagna");
  if (type === "relax") why.push("Ottima per relax e benessere");
  if (type === "borgo") why.push("Borgo piacevole e autentico");
  if (type === "citta") why.push("Più servizi, cibo e passeggiata urbana");

  if (poiCount > 0) why.push(`${poiCount} cose da fare nei dintorni (raggio ~${radiusKm} km)`);
  if (familyHits) why.push("Presenza di attività per bambini / famiglie vicino");
  if (storiaHits) why.push("Punti di interesse storico nei dintorni");
  if (!why.length) why.push("Meta interessante per una gita veloce");

  // compute beauty + visibility
  const beauty = beautyScore(tags, poiCount, curatedBoost, pop);
  const visibility = visibilityFrom(pop, beauty);

  // unique id
  const id = `${areaId}_${slug(name)}_${String(lat).slice(0,6)}_${String(lon).slice(0,6)}`;
  if (seenIds.has(id)) continue;
  seenIds.add(id);

  // build links (for your app UI)
  // NB: qui mettiamo SOLO link di discovery (non affiliati), poi in app.js li trasformiamo in bottoni monetizzabili
  const q = encodeURIComponent(name);
  const links = {
    maps: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lon)}`,
    photos: `https://www.google.com/search?tbm=isch&q=${q}`,
    cosaVedere: `https://www.google.com/search?q=${encodeURIComponent("cosa vedere " + name)}`,
    cosaFare: `https://www.google.com/search?q=${encodeURIComponent("cosa fare " + name)}`,
    ristoranti: `https://www.google.com/search?q=${encodeURIComponent("ristoranti " + name)}`,
    eventi: `https://www.google.com/search?q=${encodeURIComponent("eventi " + name + " oggi")}`,
    wiki: `https://it.wikipedia.org/wiki/Special:Search?search=${q}`
  };

  // pack nearby list (used later in app)
  const nearbyTop = topNearbyList(lat, lon, nearbyPois, 12);

  places.push({
    id,
    name,
    area: area?.name || areaId,
    country: area?.country || "IT",
    lat,
    lon,
    type,
    tags: [...tags],
    visibility,
    beauty_score: beauty,
    why,
    nearby: nearbyTop, // <-- lista di cose da fare vicino (per scheda Family/Things-to-do)
    links
  });
}

// sort best first
places.sort((a, b) => (b.beauty_score || 0) - (a.beauty_score || 0));

fs.mkdirSync(OUT_DIR, { recursive: true });

// IMPORTANT: naming convention
// Your app.js / macros_index may reference /data/macros/<something>.json
// Here we generate: /public/data/macros/<areaId>.json
// (poi se vuoi, il workflow può anche rinominarlo in it_macro_01_xxx.json)
const outFile = path.join(OUT_DIR, `${areaId}.json`);

const out = {
  id: `macro_${areaId}`,
  name: `Macro ${area?.name || areaId} — AUTO ONLY`,
  updated_at: new Date().toISOString().slice(0, 10),
  area: { id: areaId, name: area?.name || areaId, country: area?.country || "IT" },
  places
};

fs.writeFileSync(outFile, JSON.stringify(out), "utf8");

console.log("✅ Macro generato:", outFile);
console.log("Mete:", places.length);

// quick stats
const stats = {};
for (const p of places) stats[p.type] = (stats[p.type] || 0) + 1;
console.log("Types:", stats);
