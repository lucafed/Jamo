// scripts/build_pois_it_region.mjs
// Build POIs for an Italian region (Overpass) -> writes JSON into public/data/pois/it/<region>/
// Robust CLI: accepts --region=it-abruzzo OR --region it-abruzzo
// Node 20+ (ESM)

import fs from "fs";
import path from "path";

const ROOT = process.cwd();

function argValue(name, def = null) {
  // supports:
  //   --region=it-abruzzo
  //   --region it-abruzzo
  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    // --name=value
    if (a.startsWith(name + "=")) return a.slice((name + "=").length);

    // --name value
    if (a === name && i + 1 < argv.length && !argv[i + 1].startsWith("--")) return argv[i + 1];
  }
  return def;
}

function die(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj), "utf8");
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

async function fetchWithTimeout(url, body, timeoutMs = 45000) {
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

function overpassBody(query) {
  return `data=${encodeURIComponent(query)}`;
}

function bboxFromRegion(regionJson) {
  // region file expected format:
  // { "id": "it-abruzzo", "bbox": [minLon, minLat, maxLon, maxLat], ... }
  // OR { bbox: { minLat, minLon, maxLat, maxLon } }
  if (!regionJson) return null;

  if (Array.isArray(regionJson.bbox) && regionJson.bbox.length === 4) {
    const [minLon, minLat, maxLon, maxLat] = regionJson.bbox.map(Number);
    if ([minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
      return { minLon, minLat, maxLon, maxLat };
    }
  }

  if (regionJson.bbox && typeof regionJson.bbox === "object") {
    const minLat = Number(regionJson.bbox.minLat);
    const minLon = Number(regionJson.bbox.minLon);
    const maxLat = Number(regionJson.bbox.maxLat);
    const maxLon = Number(regionJson.bbox.maxLon);
    if ([minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
      return { minLon, minLat, maxLon, maxLat };
    }
  }

  return null;
}

function bboxClause(b) {
  // Overpass bbox: (south,west,north,east) = (minLat,minLon,maxLat,maxLon)
  return `(${b.minLat},${b.minLon},${b.maxLat},${b.maxLon})`;
}

// ---- CATEGORY QUERIES (POIs offline) ----
// Qui teniamo le categorie coerenti con la tua app:
// family, theme_park, kids_museum, storia, natura, mare, relax, viewpoints, hiking
function queryForCategory(cat, bbox) {
  const B = bboxClause(bbox);

  // Nota: solo esempi robusti e non enormi. Possiamo espandere dopo.
  if (cat === "family") return `
[out:json][timeout:45];
(
  node[tourism=theme_park]${B};
  way[tourism=theme_park]${B};
  node[leisure=water_park]${B};
  way[leisure=water_park]${B};
  node[tourism=zoo]${B};
  way[tourism=zoo]${B};
  node[tourism=aquarium]${B};
  node[amenity=aquarium]${B};
  node[leisure=playground]${B};
  way[leisure=playground]${B};
  node[tourism=museum]["name"~"bambin|kids|children|interattiv|science|planetari|museo dei bambini|children\\s?museum|science\\s?center",i]${B};
  node["name"~"acquapark|aqua\\s?park|water\\s?park|parco\\s?divertimenti|lunapark|luna\\s?park|zoo|acquario|parco\\s?avventura|fattoria\\s?didattica",i]${B};
);
out tags center;
`.trim();

  if (cat === "theme_park") return `
[out:json][timeout:45];
(
  node[tourism=theme_park]${B};
  way[tourism=theme_park]${B};
  node[leisure=water_park]${B};
  way[leisure=water_park]${B};
  node["name"~"parco\\s?divertimenti|lunapark|luna\\s?park|parco\\s?acquatico|acquapark|aqua\\s?park|water\\s?park|giostre",i]${B};
);
out tags center;
`.trim();

  if (cat === "kids_museum") return `
[out:json][timeout:45];
(
  node[tourism=museum]["name"~"bambin|kids|children|ragazz|interattiv|science|planetari|museo dei bambini|children\\s?museum|science\\s?center|planetarium",i]${B};
  node["name"~"museo dei bambini|children\\s?museum|science\\s?center|planetari|planetarium",i]${B};
);
out tags center;
`.trim();

  if (cat === "storia") return `
[out:json][timeout:45];
(
  node[historic=castle]${B};
  way[historic=castle]${B};
  node[historic=ruins]${B};
  node[historic=archaeological_site]${B};
  node[tourism=museum]${B};
  node[historic=monument]${B};
  node["name"~"castello|rocca|forte|abbazia|museo|anfiteatro|tempio|scavi|necropol|centro\\s?storico",i]${B};
);
out tags center;
`.trim();

  if (cat === "natura") return `
[out:json][timeout:45];
(
  node[natural=waterfall]${B};
  node[natural=peak]${B};
  node[leisure=nature_reserve]${B};
  way[leisure=nature_reserve]${B};
  node[boundary=national_park]${B};
  way[boundary=national_park]${B};
  node["name"~"cascata|lago|gola|riserva|parco\\s?naturale|sentiero",i]${B};
);
out tags center;
`.trim();

  if (cat === "mare") return `
[out:json][timeout:45];
(
  node[natural=beach]${B};
  way[natural=beach]${B};
  node[leisure=marina]${B};
  node["name"~"spiaggia|lido|baia|mare",i]${B};
);
out tags center;
`.trim();

  if (cat === "relax") return `
[out:json][timeout:45];
(
  node[amenity=spa]${B};
  node[leisure=spa]${B};
  node[natural=hot_spring]${B};
  node[amenity=public_bath]${B};
  node["name"~"terme|spa|thermal|benessere",i]${B};
  node[leisure=swimming_pool]${B};
  node[amenity=swimming_pool]${B};
);
out tags center;
`.trim();

  if (cat === "viewpoints") return `
[out:json][timeout:45];
(
  node[tourism=viewpoint]${B};
  node["name"~"belvedere|panoram|viewpoint|scenic|terrazza|vista",i]${B};
  node[natural=peak]${B};
);
out tags center;
`.trim();

  if (cat === "hiking") return `
[out:json][timeout:45];
(
  node[information=guidepost]${B};
  node[amenity=shelter]${B};
  node["name"~"sentiero|trail|trek|trekking|hike|hiking|via\\s?ferrata|rifugio|anello",i]${B};
);
out tags center;
`.trim();

  // fallback
  return `
[out:json][timeout:45];
(
  node[tourism=attraction]${B};
  node[tourism=museum]${B};
  node[tourism=viewpoint]${B};
);
out tags center;
`.trim();
}

function mapElementToPoi(el, fallbackType = "meta") {
  const tags = el?.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";
  const cleanedName = String(name || "").trim();
  if (!cleanedName || cleanedName.length < 2) return null;

  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  // minimal tags -> array (string)
  const outTags = [];
  const pushKV = (k, v) => { if (v != null && String(v).length) outTags.push(`${k}=${v}`); };
  pushKV("tourism", tags.tourism);
  pushKV("leisure", tags.leisure);
  pushKV("historic", tags.historic);
  pushKV("natural", tags.natural);
  pushKV("amenity", tags.amenity);
  pushKV("place", tags.place);

  if (tags.attraction) outTags.push("attraction");

  return {
    id: `osm_${el.type}_${el.id}`,
    name: cleanedName,
    lat,
    lon,
    type: fallbackType,
    visibility: "classica",
    tags: Array.from(new Set(outTags)).slice(0, 18),
  };
}

async function runOverpass(query) {
  let lastErr = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const j = await fetchWithTimeout(endpoint, overpassBody(query), 60000);
      return { ok: true, endpoint, json: j };
    } catch (e) {
      lastErr = e;
    }
  }
  return { ok: false, endpoint: "", json: null, error: lastErr };
}

async function main() {
  const region = argValue("--region", null);
  if (!region) die("Missing --region argument (example: --region=it-abruzzo)");

  const regionFile = path.join(ROOT, "public/data/regions", `${region}.json`);
  const regionJson = safeReadJson(regionFile);
  if (!regionJson) die(`Region file not found or invalid JSON: ${regionFile}`);

  const bbox = bboxFromRegion(regionJson);
  if (!bbox) die(`Missing/invalid bbox in region file: ${regionFile}`);

  const outDir = path.join(ROOT, "public/data/pois/it", region);
  ensureDir(outDir);

  const categories = [
    "family",
    "theme_park",
    "kids_museum",
    "storia",
    "natura",
    "mare",
    "relax",
    "viewpoints",
    "hiking",
  ];

  const index = {
    region,
    updated_at: new Date().toISOString().slice(0, 10),
    categories: {},
  };

  console.log(`🧭 Build POIs for region: ${region}`);
  console.log(`📦 bbox: ${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`);

  for (const cat of categories) {
    console.log(`📍 Fetch category: ${cat}`);

    const q = queryForCategory(cat, bbox);
    const r = await runOverpass(q);

    if (!r.ok || !r.json) {
      console.log(`❌ ${cat} failed: ${String(r.error?.message || r.error || "fetch failed")}`);
      index.categories[cat] = { count: 0, file: `${cat}.json`, endpoint: "" };
      writeJson(path.join(outDir, `${cat}.json`), { elements: [] });
      continue;
    }

    const els = Array.isArray(r.json.elements) ? r.json.elements : [];
    const mapped = els.map((el) => mapElementToPoi(el, cat)).filter(Boolean);

    // de-dup by name+coords
    const seen = new Set();
    const uniq = [];
    for (const p of mapped) {
      const k = `${p.name.toLowerCase()}_${String(p.lat).slice(0, 6)}_${String(p.lon).slice(0, 6)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(p);
    }

    writeJson(path.join(outDir, `${cat}.json`), { elements: uniq });
    index.categories[cat] = { count: uniq.length, file: `${cat}.json`, endpoint: r.endpoint };

    console.log(`✅ ${cat}: ${uniq.length} items (endpoint: ${r.endpoint})`);
  }

  writeJson(path.join(outDir, `index.json`), index);
  console.log(`🎉 Done. Wrote: ${outDir}/index.json`);
}

main().catch((e) => {
  console.error("❌ Failed:", e);
  process.exit(1);
});
