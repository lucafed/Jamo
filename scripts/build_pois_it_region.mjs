// scripts/build_pois_it_region.mjs
// Build POIs for ONE Italian region (safe for GitHub Actions / Node 20)
// Usage:
//   node scripts/build_pois_it_region.mjs --region=it-abruzzo
//
// Output:
//   public/data/pois/it/<regionId>/{family,natura,storia,mare,borghi,relax}.json
//   public/data/pois/it/<regionId>/index.json

import fs from "fs";
import path from "path";

// -------------------- CLI --------------------
function argValue(name) {
  const p = process.argv.find((a) => a.startsWith(`${name}=`));
  if (!p) return null;
  const v = p.split("=").slice(1).join("=");
  return v ? v.trim() : null;
}

const REGION_ID = argValue("--region");
if (!REGION_ID) {
  console.error("❌ Missing --region argument (example: --region=it-abruzzo)");
  process.exit(1);
}

// -------------------- PATHS --------------------
const REGION_FILE = path.join(process.cwd(), "public", "data", "regions", `${REGION_ID}.json`);
const OUT_DIR = path.join(process.cwd(), "public", "data", "pois", "it", REGION_ID);

fs.mkdirSync(OUT_DIR, { recursive: true });

// -------------------- LOAD REGION --------------------
if (!fs.existsSync(REGION_FILE)) {
  console.error(`❌ Region file not found: ${REGION_FILE}`);
  process.exit(1);
}

let region;
try {
  region = JSON.parse(fs.readFileSync(REGION_FILE, "utf8"));
} catch (e) {
  console.error(`❌ Invalid JSON in region file: ${REGION_FILE}`);
  console.error(String(e?.message || e));
  process.exit(1);
}

const bbox = region?.bbox;
if (!Array.isArray(bbox) || bbox.length !== 4) {
  console.error("❌ Region JSON must contain bbox: [minLon, minLat, maxLon, maxLat]");
  console.error("   Example: { bbox: [13.0, 41.9, 14.9, 42.9] }");
  process.exit(1);
}

const [minLon, minLat, maxLon, maxLat] = bbox;

// Overpass expects (south,west,north,east)
function box() {
  return `${minLat},${minLon},${maxLat},${maxLon}`;
}

// -------------------- OVERPASS --------------------
const OVERPASS = "https://overpass-api.de/api/interpreter";

async function overpass(query, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(OVERPASS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: `data=${encodeURIComponent(query)}`,
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Overpass HTTP ${res.status} ${txt ? "- " + txt.slice(0, 120) : ""}`);
    }

    const json = await res.json().catch(() => null);
    if (!json) throw new Error("Overpass: bad JSON");
    return json;
  } finally {
    clearTimeout(t);
  }
}

// -------------------- CATEGORIES --------------------
// Nota: qui usiamo SOLO NODES (veloce e stabile). In seguito aggiungeremo ways/relations per parchi grandi.
const B = box();

const CATEGORIES = {
  family: `
    node[tourism=theme_park](${B});
    node[leisure=water_park](${B});
    node[tourism=zoo](${B});
    node[tourism=aquarium](${B});
    node[leisure=playground](${B});
    node["name"~"parco divertimenti|acquapark|aqua\\s?park|water\\s?park|zoo|acquario|parco avventura|fattoria",i](${B});
  `,
  natura: `
    node[natural=waterfall](${B});
    node[natural=peak](${B});
    node[natural=spring](${B});
    node[leisure=nature_reserve](${B});
    node[boundary=national_park](${B});
    node["name"~"cascata|lago|riserva|parco naturale|gola|sentiero",i](${B});
  `,
  storia: `
    node[tourism=museum](${B});
    node[historic=castle](${B});
    node[historic=ruins](${B});
    node[historic=archaeological_site](${B});
    node[historic=monument](${B});
    node["name"~"castello|rocca|museo|abbazia|anfiteatro|scavi|necropol|eremo|centro\\s?storico",i](${B});
  `,
  mare: `
    node[natural=beach](${B});
    node[leisure=marina](${B});
    node["name"~"spiaggia|lido|baia|mare",i](${B});
  `,
  borghi: `
    node[place=village](${B});
    node[place=hamlet](${B});
    node["name"~"borgo|castel|rocca|monte|san\\s",i](${B});
  `,
  relax: `
    node[amenity=spa](${B});
    node[leisure=spa](${B});
    node[natural=hot_spring](${B});
    node[amenity=public_bath](${B});
    node["name"~"terme|spa|benessere|thermal",i](${B});
  `,
};

// -------------------- BUILD --------------------
function normalizeTags(tagsObj) {
  const tags = tagsObj || {};
  const out = [];
  for (const [k, v] of Object.entries(tags)) {
    if (v == null) continue;
    const s = String(v);
    if (!s.length) continue;
    out.push(`${k}=${s}`);
  }
  return out.slice(0, 40);
}

function mapElement(el, category) {
  const tags = el?.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);

  if (!name || name.trim().length < 2) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    id: `osm_${el.type}_${el.id}`,
    name: String(name).trim(),
    lat,
    lon,
    tags: normalizeTags(tags),
    category,
  };
}

console.log(`🏗️  Building POIs for region: ${REGION_ID}`);
console.log(`📦 Region file: ${REGION_FILE}`);
console.log(`🧭 BBOX: ${B}`);
console.log(`🗂️  Output dir: ${OUT_DIR}`);

const index = {};

for (const [cat, body] of Object.entries(CATEGORIES)) {
  console.log(`\n📡 Fetch category: ${cat}`);

  const query = `
[out:json][timeout:25];
(
  ${body}
);
out tags center;
  `.trim();

  try {
    const json = await overpass(query, 30000);
    const els = Array.isArray(json?.elements) ? json.elements : [];

    // Map + filter + de-dup (name+coords)
    const seen = new Set();
    const items = [];
    for (const el of els) {
      const p = mapElement(el, cat);
      if (!p) continue;
      const key = `${p.name.toLowerCase()}_${String(p.lat).slice(0, 6)}_${String(p.lon).slice(0, 6)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(p);
    }

    fs.writeFileSync(path.join(OUT_DIR, `${cat}.json`), JSON.stringify(items, null, 2), "utf8");
    index[cat] = items.length;

    console.log(`✅ ${cat}: ${items.length} items`);

  } catch (e) {
    console.error(`❌ ${cat} failed: ${String(e?.message || e)}`);
    // salviamo file vuoto per non rompere la build
    fs.writeFileSync(path.join(OUT_DIR, `${cat}.json`), JSON.stringify([], null, 2), "utf8");
    index[cat] = 0;
  }
}

// index.json
fs.writeFileSync(
  path.join(OUT_DIR, "index.json"),
  JSON.stringify(
    {
      region: REGION_ID,
      generatedAt: new Date().toISOString(),
      counts: index,
    },
    null,
    2
  ),
  "utf8"
);

console.log("\n🎉 DONE");
