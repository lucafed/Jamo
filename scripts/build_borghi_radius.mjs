// scripts/build_borghi_radius.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { overpass, toPlace, writeJson } from "./lib/overpass.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Centro e raggio (compatibile sia con workflow che con uso locale)
const CENTER_LAT = Number(process.env.CENTER_LAT ?? process.env.RADIUS_LAT ?? 45.5209); // Bussolengo default
const CENTER_LON = Number(process.env.CENTER_LON ?? process.env.RADIUS_LON ?? 10.8686);
const RADIUS_KM = Number(process.env.RADIUS_KM ?? 120);
const RADIUS_M = Math.round(RADIUS_KM * 1000);

// ✅ Output
const OUT = path.join(
  __dirname,
  "..",
  "public",
  "data",
  "pois",
  "regions",
  "radius-borghi.json"
);

// ----------------------
// Overpass Query (BORHI)
// - SOLO centri abitati + confini comunali (no musei / POI singoli)
// ----------------------
function buildQuery(lat, lon, radiusM) {
  // NOTE:
  // - place=* è la cosa più pulita per “borgo come meta”
  // - boundary admin_level=8/9 aiuta dove mancano i nodi place
  return `
[out:json][timeout:220];
(
  // Centri abitati (target principale)
  node(around:${radiusM},${lat},${lon})["place"~"^(village|town|hamlet)$"]["name"];
  way(around:${radiusM},${lat},${lon})["place"~"^(village|town|hamlet)$"]["name"];
  relation(around:${radiusM},${lat},${lon})["place"~"^(village|town|hamlet)$"]["name"];

  // Confini amministrativi (fallback)
  relation(around:${radiusM},${lat},${lon})["boundary"="administrative"]["admin_level"~"^(8|9)$"]["name"];
);
out center tags;
`;
}

// ----------------------
// Helpers
// ----------------------
function str(x) {
  return (x ?? "").toString().trim();
}

function lower(x) {
  return str(x).toLowerCase();
}

function hasAnyTag(tags, keys) {
  return keys.some((k) => tags?.[k] != null && str(tags[k]) !== "");
}

function numOrNull(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// ----------------------
// Filtri anti-spazzatura (borghi veri)
// ----------------------
const BIG_CITIES = new Set([
  "verona",
  "vicenza",
  "padova",
  "venezia",
  "treviso",
  "rovigo",
  "belluno",
  "brescia",
  "mantova",
  "trento",
  "bolzano",
  "milano",
  "torino",
  "bologna",
]);

function isNotBorgo(place) {
  const t = place.tags || {};
  const name = lower(place.name);

  // Deve essere un centro abitato o un confine amministrativo
  const isSettlement = !!t.place && ["village", "town", "hamlet"].includes(lower(t.place));
  const isAdmin = lower(t.boundary) === "administrative" && ["8", "9"].includes(str(t.admin_level));

  if (!isSettlement && !isAdmin) return true;

  // Nomi palesemente non-meta
  if (!name) return true;
  if (name.startsWith("via ")) return true;
  if (name.includes("case sparse")) return true;
  if (name.includes("zona industriale")) return true;
  if (name.includes("area industriale")) return true;

  // “città grandi” fuori concetto di borgo (le vogliamo fuori dai borghi)
  if (BIG_CITIES.has(name)) return true;

  // Se è un admin boundary ma in realtà è un quartiere/municipalità strana
  // (teniamolo leggero: scartiamo solo se ha segnali chiaramente “non comune”)
  const adminLevel = str(t.admin_level);
  if (isAdmin && (adminLevel === "9" || adminLevel === "10")) {
    if (name.includes("quartiere") || name.includes("frazione")) return true;
  }

  return false;
}

// ----------------------
// Scoring + Classici vs Chicche
// ----------------------
function scoreBorgo(p) {
  const t = p.tags || {};
  const name = lower(p.name);
  let s = 0;

  // Base: preferiamo village/hamlet come “borgo”
  const placeType = lower(t.place);
  if (placeType === "hamlet") s += 55;
  if (placeType === "village") s += 75;
  if (placeType === "town") s += 60;

  // Admin boundary (comune) -> buono ma meno “borgo” di village
  if (lower(t.boundary) === "administrative") s += 40;

  // Segnali turistico-storici “puliti”
  if (hasAnyTag(t, ["wikipedia"])) s += 35;
  if (hasAnyTag(t, ["wikidata"])) s += 25;
  if (hasAnyTag(t, ["heritage"])) s += 18;
  if (hasAnyTag(t, ["historic"])) s += 20;

  // Se ha un centro storico dichiarato (a volte)
  if (name.includes("borgo")) s += 10;
  if (name.includes("castello") || name.includes("rocca")) s += 8; // spesso borghi con castello
  if (name.includes("antico") || name.includes("medieval")) s += 8;

  // Penalità per “troppo grande” se abbiamo popolazione
  const pop = numOrNull(t.population);
  if (pop != null) {
    if (pop > 200000) s -= 120;
    else if (pop > 100000) s -= 80;
    else if (pop > 50000) s -= 35;
    else if (pop < 800) s += 10; // molto piccolo -> spesso borgo vero
  }

  // Extra: se ha “tourism” ma resta un place/boundary, ok (qualche comune lo mette)
  if (hasAnyTag(t, ["tourism"])) s += 10;

  return s;
}

function computeVisibility(score, p) {
  const t = p.tags || {};
  // Chicca = segnali forti (wiki/wikidata/historic/heritage) + buon punteggio
  const strong =
    hasAnyTag(t, ["wikipedia", "wikidata", "heritage", "historic"]) ||
    lower(p.name).includes("borgo");

  if (score >= 110 && strong) return "chicca";
  if (score >= 135) return "chicca";
  return "classica";
}

// ----------------------
// MAIN
// ----------------------
async function main() {
  console.log(
    `Build BORGHI radius: center=${CENTER_LAT},${CENTER_LON} radius=${RADIUS_KM}km`
  );

  let data;
  try {
    const q = buildQuery(CENTER_LAT, CENTER_LON, RADIUS_M);
    data = await overpass(q, { retries: 7, timeoutMs: 170000 });
  } catch (err) {
    console.error("⚠️ Overpass failed. Keeping previous dataset if it exists.");
    if (fs.existsSync(OUT)) {
      console.log("✔ Existing radius-borghi.json found, not failing the build.");
      return;
    }
    throw err;
  }

  // Normalizziamo
  const raw = (data.elements || [])
    .map(toPlace)
    .filter((p) => p.lat != null && p.lon != null)
    .filter((p) => str(p.name) !== "" && str(p.name) !== "(senza nome)")
    .filter((p) => !isNotBorgo(p));

  // Dedup: nome + coordinate (round)
  const seen = new Set();
  const deduped = [];
  for (const p of raw) {
    const key = `${lower(p.name)}|${p.lat.toFixed(4)}|${p.lon.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  // Build places
  const places = deduped
    .map((p) => {
      const sc = scoreBorgo(p);
      return {
        id: p.id,
        name: p.name,
        lat: p.lat,
        lon: p.lon,
        type: "borghi",
        visibility: computeVisibility(sc, p), // ✅ classica/chicca qui
        tags: Object.entries(p.tags || {})
          .slice(0, 60)
          .map(([k, v]) => `${k}=${v}`),
        score: sc,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 12000); // largo: l’app poi prende le 5 migliori nel tempo scelto

  await writeJson(OUT, {
    region_id: "radius-borghi",
    label_it: `Radius • Borghi (${RADIUS_KM}km)`,
    bbox_hint: { lat: CENTER_LAT, lng: CENTER_LON, radius_km: RADIUS_KM },
    generated_at: new Date().toISOString(),
    places,
  });

  const countClassici = places.filter((p) => p.visibility === "classica").length;
  const countChicche = places.filter((p) => p.visibility === "chicca").length;

  console.log(`✔ Written ${OUT} (${places.length} places)`);
  console.log(`   - classica: ${countClassici}`);
  console.log(`   - chicca:   ${countChicche}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
