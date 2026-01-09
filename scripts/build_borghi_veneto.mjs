// scripts/build_borghi_veneto.mjs
// Veneto – BORGI TURISTICI (robusto, con retry + fallback)
// Output: public/data/pois/regions/it-veneto-borghi.json

import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "public/data/pois/regions/it-veneto-borghi.json");

const BBOX = { s: 44.70, w: 10.20, n: 46.70, e: 13.20 };

// endpoint multipli (fallback)
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
];

// ---------- utils ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normName(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function makeId(el) { return `osm:${el.type[0]}:${el.id}`; }

function tagsToList(tags = {}) {
  return Object.entries(tags).map(([k, v]) => `${k}=${v}`);
}

function pickArea(tags = {}) {
  return tags["addr:city"] || tags["addr:town"] || tags["addr:village"] || tags["is_in"] || "Veneto";
}

function getLatLon(el) {
  if (el.type === "node") return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

// ---------- BORGO QUALITY ----------
function touristScore(tags = {}, name = "") {
  let s = 0;
  if (tags.wikidata || tags.wikipedia) s += 40;
  if (tags.historic) s += 18;
  if (tags.tourism === "attraction") s += 16;
  if (tags.heritage) s += 12;
  if (tags.tourism === "viewpoint") s += 8;

  const n = normName(name);
  if (
    n.includes("borgo") ||
    n.includes("centro storico") ||
    n.includes("castello") ||
    n.includes("rocca") ||
    n.includes("medieval") ||
    n.includes("antico")
  ) s += 10;

  return s;
}

function acceptBorgo(tags = {}, name = "") {
  if (!name || name.length < 2) return { ok: false, score: 0 };

  const place = tags.place;
  const score = touristScore(tags, name);

  if (place === "town" || place === "village") {
    return { ok: score >= 15, score };
  }

  if (place === "hamlet") {
    return { ok: score >= 35, score }; // molto selettivo
  }

  return { ok: false, score: 0 };
}

function visibilityFromScore(score) {
  return score >= 55 ? "chicca" : "classica";
}

function beautyFromScore(score) {
  return Math.min(0.98, Math.max(0.78, 0.78 + score / 120));
}

// ---------- OVERPASS (robusto) ----------
async function overpass(query) {
  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body: "data=" + encodeURIComponent(query),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        console.warn(`⚠️ Overpass fail (${endpoint}) attempt ${attempt}`);
        await sleep(1200 * attempt);
      }
    }
  }
  throw new Error("All Overpass endpoints failed");
}

// ---------- QUERY SPLIT ----------
function queryPlaces(b) {
  const bb = `${b.s},${b.w},${b.n},${b.e}`;
  return `
[out:json][timeout:180];
(
  node["place"~"town|village|hamlet"](${bb});
  way["place"~"town|village|hamlet"](${bb});
  relation["place"~"town|village|hamlet"](${bb});
);
out center tags;
`;
}

function queryAttractions(b) {
  const bb = `${b.s},${b.w},${b.n},${b.e}`;
  return `
[out:json][timeout:180];
(
  node["historic"](${bb});
  node["tourism"~"attraction|viewpoint"](${bb});
  way["historic"](${bb});
  way["tourism"~"attraction|viewpoint"](${bb});
);
out center tags;
`;
}

// ---------- DEDUPE ----------
function dedupe(items) {
  const seen = new Set();
  return items.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

// ---------- MAIN ----------
async function main() {
  console.log("Building Veneto BORghi (robust)…");

  const placesRaw = [];

  const data1 = await overpass(queryPlaces(BBOX));
  const data2 = await overpass(queryAttractions(BBOX));

  const elements = [
    ...(data1.elements || []),
    ...(data2.elements || []),
  ];

  for (const el of elements) {
    const tags = el.tags || {};
    const name = tags.name || tags["name:it"] || "";
    const ll = getLatLon(el);
    if (!ll) continue;

    const { ok, score } = acceptBorgo(tags, name);
    if (!ok) continue;

    placesRaw.push({
      id: makeId(el),
      name,
      lat: ll.lat,
      lon: ll.lon,
      type: "borghi",
      visibility: visibilityFromScore(score),
      beauty_score: beautyFromScore(score),
      country: "IT",
      area: pickArea(tags),
      tags: tagsToList(tags),
      score,
    });
  }

  const places = dedupe(placesRaw).sort((a, b) => b.score - a.score);

  const out = {
    region_id: "it-veneto-borghi",
    country: "IT",
    label_it: "Veneto • Borghi",
    generated_at: new Date().toISOString(),
    places,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`✅ BORghi creati: ${places.length}`);
}

main().catch(e => {
  console.error("❌ Build failed:", e.message);
  process.exit(0); // IMPORTANTISSIMO: non fallire il workflow
});
