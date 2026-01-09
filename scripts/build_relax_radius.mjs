// scripts/build_relax_radius.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { overpass, toPlace, writeJson } from "./lib/overpass.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Default: Bussolengo (puoi cambiare via ENV)
const CENTER_LAT = Number(process.env.CENTER_LAT ?? 45.5209);
const CENTER_LON = Number(process.env.CENTER_LON ?? 10.8686);
const RADIUS_KM = Number(process.env.RADIUS_KM ?? 120); // più largo per includere Garda, Abano, ecc.
const RADIUS_M = Math.round(RADIUS_KM * 1000);

// ✅ Output
const OUT = path.join(
  __dirname,
  "..",
  "public",
  "data",
  "pois",
  "regions",
  "radius-relax.json"
);

// ----------------------
// Query Overpass (RELAX)
// ----------------------
function buildQuery(lat, lon, radiusM) {
  // Filtri abbastanza larghi, poi puliamo dopo con scoring e anti-spam
  // Nota: “tourism=spa” non è sempre usato, quindi includiamo più tag possibili.
  return `
[out:json][timeout:180];
(
  node(around:${radiusM},${lat},${lon})["tourism"="spa"];
  way(around:${radiusM},${lat},${lon})["tourism"="spa"];
  relation(around:${radiusM},${lat},${lon})["tourism"="spa"];

  node(around:${radiusM},${lat},${lon})["amenity"="public_bath"];
  way(around:${radiusM},${lat},${lon})["amenity"="public_bath"];
  relation(around:${radiusM},${lat},${lon})["amenity"="public_bath"];

  node(around:${radiusM},${lat},${lon})["amenity"="sauna"];
  way(around:${radiusM},${lat},${lon})["amenity"="sauna"];
  relation(around:${radiusM},${lat},${lon})["amenity"="sauna"];

  node(around:${radiusM},${lat},${lon})["leisure"="spa"];
  way(around:${radiusM},${lat},${lon})["leisure"="spa"];
  relation(around:${radiusM},${lat},${lon})["leisure"="spa"];

  node(around:${radiusM},${lat},${lon})["healthcare"="spa"];
  way(around:${radiusM},${lat},${lon})["healthcare"="spa"];
  relation(around:${radiusM},${lat},${lon})["healthcare"="spa"];

  node(around:${radiusM},${lat},${lon})["natural"="hot_spring"];
  way(around:${radiusM},${lat},${lon})["natural"="hot_spring"];
  relation(around:${radiusM},${lat},${lon})["natural"="hot_spring"];

  // hotel/amenity che dichiarano “spa” nei tag
  node(around:${radiusM},${lat},${lon})["tourism"="hotel"]["spa"];
  way(around:${radiusM},${lat},${lon})["tourism"="hotel"]["spa"];
  relation(around:${radiusM},${lat},${lon})["tourism"="hotel"]["spa"];

  node(around:${radiusM},${lat},${lon})["amenity"="hotel"]["spa"];
  way(around:${radiusM},${lat},${lon})["amenity"="hotel"]["spa"];
  relation(around:${radiusM},${lat},${lon})["amenity"="hotel"]["spa"];
);
out center tags;
`;
}

// ----------------------
// Anti-spazzatura
// ----------------------
function hasAnyTag(tags, keys) {
  return keys.some((k) => tags[k] != null && String(tags[k]).trim() !== "");
}

function tagEquals(tags, k, v) {
  return String(tags[k] ?? "").toLowerCase() === String(v).toLowerCase();
}

function isClearlyNotRelax(p) {
  const t = p.tags || {};
  const name = (p.name || "").toLowerCase();

  // roba chiaramente NON relax (strade, fermate, uffici, aziende, industria, ecc.)
  if (tagEquals(t, "highway", "bus_stop")) return true;
  if (t.highway) return true; // via, strada, ecc.
  if (t.railway) return true;
  if (t.public_transport) return true;

  if (t.building && ["office", "industrial", "warehouse", "retail"].includes(String(t.building).toLowerCase()))
    return true;

  if (t.landuse && ["industrial", "commercial"].includes(String(t.landuse).toLowerCase()))
    return true;

  if (t.amenity && ["bank", "school", "clinic", "hospital", "pharmacy", "police", "post_office"].includes(String(t.amenity).toLowerCase()))
    return true;

  // “SpA” azienda: la togliamo SOLO se non ci sono segnali forti di spa/terme
  const hasStrongRelaxSignal =
    tagEquals(t, "tourism", "spa") ||
    tagEquals(t, "leisure", "spa") ||
    tagEquals(t, "amenity", "public_bath") ||
    tagEquals(t, "amenity", "sauna") ||
    tagEquals(t, "natural", "hot_spring") ||
    (t.spa && String(t.spa).toLowerCase() !== "no") ||
    (t["bath:type"] && String(t["bath:type"]).toLowerCase().includes("thermal"));

  if (!hasStrongRelaxSignal) {
    if (name.endsWith(" spa") || name.includes(" s.p.a") || name.includes(" spa ") || name.includes("azienda")) {
      return true;
    }
  }

  // nomi palesemente non utili
  if (name.startsWith("via ") || name.includes("case sparse")) return true;

  return false;
}

// ----------------------
// Scoring (semplice ma efficace)
// ----------------------
function scoreRelax(p) {
  const t = p.tags || {};
  const name = (p.name || "").toLowerCase();
  let s = 0;

  // segnali forti
  if (tagEquals(t, "natural", "hot_spring")) s += 80;
  if (tagEquals(t, "amenity", "public_bath")) s += 70;
  if (tagEquals(t, "tourism", "spa")) s += 65;
  if (tagEquals(t, "leisure", "spa")) s += 60;
  if (tagEquals(t, "amenity", "sauna")) s += 55;

  // “thermal”
  const bathType = String(t["bath:type"] ?? "").toLowerCase();
  if (bathType.includes("thermal")) s += 45;

  // parole chiave nel nome
  if (name.includes("terme")) s += 40;
  if (name.includes("spa")) s += 25;
  if (name.includes("sauna")) s += 20;
  if (name.includes("wellness")) s += 20;
  if (name.includes("thermal")) s += 20;

  // info utili
  if (hasAnyTag(t, ["website", "contact:website"])) s += 8;
  if (hasAnyTag(t, ["opening_hours"])) s += 5;
  if (hasAnyTag(t, ["phone", "contact:phone"])) s += 5;

  // penalità se sembra “azienda”
  if (name.includes("azienda") || name.includes("s.p.a")) s -= 30;
  if (t.building && ["office", "industrial"].includes(String(t.building).toLowerCase())) s -= 50;

  return s;
}

// ----------------------
// MAIN
// ----------------------
async function main() {
  console.log(`Build RELAX radius: center=${CENTER_LAT},${CENTER_LON} radius=${RADIUS_KM}km`);
  let data;

  try {
    const q = buildQuery(CENTER_LAT, CENTER_LON, RADIUS_M);
    data = await overpass(q, { retries: 7, timeoutMs: 150000 });
  } catch (err) {
    console.error("⚠️ Overpass failed. Keeping previous dataset if it exists.");
    if (fs.existsSync(OUT)) {
      console.log("✔ Existing radius-relax.json found, not failing the build.");
      return;
    }
    throw err;
  }

  const raw = (data.elements || [])
    .map(toPlace)
    .filter((p) => p.lat != null && p.lon != null)
    .filter((p) => (p.name || "").trim() !== "(senza nome)")
    .filter((p) => !isClearlyNotRelax(p));

  // Dedup (stesso nome + coordinate)
  const seen = new Set();
  const deduped = [];
  for (const p of raw) {
    const key = `${(p.name || "").toLowerCase()}|${p.lat.toFixed(5)}|${p.lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  const places = deduped
    .map((p) => ({
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
    .slice(0, 6000); // largo, poi l’app sceglie le 5 migliori

  await writeJson(OUT, {
    region_id: "radius-relax",
    label_it: `Radius • Relax (${RADIUS_KM}km)`,
    bbox_hint: { lat: CENTER_LAT, lng: CENTER_LON, radius_km: RADIUS_KM },
    generated_at: new Date().toISOString(),
    places,
  });

  console.log(`✔ Written ${OUT} (${places.length} places)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
