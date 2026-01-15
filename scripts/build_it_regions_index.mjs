// scripts/build_it_regions_index.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "./lib/overpass.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// config regioni
const REGIONS_CFG_PATH = path.join(__dirname, "..", "configs", "it", "regions.json");
const cfg = JSON.parse(fs.readFileSync(REGIONS_CFG_PATH, "utf-8"));

// output index
const DIR = path.join(__dirname, "..", "public", "data", "pois", "regions");
const OUT = path.join(DIR, "it-regions-index.json");

// categorie che vuoi indicizzare (SOLO queste)
const CATEGORIES = [
  "core",
  "mare",
  "natura",
  "panorami",
  "trekking",
  "family",
  "storia",
  "montagna",
  "relax",
  "borghi",
  "citta",
  "cantine",
];

function safeReadJson(p) {
  try {
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function bboxFromPlaces(places) {
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  let ok = false;

  for (const x of (places || [])) {
    const lat = Number(x?.lat);
    const lon = Number(x?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    ok = true;
    if (lat < minLat) minLat = lat;
    if (lon < minLon) minLon = lon;
    if (lat > maxLat) maxLat = lat;
    if (lon > maxLon) maxLon = lon;
  }

  if (!ok) return null;
  return { minLat, minLon, maxLat, maxLon };
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => f !== "it-regions-index.json")
    .map((f) => path.join(dir, f));
}

function parseRegionCategoryFromFilename(filePath) {
  // accetta SOLO: it-<qualcosa>-<categoria>.json
  // es: it-lazio-borghi.json
  const base = path.basename(filePath);
  const m = base.match(/^(it-[a-z0-9-]+)-([a-z0-9_]+)\.json$/i);
  if (!m) return null;
  const regionId = m[1];
  const category = String(m[2]).toLowerCase();
  return { regionId, category };
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });

  const regionsCfg = cfg.regions || [];
  const regionsMap = new Map(regionsCfg.map((r) => [String(r.id), r]));

  const files = listJsonFiles(DIR);

  // regionId -> (category -> info)
  const perRegion = new Map();

  let indexedFiles = 0;

  for (const f of files) {
    const rc = parseRegionCategoryFromFilename(f);
    if (!rc) continue;

    const { regionId, category } = rc;

    // ignora regioni non in config
    if (!regionsMap.has(regionId)) continue;

    // ignora categorie non previste
    if (!CATEGORIES.includes(category)) continue;

    const json = safeReadJson(f);
    if (!json) continue;

    const places = Array.isArray(json.places) ? json.places : [];
    const count = places.length;
    const bbox = bboxFromPlaces(places);

    if (!perRegion.has(regionId)) perRegion.set(regionId, new Map());
    perRegion.get(regionId).set(category, {
      file: path.basename(f),
      count,
      bbox,
      generated_at: json.generated_at || null,
      label_it: json.label_it || null,
    });

    indexedFiles++;
  }

  // costruisci items rispettando l’ordine di regions.json
  const items = regionsCfg.map((r) => {
    const regionId = String(r.id);
    const cats = perRegion.get(regionId) || new Map();

    const categories = {};
    let total = 0;

    // ordine stabile categorie
    for (const c of CATEGORIES) {
      const info = cats.get(c);
      if (!info) continue;
      categories[c] = info;
      total += Number(info.count || 0);
    }

    return {
      id: regionId,
      name: r.name,
      iso3166_2: r.iso3166_2,
      total_places: total,
      categories,
    };
  });

  const summary = {
    regions: items.length,
    categories: CATEGORIES,
    total_files_found_in_dir: files.length,
    total_files_indexed: indexedFiles,
  };

  await writeJson(OUT, {
    country: "IT",
    generated_at: new Date().toISOString(),
    summary,
    items,
  });

  console.log(`✔ Written ${OUT}`);
  console.log(`✔ Regions: ${items.length}`);
  console.log(`✔ Files indexed: ${indexedFiles}/${files.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
