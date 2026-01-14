// scripts/build_cantine_veneto.mjs
// Build "Cantine Veneto" dataset (pulito + monetizzabile)
// Output: public/data/pois/regions/it-veneto-cantine.json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { overpass, toPlace, writeJson } from "./lib/overpass.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUT = path.join(__dirname, "..", "public", "data", "pois", "regions", "it-veneto-cantine.json");

// Veneto bbox (abbastanza sicuro)
const VENETO_BBOX = {
  minLat: 44.70,
  maxLat: 46.70,
  minLon: 10.20,
  maxLon: 13.20,
};

function withinBBox(lat, lon, bb) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= bb.minLat && lat <= bb.maxLat &&
    lon >= bb.minLon && lon <= bb.maxLon
  );
}

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function tagEq(tags, k, v) {
  return norm(tags?.[k]) === norm(v);
}

function hasAnyTag(tags, keys) {
  for (const k of keys) {
    const v = tags?.[k];
    if (v != null && String(v).trim() !== "") return true;
  }
  return false;
}

// ----------------------
// Overpass Query (Cantine)
// ----------------------
// Obiettivo: cantine visitabili + winery, vinicole, produttori (NO bar/ristoranti/enoteche)
// In OSM "craft=winery" è ottimo. "shop=wine" spesso è enoteca => la escludiamo.
function buildQuery(b) {
  return `
[out:json][timeout:180];
(
  // craft=winery (cantina / vinicola)
  node(${b.minLat},${b.minLon},${b.maxLat},${b.maxLon})["craft"="winery"];
  way(${b.minLat},${b.minLon},${b.maxLat},${b.maxLon})["craft"="winery"];
  relation(${b.minLat},${b.minLon},${b.maxLat},${b.maxLon})["craft"="winery"];

  // tourism=winery (meno comune ma utile)
  node(${b.minLat},${b.minLon},${b.maxLat},${b.maxLon})["tourism"="winery"];
  way(${b.minLat},${b.minLon},${b.maxLat},${b.maxLon})["tourism"="winery"];
  relation(${b.minLat},${b.minLon},${b.maxLat},${b.maxLon})["tourism"="winery"];

  // man_made=winery (raro)
  node(${b.minLat},${b.minLon},${b.maxLat},${b.maxLon})["man_made"="winery"];
  way(${b.minLat},${b.minLon},${b.maxLat},${b.maxLon})["man_made"="winery"];
  relation(${b.minLat},${b.minLon},${b.maxLat},${b.maxLon})["man_made"="winery"];
);
out center tags;
`;
}

// ----------------------
// Anti-spazzatura (cantine)
// ----------------------
function isClearlyNotWinery(p) {
  const t = p.tags || {};
  const name = norm(p.name || "");

  // senza nome -> spesso roba inutile
  if (!name || name === "(senza nome)") return true;

  // escludi roba "shop=wine" (enoteche) e "amenity=bar/restaurant" (ristoro)
  if (tagEq(t, "shop", "wine")) return true;
  if (t.amenity && ["bar", "cafe", "restaurant", "pub", "fast_food", "ice_cream"].includes(norm(t.amenity))) return true;

  // escludi "tourism=information", "office", ecc.
  if (t.office) return true;
  if (t.highway || t.railway || t.public_transport) return true;

  // parole chiave tipiche enoteca/ristoro
  const badWords = [
    "enoteca", "wine bar", "osteria", "trattoria", "ristorante", "pizzeria",
    "bar", "caffe", "café", "bistrot", "food", "panin", "gelateria"
  ];
  for (const w of badWords) if (name.includes(w)) return true;

  // se è "azienda agricola" ma NON ha segnali vino/uva/cantina -> fuori
  if (name.includes("azienda agricola")) {
    const wineSignals =
      tagEq(t, "craft", "winery") ||
      tagEq(t, "tourism", "winery") ||
      tagEq(t, "man_made", "winery") ||
      name.includes("cantina") ||
      name.includes("vin") ||
      name.includes("wine") ||
      name.includes("vign") ||
      name.includes("prosecco") ||
      name.includes("amarone") ||
      name.includes("valpolicella");
    if (!wineSignals) return true;
  }

  // micro-etichette troppo generiche che inquinano
  if (name.startsWith("via ") || name.startsWith("viale ") || name.includes("case sparse")) return true;

  return false;
}

// ----------------------
// Scoring + Chicche/Classici
// ----------------------
function scoreWinery(p) {
  const t = p.tags || {};
  const name = norm(p.name || "");
  let s = 0;

  // segnali OSM forti
  if (tagEq(t, "craft", "winery")) s += 70;
  if (tagEq(t, "tourism", "winery")) s += 60;
  if (tagEq(t, "man_made", "winery")) s += 55;

  // info monetizzabili / utili
  if (hasAnyTag(t, ["website", "contact:website"])) s += 12;
  if (hasAnyTag(t, ["phone", "contact:phone"])) s += 6;
  if (hasAnyTag(t, ["opening_hours"])) s += 6;

  // se dichiara tasting/tour/visit
  const desc = norm(t.description || "");
  const note = norm(t.note || "");
  const tourism = norm(t.tourism || "");
  const visitWords = ["degust", "tasting", "visita", "visit", "tour", "wine experience", "ospitalit", "accoglienza"];
  if (visitWords.some(w => name.includes(w) || desc.includes(w) || note.includes(w) || tourism.includes(w))) s += 10;

  // keyword vini famosi veneti -> più "classico" / turistico
  const classicWine = ["prosecco", "amarone", "valpolicella", "soave", "lugana", "bardolino", "garda", "colli euganei"];
  if (classicWine.some(w => name.includes(w) || desc.includes(w))) s += 8;

  // penalità: nomi troppo generici
  if (name.length < 5) s -= 10;

  return s;
}

function visibilityForWinery(p) {
  // logica semplice:
  // - "classica" se ha sito/telefono/orari o keyword famose (turistico)
  // - "chicca" se non ha info complete ma è comunque craft/tourism=winery (scoperta)
  const t = p.tags || {};
  const name = norm(p.name || "");
  const desc = norm(t.description || "");

  const classicSignals =
    hasAnyTag(t, ["website", "contact:website", "phone", "contact:phone", "opening_hours"]) ||
    ["prosecco", "amarone", "valpolicella", "soave", "lugana", "bardolino", "garda"].some(w => name.includes(w) || desc.includes(w));

  return classicSignals ? "classica" : "chicca";
}

// ----------------------
// MAIN
// ----------------------
async function main() {
  console.log("Build CANTINE Veneto dataset…");

  let data;
  try {
    const q = buildQuery(VENETO_BBOX);
    data = await overpass(q, { retries: 7, timeoutMs: 150000 });
  } catch (err) {
    console.error("⚠️ Overpass failed. Keeping previous dataset if it exists.");
    if (fs.existsSync(OUT)) {
      console.log("✔ Existing it-veneto-cantine.json found, not failing the build.");
      return;
    }
    throw err;
  }

  const raw = (data.elements || [])
    .map(toPlace)
    .filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .filter((p) => withinBBox(p.lat, p.lon, VENETO_BBOX))
    .filter((p) => !isClearlyNotWinery(p));

  // Dedup (nome + coordinate)
  const seen = new Set();
  const deduped = [];
  for (const p of raw) {
    const key = `${norm(p.name)}|${Number(p.lat).toFixed(5)}|${Number(p.lon).toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  const places = deduped
    .map((p) => {
      const score = scoreWinery(p);
      return {
        id: p.id,
        name: p.name,
        lat: p.lat,
        lon: p.lon,
        type: "cantine",
        visibility: visibilityForWinery(p),
        tags: Object.entries(p.tags || {}).slice(0, 80).map(([k, v]) => `${k}=${v}`),
        score,
        // opzionale: aiuta l’app, non rompe nulla se ignorato
        beauty_score: Math.max(0.35, Math.min(1, 0.55 + score / 140)),
      };
    })
    .sort((a, b) => (b.score - a.score))
    .slice(0, 7000);

  await writeJson(OUT, {
    region_id: "it-veneto-cantine",
    label_it: "Veneto • Cantine",
    bbox: VENETO_BBOX,
    generated_at: new Date().toISOString(),
    places,
  });

  console.log(`✔ Written ${OUT} (${places.length} places)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
