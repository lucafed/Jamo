// scripts/build_places_bbox_it_abruzzo.mjs
// Build a compact IT-only bbox dataset (Abruzzo + neighbors band)
// Input:  public/data/places_index_eu_uk.json
// Output: public/data/places_bbox_abruzzo_neighbors.json

import fs from "fs";
import path from "path";

const IN = path.join(process.cwd(), "public", "data", "places_index_eu_uk.json");
const OUT = path.join(process.cwd(), "public", "data", "places_bbox_abruzzo_neighbors.json");

// Bounding box "pratico": Abruzzo + fascia intorno (Lazio/Marche/Molise/Umbria)
// Se vuoi più largo: abbassa minLat/minLon e alza maxLat/maxLon.
const BBOX = {
  minLat: 41.10,
  maxLat: 43.90,
  minLon: 12.00,
  maxLon: 15.35
};

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function inBox(lat, lon) {
  return lat >= BBOX.minLat && lat <= BBOX.maxLat && lon >= BBOX.minLon && lon <= BBOX.maxLon;
}

// euristiche: ci servono per “aiutare” a monetizzare e a trovare più risultati mare/family
function inferTagsFromName(name) {
  const n = norm(name);
  const tags = new Set();

  // mare / spiagge / costa
  if (
    n.includes("marina") || n.includes("lido") || n.includes("porto") ||
    n.includes("spiaggia") || n.includes("costa") || n.includes("trabocch")
  ) {
    tags.add("mare");
    tags.add("spiagge");
  }

  // family / attività
  if (
    n.includes("parco") || n.includes("zoo") || n.includes("acquario") ||
    n.includes("avventura") || n.includes("fun") || n.includes("luna park") ||
    n.includes("fattoria") || n.includes("didattic")
  ) {
    tags.add("famiglie");
    tags.add("bambini");
    tags.add("attivita");
  }

  // natura
  if (
    n.includes("riserva") || n.includes("lago") || n.includes("gole") ||
    n.includes("cascat") || n.includes("parco nazionale") || n.includes("oasi")
  ) {
    tags.add("natura");
  }

  // storia/cultura
  if (
    n.includes("castell") || n.includes("abbazi") || n.includes("museo") ||
    n.includes("duomo") || n.includes("santuar") || n.includes("anfiteatro")
  ) {
    tags.add("storia");
  }

  return [...tags];
}

function main() {
  if (!fs.existsSync(IN)) {
    console.error("Missing input:", IN);
    process.exit(1);
  }

  const raw = fs.readFileSync(IN, "utf8");
  const big = JSON.parse(raw);

  const srcPlaces = Array.isArray(big?.places) ? big.places : [];
  const outPlaces = [];

  for (const p of srcPlaces) {
    if (!p) continue;

    // nostro index salva country come "IT" e lat/lng
    const country = String(p.country || "").toUpperCase();
    if (country !== "IT") continue;

    const lat = Number(p.lat);
    const lon = Number(p.lng ?? p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!inBox(lat, lon)) continue;

    // filtro anti micro-frazioni: usa population se presente
    const pop = Number(p.population ?? 0);
    if (Number.isFinite(pop) && pop > 0 && pop < 1500) continue;

    const name = String(p.name || "").trim();
    if (!name) continue;

    const extraTags = inferTagsFromName(name);

    outPlaces.push({
      id: String(p.id),
      name,
      country: "IT",
      lat,
      lon,
      population: Number.isFinite(pop) ? pop : undefined,
      type: p.type || "place",
      visibility: p.visibility || "chicca",
      tags: [...new Set([...(p.tags || []), ...extraTags])],
    });
  }

  const out = {
    version: "1.0",
    updated: new Date().toISOString().slice(0, 10),
    bbox: BBOX,
    note: "IT-only places inside Abruzzo+neighbors bbox. Derived from places_index_eu_uk.json",
    count: outPlaces.length,
    places: outPlaces
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out), "utf8");

  console.log("Saved:", OUT);
  console.log("Count:", outPlaces.length);
}

main();
