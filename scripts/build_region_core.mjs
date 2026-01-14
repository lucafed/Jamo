import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { overpass, toPlace, writeJson } from "./lib/overpass.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REGION_ID = String(process.env.REGION_ID || "").trim();
if (!REGION_ID) throw new Error("Missing env REGION_ID (e.g. it-veneto)");

const REGIONS_CFG_PATH = path.join(__dirname, "..", "configs", "it", "regions.json");
const cfg = JSON.parse(fs.readFileSync(REGIONS_CFG_PATH, "utf-8"));
const region = (cfg.regions || []).find(r => String(r.id) === REGION_ID);
if (!region) throw new Error(`Region not found in configs: ${REGION_ID}`);

const OUT = path.join(__dirname, "..", "public", "data", "pois", "regions", `${REGION_ID}.json`);

// ---------------------- UTIL ----------------------
function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function hasAny(str, arr) { return arr.some(k => str.includes(k)); }

// ---------------------- GLOBAL ANTI-SPAZZATURA ----------------------
function isClearlyIrrelevant(p) {
  const t = p.tags || {};
  const ts = Object.entries(t).map(([k,v]) => `${String(k).toLowerCase()}=${String(v).toLowerCase()}`).join(" ");
  const n = normName(p.name || "");

  if (hasAny(ts, ["highway=", "railway=", "public_transport=", "route=", "junction="])) return true;
  if (hasAny(ts, ["amenity=bus_station","highway=bus_stop","highway=platform"])) return true;

  if (hasAny(ts, [
    "amenity=parking","amenity=parking_entrance","amenity=parking_space",
    "highway=rest_area","amenity=fuel","amenity=charging_station"
  ])) return true;

  if (hasAny(ts, [
    "landuse=industrial","landuse=commercial","building=industrial",
    "building=warehouse","building=office","man_made=works"
  ])) return true;

  if (hasAny(ts, ["man_made=survey_point","power=","telecom=","pipeline=","boundary=","place=locality"])) return true;

  if (hasAny(n, ["parcheggio","stazione","fermata","svincolo","uscita","cabina","impianto","linea","tratto","km "])) return true;

  const looksCompany = (n.endsWith(" spa") || n.includes(" s p a") || n.includes(" s.p.a") || n.includes(" azienda "));
  const looksWellness = hasAny(n, ["terme","spa","wellness","termale","thermal"]);
  if (looksCompany && !looksWellness) return true;

  return false;
}

function overpassAreaSelectorByISO(iso3166_2) {
  return `area["ISO3166-2"="${iso3166_2}"]["boundary"="administrative"]->.a;`;
}

// CORE = “pulito ma denso”
// - abbastanza grande per far funzionare Natura/Panorami/Trekking/Montagna/Storia/Mare/Family/Città/Ovunque
function buildCoreQuery(iso3166_2) {
  const header = `[out:json][timeout:260];`;
  const area = overpassAreaSelectorByISO(iso3166_2);

  return `
${header}
${area}
(
  // ---- PLACE (copertura enorme) ----
  node(area.a)["place"="city"];
  node(area.a)["place"="town"];
  node(area.a)["place"="village"];
  node(area.a)["place"="hamlet"];

  // ---- NATURA / ACQUA ----
  node(area.a)["natural"="water"];
  way(area.a)["natural"="water"];
  relation(area.a)["natural"="water"];

  node(area.a)["water"="lake"];
  way(area.a)["water"="lake"];
  relation(area.a)["water"="lake"];

  node(area.a)["natural"="wood"];
  way(area.a)["natural"="wood"];

  node(area.a)["natural"="gorge"];
  node(area.a)["natural"="cave_entrance"];
  node(area.a)["natural"="spring"];

  node(area.a)["waterway"="river"];
  way(area.a)["waterway"="river"];
  node(area.a)["waterway"="stream"];
  way(area.a)["waterway"="stream"];

  // ---- MONTAGNA / TREKKING ----
  node(area.a)["natural"="peak"];
  node(area.a)["natural"="saddle"];

  node(area.a)["tourism"="alpine_hut"];
  way(area.a)["tourism"="alpine_hut"];
  node(area.a)["amenity"="shelter"];
  way(area.a)["amenity"="shelter"];

  // ---- PANORAMI ----
  node(area.a)["tourism"="viewpoint"];
  way(area.a)["tourism"="viewpoint"];
  node(area.a)["man_made"="observation_tower"];
  way(area.a)["man_made"="observation_tower"];

  // ---- PARCHI / RISERVE ----
  relation(area.a)["boundary"="national_park"];
  relation(area.a)["leisure"="nature_reserve"];
  way(area.a)["leisure"="nature_reserve"];

  // ---- STORIA ----
  node(area.a)["historic"="castle"];
  way(area.a)["historic"="castle"];
  node(area.a)["historic"="fort"];
  node(area.a)["historic"="ruins"];
  node(area.a)["historic"="archaeological_site"];
  node(area.a)["historic"="monument"];

  // ---- ATTRAZIONI / MUSEI (poi li filtri/scori in app) ----
  node(area.a)["tourism"="attraction"]["name"];
  way(area.a)["tourism"="attraction"]["name"];
  relation(area.a)["tourism"="attraction"]["name"];

  node(area.a)["tourism"="museum"]["name"];
  way(area.a)["tourism"="museum"]["name"];
  relation(area.a)["tourism"="museum"]["name"];

  // ---- FAMILY (segnali forti) ----
  node(area.a)["tourism"="theme_park"];
  way(area.a)["tourism"="theme_park"];
  node(area.a)["tourism"="zoo"];
  way(area.a)["tourism"="zoo"];
  node(area.a)["tourism"="aquarium"];
  way(area.a)["tourism"="aquarium"];

  node(area.a)["leisure"="water_park"];
  way(area.a)["leisure"="water_park"];
  node(area.a)["leisure"="adventure_park"];
  way(area.a)["leisure"="adventure_park"];
  node(area.a)["leisure"="playground"];
  way(area.a)["leisure"="playground"];

  // ---- MARE (segnali forti) ----
  node(area.a)["natural"="beach"];
  way(area.a)["natural"="beach"];
  node(area.a)["leisure"="marina"];
  way(area.a)["leisure"="marina"];
);
out center tags;
`;
}

function scoreCore(p) {
  const t = p.tags || {};
  const ts = Object.entries(t).map(([k,v]) => `${String(k).toLowerCase()}=${String(v).toLowerCase()}`).join(" ");
  const n = normName(p.name || "");

  let s = 0;

  // place
  if (ts.includes("place=city")) s += 22;
  if (ts.includes("place=town")) s += 18;
  if (ts.includes("place=village")) s += 14;
  if (ts.includes("place=hamlet")) s += 10;

  // natura / acqua
  if (ts.includes("water=lake")) s += 18;
  if (ts.includes("natural=water")) s += 14;
  if (ts.includes("waterway=river")) s += 10;
  if (ts.includes("natural=gorge")) s += 16;
  if (ts.includes("natural=waterfall")) s += 18;
  if (ts.includes("natural=spring")) s += 10;

  // montagna/trek/panorami
  if (ts.includes("natural=peak")) s += 14;
  if (ts.includes("tourism=viewpoint")) s += 16;
  if (ts.includes("man_made=observation_tower")) s += 12;
  if (ts.includes("tourism=alpine_hut")) s += 10;
  if (ts.includes("amenity=shelter")) s += 7;

  // storia/attrazioni
  if (hasAny(ts, ["historic=castle","historic=fort","historic=ruins","historic=archaeological_site"])) s += 16;
  if (ts.includes("tourism=attraction")) s += 10;
  if (ts.includes("tourism=museum")) s += 6;

  // family
  if (hasAny(ts, ["tourism=theme_park","tourism=zoo","tourism=aquarium","leisure=water_park","leisure=adventure_park"])) s += 18;
  if (ts.includes("leisure=playground")) s += 8;

  // mare
  if (ts.includes("natural=beach")) s += 16;
  if (ts.includes("leisure=marina")) s += 10;

  // segnali qualità
  if (t.website || t["contact:website"]) s += 4;
  if (t.wikipedia || t.wikidata) s += 4;
  if (t.opening_hours) s += 2;

  // penalità nomi troppo tecnici
  if (hasAny(n, ["impianto","cabina","svincolo","uscita","tratto","km "])) s -= 30;

  return s;
}

function visibilityFromScore(score) {
  // CORE: chicca solo in alto
  return score >= 22 ? "chicca" : "classica";
}

// ---------------------- MAIN ----------------------
async function main() {
  console.log(`[BUILD] CORE ${REGION_ID} • iso=${region.iso3166_2}`);

  let data;
  try {
    const q = buildCoreQuery(region.iso3166_2);
    data = await overpass(q, { retries: 7, timeoutMs: 200000 });
  } catch (e) {
    console.error("⚠️ Overpass failed.");
    if (fs.existsSync(OUT)) {
      console.log("✔ Keeping previous dataset (existing file found).");
      return;
    }
    throw e;
  }

  const raw = (data.elements || [])
    .map(toPlace)
    .filter(p => p && p.lat != null && p.lon != null)
    .filter(p => (p.name || "").trim() && (p.name || "").trim() !== "(senza nome)")
    .filter(p => !isClearlyIrrelevant(p));

  // dedupe: nome + coordinate
  const seen = new Set();
  const deduped = [];
  for (const p of raw) {
    const key = `${normName(p.name)}|${Number(p.lat).toFixed(5)}|${Number(p.lon).toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  const places = deduped
    .map(p => {
      const score = scoreCore(p);
      return {
        id: p.id,
        name: p.name,
        lat: p.lat,
        lon: p.lon,
        type: "core",
        visibility: visibilityFromScore(score),
        tags: Object.entries(p.tags || {}).slice(0, 70).map(([k,v]) => `${k}=${v}`),
        score
      };
    })
    .sort((a,b) => (b.score - a.score))
    .slice(0, 35000); // ✅ copertura vera, poi l’app filtra/scora

  await writeJson(OUT, {
    region_id: `${REGION_ID}`,
    label_it: `${region.name} • core`,
    generated_at: new Date().toISOString(),
    places
  });

  console.log(`✔ Written ${OUT} (${places.length} places)`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
