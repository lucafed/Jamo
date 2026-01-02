// scripts/build_macro_it_abruzzo.mjs
// Build macro Abruzzo (AUTO-ONLY) from:
// - public/data/macros/it_macro_01_abruzzo_base.json   (optional curated base)
// - public/data/places_bbox_abruzzo_neighbors.json    (bbox places)
// - public/data/pois_eu_uk.json                       (POIs)
// Output:
// - public/data/macros/it_macro_01_abruzzo.json        (compact, stable)
//
// Node 18+ / 20 OK (ESM .mjs)

import fs from "fs";
import path from "path";

const ROOT = process.cwd();

const IN_BASE_MACRO = path.join(ROOT, "public", "data", "macros", "it_macro_01_abruzzo_base.json");
const IN_EXISTING_MACRO = path.join(ROOT, "public", "data", "macros", "it_macro_01_abruzzo.json");
const IN_BBOX = path.join(ROOT, "public", "data", "places_bbox_abruzzo_neighbors.json");
const IN_POIS = path.join(ROOT, "public", "data", "pois_eu_uk.json");

const OUT_MACRO = path.join(ROOT, "public", "data", "macros", "it_macro_01_abruzzo.json");

function readJsonSafe(p, fallback = null) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("readJsonSafe failed:", p, e?.message || e);
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

function safeIdFrom(name, lat, lon, prefix = "p") {
  const key = `${prefix}_${norm(name).replace(/\s+/g, "_")}_${String(lat).slice(0, 7)}_${String(lon).slice(0, 7)}`;
  return key.slice(0, 90);
}

function uniquePush(arr, item, byKey = "id") {
  const v = item?.[byKey];
  if (!v) return;
  if (!arr._seen) arr._seen = new Set();
  if (arr._seen.has(v)) return;
  arr._seen.add(v);
  arr.push(item);
}

function tagAdd(set, ...tags) {
  for (const t of tags) {
    const k = norm(t);
    if (k) set.add(k);
  }
}

// --- Heuristics: POI categories -> tags (monetizzabili) ---
function tagsFromPoi(poi) {
  const out = new Set();
  const name = norm(poi?.name);
  const cat = norm(poi?.category || poi?.kind || poi?.type);

  // attività monetizzabili tipiche
  const has = (w) => name.includes(w) || cat.includes(w);

  if (has("museum") || has("museo")) tagAdd(out, "storia", "arte", "museo");
  if (has("castle") || has("fort") || has("castello") || has("fortezza")) tagAdd(out, "storia", "castello");
  if (has("abbey") || has("abbazia") || has("church") || has("cattedrale") || has("santuario")) tagAdd(out, "storia");
  if (has("beach") || has("spiaggia") || has("lido")) tagAdd(out, "mare", "spiagge", "relax");
  if (has("trail") || has("hike") || has("trek") || has("sentiero")) tagAdd(out, "natura", "trekking");
  if (has("waterfall") || has("cascata")) tagAdd(out, "natura", "fotografico");
  if (has("lake") || has("lago")) tagAdd(out, "natura", "lago", "relax");
  if (has("ski") || has("sciare") || has("piste") || has("snow") || has("neve")) tagAdd(out, "montagna", "neve", "sport");
  if (has("thermal") || has("terme") || has("spa")) tagAdd(out, "relax", "terme");
  if (has("zoo") || has("fauna") || has("wildlife") || has("orso") || has("lupo")) tagAdd(out, "famiglie", "animali", "bambini");
  if (has("park") || has("parco") || has("playground") || has("giochi")) tagAdd(out, "famiglie", "bambini");
  if (has("boat") || has("kayak") || has("rafting") || has("canoe")) tagAdd(out, "avventura", "famiglie", "natura");
  if (has("bike") || has("cic") || has("ciclabile")) tagAdd(out, "bike", "natura", "famiglie");
  if (has("viewpoint") || has("panorama") || has("belvedere")) tagAdd(out, "panorama", "fotografico");
  if (has("food") || has("ristor") || has("tratt") || has("cantina") || has("wine")) tagAdd(out, "cibo");

  return out;
}

// --- Place type / visibility fix ---
function normalizeType(rawType, rawName, tags) {
  const t = norm(rawType);
  const n = norm(rawName);

  if (tags.has("mare") || tags.has("spiagge") || n.includes("spiaggia") || n.includes("trabocc")) return "mare";
  if (tags.has("montagna") || tags.has("neve") || n.includes("monte") || n.includes("gran sasso") || n.includes("majella")) return "montagna";
  if (tags.has("natura") || tags.has("lago") || tags.has("trekking") || n.includes("gole") || n.includes("riserva")) return "natura";
  if (tags.has("storia") || tags.has("castello") || tags.has("museo") || n.includes("abbazia") || n.includes("eremo")) return "storia";
  if (tags.has("relax") || tags.has("terme")) return "relax";
  if (tags.has("bambini") || tags.has("famiglie")) return "bambini";

  // fallback da source
  if (t === "citta" || t === "città" || t === "city") return "citta";
  if (t === "borgo" || t === "village") return "borgo";
  if (t) return t;

  // fallback dal nome
  if (n.includes("lido") || n.includes("marina")) return "mare";
  return "borgo";
}

function normalizeVisibility(rawVis, pop = 0, tags) {
  const v = norm(rawVis);
  if (v === "chicca" || v === "conosciuta") return v;

  // euristica: grandi città = conosciuta, altrimenti chicca
  if (pop >= 120000) return "conosciuta";
  if (tags.has("chicca")) return "chicca";
  return pop >= 15000 ? "conosciuta" : "chicca";
}

// --- beauty score heuristic (stable, offline) ---
function computeBeautyScore({ pop = 0, poiCount = 0, tags, visibility }) {
  // base by visibility
  let s = visibility === "chicca" ? 0.86 : 0.80;

  // POI density bonus (cap)
  const poiBoost = clamp(Math.log10(1 + poiCount) / 2.2, 0, 0.18);
  s += poiBoost;

  // nature/sea/mountain often “wow”
  if (tags.has("mare") || tags.has("spiagge")) s += 0.06;
  if (tags.has("montagna") || tags.has("panorama")) s += 0.05;
  if (tags.has("natura") || tags.has("lago") || tags.has("gole")) s += 0.05;
  if (tags.has("storia") || tags.has("castello") || tags.has("abbazia")) s += 0.03;
  if (tags.has("famiglie") || tags.has("bambini")) s += 0.02;

  // very large cities aren’t always “wow”
  if (pop >= 500000) s -= 0.05;

  return Number(clamp(s, 0.68, 1.0).toFixed(2));
}

function whyFrom(tags, poiCount, name) {
  const out = [];

  // 1) Hook “wow”
  if (tags.has("spiagge")) out.push("Spiagge belle e tratto di costa perfetto per relax e foto.");
  else if (tags.has("mare")) out.push("Meta di mare comoda: panorama, passeggiata e atmosfera estiva.");
  else if (tags.has("montagna")) out.push("Montagna vera: aria pulita, panorami e gite outdoor.");
  else if (tags.has("natura")) out.push("Natura forte: sentieri, scorci e spot fotografici.");
  else if (tags.has("storia")) out.push("Tanta storia: centro/monumenti e visite interessanti.");
  else out.push("Posto valido per una gita nel tempo scelto.");

  // 2) Monetizzabile / cosa fare
  if (tags.has("trekking")) out.push("Perfetto per trekking/passeggiate (anche facili).");
  if (tags.has("bike")) out.push("Ottimo anche in bici: strade e percorsi piacevoli.");
  if (tags.has("terme")) out.push("Ideale per staccare: terme/spa e relax.");
  if (tags.has("castello") || tags.has("abbazia") || tags.has("museo")) out.push("Visite culturali top (castelli/abbazie/musei).");

  // 3) Family
  if (tags.has("famiglie") || tags.has("bambini")) out.push("Family-friendly: attività e posti adatti anche ai bambini.");

  // 4) POI evidence
  if (poiCount >= 12) out.push("Tante cose da fare nei dintorni (POI + attività).");
  else if (poiCount >= 5) out.push("Diversi punti di interesse e attività nei dintorni.");

  // keep max 4
  return out.slice(0, 4);
}

function ensureMacroHeader() {
  return {
    id: "it_macro_01_abruzzo",
    name: "Macro 01 — Abruzzo (AUTO-ONLY) — Mete stabili offline",
    version: "3.0.0",
    updated_at: new Date().toISOString().slice(0, 10),
    coverage: {
      primary_region: "Abruzzo",
      neighbors_regions: ["Lazio", "Marche", "Molise", "Umbria"]
    },
    rules: {
      mode: "car_only",
      offline_and_stable: true,
      prefer_primary_region_first: true,
      fallback_allow_neighbors_if_few_results: true
    },
    schema: {
      place_fields: ["id","name","type","area","lat","lon","tags","visibility","beauty_score","why"]
    },
    places: []
  };
}

function main() {
  // 1) Load inputs
  const baseMacro = readJsonSafe(IN_BASE_MACRO, null);
  const existingMacro = readJsonSafe(IN_EXISTING_MACRO, null);

  const bbox = readJsonSafe(IN_BBOX, null);
  const pois = readJsonSafe(IN_POIS, null);

  const bboxPlaces = Array.isArray(bbox?.places) ? bbox.places : Array.isArray(bbox) ? bbox : [];
  const poiList = Array.isArray(pois?.pois) ? pois.pois : Array.isArray(pois?.items) ? pois.items : Array.isArray(pois) ? pois : [];

  // 2) Start macro header
  const out = ensureMacroHeader();

  // 3) Seed curated places (base > existing)
  const seed = (baseMacro?.places && Array.isArray(baseMacro.places))
    ? baseMacro.places
    : (existingMacro?.places && Array.isArray(existingMacro.places))
      ? existingMacro.places
      : [];

  // Add seed first (keeps your curated “best picks”)
  for (const p of seed) {
    const lat = safeNum(p?.lat);
    const lon = safeNum(p?.lon ?? p?.lng);
    if (!p?.name || lat === null || lon === null) continue;

    const tags = new Set(Array.isArray(p.tags) ? p.tags.map(norm) : []);
    const type = normalizeType(p.type, p.name, tags);
    const visibility = normalizeVisibility(p.visibility, p.population || 0, tags);

    uniquePush(out.places, {
      id: String(p.id || safeIdFrom(p.name, lat, lon, "cur")),
      name: String(p.name),
      type,
      area: String(p.area || "Abruzzo"),
      lat, lon,
      tags: [...tags],
      visibility,
      beauty_score: Number.isFinite(Number(p.beauty_score)) ? Number(p.beauty_score) : 0.85,
      why: Array.isArray(p.why) ? p.why.slice(0, 4) : whyFrom(tags, 0, p.name)
    });
  }

  // 4) Index POIs quickly (by rough grid for speed)
  // Build a simple grid index with cell size ~0.08 deg (~9km lat)
  const cell = 0.08;
  const grid = new Map(); // key -> poi[]
  function gridKey(lat, lon) {
    const a = Math.floor(lat / cell);
    const b = Math.floor(lon / cell);
    return `${a}:${b}`;
  }
  for (const poi of poiList) {
    const lat = safeNum(poi?.lat);
    const lon = safeNum(poi?.lon ?? poi?.lng);
    if (lat === null || lon === null) continue;
    const k = gridKey(lat, lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push({ ...poi, lat, lon });
  }
  function nearbyPois(lat, lon) {
    const a = Math.floor(lat / cell);
    const b = Math.floor(lon / cell);
    const bucket = [];
    for (let da = -1; da <= 1; da++) {
      for (let db = -1; db <= 1; db++) {
        const k = `${a + da}:${b + db}`;
        const arr = grid.get(k);
        if (arr && arr.length) bucket.push(...arr);
      }
    }
    // filter within 8km
    const res = [];
    for (const poi of bucket) {
      const km = haversineKm(lat, lon, poi.lat, poi.lon);
      if (km <= 8) res.push(poi);
    }
    return res;
  }

  // 5) Add bbox places (touristic + monetizzabili)
  // filter: only IT (since bbox is Abruzzo neighbors, should be IT)
  // Also: skip ultra-tiny and duplicates by near-equality
  const existingIds = new Set(out.places.map(p => String(p.id)));
  const existingKey = new Set(out.places.map(p => `${norm(p.name)}_${p.lat.toFixed(3)}_${p.lon.toFixed(3)}`));

  for (const bp of bboxPlaces) {
    const name = bp?.name;
    const lat = safeNum(bp?.lat);
    const lon = safeNum(bp?.lon ?? bp?.lng);
    if (!name || lat === null || lon === null) continue;

    const key = `${norm(name)}_${lat.toFixed(3)}_${lon.toFixed(3)}`;
    if (existingKey.has(key)) continue;

    // Only Italy for this macro
    const country = (bp?.country || bp?.cc || "").toUpperCase();
    if (country && country !== "IT") continue;

    const pop = safeNum(bp?.population) ?? 0;

    // remove too-tiny hamlets (they kill UX + monetization)
    if (pop && pop < 800) continue;

    const near = nearbyPois(lat, lon);
    const tags = new Set();

    // base tags from bbox item
    if (Array.isArray(bp.tags)) bp.tags.forEach(t => tagAdd(tags, t));
    if (bp.vibes && Array.isArray(bp.vibes)) bp.vibes.forEach(v => tagAdd(tags, v));

    // infer tags from POIs
    for (const poi of near) {
      const t = tagsFromPoi(poi);
      for (const x of t) tags.add(x);
    }

    // some name-based hints (Abruzzo specifics)
    const n = norm(name);
    if (n.includes("trabocc")) tagAdd(tags, "mare", "trabocchi", "spiagge", "panorama");
    if (n.includes("riserva")) tagAdd(tags, "natura");
    if (n.includes("lago")) tagAdd(tags, "natura", "lago", "relax");
    if (n.includes("gole") || n.includes("canyon")) tagAdd(tags, "natura", "trekking", "avventura");
    if (n.includes("terme")) tagAdd(tags, "relax", "terme");
    if (n.includes("parco")) tagAdd(tags, "natura", "famiglie");
    if (n.includes("ski") || n.includes("campo imperatore") || n.includes("ovindoli") || n.includes("roccaraso"))
      tagAdd(tags, "montagna", "neve", "sport", "famiglie");

    // ensure some minimal tags for filtering
    if (tags.size === 0) tagAdd(tags, "citta");

    const type = normalizeType(bp.type, name, tags);
    const visibility = normalizeVisibility(bp.visibility, pop, tags);

    const poiCount = near.length;
    const beauty = computeBeautyScore({ pop, poiCount, tags, visibility });

    // Decide area: default Abruzzo; else neighbor by lat/lon rough (cheap)
    // If bbox already contains region field, use it
    const area = String(bp.area || bp.region || "Abruzzo");

    const id = String(bp.id || safeIdFrom(name, lat, lon, "gn"));
    if (existingIds.has(id)) continue;

    uniquePush(out.places, {
      id,
      name: String(name),
      type,
      area,
      lat, lon,
      tags: [...tags].slice(0, 18),
      visibility,
      beauty_score: beauty,
      why: whyFrom(tags, poiCount, name)
    });

    existingIds.add(id);
    existingKey.add(key);
  }

  // 6) Final cleanup: remove duplicates by name-only collisions, keep higher beauty_score
  const byName = new Map();
  for (const p of out.places) {
    const k = norm(p.name);
    if (!k) continue;
    const prev = byName.get(k);
    if (!prev) byName.set(k, p);
    else {
      const a = Number(prev.beauty_score) || 0;
      const b = Number(p.beauty_score) || 0;
      if (b > a) byName.set(k, p);
    }
  }
  out.places = [...byName.values()];

  // 7) Sort: Abruzzo first, then by beauty_score desc
  const primary = norm(out.coverage.primary_region);
  out.places.sort((a, b) => {
    const ap = norm(a.area) === primary ? 0 : 1;
    const bp = norm(b.area) === primary ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return (Number(b.beauty_score) || 0) - (Number(a.beauty_score) || 0);
  });

  // 8) bump version/date
  out.version = "3.0.0";
  out.updated_at = new Date().toISOString().slice(0, 10);

  // 9) Write compact
  writeJsonCompact(OUT_MACRO, out);

  console.log("✅ Macro generated:", OUT_MACRO);
  console.log("Places:", out.places.length);
  console.log("Sample:", out.places[0]?.name, "-", out.places[0]?.type, "-", out.places[0]?.visibility);
}

main();
