import fs from "fs";
import path from "path";

const ROOT = process.cwd();

const region = process.argv[2];   // es: piemonte
const category = process.argv[3]; // es: borghi
const LIMIT = Number(process.argv[4] || 600);

if (!region || !category) {
  console.error("Usage: node scripts/trim_bbox_region.mjs piemonte borghi 600");
  process.exit(1);
}

const FILE = path.join(
  ROOT,
  "public",
  "data",
  "pois",
  "regions",
  `data-it-${region}-${category}`,
  `it-${region}-${category}.json`
);

if (!fs.existsSync(FILE)) {
  console.error("File not found:", FILE);
  process.exit(1);
}

function norm(s){
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .replace(/[^a-z0-9]+/g," ");
}

function tagsStr(p){
  return (p.tags || []).join(" ").toLowerCase();
}

function score(p){
  const t = tagsStr(p);
  const n = norm(p.name);
  let s = 0;

  if (t.includes("wikipedia=")) s += 40;
  if (t.includes("wikidata=")) s += 30;
  if (t.includes("website=")) s += 20;
  if (t.includes("historic=")) s += 15;
  if (t.includes("tourism=attraction")) s += 15;
  if (t.includes("tourism=viewpoint")) s += 10;

  if (n.includes("centro storico")) s += 15;
  if (n.includes("borgo")) s += 15;
  if (n.includes("castello")) s += 20;

  if (n.includes("parcheggio")) s -= 50;
  if (t.includes("highway=")) s -= 80;

  return s;
}

const raw = JSON.parse(fs.readFileSync(FILE,"utf8"));
const places = raw.places || [];

const filtered = places
  .map(p => ({ ...p, score: score(p) }))
  .filter(p => p.score > 0)
  .sort((a,b) => b.score - a.score)
  .slice(0, LIMIT);

raw.places = filtered;
raw.meta = {
  ...(raw.meta || {}),
  trimmed_at: new Date().toISOString(),
  original_count: places.length,
  final_count: filtered.length
};

fs.writeFileSync(FILE, JSON.stringify(raw));
console.log("Trim complete:", places.length, "->", filtered.length);
