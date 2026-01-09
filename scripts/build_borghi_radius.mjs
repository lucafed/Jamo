// scripts/build_relax_radius.mjs
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = path.join(process.cwd(), "public", "data", "pois", "regions");
const OUT_FILE = path.join(OUT_DIR, "relax-radius.json");

// Centro: Bussolengo circa (puoi cambiare)
const CENTER = { lat: 45.521, lon: 10.860 };

// Raggio in km (puoi alzare)
const RADIUS_KM = 250;

// Limite risultati (evita file enormi)
const LIMIT = 12000;

// Overpass endpoints (fallback)
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function overpass(query, { tries = 6 } = {}) {
  let lastErr;
  for (let t = 0; t < tries; t++) {
    const endpoint = OVERPASS_ENDPOINTS[t % OVERPASS_ENDPOINTS.length];
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: "data=" + encodeURIComponent(query),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Overpass ${res.status} ${res.statusText} :: ${txt.slice(0, 160)}`);
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      const backoff = 1200 * Math.pow(1.7, t);
      console.log(`Overpass fail [${t + 1}/${tries}] -> ${String(e).slice(0, 160)}`);
      console.log(`Retry in ${Math.round(backoff)}ms...`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

function tagPairs(tags = {}) {
  // normalizza a ["k=v", ...]
  const out = [];
  for (const [k, v] of Object.entries(tags)) out.push(`${k}=${v}`);
  return out;
}

function normalizePlace(el) {
  const tags = el.tags || {};
  const id = `${el.type}:${el.id}`;
  const name =
    tags.name ||
    tags["name:it"] ||
    tags.brand ||
    tags.operator ||
    tags.amenity ||
    tags.tourism ||
    tags.leisure ||
    "Senza nome";

  // coordinate
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;

  return {
    id,
    name,
    lat,
    lon,
    type: "relax",
    visibility: "classica",
    beauty_score: 0.86,
    country: tags["addr:country"] || "??",
    area: tags["addr:region"] || tags["addr:city"] || "Radius",
    tags: tagPairs(tags),
  };
}

function buildQuery({ lat, lon, radiusKm }) {
  // “Relax” = terme/spa/sauna/pool + public_bath + hot_spring
  // NB: volutamente NON stringo troppo: poi filtriamo lato app con score/qualità.
  const r = Math.round(radiusKm * 1000);

  return `
[out:json][timeout:180];
(
  node(around:${r},${lat},${lon})["amenity"="spa"];
  way(around:${r},${lat},${lon})["amenity"="spa"];
  relation(around:${r},${lat},${lon})["amenity"="spa"];

  node(around:${r},${lat},${lon})["amenity"="public_bath"];
  way(around:${r},${lat},${lon})["amenity"="public_bath"];
  relation(around:${r},${lat},${lon})["amenity"="public_bath"];

  node(around:${r},${lat},${lon})["natural"="hot_spring"];
  way(around:${r},${lat},${lon})["natural"="hot_spring"];
  relation(around:${r},${lat},${lon})["natural"="hot_spring"];

  node(around:${r},${lat},${lon})["leisure"="sauna"];
  way(around:${r},${lat},${lon})["leisure"="sauna"];
  relation(around:${r},${lat},${lon})["leisure"="sauna"];

  node(around:${r},${lat},${lon})["leisure"="swimming_pool"];
  way(around:${r},${lat},${lon})["leisure"="swimming_pool"];
  relation(around:${r},${lat},${lon})["leisure"="swimming_pool"];

  node(around:${r},${lat},${lon})["tourism"="spa"];
  way(around:${r},${lat},${lon})["tourism"="spa"];
  relation(around:${r},${lat},${lon})["tourism"="spa"];
);
out center tags;
`;
}

function dedupeById(items) {
  const m = new Map();
  for (const it of items) {
    if (!it) continue;
    if (!m.has(it.id)) m.set(it.id, it);
  }
  return [...m.values()];
}

(async function main() {
  console.log(`Building relax-radius.json | center=${CENTER.lat},${CENTER.lon} | r=${RADIUS_KM}km`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const q = buildQuery({ lat: CENTER.lat, lon: CENTER.lon, radiusKm: RADIUS_KM });
  const json = await overpass(q);

  let places = (json.elements || []).map(normalizePlace);
  places = dedupeById(places);

  // filtro soft: togli cose chiaramente non relax (tipo "building=office" ecc)
  // NON troppo aggressivo: solo esclusioni “sicure”
  const BAD = [
    "building=office",
    "building=industrial",
    "amenity=bus_station",
    "highway=bus_stop",
    "shop=",
    "office=",
  ];

  places = places.filter((p) => !p.tags.some((t) => BAD.some((b) => (b.endsWith("=") ? t.startsWith(b) : t === b))));

  // limita
  places.sort((a, b) => a.name.localeCompare(b.name));
  if (places.length > LIMIT) places = places.slice(0, LIMIT);

  const out = {
    region_id: "relax-radius",
    country: "XX",
    label_it: `Radius • Relax (${RADIUS_KM}km)`,
    bbox_hint: { lat: CENTER.lat, lng: CENTER.lon, radius_km: RADIUS_KM },
    generated_at: new Date().toISOString(),
    places,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), "utf8");
  console.log(`✅ wrote ${OUT_FILE} (${places.length} places)`);
})();
