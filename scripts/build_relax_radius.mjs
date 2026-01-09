// scripts/build_relax_radius.mjs
// RELAX entro 300km da Bussolengo — anche fuori Italia
// Output: public/data/pois/regions/relax-radius.json

import fs from "node:fs";
import path from "node:path";

const OUT = "public/data/pois/regions/relax-radius.json";

const CENTER = { lat: 45.52, lon: 10.85 };
const RADIUS_M = 300000;

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function bad(tags = {}) {
  return (
    tags.highway ||
    tags.public_transport ||
    tags.route ||
    tags.railway ||
    tags.aeroway ||
    tags.shop ||
    tags.building === "office" ||
    tags.building === "industrial"
  );
}

function isRelax(tags = {}, name = "") {
  const n = norm(name);
  return (
    tags.tourism === "spa" ||
    tags.amenity === "public_bath" ||
    tags.leisure === "sauna" ||
    tags.healthcare === "spa" ||
    tags.natural === "hot_spring" ||
    n.includes("terme") ||
    n.includes("spa") ||
    n.includes("thermal") ||
    n.includes("wellness") ||
    n.includes("benessere")
  );
}

function pickCenter(el) {
  if (el.type === "node") return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

function tagsToArr(tags = {}) {
  return Object.entries(tags).map(([k, v]) => `${k}=${v}`);
}

async function overpass(q) {
  let err;
  for (const ep of ENDPOINTS) {
    try {
      const r = await fetch(ep, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: "data=" + encodeURIComponent(q),
      });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } catch (e) {
      err = e;
      await sleep(1200);
    }
  }
  throw err;
}

const QUERY = `
[out:json][timeout:180];
(
  nwr["tourism"="spa"](around:${RADIUS_M},${CENTER.lat},${CENTER.lon});
  nwr["amenity"="public_bath"](around:${RADIUS_M},${CENTER.lat},${CENTER.lon});
  nwr["leisure"="sauna"](around:${RADIUS_M},${CENTER.lat},${CENTER.lon});
  nwr["healthcare"="spa"](around:${RADIUS_M},${CENTER.lat},${CENTER.lon});
  nwr["natural"="hot_spring"](around:${RADIUS_M},${CENTER.lat},${CENTER.lon});
);
out center tags;
`;

async function main() {
  console.log("Fetching RELAX (300km radius)...");
  const json = await overpass(QUERY);

  const places = [];
  for (const el of json.elements || []) {
    const tags = el.tags || {};
    const name = tags.name || tags["name:it"];
    if (!name || bad(tags)) continue;
    if (!isRelax(tags, name)) continue;

    const c = pickCenter(el);
    if (!c) continue;

    places.push({
      id: `osm:${el.type[0]}:${el.id}`,
      name,
      lat: c.lat,
      lon: c.lon,
      type: "relax",
      visibility: tags.natural === "hot_spring" ? "chicca" : "classica",
      beauty_score: 0.85,
      country: tags["addr:country"] || "",
      area: tags["addr:city"] || tags["addr:town"] || "",
      tags: tagsToArr(tags),
    });
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    region_id: "relax-radius",
    generated_at: new Date().toISOString(),
    center: CENTER,
    radius_km: 300,
    places,
  }, null, 2));

  console.log(`OK RELAX → ${places.length} posti`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
