// Build FAMILY POIs EU+UK (offline)
// Output: public/data/pois/family.json
// Categoria FAMILY = parchi divertimento, acquapark, zoo, acquari, kids museum, playground con nome, neve kids

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "public/data/pois");
const OUT_FILE = path.join(OUT_DIR, "family.json");

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

const COUNTRIES = [
  "AT","BE","BG","CY","CZ","DE","DK","EE","ES","FI","FR","GR","HR","HU",
  "IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK","UK"
];

function ensureDir(p){
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function opBody(q){ return `data=${encodeURIComponent(q)}`; }

async function fetchWithRetry(query) {
  const body = opBody(query);

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let i = 1; i <= 3; i++) {
      try {
        const r = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body,
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        return j;
      } catch (e) {
        await sleep(600 * i);
      }
    }
  }
  throw new Error("Overpass failed on all endpoints");
}

// --- OVERPASS QUERY (FAMILY ONLY, PULITA) ---
function buildQuery() {
  const areas = COUNTRIES
    .map(c => `area["ISO3166-1"="${c}"]->.a${c};`)
    .join("\n");

  const union = `(${COUNTRIES.map(c => `.a${c};`).join("")})->.EUUK;`;

  return `
[out:json][timeout:300];
${areas}
${union}
(
  // 🎢 Theme parks & acquapark
  nwr[tourism=theme_park](area.EUUK);
  nwr[leisure=water_park](area.EUUK);

  // 🦁 Zoo & acquari
  nwr[tourism=zoo](area.EUUK);
  nwr[tourism=aquarium](area.EUUK);

  // 🧒 Musei per bambini / science center
  nwr[tourism=museum]["name"~"children|kids|bambin|science|planetar",i](area.EUUK);
  nwr[tourism=attraction]["name"~"children|kids|bambin|science|planetar",i](area.EUUK);

  // 🛝 Playground SOLO se hanno nome (anti-spam)
  nwr[leisure=playground]["name"](area.EUUK);

  // ❄️ Family winter / neve (kids friendly)
  nwr[leisure=ice_rink](area.EUUK);
  nwr[aerialway](area.EUUK);
  nwr["name"~"ski|sci|slitt|neve|snow|baby|kids",i](area.EUUK);
);
out tags center;
`.trim();
}

// --- NORMALIZZAZIONE ---
function mapElement(el) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"];
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);

  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  // ❌ escludi città/paesi
  if (tags.place) return null;

  // ❌ escludi spa/terme
  if (
    tags.amenity === "spa" ||
    tags.leisure === "spa" ||
    tags.natural === "hot_spring" ||
    /terme|spa|thermal/i.test(name)
  ) return null;

  const tagList = [];
  ["tourism","leisure","amenity","sport","aerialway"].forEach(k => {
    if (tags[k]) tagList.push(`${k}=${tags[k]}`);
  });

  return {
    id: `family_${el.type}_${el.id}`,
    name: String(name).trim(),
    lat,
    lon,
    type: "family",
    primary_category: "family",
    visibility: "classica",
    beauty_score: 0.75,
    tags: tagList,
    source: "overpass_family_build",
  };
}

function dedup(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const k = `${p.name.toLowerCase()}_${p.lat.toFixed(4)}_${p.lon.toFixed(4)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

// --- MAIN ---
async function main() {
  ensureDir(OUT_DIR);

  console.log("🛰️ Building FAMILY POIs (EU+UK)...");
  const query = buildQuery();
  const json = await fetchWithRetry(query);

  const elements = Array.isArray(json.elements) ? json.elements : [];
  const mapped = dedup(elements.map(mapElement).filter(Boolean));

  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify({
      meta: {
        category: "family",
        count: mapped.length,
        built_at: new Date().toISOString(),
        countries: COUNTRIES,
      },
      places: mapped,
    }, null, 2),
    "utf8"
  );

  console.log(`✅ FAMILY DONE: ${mapped.length} places → public/data/pois/family.json`);
}

main().catch(e => {
  console.error("❌ BUILD FAILED:", e);
  process.exit(1);
});
