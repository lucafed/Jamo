// scripts/build_pois_it_region.mjs
// Build POIs per una regione IT (bbox) e categorie.
// Uso:
//   node scripts/build_pois_it_region.mjs --region it-abruzzo
// Opzioni:
//   --region it-abruzzo         (file in public/data/regions/it-abruzzo.json)
//   --out public/data/pois/it   (default)
//   --cats family,natura,mare,storia,relax,borghi,citta,montagna,viewpoints,hiking,theme_park,kids_museum
//   --dry                       (non scrive file)
//
// Output:
//   public/data/pois/it/<region>/<cat>.json
//   public/data/pois/it/<region>/index.json
//
// Node 20 ESM. Nessuna dipendenza.

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const REGIONS_DIR = path.join(ROOT, "public/data/regions");

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

function argValue(name, def = null) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return def;
}
const DRY = process.argv.includes("--dry");
const REGION_SLUG = argValue("--region", "it-abruzzo"); // file base name (senza .json)
const OUT_ROOT = path.join(ROOT, argValue("--out", "public/data/pois/it"));

const catsArg = argValue(
  "--cats",
  "family,theme_park,kids_museum,natura,mare,storia,relax,montagna,viewpoints,hiking,borghi,citta"
);
const CATS = catsArg.split(",").map(s => s.trim()).filter(Boolean);

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowIso() { return new Date().toISOString(); }

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

async function fetchWithTimeout(url, body, timeoutMs = 65000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body,
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json().catch(() => null);
    if (!j) throw new Error("Bad JSON");
    return j;
  } finally {
    clearTimeout(t);
  }
}

function opBody(query) { return `data=${encodeURIComponent(query)}`; }

// Legge bbox da file region
function readRegionBBox(regionSlug) {
  const file = path.join(REGIONS_DIR, `${regionSlug}.json`);
  if (!fs.existsSync(file)) throw new Error(`Region file not found: ${file}`);

  const j = JSON.parse(fs.readFileSync(file, "utf8"));

  // Supporta varie strutture possibili:
  // - { bbox: { south, west, north, east } }
  // - { bbox: [west,south,east,north] }
  // - { bounds: { minLat, minLon, maxLat, maxLon } }
  let south, west, north, east;

  if (j?.bbox && Array.isArray(j.bbox) && j.bbox.length === 4) {
    [west, south, east, north] = j.bbox;
  } else if (j?.bbox && typeof j.bbox === "object") {
    south = j.bbox.south ?? j.bbox.minLat ?? j.bbox.min_lat;
    west  = j.bbox.west  ?? j.bbox.minLon ?? j.bbox.min_lon;
    north = j.bbox.north ?? j.bbox.maxLat ?? j.bbox.max_lat;
    east  = j.bbox.east  ?? j.bbox.maxLon ?? j.bbox.max_lon;
  } else if (j?.bounds && typeof j.bounds === "object") {
    south = j.bounds.minLat; west = j.bounds.minLon; north = j.bounds.maxLat; east = j.bounds.maxLon;
  }

  const nums = [south, west, north, east].map(Number);
  if (!nums.every(Number.isFinite)) {
    throw new Error(`Invalid bbox in ${REGION_SLUG}.json. Need south/west/north/east numbers.`);
  }
  return { south: nums[0], west: nums[1], north: nums[2], east: nums[3], raw: j };
}

function bboxClause(b) {
  // Overpass bbox: (south,west,north,east)
  return `(${b.south},${b.west},${b.north},${b.east})`;
}

// --- Query templates (piccole, mirate) ---
// Nota: usiamo nwr=nodes+ways+relations, poi out center per ways.
// Manteniamo query “a blocchi” per evitare overload.
const CAT_QUERIES = {
  family: (BB) => `
(
  nwr["tourism"="theme_park"]${BB};
  nwr["leisure"="water_park"]${BB};
  nwr["tourism"="zoo"]${BB};
  nwr["tourism"="aquarium"]${BB};
  nwr["amenity"="aquarium"]${BB};

  nwr["tourism"="museum"]["name"~"bambin|kids|children|museo dei bambini|children\\s?museum|science\\s?center|planetari|planetarium|interattiv",i]${BB};

  nwr["tourism"="attraction"]["name"~"parco\\s?divertimenti|lunapark|luna\\s?park|giostre|acquapark|aqua\\s?park|water\\s?park|parco\\s?acquatico|parco\\s?avventura|fattoria|didattic|faunistico|safari",i]${BB};

  // playground SOLO se ha name (meno rumore)
  nwr["leisure"="playground"]["name"]${BB};
);
`.trim(),

  theme_park: (BB) => `
(
  nwr["tourism"="theme_park"]${BB};
  nwr["leisure"="water_park"]${BB};
  nwr["tourism"="attraction"]["name"~"parco\\s?divertimenti|lunapark|luna\\s?park|giostre|acquapark|aqua\\s?park|water\\s?park|parco\\s?acquatico",i]${BB};
  nwr["leisure"="amusement_arcade"]["name"]${BB};
);
`.trim(),

  kids_museum: (BB) => `
(
  nwr["tourism"="museum"]["name"~"bambin|kids|children|museo dei bambini|children\\s?museum|science\\s?center|planetari|planetarium|interattiv",i]${BB};
  nwr["tourism"="attraction"]["name"~"museo dei bambini|children\\s?museum|science\\s?center|planetari|planetarium|interattiv",i]${BB};
);
`.trim(),

  natura: (BB) => `
(
  nwr["natural"="waterfall"]${BB};
  nwr["natural"="spring"]${BB};
  nwr["natural"="peak"]${BB};
  nwr["leisure"="nature_reserve"]${BB};
  nwr["boundary"="national_park"]${BB};
  nwr["natural"="cave_entrance"]${BB};
  nwr["name"~"cascata|lago|gola|orrido|riserva|parco\\s?naturale|eremo",i]${BB};
);
`.trim(),

  mare: (BB) => `
(
  nwr["natural"="beach"]${BB};
  nwr["leisure"="marina"]${BB};
  nwr["name"~"spiaggia|lido|baia|mare|costa",i]${BB};
);
`.trim(),

  storia: (BB) => `
(
  nwr["historic"="castle"]${BB};
  nwr["historic"="ruins"]${BB};
  nwr["historic"="archaeological_site"]${BB};
  nwr["tourism"="museum"]${BB};
  nwr["historic"="monument"]${BB};
  nwr["historic"="memorial"]${BB};
  nwr["historic"="fort"]${BB};
  nwr["amenity"="place_of_worship"]["name"~"abbazia|cattedrale|basilica|duomo|santuario|monastero",i]${BB};
);
`.trim(),

  relax: (BB) => `
(
  nwr["amenity"="spa"]${BB};
  nwr["leisure"="spa"]${BB};
  nwr["natural"="hot_spring"]${BB};
  nwr["amenity"="public_bath"]${BB};
  nwr["thermal"="yes"]${BB};
  nwr["name"~"terme|spa|benessere|thermal",i]${BB};
);
`.trim(),

  montagna: (BB) => `
(
  nwr["natural"="peak"]${BB};
  nwr["tourism"="alpine_hut"]${BB};
  nwr["amenity"="shelter"]${BB};
  nwr["tourism"="viewpoint"]${BB};
  nwr["name"~"monte|cima|passo|rifugio",i]${BB};
);
`.trim(),

  viewpoints: (BB) => `
(
  nwr["tourism"="viewpoint"]${BB};
  nwr["name"~"belvedere|panoram|terrazza|vista|viewpoint|scenic",i]${BB};
);
`.trim(),

  hiking: (BB) => `
(
  nwr["information"="guidepost"]${BB};
  nwr["route"="hiking"]["name"]${BB};
  nwr["amenity"="shelter"]${BB};
  nwr["name"~"sentiero|trail|trek|trekking|hike|hiking|via\\s?ferrata|anello",i]${BB};
);
`.trim(),

  borghi: (BB) => `
(
  nwr["place"="hamlet"]["name"]${BB};
  nwr["place"="village"]["name"]${BB};
  nwr["name"~"borgo|borgo\\s?antico|centro\\s?storico|castel|rocca",i]${BB};
);
`.trim(),

  citta: (BB) => `
(
  nwr["place"="city"]["name"]${BB};
  nwr["place"="town"]["name"]${BB};
  nwr["tourism"="attraction"]["name"~"centro|piazza|duomo",i]${BB};
);
`.trim(),
};

function buildQuery(catKey, bbox) {
  const BB = bboxClause(bbox);
  const inner = CAT_QUERIES[catKey] ? CAT_QUERIES[catKey](BB) : null;
  if (!inner) throw new Error(`Unknown category: ${catKey}`);

  // Limite per evitare dataset enormi (soprattutto borghi/citta)
  // Overpass: out ...; (no built-in "limit" su out, ma possiamo filtrare bene con name già fatto)
  return `
[out:json][timeout:150];
${inner}
out tags center;
`.trim();
}

function mapElementToPlace(el, catKey, regionSlug) {
  const tags = el?.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";
  const cleanedName = String(name || "").trim();
  if (!cleanedName || cleanedName.length < 2) return null;

  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const tagList = [];
  const pushKV = (k) => { if (tags[k] != null) tagList.push(`${k}=${tags[k]}`); };
  ["tourism","leisure","historic","natural","amenity","information","place","boundary","route","waterway"].forEach(pushKV);
  if (tags.attraction) tagList.push("attraction");

  const nm = norm(cleanedName);
  const hasBrandish = !!(tags.brand || tags.operator);
  const chiccaHint =
    !hasBrandish &&
    (nm.includes("gola") || nm.includes("cascata") || nm.includes("eremo") || nm.includes("orrido") ||
     nm.includes("riserva") || nm.includes("belvedere") || nm.includes("sentiero") || nm.includes("borgo"));

  const visibility = chiccaHint ? "chicca" : "classica";

  const ideal_for = (() => {
    const out = new Set();
    if (catKey === "family" || catKey === "theme_park" || catKey === "kids_museum") { out.add("famiglie"); out.add("bambini"); }
    if (catKey === "storia") out.add("storia");
    if (catKey === "mare") out.add("mare");
    if (catKey === "natura" || catKey === "hiking" || catKey === "viewpoints" || catKey === "montagna") out.add("natura");
    if (catKey === "relax") out.add("relax");
    if (catKey === "borghi") out.add("borghi");
    if (catKey === "citta") out.add("citta");
    return [...out];
  })();

  const family_level =
    (catKey === "family" || catKey === "theme_park" || catKey === "kids_museum") ? "high" : "low";

  return {
    id: `poi_${regionSlug}_${catKey}_${el.type}_${el.id}`,
    name: cleanedName,
    lat,
    lon,
    country: "IT",
    area: regionSlug,
    type: catKey,
    primary_category: catKey,
    ideal_for,
    family_level,
    visibility,
    tags: Array.from(new Set(tagList)).slice(0, 22),
    beauty_score: visibility === "chicca" ? 0.78 : 0.72,
    live: false,
    source: "overpass_build_region",
  };
}

function dedupPlaces(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const k = `${norm(p.name)}_${String(p.lat).slice(0, 6)}_${String(p.lon).slice(0, 6)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

async function runOverpass(query) {
  const body = opBody(query);
  let lastErr = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const j = await fetchWithTimeout(endpoint, body, 65000);
        return { ok: true, endpoint, json: j };
      } catch (e) {
        lastErr = e;
        await sleep(900 * attempt);
      }
    }
    await sleep(1200);
  }
  return { ok: false, endpoint: "", json: null, error: String(lastErr?.message || lastErr) };
}

function writeJson(file, obj) {
  if (DRY) return;
  fs.writeFileSync(file, JSON.stringify(obj), "utf8");
}

async function main() {
  const bbox = readRegionBBox(REGION_SLUG);
  const regionOutDir = path.join(OUT_ROOT, REGION_SLUG);
  ensureDir(regionOutDir);

  console.log("🧩 Build POIs region:", REGION_SLUG);
  console.log("📦 Output dir:", regionOutDir);
  console.log("🧭 BBox:", bbox.south, bbox.west, bbox.north, bbox.east);
  console.log("🗂️ Categories:", CATS.join(", "));
  console.log("DRY:", DRY);

  const metaBase = {
    built_at: nowIso(),
    scope: "IT",
    region: REGION_SLUG,
    bbox: { south: bbox.south, west: bbox.west, north: bbox.north, east: bbox.east },
    notes: [],
  };

  const index = {
    meta: metaBase,
    files: [],
    counts: {},
    total: 0,
  };

  let totalAll = 0;

  for (const catKey of CATS) {
    console.log(`🛰️ Fetch category: ${catKey}`);

    let places = [];
    let endpoint = "";
    let ok = false;

    try {
      const q = buildQuery(catKey, bbox);
      const r = await runOverpass(q);

      if (!r.ok || !r.json) {
        console.log(`❌ ${catKey} failed: ${r.error || "fetch failed"}`);
        metaBase.notes.push(`fail_${catKey}`);
      } else {
        ok = true;
        endpoint = r.endpoint;
        const els = Array.isArray(r.json.elements) ? r.json.elements : [];
        places = dedupPlaces(els.map(el => mapElementToPlace(el, catKey, REGION_SLUG)).filter(Boolean));
        console.log(`✅ ${catKey}: ${places.length} items (endpoint: ${endpoint})`);
      }
    } catch (e) {
      console.log(`❌ ${catKey} build error: ${String(e?.message || e)}`);
      metaBase.notes.push(`error_${catKey}`);
    }

    // scrivi sempre un file (anche vuoto)
    const outFile = path.join(regionOutDir, `${catKey}.json`);
    writeJson(outFile, {
      meta: { ...metaBase, category: catKey, ok, endpoint },
      places,
    });

    index.counts[catKey] = places.length;
    index.files.push({
      category: catKey,
      path: `/data/pois/it/${REGION_SLUG}/${catKey}.json`,
      count: places.length,
      ok,
    });

    totalAll += places.length;

    // throttle tra categorie
    await sleep(900);
  }

  index.total = totalAll;

  writeJson(path.join(regionOutDir, "index.json"), index);

  console.log(`🎉 DONE ${REGION_SLUG}: total=${totalAll}`);
  if (DRY) console.log("ℹ️ DRY mode: niente file scritti.");
}

main().catch((e) => {
  console.error("❌ build failed:", e);
  process.exit(1);
});
