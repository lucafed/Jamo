// scripts/build_pois_it_region.mjs
// Build POIs for ONE Italian region (safe for GitHub Actions)
// Usage: node scripts/build_pois_it_region.mjs --region it-abruzzo

import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const __dirname = new URL(".", import.meta.url).pathname;

// -------------------- CLI --------------------
const args = process.argv.slice(2);
const regionArg = args.find(a => a.startsWith("--region="));
if (!regionArg) {
  console.error("❌ Missing --region argument (example: --region=it-abruzzo)");
  process.exit(1);
}
const REGION_ID = regionArg.split("=")[1];

// -------------------- PATHS --------------------
const REGION_FILE = path.join(
  process.cwd(),
  "public",
  "data",
  "regions",
  `${REGION_ID}.json`
);

const OUT_DIR = path.join(
  process.cwd(),
  "public",
  "data",
  "pois",
  "it",
  REGION_ID
);

fs.mkdirSync(OUT_DIR, { recursive: true });

// -------------------- LOAD REGION --------------------
if (!fs.existsSync(REGION_FILE)) {
  console.error(`❌ Region file not found: ${REGION_FILE}`);
  process.exit(1);
}

const region = JSON.parse(fs.readFileSync(REGION_FILE, "utf8"));

const { bbox } = region;
if (!bbox || bbox.length !== 4) {
  console.error("❌ Region JSON must contain bbox: [minLon, minLat, maxLon, maxLat]");
  process.exit(1);
}

const [minLon, minLat, maxLon, maxLat] = bbox;

// -------------------- OVERPASS --------------------
const OVERPASS = "https://overpass-api.de/api/interpreter";

async function overpass(query) {
  const res = await fetch(OVERPASS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
    timeout: 20000
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return res.json();
}

function box() {
  return `${minLat},${minLon},${maxLat},${maxLon}`;
}

// -------------------- CATEGORIES --------------------
const CATEGORIES = {
  family: `
    node[tourism=theme_park](${box()});
    node[leisure=water_park](${box()});
    node[tourism=zoo](${box()});
    node[tourism=aquarium](${box()});
    node[leisure=playground](${box()});
    node["name"~"parco divertimenti|acquapark|zoo|acquario|parco avventura|fattoria",i](${box()});
  `,
  natura: `
    node[natural=waterfall](${box()});
    node[natural=peak](${box()});
    node[natural=wood](${box()});
    node[leisure=nature_reserve](${box()});
    node["name"~"cascata|lago|riserva|parco naturale",i](${box()});
  `,
  storia: `
    node[tourism=museum](${box()});
    node[historic=castle](${box()});
    node[historic=archaeological_site](${box()});
    node["name"~"castello|rocca|museo|abbazia|eremo",i](${box()});
  `,
  mare: `
    node[natural=beach](${box()});
    node["name"~"spiaggia|lido|baia",i](${box()});
  `,
  borghi: `
    node[place=village](${box()});
    node["name"~"borgo|castel|monte|san ",i](${box()});
  `,
  relax: `
    node[amenity=spa](${box()});
    node[natural=hot_spring](${box()});
    node["name"~"terme|spa|benessere",i](${box()});
  `
};

// -------------------- BUILD --------------------
console.log(`🏗️  Building POIs for region: ${REGION_ID}`);

const index = {};

for (const [cat, body] of Object.entries(CATEGORIES)) {
  console.log(`📡 Fetch ${cat}…`);

  const query = `
    [out:json][timeout:20];
    (
      ${body}
    );
    out tags center;
  `;

  try {
    const json = await overpass(query);
    const elements = (json.elements || []).map(el => ({
      id: `osm_${el.type}_${el.id}`,
      name: el.tags?.name || "Senza nome",
      lat: el.lat || el.center?.lat,
      lon: el.lon || el.center?.lon,
      tags: Object.entries(el.tags || {}).map(([k, v]) => `${k}=${v}`),
      category: cat
    })).filter(p => p.lat && p.lon);

    fs.writeFileSync(
      path.join(OUT_DIR, `${cat}.json`),
      JSON.stringify(elements, null, 2)
    );

    index[cat] = elements.length;
    console.log(`✅ ${cat}: ${elements.length}`);

  } catch (e) {
    console.error(`❌ ${cat} failed: ${e.message}`);
    index[cat] = 0;
  }
}

// -------------------- INDEX --------------------
fs.writeFileSync(
  path.join(OUT_DIR, "index.json"),
  JSON.stringify({
    region: REGION_ID,
    generatedAt: new Date().toISOString(),
    counts: index
  }, null, 2)
);

console.log("🎉 DONE");
