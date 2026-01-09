// scripts/build_borghi_radius.mjs
import { overpass, toPlace, writeJson } from "./lib/overpass.mjs";

const OUT = "public/data/pois/regions/radius-borghi.json";

const CENTER_LAT = Number(process.env.RADIUS_LAT ?? 45.468);
const CENTER_LON = Number(process.env.RADIUS_LON ?? 10.855);
const RADIUS_KM = Number(process.env.RADIUS_KM ?? 120);
const RADIUS_M = Math.round(RADIUS_KM * 1000);

function buildQuery(lat, lon, radiusM) {
  // Borghi / posti turistici: query ampia ma sensata.
  // Prendiamo:
  // - place=village|town|hamlet (ma NON suburb/neighbourhood)
  // - tourism=attraction, viewpoint
  // - historic=* (centri storici, castelli, ecc.)
  // - boundary=administrative (solo come supporto, ma poi filtriamo)
  return `
[out:json][timeout:180];
(
  node(around:${radiusM},${lat},${lon})["place"~"^(village|town|hamlet)$"];
  way(around:${radiusM},${lat},${lon})["place"~"^(village|town|hamlet)$"];
  relation(around:${radiusM},${lat},${lon})["place"~"^(village|town|hamlet)$"];

  node(around:${radiusM},${lat},${lon})["tourism"~"^(attraction|viewpoint|museum)$"];
  way(around:${radiusM},${lat},${lon})["tourism"~"^(attraction|viewpoint|museum)$"];
  relation(around:${radiusM},${lat},${lon})["tourism"~"^(attraction|viewpoint|museum)$"];

  node(around:${radiusM},${lat},${lon})["historic"];
  way(around:${radiusM},${lat},${lon})["historic"];
  relation(around:${radiusM},${lat},${lon})["historic"];

  // catch-name: molti borghi sono taggati solo nel nome
  node(around:${radiusM},${lat},${lon})["name"~"(?i)(borgo|castello|rocca|centro storico)"];
  way(around:${radiusM},${lat},${lon})["name"~"(?i)(borgo|castello|rocca|centro storico)"];
  relation(around:${radiusM},${lat},${lon})["name"~"(?i)(borgo|castello|rocca|centro storico)"];
);
out center tags;
`;
}

function isJunk(p) {
  const t = p.tags || {};
  if (t.highway) return true;
  if (t.public_transport) return true;
  if (t.amenity === "bus_stop") return true;

  const place = (t.place || "").toLowerCase();
  if (["suburb", "neighbourhood", "quarter", "locality"].includes(place)) return true;

  return false;
}

function scoreBorgo(p) {
  const t = p.tags || {};
  const name = (p.name || "").toLowerCase();
  let s = 0;

  const place = (t.place || "").toLowerCase();
  if (place === "town") s += 5;
  if (place === "village") s += 6;
  if (place === "hamlet") s += 4;

  if (t.historic) s += 5;
  if (t.tourism === "attraction") s += 5;
  if (t.tourism === "viewpoint") s += 4;
  if (t.tourism === "museum") s += 3;

  if (/(borgo|centro storico)/.test(name)) s += 5;
  if (/(castello|rocca)/.test(name)) s += 3;

  return s;
}

async function main() {
  console.log(`Building BORGHI radius dataset: ${CENTER_LAT},${CENTER_LON} r=${RADIUS_KM}km`);

  const q = buildQuery(CENTER_LAT, CENTER_LON, RADIUS_M);
  const data = await overpass(q, { retries: 7, timeoutMs: 140000 });

  const raw = (data.elements || [])
    .map(toPlace)
    .filter(p => p.lat != null && p.lon != null)
    .filter(p => !isJunk(p));

  const places = raw
    .map(p => ({
      id: p.id,
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      type: "borgo",
      visibility: "chicca", // qui ha senso mostrarli come chicche
      tags: Object.entries(p.tags || {}).slice(0, 60).map(([k, v]) => `${k}=${v}`),
      score: scoreBorgo(p),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8000);

  const out = {
    region_id: "radius-borghi",
    country: "ANY",
    label_it: `Radius • Borghi (${RADIUS_KM}km)`,
    bbox_hint: { lat: CENTER_LAT, lng: CENTER_LON, radius_km: RADIUS_KM },
    generated_at: new Date().toISOString(),
    places,
  };

  await writeJson(OUT, out);
  console.log(`Wrote ${OUT} (${places.length} places)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
