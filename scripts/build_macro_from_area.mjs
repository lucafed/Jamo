// scripts/build_macro_from_area.mjs
// Build macro AUTO-ONLY from:
// - public/data/bbox/<areaId>.json
// - public/data/pois_eu_uk.json (optional)
// - public/data/curated_destinations_eu_uk.json (optional)
// Output (based on areaId):
// - it_<region>        -> public/data/macros/it_macro_01_<region>.json
// - euuk_country_xx    -> public/data/macros/euuk_country_xx.json
// - other              -> public/data/macros/<areaId>.json
//
// Usage:
//   node scripts/build_macro_from_area.mjs it_abruzzo
//   node scripts/build_macro_from_area.mjs euuk_country_it

import fs from "fs";
import path from "path";

const ROOT = process.cwd();

const AREAS_FILE = path.join(ROOT, "public", "data", "areas.json");
const BBOX_DIR = path.join(ROOT, "public", "data", "bbox");
const POIS_FILE = path.join(ROOT, "public", "data", "pois_eu_uk.json");
const CURATED_FILE = path.join(ROOT, "public", "data", "curated_destinations_eu_uk.json");
const OUT_DIR = path.join(ROOT, "public", "data", "macros");

const areaId = process.argv[2];
if (!areaId) {
  console.error("❌ Missing area id. Example: node scripts/build_macro_from_area.mjs it_abruzzo");
  process.exit(1);
}

// -------------------- UTIL --------------------
function readJsonSafe(p, fallback = null) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.warn("⚠️ readJsonSafe failed:", p, e?.message || e);
    return fallback;
  }
}

function writeJsonCompact(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj), "utf8");
}

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slugify(s) {
  return norm(s).replace(/\s+/g, "_").slice(0, 80);
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function toRad(x) {
  return (x * Math.PI) / 180;
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function uniqueByKey(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!k) continue;
    const prev = m.get(k);
    if (!prev) m.set(k, it);
    else {
      // tieni quello con beauty_score maggiore
      const a = Number(prev.beauty_score) || 0;
      const b = Number(it.beauty_score) || 0;
      if (b > a) m.set(k, it);
    }
  }
  return [...m.values()];
}

function outPathFor(areaId) {
  if (areaId.startsWith("it_")) {
    const reg = areaId.replace(/^it_/, "");
    return path.join(OUT_DIR, `it_macro_01_${reg}.json`);
  }
  if (areaId.startsWith("euuk_country_")) {
    return path.join(OUT_DIR, `${areaId}.json`);
  }
  // fallback
  return path.join(OUT_DIR, `${areaId}.json`);
}

function macroIdFor(areaId) {
  if (areaId.startsWith("it_")) return `it_macro_01_${areaId.replace(/^it_/, "")}`;
  if (areaId.startsWith("euuk_country_")) return areaId;
  return `macro_${areaId}`;
}

function macroNameFor(area) {
  // area: {name, country, scope}
  const n = area?.name || area?.id || "Area";
  const cc = area?.country ? ` (${area.country})` : "";
  return `Macro — ${n}${cc} — AUTO-ONLY`;
}

// -------------------- TAGGING / TYPE --------------------
function tagAdd(set, ...tags) {
  for (const t of tags) {
    const k = norm(t);
    if (k) set.add(k);
  }
}

// POI -> tags (usa sia types che name)
function tagsFromPoi(p) {
  const out = new Set();
  const name = norm(p?.name);
  const types = Array.isArray(p?.types) ? p.types.map(norm) : [];

  // se WDQS types già buoni
  for (const t of types) {
    if (t === "mare") tagAdd(out, "mare", "spiagge");
    if (t === "montagna") tagAdd(out, "montagna", "panorama");
    if (t === "natura") tagAdd(out, "natura");
    if (t === "relax") tagAdd(out, "relax", "terme");
    if (t === "bambini") tagAdd(out, "famiglie", "bambini", "family");
  }

  // fallback dal nome (tanto per)
  const has = (w) => name.includes(w);

  if (has("spiaggia") || has("beach") || has("lido")) tagAdd(out, "mare", "spiagge");
  if (has("monte") || has("mountain") || has("peak") || has("ski")) tagAdd(out, "montagna", "neve");
  if (has("parco") || has("park") || has("nature")) tagAdd(out, "natura");
  if (has("cascata") || has("waterfall")) tagAdd(out, "natura", "fotografico");
  if (has("lago") || has("lake")) tagAdd(out, "natura", "lago", "relax");
  if (has("terme") || has("spa") || has("hot spring")) tagAdd(out, "relax", "terme");
  if (has("zoo") || has("acquario") || has("aquarium") || has("theme park") || has("amusement")) tagAdd(out, "famiglie", "bambini", "family");
  if (has("museo") || has("museum") || has("abbazia") || has("castle") || has("castello") || has("cathedral") || has("cattedrale"))
    tagAdd(out, "storia", "museo");

  // ristorazione non la mettiamo nei macro (serve come link in app.js)
  return out;
}

function normalizeType(placeName, tags, rawType = "") {
  const n = norm(placeName);
  const t = norm(rawType);

  // prima tags forti
  if (tags.has("mare") || tags.has("spiagge") || n.includes("spiaggia") || n.includes("lido")) return "mare";
  if (tags.has("montagna") || tags.has("neve") || n.includes("monte") || n.includes("gran sasso") || n.includes("majella")) return "montagna";
  if (tags.has("storia") || tags.has("museo") || n.includes("abbazia") || n.includes("castello") || n.includes("duomo") || n.includes("eremo")) return "storia";
  if (tags.has("famiglie") || tags.has("bambini") || tags.has("family")) return "family";
  if (tags.has("relax") || tags.has("terme")) return "relax";
  if (tags.has("natura") || tags.has("lago") || n.includes("gole") || n.includes("riserva") || n.includes("parco")) return "natura";

  // fallback raw
  if (t === "borgo" || n.includes("borgo")) return "borgo";
  if (t === "citta" || t === "città" || n.includes("city")) return "citta";

  // fallback dal nome
  if (n.includes("marina")) return "mare";
  return "borgo";
}

function normalizeVisibility(pop = 0, tags, fallback = "") {
  const v = norm(fallback);
  if (v === "chicca" || v === "conosciuta") return v;

  // famiglie: spesso “conosciuta” se è un parco grosso
  if (tags.has("bambini") && pop >= 8000) return "conosciuta";
  if (pop >= 70000) return "conosciuta";
  if (pop >= 15000) return "conosciuta";
  return "chicca";
}

function computeBeautyScore(tags, poiCount, pop) {
  let s = 0.78;

  if (tags.has("mare") || tags.has("spiagge")) s += 0.08;
  if (tags.has("montagna") || tags.has("panorama")) s += 0.07;
  if (tags.has("natura") || tags.has("lago")) s += 0.06;
  if (tags.has("storia") || tags.has("museo")) s += 0.05;
  if (tags.has("famiglie") || tags.has("bambini") || tags.has("family")) s += 0.05;
  if (tags.has("relax") || tags.has("terme")) s += 0.04;

  // densità POI vicini (cap)
  s += clamp(Math.log10(1 + (poiCount || 0)) / 2.4, 0, 0.14);

  // penalizza metropoli enormi (non sempre “gita”)
  if ((pop || 0) >= 600000) s -= 0.04;

  return Number(clamp(s, 0.68, 1.0).toFixed(2));
}

function whyFrom(tags, poiCount) {
  const out = [];
  if (tags.has("famiglie") || tags.has("bambini") || tags.has("family")) out.push("Ottimo per famiglie: attività e posti adatti anche ai bambini.");
  if (tags.has("storia")) out.push("Cose da vedere: centro storico, monumenti e tappe culturali.");
  if (tags.has("mare")) out.push("Mare e relax: spiagge, passeggiate e atmosfera estiva.");
  if (tags.has("montagna")) out.push("Outdoor in montagna: panorami, aria pulita e gite.");
  if (tags.has("natura")) out.push("Natura forte: sentieri, scorci e punti fotografici.");
  if (tags.has("relax")) out.push("Relax: terme/spa o vibe tranquilla.");

  if ((poiCount || 0) >= 12) out.push("Tante cose da fare nei dintorni.");
  else if ((poiCount || 0) >= 5) out.push("Diversi punti di interesse nei dintorni.");

  if (!out.length) out.push("Buona scelta per una gita easy, con alternative nei dintorni.");
  return out.slice(0, 4);
}

// -------------------- MAIN --------------------
async function main() {
  const areas = readJsonSafe(AREAS_FILE, []);
  const area = Array.isArray(areas) ? areas.find((a) => a.id === areaId) : null;
  if (!area) {
    console.error("❌ Area not found in public/data/areas.json:", areaId);
    process.exit(1);
  }

  const bboxFile = path.join(BBOX_DIR, `${areaId}.json`);
  const bboxJson = readJsonSafe(bboxFile, null);
  if (!bboxJson) {
    console.error("❌ BBox file missing or invalid:", bboxFile);
    process.exit(1);
  }
  const bboxPlaces = Array.isArray(bboxJson?.places) ? bboxJson.places : Array.isArray(bboxJson) ? bboxJson : [];

  // POIs optional
  const poisJson = readJsonSafe(POIS_FILE, null);
  const pois = Array.isArray(poisJson?.pois) ? poisJson.pois : [];

  // curated optional
  const curatedJson = readJsonSafe(CURATED_FILE, null);
  const curatedPlaces = Array.isArray(curatedJson?.places) ? curatedJson.places : [];

  // --- build POI grid index (fast) ---
  const cell = 0.08; // ~9km lat
  const grid = new Map();

  function gridKey(lat, lon) {
    const a = Math.floor(lat / cell);
    const b = Math.floor(lon / cell);
    return `${a}:${b}`;
  }

  for (const po of pois) {
    const lat = safeNum(po?.lat);
    const lon = safeNum(po?.lng ?? po?.lon);
    if (lat === null || lon === null) continue;
    const k = gridKey(lat, lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push({ ...po, lat, lon });
  }

  function nearbyPois(lat, lon, kmMax = 10) {
    const a = Math.floor(lat / cell);
    const b = Math.floor(lon / cell);
    const bucket = [];
    for (let da = -1; da <= 1; da++) {
      for (let db = -1; db <= 1; db++) {
        const arr = grid.get(`${a + da}:${b + db}`);
        if (arr && arr.length) bucket.push(...arr);
      }
    }
    const res = [];
    for (const po of bucket) {
      const km = haversineKm(lat, lon, po.lat, po.lon);
      if (km <= kmMax) res.push(po);
    }
    return res;
  }

  // --- base macro header ---
  const out = {
    id: macroIdFor(areaId),
    name: macroNameFor(area),
    version: "3.0.0",
    updated_at: new Date().toISOString().slice(0, 10),
    coverage: {
      scope: area.scope || (areaId.startsWith("it_") ? "region" : "area"),
      country: area.country || null,
      area_id: areaId,
      area_name: area.name || null,
    },
    rules: {
      mode: "car_only",
      offline_and_stable: true,
      prefer_primary_area_first: true,
    },
    schema: {
      place_fields: ["id", "name", "type", "area", "country", "lat", "lon", "tags", "visibility", "beauty_score", "why"],
    },
    places: [],
  };

  // --- helper to push place normalized ---
  function pushPlace(raw, { forceAreaName = null, forceCountry = null, boostTags = [] } = {}) {
    const name = raw?.name;
    const lat = safeNum(raw?.lat);
    const lon = safeNum(raw?.lng ?? raw?.lon);
    if (!name || lat === null || lon === null) return;

    const pop = safeNum(raw?.population) ?? 0;

    const tags = new Set();
    // bbox tags
    if (Array.isArray(raw?.tags)) raw.tags.forEach((t) => tagAdd(tags, t));
    if (Array.isArray(raw?.vibes)) raw.vibes.forEach((t) => tagAdd(tags, t));

    // curated tags
    if (Array.isArray(raw?.types)) raw.types.forEach((t) => tagAdd(tags, t));
    if (Array.isArray(raw?.categories)) raw.categories.forEach((t) => tagAdd(tags, t));

    // POIs around
    const near = nearbyPois(lat, lon, 10);
    for (const po of near) {
      const t = tagsFromPoi(po);
      for (const x of t) tags.add(x);
    }

    // name-based hints to not lose “borghi” etc.
    const n = norm(name);
    if (n.includes("borgo") || n.includes("castel") || n.includes("rocca")) tagAdd(tags, "borgo");
    if (n.includes("parco") || n.includes("park")) tagAdd(tags, "natura");
    if (n.includes("luna park") || n.includes("parco avventura") || n.includes("zoo") || n.includes("acquario"))
      tagAdd(tags, "famiglie", "bambini", "family");
    if (n.includes("abbazia") || n.includes("duomo") || n.includes("museo") || n.includes("castello") || n.includes("cattedrale"))
      tagAdd(tags, "storia");

    // forced boosts
    boostTags.forEach((t) => tagAdd(tags, t));

    // ensure some minimal classification tags (don’t leave empty)
    if (tags.size === 0) tagAdd(tags, "borgo");

    const type = normalizeType(name, tags, raw?.type || raw?.kind || "");
    const visibility = normalizeVisibility(pop, tags, raw?.visibility || "");
    const beauty_score = computeBeautyScore(tags, near.length, pop);

    out.places.push({
      id: String(raw?.id || `${areaId}_${slugify(name)}_${String(lat).slice(0, 6)}_${String(lon).slice(0, 6)}`),
      name: String(name),
      type,
      area: String(forceAreaName || raw?.area || area.name || areaId),
      country: String(forceCountry || raw?.country || area.country || ""),
      lat,
      lon,
      tags: [...tags].slice(0, 18),
      visibility,
      beauty_score,
      why: whyFrom(tags, near.length),
    });
  }

  // 1) Add curated first (keeps “top picks”)
  // We include curated that match this area by:
  // - area.name match OR region match OR country match + inside bbox envelope approx
  const bboxLats = bboxPlaces.map((p) => safeNum(p?.lat)).filter((x) => x !== null);
  const bboxLons = bboxPlaces.map((p) => safeNum(p?.lng ?? p?.lon)).filter((x) => x !== null);

  const minLat = bboxLats.length ? Math.min(...bboxLats) : null;
  const maxLat = bboxLats.length ? Math.max(...bboxLats) : null;
  const minLon = bboxLons.length ? Math.min(...bboxLons) : null;
  const maxLon = bboxLons.length ? Math.max(...bboxLons) : null;

  function inBbox(lat, lon) {
    if (minLat === null || minLon === null || maxLat === null || maxLon === null) return true;
    return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
  }

  const areaNameN = norm(area?.name);
  const areaCountry = String(area?.country || "").toUpperCase();

  for (const c of curatedPlaces) {
    const lat = safeNum(c?.lat);
    const lon = safeNum(c?.lon ?? c?.lng);
    if (lat === null || lon === null) continue;

    const cAreaN = norm(c?.area || c?.region || "");
    const cCountry = String(c?.country || "").toUpperCase();

    const matchByName = !!areaNameN && !!cAreaN && (cAreaN === areaNameN || cAreaN.includes(areaNameN) || areaNameN.includes(cAreaN));
    const matchByCountry = !!areaCountry && !!cCountry && areaCountry === cCountry;

    if (matchByName || (matchByCountry && inBbox(lat, lon))) {
      pushPlace(
        { ...c, lat, lon },
        { forceAreaName: area.name, forceCountry: area.country, boostTags: ["chicca"] }
      );
    }
  }

  // 2) Add bbox places
  for (const p of bboxPlaces) {
    pushPlace(
      {
        ...p,
        lon: p?.lng ?? p?.lon,
      },
      { forceAreaName: area.name, forceCountry: area.country }
    );
  }

  // 3) Dedup (by name + rounding coords)
  out.places = uniqueByKey(out.places, (p) => `${norm(p.name)}_${Number(p.lat).toFixed(3)}_${Number(p.lon).toFixed(3)}`);

  // 4) Sort by beauty_score desc (and keep family visible)
  out.places.sort((a, b) => {
    // slight boost family so it appears often
    const af = a.type === "family" || a.tags?.includes("famiglie") ? 0.02 : 0;
    const bf = b.type === "family" || b.tags?.includes("famiglie") ? 0.02 : 0;
    const as = (Number(a.beauty_score) || 0) + af;
    const bs = (Number(b.beauty_score) || 0) + bf;
    if (bs !== as) return bs - as;
    return norm(a.name).localeCompare(norm(b.name));
  });

  // 5) Write
  const outFile = outPathFor(areaId);
  writeJsonCompact(outFile, out);

  console.log("✅ Macro generato:", outFile);
  console.log("Mete:", out.places.length);

  const counts = {};
  for (const p of out.places) counts[p.type] = (counts[p.type] || 0) + 1;
  console.log("Type counts:", counts);
}

main().catch((e) => {
  console.error("❌ build_macro_from_area failed:", e?.message || e);
  process.exit(1);
});
