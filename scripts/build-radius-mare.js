/**
 * build-radius-mare.js
 * Genera: public/data/pois/regions/radius-mare.json
 *
 * Requisiti: Node 18+
 * Esecuzione: node scripts/build-radius-mare.js
 *
 * NOTE:
 * - usa Overpass API (OSM). Se rate-limit, ritenta automaticamente.
 * - filtra hard: niente ferry/harbour/terminal/porti tecnici
 */

import fs from "fs";
import path from "path";

const OUT_PATH = path.join(process.cwd(), "public", "data", "pois", "regions", "radius-mare.json");

// BBOX costiere Italia (uguali alle tue, le riuso per non pescare roba inland)
const COASTAL_BBOXES_IT = [
  { minLat: 44.75, maxLat: 46.30, minLon: 12.00, maxLon: 13.90 },
  { minLat: 44.00, maxLat: 45.15, minLon: 11.80, maxLon: 13.40 },
  { minLat: 42.55, maxLat: 44.20, minLon: 12.90, maxLon: 13.90 },
  { minLat: 41.98, maxLat: 42.52, minLon: 13.90, maxLon: 14.90 },
  { minLat: 41.00, maxLat: 42.20, minLon: 11.20, maxLon: 12.90 },
  { minLat: 42.30, maxLat: 44.10, minLon: 9.70,  maxLon: 11.40 },
  { minLat: 40.40, maxLat: 41.20, minLon: 13.70, maxLon: 15.10 },
  { minLat: 39.70, maxLat: 42.20, minLon: 15.00, maxLon: 18.60 },
  { minLat: 36.60, maxLat: 38.40, minLon: 12.20, maxLon: 15.70 },
  { minLat: 38.80, maxLat: 41.40, minLon: 8.00,  maxLon: 9.90 },
];

// Overpass endpoints (fallback)
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function safeId(el, name, lat, lon) {
  if (el?.type && typeof el?.id !== "undefined") return `${el.type}/${el.id}`;
  const nm = normName(name);
  return `p_${nm || "x"}_${String(lat).slice(0, 8)}_${String(lon).slice(0, 8)}`;
}

function tagsToArray(tags = {}) {
  const out = [];
  for (const [k, v] of Object.entries(tags)) {
    if (v === undefined || v === null) continue;
    out.push(`${k}=${String(v)}`);
  }
  return out.map((x) => x.toLowerCase());
}

function getName(tags = {}) {
  return (
    tags.name ||
    tags["name:it"] ||
    tags["name:en"] ||
    tags["official_name"] ||
    tags["alt_name"] ||
    ""
  ).trim();
}

function isBadPortThing(tagsArr) {
  const t = tagsArr.join(" ");
  // roba tecnica/portuale/ferry
  return (
    t.includes("amenity=ferry_terminal") ||
    t.includes("harbour=") ||
    t.includes("man_made=pier") && (t.includes("industrial") || t.includes("cargo")) ||
    t.includes("seamark=") ||
    t.includes("route=ferry") ||
    t.includes("ferry=") ||
    t.includes("port") && !t.includes("beach") && !t.includes("lido")
  );
}

function isSeaCategory(tagsArr, nameNorm) {
  const t = tagsArr.join(" ");

  // Strong sea
  const strong =
    t.includes("natural=beach") ||
    t.includes("tourism=beach_resort") ||
    t.includes("natural=bay") ||
    t.includes("natural=cliff") ||
    t.includes("natural=reef") ||
    t.includes("natural=cape") ||
    t.includes("natural=strait");

  // Name hints
  const nameHint =
    nameNorm.includes("spiaggia") ||
    nameNorm.includes("lido") ||
    nameNorm.includes("baia") ||
    nameNorm.includes("cala") ||
    nameNorm.includes("scogliera") ||
    nameNorm.includes("lungomare") ||
    nameNorm.includes("litorale");

  // Tourist/quality signals
  const quality =
    t.includes("wikipedia=") ||
    t.includes("wikidata=") ||
    t.includes("website=") ||
    t.includes("contact:website=") ||
    t.includes("opening_hours=");

  // Un minimo di “visitabile”
  const visitabile =
    t.includes("tourism=attraction") ||
    t.includes("tourism=information") ||
    t.includes("amenity=toilets") ||
    t.includes("amenity=bar") ||
    t.includes("amenity=restaurant") ||
    t.includes("sport=swimming") ||
    quality;

  // Regola: o strong, o (nameHint + visitabile)
  return strong || (nameHint && (visitabile || quality));
}

async function postOverpass(query, endpoint) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Overpass HTTP ${res.status} @ ${endpoint} :: ${txt.slice(0, 140)}`);
  }
  return await res.json();
}

async function overpassWithRetry(query, { tries = 8 } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    const endpoint = OVERPASS_ENDPOINTS[i % OVERPASS_ENDPOINTS.length];
    try {
      // backoff progressivo
      if (i > 0) await sleep(800 * i);
      return await postOverpass(query, endpoint);
    } catch (e) {
      lastErr = e;
      // se rate-limit, aspetta un po’ di più
      await sleep(1200 + i * 700);
    }
  }
  throw lastErr || new Error("Overpass failed");
}

function makeQueryForBBox(b) {
  // out center => per ways/relations hai "center"
  // cerchiamo solo tag mare “buoni”
  return `
[out:json][timeout:180];
(
  nwr["natural"="beach"](${b.minLat},${b.minLon},${b.maxLat},${b.maxLon});
  nwr["tourism"="beach_resort"](${b.minLat},${b.minLon},${b.maxLat},${b.maxLon});
  nwr["natural"="bay"](${b.minLat},${b.minLon},${b.maxLat},${b.maxLon});
  nwr["natural"="cliff"](${b.minLat},${b.minLon},${b.maxLat},${b.maxLon});
  nwr["natural"="reef"](${b.minLat},${b.minLon},${b.maxLat},${b.maxLon});
  nwr["natural"="cape"](${b.minLat},${b.minLon},${b.maxLat},${b.maxLon});
);
out center tags;
`;
}

function elementToPlace(el) {
  const tags = el.tags || {};
  const name = getName(tags);
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!name || name.length < 2) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const tagsArr = tagsToArray(tags);
  const nn = normName(name);

  // filtri duri anti-robaccia
  if (isBadPortThing(tagsArr)) return null;

  // filtro mare vero
  if (!isSeaCategory(tagsArr, nn)) return null;

  const area =
    (tags["addr:city"] || tags["is_in:city"] || tags["addr:suburb"] || tags["addr:province"] || "").toString();

  return {
    id: safeId(el, name, lat, lon),
    name,
    lat,
    lon,
    type: "mare",
    primary_category: "mare",
    country: "IT",
    area: area || "",
    visibility: "unknown",
    beauty_score: 0.72,
    tags: tagsArr,
    source: "osm_overpass",
  };
}

function dedupePlaces(places) {
  const byId = new Map();
  for (const p of places) {
    if (!p?.id) continue;
    if (!byId.has(p.id)) byId.set(p.id, p);
  }

  // dedupe extra by (name bucket + ~close)
  const out = [];
  const buckets = new Map();
  const CLONE_KM = 1.8;

  function hav(aLat, aLon, bLat, bLon) {
    const R = 6371;
    const toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLon - aLon);
    const lat1 = toRad(aLat);
    const lat2 = toRad(bLat);
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  for (const p of byId.values()) {
    const key = normName(p.name);
    const arr = buckets.get(key) || [];
    let tooClose = false;
    for (const q of arr) {
      if (hav(p.lat, p.lon, q.lat, q.lon) < CLONE_KM) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) {
      arr.push({ lat: p.lat, lon: p.lon });
      buckets.set(key, arr);
      out.push(p);
    }
  }

  return out;
}

async function main() {
  console.log("🌊 Build radius-mare.json — start");

  let all = [];
  for (let i = 0; i < COASTAL_BBOXES_IT.length; i++) {
    const b = COASTAL_BBOXES_IT[i];
    const q = makeQueryForBBox(b);
    console.log(`→ Overpass bbox ${i + 1}/${COASTAL_BBOXES_IT.length}...`);
    const j = await overpassWithRetry(q, { tries: 10 });

    const els = Array.isArray(j?.elements) ? j.elements : [];
    const places = els.map(elementToPlace).filter(Boolean);
    console.log(`   + got ${places.length}`);
    all = all.concat(places);

    // micro-pausa per non farsi odiare da Overpass
    await sleep(450);
  }

  all = dedupePlaces(all);
  console.log(`✅ final places: ${all.length}`);

  // sort carino: per nome
  all.sort((a, b) => a.name.localeCompare(b.name));

  const out = {
    updated_at: new Date().toISOString(),
    count: all.length,
    places: all,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf-8");
  console.log(`💾 wrote: ${OUT_PATH}`);
}

main().catch((e) => {
  console.error("❌ build failed:", e);
  process.exit(1);
});
