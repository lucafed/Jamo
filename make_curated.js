// make_curated.js
// Genera public/data/curated.json partendo da public/data/curated_destinations_eu_uk.json
// Uso: node make_curated.js

const fs = require("fs");
const path = require("path");

const SRC = path.join(process.cwd(), "public", "data", "curated_destinations_eu_uk.json");
const OUT = path.join(process.cwd(), "public", "data", "curated.json");

function pickVisibility(i) {
  // 60% conosciuta, 40% chicca
  return (i % 10 < 6) ? "conosciuta" : "chicca";
}

function buildTags(vis) {
  return vis === "conosciuta"
    ? ["iconica", "weekend", "amici"]
    : ["chicca", "slow", "weekend"];
}

function buildWhatToDo(name) {
  // lasciamo generico (puoi arricchirlo dopo)
  return [`Passeggiata in centro a ${name}`, "Punti panoramici", "Cibo tipico", "Foto/relax"];
}

const raw = fs.readFileSync(SRC, "utf8");
const arr = JSON.parse(raw);

if (!Array.isArray(arr)) {
  console.error("curated_destinations_eu_uk.json deve essere un array");
  process.exit(1);
}

// Tutte come "città" (così funziona ovunque).
// Se vuoi anche borghi/mare/montagna, li aggiungi manualmente o con regole dopo.
const places = arr
  .map((d, i) => {
    const name = d.name || d.city || d.title;
    const id = d.id || (String(name || "place") + "_" + (d.country || "xx")).toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const lat = Number(d.lat);
    const lng = Number(d.lon ?? d.lng);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const visibility = pickVisibility(i);

    return {
      id,
      name,
      country: d.country || "",
      type: "città",
      visibility,
      lat,
      lng,
      tags: buildTags(visibility),
      what_to_do: buildWhatToDo(name)
    };
  })
  .filter(Boolean);

const out = {
  version: "INFINITE-1.0",
  updated: new Date().toISOString().slice(0, 10),
  regions: ["EU", "UK"],
  places
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
console.log("✅ Creato:", OUT, " | mete:", places.length);
