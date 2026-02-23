// scripts/trim_regions_dataset.mjs
// Trim a legacy regions dataset in-place (the same file app.js already reads)
// Usage:
//   node scripts/trim_regions_dataset.mjs it-piemonte borghi 600
// Output (overwrites):
//   public/data/pois/regions/it-piemonte-borghi.json

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const rid = String(process.argv[2] || "").trim();      // es: it-piemonte
const cat = String(process.argv[3] || "").trim();      // es: borghi
const LIMIT = Number(process.argv[4] || 600);          // es: 600

if (!rid || !cat) {
  console.error("Usage: node scripts/trim_regions_dataset.mjs it-piemonte borghi 600");
  process.exit(1);
}

const FILE = path.join(ROOT, "public", "data", "pois", "regions", `${rid}-${cat}.json`);
if (!fs.existsSync(FILE)) {
  console.error("File not found:", FILE);
  process.exit(1);
}

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tagsStr(p) {
  const arr = Array.isArray(p?.tags) ? p.tags : [];
  return arr.map(x => String(x).toLowerCase()).join(" ");
}

function hasAny(str, arr) {
  for (const k of arr) if (str.includes(k)) return true;
  return false;
}

function hasQualitySignals(p) {
  const t = tagsStr(p);
  return (
    t.includes("wikipedia=") ||
    t.includes("wikidata=") ||
    t.includes("website=") ||
    t.includes("contact:website=") ||
    t.includes("opening_hours=") ||
    t.includes("phone=") ||
    t.includes("contact:phone=")
  );
}

// “WOW + servito” (versione dataset-side)
function hasTouristSignals(p) {
  const t = tagsStr(p);
  const n = normName(p?.name || "");

  const osmTourism =
    t.includes("tourism=attraction") ||
    t.includes("tourism=museum") ||
    t.includes("tourism=gallery") ||
    t.includes("tourism=viewpoint") ||
    t.includes("tourism=information") ||
    t.includes("historic=") ||
    t.includes("heritage=") ||
    t.includes("leisure=park") ||
    t.includes("leisure=garden") ||
    t.includes("natural=waterfall") ||
    t.includes("natural=cave_entrance");

  const services =
    t.includes("amenity=restaurant") ||
    t.includes("amenity=cafe") ||
    t.includes("amenity=bar") ||
    t.includes("amenity=toilets") ||
    t.includes("tourism=hotel") ||
    t.includes("tourism=guest_house");

  const wowName = hasAny(n, [
    "centro storico","borgo",
    "castello","rocca","forte","torre",
    "abbazia","duomo","cattedrale","santuario",
    "riserva","oasi","parco",
    "cascata","gole","belvedere","panorama"
  ]);

  return hasQualitySignals(p) || osmTourism || services || wowName;
}

function isClearlyIrrelevant(p) {
  const t = tagsStr(p);
  const n = normName(p?.name || "");

  if (hasAny(t, ["highway=", "railway=", "public_transport=", "route=", "junction=", "highway=bus_stop", "highway=platform"])) return true;
  if (hasAny(t, ["amenity=parking", "amenity=parking_entrance", "amenity=parking_space", "highway=rest_area", "amenity=fuel", "amenity=charging_station"])) return true;
  if (hasAny(t, ["landuse=industrial", "landuse=commercial", "building=industrial", "building=warehouse", "building=office", "man_made=works"])) return true;
  if (hasAny(t, ["man_made=survey_point", "power=", "telecom=", "pipeline=", "place=locality"])) return true;
  if (hasAny(n, ["parcheggio", "stazione", "fermata", "svincolo", "uscita", "cabina", "impianto", "linea", "km "])) return true;

  return false;
}

function score(p) {
  const t = tagsStr(p);
  const n = normName(p?.name || "");
  let s = 0;

  // qualità info (molto importante)
  if (t.includes("wikipedia=")) s += 40;
  if (t.includes("wikidata=")) s += 30;
  if (t.includes("website=") || t.includes("contact:website=")) s += 25;
  if (t.includes("opening_hours=")) s += 12;

  // attrazioni vere
  if (t.includes("historic=") || t.includes("heritage=")) s += 18;
  if (t.includes("tourism=attraction")) s += 18;
  if (t.includes("tourism=viewpoint")) s += 14;
  if (t.includes("tourism=museum")) s += 10;

  // “borgo” = settlement + centro storico ecc.
  if (cat === "borghi") {
    if (hasAny(n, ["centro storico","borgo","paese","frazione"])) s += 18;
    if (hasAny(n, ["case sparse"])) s -= 60;
  }

  // servizi utili (soft)
  if (t.includes("amenity=restaurant") || t.includes("amenity=cafe") || t.includes("amenity=bar")) s += 6;
  if (t.includes("amenity=toilets")) s += 3;

  // penalità spazzatura residua
  if (isClearlyIrrelevant(p)) s -= 80;

  return s;
}

function dedup(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const key = `${normName(p.name)}_${String(p.lat).slice(0,6)}_${String(p.lon).slice(0,6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
const places = Array.isArray(raw?.places) ? raw.places : [];

let filtered = places
  .filter(p => p && p.name && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)))
  .filter(p => !isClearlyIrrelevant(p))
  .filter(p => hasTouristSignals(p)); // <-- QUI “pochi ma forti”

filtered = dedup(filtered)
  .map(p => ({ ...p, score: score(p) }))
  .sort((a,b) => (b.score - a.score))
  .slice(0, clamp(LIMIT, 50, 5000));

const out = {
  ...raw,
  meta: {
    ...(raw.meta || {}),
    trimmed_at: new Date().toISOString(),
    trimmed_limit: LIMIT,
    trimmed_rules: "wow+servito, no-irrelevant, scored",
    original_count: places.length,
    final_count: filtered.length,
  },
  places: filtered,
};

fs.writeFileSync(FILE, JSON.stringify(out), "utf8");
console.log(`OK: ${rid}-${cat}.json  ${places.length} -> ${filtered.length}`);
