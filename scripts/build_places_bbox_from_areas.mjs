// scripts/build_places_bbox_from_areas.mjs
// Build bbox places for each area defined in public/data/areas.json
// Input:  .tmp/cities500.txt (GeoNames)
// Output: public/data/bbox/<area_id>.json
//
// Usage:
//   node scripts/build_places_bbox_from_areas.mjs .tmp/cities500.txt
//
// Notes:
// - We keep population >= 800 (avoid tiny hamlets that ruin UX/monetization)
// - We include ONLY country matching area.country (e.g. IT)
// - Output is compact JSON (smaller repo diffs)

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const inputPath = process.argv[2];

if (!inputPath) {
  console.error("Missing input path. Example: node scripts/build_places_bbox_from_areas.mjs .tmp/cities500.txt");
  process.exit(1);
}

const AREAS_PATH = path.join(ROOT, "public", "data", "areas.json");
const OUT_DIR = path.join(ROOT, "public", "data", "bbox");

function readJson(p) {
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function typeFromPop(pop) {
  if (pop >= 80000) return "citta";
  if (pop >= 8000) return "citta";
  return "borgo";
}

function visibilityFromPop(pop) {
  if (pop >= 250000) return "conosciuta";
  return "chicca";
}

function withinBBox(lat, lon, b) {
  return lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;
}

function makeId(geonameid) {
  return `gn_${geonameid}`;
}

function main() {
  if (!fs.existsSync(AREAS_PATH)) {
    console.error("Missing areas file:", AREAS_PATH);
    process.exit(1);
  }

  const areasDoc = readJson(AREAS_PATH);
  const areas = Array.isArray(areasDoc?.areas) ? areasDoc.areas : [];
  if (!areas.length) {
    console.error("No areas[] in", AREAS_PATH);
    process.exit(1);
  }

  const txt = fs.readFileSync(inputPath, "utf8");
  const lines = txt.split("\n");

  // Pre-parse all geonames rows once (fast)
  const rows = [];
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const cols = line.split("\t");
    if (cols.length < 19) continue;

    const geonameid = cols[0];
    const name = cols[1];
    const lat = safeNum(cols[4]);
    const lon = safeNum(cols[5]);
    const country = (cols[8] || "").toUpperCase();
    const population = safeNum(cols[14]) ?? 0;

    if (!geonameid || !name || lat === null || lon === null) continue;

    rows.push({ geonameid, name, lat, lon, country, population });
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const a of areas) {
    const id = String(a.id || "").trim();
    const name = String(a.name || id);
    const country = String(a.country || "").toUpperCase();
    const bbox = a.bbox;

    if (!id || !country || !bbox) {
      console.warn("Skipping area (missing id/country/bbox):", a);
      continue;
    }

    const minPop = Number(a.min_population ?? 800); // default 800
    const maxPlaces = Number(a.max_places ?? 12000); // safety
    const outPath = path.join(OUT_DIR, `${id}.json`);

    const places = [];
    for (const r of rows) {
      if (r.country !== country) continue;
      if (r.population < minPop) continue;
      if (!withinBBox(r.lat, r.lon, bbox)) continue;

      places.push({
        id: makeId(r.geonameid),
        name: r.name,
        country,
        type: typeFromPop(r.population),
        visibility: visibilityFromPop(r.population),
        lat: r.lat,
        lon: r.lon,
        population: r.population,
        tags: [],
        vibes: [],
        best_when: [],
        why: [],
        what_to_do: [],
        what_to_eat: []
      });

      if (places.length >= maxPlaces) break;
    }

    // Small de-dup by (normalized name + rounded coords)
    const seen = new Set();
    const dedup = [];
    for (const p of places) {
      const k = `${norm(p.name)}_${p.lat.toFixed(3)}_${p.lon.toFixed(3)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      dedup.push(p);
    }

    const out = {
      id,
      name,
      country,
      updated_at: new Date().toISOString().slice(0, 10),
      bbox,
      min_population: minPop,
      places: dedup
    };

    fs.writeFileSync(outPath, JSON.stringify(out), "utf8");
    console.log(`✅ ${id} (${name}) -> ${dedup.length} places saved: ${path.relative(ROOT, outPath)}`);
  }
}

main();
