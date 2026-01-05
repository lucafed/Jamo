// Build FAMILY POIs - ITALY (offline)
// Output: public/data/pois/it/family.json
// Family = theme parks, water parks, zoo, aquarium, adventure parks, kids museums,
// playground WITH name, ice rinks, ski/snow kids areas (best-effort)

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "public/data/pois/it");
const OUT_FILE = path.join(OUT_DIR, "family.json");

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

function ensureDir(p){
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function opBody(q){ return `data=${encodeURIComponent(q)}`; }

async function fetchOverpass(query) {
  const body = opBody(query);

  let lastErr = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 60000);

        const r = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body,
          signal: ctrl.signal,
        });

        clearTimeout(t);

        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json().catch(() => null);
        if (!j) throw new Error("Bad JSON");
        return j;

      } catch (e) {
        lastErr = e;
        await sleep(800 * attempt);
      }
    }
  }
  throw new Error(`Overpass failed: ${String(lastErr?.message || lastErr)}`);
}

// IT area
function buildQueryIT() {
  // NOTA: area ISO per IT
  // Poi query SOLO family veri, niente spa/terme/città
  return `
[out:json][timeout:180];
area["ISO3166-1"="IT"]->.aIT;
(
  // 🎢 Theme parks
  nwr[tourism=theme_park](area.aIT);

  // 💦 Water parks
  nwr[leisure=water_park](area.aIT);

  // 🦁 Zoo / aquarium
  nwr[tourism=zoo](area.aIT);
  nwr[tourism=aquarium](area.aIT);

  // 🌲 Adventure parks / climbing (molto family)
  nwr["name"~"parco\\s?avventura|adventure\\s?park|tree\\s?top|acrobatic|zip\\s?line",i](area.aIT);

  // 🧒 Kids museums / science centers
  nwr[tourism=museum]["name"~"bambin|kids|children|museo\\s?dei\\s?bambini|science\\s?center|planetar",i](area.aIT);
  nwr[tourism=attraction]["name"~"bambin|kids|children|science\\s?center|planetar",i](area.aIT);

  // 🛝 Playgrounds SOLO se hanno un nome (riduce spam)
  nwr[leisure=playground]["name"](area.aIT);

  // ⛸️ Ice rink (ottimo inverno)
  nwr[leisure=ice_rink](area.aIT);

  // ❄️ Snow / ski kids (best-effort con nome)
  nwr["name"~"baby\\s?park|snow\\s?park|parco\\s?neve|slitt|bob\\s?track|pista\\s?slitt|ski\\s?school|scuola\\s?sci",i](area.aIT);
);
out tags center;
`.trim();
}

function mapElementToPlace(el) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || "";
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  // ❌ Escludi città/paesi (place=city/town/village...)
  if (tags.place) return null;

  // ❌ Escludi spa/terme (family non deve prenderle mai)
  if (
    tags.amenity === "spa" ||
    tags.leisure === "spa" ||
    tags.natural === "hot_spring" ||
    /terme|spa|thermal|benessere/i.test(name)
  ) return null;

  // tag list compatta
  const tagList = [];
  const pushKV = (k) => { if (tags[k] != null) tagList.push(`${k}=${tags[k]}`); };
  ["tourism","leisure","amenity","sport","aerialway","natural"].forEach(pushKV);

  // sotto-tipo utile per UI/logica stagione
  let subtype = "family";
  if (tags.tourism === "theme_park") subtype = "theme_park";
  else if (tags.leisure === "water_park") subtype = "water_park";
  else if (tags.tourism === "zoo") subtype = "zoo";
  else if (tags.tourism === "aquarium") subtype = "aquarium";
  else if (tags.leisure === "playground") subtype = "playground";
  else if (tags.leisure === "ice_rink") subtype = "ice_rink";
  else if (/snow|neve|slitt|bob|sci|ski|baby\s?park/i.test(name)) subtype = "snow_family";
  else if (/avventura|adventure|zip\s?line|acrobatic/i.test(name)) subtype = "adventure_park";

  return {
    id: `poi_it_family_${el.type}_${el.id}`,
    name: String(name).trim(),
    lat,
    lon,
    country: "IT",
    type: "family",
    subtype,
    primary_category: "family",
    visibility: "classica",
    beauty_score: 0.72,
    tags: Array.from(new Set(tagList)).slice(0, 18),
    source: "overpass_it_family",
  };
}

function dedupPlaces(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const k = `${p.name.toLowerCase()}_${p.lat.toFixed(4)}_${p.lon.toFixed(4)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

async function main() {
  ensureDir(OUT_DIR);

  console.log("🛰️ Building IT FAMILY POIs...");
  const q = buildQueryIT();
  const j = await fetchOverpass(q);

  const elements = Array.isArray(j.elements) ? j.elements : [];
  const mapped = dedupPlaces(elements.map(mapElementToPlace).filter(Boolean));

  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify({
      meta: {
        category: "family",
        country: "IT",
        count: mapped.length,
        built_at: new Date().toISOString(),
        notes: ["offline", "country_scoped", "family_strict"],
      },
      places: mapped,
    }, null, 2),
    "utf8"
  );

  console.log(`✅ DONE: ${mapped.length} → public/data/pois/it/family.json`);
}

main().catch((e) => {
  console.error("❌ BUILD FAILED:", e);
  process.exit(1);
});
