// scripts/build_it_regions_index.mjs — v2.0
// Scansiona public/data/pois/regions/*.json e costruisce:
// public/data/pois/regions/it-regions-index.json
//
// Output per regione:
// - bbox (da places)
// - paths: { core, borghi, relax, cantine, ... } (solo quelle presenti)
// - counts: { ... }
// - total_places
//
// NOTE: ignora radius-*.json

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

// categorie che consideriamo “canon” (ma indicizziamo anche altre se presenti)
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

const ALIASES = {
  panorami: ["viewpoints"],
  trekking: ["hiking"],
  citta: ["città", "city"],
};

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
    const lon = Number(x?.lon ?? x?.lng);
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
    .filter(f => f.endsWith(".json"))
    .filter(f => f !== "it-regions-index.json")
    .filter(f => !f.startsWith("radius-")) // ignora radius
    .map(f => path.join(dir, f));
}

function normalizeCategory(cat) {
  const c = String(cat || "").toLowerCase().trim();
  if (!c) return "";

  // alias -> canon
  for (const [canon, arr] of Object.entries(ALIASES)) {
    if (arr.includes(c)) return canon;
  }
  return c;
}

function parseRegionCategoryFromFilename(filePath) {
  // expected: <regionId>-<category>.json (category = ultima parte dopo ultimo "-")
  // example: it-lazio-borghi.json => regionId=it-lazio, category=borghi
  const base = path.basename(filePath);

  const m = base.match(/^(.+)-([a-z0-9_àèìòù]+)\.json$/i);
  if (!m) return null;

  const regionId = m[1];
  const categoryRaw = m[2];
  const category = normalizeCategory(categoryRaw);

  return { regionId, category, file: base };
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });

  const regionsCfg = cfg.regions || [];
  const regionsMap = new Map(regionsCfg.map(r => [String(r.id), r]));

  const files = listJsonFiles(DIR);

  // region -> { paths, counts, bbox, generated_at, total_places }
  const perRegion = new Map();

  for (const f of files) {
    const rc = parseRegionCategoryFromFilename(f);
    if (!rc) continue;

    const { regionId, category, file } = rc;

    // se il nome file è solo it-lazio.json => regex lo legge come regionId="it" category="lazio" (NO!)
    // Quindi gestiamo il caso "core" senza suffisso:
    // -> se il file base è esattamente "<regionId>.json" allora è core.
    // (e lo intercettiamo prima)
  }

  // Prima: aggiungi file "<regionId>.json" come core
  for (const r of regionsCfg) {
    const regionId = String(r.id);
    const corePath = path.join(DIR, `${regionId}.json`);
    if (!fs.existsSync(corePath)) continue;

    const json = safeReadJson(corePath);
    if (!json) continue;

    const places = Array.isArray(json.places) ? json.places : [];
    const count = places.length;
    const bbox = bboxFromPlaces(places);

    perRegion.set(regionId, {
      id: regionId,
      name: r.name,
      iso3166_2: r.iso3166_2,
      bbox: bbox || null,
      paths: { core: `/data/pois/regions/${regionId}.json` },
      counts: { core: count },
      total_places: count,
      generated_at: json.generated_at || null,
    });
  }

  // Poi: scansiona gli altri file "<regionId>-<category>.json"
  for (const f of files) {
    const base = path.basename(f);

    // ignora i core già gestiti
    if (regionsMap.has(base.replace(/\.json$/i, ""))) continue;

    const rc = parseRegionCategoryFromFilename(f);
    if (!rc) continue;

    const { regionId, category } = rc;
    if (!regionsMap.has(regionId)) continue;

    const json = safeReadJson(f);
    if (!json) continue;

    const places = Array.isArray(json.places) ? json.places : [];
    const count = places.length;

    // inizializza se core mancava
    if (!perRegion.has(regionId)) {
      const r = regionsMap.get(regionId);
      perRegion.set(regionId, {
        id: regionId,
        name: r.name,
        iso3166_2: r.iso3166_2,
        bbox: null,
        paths: {},
        counts: {},
        total_places: 0,
        generated_at: null,
      });
    }

    const obj = perRegion.get(regionId);

    obj.paths[category] = `/data/pois/regions/${base}`;
    obj.counts[category] = count;
    obj.total_places += count;

    // bbox: se non hai core o bbox null, prova a derivarla da questo file
    if (!obj.bbox) {
      const bb = bboxFromPlaces(places);
      if (bb) obj.bbox = bb;
    }

    // generated_at: tieni l’ultimo non-null
    if (json.generated_at) obj.generated_at = json.generated_at;
  }

  // Ordina secondo configs
  const items = regionsCfg.map(r => {
    const regionId = String(r.id);
    const hit = perRegion.get(regionId) || {
      id: regionId,
      name: r.name,
      iso3166_2: r.iso3166_2,
      bbox: null,
      paths: {},
      counts: {},
      total_places: 0,
      generated_at: null,
    };

    // stabilizza ordine categorie (ma conserva anche extra)
    const orderedPaths = {};
    const orderedCounts = {};

    for (const c of CATEGORIES_CANON) {
      if (hit.paths?.[c]) orderedPaths[c] = hit.paths[c];
      if (hit.counts?.[c] != null) orderedCounts[c] = hit.counts[c];
    }

    // extra categorie non canon
    for (const [k, v] of Object.entries(hit.paths || {})) {
      if (!orderedPaths[k]) orderedPaths[k] = v;
    }
    for (const [k, v] of Object.entries(hit.counts || {})) {
      if (orderedCounts[k] == null) orderedCounts[k] = v;
    }

    return {
      id: hit.id,
      name: hit.name,
      iso3166_2: hit.iso3166_2,
      bbox: hit.bbox || null,
      total_places: hit.total_places || 0,
      paths: orderedPaths,
      counts: orderedCounts,
      generated_at: hit.generated_at || null,
    };
  });

  const summary = {
    regions: items.length,
    categories_canon: CATEGORIES_CANON,
    aliases: ALIASES,
    total_files_seen: files.length + regionsCfg.length, // + core file per regione (anche se non tutti esistono)
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
