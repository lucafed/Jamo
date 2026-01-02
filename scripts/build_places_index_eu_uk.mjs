// scripts/build_places_index_eu_uk.mjs
// Usage:
//   node scripts/build_places_index_eu_uk.mjs .tmp/cities500.txt
//
// Output:
//   public/data/places_index_eu_uk.json
//
// Strategy:
// - Start from GeoNames cities500 (EU+UK)
// - Keep smaller places too, BUT only if they look tourist/monetizable
// - Tourist signal comes from nearby POIs (public/data/pois_eu_uk.json)
//   -> count POIs within radius and boost by POI "strength"

import fs from "fs";
import path from "path";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Missing input path. Example: node scripts/build_places_index_eu_uk.mjs .tmp/cities500.txt");
  process.exit(1);
}

const OUT = path.join(process.cwd(), "public", "data", "places_index_eu_uk.json");

// If you have a different filename, change it here:
const POIS_PATH = path.join(process.cwd(), "public", "data", "pois_eu_uk.json");

// EU + UK country codes (GeoNames)
const EU_UK = new Set([
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT",
  "NL","PL","PT","RO","SK","SI","ES","SE","GB"
]);

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
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

// --- Heuristics: type/visibility from population (base, then tourismScore refines)
function typeFromPop(pop) {
  if (pop >= 80000) return "citta";
  if (pop >= 8000) return "citta";
  return "borgo";
}
function visibilityFromPop(pop) {
  if (pop >= 250000) return "conosciuta";
  return "chicca";
}

// --- POI loading (optional but recommended)
function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizePois(raw) {
  // Accept array or {pois:[...]} etc.
  const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.pois) ? raw.pois : []);
  return arr
    .map(x => {
      const lat = Number(x?.lat);
      const lon = Number(x?.lon ?? x?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const kind = norm(x?.kind || x?.type || "");
      const tags = Array.isArray(x?.tags) ? x.tags.map(norm) : [];
      return {
        id: String(x?.id || ""),
        name: String(x?.name || ""),
        lat, lon,
        kind,
        tags
      };
    })
    .filter(Boolean);
}

// Strong POI categories => monetizable
function poiStrength(poi) {
  const k = poi.kind;
  const t = poi.tags;

  // super monetizable:
  if (k.includes("beach") || t.includes("spiaggia") || t.includes("beach")) return 4.0;
  if (k.includes("museum") || t.includes("museo") || t.includes("museum")) return 3.2;
  if (k.includes("castle") || t.includes("castello") || t.includes("castle")) return 3.0;
  if (k.includes("attraction") || t.includes("attrazione") || t.includes("theme park") || t.includes("parco divertimenti")) return 3.0;
  if (k.includes("national park") || t.includes("parco nazionale") || t.includes("park")) return 2.6;
  if (k.includes("viewpoint") || t.includes("panorama") || t.includes("belvedere")) return 2.2;
  if (k.includes("lake") || t.includes("lago")) return 2.0;
  if (k.includes("waterfall") || t.includes("cascata")) return 2.0;
  if (k.includes("hiking") || t.includes("trekking") || t.includes("sentiero")) return 1.8;
  if (k.includes("ski") || t.includes("sci")) return 1.8;

  // generic POI:
  return 1.0;
}

// Count POIs around a place and compute tourism score
function tourismScoreForPlace(place, pois) {
  if (!pois?.length) return 0;

  const { lat, lng } = place;
  // radii buckets
  const R1 = 8;   // very close
  const R2 = 18;  // day-trip close
  const R3 = 35;  // region close

  let s1 = 0, s2 = 0, s3 = 0;
  let c1 = 0, c2 = 0, c3 = 0;

  for (const poi of pois) {
    const km = haversineKm(lat, lng, poi.lat, poi.lon);
    if (km > R3) continue;

    const w = poiStrength(poi);

    if (km <= R1) { s1 += w; c1++; }
    else if (km <= R2) { s2 += w; c2++; }
    else { s3 += w * 0.7; c3++; }
  }

  // Score weighting: closest matters most
  const raw = (s1 * 1.0) + (s2 * 0.65) + (s3 * 0.35);

  // Slight boost if there is density (many options)
  const densityBoost = clamp((c1 + c2 * 0.6 + c3 * 0.3) / 18, 0, 0.25);

  return raw + raw * densityBoost;
}

function vibesFromPoiMix(place, pois) {
  // tiny tags based on nearby POIs
  if (!pois?.length) return [];
  const { lat, lng } = place;
  const within = [];
  for (const poi of pois) {
    const km = haversineKm(lat, lng, poi.lat, poi.lon);
    if (km <= 18) within.push(poi);
  }
  const tags = new Set();
  for (const p of within) {
    const k = p.kind;
    const t = p.tags;
    if (k.includes("beach") || t.includes("spiaggia") || t.includes("beach")) tags.add("mare");
    if (k.includes("museum") || t.includes("museo") || t.includes("museum")) tags.add("cultura");
    if (k.includes("castle") || t.includes("castello") || t.includes("castle")) tags.add("storia");
    if (k.includes("national park") || t.includes("parco nazionale") || t.includes("park")) tags.add("natura");
    if (k.includes("viewpoint") || t.includes("panorama") || t.includes("belvedere")) tags.add("panorama");
    if (k.includes("lake") || t.includes("lago")) tags.add("lago");
    if (k.includes("waterfall") || t.includes("cascata")) tags.add("cascate");
    if (k.includes("hiking") || t.includes("trekking") || t.includes("sentiero")) tags.add("trekking");
    if (k.includes("ski") || t.includes("sci")) tags.add("neve");
    if (t.includes("famiglie") || t.includes("bambini") || t.includes("family")) tags.add("family");
  }
  return [...tags].slice(0, 7);
}

// --- Read GeoNames cities500
const txt = fs.readFileSync(inputPath, "utf8");
const lines = txt.split("\n");

// Load POIs if present
const poisRaw = readJsonSafe(POIS_PATH, null);
const pois = normalizePois(poisRaw);

// Build candidate places
const candidates = [];
for (const line of lines) {
  if (!line || line.startsWith("#")) continue;
  const cols = line.split("\t");
  if (cols.length < 19) continue;

  // GeoNames columns:
  // 0 geonameid
  // 1 name
  // 4 latitude
  // 5 longitude
  // 8 country code
  // 14 population
  const geonameid = cols[0];
  const name = cols[1];
  const lat = safeNum(cols[4]);
  const lng = safeNum(cols[5]);
  const country = cols[8];
  const population = safeNum(cols[14]) ?? 0;

  if (!EU_UK.has(country)) continue;
  if (!name || lat === null || lng === null) continue;

  // KEEP more places than before, but not too tiny:
  // below 500 often becomes hamlets. We keep them only if POI score is high.
  candidates.push({
    id: `gn_${geonameid}`,
    name,
    country: country === "GB" ? "UK" : country,
    lat,
    lng,
    population
  });
}

// Dedupe by normalized name + approx coords (avoid duplicates)
const seen = new Set();
const deduped = [];
for (const p of candidates) {
  const key = `${p.country}|${norm(p.name)}|${p.lat.toFixed(3)}|${p.lng.toFixed(3)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  deduped.push(p);
}

// Score tourism/monetizability
const scored = deduped.map(p => {
  const tscore = tourismScoreForPlace(p, pois);
  return { ...p, _tourismScore: tscore };
});

// Filter rules:
// - If you have POIs: require tourismScore OR decent population
// - If no POIs file: fallback to population >= 2000 (old behavior)
let filtered;
if (pois.length) {
  filtered = scored.filter(p => {
    const pop = p.population || 0;
    const ts = p._tourismScore || 0;

    // Big cities always ok
    if (pop >= 20000) return true;

    // Medium towns ok if some tourism
    if (pop >= 4000 && ts >= 3.0) return true;

    // Small places only if strongly touristic
    if (pop >= 500 && ts >= 6.5) return true;

    return false;
  });
} else {
  filtered = scored.filter(p => (p.population || 0) >= 2000);
}

// Convert to final structure + enrich vibes/tags
const places = filtered
  .sort((a, b) => (b._tourismScore - a._tourismScore) || ((b.population || 0) - (a.population || 0)))
  .map(p => {
    const pop = p.population || 0;
    const type = typeFromPop(pop);
    const visibility = visibilityFromPop(pop);

    const vibes = vibesFromPoiMix(p, pois);

    // Extra monetizable tags
    const tags = [];
    if (vibes.includes("mare")) tags.push("mare");
    if (vibes.includes("natura")) tags.push("natura");
    if (vibes.includes("storia")) tags.push("storia");
    if (vibes.includes("cultura")) tags.push("cultura");
    if (vibes.includes("family")) tags.push("famiglie");

    // A compact "why" baseline for UI
    const why = [];
    if (p._tourismScore > 0) why.push("Zona ricca di cose da fare/vedere nelle vicinanze.");
    if (pop >= 80000) why.push("Città con servizi, ristoranti e attività.");
    if (visibility === "chicca") why.push("Ottima come gita/scoperta meno ovvia.");

    return {
      id: p.id,
      name: p.name,
      country: p.country,
      type,
      visibility,
      lat: p.lat,
      lng: p.lng,
      population: pop,

      // NEW: monetization intelligence
      tourism_score: Number((p._tourismScore || 0).toFixed(2)),
      tags,
      vibes,

      // fillable later
      best_when: [],
      why,
      what_to_do: [],
      what_to_eat: []
    };
  });

const out = {
  version: "2.0",
  updated: new Date().toISOString().slice(0, 10),
  regions: ["EU", "UK"],
  pois_loaded: pois.length,
  places
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out), "utf8");

// sanity check
const aq = places.find(p => norm(p.name) === "l aquila" || norm(p.name) === "laquila");
console.log("Saved:", OUT, "places:", places.length, "POIs:", pois.length, "Check L'Aquila:", aq ? "OK" : "NOT FOUND");
