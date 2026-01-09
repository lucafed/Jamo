// scripts/build_borghi_radius.mjs
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = path.join(process.cwd(), "public", "data", "pois", "regions");
const OUT_FILE = path.join(OUT_DIR, "borghi-radius.json");

const CENTER = { lat: 45.521, lon: 10.860 }; // Bussolengo circa
const RADIUS_KM = 250;
const LIMIT = 12000;

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
      await sleep(backoff);
    }
  }
  throw lastErr;
}

function tagPairs(tags = {}) {
  const out = [];
  for (const [k, v] of Object.entries(tags)) out.push(`${k}=${v}`);
  return out;
}

function normalizePlace(el) {
  const tags = el.tags || {};
  const id = `${el.type}:${el.id}`;

  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;

  const name =
    tags.name ||
    tags["name:it"] ||
    tags["name:en"] ||
    tags.place ||
    "Senza nome";

  return {
    id,
    name,
    lat,
    lon,
    type: "borgo",
    visibility: "chicca",
    beauty_score: 0.92,
    country: tags["addr:country"] || "??",
    area: tags["addr:region"] || tags["addr:city"] || "Radius",
    tags: tagPairs(tags),
  };
}

function buildQuery({ lat, lon, radiusKm }) {
  const r = Math.round(radiusKm * 1000);

  // Borghi: place=hamlet/village/town + tourism=attraction/viewpoint + historic=city_gate/castle
  // NON stringere troppo, poi la "classica/chicca" la gestisci con scoring lato app
  return `
[out:json][timeout:180];
(
  node(around:${r},${lat},${lon})["place"~"^(hamlet|village|town)$"];
  way(around:${r},${lat},${lon})["place"~"^(hamlet|village|town)$"];
  relation(around:${r},${lat},${lon})["place"~"^(hamlet|village|town)$"];

  node(around:${r},${lat},${lon})["tourism"="attraction"];
  way(around:${r},${lat},${lon})["tourism"="attraction"];
  relation(around:${r},${lat},${lon})["tourism"="attraction"];

  node(around:${r},${lat},${lon})["tourism"="viewpoint"];
  way(around:${r},${lat},${lon})["tourism"="viewpoint"];
  relation(around:${r},${lat},${lon})["tourism"="viewpoint"];

  node(around:${r},${lat},${lon})["historic"="castle"];
  way(around:${r},${lat},${lon})["historic"="castle"];
  relation(around:${r},${lat},${lon})["historic"="castle"];
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
  console.log(`Building borghi-radius.json | center=${CENTER.lat},${CENTER.lon} | r=${RADIUS_KM}km`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const q = buildQuery({ lat: CENTER.lat, lon: CENTER.lon, radiusKm: RADIUS_KM });
  const json = await overpass(q);

  let places = (json.elements || []).map(normalizePlace);
  places = dedupeById(places);

  // filtro soft: togli roba palesemente non “borgo”
  const BAD_PREFIX = ["shop=", "office=", "building=industrial", "amenity=bus_stop", "highway=bus_stop"];
  places = places.filter((p) => !p.tags.some((t) => BAD_PREFIX.some((b) => t.startsWith(b) || t === b)));

  places.sort((a, b) => a.name.localeCompare(b.name));
  if (places.length > LIMIT) places = places.slice(0, LIMIT);

  const out = {
    region_id: "borghi-radius",
    country: "XX",
    label_it: `Radius • Borghi (${RADIUS_KM}km)`,
    bbox_hint: { lat: CENTER.lat, lng: CENTER.lon, radius_km: RADIUS_KM },
    generated_at: new Date().toISOString(),
    places,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), "utf8");
  console.log(`✅ wrote ${OUT_FILE} (${places.length} places)`);
})();
