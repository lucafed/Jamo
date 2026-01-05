// scripts/build_pois_eu_uk_all.mjs
// Build POIs EU+UK (offline dataset) for GitHub Pages (NO /api needed)
// Output (✅ fixed paths):
// - public/data/pois/pois_eu_uk.json          (ALL)
// - public/data/pois/index.json               (index)
// - public/data/pois/<category>.json          (split)
//
// ✅ Fix principali:
// - UK -> GB (ISO3166-1 corretto per Overpass)
// - Niente mega-area EUUK: fetch per-country (molto più affidabile)
// - Quasi tutto richiede ["name"] per evitare milioni di risultati
// - Dedup robusto
//
// Run:
//   node scripts/build_pois_eu_uk_all.mjs

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "public", "data", "pois");

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

function opBody(q){ return `data=${encodeURIComponent(q)}`; }

// ✅ EU27 + GB (UK -> GB)
const COUNTRIES = [
  "AT","BE","BG","CY","CZ","DE","DK","EE","ES","FI","FR","GR","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK","GB"
];

// --------- CATEGORIE POI (mirate) ---------
// NOTE: per evitare dataset enorme/ingestibile, molti blocchi richiedono ["name"].
// Le categorie "borghi/citta" NON conviene farle POI: sono macro (come già fai).
const CATEGORIES = {
  family: `
(
  nwr["tourism"="theme_park"]["name"](area.A);
  nwr["leisure"="water_park"]["name"](area.A);
  nwr["tourism"="zoo"]["name"](area.A);
  nwr["tourism"="aquarium"]["name"](area.A);

  // kids museum / science center: solo se name match
  nwr["tourism"="museum"]["name"~"children|kids|bambin|children\\s?museum|museo dei bambini|science\\s?center|planetari|planetarium",i](area.A);
  nwr["tourism"="attraction"]["name"~"children|kids|bambin|children\\s?museum|museo dei bambini|science\\s?center|planetari|planetarium",i](area.A);

  // playground SOLO se named (riduce tantissimo)
  nwr["leisure"="playground"]["name"](area.A);

  // “family keywords” su attraction (named)
  nwr["tourism"="attraction"]["name"~"parco\\s?divertimenti|lunapark|luna\\s?park|giostre|parco\\s?avventura|safari",i](area.A);
);
`,

  theme_park: `
(
  nwr["tourism"="theme_park"]["name"](area.A);
  nwr["leisure"="water_park"]["name"](area.A);
  nwr["leisure"="amusement_arcade"]["name"](area.A);
  nwr["tourism"="attraction"]["name"~"parco\\s?divertimenti|lunapark|luna\\s?park|giostre|water\\s?park|acquapark|aqua\\s?park|parco\\s?acquatico",i](area.A);
);
`,

  kids_museum: `
(
  nwr["tourism"="museum"]["name"~"children|kids|bambin|children\\s?museum|museo dei bambini|science\\s?center|planetari|planetarium",i](area.A);
  nwr["amenity"="planetarium"]["name"](area.A);
  nwr["tourism"="attraction"]["name"~"children|kids|bambin|children\\s?museum|museo dei bambini|science\\s?center|planetari|planetarium",i](area.A);
);
`,

  storia: `
(
  nwr["historic"="castle"]["name"](area.A);
  nwr["historic"="ruins"]["name"](area.A);
  nwr["historic"="archaeological_site"]["name"](area.A);
  nwr["historic"="monument"]["name"](area.A);
  nwr["historic"="memorial"]["name"](area.A);
  nwr["tourism"="museum"]["name"](area.A);
);
`,

  natura: `
(
  nwr["natural"="waterfall"]["name"](area.A);
  nwr["natural"="peak"]["name"](area.A);
  nwr["natural"="spring"]["name"](area.A);
  nwr["leisure"="nature_reserve"]["name"](area.A);
  nwr["boundary"="national_park"]["name"](area.A);
  nwr["natural"="cave_entrance"]["name"](area.A);
);
`,

  mare: `
(
  nwr["natural"="beach"]["name"](area.A);
  nwr["leisure"="marina"]["name"](area.A);
  nwr["tourism"="viewpoint"]["name"~"sea|mare|coast|costa|spiaggia|beach",i](area.A);
);
`,

  relax: `
(
  nwr["amenity"="spa"]["name"](area.A);
  nwr["leisure"="spa"]["name"](area.A);
  nwr["natural"="hot_spring"]["name"](area.A);
  nwr["amenity"="public_bath"]["name"](area.A);
  nwr["thermal"="yes"]["name"](area.A);
);
`,

  viewpoints: `
(
  nwr["tourism"="viewpoint"]["name"](area.A);
  nwr["name"~"belvedere|panoram|viewpoint|scenic|terrazza|vista",i](area.A);
);
`,

  hiking: `
(
  nwr["information"="guidepost"]["name"](area.A);
  nwr["amenity"="shelter"]["name"](area.A);

  // route=hiking può essere enorme: limitiamoci a named
  nwr["route"="hiking"]["name"](area.A);

  // keyword named
  nwr["name"~"sentiero|trail|trek|trekking|hike|hiking|via\\s?ferrata|rifugio|anello",i](area.A);
);
`,
};

// Query wrapper per singolo paese
function buildQueryForCountry(catKey, iso2) {
  return `
[out:json][timeout:120];
area["ISO3166-1"="${iso2}"]->.A;
${CATEGORIES[catKey]}
out tags center;
`.trim();
}

// Normalizza in “place” compatibile con la tua app
function mapElementToPlace(el, catKey, iso2) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags["name:en"] || tags.brand || tags.operator || "";
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  // tag list compatta k=v (utile per matching)
  const tagList = [];
  const pushKV = (k) => { if (tags[k] != null) tagList.push(`${k}=${tags[k]}`); };
  ["tourism","leisure","historic","natural","amenity","information","place","boundary","route","sport","piste:type"].forEach(pushKV);

  return {
    id: `poi_${catKey}_${iso2}_${el.type}_${el.id}`,
    name: String(name).trim(),
    lat,
    lon,
    type: catKey,               // catKey come type per filtro
    primary_category: catKey,
    country: iso2,              // ✅ utile per debug/filtri
    visibility: "classica",
    beauty_score: 0.72,
    tags: Array.from(new Set(tagList)).slice(0, 24),
    live: false,
    source: "overpass_build",
  };
}

function dedupPlaces(places) {
  // dedup su name + approx coords + category
  const seen = new Set();
  const out = [];
  for (const p of places) {
    const k = `${p.primary_category}|${p.name.toLowerCase()}|${String(p.lat).slice(0,6)}|${String(p.lon).slice(0,6)}`;
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
        const j = await fetchWithTimeout(endpoint, body, 70000);
        return { ok: true, endpoint, json: j };
      } catch (e) {
        lastErr = e;
        await sleep(700 * attempt);
      }
    }
  }
  return { ok: false, endpoint: "", json: null, error: String(lastErr?.message || lastErr) };
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj), "utf8");
}

async function main() {
  ensureDir(OUT_DIR);

  const metaBase = {
    built_at: nowIso(),
    countries: COUNTRIES,
    categories: Object.keys(CATEGORIES),
    notes: [],
  };

  const allByCat = {};
  for (const catKey of Object.keys(CATEGORIES)) allByCat[catKey] = [];

  // --- fetch per category per country ---
  for (const catKey of Object.keys(CATEGORIES)) {
    console.log(`\n🧩 Category: ${catKey}`);

    for (const iso2 of COUNTRIES) {
      console.log(`  🛰️ ${iso2} ...`);

      const q = buildQueryForCountry(catKey, iso2);
      const r = await runOverpass(q);

      if (!r.ok || !r.json) {
        console.log(`  ❌ ${iso2} failed (${catKey}): ${r.error || "unknown"}`);
        metaBase.notes.push(`fail_${catKey}_${iso2}`);
        continue;
      }

      const els = Array.isArray(r.json.elements) ? r.json.elements : [];
      const mapped = els.map(el => mapElementToPlace(el, catKey, iso2)).filter(Boolean);
      const dedup = dedupPlaces(mapped);

      console.log(`  ✅ ${iso2}: ${dedup.length} items (endpoint: ${r.endpoint})`);
      allByCat[catKey].push(...dedup);

      // piccola pausa per non martellare
      await sleep(250);
    }

    // dedup categoria globale
    allByCat[catKey] = dedupPlaces(allByCat[catKey]);

    // write split
    writeJson(
      path.join(OUT_DIR, `${catKey}.json`),
      {
        meta: { ...metaBase, category: catKey },
        places: allByCat[catKey],
      }
    );

    console.log(`  📦 ${catKey} TOTAL unique: ${allByCat[catKey].length}`);
  }

  // --- all merged ---
  const all = dedupPlaces(Object.values(allByCat).flat());

  // index
  const index = {
    meta: metaBase,
    counts: Object.fromEntries(Object.entries(allByCat).map(([k, v]) => [k, v.length])),
    total: all.length,
    files: Object.keys(allByCat).map(k => ({ category: k, path: `/data/pois/${k}.json`, count: allByCat[k].length })),
  };

  // ✅ write index + all in the right folder
  writeJson(path.join(OUT_DIR, "index.json"), index);
  writeJson(path.join(OUT_DIR, "pois_eu_uk.json"), { meta: metaBase, places: all });

  console.log(`\n🎉 DONE: total unique POIs = ${all.length}`);
  console.log(`➡️ Wrote: public/data/pois/pois_eu_uk.json`);
  console.log(`➡️ Wrote: public/data/pois/index.json + per-category files`);
}

main().catch((e) => {
  console.error("❌ build failed:", e);
  process.exit(1);
});
