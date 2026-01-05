#!/usr/bin/env node
/**
 * build_pois_area.mjs
 *
 * Costruisce POI offline per UNA area definita in public/data/areas.json
 * Schema areas.json (tuo):
 *  { version, updated_at, areas:[ {id, name, country, bbox:{minLat,minLon,maxLat,maxLon}, neighbors:[], macro_out } ] }
 *
 * Output:
 *  public/data/pois/areas/<areaId>/{family,natura,storia,mare,relax,borghi,citta}.json
 *  public/data/pois/areas/<areaId>/index.json  (items + counts + meta)
 *
 * Uso:
 *  node scripts/build_pois_area.mjs --area=it_abruzzo
 */

import fs from "fs/promises";
import path from "path";
import process from "process";

const ROOT = process.cwd();

const AREAS_PATH = path.join(ROOT, "public/data/areas.json");
const OUT_ROOT = path.join(ROOT, "public/data/pois/areas");

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter"
];

const TIMEOUT_MS = 35_000;
const PER_QUERY_SLEEP_MS = 900;

function arg(name) {
  const a = process.argv.find(v => v.startsWith(`--${name}=`));
  return a ? a.split("=")[1] : null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

async function fetchOverpass(endpoint, query) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: `data=${encodeURIComponent(query)}`,
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

async function queryWithFallback(query) {
  let lastErr = null;
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      const json = await fetchOverpass(ep, query);
      return { ok: true, endpoint: ep, json };
    } catch (e) {
      lastErr = e;
    }
    await sleep(450);
  }
  return { ok: false, endpoint: "", json: { elements: [] }, error: String(lastErr?.message || lastErr) };
}

function uniqElements(elements) {
  const seen = new Set();
  const out = [];
  for (const e of (elements || [])) {
    const k = `${e.type}:${e.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

function mapElementToPlace(e, cat) {
  const tags = e.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || null;
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;

  if (!name || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;

  // tags compatibili con app.js (stringhe k=v)
  const tagList = [];
  const pushKV = (k) => { if (tags[k] != null) tagList.push(`${k}=${tags[k]}`); };

  pushKV("tourism");
  pushKV("leisure");
  pushKV("historic");
  pushKV("natural");
  pushKV("amenity");
  pushKV("place");
  if (tags.attraction) tagList.push("attraction");

  return {
    id: `pois_${cat}_${e.type}_${e.id}`,
    name: String(name).trim(),
    lat: Number(lat),
    lon: Number(lon),
    type: cat,                 // IMPORTANT: categoria = type
    visibility: "classica",
    tags: Array.from(new Set(tagList)).slice(0, 14),
    beauty_score: 0.72
  };
}

/**
 * Categorie coerenti:
 * - family: attrazioni vere + kids place (playground incluso come secondario)
 * - natura: viewpoint + waterfalls + parks/national_park/nature_reserve
 * - storia: castelli/musei/monumenti + centro storico (solo come POI, non città random)
 * - mare: beach + marina + name match
 * - relax: spa/terme/hot_spring
 * - borghi/citta: place nodes
 */
const CATEGORIES = {
  family: `
    node[tourism=theme_park];
    way[tourism=theme_park];
    node[leisure=water_park];
    way[leisure=water_park];
    node[tourism=zoo];
    way[tourism=zoo];
    node[tourism=aquarium];
    node[amenity=aquarium];
    node[leisure=amusement_arcade];
    node[leisure=trampoline_park];
    node[leisure=playground];
    way[leisure=playground];
    node[tourism=attraction]["name"~"parco divertimenti|acquapark|aqua\\s?park|water\\s?park|zoo|acquario|planetari|children\\s?museum|museo dei bambini|science\\s?center|parco avventura|fattoria didattica|faunistico|safari",i];
  `,
  natura: `
    node[natural=waterfall];
    node[natural=peak];
    node[natural=spring];
    node[tourism=viewpoint];
    node[leisure=nature_reserve];
    way[leisure=nature_reserve];
    node[boundary=national_park];
    way[boundary=national_park];
    node["name"~"cascata|lago|gola|riserva|parco naturale|belvedere|panoram|sentiero",i];
  `,
  storia: `
    node[historic=castle];
    way[historic=castle];
    node[historic=ruins];
    node[historic=archaeological_site];
    node[tourism=museum];
    node[historic=monument];
    node[historic=memorial];
    node[tourism=attraction]["name"~"castello|rocca|forte|abbazia|museo|anfiteatro|scavi|necropol|centro\\s?storico",i];
  `,
  mare: `
    node[natural=beach];
    way[natural=beach];
    node[leisure=marina];
    node["name"~"spiaggia|lido|baia|mare",i];
  `,
  relax: `
    node[amenity=spa];
    node[leisure=spa];
    node[natural=hot_spring];
    node[amenity=public_bath];
    node["name"~"terme|spa|thermal|benessere",i];
  `,
  borghi: `
    node[place=village];
    node[place=hamlet];
    node["name"~"borgo|castel|rocca|monte\\s|san\\s",i];
  `,
  citta: `
    node[place=city];
    node[place=town];
  `
};

function makeQuery(bbox, body) {
  const timeout = 25;
  const minLat = bbox.minLat, minLon = bbox.minLon, maxLat = bbox.maxLat, maxLon = bbox.maxLon;

  return `
[out:json][timeout:${timeout}];
(
  ${body}
)(${minLat},${minLon},${maxLat},${maxLon});
out tags center;
  `.trim();
}

// -------------------- MAIN --------------------
const areaId = arg("area");
if (!areaId) {
  console.error("❌ Missing --area argument (example: --area=it_abruzzo)");
  process.exit(1);
}

const rawAreas = await fs.readFile(AREAS_PATH, "utf8");
const areasJson = JSON.parse(rawAreas);
const areas = Array.isArray(areasJson?.areas) ? areasJson.areas : [];

const area = areas.find(a => a.id === areaId);
if (!area) {
  console.error(`❌ Area not found in areas.json: ${areaId}`);
  process.exit(1);
}

const bbox = area.bbox || {};
if (![bbox.minLat, bbox.minLon, bbox.maxLat, bbox.maxLon].every(Number.isFinite)) {
  console.error("❌ Area bbox invalid. Expected bbox:{minLat,minLon,maxLat,maxLon}");
  process.exit(1);
}

// clamp sanity (avoid reversed)
bbox.minLat = Math.min(bbox.minLat, bbox.maxLat);
bbox.maxLat = Math.max(bbox.minLat, bbox.maxLat);
bbox.minLon = Math.min(bbox.minLon, bbox.maxLon);
bbox.maxLon = Math.max(bbox.minLon, bbox.maxLon);

// output dir
const outDir = path.join(OUT_ROOT, areaId);
await fs.mkdir(outDir, { recursive: true });

console.log(`🗺️  Building POIs for area: ${areaId} — ${area.name} (${area.country})`);
console.log(`   bbox: [${bbox.minLat},${bbox.minLon}] -> [${bbox.maxLat},${bbox.maxLon}]`);

const counts = {};
const items = [];
let usedEndpoint = "";
const notes = [];

for (const [cat, body] of Object.entries(CATEGORIES)) {
  console.log(`🔹 Fetch ${cat}`);

  const q = makeQuery(bbox, body);
  const r = await queryWithFallback(q);
  if (r.ok) usedEndpoint = usedEndpoint || r.endpoint;

  const els = uniqElements(r.json?.elements || []);
  const places = els.map(e => mapElementToPlace(e, cat)).filter(Boolean);

  // cap per evitare file assurdi (ma comunque “tanti”)
  const capped = places.slice(0, 8000);

  const fileName = `${cat}.json`;
  const filePath = path.join(outDir, fileName);
  await fs.writeFile(filePath, JSON.stringify(capped, null, 2), "utf8");

  counts[cat] = capped.length;
  items.push({
    cat,
    path: `/data/pois/areas/${areaId}/${fileName}`,
    count: capped.length
  });

  if (!r.ok) notes.push(`cat_${cat}_fail:${r.error}`);
  console.log(`   ✅ ${capped.length} items${r.ok ? "" : " (endpoint fail, wrote what we could)"}`);

  await sleep(PER_QUERY_SLEEP_MS);
}

const index = {
  areaId,
  name: area.name,
  country: area.country,
  neighbors: Array.isArray(area.neighbors) ? area.neighbors : [],
  bbox,
  generatedAt: new Date().toISOString(),
  endpoint: usedEndpoint || "",
  counts,
  items,
  notes
};

await fs.writeFile(path.join(outDir, "index.json"), JSON.stringify(index, null, 2), "utf8");
console.log("🎉 DONE");
