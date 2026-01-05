#!/usr/bin/env node
/**
 * build_pois_it_region.mjs — Jamo OFFLINE POIs for one IT region (v2)
 *
 * Output:
 * public/data/pois/it/<region>/
 *   family.json, theme_park.json, kids_museum.json, natura.json, storia.json, mare.json,
 *   relax.json, viewpoints.json, hiking.json, montagna.json, borghi.json, citta.json,
 *   index.json
 *
 * Features:
 * - Overpass endpoint fallback + per-query timeout + retries
 * - Tiered queries per category (CORE -> SECONDARY -> FALLBACK)
 * - Produces "places" compatible with app.js (name/lat/lon/type/tags/visibility/beauty_score/country/area)
 * - Writes a rich index.json (files/categories/counts/basePath)
 */

import fs from "fs/promises";
import path from "path";
import process from "process";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

const TIMEOUT_MS = 25_000;
const RETRIES = 2;          // per endpoint
const PAUSE_MS = 1200;      // base pause between categories
const MAX_PER_CAT = 9000;   // safety cap

// -------------------- utils --------------------
function arg(name) {
  const a = process.argv.find(v => v.startsWith(`--${name}=`));
  return a ? a.split("=")[1] : null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normName(s) {
  return String(s ?? "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function uniqByTypeId(elements) {
  const seen = new Set();
  const out = [];
  for (const e of elements || []) {
    const k = `${e.type}:${e.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

function overpassBody(q) {
  return `data=${encodeURIComponent(q)}`;
}

async function fetchWithTimeout(url, { method = "POST", body, headers = {} } = {}, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", ...headers },
      body,
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json().catch(() => null);
    if (!j) throw new Error("Bad JSON");
    return j;
  } finally {
    clearTimeout(t);
  }
}

// Run a list of queries with endpoint fallback; keep partial results
async function runTieredQueries(queries, { softEnough = 250 } = {}) {
  const notes = [];
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const results = [];
    let failed = 0;

    for (let qi = 0; qi < queries.length; qi++) {
      const q = queries[qi];

      let ok = false;
      for (let r = 0; r <= RETRIES; r++) {
        try {
          const j = await fetchWithTimeout(endpoint, { method: "POST", body: overpassBody(q) }, TIMEOUT_MS);
          results.push(j);
          ok = true;
          break;
        } catch (e) {
          if (r === RETRIES) {
            failed++;
            notes.push(`q${qi}_fail:${String(e?.message || e)}`);
          } else {
            await sleep(700 + r * 400);
          }
        }
      }

      const mergedSoFar = mergeElements(results);
      if (mergedSoFar.length >= softEnough && qi <= 1) {
        return { ok: true, endpoint, elements: mergedSoFar, notes: notes.concat([`early_stop_at_${qi}`, `failed:${failed}`]) };
      }

      // tiny pause between tier queries
      if (ok) await sleep(250);
    }

    const elements = mergeElements(results);
    if (elements.length > 0) {
      return { ok: true, endpoint, elements, notes: notes.concat([`partial_ok_failed:${failed}`]) };
    }

    notes.push(`endpoint_empty_failed:${failed}`);
    // try next endpoint
  }

  return { ok: false, endpoint: "", elements: [], notes };
}

function mergeElements(results) {
  const seen = new Set();
  const out = [];
  for (const j of results) {
    const els = Array.isArray(j?.elements) ? j.elements : [];
    for (const el of els) {
      const key = `${el.type}:${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(el);
    }
  }
  return out;
}

// -------------------- region --------------------
const regionId = arg("region");
if (!regionId) {
  console.error("❌ Missing --region argument (example: --region=it-abruzzo)");
  process.exit(1);
}

const regionPath = `public/data/regions/${regionId}.json`;
const region = JSON.parse(await fs.readFile(regionPath, "utf8"));

if (!Array.isArray(region.bbox) || region.bbox.length !== 4) {
  console.error("❌ Region JSON must contain bbox: [minLon, minLat, maxLon, maxLat]");
  process.exit(1);
}
const [minLon, minLat, maxLon, maxLat] = region.bbox;

const outDir = `public/data/pois/it/${regionId}`;
await fs.mkdir(outDir, { recursive: true });

console.log(`🗺️  Building OFFLINE POIs for ${region.name} (${regionId})`);
console.log(`📦 bbox: [${minLon}, ${minLat}, ${maxLon}, ${maxLat}]`);

// -------------------- tiered query builder --------------------
function bboxBlock() {
  return `(${minLat},${minLon},${maxLat},${maxLon})`;
}

function wrapQuery(inner, timeout = 25, outLine = "out tags center;") {
  return `
[out:json][timeout:${timeout}];
(
  ${inner}
)${bboxBlock()};
${outLine}
  `.trim();
}

function buildTiered(cat) {
  // Avoid dumping gigantic "parks" results
  const PARKS_FILTERED = `
node[leisure=park]["name"~"avventura|faunistico|safari|botanico|giardino|parco naturale|riserva|cascat(a|e)|lago",i];
way[leisure=park]["name"~"avventura|faunistico|safari|botanico|giardino|parco naturale|riserva|cascat(a|e)|lago",i];
  `.trim();

  if (cat === "theme_park") {
    const CORE = wrapQuery(`
node[tourism=theme_park];
way[tourism=theme_park];
node[leisure=water_park];
way[leisure=water_park];
node[leisure=amusement_arcade];
node["name"~"parco divertimenti|lunapark|luna\\s?park|parco acquatico|acquapark|aqua\\s?park|water\\s?park|giostre",i];
    `, 25, "out tags center 650;");

    const SECONDARY = wrapQuery(`
node[tourism=attraction]["name"~"parco divertimenti|lunapark|giostre|water\\s?park|acquapark|aqua\\s?park",i];
node[tourism=attraction][leisure=water_park];
    `, 20, "out tags center 350;");

    return { queries: [CORE, SECONDARY], softEnough: 120 };
  }

  if (cat === "kids_museum") {
    const CORE = wrapQuery(`
node[tourism=museum]["name"~"bambin|kids|children|ragazz|interattiv|science|planetari|museo dei bambini|children\\s?museum|science\\s?center",i];
node["name"~"museo dei bambini|children\\s?museum|science\\s?center|planetari|planetarium",i];
    `, 25, "out tags center 650;");

    const SECONDARY = wrapQuery(`
node[tourism=museum];
    `, 20, "out tags center 350;");

    return { queries: [CORE, SECONDARY], softEnough: 140 };
  }

  if (cat === "viewpoints") {
    const CORE = wrapQuery(`
node[tourism=viewpoint];
node["name"~"belvedere|panoram|viewpoint|scenic|terrazza|vista",i];
    `, 25, "out tags center 700;");

    const SECONDARY = wrapQuery(`
node["tourism"="attraction"]["name"~"panoram|belvedere|vista",i];
node[natural=peak];
    `, 20, "out tags center 350;");

    return { queries: [CORE, SECONDARY], softEnough: 220 };
  }

  if (cat === "hiking") {
    const CORE = wrapQuery(`
node[information=guidepost];
node[amenity=shelter];
node["name"~"sentiero|trail|trek|trekking|hike|hiking|via\\s?ferrata|rifugio|anello",i];
    `, 25, "out tags center 700;");

    const SECONDARY = wrapQuery(`
node[natural=peak];
node[tourism=viewpoint];
    `, 20, "out tags center 350;");

    return { queries: [CORE, SECONDARY], softEnough: 260 };
  }

  if (cat === "relax") {
    const CORE = wrapQuery(`
node[amenity=spa];
node[leisure=spa];
node[natural=hot_spring];
node[amenity=public_bath];
node["sauna"="yes"];
node["thermal"="yes"];
node["name"~"terme|spa|thermal|benessere",i];
    `, 25, "out tags center 450;");

    const SECONDARY = wrapQuery(`
node[leisure=swimming_pool];
node[amenity=swimming_pool];
node["sport"="swimming"];
node["tourism"="resort"];
node["tourism"="hotel"]["spa"="yes"];
    `, 20, "out tags center 350;");

    return { queries: [CORE, SECONDARY], softEnough: 240 };
  }

  if (cat === "family") {
    const CORE = wrapQuery(`
node[tourism=theme_park];
way[tourism=theme_park];
node[leisure=water_park];
way[leisure=water_park];
node[tourism=zoo];
way[tourism=zoo];
node[tourism=aquarium];
node[amenity=aquarium];
node[tourism=attraction];
node[leisure=amusement_arcade];
node["name"~"parco divertimenti|parco acquatico|acquapark|aqua\\s?park|water\\s?park|luna\\s?park|zoo|acquario|giostre|museo dei bambini|children\\s?museum|science\\s?center|planetari",i];
    `, 25, "out tags center 650;");

    const SECONDARY = wrapQuery(`
node[leisure=playground];
way[leisure=playground];
node[leisure=trampoline_park];
node["name"~"parco\\s?giochi|area\\s?giochi|gonfiabil|trampolin|kids|bambin|family",i];
node["name"~"parco\\s?avventura|avventura|fattoria|didattica|safari|faunistico",i];
node[amenity=cinema];
node[amenity=bowling_alley];
    `, 22, "out tags center 450;");

    const FALLBACK = wrapQuery(`
node[amenity=spa];
node[natural=hot_spring];
node[leisure=swimming_pool];
node[amenity=swimming_pool];
    `, 18, "out tags center 300;");

    const PARKS = wrapQuery(PARKS_FILTERED, 18, "out tags center 350;");

    return { queries: [CORE, SECONDARY, FALLBACK, PARKS], softEnough: 260 };
  }

  if (cat === "mare") {
    const CORE = wrapQuery(`
node[natural=beach];
way[natural=beach];
node["name"~"spiaggia|lido|baia|mare",i];
node[leisure=marina];
    `, 25, "out tags center 650;");

    const SECONDARY = wrapQuery(`
node[tourism=viewpoint];
node[amenity=restaurant]["name"~"lido|spiaggia|mare",i];
    `, 18, "out tags center 300;");

    return { queries: [CORE, SECONDARY], softEnough: 160 };
  }

  if (cat === "natura") {
    const CORE = wrapQuery(`
node[natural=waterfall];
node[natural=peak];
node[natural=spring];
node[leisure=nature_reserve];
way[leisure=nature_reserve];
node[boundary=national_park];
way[boundary=national_park];
node["name"~"cascata|lago|gola|riserva|parco naturale|sentiero|eremo",i];
    `, 25, "out tags center 750;");

    const SECONDARY = wrapQuery(`
node[tourism=viewpoint];
node["tourism"="attraction"]["name"~"cascata|lago|gola|panoram|belvedere",i];
    `, 20, "out tags center 350;");

    const PARKS = wrapQuery(PARKS_FILTERED, 18, "out tags center 350;");

    return { queries: [CORE, SECONDARY, PARKS], softEnough: 260 };
  }

  if (cat === "storia") {
    const CORE = wrapQuery(`
node[historic=castle];
way[historic=castle];
node[historic=ruins];
node[historic=archaeological_site];
node[tourism=museum];
node[historic=monument];
node[historic=memorial];
node["name"~"castello|rocca|forte|abbazia|museo|anfiteatro|tempio|scavi|necropol|eremo|centro\\s?storico",i];
    `, 25, "out tags center 800;");

    const SECONDARY = wrapQuery(`
node["tourism"="attraction"]["historic"];
node["name"~"centro\\s?storico|citta\\s?vecchia|borgo\\s?antico",i];
    `, 20, "out tags center 350;");

    return { queries: [CORE, SECONDARY], softEnough: 220 };
  }

  if (cat === "borghi") {
    const CORE = wrapQuery(`
node[place=village];
node[place=hamlet];
node["name"~"borgo|castel|rocca|monte|san\\s",i];
    `, 22, "out tags center 600;");

    const SECONDARY = wrapQuery(`
node["name"~"centro\\s?storico|borgo\\s?antico",i];
    `, 18, "out tags center 250;");

    return { queries: [CORE, SECONDARY], softEnough: 260 };
  }

  if (cat === "citta") {
    const CORE = wrapQuery(`
node[place=city];
node[place=town];
node["name"~"centro|piazza|duomo",i];
node[tourism=attraction];
    `, 22, "out tags center 600;");

    const SECONDARY = wrapQuery(`
node[tourism=museum];
node[historic=monument];
    `, 18, "out tags center 300;");

    return { queries: [CORE, SECONDARY], softEnough: 260 };
  }

  if (cat === "montagna") {
    const CORE = wrapQuery(`
node[natural=peak];
node["name"~"monte|cima|passo|rifugio",i];
node[tourism=viewpoint];
node[amenity=shelter];
    `, 22, "out tags center 650;");

    return { queries: [CORE], softEnough: 240 };
  }

  // default
  const CORE = wrapQuery(`
node[tourism=attraction];
node[tourism=viewpoint];
node[tourism=museum];
node[historic=castle];
node[natural=waterfall];
node[natural=beach];
node[amenity=spa];
node["name"~"castello|rocca|museo|cascata|lago|terme|spa|spiaggia|belvedere|panorama|zoo|acquario|parco\\s?divertimenti|acquapark",i];
  `, 25, "out tags center 900;");

  return { queries: [CORE], softEnough: 300 };
}

// -------------------- map to Jamo place --------------------
function typeFromCat(cat) {
  // app.js matchesCategory() expects these words in place.type:
  // family, storia, mare, natura, relax, borghi, citta, montagna
  // plus extras we support: theme_park, kids_museum, viewpoints, hiking
  return cat;
}

function buildTagsArray(tagsObj = {}) {
  // Convert tags object to compact array of "k=v" (help app-side matchers)
  const allow = ["tourism","leisure","historic","natural","amenity","place","sport","boundary"];
  const out = [];
  for (const k of allow) {
    if (tagsObj[k] != null) out.push(`${k}=${tagsObj[k]}`);
  }
  if (tagsObj.attraction) out.push("attraction");
  if (tagsObj.spa) out.push("spa");
  return Array.from(new Set(out)).slice(0, 14);
}

function toPlace(el, cat, region) {
  const tags = el?.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";
  const cleaned = normName(name);
  if (!cleaned || cleaned.length < 2) return null;

  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    id: `poi_${cat}_${el.type}_${el.id}`,
    name: String(name).trim(),
    lat,
    lon,
    country: region.country || "IT",
    area: region.name || "",
    type: typeFromCat(cat),
    visibility: "classica",
    tags: buildTagsArray(tags),
    beauty_score: 0.72
  };
}

// -------------------- build --------------------
const CATEGORY_ORDER = [
  "family","theme_park","kids_museum","storia","natura","mare","relax",
  "viewpoints","hiking","montagna","borghi","citta"
];

const files = {};
const counts = {};

for (const cat of CATEGORY_ORDER) {
  console.log(`\n🔹 Fetch category: ${cat}`);

  const { queries, softEnough } = buildTiered(cat);
  const r = await runTieredQueries(queries, { softEnough });

  if (!r.ok) {
    console.error(`❌ ${cat}: failed on all endpoints`);
    files[cat] = `${cat}.json`;
    counts[cat] = 0;
    // still write empty file to keep app stable
    await fs.writeFile(path.join(outDir, `${cat}.json`), JSON.stringify({ places: [] }, null, 2));
    await sleep(PAUSE_MS);
    continue;
  }

  const els = uniqByTypeId(r.elements || []);
  let places = els.map(el => toPlace(el, cat, region)).filter(Boolean);

  // safety cap
  if (places.length > MAX_PER_CAT) places = places.slice(0, MAX_PER_CAT);

  // de-dup by (name + coords)
  const seen = new Set();
  const uniqPlaces = [];
  for (const p of places) {
    const k = `${p.name.toLowerCase()}_${String(p.lat).slice(0,6)}_${String(p.lon).slice(0,6)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniqPlaces.push(p);
  }

  files[cat] = `${cat}.json`;
  counts[cat] = uniqPlaces.length;

  await fs.writeFile(
    path.join(outDir, `${cat}.json`),
    JSON.stringify({ places: uniqPlaces, meta: { region: regionId, cat, endpoint: r.endpoint, notes: r.notes || [] } }, null, 2)
  );

  console.log(`✅ ${cat}: ${uniqPlaces.length} places (endpoint: ${r.endpoint})`);
  await sleep(PAUSE_MS);
}

// -------------------- index.json (rich) --------------------
const index = {
  region: regionId,
  name: region.name,
  country: region.country || "IT",
  generatedAt: new Date().toISOString(),
  basePath: "/data/pois/it/" + regionId,
  files,
  categories: CATEGORY_ORDER,
  counts
};

await fs.writeFile(path.join(outDir, "index.json"), JSON.stringify(index, null, 2));
console.log("\n🎉 DONE");
