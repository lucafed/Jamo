/**
 * build-radius-mare.js
 * Genera dataset "mare" offline (Italia + Europa) da Overpass.
 *
 * Output:
 *  - public/data/pois/regions/radius-mare-it.json
 *  - public/data/pois/regions/radius-mare-eu.json
 *  - public/data/pois/regions/radius-mare.json (merge)
 *
 * NOTE:
 * - Overpass ha limiti: usiamo bbox "tile" e dedupe.
 * - Solo POI costieri "veri": spiagge/baie/scogliere + alcuni viewpoint costieri.
 */

import fs from "fs";
import path from "path";

const OUT_DIR = path.join(process.cwd(), "public/data/pois/regions");
fs.mkdirSync(OUT_DIR, { recursive: true });

// -------------- CONFIG --------------
const OVERPASS = "https://overpass-api.de/api/interpreter";

// BBOX (W,S,E,N) — grossolane ma ok per “radius mare”
// IT: include coste + isole
const BBOX_IT = [6.5, 36.3, 18.7, 47.2];

// EU “larga” (Europa geografica più UK/IE + coste nord)
// Se vuoi più stretto dimmelo, ma così copre bene.
const BBOX_EU = [-11.5, 34.5, 31.8, 71.5];

// Step griglia (gradi). Più piccolo = più preciso ma più chiamate.
const GRID_STEP = 2.5;

// Filtri
const MIN_NAME_LEN = 3;

// Tag “mare vero” (nodi + way + rel)
const SELECTORS = [
  // spiagge e baie
  'nwr["natural"="beach"]',
  'nwr["natural"="bay"]',
  'nwr["natural"="cliff"]',
  'nwr["natural"="reef"]',
  // scogliere/rocce note (spesso su man_made=breakwater NO, quindi evitiamo)
  // resort spiaggia
  'nwr["tourism"="beach_resort"]',
  // swimming area spesso indica spot balneabile
  'nwr["leisure"="swimming_area"]',
  // viewpoint ma SOLO se costiero (lo filtriamo dopo con coastalHeuristic)
  'nwr["tourism"="viewpoint"]',
];

// roba da ESCLUDERE (porti, industria, trasporti)
const NEG_TAG_KEYS = [
  "industrial",
  "landuse",
  "power",
  "man_made",
];

const NEG_TAG_SUBSTR = [
  "harbour",
  "port",
  "dock",
  "shipyard",
  "cargo",
  "terminal",
  "ferry",
  "marina", // marina spesso è “porto turistico”: se la vuoi includere lo togli
];

// -------------- HELPERS --------------
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tileBboxes([w,s,e,n], step) {
  const out = [];
  for (let y = s; y < n; y += step) {
    for (let x = w; x < e; x += step) {
      const w2 = x;
      const s2 = y;
      const e2 = Math.min(e, x + step);
      const n2 = Math.min(n, y + step);
      out.push([w2, s2, e2, n2]);
    }
  }
  return out;
}

function tagsToArray(tags) {
  const arr = [];
  if (!tags) return arr;
  for (const [k,v] of Object.entries(tags)) arr.push(`${k}=${v}`);
  return arr;
}

function isClearlyBad(tags) {
  const t = tags || {};
  const all = Object.entries(t).map(([k,v]) => `${k}=${v}`.toLowerCase());

  // escludi key sospette
  for (const k of NEG_TAG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(t, k)) return true;
  }

  // escludi substring su qualunque tag
  for (const s of NEG_TAG_SUBSTR) {
    if (all.some(x => x.includes(s))) return true;
  }

  // escludi se è trasporto
  if (all.some(x => x.startsWith("highway=") || x.startsWith("railway=") || x.startsWith("public_transport="))) return true;

  return false;
}

// euristica “coastal”: se nel nome/tags c’è roba da mare
function coastalHeuristic(name, tagsArr) {
  const n = norm(name);
  const t = (tagsArr || []).join(" ").toLowerCase();

  const goodName = [
    "spiaggia","beach","plage","playa","strand",
    "cala","baia","bay",
    "scogliera","cliff","falesia",
    "lido","lungomare","promenade",
    "capo","punta","faro","lighthouse",
    "costa","coast",
    "golf","gulf","anse",
  ];

  const goodTags =
    t.includes("natural=beach") ||
    t.includes("natural=bay") ||
    t.includes("natural=cliff") ||
    t.includes("natural=reef") ||
    t.includes("tourism=beach_resort") ||
    t.includes("leisure=swimming_area");

  if (goodTags) return true;
  return goodName.some(w => n.includes(w));
}

function makeId(el) {
  const t = el.type; // node/way/relation
  return `${t}_${el.id}`;
}

function getCenter(el) {
  // Overpass: node ha lat/lon; way/rel spesso ha "center" se richiesto
  if (Number.isFinite(el.lat) && Number.isFinite(el.lon)) return { lat: el.lat, lon: el.lon };
  if (el.center && Number.isFinite(el.center.lat) && Number.isFinite(el.center.lon)) return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

// -------------- OVERPASS --------------
function overpassQueryForBBox([w,s,e,n]) {
  const bbox = `${s},${w},${n},${e}`; // Overpass usa S,W,N,E
  const body = `
[out:json][timeout:120];
(
  ${SELECTORS.map(sel => `${sel}(${bbox});`).join("\n  ")}
);
out center tags;
`;
  return body.trim();
}

async function fetchOverpass(query) {
  const r = await fetch(OVERPASS, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: `data=${encodeURIComponent(query)}`
  });
  if (!r.ok) throw new Error(`Overpass HTTP ${r.status}`);
  return await r.json();
}

async function collectForBBoxRegion(label, bbox) {
  const tiles = tileBboxes(bbox, GRID_STEP);
  const map = new Map(); // id -> place

  for (let i = 0; i < tiles.length; i++) {
    const tbox = tiles[i];
    const q = overpassQueryForBBox(tbox);

    let j;
    try {
      j = await fetchOverpass(q);
    } catch (e) {
      // retry semplice 1 volta
      await new Promise(res => setTimeout(res, 1000));
      j = await fetchOverpass(q);
    }

    const els = Array.isArray(j?.elements) ? j.elements : [];
    for (const el of els) {
      const id = makeId(el);
      const c = getCenter(el);
      if (!c) continue;

      const tags = el.tags || {};
      const name = tags.name || tags["name:it"] || tags["name:en"] || "";

      if (String(name).trim().length < MIN_NAME_LEN) continue;

      const tagsArr = tagsToArray(tags);
      if (isClearlyBad(tags)) continue;

      // se è solo viewpoint, deve “sembrare mare”
      if (tags.tourism === "viewpoint") {
        if (!coastalHeuristic(name, tagsArr)) continue;
      } else {
        // gli altri devono comunque passare euristica (aiuta a pulire)
        if (!coastalHeuristic(name, tagsArr)) continue;
      }

      if (!map.has(id)) {
        map.set(id, {
          id,
          name: String(name).trim(),
          lat: c.lat,
          lon: c.lon,
          type: "mare",
          visibility: "unknown",
          beauty_score: 0.72,
          country: (tags["addr:country"] || "").toUpperCase(),
          area: label,
          tags: tagsArr,
          source: "osm_overpass_mare",
        });
      }
    }

    // mini-pausa per non martellare
    if (i % 8 === 7) await new Promise(res => setTimeout(res, 350));
  }

  return [...map.values()];
}

function writeDataset(file, places, meta = {}) {
  const out = {
    updated_at: new Date().toISOString(),
    count: places.length,
    ...meta,
    places,
  };
  fs.writeFileSync(file, JSON.stringify(out, null, 2), "utf-8");
  console.log(`✅ wrote ${file} (${places.length})`);
}

function mergeUnique(a, b) {
  const map = new Map();
  for (const x of [...a, ...b]) map.set(x.id, x);
  return [...map.values()];
}

// -------------- MAIN --------------
async function main() {
  console.log("🌊 Building radius-mare IT...");
  const it = await collectForBBoxRegion("IT", BBOX_IT);

  console.log("🌍 Building radius-mare EU...");
  const eu = await collectForBBoxRegion("EU", BBOX_EU);

  // Merge
  const merged = mergeUnique(it, eu);

  // Scrivi
  writeDataset(path.join(OUT_DIR, "radius-mare-it.json"), it, { area: "IT" });
  writeDataset(path.join(OUT_DIR, "radius-mare-eu.json"), eu, { area: "EU" });
  writeDataset(path.join(OUT_DIR, "radius-mare.json"), merged, { area: "IT+EU" });

  console.log("✅ DONE");
}

main().catch((e) => {
  console.error("❌ build-radius-mare failed:", e);
  process.exit(1);
});
