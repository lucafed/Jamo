// scripts/build_pois_eu_uk_all.mjs
// Build POIs EU+UK (offline dataset) for GitHub Pages (NO /api needed)
// Output:
// - public/data/pois_eu_uk.json (all)
// - public/data/pois_index_eu_uk.json (index)
// - public/data/pois/<category>.json (split)

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "public/data");
const OUT_POIS_DIR = path.join(OUT_DIR, "pois");

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function nowIso(){ return new Date().toISOString(); }

function ensureDir(p){
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function fetchWithTimeout(url, body, timeoutMs = 30000) {
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

function opBody(q){ return `data=${encodeURIComponent(q)}`; }

// EU+UK area (Overpass uses ISO3166-1 codes sometimes; easiest: union of Europe + UK by relation areas)
// Practical approach: query by multiple country areas.
// -> Inizia con una lista: EU27 + UK + EEA/Schengen se vuoi. Qui metto EU + UK “pratici”.
// Se vuoi aggiungere paesi, basta aggiungere ISO.
const COUNTRIES = [
  "AT","BE","BG","CY","CZ","DE","DK","EE","ES","FI","FR","GR","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK","UK"
];

// Genera il blocco aree: area["ISO3166-1"="IT"]->.aIT;
function areaDefs() {
  return COUNTRIES.map(c => `area["ISO3166-1"="${c}"]->.a${c};`).join("\n");
}
// Unione: (.aIT;.aFR;...;)->.EUUK;
function areaUnion() {
  return `(${COUNTRIES.map(c => `.a${c};`).join("")})->.EUUK;`;
}

// --------- CATEGORIE “INTERESSANTI” (puoi editarle qui) ---------
// L’idea: family = zoo, theme parks, water parks, aquariums, kids museums, playground (non troppo spam),
// storia = castle, ruins, archaeological, museum, monument
// natura = waterfalls, peaks, springs, nature reserves, national parks, caves
// mare = beaches, marinas, viewpoints costieri
// relax = spa, hot springs, public bath
// borghi/citta = place=hamlet/village/town/city (ma attenzione: sono tanti → meglio tenerli come “macro”, non come POI)
const CATEGORIES = {
  family: `
(
  nwr["tourism"="theme_park"](area.EUUK);
  nwr["leisure"="water_park"](area.EUUK);
  nwr["tourism"="zoo"](area.EUUK);
  nwr["tourism"="aquarium"](area.EUUK);
  nwr["amenity"="aquarium"](area.EUUK);
  nwr["tourism"="attraction"]["name"~"children|kids|bambin|children\\s?museum|museo dei bambini|science\\s?center|planetari",i](area.EUUK);
  nwr["tourism"="museum"]["name"~"children|kids|bambin|children\\s?museum|museo dei bambini|science\\s?center|planetari",i](area.EUUK);

  // playground: solo se ha name (riduce spam)
  nwr["leisure"="playground"]["name"](area.EUUK);
);
`,

  theme_park: `
(
  nwr["tourism"="theme_park"](area.EUUK);
  nwr["leisure"="water_park"](area.EUUK);
  nwr["leisure"="amusement_arcade"](area.EUUK);
  nwr["tourism"="attraction"]["name"~"parco divertimenti|lunapark|luna\\s?park|giostre|water\\s?park|acquapark|aqua\\s?park",i](area.EUUK);
);
`,

  kids_museum: `
(
  nwr["tourism"="museum"]["name"~"children|kids|bambin|children\\s?museum|museo dei bambini|science\\s?center|planetari|planetarium",i](area.EUUK);
  nwr["tourism"="attraction"]["name"~"children|kids|bambin|children\\s?museum|museo dei bambini|science\\s?center|planetari|planetarium",i](area.EUUK);
);
`,

  storia: `
(
  nwr["historic"="castle"](area.EUUK);
  nwr["historic"="ruins"](area.EUUK);
  nwr["historic"="archaeological_site"](area.EUUK);
  nwr["tourism"="museum"](area.EUUK);
  nwr["historic"="monument"](area.EUUK);
  nwr["historic"="memorial"](area.EUUK);
);
`,

  natura: `
(
  nwr["natural"="waterfall"](area.EUUK);
  nwr["natural"="peak"](area.EUUK);
  nwr["natural"="spring"](area.EUUK);
  nwr["leisure"="nature_reserve"](area.EUUK);
  nwr["boundary"="national_park"](area.EUUK);
  nwr["natural"="cave_entrance"](area.EUUK);
);
`,

  mare: `
(
  nwr["natural"="beach"](area.EUUK);
  nwr["leisure"="marina"](area.EUUK);
  nwr["tourism"="viewpoint"]["name"~"sea|mare|coast|costa|spiaggia|beach",i](area.EUUK);
);
`,

  relax: `
(
  nwr["amenity"="spa"](area.EUUK);
  nwr["leisure"="spa"](area.EUUK);
  nwr["natural"="hot_spring"](area.EUUK);
  nwr["amenity"="public_bath"](area.EUUK);
  nwr["thermal"="yes"](area.EUUK);
);
`,

  viewpoints: `
(
  nwr["tourism"="viewpoint"](area.EUUK);
  nwr["name"~"belvedere|panoram|viewpoint|scenic|terrazza|vista",i](area.EUUK);
);
`,

  hiking: `
(
  nwr["information"="guidepost"](area.EUUK);
  nwr["amenity"="shelter"](area.EUUK);
  nwr["name"~"sentiero|trail|trek|trekking|hike|hiking|via\\s?ferrata|rifugio|anello",i](area.EUUK);
);
`,
};

// Query wrapper
function buildQuery(catKey) {
  return `
[out:json][timeout:180];
${areaDefs()}
${areaUnion()}
${CATEGORIES[catKey]}
out tags center;
  `.trim();
}

// Normalizza in “place” compatibile con la tua app
function mapElementToPlace(el, catKey) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  // tag list compatta k=v (utile per matching)
  const tagList = [];
  const pushKV = (k) => { if (tags[k] != null) tagList.push(`${k}=${tags[k]}`); };
  ["tourism","leisure","historic","natural","amenity","information","place","boundary"].forEach(pushKV);

  return {
    id: `poi_${catKey}_${el.type}_${el.id}`,
    name: String(name).trim(),
    lat,
    lon,
    type: catKey,               // usiamo catKey come type per filtro
    primary_category: catKey,    // coerente con enrichment
    visibility: "classica",
    beauty_score: 0.72,
    tags: Array.from(new Set(tagList)).slice(0, 18),
    live: false,
    source: "overpass_build",
  };
}

function dedupPlaces(places) {
  const seen = new Set();
  const out = [];
  for (const p of places) {
    const k = `${p.name.toLowerCase()}_${String(p.lat).slice(0,6)}_${String(p.lon).slice(0,6)}`;
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
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const j = await fetchWithTimeout(endpoint, body, 60000);
        return { ok: true, endpoint, json: j };
      } catch (e) {
        lastErr = e;
        await sleep(600 * attempt);
      }
    }
  }
  return { ok: false, endpoint: "", json: null, error: String(lastErr?.message || lastErr) };
}

async function main() {
  ensureDir(OUT_DIR);
  ensureDir(OUT_POIS_DIR);

  const meta = {
    built_at: nowIso(),
    countries: COUNTRIES,
    categories: Object.keys(CATEGORIES),
    notes: [],
  };

  const allByCat = {};
  const all = [];

  for (const catKey of Object.keys(CATEGORIES)) {
    console.log(`🛰️ Fetch category: ${catKey}`);
    const q = buildQuery(catKey);
    const r = await runOverpass(q);

    if (!r.ok || !r.json) {
      console.log(`❌ ${catKey} failed: ${r.error || "unknown"}`);
      meta.notes.push(`fail_${catKey}`);
      allByCat[catKey] = [];
      continue;
    }

    const els = Array.isArray(r.json.elements) ? r.json.elements : [];
    const mapped = dedupPlaces(els.map(el => mapElementToPlace(el, catKey)).filter(Boolean));

    console.log(`✅ ${catKey}: ${mapped.length} items (endpoint: ${r.endpoint})`);
    allByCat[catKey] = mapped;
    all.push(...mapped);

    // write split
    fs.writeFileSync(
      path.join(OUT_POIS_DIR, `${catKey}.json`),
      JSON.stringify({ meta: { ...meta, category: catKey, endpoint: r.endpoint }, places: mapped }),
      "utf8"
    );
  }

  const allDedup = dedupPlaces(all);

  // index
  const index = {
    meta,
    counts: Object.fromEntries(Object.entries(allByCat).map(([k,v]) => [k, v.length])),
    total: allDedup.length,
    files: Object.keys(allByCat).map(k => ({ category: k, path: `/data/pois/${k}.json`, count: allByCat[k].length })),
  };

  fs.writeFileSync(path.join(OUT_DIR, "pois_index_eu_uk.json"), JSON.stringify(index), "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "pois_eu_uk.json"), JSON.stringify({ meta, places: allDedup }), "utf8");

  console.log(`🎉 DONE: total unique POIs = ${allDedup.length}`);
}

main().catch((e) => {
  console.error("❌ build failed:", e);
  process.exit(1);
});
