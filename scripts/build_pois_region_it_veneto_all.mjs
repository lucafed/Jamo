// scripts/build_pois_region_it_veneto_all.mjs
// Build OFFLINE POIs for ONE REGION (Veneto) — ALL categories in ONE file
// Output: public/data/pois/regions/it-veneto.json
//
// Tag-only categories (no name matching). Good for your app.js v10.6 tag-only filters.

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "public/data/pois/regions");
const OUT_FILE = path.join(OUT_DIR, "it-veneto.json");

// Veneto bbox (approx)
const BBOX = { minLat: 44.70, minLon: 10.20, maxLat: 46.70, maxLon: 13.20 };

// Overpass endpoints + retries
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowIso() { return new Date().toISOString(); }
function opBody(q) { return `data=${encodeURIComponent(q)}`; }

async function fetchWithTimeout(url, body, timeoutMs = 60000) {
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

async function runOverpass(query) {
  const body = opBody(query);
  let lastErr = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const json = await fetchWithTimeout(endpoint, body, 120000);
        return { ok: true, endpoint, json };
      } catch (e) {
        lastErr = e;
        await sleep(800 * attempt);
      }
    }
  }
  return { ok: false, endpoint: "", json: null, error: String(lastErr?.message || lastErr) };
}

// bbox helper
function bboxStr() {
  // Overpass bbox is: (south,west,north,east)
  return `(${BBOX.minLat},${BBOX.minLon},${BBOX.maxLat},${BBOX.maxLon})`;
}

// -----------------------------------------------
// CATEGORIES (TAG-ONLY, NO NAME-BASED)
// -----------------------------------------------
const CATS = {
  // family
  family: `
(
  nwr[tourism=theme_park]${bboxStr()};
  nwr[leisure=water_park]${bboxStr()};
  nwr[tourism=zoo]${bboxStr()};
  nwr[tourism=aquarium]${bboxStr()};
  nwr[amenity=aquarium]${bboxStr()};
  nwr[leisure=playground]${bboxStr()};
  nwr[leisure=ice_rink]${bboxStr()};
  nwr[amenity=cinema]${bboxStr()};
  nwr[leisure=bowling_alley]${bboxStr()};
);
`,

  // panorami reali (NO hotel belvedere)
  viewpoints: `
(
  nwr[tourism=viewpoint]${bboxStr()};
);
`,

  // hiking minimal “real” (senza prendere milioni di path)
  hiking: `
(
  nwr[information=guidepost]${bboxStr()};
  nwr[amenity=shelter]${bboxStr()};
  nwr[tourism=alpine_hut]${bboxStr()};
);
`,

  natura: `
(
  nwr[natural=waterfall]${bboxStr()};
  nwr[natural=spring]${bboxStr()};
  nwr[natural=cave_entrance]${bboxStr()};
  nwr[leisure=nature_reserve]${bboxStr()};
  nwr[boundary=national_park]${bboxStr()};
  nwr[natural=peak]${bboxStr()};
);
`,

  storia: `
(
  nwr[historic=castle]${bboxStr()};
  nwr[historic=ruins]${bboxStr()};
  nwr[historic=archaeological_site]${bboxStr()};
  nwr[historic=monument]${bboxStr()};
  nwr[historic=memorial]${bboxStr()};
  nwr[tourism=museum]${bboxStr()};
);
`,

  mare: `
(
  nwr[natural=beach]${bboxStr()};
  nwr[leisure=marina]${bboxStr()};
);
`,

  montagna: `
(
  nwr[natural=peak]${bboxStr()};
  nwr[tourism=alpine_hut]${bboxStr()};
  nwr[aerialway]${bboxStr()};
  nwr[amenity=shelter]${bboxStr()};
);
`,

  // Attenzione: sono tanti. Ma per “test completo” va bene.
  borghi: `
(
  nwr[place=hamlet]${bboxStr()};
  nwr[place=village]${bboxStr()};
);
`,

  citta: `
(
  nwr[place=town]${bboxStr()};
  nwr[place=city]${bboxStr()};
);
`,

  relax: `
(
  nwr[amenity=spa]${bboxStr()};
  nwr[leisure=spa]${bboxStr()};
  nwr[natural=hot_spring]${bboxStr()};
  nwr[amenity=public_bath]${bboxStr()};
  nwr[thermal=yes]${bboxStr()};
);
`,
};

// -----------------------------------------------
// Filtering: NO hotel/food inside dataset
// (così non ti escono “Hotel Belvedere” ecc. anche se capita)
function isLodgingOrFood(tags = {}) {
  const t = tags;
  const tourism = t.tourism;
  const amenity = t.amenity;

  // lodging
  if (tourism === "hotel" || tourism === "hostel" || tourism === "guest_house" || tourism === "apartment" ||
      tourism === "motel" || tourism === "camp_site" || tourism === "caravan_site" || tourism === "chalet") return true;

  // food & drink
  if (amenity === "restaurant" || amenity === "fast_food" || amenity === "cafe" || amenity === "bar" ||
      amenity === "pub" || amenity === "ice_cream") return true;

  return false;
}

// Overpass wrapper
function buildQuery(catKey) {
  return `
[out:json][timeout:180];
${CATS[catKey]}
out tags center;
  `.trim();
}

function elementLatLon(el) {
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function tagListCompact(tags) {
  const out = [];
  const pushKV = (k) => { if (tags?.[k] != null) out.push(`${k}=${tags[k]}`); };
  [
    "tourism","leisure","amenity","historic","natural","boundary","information","place",
    "aerialway","thermal","sport"
  ].forEach(pushKV);
  return Array.from(new Set(out)).slice(0, 18);
}

function visibilityFromTags(catKey, tags) {
  // semplice e utile per test: se ha wiki/wikidata -> conosciuta
  const hasWiki = !!(tags.wikipedia || tags.wikidata);
  if (hasWiki) return "conosciuta";
  // family grandi spesso note
  if (catKey === "family" && (tags.tourism === "theme_park" || tags.tourism === "zoo")) return "conosciuta";
  return "classica";
}

function beautyScore(catKey) {
  // valori “ragionevoli” per far lavorare bene lo scoring della tua app
  const map = {
    viewpoints: 0.86,
    natura: 0.82,
    mare: 0.80,
    montagna: 0.82,
    storia: 0.78,
    family: 0.76,
    hiking: 0.74,
    borghi: 0.72,
    citta: 0.72,
    relax: 0.70,
  };
  return map[catKey] ?? 0.72;
}

function mapElementToPlace(el, catKey) {
  const tags = el.tags || {};
  if (isLodgingOrFood(tags)) return null;

  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";
  if (!name || String(name).trim().length < 2) return null;

  const ll = elementLatLon(el);
  if (!ll) return null;

  return {
    id: `veneto_${catKey}_${el.type}_${el.id}`,
    name: String(name).trim(),
    lat: ll.lat,
    lon: ll.lon,

    // IMPORTANT per app.js: type = categoria
    type: catKey,
    primary_category: catKey,

    visibility: visibilityFromTags(catKey, tags),
    beauty_score: beautyScore(catKey),

    tags: tagListCompact(tags),
    live: false,
    source: "overpass_build_region",
    region_id: "it-veneto",
    region_name: "Veneto",
    country: "IT",
  };
}

function dedupPlaces(places) {
  const seen = new Set();
  const out = [];
  for (const p of places) {
    const k = `${p.type}_${p.name.toLowerCase()}_${p.lat.toFixed(4)}_${p.lon.toFixed(4)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

async function main() {
  ensureDir(OUT_DIR);

  const meta = {
    version: "veneto_all_v1",
    built_at: nowIso(),
    region_id: "it-veneto",
    region_name: "Veneto",
    bbox: BBOX,
    categories: Object.keys(CATS),
    notes: [],
    endpoints: {},
  };

  const allByCat = {};
  const all = [];

  for (const catKey of Object.keys(CATS)) {
    console.log(`🛰️ Veneto: fetch category = ${catKey}`);
    const q = buildQuery(catKey);
    const r = await runOverpass(q);

    if (!r.ok || !r.json) {
      console.log(`❌ ${catKey} failed: ${r.error || "unknown"}`);
      meta.notes.push(`fail_${catKey}`);
      allByCat[catKey] = [];
      continue;
    }

    meta.endpoints[catKey] = r.endpoint;
    const els = Array.isArray(r.json.elements) ? r.json.elements : [];
    const mapped = dedupPlaces(els.map(el => mapElementToPlace(el, catKey)).filter(Boolean));

    console.log(`✅ ${catKey}: ${mapped.length}`);
    allByCat[catKey] = mapped;
    all.push(...mapped);
  }

  const allDedup = dedupPlaces(all);

  const outJson = {
    meta,
    counts: Object.fromEntries(Object.entries(allByCat).map(([k, v]) => [k, v.length])),
    places: allDedup,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(outJson), "utf8");
  console.log(`🎉 DONE: ${OUT_FILE}`);
  console.log(`Total unique places: ${allDedup.length}`);
  console.log(`Counts:`, outJson.counts);
}

main().catch((e) => {
  console.error("❌ build failed:", e);
  process.exit(1);
});
