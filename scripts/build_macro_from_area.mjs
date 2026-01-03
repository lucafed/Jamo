// scripts/build_macro_from_area.mjs
// Build macro AUTO-ONLY from bbox + pois + curated
// Usage: node scripts/build_macro_from_area.mjs it_abruzzo

import fs from "fs";
import path from "path";

const ROOT = process.cwd();

const AREAS_FILE = path.join(ROOT, "public/data/areas.json");
const BBOX_DIR   = path.join(ROOT, "public/data/bbox");
const POIS_FILE  = path.join(ROOT, "public/data/pois_eu_uk.json");
const CURATED    = path.join(ROOT, "public/data/curated_destinations_eu_uk.json");
const OUT_DIR    = path.join(ROOT, "public/data/macros");

const areaId = process.argv[2];
if (!areaId) {
  console.error("❌ Missing area id. Example: node build_macro_from_area.mjs it_abruzzo");
  process.exit(1);
}

const norm = s =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();

const haversineKm = (a,b,c,d) => {
  const R = 6371;
  const toRad = x => x*Math.PI/180;
  const dLat = toRad(c-a);
  const dLon = toRad(d-b);
  return 2*R*Math.asin(Math.sqrt(
    Math.sin(dLat/2)**2 +
    Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(dLon/2)**2
  ));
};

const areas = JSON.parse(fs.readFileSync(AREAS_FILE,"utf8"));
const area = areas.find(a => a.id === areaId);
if (!area) throw new Error("Area not found in areas.json");

const bboxFile = path.join(BBOX_DIR, `${areaId}.json`);
if (!fs.existsSync(bboxFile)) throw new Error("BBox file missing");

const bbox = JSON.parse(fs.readFileSync(bboxFile,"utf8")).places || [];
const pois = JSON.parse(fs.readFileSync(POIS_FILE,"utf8")).pois || [];
const curated = JSON.parse(fs.readFileSync(CURATED,"utf8")).places || [];

function tagsFromPoi(p) {
  const t = new Set();
  const n = norm(p.name);
  if (n.includes("ristor") || n.includes("tratt") || n.includes("oster")) t.add("ristoranti");
  if (n.includes("museum") || n.includes("museo")) t.add("museo");
  if (n.includes("beach") || n.includes("spiaggia")) t.add("mare");
  if (n.includes("park") || n.includes("parco")) t.add("famiglie");
  if (n.includes("zoo") || n.includes("acquario")) t.add("bambini");
  if (n.includes("trek") || n.includes("sentier")) t.add("trekking");
  return t;
}

function beautyScore(tags, poiCount) {
  let s = 0.75;
  if (tags.has("mare")) s += 0.08;
  if (tags.has("montagna")) s += 0.08;
  if (tags.has("natura")) s += 0.07;
  if (tags.has("storia")) s += 0.05;
  if (tags.has("famiglie")) s += 0.04;
  s += Math.min(0.12, poiCount * 0.015);
  return Math.min(1, Number(s.toFixed(2)));
}

const places = [];

for (const p of bbox) {
  if (!p.lat || !p.lng || !p.name) continue;

  const nearbyPois = pois.filter(po =>
    haversineKm(p.lat, p.lng, po.lat, po.lng) <= 6
  );

  const tags = new Set();
  nearbyPois.forEach(po => tagsFromPoi(po).forEach(t => tags.add(t)));

  if (tags.size === 0) continue; // 🔥 scarta posti morti

  const type =
    tags.has("mare") ? "mare" :
    tags.has("montagna") ? "montagna" :
    tags.has("storia") ? "storia" :
    tags.has("famiglie") ? "family" :
    "natura";

  places.push({
    id: `${areaId}_${norm(p.name).replace(/\s+/g,"_")}`,
    name: p.name,
    area: area.name,
    lat: p.lat,
    lon: p.lng,
    type,
    tags: [...tags],
    visibility: p.population > 50000 ? "conosciuta" : "chicca",
    beauty_score: beautyScore(tags, nearbyPois.length),
    why: [
      `Buona scelta per ${type}`,
      `${nearbyPois.length} attività nei dintorni`,
      tags.has("famiglie") ? "Adatto anche ai bambini" : "Esperienza autentica"
    ]
  });
}

fs.mkdirSync(OUT_DIR,{recursive:true});
const outFile = path.join(OUT_DIR, `macro_${areaId}.json`);
fs.writeFileSync(outFile, JSON.stringify({
  id:`macro_${areaId}`,
  name:`Macro ${area.name} — AUTO ONLY`,
  updated_at:new Date().toISOString().slice(0,10),
  places
}));

console.log("✅ Macro generato:", outFile, "mete:", places.length);
