import fs from "fs";
import path from "path";

const OUT_PATH = path.join(process.cwd(), "public", "data", "pois", "regions", "radius-mare.json");

const COASTAL_BBOXES_IT = [
  { minLat: 44.75, maxLat: 46.30, minLon: 12.00, maxLon: 13.90 },
  { minLat: 44.00, maxLat: 45.15, minLon: 11.80, maxLon: 13.40 },
  { minLat: 42.55, maxLat: 44.20, minLon: 12.90, maxLon: 13.90 },
  { minLat: 41.98, maxLat: 42.52, minLon: 13.90, maxLon: 14.90 },
  { minLat: 41.00, maxLat: 42.20, minLon: 11.20, maxLon: 12.90 },
  { minLat: 42.30, maxLat: 44.10, minLon: 9.70,  maxLon: 11.40 },
  { minLat: 40.40, maxLat: 41.20, minLon: 13.70, maxLon: 15.10 },
  { minLat: 39.70, maxLat: 42.20, minLon: 15.00, maxLon: 18.60 },
  { minLat: 36.60, maxLat: 38.40, minLon: 12.20, maxLon: 15.70 },
  { minLat: 38.80, maxLat: 41.40, minLon: 8.00,  maxLon: 9.90 },
];

const OVERPASS = "https://overpass-api.de/api/interpreter";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function norm(s){
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g," ")
    .trim();
}

function isRealSeaName(name){
  const n = norm(name);
  return (
    n.includes("spiaggia") ||
    n.includes("lido") ||
    n.includes("baia") ||
    n.includes("cala") ||
    n.includes("scogliera") ||
    n.includes("litorale")
  );
}

function makeQuery(b){
  return `
[out:json][timeout:180];
(
  nwr["natural"="beach"](${b.minLat},${b.minLon},${b.maxLat},${b.maxLon});
  nwr["natural"="bay"](${b.minLat},${b.minLon},${b.maxLat},${b.maxLon});
  nwr["natural"="cliff"](${b.minLat},${b.minLon},${b.maxLat},${b.maxLon});
  nwr["natural"="reef"](${b.minLat},${b.minLon},${b.maxLat},${b.maxLon});
  nwr["natural"="cape"](${b.minLat},${b.minLon},${b.maxLat},${b.maxLon});
);
out center tags;
`;
}

async function fetchOverpass(q){
  const r = await fetch(OVERPASS, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(q),
  });
  if(!r.ok) throw new Error("Overpass error");
  return r.json();
}

function elementToPlace(el){
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"];
  if(!name) return null;
  if(!isRealSeaName(name)) return null;

  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if(!lat || !lon) return null;

  return {
    id: `${el.type}/${el.id}`,
    name,
    lat,
    lon,
    type: "mare",
    primary_category: "mare",
    country: "IT",
    area: "",
    visibility: "unknown",
    beauty_score: 0.75,
    tags: Object.entries(tags).map(([k,v])=>`${k}=${v}`),
    source: "osm_overpass"
  };
}

async function main(){
  let all = [];

  for(const b of COASTAL_BBOXES_IT){
    const q = makeQuery(b);
    const j = await fetchOverpass(q);
    const els = j.elements || [];
    const places = els.map(elementToPlace).filter(Boolean);
    all = all.concat(places);
    await sleep(400);
  }

  // dedupe
  const map = new Map();
  for(const p of all){
    if(!map.has(p.id)) map.set(p.id, p);
  }

  const final = [...map.values()];

  const out = {
    updated_at: new Date().toISOString(),
    count: final.length,
    places: final
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));

  console.log("✅ radius-mare.json scritto:", final.length);
}

main().catch(e=>{
  console.error(e);
  process.exit(1);
});
