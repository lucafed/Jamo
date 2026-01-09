// scripts/build_relax_veneto.mjs
// Veneto RELAX (pulito ma NON stretto) — evita SpA aziendali, strade, bus, uffici
import fs from "node:fs";
import path from "node:path";

const OUT = "public/data/pois/regions/it-veneto-relax.json";

// bbox Veneto (larga). Se vuoi includere un po’ di lago di Garda/Lombardia: allarga di ~0.15
const BBOX = {
  s: 44.70,
  w: 10.20,
  n: 46.70,
  e: 13.20,
};

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];

// --- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickCenter(el) {
  if (el.type === "node") return { lat: el.lat, lon: el.lon };
  if (el.center && Number.isFinite(el.center.lat) && Number.isFinite(el.center.lon)) {
    return { lat: el.center.lat, lon: el.center.lon };
  }
  return null;
}

function tagsToArray(tags = {}) {
  // format: ["k=v", ...]
  return Object.entries(tags).map(([k, v]) => `${k}=${String(v)}`);
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function hasAny(str, arr) {
  for (const a of arr) if (str.includes(a)) return true;
  return false;
}

function isWellnessByTags(tags = {}) {
  const t = tags;

  // tag FORTI (veri)
  const strong =
    t.amenity === "spa" ||
    t.leisure === "spa" ||
    t.tourism === "spa" ||
    t.healthcare === "spa" ||
    t.amenity === "sauna" ||
    t.leisure === "sauna" ||
    t.healthcare === "sauna" ||
    t.amenity === "public_bath" ||
    t.natural === "hot_spring" ||
    t["bath:type"] === "thermal" ||
    t.amenity === "public_bath" ||
    t.healthcare === "massage" ||
    t.amenity === "massage";

  return !!strong;
}

function isBadTransportOrRoad(tags = {}) {
  const t = tags;
  if (t.highway) return true;
  if (t.public_transport) return true;
  if (t.railway) return true;
  if (t.route) return true;
  if (t.amenity === "bus_station") return true;
  if (t.highway === "bus_stop") return true;
  if (t.public_transport === "platform") return true;
  return false;
}

function isLikelyOfficeOrIndustry(tags = {}) {
  const b = tags.building;
  return b === "office" || b === "industrial" || b === "warehouse";
}

function looksWellnessByName(name = "") {
  const n = norm(name);
  return hasAny(n, [
    "terme",
    "termale",
    "thermal",
    "spa",
    "wellness",
    "benessere",
    "sauna",
    "hammam",
    "hamam",
    "bagno turco",
    "idroterapia",
  ]);
}

function looksCompanySpa(name = "") {
  const n = String(name || "");
  return /(\bS\.p\.A\.|\bSpA\b)/.test(n);
}

function isAllowedSwimmingPool(tags = {}, name = "") {
  // piscina la prendo SOLO se nome/brand indica chiaramente relax/terme/spa
  // (così non ti entra la piscina comunale)
  if (tags.leisure !== "swimming_pool") return false;
  return looksWellnessByName(name) || tags.natural === "hot_spring" || tags["bath:type"] === "thermal";
}

function score(tags = {}, name = "") {
  // semplice “priorità”: prima terme/ sorgenti / bagni, poi spa/saune
  let s = 0;
  if (tags.natural === "hot_spring") s += 90;
  if (tags["bath:type"] === "thermal") s += 70;
  if (tags.amenity === "public_bath") s += 70;
  if (tags.amenity === "spa" || tags.leisure === "spa" || tags.tourism === "spa" || tags.healthcare === "spa") s += 55;
  if (tags.amenity === "sauna" || tags.leisure === "sauna" || tags.healthcare === "sauna") s += 45;
  if (looksWellnessByName(name)) s += 25;
  return s;
}

// --- Overpass query (tag forti + piscine “candidate”)
function buildQuery(b) {
  return `
[out:json][timeout:180];
(
  node["amenity"="spa"](${b.s},${b.w},${b.n},${b.e});
  way["amenity"="spa"](${b.s},${b.w},${b.n},${b.e});
  relation["amenity"="spa"](${b.s},${b.w},${b.n},${b.e});

  node["leisure"="spa"](${b.s},${b.w},${b.n},${b.e});
  way["leisure"="spa"](${b.s},${b.w},${b.n},${b.e});
  relation["leisure"="spa"](${b.s},${b.w},${b.n},${b.e});

  node["tourism"="spa"](${b.s},${b.w},${b.n},${b.e});
  way["tourism"="spa"](${b.s},${b.w},${b.n},${b.e});
  relation["tourism"="spa"](${b.s},${b.w},${b.n},${b.e});

  node["healthcare"="spa"](${b.s},${b.w},${b.n},${b.e});
  way["healthcare"="spa"](${b.s},${b.w},${b.n},${b.e});
  relation["healthcare"="spa"](${b.s},${b.w},${b.n},${b.e});

  node["amenity"="sauna"](${b.s},${b.w},${b.n},${b.e});
  way["amenity"="sauna"](${b.s},${b.w},${b.n},${b.e});
  relation["amenity"="sauna"](${b.s},${b.w},${b.n},${b.e});

  node["leisure"="sauna"](${b.s},${b.w},${b.n},${b.e});
  way["leisure"="sauna"](${b.s},${b.w},${b.n},${b.e});
  relation["leisure"="sauna"](${b.s},${b.w},${b.n},${b.e});

  node["amenity"="public_bath"](${b.s},${b.w},${b.n},${b.e});
  way["amenity"="public_bath"](${b.s},${b.w},${b.n},${b.e});
  relation["amenity"="public_bath"](${b.s},${b.w},${b.n},${b.e});

  node["natural"="hot_spring"](${b.s},${b.w},${b.n},${b.e});
  way["natural"="hot_spring"](${b.s},${b.w},${b.n},${b.e});
  relation["natural"="hot_spring"](${b.s},${b.w},${b.n},${b.e});

  node["bath:type"="thermal"](${b.s},${b.w},${b.n},${b.e});
  way["bath:type"="thermal"](${b.s},${b.w},${b.n},${b.e});
  relation["bath:type"="thermal"](${b.s},${b.w},${b.n},${b.e});

  // “candidate” piscine: filtriamo dopo col nome/tag
  node["leisure"="swimming_pool"](${b.s},${b.w},${b.n},${b.e});
  way["leisure"="swimming_pool"](${b.s},${b.w},${b.n},${b.e});
  relation["leisure"="swimming_pool"](${b.s},${b.w},${b.n},${b.e});

  // massage (aumenta copertura senza sporcare troppo)
  node["healthcare"="massage"](${b.s},${b.w},${b.n},${b.e});
  way["healthcare"="massage"](${b.s},${b.w},${b.n},${b.e});
  relation["healthcare"="massage"](${b.s},${b.w},${b.n},${b.e});
);
out center tags;
`;
}

async function overpass(query) {
  let lastErr = null;
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(ep, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: "data=" + encodeURIComponent(query),
      });

      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      const json = await res.json();
      return json;
    } catch (e) {
      lastErr = e;
      // retry soft
      await sleep(900);
    }
  }
  throw lastErr || new Error("Overpass failed");
}

function toPlace(el) {
  const center = pickCenter(el);
  if (!center) return null;

  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || "";
  if (!name || String(name).trim().length < 2) return null;

  // HARD EXCLUDE: strade/bus/trasporto
  if (isBadTransportOrRoad(tags)) return null;

  // wellness by tag OR piscina candidate
  const okStrong = isWellnessByTags(tags);
  const okPool = isAllowedSwimmingPool(tags, name);
  if (!okStrong && !okPool) return null;

  // escludi uffici/industrie se non c’è wellness “vero”
  if (isLikelyOfficeOrIndustry(tags) && !okStrong) return null;

  // escludi aziende “SpA” se non c’è wellness “vero”
  if (looksCompanySpa(name) && !okStrong) return null;

  const s = score(tags, name);

  return {
    id: `osm:${el.type[0]}:${el.id}`,
    name: String(name).trim(),
    lat: center.lat,
    lon: center.lon,
    type: "relax",
    visibility: s >= 70 ? "chicca" : "classica",
    beauty_score: 0.86,
    country: "IT",
    area: "Veneto",
    tags: tagsToArray(tags),
    score: s,
  };
}

function dedupe(list) {
  const out = [];
  const seen = new Set();
  for (const p of list) {
    const key = `${p.name.toLowerCase()}|${p.lat.toFixed(5)}|${p.lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

async function main() {
  console.log("Fetching Veneto RELAX (pulito ma largo) …");
  const query = buildQuery(BBOX);
  const json = await overpass(query);

  const els = Array.isArray(json.elements) ? json.elements : [];
  let places = els.map(toPlace).filter(Boolean);

  // Ordina per score prima
  places.sort((a, b) => (b.score - a.score));

  places = dedupe(places);

  const out = {
    region_id: "it-veneto-relax",
    country: "IT",
    label_it: "Veneto • Relax",
    bbox_hint: {
      lat: 45.5,
      lng: 11.9,
      radius_km: 240,
    },
    generated_at: new Date().toISOString(),
    places,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");

  console.log(`OK ✅ ${places.length} places -> ${OUT}`);
}

main().catch((e) => {
  console.error("Build failed:", e);
  process.exit(1);
});
