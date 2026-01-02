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

const OUT_FULL = path.join(process.cwd(), "public", "data", "places_index_eu_uk.json");
const OUT_COMPACT = path.join(process.cwd(), "public", "data", "places_index_eu_uk_compact.json");

// EU + UK country codes (GeoNames)
const EU_UK = new Set([
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT",
  "NL","PL","PT","RO","SK","SI","ES","SE","GB" // GeoNames usa GB
]);

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const k = norm(x);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function typeFromPop(pop, fcode) {
  // semplice, ma migliore del vecchio:
  // - capitali / grandi -> citta
  // - altri -> borgo (ma con pop > 10k -> citta)
  const p = Number(pop) || 0;
  const fc = String(fcode || "").toUpperCase();

  if (p >= 80000) return "citta";
  if (p >= 12000) return "citta";
  // alcuni feature_code tipici di posti “veri”
  if (fc === "PPLA" || fc === "PPLC" || fc === "PPLA2" || fc === "PPLA3" || fc === "PPLA4") return "citta";
  return "borgo";
}

function visibilityFromPop(pop, fcode) {
  const p = Number(pop) || 0;
  const fc = String(fcode || "").toUpperCase();
  if (fc === "PPLC" || p >= 250000) return "conosciuta";
  if (p >= 60000) return "conosciuta";
  return "chicca";
}

function pickBestDisplayName(name, asciiname) {
  // mantieni name originale (con apostrofi), ma se name è vuoto usa asciiname
  const n = String(name || "").trim();
  if (n) return n;
  return String(asciiname || "").trim();
}

function splitAltNames(alt) {
  // alternatenames è una lista separata da virgola (può essere enorme)
  // teniamo solo quelli "sensati" (no codici, no roba di 1-2 caratteri)
  const raw = String(alt || "");
  if (!raw) return [];
  const parts = raw.split(",").map(s => s.trim()).filter(Boolean);

  const filtered = [];
  for (const p of parts) {
    if (p.length < 3) continue;
    // scarta cose palesemente inutili (codici, numeri)
    if (/^\d+$/.test(p)) continue;
    // scarta stringhe troppo lunghe
    if (p.length > 60) continue;
    filtered.push(p);
  }
  return filtered;
}

function isUsefulSmallPlace(pop, featureCode) {
  // cities500 include già >=500 abitanti, ma qui decidiamo cosa tenere:
  // - teniamo sempre PPLA* e PPLC
  // - teniamo anche piccoli comuni se >= 1200
  // - scartiamo micro frazioni random
  const p = Number(pop) || 0;
  const fc = String(featureCode || "").toUpperCase();

  if (fc === "PPLC") return true;
  if (fc.startsWith("PPLA")) return true;

  if (p >= 1200) return true;
  // sotto 1200 spesso è rumore, ma se è un “PPL” e ha alias buoni può restare:
  if (fc === "PPL" && p >= 800) return true;

  return false;
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
  // 2 asciiname
  // 3 alternatenames
  // 4 latitude
  // 5 longitude
  // 8 country code
  // 10 admin1 (region code)
  // 11 admin2 (province code)
  // 14 population
  // 17 feature class
  // 18 feature code

  const geonameid = cols[0];
  const name = cols[1];
  const asciiname = cols[2];
  const alternatenames = cols[3];
  const lat = safeNum(cols[4]);
  const lon = safeNum(cols[5]);
  const country = cols[8];
  const admin1 = cols[10]; // e.g. IT.01 ecc (dipende da dataset)
  const admin2 = cols[11];
  const population = safeNum(cols[14]) ?? 0;
  const fclass = cols[17];
  const fcode = cols[18];

  if (!EU_UK.has(country)) continue;
  if (!geonameid) continue;
  if (!lat || !lon) continue;

  if (!isUsefulSmallPlace(population, fcode)) continue;

  const displayName = pickBestDisplayName(name, asciiname);

  // Names array for search:
  // - displayName
  // - asciiname
  // - alternatenames filtered
  const alts = splitAltNames(alternatenames);

  // de-dup by normalized
  const names = uniq([displayName, asciiname, ...alts]);

  places.push({
    id: `gn_${geonameid}`,
    name: displayName,
    names, // <-- IMPORTANTISSIMO per geocoding robusto
    country: country === "GB" ? "UK" : country,
    admin1: admin1 || "",
    admin2: admin2 || "",
    feature_class: fclass || "",
    feature_code: fcode || "",
    type: typeFromPop(population, fcode),
    visibility: visibilityFromPop(population, fcode),
    lat,
    lon, // <-- uniformiamo a lon
    population,

    // campi future-proof (per quando vorrai arricchire)
    tags: [],
    vibes: [],
    best_when: [],
    why: [],
    what_to_do: [],
    what_to_eat: []
  });
}

// FULL (dettagliato)
const outFull = {
  version: "2.0",
  updated: new Date().toISOString().slice(0, 10),
  regions: ["EU", "UK"],
  places
};

// COMPACT (molto più leggero e più veloce per lookup)
const outCompact = {
  version: "2.0",
  updated: outFull.updated,
  regions: outFull.regions,
  // campi minimi per geocode/search
  places: places.map(p => ({
    id: p.id,
    name: p.name,
    names: p.names,
    country: p.country,
    admin1: p.admin1,
    admin2: p.admin2,
    lat: p.lat,
    lon: p.lon,
    population: p.population
  }))
};

fs.mkdirSync(path.dirname(OUT_FULL), { recursive: true });
fs.writeFileSync(OUT_FULL, JSON.stringify(outFull), "utf8");
fs.writeFileSync(OUT_COMPACT, JSON.stringify(outCompact), "utf8");

// sanity checks
const n1 = places.find(p => norm(p.name) === "l aquila" || p.names.some(x => norm(x) === "l aquila" || norm(x) === "laquila"));
const n2 = places.find(p => norm(p.name) === "roma" || p.names.some(x => norm(x) === "rome" || norm(x) === "roma"));
console.log("Saved:", OUT_FULL, "places:", places.length, "Check L'Aquila:", n1 ? "OK" : "NOT FOUND", "Check Roma:", n2 ? "OK" : "NOT FOUND");
console.log("Saved:", OUT_COMPACT);
