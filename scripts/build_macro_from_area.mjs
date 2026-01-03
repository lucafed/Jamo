// scripts/build_macro_from_area.mjs
// Build macro AUTO-ONLY from:
// - public/data/areas.json
// - public/data/bbox/<areaId>.json
// - public/data/pois_eu_uk.json
// - public/data/curated_destinations_eu_uk.json  (optional)
// Output: public/data/macros/<macroName>.json
//
// Usage:
//   node scripts/build_macro_from_area.mjs it_abruzzo
//   node scripts/build_macro_from_area.mjs euuk_country_it
//
// Goal:
// - produce MANY good destinations (family/storia/borghi included)
// - attach “what to do nearby” + monetizable discovery links
// - keep offline selection stable (macro contains places), links are just helpers

import fs from "fs";
import path from "path";

const ROOT = process.cwd();

const AREAS_FILE = path.join(ROOT, "public", "data", "areas.json");
const BBOX_DIR   = path.join(ROOT, "public", "data", "bbox");
const POIS_FILE  = path.join(ROOT, "public", "data", "pois_eu_uk.json");
const CURATED    = path.join(ROOT, "public", "data", "curated_destinations_eu_uk.json");
const OUT_DIR    = path.join(ROOT, "public", "data", "macros");

const areaId = process.argv[2];
if (!areaId) {
  console.error("❌ Missing area id. Example: node scripts/build_macro_from_area.mjs it_abruzzo");
  process.exit(1);
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

const toRad = (x) => (x * Math.PI) / 180;
const haversineKm = (aLat, aLon, bLat, bLon) => {
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function slugFromAreaId(areaId) {
  // it_abruzzo -> abruzzo
  // euuk_country_it -> euuk_country_it (kept)
  if (areaId.startsWith("it_")) return areaId.slice(3);
  return areaId;
}

function macroOutputName(area) {
  // IMPORTANT: must match what app.js expects in macros_index.json
  // IT regions: it_macro_01_<regionSlug>.json
  if (area.id?.startsWith("it_")) {
    return `it_macro_01_${slugFromAreaId(area.id)}.json`;
  }

  // EU/UK country macros (your repo already uses euuk_country_xx.json)
  if (area.id?.startsWith("euuk_country_")) {
    return `${area.id}.json`;
  }

  // fallback
  return `macro_${area.id}.json`;
}

// --- DISCOVERY / “scheda” links (also monetizable later) ---
function googleSearchUrl(q) {
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}
function googleImagesUrl(q) {
  return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`;
}
function googleMapsSearchUrl(q) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}
function googleEventsUrl(q) {
  // “eventi vicino” (Google will localize by user)
  return googleSearchUrl(`eventi ${q} oggi weekend`);
}
function wikiUrl(title) {
  return `https://it.wikipedia.org/wiki/${encodeURIComponent(String(title || "").replace(/\s+/g, "_"))}`;
}

// Travel purchase links (no routes, just search pages)
function skyscannerFlightsUrl(q) {
  return `https://www.skyscanner.it/trasporti/voli/${encodeURIComponent(q)}`;
}
function omioUrl(q) {
  return `https://www.omio.it/search?term=${encodeURIComponent(q)}`;
}
function trainlineUrl(q) {
  return `https://www.thetrainline.com/it/orari-treni/${encodeURIComponent(q)}`;
}

// Monetization marketplaces (work via search query; affiliate IDs optional in app.js later)
function bookingUrl(q) {
  return `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(q)}`;
}
function getYourGuideUrl(q) {
  return `https://www.getyourguide.com/s/?q=${encodeURIComponent(q)}`;
}
function tiqetsUrl(q) {
  // NOTE: Tiqets search is picky; use broader query (city + "tickets")
  return `https://www.tiqets.com/it/search/?query=${encodeURIComponent(q)}`;
}

// --- TAG/TYPE classification ---
function addTag(set, ...tags) {
  for (const t of tags) {
    const k = norm(t);
    if (k) set.add(k);
  }
}

function inferTagsFromNameAndBbox(p) {
  const t = new Set();
  const n = norm(p?.name);

  // borghi / centri storici
  if (n.includes("borgo") || n.includes("centro storico") || n.includes("castel") || n.includes("rocca")) {
    addTag(t, "borgo", "storia");
  }

  // storia/cultura
  if (
    n.includes("abbazia") || n.includes("cattedrale") || n.includes("duomo") ||
    n.includes("chiesa") || n.includes("museo") || n.includes("teatro") ||
    n.includes("castello") || n.includes("fortezza") || n.includes("anfiteatro") ||
    n.includes("archeolog") || n.includes("monastero") || n.includes("eremo")
  ) {
    addTag(t, "storia", "cultura");
  }

  // natura
  if (
    n.includes("parco") || n.includes("riserva") || n.includes("gole") ||
    n.includes("cascata") || n.includes("lago") || n.includes("bosco") ||
    n.includes("sentiero") || n.includes("canyon") || n.includes("valle")
  ) {
    addTag(t, "natura");
  }

  // mare/montagna/relax
  if (n.includes("spiaggia") || n.includes("lido") || n.includes("marina") || n.includes("trabocc")) addTag(t, "mare", "spiagge");
  if (n.includes("monte") || n.includes("passo") || n.includes("rifugio") || n.includes("gran sasso") || n.includes("majella")) addTag(t, "montagna");
  if (n.includes("terme") || n.includes("spa")) addTag(t, "relax", "terme");

  // family hints
  if (n.includes("zoo") || n.includes("acquario") || n.includes("parco avventura") || n.includes("luna park") || n.includes("fattoria")) {
    addTag(t, "famiglie", "bambini");
  }

  // bbox tags/vibes
  if (Array.isArray(p?.tags)) p.tags.forEach(x => addTag(t, x));
  if (Array.isArray(p?.vibes)) p.vibes.forEach(x => addTag(t, x));

  return t;
}

function inferTagsFromPoi(poi) {
  // POIs builder already gives types: mare/montagna/natura/relax/bambini
  const t = new Set();

  const types = Array.isArray(poi?.types) ? poi.types : [];
  for (const x of types) addTag(t, x);

  // extra from name for family/storia
  const n = norm(poi?.name);
  if (n.includes("museum") || n.includes("museo")) addTag(t, "storia", "museo");
  if (n.includes("castle") || n.includes("castello") || n.includes("fort") || n.includes("fortezza")) addTag(t, "storia", "castello");
  if (n.includes("abbey") || n.includes("abbazia") || n.includes("church") || n.includes("cattedrale") || n.includes("duomo")) addTag(t, "storia");
  if (n.includes("park") || n.includes("parco") || n.includes("garden") || n.includes("giardino")) addTag(t, "natura", "famiglie");
  if (n.includes("zoo") || n.includes("aquarium") || n.includes("acquario") || n.includes("theme park") || n.includes("amusement")) addTag(t, "bambini", "famiglie");

  return t;
}

function chooseType(tags) {
  // app.js categories expect: citta, borgo, mare, montagna, natura, storia, relax, bambini
  if (tags.has("bambini") || tags.has("famiglie") || tags.has("family")) return "bambini";
  if (tags.has("storia") || tags.has("museo") || tags.has("castello") || tags.has("cultura")) return "storia";
  if (tags.has("mare") || tags.has("spiagge") || tags.has("trabocchi")) return "mare";
  if (tags.has("montagna") || tags.has("neve")) return "montagna";
  if (tags.has("relax") || tags.has("terme") || tags.has("spa")) return "relax";
  if (tags.has("borgo")) return "borgo";
  if (tags.has("natura") || tags.has("lago") || tags.has("cascata") || tags.has("riserva")) return "natura";
  // fallback
  return "citta";
}

function familyLevel(tags) {
  // quick “for who”
  const out = {
    family: tags.has("famiglie") || tags.has("bambini") || tags.has("family"),
    kids: tags.has("bambini"),
    teens: tags.has("avventura") || tags.has("trekking") || tags.has("sport")
  };
  return out;
}

function beautyScore(tags, poiCount, pop = 0) {
  let s = 0.74;

  // category boosts
  if (tags.has("mare") || tags.has("spiagge")) s += 0.07;
  if (tags.has("montagna")) s += 0.07;
  if (tags.has("natura")) s += 0.06;
  if (tags.has("storia")) s += 0.05;
  if (tags.has("famiglie") || tags.has("bambini")) s += 0.06;
  if (tags.has("borgo")) s += 0.03;

  // density boosts (cap)
  s += Math.min(0.18, Math.log10(1 + Math.max(0, poiCount)) * 0.10);

  // huge cities slight penalty (less “gita wow”)
  if (pop >= 500000) s -= 0.05;

  return clamp(Number(s.toFixed(2)), 0.60, 1.0);
}

function visibilityFrom(pop = 0, score = 0.8) {
  if (pop >= 70000) return "conosciuta";
  if (score >= 0.90) return "conosciuta";
  return "chicca";
}

function topWhy(tags, poiCount) {
  const w = [];

  if (tags.has("bambini") || tags.has("famiglie")) w.push("Family-friendly: attività e posti adatti a bambini.");
  if (tags.has("storia")) w.push("Cose da vedere: cultura, monumenti e visite interessanti.");
  if (tags.has("natura")) w.push("Natura vicina: panorami, sentieri, relax all’aperto.");
  if (tags.has("mare")) w.push("Mare/spiagge: perfetto per relax e foto.");
  if (tags.has("montagna")) w.push("Montagna: aria top e gite outdoor.");

  if (poiCount >= 10) w.push("Tante cose da fare nei dintorni (molti POI).");
  else if (poiCount >= 4) w.push("Diversi punti di interesse e attività nei dintorni.");

  // max 4
  return w.slice(0, 4);
}

// Build a small grid index for POIs -> fast nearby lookup
function buildPoiGrid(pois, cellDeg = 0.08) {
  const grid = new Map();
  const key = (lat, lon) => `${Math.floor(lat / cellDeg)}:${Math.floor(lon / cellDeg)}`;

  for (const p of pois) {
    const lat = safeNum(p?.lat);
    const lon = safeNum(p?.lng ?? p?.lon);
    if (lat === null || lon === null) continue;
    const k = key(lat, lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push({ ...p, lat, lon });
  }

  function nearby(lat, lon, maxKm = 10) {
    const a = Math.floor(lat / cellDeg);
    const b = Math.floor(lon / cellDeg);
    const bucket = [];

    for (let da = -1; da <= 1; da++) {
      for (let db = -1; db <= 1; db++) {
        const k = `${a + da}:${b + db}`;
        const arr = grid.get(k);
        if (arr && arr.length) bucket.push(...arr);
      }
    }

    const res = [];
    for (const p of bucket) {
      const km = haversineKm(lat, lon, p.lat, p.lon);
      if (km <= maxKm) res.push({ poi: p, km });
    }

    res.sort((x, y) => x.km - y.km);
    return res;
  }

  return { nearby };
}

function uniqueById(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const id = String(x?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(x);
  }
  return out;
}

function safePlaceId(areaId, name, lat, lon) {
  return `${areaId}_${norm(name).replace(/\s+/g, "_")}_${String(lat).slice(0, 6)}_${String(lon).slice(0, 6)}`.slice(0, 110);
}

function main() {
  // --- load files ---
  if (!exists(AREAS_FILE)) throw new Error("Missing public/data/areas.json");
  if (!exists(POIS_FILE)) throw new Error("Missing public/data/pois_eu_uk.json");

  const areas = readJson(AREAS_FILE);
  const area = Array.isArray(areas) ? areas.find(a => a.id === areaId) : null;
  if (!area) throw new Error(`Area not found in areas.json: ${areaId}`);

  const bboxFile = path.join(BBOX_DIR, `${areaId}.json`);
  if (!exists(bboxFile)) throw new Error(`BBox file missing: ${bboxFile}`);

  const bboxRaw = readJson(bboxFile);
  const bboxPlaces = Array.isArray(bboxRaw?.places) ? bboxRaw.places : (Array.isArray(bboxRaw) ? bboxRaw : []);
  const poiRaw = readJson(POIS_FILE);
  const pois = Array.isArray(poiRaw?.pois) ? poiRaw.pois : [];

  const curatedRaw = exists(CURATED) ? readJson(CURATED) : null;
  const curatedPlaces = Array.isArray(curatedRaw?.places) ? curatedRaw.places : [];

  // Build POI grid
  const grid = buildPoiGrid(pois, 0.08);

  const outPlaces = [];
  const seenKey = new Set();

  // --- 1) Seed curated first (if matches area country/region, best-effort) ---
  // Curated structure may vary; we accept items with lat/lon
  for (const c of curatedPlaces) {
    const lat = safeNum(c?.lat);
    const lon = safeNum(c?.lon ?? c?.lng);
    if (lat === null || lon === null || !c?.name) continue;

    // if curated has country / region mismatch, skip lightly (best-effort)
    const cc = String(c?.country || "").toUpperCase();
    if (area.country && cc && cc !== String(area.country).toUpperCase()) continue;

    const tags = new Set(Array.isArray(c?.tags) ? c.tags.map(norm) : []);
    addTag(tags, ...inferTagsFromNameAndBbox(c));

    const type = chooseType(tags);
    const nearby = grid.nearby(lat, lon, 10);
    // merge tags from nearby pois
    for (const x of nearby.slice(0, 12)) {
      const t2 = inferTagsFromPoi(x.poi);
      for (const t of t2) tags.add(t);
    }

    const score = beautyScore(tags, nearby.length, safeNum(c?.population) ?? 0);
    const key = `${norm(c.name)}_${lat.toFixed(3)}_${lon.toFixed(3)}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);

    outPlaces.push({
      id: String(c?.id || safePlaceId(areaId, c.name, lat, lon)),
      name: String(c.name),
      area: String(area.name || areaId),
      country: String(area.country || cc || "IT"),
      lat,
      lon,
      type,
      tags: [...tags].slice(0, 24),
      visibility: String(c?.visibility || visibilityFrom(safeNum(c?.population) ?? 0, score)),
      beauty_score: score,
      family: familyLevel(tags),
      why: Array.isArray(c?.why) ? c.why.slice(0, 4) : topWhy(tags, nearby.length),
      nearby: nearby.slice(0, 14).map(x => ({
        name: x.poi?.name,
        type: (Array.isArray(x.poi?.types) && x.poi.types[0]) ? x.poi.types[0] : "poi",
        km: Number(x.km.toFixed(1))
      })),
      links: {
        maps: googleMapsSearchUrl(`${c.name} ${area.name}`),
        photos: googleImagesUrl(`${c.name} ${area.name}`),
        cosa_vedere: googleSearchUrl(`cosa vedere ${c.name}`),
        cosa_fare: googleSearchUrl(`cosa fare ${c.name}`),
        ristoranti: googleMapsSearchUrl(`ristoranti ${c.name}`),
        eventi: googleEventsUrl(`${c.name} ${area.name}`),
        wiki: wikiUrl(c.name),
        booking: bookingUrl(`${c.name} ${area.name}`),
        gyg: getYourGuideUrl(`${c.name}`),
        tiqets: tiqetsUrl(`${c.name} tickets`),
        voli: skyscannerFlightsUrl(`${c.name}`),
        treni_bus: omioUrl(`${c.name}`),
        treni: trainlineUrl(`${c.name}`)
      }
    });
  }

  // --- 2) BBOX places (bulk). NO MORE “skip if tags empty” ---
  for (const p of bboxPlaces) {
    const lat = safeNum(p?.lat);
    const lon = safeNum(p?.lng ?? p?.lon);
    const name = p?.name;

    if (!name || lat === null || lon === null) continue;

    const key = `${norm(name)}_${lat.toFixed(3)}_${lon.toFixed(3)}`;
    if (seenKey.has(key)) continue;

    const pop = safeNum(p?.population) ?? 0;

    // nearby POIs within radius: bigger for small towns to catch family stuff around
    const radiusKm = pop && pop < 5000 ? 14 : 10;
    const nearby = grid.nearby(lat, lon, radiusKm);

    const tags = inferTagsFromNameAndBbox(p);

    // Add tags from nearby POIs (this is what enables Family / Bambini / Natura strongly)
    for (const x of nearby.slice(0, 16)) {
      const t2 = inferTagsFromPoi(x.poi);
      for (const t of t2) tags.add(t);
    }

    // If still empty (rare), assume it’s at least a “borgo/citta” depending on pop
    if (tags.size === 0) {
      if (pop >= 20000) addTag(tags, "citta");
      else addTag(tags, "borgo");
    }

    const type = chooseType(tags);

    // IMPORTANT: keep borghi + storia even if POIs are few
    // (Your previous script was killing these!)
    const score = beautyScore(tags, nearby.length, pop);

    seenKey.add(key);

    outPlaces.push({
      id: String(p?.id || safePlaceId(areaId, name, lat, lon)),
      name: String(name),
      area: String(area.name || areaId),
      country: String(area.country || p?.country || "IT"),
      lat,
      lon,
      type,
      tags: [...tags].slice(0, 24),
      visibility: String(p?.visibility || visibilityFrom(pop, score)),
      beauty_score: score,
      family: familyLevel(tags),
      why: topWhy(tags, nearby.length),
      nearby: nearby.slice(0, 14).map(x => ({
        name: x.poi?.name,
        type: (Array.isArray(x.poi?.types) && x.poi.types[0]) ? x.poi.types[0] : "poi",
        km: Number(x.km.toFixed(1))
      })),
      links: {
        maps: googleMapsSearchUrl(`${name} ${area.name}`),
        photos: googleImagesUrl(`${name} ${area.name}`),
        cosa_vedere: googleSearchUrl(`cosa vedere ${name}`),
        cosa_fare: googleSearchUrl(`cosa fare ${name}`),
        ristoranti: googleMapsSearchUrl(`ristoranti ${name}`),
        eventi: googleEventsUrl(`${name} ${area.name}`),
        wiki: wikiUrl(name),
        booking: bookingUrl(`${name} ${area.name}`),
        gyg: getYourGuideUrl(`${name}`),
        tiqets: tiqetsUrl(`${name} tickets`),
        voli: skyscannerFlightsUrl(`${name}`),
        treni_bus: omioUrl(`${name}`),
        treni: trainlineUrl(`${name}`)
      }
    });
  }

  // Final dedup by id
  const places = uniqueById(outPlaces);

  // Sort: best first (beauty desc), then more “family” density
  places.sort((a, b) => {
    const as = Number(a.beauty_score || 0);
    const bs = Number(b.beauty_score || 0);
    if (bs !== as) return bs - as;

    const af = (a.family?.family ? 1 : 0) + (a.family?.kids ? 1 : 0);
    const bf = (b.family?.family ? 1 : 0) + (b.family?.kids ? 1 : 0);
    if (bf !== af) return bf - af;

    return norm(a.name).localeCompare(norm(b.name));
  });

  // Output macro header (compatible with your app)
  const out = {
    id: `macro_${area.id}`,
    name: `Macro — ${area.name} (AUTO-ONLY)`,
    version: "4.0.0",
    updated_at: new Date().toISOString().slice(0, 10),
    coverage: {
      area_id: area.id,
      area_name: area.name,
      country: area.country || null
    },
    rules: {
      mode: "car_only",
      offline_and_stable: true,
      include_family: true,
      include_storia_borghi: true,
      include_nearby_pois: true
    },
    schema: {
      // app.js needs at least these:
      // id,name,type,area,lat,lon,tags,visibility,beauty_score,why
      place_fields: [
        "id","name","type","area","country","lat","lon","tags",
        "visibility","beauty_score","why","family","nearby","links"
      ]
    },
    places
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outName = macroOutputName(area);
  const outFile = path.join(OUT_DIR, outName);
  fs.writeFileSync(outFile, JSON.stringify(out), "utf8");

  console.log("✅ Macro generato:", outFile);
  console.log("Mete:", places.length);

  // quick stats per type (useful for verifying Family/Storia/Borghi)
  const types = {};
  for (const p of places) types[p.type] = (types[p.type] || 0) + 1;
  console.log("Breakdown:", types);
}

main();
