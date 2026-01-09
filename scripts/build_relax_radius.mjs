// scripts/build_relax_radius.mjs
import { overpass, toPlace, writeJson } from "./lib/overpass.mjs";

const OUT = "public/data/pois/regions/radius-relax.json";

// Centro di default: Bussolengo (puoi cambiare quando vuoi)
const CENTER_LAT = Number(process.env.RADIUS_LAT ?? 45.468);
const CENTER_LON = Number(process.env.RADIUS_LON ?? 10.855);
const RADIUS_KM = Number(process.env.RADIUS_KM ?? 120); // più largo (non troppo stretto)

const RADIUS_M = Math.round(RADIUS_KM * 1000);

// Query volutamente ampia (poi ripuliamo lato JS)
function buildQuery(lat, lon, radiusM) {
  // Cerchiamo cose “relax” in modo AMPIO:
  // - spa / sauna / wellness / thermal / hot_spring / public_bath
  // - leisure=sauna / amenity=public_bath
  // - tourism=spa (in OSM capita)
  // - healthclub/fitness lo prendo ma poi lo declasso
  return `
[out:json][timeout:180];
(
  node(around:${radiusM},${lat},${lon})["amenity"="public_bath"];
  way(around:${radiusM},${lat},${lon})["amenity"="public_bath"];
  relation(around:${radiusM},${lat},${lon})["amenity"="public_bath"];

  node(around:${radiusM},${lat},${lon})["leisure"="sauna"];
  way(around:${radiusM},${lat},${lon})["leisure"="sauna"];
  relation(around:${radiusM},${lat},${lon})["leisure"="sauna"];

  node(around:${radiusM},${lat},${lon})["tourism"="spa"];
  way(around:${radiusM},${lat},${lon})["tourism"="spa"];
  relation(around:${radiusM},${lat},${lon})["tourism"="spa"];

  node(around:${radiusM},${lat},${lon})["amenity"="spa"];
  way(around:${radiusM},${lat},${lon})["amenity"="spa"];
  relation(around:${radiusM},${lat},${lon})["amenity"="spa"];

  node(around:${radiusM},${lat},${lon})["healthcare"="spa"];
  way(around:${radiusM},${lat},${lon})["healthcare"="spa"];
  relation(around:${radiusM},${lat},${lon})["healthcare"="spa"];

  node(around:${radiusM},${lat},${lon})["natural"="hot_spring"];
  way(around:${radiusM},${lat},${lon})["natural"="hot_spring"];
  relation(around:${radiusM},${lat},${lon})["natural"="hot_spring"];

  // catch-all “wellness” (molti lo mettono così)
  node(around:${radiusM},${lat},${lon})["name"~"(?i)(terme|spa|sauna|wellness|bagno termale|thermal)"];
  way(around:${radiusM},${lat},${lon})["name"~"(?i)(terme|spa|sauna|wellness|bagno termale|thermal)"];
  relation(around:${radiusM},${lat},${lon})["name"~"(?i)(terme|spa|sauna|wellness|bagno termale|thermal)"];
);
out center tags;
`;
}

function isObviouslyNotRelax(p) {
  const t = p.tags || {};
  // roba palesemente NON relax (quella che ti usciva: bus stop, aziende, uffici, strade)
  if (t.highway) return true; // highway=bus_stop, living_street, residential...
  if (t.public_transport) return true;
  if (t.route || t.route_ref || t.network) return true;

  const building = (t.building || "").toLowerCase();
  if (["industrial", "office", "warehouse", "commercial"].includes(building)) return true;

  const amenity = (t.amenity || "").toLowerCase();
  if (["bus_station", "parking", "fuel", "bank", "post_office"].includes(amenity)) return true;

  // nomi tipici “azienda spa/srl” che non sono terme
  const name = (p.name || "").toLowerCase();
  if (/\b(s\.p\.a\.|srl|s\.r\.l\.|spa)\b/.test(name) && !/(spa|terme|sauna|wellness)/.test(name)) {
    return true;
  }

  return false;
}

function scoreRelax(p) {
  const t = p.tags || {};
  const name = (p.name || "").toLowerCase();

  let s = 0;

  // segnali forti “terme / hot spring”
  if (t.natural === "hot_spring") s += 8;
  if (t.amenity === "public_bath") s += 6;
  if (t.tourism === "spa") s += 6;
  if (t.amenity === "spa") s += 5;
  if (t.leisure === "sauna") s += 5;
  if (t.healthcare === "spa") s += 5;

  // segnali nel nome
  if (/(terme|thermal|bagno termale)/.test(name)) s += 7;
  if (/(spa|sauna|wellness)/.test(name)) s += 4;

  // penalità: se è troppo generico tipo fitness/health club
  const leisure = (t.leisure || "").toLowerCase();
  if (["fitness_centre", "sports_centre"].includes(leisure)) s -= 2;

  return s;
}

async function main() {
  console.log(`Building RELAX radius dataset: ${CENTER_LAT},${CENTER_LON} r=${RADIUS_KM}km`);

  const q = buildQuery(CENTER_LAT, CENTER_LON, RADIUS_M);
  const data = await overpass(q, { retries: 7, timeoutMs: 140000 });

  const raw = (data.elements || [])
    .map(toPlace)
    .filter(p => p.lat != null && p.lon != null);

  // pulizia “soft”: togli SOLO le schifezze evidenti
  const cleaned = raw.filter(p => !isObviouslyNotRelax(p));

  const places = cleaned
    .map(p => ({
      id: p.id,
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      type: "relax",
      visibility: "classica",
      tags: Object.entries(p.tags || {}).slice(0, 60).map(([k, v]) => `${k}=${v}`),
      score: scoreRelax(p),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6000); // cap alto: non strozzare

  const out = {
    region_id: "radius-relax",
    country: "ANY",
    label_it: `Radius • Relax (${RADIUS_KM}km)`,
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
