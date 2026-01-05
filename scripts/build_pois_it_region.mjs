#!/usr/bin/env node
/**
 * build_pois_it_region.mjs
 *
 * Costruisce POI offline per UNA regione italiana
 * Output per categoria:
 * public/data/pois/it/<region>/{family,natura,storia,mare,relax,borghi,citta}.json
 */

import fs from "fs/promises";
import path from "path";
import process from "process";

const OVERPASS = "https://overpass-api.de/api/interpreter";
const TIMEOUT_MS = 25_000;

// -------------------- utils --------------------
function arg(name) {
  const a = process.argv.find(v => v.startsWith(`--${name}=`));
  return a ? a.split("=")[1] : null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchOverpass(query) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(OVERPASS, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function uniq(elements) {
  const seen = new Set();
  return elements.filter(e => {
    const k = `${e.type}:${e.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// -------------------- main --------------------
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

console.log(`🗺️  Building POIs for ${region.name}`);

// -------------------- categorie --------------------
const CATEGORIES = {
  family: `
    node[tourism=theme_park];
    node[leisure=water_park];
    node[tourism=zoo];
    node[tourism=aquarium];
    node[leisure=amusement_arcade];
    node[leisure=trampoline_park];
    node["name"~"parco divertimenti|acquapark|zoo|acquario|planetario|museo dei bambini|children",i];
  `,
  natura: `
    node[natural=waterfall];
    node[natural=peak];
    node[natural=wood];
    node[leisure=nature_reserve];
    node[boundary=national_park];
    node["name"~"cascata|lago|riserva|parco naturale",i];
  `,
  storia: `
    node[historic=castle];
    node[historic=ruins];
    node[historic=archaeological_site];
    node[tourism=museum];
    node[historic=monument];
  `,
  mare: `
    node[natural=beach];
    node[leisure=marina];
    node["name"~"spiaggia|lido|baia",i];
  `,
  relax: `
    node[amenity=spa];
    node[leisure=spa];
    node[natural=hot_spring];
    node["name"~"terme|spa|benessere",i];
  `,
  borghi: `
    node[place=village];
    node[place=hamlet];
    node["name"~"borgo|castel|rocca",i];
  `,
  citta: `
    node[place=city];
    node[place=town];
  `
};

// -------------------- build --------------------
const index = {};

for (const [cat, body] of Object.entries(CATEGORIES)) {
  console.log(`🔹 Fetch ${cat}`);

  const query = `
    [out:json][timeout:25];
    (
      ${body}
    )(${minLat},${minLon},${maxLat},${maxLon});
    out tags center;
  `;

  let json;
  try {
    json = await fetchOverpass(query);
  } catch (e) {
    console.error(`❌ ${cat} failed`, e.message);
    continue;
  }

  const elements = uniq(json.elements || []).map(e => ({
    id: e.id,
    type: e.type,
    lat: e.lat ?? e.center?.lat,
    lon: e.lon ?? e.center?.lon,
    name: e.tags?.name || null,
    tags: e.tags || {},
    category: cat
  })).filter(p => p.lat && p.lon && p.name);

  await fs.writeFile(
    path.join(outDir, `${cat}.json`),
    JSON.stringify(elements, null, 2)
  );

  index[cat] = elements.length;
  console.log(`   ✅ ${elements.length} items`);

  // piccola pausa per Overpass
  await sleep(1200);
}

// -------------------- index --------------------
await fs.writeFile(
  path.join(outDir, "index.json"),
  JSON.stringify({
    region: regionId,
    generatedAt: new Date().toISOString(),
    counts: index
  }, null, 2)
);

console.log("🎉 DONE");
