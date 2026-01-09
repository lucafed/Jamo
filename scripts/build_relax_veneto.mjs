// scripts/build_relax_veneto.mjs
// Genera: public/data/pois/regions/it-veneto-relax.json
// Relax VERO: terme, spa, saune, bagni termali

import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "public/data/pois/regions/it-veneto-relax.json");
const OVERPASS = "https://overpass-api.de/api/interpreter";

// BBOX Veneto
const BBOX = { s: 44.7, w: 10.2, n: 46.7, e: 13.2 };

function norm(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function tagsToList(tags = {}) {
  return Object.entries(tags).map(([k, v]) => `${k}=${v}`);
}

function getLatLon(el) {
  if (el.type === "node") return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

// 🔒 TAG RELAX VERI (OBBLIGATORI)
function hasStrongRelaxTag(tags) {
  return (
    tags["natural"] === "hot_spring" ||
    tags["amenity"] === "public_bath" ||
    tags["tourism"] === "spa" ||
    tags["amenity"] === "spa" ||
    tags["leisure"] === "spa" ||
    tags["amenity"] === "sauna" ||
    tags["leisure"] === "sauna" ||
    tags["bath:type"] === "thermal" ||
    tags["healthcare"] === "spa"
  );
}

// ❌ BLACKLIST INFRASTRUTTURE / AZIENDE
function isForbidden(tags, name) {
  const t = JSON.stringify(tags).toLowerCase();
  const n = norm(name);

  if (
    t.match(/highway=|public_transport=|railway=|building=industrial|building=office|office=|amenity=association|man_made=/)
  ) return true;

  if (
    n.match(/\b(s\.p\.a|srl|s\.r\.l|snc|sas|holding|azienda|industria|group|logistica)\b/)
  ) return true;

  return false;
}

function buildQuery(b) {
  const bbox = `${b.s},${b.w},${b.n},${b.e}`;
  return `
[out:json][timeout:180];
(
  node["natural"="hot_spring"](${bbox});
  way["natural"="hot_spring"](${bbox});
  relation["natural"="hot_spring"](${bbox});

  node["amenity"="public_bath"](${bbox});
  way["amenity"="public_bath"](${bbox});
  relation["amenity"="public_bath"](${bbox});

  node["tourism"="spa"](${bbox});
  way["tourism"="spa"](${bbox});
  relation["tourism"="spa"](${bbox});

  node["amenity"="spa"](${bbox});
  way["amenity"="spa"](${bbox});
  relation["amenity"="spa"](${bbox});

  node["amenity"="sauna"](${bbox});
  way["amenity"="sauna"](${bbox});
  relation["amenity"="sauna"](${bbox});

  node["bath:type"="thermal"](${bbox});
  way["bath:type"="thermal"](${bbox});
  relation["bath:type"="thermal"](${bbox});
);
out center tags;
`;
}

async function overpass(query) {
  const res = await fetch(OVERPASS, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  return res.json();
}

async function main() {
  console.log("Fetching Veneto RELAX (pulito)...");
  const data = await overpass(buildQuery(BBOX));
  const els = data.elements || [];

  const places = [];

  for (const el of els) {
    const tags = el.tags || {};
    const name = tags.name || tags["name:it"];
    if (!name) continue;

    if (!hasStrongRelaxTag(tags)) continue;
    if (isForbidden(tags, name)) continue;

    const ll = getLatLon(el);
    if (!ll) continue;

    places.push({
      id: `osm:${el.type[0]}:${el.id}`,
      name: name.trim(),
      lat: ll.lat,
      lon: ll.lon,
      type: "relax",
      visibility: "classica",
      beauty_score: 0.9,
      country: "IT",
      area: "Veneto",
      tags: tagsToList(tags),
    });
  }

  const out = {
    region_id: "it-veneto-relax",
    country: "IT",
    label_it: "Veneto • Relax",
    generated_at: new Date().toISOString(),
    places,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`OK: ${places.length} luoghi relax veri`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
