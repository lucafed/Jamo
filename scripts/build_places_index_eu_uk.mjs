// scripts/build_places_index_eu_uk.mjs
// Usage:
//   node scripts/build_places_index_eu_uk.mjs .tmp/cities500.txt

import fs from "fs";
import path from "path";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Missing input path. Example: node scripts/build_places_index_eu_uk.mjs .tmp/cities500.txt");
  process.exit(1);
}

const OUT = path.join(process.cwd(), "public", "data", "places_index_eu_uk.json");

// EU + UK country codes (GeoNames)
const EU_UK = new Set([
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT",
  "NL","PL","PT","RO","SK","SI","ES","SE","GB" // GeoNames usa GB, non UK
]);

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function typeFromPop(pop) {
  // Puoi tarare dopo: ora evita “micro posti inutili”
  if (pop >= 80000) return "citta";
  if (pop >= 8000) return "citta";
  return "borgo";
}

function visibilityFromPop(pop) {
  // “known” = più grande / “gems” = più piccolo
  if (pop >= 250000) return "conosciuta";
  return "chicca";
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

const txt = fs.readFileSync(inputPath, "utf8");
const lines = txt.split("\n");

const places = [];
for (const line of lines) {
  if (!line || line.startsWith("#")) continue;
  const cols = line.split("\t");
  if (cols.length < 19) continue;

  // GeoNames columns:
  // 0 geonameid
  // 1 name
  // 4 latitude
  // 5 longitude
  // 8 country code
  // 14 population
  const geonameid = cols[0];
  const name = cols[1];
  const lat = safeNum(cols[4]);
  const lng = safeNum(cols[5]);
  const country = cols[8];
  const population = safeNum(cols[14]) ?? 0;

  if (!EU_UK.has(country)) continue;
  if (!name || !lat || !lng) continue;

  // filtro anti “posti inutili”: sotto i 2.000 abitanti spesso sono frazioni/nomi poco utili
  // (evita suggerimenti tipo “progetto case” e roba random)
  if (population < 2000) continue;

  places.push({
    id: `gn_${geonameid}`,
    name,
    country: country === "GB" ? "UK" : country,
    type: typeFromPop(population),
    visibility: visibilityFromPop(population),
    lat,
    lng,

    // IMPORTANTISSIMO per i prossimi step (bellezza + filtri)
    population,

    tags: [],
    vibes: [],
    best_when: [],
    why: [],
    what_to_do: [],
    what_to_eat: []
  });
}

const out = {
  version: "1.1",
  updated: new Date().toISOString().slice(0, 10),
  regions: ["EU", "UK"],
  places
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out), "utf8");

const aq = places.find(p => norm(p.name) === "l aquila" || norm(p.name) === "laquila");
console.log("Saved:", OUT, "places:", places.length, "Check L'Aquila:", aq ? "OK" : "NOT FOUND");
