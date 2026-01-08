// scripts/build_relax_veneto.mjs
// Genera: public/data/pois/regions/it-veneto-relax.json
// Fonte: Overpass API (OSM) -> spa/terme/wellness/sauna/hot_spring/public_bath + keyword thermal

import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "public/data/pois/regions/it-veneto-relax.json");

// BBOX Veneto (approx): south,west,north,east
// Se vuoi la perfezioniamo dopo, ma già funziona bene.
const BBOX = { s: 44.70, w: 10.20, n: 46.70, e: 13.20 };

const OVERPASS = "https://overpass-api.de/api/interpreter";

function normName(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function makeId(el) {
  return `osm:${el.type[0]}:${el.id}`; // n/w/r
}

function tagsToList(tags = {}) {
  return Object.entries(tags).map(([k, v]) => `${k}=${v}`);
}

function pickArea(tags = {}) {
  return (
    tags["addr:city"] ||
    tags["addr:town"] ||
    tags["addr:village"] ||
    tags["is_in:city"] ||
    tags["is_in"] ||
    "Veneto"
  );
}

// Relax “vero”
function isRelaxStrong(tags = {}, name = "") {
  const t = tags;
  const n = normName(name);

  const tagStrong =
    t["amenity"] === "spa" ||
    t["leisure"] === "spa" ||
    t["tourism"] === "spa" ||
    t["natural"] === "hot_spring" ||
    t["amenity"] === "public_bath" ||
    t["amenity"] === "sauna" ||
    t["leisure"] === "sauna" ||
    t["healthcare"] === "spa" ||
    t["healthcare"] === "sauna" ||
    t["bath:type"] === "thermal" ||
    t["spa"] === "yes";

  const nameStrong =
    n.includes("terme") ||
    n.includes("termale") ||
    n.includes("thermal") ||
    n.includes("hot spring") ||
    n.includes("spa") ||
    n.includes("wellness") ||
    n.includes("benessere") ||
    n.includes("hammam") ||
    n.includes("hamam") ||
    n.includes("bagno turco") ||
    n.includes("sauna");

  // piscine: le prendiamo SOLO se hanno segnali “terme/spa”
  const poolMaybe =
    (t["leisure"] === "swimming_pool" || t["leisure"] === "swimming_area") &&
    (n.includes("terme") || n.includes("spa") || n.includes("thermal") || n.includes("wellness") || n.includes("benessere"));

  return tagStrong || nameStrong || poolMaybe;
}

async function overpass(query) {
  const res = await fetch(OVERPASS, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return await res.json();
}

// Prendiamo nodi/way/relation + center (per way/relation)
function buildQuery(b) {
  const bbox = `${b.s},${b.w},${b.n},${b.e}`;

  // Tag mirati + keyword: così peschiamo davvero terme/spa, non “acqua a caso”
  return `
[out:json][timeout:180];
(
  node["amenity"="spa"](${bbox});
  way["amenity"="spa"](${bbox});
  relation["amenity"="spa"](${bbox});

  node["leisure"="spa"](${bbox});
  way["leisure"="spa"](${bbox});
  relation["leisure"="spa"](${bbox});

  node["tourism"="spa"](${bbox});
  way["tourism"="spa"](${bbox});
  relation["tourism"="spa"](${bbox});

  node["natural"="hot_spring"](${bbox});
  way["natural"="hot_spring"](${bbox});
  relation["natural"="hot_spring"](${bbox});

  node["amenity"="public_bath"](${bbox});
  way["amenity"="public_bath"](${bbox});
  relation["amenity"="public_bath"](${bbox});

  node["amenity"="sauna"](${bbox});
  way["amenity"="sauna"](${bbox});
  relation["amenity"="sauna"](${bbox});

  node["healthcare"="spa"](${bbox});
  way["healthcare"="spa"](${bbox});
  relation["healthcare"="spa"](${bbox});

  node["healthcare"="sauna"](${bbox});
  way["healthcare"="sauna"](${bbox});
  relation["healthcare"="sauna"](${bbox});

  // Keyword nel nome (molte terme sono taggate male ma nel nome c’è “Terme”)
  node["name"~"terme|termale|thermal|spa|wellness|benessere|hammam|hamam|bagno turco|sauna",i](${bbox});
  way["name"~"terme|termale|thermal|spa|wellness|benessere|hammam|hamam|bagno turco|sauna",i](${bbox});
  relation["name"~"terme|termale|thermal|spa|wellness|benessere|hammam|hamam|bagno turco|sauna",i](${bbox});
);
out center tags;
`;
}

function getLatLon(el) {
  if (el.type === "node") return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

function dedupe(items) {
  const byId = new Set();
  const byNameCell = new Set();

  const out = [];
  for (const p of items) {
    if (byId.has(p.id)) continue;
    byId.add(p.id);

    const cellLat = Math.round(p.lat * 1000) / 1000;
    const cellLon = Math.round(p.lon * 1000) / 1000;
    const key = `${normName(p.name)}|${cellLat}|${cellLon}`;
    if (byNameCell.has(key)) continue;
    byNameCell.add(key);

    out.push(p);
  }
  return out;
}

async function main() {
  console.log("Fetching Overpass Veneto Relax…");
  const data = await overpass(buildQuery(BBOX));
  const els = Array.isArray(data.elements) ? data.elements : [];

  const places = [];

  for (const el of els) {
    const tags = el.tags || {};
    const name = tags.name || tags["name:it"] || "";
    if (!name) continue;

    const ll = getLatLon(el);
    if (!ll || !Number.isFinite(ll.lat) || !Number.isFinite(ll.lon)) continue;

    if (!isRelaxStrong(tags, name)) continue;

    places.push({
      id: makeId(el),
      name: String(name).trim(),
      lat: Number(ll.lat),
      lon: Number(ll.lon),
      type: "relax",
      visibility: "classica",
      beauty_score: 0.86,
      country: "IT",
      area: pickArea(tags),
      tags: tagsToList(tags),
    });
  }

  const out = {
    region_id: "it-veneto-relax",
    country: "IT",
    label_it: "Veneto • Relax",
    bbox_hint: { lat: 45.5, lng: 11.9, radius_km: 240 },
    generated_at: new Date().toISOString(),
    places: dedupe(places),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`OK: ${OUT} (${out.places.length} places)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
