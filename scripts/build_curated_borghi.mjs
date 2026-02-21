#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const IN_DIR = path.join(ROOT, "public", "data", "pois", "regions");
const OUT_DIR = path.join(ROOT, "public", "data", "curated", "regions");

fs.mkdirSync(OUT_DIR, { recursive: true });

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return null; }
}

function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tagsStr(p) {
  return (p.tags || []).map(t => String(t).toLowerCase()).join(" ");
}

function hasAny(str, arr) {
  return arr.some(k => str.includes(k));
}

function hasQuality(p) {
  const t = tagsStr(p);
  return (
    t.includes("wikipedia=") ||
    t.includes("wikidata=") ||
    t.includes("website=") ||
    t.includes("opening_hours=")
  );
}

function hasTourism(p) {
  const t = tagsStr(p);
  return (
    t.includes("tourism=") ||
    t.includes("historic=") ||
    t.includes("heritage=") ||
    t.includes("leisure=park") ||
    t.includes("tourism=viewpoint")
  );
}

function isSpa(p) {
  const n = norm(p.name);
  const t = tagsStr(p);
  return (
    t.includes("amenity=spa") ||
    hasAny(n, ["terme","spa","wellness","benessere","sauna"])
  );
}

function isJunkByName(p) {
  const n = norm(p.name);
  return hasAny(n, [
    "case sparse",
    "cascina",
    "agriturismo",
    "ristorante",
    "pizzeria",
    "bar ",
    "hotel",
    "residence",
    "campeggio",
    "parcheggio",
    "stazione",
    "area industriale",
    "supermercato",
    "outlet",
    "centro commerciale",
    "ospedale",
    "farmacia"
  ]);
}

function isSettlement(p) {
  const t = tagsStr(p);
  return (
    t.includes("place=village") ||
    t.includes("place=town") ||
    t.includes("place=city")
  );
}

function isWeakSettlement(p) {
  const t = tagsStr(p);
  return (
    t.includes("place=hamlet") ||
    t.includes("place=suburb") ||
    t.includes("place=neighbourhood")
  );
}

function isBorgoA2(p) {
  if (!p.name || p.name.length < 3) return false;
  if (isJunkByName(p)) return false;
  if (isSpa(p)) return false;

  const t = tagsStr(p);
  const quality = hasQuality(p);
  const tourism = hasTourism(p);

  // castelli NON sono borghi
  if (t.includes("historic=castle") || t.includes("historic=fort")) return false;

  if (isSettlement(p)) {
    return tourism || quality;
  }

  if (isWeakSettlement(p)) {
    return quality && tourism;
  }

  return false;
}

function score(p) {
  let s = 0;
  const t = tagsStr(p);

  if (hasQuality(p)) s += 3;
  if (t.includes("heritage=")) s += 2;
  if (t.includes("historic=")) s += 2;
  if (t.includes("tourism=viewpoint")) s += 1;
  if (t.includes("tourism=attraction")) s += 1;

  return s;
}

const files = fs.readdirSync(IN_DIR)
  .filter(f => /^it-.*-borghi\.json$/i.test(f));

let totalIn = 0;
let totalOut = 0;

for (const file of files) {
  const inputPath = path.join(IN_DIR, file);
  const json = readJSON(inputPath);
  if (!json?.places) continue;

  totalIn += json.places.length;

  const cleaned = json.places
    .map(p => ({
      ...p,
      lat: Number(p.lat),
      lon: Number(p.lon ?? p.lng),
      name: String(p.name || "").trim(),
      tags: Array.isArray(p.tags) ? p.tags : []
    }))
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .filter(isBorgoA2);

  cleaned.sort((a, b) => score(b) - score(a));

  const output = {
    updated_at: new Date().toISOString(),
    category: "borghi",
    curated: true,
    count_in: json.places.length,
    count_out: cleaned.length,
    places: cleaned
  };

  const outPath = path.join(OUT_DIR, file);
  writeJSON(outPath, output);

  totalOut += cleaned.length;

  console.log(`${file}: ${json.places.length} -> ${cleaned.length}`);
}

console.log("-----");
console.log(`TOTALE: ${totalIn} -> ${totalOut}`);
console.log("Output in:", OUT_DIR);
