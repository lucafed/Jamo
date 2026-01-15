import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJson } from "./lib/overpass.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REGIONS_CFG_PATH = path.join(__dirname, "..", "configs", "it", "regions.json");
const cfg = JSON.parse(fs.readFileSync(REGIONS_CFG_PATH, "utf-8"));

const DIR = path.join(__dirname, "..", "public", "data", "pois", "regions");
const OUT = path.join(DIR, "it-regions-index.json");

// 👇 categorie “canoniche” che vuoi indicizzare (quelle dei tuoi file)
const CATEGORIES_CANON = [
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

// 👇 alias per compatibilità con app.js (viewpoints/hiking)
const CATEGORY_ALIASES = {
  panorami: ["viewpoints"],
  trekking: ["hiking"],
  citta: ["città", "city"], // extra innocui (non usati dall’app, ma ok)
};

// Normalizza i “cat” dai nomi file
function normCat(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replaceAll("à", "a")
    .replaceAll("-", "_");
}

function safeReadJson(p) {
  try {
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// bbox da places
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

function mergeBBox(a, b) {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return {
    minLat: Math.min(a.minLat, b.minLat),
    minLon: Math.min(a.minLon, b.minLon),
    maxLat: Math.max(a.maxLat, b.maxLat),
    maxLon: Math.max(a.maxLon, b.maxLon),
  };
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .filter(f => f !== "it-regions-index.json")
    .map(f => path.join(dir, f));
}

function parseRegionCategoryFromFilename(filePath) {
  // expected:
  // - it-lazio.json                 -> core
  // - it-lazio-relax.json           -> relax
  // - it-emilia-romagna-panorami.json -> panorami
  const base = path.basename(filePath);

  // core: it-xxx.json
  if (/^it-[a-z0-9-]+\.json$/i.test(base)) {
    const regionId = base.replace(/\.json$/i, "");
    return { regionId, category: "core" };
  }

  // category: it-xxx-<cat>.json
  const m = base.match(/^(.+)-([a-z0-9_]+)\.json$/i);
  if (!m) return null;

  const regionId = m[1];
  const category = normCat(m[2]);
  return { regionId, category };
}

// trasforma fileName in web path per la PWA (serve a app.js)
function webPathFromFile(fileName) {
  return `/data/pois/regions/${fileName}`;
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });

  const regionsCfg = Array.isArray(cfg.regions) ? cfg.regions : [];
  const regionsMap = new Map(regionsCfg.map(r => [String(r.id), r]));

  const files = listJsonFiles(DIR);

  // regionId -> info
  const perRegion = new Map();

  for (const f of files) {
    const rc = parseRegionCategoryFromFilename(f);
    if (!rc) continue;

    const { regionId } = rc;
    let category = normCat(rc.category);

    if (!regionsMap.has(regionId)) continue;

    // accetta solo categorie note (core compreso)
    if (!CATEGORIES_CANON.includes(category)) continue;

    const json = safeReadJson(f);
    if (!json) continue;

    const places = Array.isArray(json.places) ? json.places : [];
    const count = places.length;
    const bbox = bboxFromPlaces(places);

    if (!perRegion.has(regionId)) {
      perRegion.set(regionId, {
        // paths per categoria (quello che legge app.js)
        paths: {},
        // opzionale: counts utili per debug/monitor
        counts: {},
        // bbox regione (merge)
        bbox: null,
        // meta
        generated_at: null,
      });
    }

    const info = perRegion.get(regionId);
    const fileName = path.basename(f);

    // salva path canonico
    info.paths[category] = webPathFromFile(fileName);
    info.counts[category] = count;

    // alias compatibilità (es: panorami -> viewpoints)
    const aliases = CATEGORY_ALIASES[category] || [];
    for (const a of aliases) {
      const ak = normCat(a);
      if (!info.paths[ak]) info.paths[ak] = webPathFromFile(fileName);
      if (!info.counts[ak]) info.counts[ak] = count;
    }

    // bbox regione = unione bbox di tutti i file trovati
    info.bbox = mergeBBox(info.bbox, bbox);

    // tieni una generated_at “qualunque”
    if (!info.generated_at) info.generated_at = json.generated_at || null;
  }

  // Assemble index rispettando ordine cfg
  const items = regionsCfg.map(r => {
    const regionId = String(r.id);
    const p = perRegion.get(regionId);

    // bbox: se in cfg c’è bbox/bounds, preferiscila
    const cfgBBox = r.bbox || r.bounds || null;
    let bbox = null;

    if (
      cfgBBox &&
      Number.isFinite(cfgBBox.minLat) && Number.isFinite(cfgBBox.maxLat) &&
      Number.isFinite(cfgBBox.minLon) && Number.isFinite(cfgBBox.maxLon)
    ) {
      bbox = cfgBBox;
    } else if (
      cfgBBox &&
      Number.isFinite(cfgBBox.south) && Number.isFinite(cfgBBox.north) &&
      Number.isFinite(cfgBBox.west) && Number.isFinite(cfgBBox.east)
    ) {
      bbox = { minLat: cfgBBox.south, maxLat: cfgBBox.north, minLon: cfgBBox.west, maxLon: cfgBBox.east };
    } else {
      bbox = p?.bbox || null;
    }

    // total places (solo canoniche, così è pulito)
    let total = 0;
    if (p?.counts) {
      for (const c of CATEGORIES_CANON) total += Number(p.counts[c] || 0);
    }

    return {
      id: regionId,
      name: r.name || null,
      iso3166_2: r.iso3166_2 || null,
      bbox,                  // ✅ quello che serve per capire la regione via coordinate
      total_places: total,   // utile per debug
      paths: p?.paths || {}, // ✅ quello che serve a app.js (core/relax/borghi/cantine/...)
      counts: p?.counts || {}, // opzionale
      generated_at: p?.generated_at || null,
    };
  });

  const summary = {
    regions: items.length,
    categories_canon: CATEGORIES_CANON,
    aliases: CATEGORY_ALIASES,
    total_files_seen: files.length,
  };

  await writeJson(OUT, {
    country: "IT",
    generated_at: new Date().toISOString(),
    summary,
    items,
  });

  console.log(`✔ Written ${OUT} (${items.length} regions)`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
