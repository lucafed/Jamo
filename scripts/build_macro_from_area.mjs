// scripts/build_macro_from_area.mjs
// Build macro AUTO-ONLY (offline) for a single areaId from:
// - public/data/areas.json
// - public/data/bbox/<areaId>.json
// - public/data/pois_eu_uk.json
// - public/data/curated_destinations_eu_uk.json (optional)
// Output (IMPORTANT: names aligned with macros_index.json expectations):
// - IT region: public/data/macros/it_macro_01_<region>.json
// - EU country: public/data/macros/eu_macro_<cc>.json
// - fallback:  public/data/macros/macro_<areaId>.json
//
// Usage:
//   node scripts/build_macro_from_area.mjs it_abruzzo
//   node scripts/build_macro_from_area.mjs eu_fr
//
// Node 18+/20 OK (ESM)

import fs from "fs";
import path from "path";

const ROOT = process.cwd();

const AREAS_FILE = path.join(ROOT, "public", "data", "areas.json");
const BBOX_DIR   = path.join(ROOT, "public", "data", "bbox");
const POIS_FILE  = path.join(ROOT, "public", "data", "pois_eu_uk.json");
const CURATED    = path.join(ROOT, "public", "data", "curated_destinations_eu_uk.json");
const OUT_DIR    = path.join(ROOT, "public", "data", "macros");

const areaId = process.argv[2];
if (!areaId) {
  console.error("❌ Missing area id. Example: node scripts/build_macro_from_area.mjs it_abruzzo");
  process.exit(1);
}

// -------------------- safe json --------------------
function readJsonSafe(p, fallback = null) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error("readJsonSafe failed:", p, e?.message || e);
    return fallback;
}

// areas.json can be: [..] OR {areas:[..]} OR {items:[..]}
function loadAreas() {
  const raw = readJsonSafe(AREAS_FILE, null);
  if (!raw) throw new Error("areas.json missing or invalid");
  const arr = Array.isArray(raw) ? raw
    : Array.isArray(raw.areas) ? raw.areas
    : Array.isArray(raw.items) ? raw.items
    : null;
  if (!arr) throw new Error("areas.json format not supported (expected array or {areas:[..]} or {items:[..]})");
  return arr;
}

// bbox/<areaId>.json can be {places:[..]} OR {items:[..]} OR [..]
function loadBBox(areaId) {
  const bboxFile = path.join(BBOX_DIR, `${areaId}.json`);
  if (!fs.existsSync(bboxFile)) throw new Error(`BBox file missing: ${bboxFile}`);
  const raw = readJsonSafe(bboxFile, null);
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.places)) return raw.places;
  if (Array.isArray(raw.items)) return raw.items;
  return [];
}

function loadPois() {
  const raw = readJsonSafe(POIS_FILE, null);
  if (!raw) return [];
  if (Array.isArray(raw.pois)) return raw.pois;
  if (Array.isArray(raw.items)) return raw.items;
  if (Array.isArray(raw)) return raw;
  return [];
}

function loadCurated() {
  const raw = readJsonSafe(CURATED, null);
  if (!raw) return [];
  if (Array.isArray(raw.places)) return raw.places;
  if (Array.isArray(raw.items)) return raw.items;
  if (Array.isArray(raw)) return raw;
  return [];
}

// -------------------- utils --------------------
const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function toRad(x) { return (x * Math.PI) / 180; }
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

function hasAny(text, words) {
  const s = norm(text);
  return words.some(w => s.includes(norm(w)));
}

// -------------------- POI → tags (VERY IMPORTANT for Family/Storia/Borghi) --------------------
function tagsFromPoi(poi) {
  const out = new Set();
  const name = norm(poi?.name);
  const types = Array.isArray(poi?.types) ? poi.types.map(norm) : [];
  const t0 = types.join(" ");

  const has = (w) => name.includes(w) || t0.includes(w);

  // FAMILY / KIDS / FUN
  if (has("bambini") || has("kids") || has("family")) tagAdd(out, "famiglie", "bambini");
  if (has("theme") || has("amusement") || has("parco divert") || has("luna park")) tagAdd(out, "famiglie", "bambini", "parco_divertimenti");
  if (has("water park") || has("acquapark") || has("parco acquat")) tagAdd(out, "famiglie", "bambini", "acqua");
  if (has("zoo") || has("acquario") || has("wildlife") || has("fauna")) tagAdd(out, "famiglie", "bambini", "animali");
  if (has("playground") || has("area giochi") || has("giochi")) tagAdd(out, "famiglie", "bambini");
  if (has("farm") || has("fattoria") || has("agritur")) tagAdd(out, "famiglie", "bambini", "cibo");

  // CULTURE / HISTORY
  if (has("museum") || has("museo")) tagAdd(out, "storia", "museo");
  if (has("castle") || has("castello") || has("fort") || has("rocca")) tagAdd(out, "storia", "castello");
  if (has("abbey") || has("abbazia") || has("church") || has("cattedrale") || has("santuario") || has("eremo"))
    tagAdd(out, "storia", "abbazia");
  if (has("archeo") || has("roman") || has("teatro") || has("anfiteatro")) tagAdd(out, "storia");

  // NATURE / OUTDOOR
  if (has("national park") || has("parco nazionale") || has("riserva") || has("nature")) tagAdd(out, "natura");
  if (has("trail") || has("sentiero") || has("trek") || has("hike")) tagAdd(out, "natura", "trekking");
  if (has("lake") || has("lago")) tagAdd(out, "natura", "lago", "relax");
  if (has("waterfall") || has("cascata")) tagAdd(out, "natura", "fotografico");
  if (has("viewpoint") || has("belvedere") || has("panorama")) tagAdd(out, "panorama", "fotografico");

  // SEA / MOUNTAIN / RELAX
  if (has("beach") || has("spiaggia") || has("lido")) tagAdd(out, "mare", "spiagge", "relax");
  if (has("mountain") || has("monte") || has("ski") || has("piste") || has("neve")) tagAdd(out, "montagna", "neve", "sport");
  if (has("hot spring") || has("terme") || has("spa") || has("thermal")) tagAdd(out, "relax", "terme");

  // FOOD
  if (has("restaurant") || has("ristor") || has("tratt") || has("oster") || has("cantina") || has("wine"))
    tagAdd(out, "cibo");

  return out;
}

// -------------------- type / visibility --------------------
function normalizeType(rawType, name, tags) {
  const t = norm(rawType);
  const n = norm(name);

  // family first (per UX)
  if (tags.has("famiglie") || tags.has("bambini")) return "bambini";
  if (tags.has("mare") || tags.has("spiagge") || n.includes("spiaggia") || n.includes("lido")) return "mare";
  if (tags.has("montagna") || tags.has("neve") || n.includes("monte")) return "montagna";
  if (tags.has("storia") || tags.has("castello") || tags.has("abbazia") || tags.has("museo")) return "storia";
  if (tags.has("relax") || tags.has("terme")) return "relax";
  if (tags.has("natura") || tags.has("trekking") || tags.has("lago") || n.includes("gole") || n.includes("riserva")) return "natura";

  // borghi / citta
  if (t === "borgo" || n.includes("borgo")) return "borgo";
  if (t === "citta" || t === "città" || t === "city") return "citta";

  // fallback: if tiny settlement => borgo
  return "borgo";
}

function normalizeVisibility(rawVis, pop = 0, beauty = 0.8) {
  const v = norm(rawVis);
  if (v === "chicca" || v === "conosciuta") return v;
  if (pop >= 150000) return "conosciuta";
  if (beauty >= 0.9) return "conosciuta";
  return pop >= 15000 ? "conosciuta" : "chicca";
}

// -------------------- scoring / why --------------------
function computeBeautyScore({ pop = 0, poiCount = 0, tags }) {
  let s = 0.78;

  // POI density bonus
  s += clamp(Math.log10(1 + poiCount) / 2.0, 0, 0.20);

  // big bonuses for family & wow
  if (tags.has("famiglie") || tags.has("bambini")) s += 0.08;
  if (tags.has("mare") || tags.has("spiagge")) s += 0.07;
  if (tags.has("montagna") || tags.has("panorama")) s += 0.06;
  if (tags.has("natura") || tags.has("lago") || tags.has("trekking")) s += 0.06;
  if (tags.has("storia") || tags.has("castello") || tags.has("museo") || tags.has("abbazia")) s += 0.05;

  // cities too huge are less "gita"
  if (pop >= 700000) s -= 0.06;

  return Number(clamp(s, 0.65, 1.0).toFixed(2));
}

function whyFrom(tags, poiCount) {
  const out = [];

  // hook
  if (tags.has("famiglie") || tags.has("bambini")) out.push("Perfetto per famiglie: attività e posti adatti ai bambini.");
  else if (tags.has("mare")) out.push("Meta di mare: relax, passeggiata e scorci fotografici.");
  else if (tags.has("montagna")) out.push("Ottimo per aria buona e panorami: gita outdoor in montagna.");
  else if (tags.has("storia")) out.push("Tanta storia da vedere: monumenti, musei o borghi interessanti.");
  else if (tags.has("natura")) out.push("Natura e sentieri: ideale per passeggiate e foto.");
  else out.push("Buona idea per una gita semplice e piacevole.");

  // evidence
  if (poiCount >= 20) out.push("Tantissime cose da fare nei dintorni.");
  else if (poiCount >= 8) out.push("Diverse attività interessanti nei dintorni.");

  if (tags.has("trekking")) out.push("Ci sono sentieri e trekking (anche facili).");
  if (tags.has("terme")) out.push("Relax: presenti terme/spa in zona.");
  if (tags.has("animali")) out.push("Animali e parchi: ottimo con i bimbi.");

  return out.slice(0, 4);
}

// -------------------- POI grid index (FAST) --------------------
function buildPoiGrid(pois, cell = 0.10) {
  const grid = new Map(); // key -> poi[]
  const key = (lat, lon) => `${Math.floor(lat / cell)}:${Math.floor(lon / cell)}`;

  for (const po of pois) {
    const lat = safeNum(po?.lat);
    const lon = safeNum(po?.lng ?? po?.lon);
    if (lat === null || lon === null) continue;

    const k = key(lat, lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push({ ...po, lat, lon });
  }

  function nearby(lat, lon, kmRadius = 10) {
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
    const res = [];
    for (const po of bucket) {
      const km = haversineKm(lat, lon, po.lat, po.lon);
      if (km <= kmRadius) res.push({ ...po, km: Number(km.toFixed(2)) });
    }
    res.sort((x, y) => (x.km - y.km) || ((y.beauty_score || 0) - (x.beauty_score || 0)));
    return res;
  }

  return { nearby };
}

// -------------------- output naming (fix 404 in app) --------------------
function outFileForArea(areaId) {
  // it_<region>
  if (areaId.startsWith("it_")) {
    const slug = areaId.slice(3);
    return path.join(OUT_DIR, `it_macro_01_${slug}.json`);
  }
  // eu_<cc>
  if (areaId.startsWith("eu_")) {
    const cc = areaId.slice(3).toLowerCase();
    return path.join(OUT_DIR, `eu_macro_${cc}.json`);
  }
  // euuk_country_<cc> (if you ever call it directly)
  if (areaId.startsWith("euuk_country_")) {
    return path.join(OUT_DIR, `${areaId}.json`);
  }
  // fallback
  return path.join(OUT_DIR, `macro_${areaId}.json`);
}

// -------------------- main --------------------
function main() {
  const areas = loadAreas();
  const area = areas.find(a => (a.id || a.area_id || a.slug) === areaId);
  if (!area) throw new Error(`Area not found in areas.json: ${areaId}`);

  const bboxPlaces = loadBBox(areaId);

  const poisAll = loadPois();
  const poiGrid = buildPoiGrid(poisAll, 0.10);

  const curatedAll = loadCurated();
  const curatedForArea = curatedAll.filter(x => {
    const a = norm(x.area || x.region || x.country || "");
    const target = norm(area.name || area.label || areaId);
    return a && target && a.includes(target);
  });

  const out = {
    id: areaId,
    name: `Macro ${area.name || area.label || areaId} — AUTO-ONLY (offline)`,
    version: "4.0.0",
    updated_at: new Date().toISOString().slice(0, 10),
    coverage: {
      area_id: areaId,
      label: area.name || area.label || areaId,
      country: area.country || area.cc || area.iso2 || null,
    },
    schema: {
      place_fields: [
        "id","name","type","area","country","lat","lon","tags","visibility","beauty_score","why",
        "nearby_pois" // extra: lista compatta “cosa fare nei dintorni”
      ]
    },
    places: []
  };

  // 1) curated first (se ci sono)
  for (const c of curatedForArea) {
    const lat = safeNum(c.lat);
    const lon = safeNum(c.lon ?? c.lng);
    if (!c.name || lat === null || lon === null) continue;

    const tags = new Set(Array.isArray(c.tags) ? c.tags.map(norm) : []);
    // curated can add explicit family/storia/borghi
    const n = norm(c.name);
    if (n.includes("castello") || n.includes("abbazia") || n.includes("eremo")) tagAdd(tags, "storia");
    if (n.includes("parco") || n.includes("zoo") || n.includes("acquario")) tagAdd(tags, "famiglie", "bambini");

    const near = poiGrid.nearby(lat, lon, 12);
    for (const po of near) for (const t of tagsFromPoi(po)) tags.add(t);

    const poiCount = near.length;
    const beauty = computeBeautyScore({ pop: safeNum(c.population) ?? 0, poiCount, tags });
    const visibility = normalizeVisibility(c.visibility, safeNum(c.population) ?? 0, beauty);

    uniquePush(out.places, {
      id: String(c.id || safeIdFrom(c.name, lat, lon, "cur")),
      name: String(c.name),
      type: normalizeType(c.type, c.name, tags),
      area: String(c.area || area.name || area.label || areaId),
      country: String(c.country || area.country || "IT"),
      lat, lon,
      tags: [...tags].slice(0, 24),
      visibility,
      beauty_score: beauty,
      why: Array.isArray(c.why) ? c.why.slice(0, 4) : whyFrom(tags, poiCount),
      nearby_pois: near.slice(0, 18).map(po => ({
        name: po.name,
        km: po.km,
        types: po.types || [],
        country: po.country || null,
        wd: po.wd || null
      }))
    });
  }

  // 2) bbox places: filter “bad names” and build rich tags
  const badNameHints = [
    "nucleo industriale",
    "zona industriale",
    "area industriale",
    "interporto",
    "polo logistico",
    "deposito",
    "magazzino",
    "autostrada",
    "svincolo",
    "stazione di servizio",
    "centro commerciale"
  ];

  for (const p of bboxPlaces) {
    const name = p?.name;
    const lat = safeNum(p?.lat);
    const lon = safeNum(p?.lng ?? p?.lon);
    if (!name || lat === null || lon === null) continue;

    const n = norm(name);
    if (badNameHints.some(x => n.includes(x))) continue; // 🔥 taglia schifezze industriali

    const pop = safeNum(p?.population) ?? 0;

    // nearby POIs
    const near = poiGrid.nearby(lat, lon, 10); // 10 km intorno
    const poiCount = near.length;

    // tags: from bbox + from POIs + from name heuristics
    const tags = new Set();

    if (Array.isArray(p.tags)) p.tags.forEach(t => tagAdd(tags, t));
    if (Array.isArray(p.vibes)) p.vibes.forEach(v => tagAdd(tags, v));

    // name hints (borghi/storia/family)
    if (hasAny(name, ["borgo", "rocca", "castello", "abbazia", "eremo", "cattedrale"])) tagAdd(tags, "storia");
    if (hasAny(name, ["parco", "zoo", "acquario", "avventura", "fattoria", "giardino"])) tagAdd(tags, "famiglie", "bambini");
    if (hasAny(name, ["spiaggia", "lido", "marina", "traboc"])) tagAdd(tags, "mare", "spiagge");
    if (hasAny(name, ["monte", "pizzo", "cima", "rifugio", "campo", "ski"])) tagAdd(tags, "montagna");
    if (hasAny(name, ["lago", "gole", "canyon", "riserva"])) tagAdd(tags, "natura");

    // POI-driven tags (this is what unlocks FAMILY everywhere)
    for (const po of near) {
      for (const t of tagsFromPoi(po)) tags.add(t);
    }

    // IMPORTANT: do NOT discard “tagless” places completely.
    // Give them a minimum tag so they can still appear (but with lower beauty).
    if (tags.size === 0) {
      // if it's small => borgo, else city-ish
      if (pop > 90000) tagAdd(tags, "citta");
      else tagAdd(tags, "borgo");
    }

    const beauty = computeBeautyScore({ pop, poiCount, tags });
    const visibility = normalizeVisibility(p.visibility, pop, beauty);
    const type = normalizeType(p.type, name, tags);

    uniquePush(out.places, {
      id: String(p.id || safeIdFrom(name, lat, lon, areaId)),
      name: String(name),
      type,
      area: String(area.name || area.label || areaId),
      country: String(area.country || p.country || p.cc || "IT"),
      lat,
      lon,
      tags: [...tags].slice(0, 24),
      visibility,
      beauty_score: beauty,
      why: whyFrom(tags, poiCount),
      nearby_pois: near.slice(0, 18).map(po => ({
        name: po.name,
        km: po.km,
        types: po.types || [],
        country: po.country || null,
        wd: po.wd || null
      }))
    });
  }

  // 3) final clean: dedup by name+coords
  const seen = new Map();
  for (const pl of out.places) {
    const k = `${norm(pl.name)}_${Number(pl.lat).toFixed(3)}_${Number(pl.lon).toFixed(3)}`;
    const prev = seen.get(k);
    if (!prev) seen.set(k, pl);
    else {
      const a = Number(prev.beauty_score) || 0;
      const b = Number(pl.beauty_score) || 0;
      if (b > a) seen.set(k, pl);
    }
  }
  out.places = [...seen.values()];

  // 4) sort: best first
  out.places.sort((a, b) => (Number(b.beauty_score) || 0) - (Number(a.beauty_score) || 0));

  // 5) write
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = outFileForArea(areaId);
  fs.writeFileSync(outFile, JSON.stringify(out), "utf8");

  console.log("✅ Macro generato:", outFile);
  console.log("Mete:", out.places.length);
  console.log("Top:", out.places[0]?.name, "-", out.places[0]?.type, "-", out.places[0]?.beauty_score);
}

main();
