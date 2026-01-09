// scripts/build_borghi_radius.mjs
// BORGHI turistici entro 300km da Bussolengo
// Output: public/data/pois/regions/borghi-radius.json

import fs from "node:fs";
import path from "node:path";

const OUT = "public/data/pois/regions/borghi-radius.json";

const CENTER = { lat: 45.52, lon: 10.85 };
const RADIUS_M = 300000;

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function hasSignal(tags = {}) {
  return (
    tags.wikipedia ||
    tags.wikidata ||
    tags.historic ||
    tags.tourism ||
    tags.heritage ||
    tags.attraction
  );
}

function bad(tags = {}) {
  return (
    tags.highway ||
    tags.public_transport ||
    tags.railway ||
    tags.route ||
    tags.shop ||
    tags.building === "industrial"
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
  nwr["place"~"town|village|hamlet"](around:${RADIUS_M},${CENTER.lat},${CENTER.lon})["name"];
);
out center tags;
`;

async function main() {
  console.log("Fetching BORGHI (300km radius)...");
  const json = await overpass(QUERY);

  const places = [];
  for (const el of json.elements || []) {
    const tags = el.tags || {};
    if (bad(tags)) continue;
    if (!hasSignal(tags)) continue;

    const c = pickCenter(el);
    if (!c) continue;

    const place = tags.place;
    const visibility =
      place === "hamlet" ? "chicca" : "classica";

    places.push({
      id: `osm:${el.type[0]}:${el.id}`,
      name: tags.name,
      lat: c.lat,
      lon: c.lon,
      type: "borgo",
      visibility,
      beauty_score: 0.86,
      country: tags["addr:country"] || "",
      area: tags["addr:city"] || tags["addr:town"] || "",
      tags: tagsToArr(tags),
    });
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    region_id: "borghi-radius",
    generated_at: new Date().toISOString(),
    center: CENTER,
    radius_km: 300,
    places,
  }, null, 2));

  console.log(`OK BORGHI → ${places.length} borghi`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
