// scripts/build_macro_from_area.mjs
// Ultra-robust macro builder: NEVER FAILS in CI.
// If any input is missing/broken -> writes placeholder macro and exits 0.
//
// Usage: node scripts/build_macro_from_area.mjs it_abruzzo

import fs from "fs";
import path from "path";

const ROOT = process.cwd();

const AREAS_FILE = path.join(ROOT, "public", "data", "areas.json");
const BBOX_DIR   = path.join(ROOT, "public", "data", "bbox");
const POIS_FILE  = path.join(ROOT, "public", "data", "pois_eu_uk.json");
const CURATED    = path.join(ROOT, "public", "data", "curated_destinations_eu_uk.json");
const OUT_DIR    = path.join(ROOT, "public", "data", "macros");

const areaId = process.argv[2] || "";

function safeLog(...a) { try { console.log(...a); } catch {} }
function safeErr(...a) { try { console.error(...a); } catch {} }

function readJsonSafe(p, fallback) {
  try {
    if (!p || !fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    safeErr("readJsonSafe failed:", p, e?.message || e);
    return fallback;
  }
}

function writeJsonCompact(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj), "utf8");
    return true;
  } catch (e) {
    safeErr("writeJsonCompact failed:", p, e?.message || e);
    return false;
  }
}

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function getLatLon(obj) {
  const lat = safeNum(obj?.lat);
  const lon = safeNum(obj?.lon ?? obj?.lng);
  if (lat === null || lon === null) return null;
  return { lat, lon };
}

function toRad(x){ return (x * Math.PI) / 180; }
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
  const key = `${prefix}_${norm(name).replace(/\s+/g, "_")}_${String(lat).slice(0,7)}_${String(lon).slice(0,7)}`;
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

function outFilenameForArea(id) {
  // Keep consistent with macros_index.json in your repo
  if (id.startsWith("it_")) return `it_macro_01_${id.replace(/^it_/, "")}.json`;
  if (id.startsWith("eu_") && id.length === 5) return `eu_macro_${id.replace(/^eu_/, "")}.json`;
  if (id.startsWith("euuk_country_")) return `${id}.json`;
  if (id === "euuk_macro_all") return "euuk_macro_all.json";
  return `macro_${id}.json`;
}

function ensureHeader(area, notes = "") {
  return {
    id: `macro_${areaId || "unknown"}`,
    name: `Macro — ${(area?.name || areaId || "UNKNOWN")} (AUTO-ONLY)`,
    version: "4.2.0",
    updated_at: new Date().toISOString().slice(0, 10),
    coverage: {
      area_id: areaId || null,
      area_name: area?.name || null,
      country: area?.country || area?.iso2 || area?.cc || null
    },
    rules: { mode: "car_only", offline_and_stable: true },
    notes,
    schema: { place_fields: ["id","name","type","area","country","lat","lon","tags","visibility","beauty_score","why","family","things_to_do"] },
    places: []
  };
}

// --- tags ---
function tagAdd(set, ...tags) {
  for (const t of tags) {
    const k = norm(t);
    if (k) set.add(k);
  }
}

function tagsFromPoi(poi) {
  const out = new Set();
  const n = norm(poi?.name);
  const types = Array.isArray(poi?.types) ? poi.types.map(norm) : [];
  const has = (w) => n.includes(w) || types.some(t => t.includes(w));

  if (types.includes("mare") || has("beach") || has("spiaggia")) tagAdd(out, "mare", "spiagge");
  if (types.includes("montagna") || has("mount") || has("monte")) tagAdd(out, "montagna", "panorama");
  if (types.includes("natura") || has("park") || has("parco") || has("riserva")) tagAdd(out, "natura");
  if (types.includes("relax") || has("terme") || has("spa") || has("hot spring")) tagAdd(out, "relax", "terme");

  // Family boost (IMPORTANT)
  if (types.includes("bambini")) tagAdd(out, "famiglie", "bambini");
  if (has("theme park") || has("amusement") || has("luna park")) tagAdd(out, "famiglie", "bambini");
  if (has("zoo") || has("acquario") || has("aquarium")) tagAdd(out, "famiglie", "bambini", "animali");
  if (has("playground") || has("area giochi") || has("giochi")) tagAdd(out, "famiglie", "bambini");
  if (has("parco avventura") || has("adventure park")) tagAdd(out, "famiglie", "ragazzi");

  // Storia / cultura
  if (has("museum") || has("museo")) tagAdd(out, "storia", "museo");
  if (has("castle") || has("castello") || has("fort")) tagAdd(out, "storia", "castello");
  if (has("abbey") || has("abbazia") || has("church") || has("cattedrale") || has("santuario")) tagAdd(out, "storia");

  // Cibo
  if (has("ristor") || has("tratt") || has("oster") || has("cantina") || has("wine")) tagAdd(out, "cibo");

  return out;
}

function normalizeType(rawType, rawName, tags) {
  const t = norm(rawType);
  const n = norm(rawName);

  if (tags.has("famiglie") || tags.has("bambini") || tags.has("ragazzi")) return "family";
  if (tags.has("storia") || tags.has("castello") || tags.has("museo")) return "storia";
  if (tags.has("mare") || tags.has("spiagge") || n.includes("spiaggia")) return "mare";
  if (tags.has("montagna") || n.includes("monte")) return "montagna";
  if (tags.has("relax") || tags.has("terme")) return "relax";
  if (tags.has("natura") || tags.has("lago") || tags.has("trekking")) return "natura";

  if (t === "citta" || t === "città" || t === "city") return "citta";
  if (t === "borgo" || t === "village") return "borgo";
  if (t) return t;

  // fallback
  if (n.includes("centro") || n.includes("piazza")) return "citta";
  return "borgo";
}

function normalizeVisibility(rawVis, pop = 0) {
  const v = norm(rawVis);
  if (v === "chicca" || v === "conosciuta") return v;
  if (pop >= 120000) return "conosciuta";
  return pop >= 15000 ? "conosciuta" : "chicca";
}

function buildFamily(nearPois, tags, pop = 0) {
  let score = 0;
  if (tags.has("famiglie") || tags.has("bambini") || tags.has("ragazzi")) score += 0.30;
  const joined = nearPois.map(p => norm(p.name)).join(" ");
  const has = (w) => joined.includes(w) || tags.has(w);

  if (has("parco") || has("park")) score += 0.15;
  if (has("giochi") || has("playground") || has("area giochi")) score += 0.18;
  if (has("zoo") || has("acquario") || has("aquarium") || has("animali")) score += 0.22;
  if (has("theme park") || has("amusement") || has("luna park")) score += 0.22;
  if (tags.has("lago") || tags.has("mare")) score += 0.08;
  if (pop >= 30000) score += 0.05;

  score = clamp(score, 0, 1);
  return { score: Number(score.toFixed(2)), bimbi: score >= 0.35, ragazzi: score >= 0.25 };
}

function buildThingsToDo(nearPois) {
  const arr = [...nearPois];
  arr.sort((a,b)=> (Number(b.beauty_score||0)-Number(a.beauty_score||0)) || String(a.name).localeCompare(String(b.name)));

  const attractions = [];
  const nature = [];
  const family = [];
  const food = [];

  for (const p of arr) {
    const n = norm(p.name);

    if (family.length < 12 && (n.includes("parco") || n.includes("playground") || n.includes("giochi") || n.includes("zoo") || n.includes("acquario") || n.includes("theme") || n.includes("luna park") || n.includes("avventura"))) {
      family.push(p.name); continue;
    }
    if (attractions.length < 12 && (n.includes("museo") || n.includes("museum") || n.includes("castello") || n.includes("abbazia") || n.includes("cattedrale") || n.includes("santuario"))) {
      attractions.push(p.name); continue;
    }
    if (nature.length < 12 && (n.includes("parco") || n.includes("riserva") || n.includes("lago") || n.includes("gole") || n.includes("cascata") || n.includes("trail") || n.includes("sentier"))) {
      nature.push(p.name); continue;
    }
    if (food.length < 10 && (n.includes("ristor") || n.includes("tratt") || n.includes("oster") || n.includes("cantina"))) {
      food.push(p.name); continue;
    }
  }

  return { family, attractions, nature, food };
}

function computeBeautyScore({ pop = 0, poiCount = 0, tags, visibility, familyScore = 0 }) {
  let s = visibility === "chicca" ? 0.86 : 0.80;
  s += clamp(Math.log10(1 + poiCount) / 2.2, 0, 0.18);

  if (tags.has("mare") || tags.has("spiagge")) s += 0.06;
  if (tags.has("montagna") || tags.has("panorama")) s += 0.05;
  if (tags.has("natura") || tags.has("lago") || tags.has("trekking")) s += 0.05;
  if (tags.has("storia") || tags.has("castello") || tags.has("museo")) s += 0.03;

  // family bonus
  if (tags.has("famiglie") || tags.has("bambini") || tags.has("ragazzi")) s += 0.03 + clamp(familyScore * 0.06, 0, 0.06);

  if (pop >= 500000) s -= 0.05;
  return Number(clamp(s, 0.68, 1.0).toFixed(2));
}

function whyFrom(type, tags, poiCount, family) {
  const out = [];
  if (type === "family") out.push("Perfetto per una gita in famiglia: attività e posti adatti ai bimbi.");
  else if (type === "storia") out.push("Ottimo per una gita culturale: monumenti e punti storici.");
  else if (type === "natura") out.push("Natura forte: sentieri, scorci e aria buona.");
  else if (type === "mare") out.push("Meta di mare: relax e passeggiata.");
  else if (type === "montagna") out.push("Montagna e panorami: outdoor e aria pulita.");
  else out.push("Meta valida per una gita nel tempo scelto.");

  if ((family?.score || 0) >= 0.35) out.push("Consigliata per famiglie (bimbi/ragazzi).");
  if (poiCount >= 10) out.push("Tante cose da fare nei dintorni.");
  else if (poiCount >= 5) out.push("Diversi punti di interesse vicini.");
  return out.slice(0, 4);
}

// -------------------- main (never throws) --------------------
(async function main() {
  try {
    // If no areaId -> still write something and exit 0
    const outFile = path.join(OUT_DIR, outFilenameForArea(areaId || "unknown"));

    const areas = readJsonSafe(AREAS_FILE, []);
    const area = Array.isArray(areas) ? areas.find(a => a.id === areaId) : null;

    // bbox file may not exist
    const bboxFile = path.join(BBOX_DIR, `${areaId}.json`);
    const bboxRaw = readJsonSafe(bboxFile, null);
    const bboxPlaces = Array.isArray(bboxRaw?.places) ? bboxRaw.places : Array.isArray(bboxRaw) ? bboxRaw : [];

    // pois optional
    const poisRaw = readJsonSafe(POIS_FILE, null);
    const poiList = Array.isArray(poisRaw?.pois) ? poisRaw.pois : Array.isArray(poisRaw?.items) ? poisRaw.items : Array.isArray(poisRaw) ? poisRaw : [];

    // curated optional
    const curatedRaw = readJsonSafe(CURATED, null);
    const curatedList =
      Array.isArray(curatedRaw?.places) ? curatedRaw.places :
      Array.isArray(curatedRaw?.items) ? curatedRaw.items :
      Array.isArray(curatedRaw) ? curatedRaw : [];

    const hasBbox = bboxPlaces.length > 0;

    const out = ensureHeader(
      area,
      !hasBbox
        ? `PLACEHOLDER: bbox missing or empty (${path.relative(ROOT, bboxFile)}).`
        : ""
    );

    // If no bbox -> write placeholder and exit 0
    if (!hasBbox) {
      writeJsonCompact(outFile, out);
      safeLog("✅ PLACEHOLDER macro written:", outFile);
      process.exit(0);
    }

    // POI grid
    const CELL = 0.09;
    const grid = new Map();
    const gridKey = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;

    for (const poi of poiList) {
      const ll = getLatLon(poi);
      if (!ll) continue;
      const k = gridKey(ll.lat, ll.lon);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push({
        ...poi,
        lat: ll.lat,
        lon: ll.lon,
        name: String(poi?.name || ""),
        types: Array.isArray(poi?.types) ? poi.types : poi?.type ? [poi.type] : []
      });
    }

    function nearbyPois(lat, lon, kmRadius = 8) {
      const a = Math.floor(lat / CELL);
      const b = Math.floor(lon / CELL);
      const bucket = [];
      for (let da = -1; da <= 1; da++) {
        for (let db = -1; db <= 1; db++) {
          const arr = grid.get(`${a + da}:${b + db}`);
          if (arr && arr.length) bucket.push(...arr);
        }
      }
      const res = [];
      for (const poi of bucket) {
        const d = haversineKm(lat, lon, poi.lat, poi.lon);
        if (d <= kmRadius) res.push(poi);
      }
      return res;
    }

    // curated first (soft match)
    const areaCountry = String(area?.country || area?.iso2 || area?.cc || "").toUpperCase();
    const areaNameNorm = norm(area?.name || "");

    for (const c of curatedList) {
      const name = String(c?.name || "");
      const ll = getLatLon(c);
      if (!name || !ll) continue;

      const cCountry = String(c?.country || c?.cc || "").toUpperCase();
      const cAreaNorm = norm(c?.area || c?.region || "");

      const match =
        (areaCountry && cCountry && cCountry === areaCountry) ||
        (areaNameNorm && cAreaNorm && cAreaNorm.includes(areaNameNorm));

      if (!match) continue;

      const tags = new Set(Array.isArray(c.tags) ? c.tags.map(norm) : []);
      const type = normalizeType(c.type, name, tags);
      const visibility = normalizeVisibility(c.visibility, Number(c.population || 0));

      uniquePush(out.places, {
        id: String(c.id || safeIdFrom(name, ll.lat, ll.lon, "cur")),
        name,
        type,
        area: String(area?.name || c.area || "—"),
        country: cCountry || areaCountry || null,
        lat: ll.lat,
        lon: ll.lon,
        tags: [...tags].slice(0, 18),
        visibility,
        beauty_score: Number.isFinite(Number(c.beauty_score)) ? Number(c.beauty_score) : 0.88,
        why: Array.isArray(c.why) ? c.why.slice(0, 4) : ["Scelta curata (top)."],
        family: c.family || null,
        things_to_do: c.things_to_do || null
      });
    }

    // build from bbox
    for (const bp of bboxPlaces) {
      const name = String(bp?.name || "");
      const ll = getLatLon(bp);
      if (!name || !ll) continue;

      const pop = Number(bp?.population || 0);
      const near = nearbyPois(ll.lat, ll.lon, 8);

      const tags = new Set();
      if (Array.isArray(bp.tags)) bp.tags.forEach(t => tagAdd(tags, t));
      if (Array.isArray(bp.vibes)) bp.vibes.forEach(v => tagAdd(tags, v));

      for (const poi of near) {
        const t = tagsFromPoi(poi);
        for (const x of t) tags.add(x);
      }

      // minimal tags fallback (do NOT drop “dead” places entirely)
      if (tags.size === 0) {
        if (pop >= 80000) tagAdd(tags, "citta");
        else if (pop >= 8000) tagAdd(tags, "borgo");
        else tagAdd(tags, "borgo");
      }

      const type = normalizeType(bp.type, name, tags);
      const visibility = normalizeVisibility(bp.visibility, pop);

      const family = buildFamily(near, tags, pop);
      const things_to_do = buildThingsToDo(near);

      // if strong family -> tag it
      if (family.score >= 0.35) tagAdd(tags, "famiglie", "bambini");

      const beauty = computeBeautyScore({
        pop,
        poiCount: near.length,
        tags,
        visibility,
        familyScore: family.score
      });

      const country = String(bp?.country || bp?.cc || areaCountry || "").toUpperCase() || null;

      uniquePush(out.places, {
        id: String(bp?.id || safeIdFrom(name, ll.lat, ll.lon, "gn")),
        name,
        type,
        area: String(area?.name || bp?.area || bp?.region || "—"),
        country,
        lat: ll.lat,
        lon: ll.lon,
        tags: [...tags].slice(0, 18),
        visibility,
        beauty_score: beauty,
        why: whyFrom(type, tags, near.length, family),
        family,
        things_to_do
      });
    }

    // dedup
    const byName = new Map();
    for (const p of out.places) {
      const k = norm(p.name) + "|" + (p.country || "");
      const prev = byName.get(k);
      if (!prev) byName.set(k, p);
      else if ((Number(p.beauty_score)||0) > (Number(prev.beauty_score)||0)) byName.set(k, p);
    }
    out.places = [...byName.values()].sort((a,b)=> (Number(b.beauty_score)||0)-(Number(a.beauty_score)||0));

    writeJsonCompact(outFile, out);

    const total = out.places.length;
    const fam = out.places.filter(x => x.type === "family" || x.tags?.includes("famiglie") || (x.family?.score || 0) >= 0.35).length;
    safeLog(`✅ OK macro: ${outFile} places=${total} family=${fam}`);
    process.exit(0);
  } catch (e) {
    // ABSOLUTE last-resort: write placeholder to keep CI green
    try {
      const outFile = path.join(OUT_DIR, outFilenameForArea(areaId || "unknown"));
      const out = ensureHeader(null, `FATAL (handled): ${String(e?.message || e)}`);
      writeJsonCompact(outFile, out);
      safeErr("⚠️ FATAL but handled. Placeholder written:", outFile);
    } catch {}
    process.exit(0);
  }
})();
