import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { overpass, toPlace, writeJson } from "./lib/overpass.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REGION_ID = String(process.env.REGION_ID || "").trim();
const CATEGORY = String(process.env.CATEGORY || "").trim().toLowerCase();

if (!REGION_ID) throw new Error("Missing env REGION_ID (e.g. it-veneto)");
if (!["relax", "borghi", "cantine"].includes(CATEGORY)) {
  throw new Error("Missing/invalid env CATEGORY (relax|borghi|cantine)");
}

const REGIONS_CFG_PATH = path.join(__dirname, "..", "configs", "it", "regions.json");
const cfg = JSON.parse(fs.readFileSync(REGIONS_CFG_PATH, "utf-8"));
const region = (cfg.regions || []).find(r => String(r.id) === REGION_ID);
if (!region) throw new Error(`Region not found in configs: ${REGION_ID}`);

const OUT = path.join(__dirname, "..", "public", "data", "pois", "regions", `${REGION_ID}-${CATEGORY}.json`);

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
function tagEq(tags, k, v) { return String(tags?.[k] ?? "").toLowerCase() === String(v).toLowerCase(); }
function hasTag(tags, k) { return tags?.[k] != null && String(tags[k]).trim() !== ""; }

// ---------------------- GLOBAL ANTI-SPAZZATURA ----------------------
function isClearlyIrrelevant(p) {
  const t = p.tags || {};
  const ts = Object.entries(t).map(([k,v]) => `${String(k).toLowerCase()}=${String(v).toLowerCase()}`).join(" ");
  const n = normName(p.name || "");

  // trasporti/strade
  if (hasAny(ts, ["highway=", "railway=", "public_transport=", "route=", "junction="])) return true;
  if (hasAny(ts, ["amenity=bus_station","highway=bus_stop","highway=platform"])) return true;

  // parking/fuel/charging
  if (hasAny(ts, ["amenity=parking","amenity=parking_entrance","amenity=parking_space","highway=rest_area","amenity=fuel","amenity=charging_station"])) return true;

  // industrial/commercial/office
  if (hasAny(ts, ["landuse=industrial","landuse=commercial","building=industrial","building=warehouse","building=office","man_made=works"])) return true;

  // OSM technical noise
  if (hasAny(ts, ["man_made=survey_point","power=","telecom=","pipeline=","boundary=","place=locality"])) return true;

  // nomi spazzatura
  if (hasAny(n, ["parcheggio","stazione","fermata","svincolo","uscita","cabina","impianto","linea","tratto","km "])) return true;

  // “SpA azienda” (ma non spa terme)
  const looksCompany = (n.endsWith(" spa") || n.includes(" s p a") || n.includes(" s.p.a") || n.includes(" azienda "));
  const looksWellness = hasAny(n, ["terme","spa","wellness","termale","thermal"]);
  if (looksCompany && !looksWellness) return true;

  return false;
}

// ---------------------- CATEGORY QUERIES ----------------------
function overpassAreaSelectorByISO(iso3166_2) {
  // Overpass: area by ISO3166-2 (admin boundary)
  // tip: relazioni admin possono avere diversi tag, quindi includiamo entrambe.
  return `
    area["ISO3166-2"="${iso3166_2}"]["boundary"="administrative"]->.a;
  `;
}

function buildQuery(category, iso3166_2) {
  const header = `[out:json][timeout:220];`;
  const area = overpassAreaSelectorByISO(iso3166_2);

  if (category === "relax") {
    return `
${header}
${area}
(
  node(area.a)["tourism"="spa"];
  way(area.a)["tourism"="spa"];
  relation(area.a)["tourism"="spa"];

  node(area.a)["amenity"="public_bath"];
  way(area.a)["amenity"="public_bath"];
  relation(area.a)["amenity"="public_bath"];

  node(area.a)["amenity"="sauna"];
  way(area.a)["amenity"="sauna"];
  relation(area.a)["amenity"="sauna"];

  node(area.a)["leisure"="spa"];
  way(area.a)["leisure"="spa"];
  relation(area.a)["leisure"="spa"];

  node(area.a)["healthcare"="spa"];
  way(area.a)["healthcare"="spa"];
  relation(area.a)["healthcare"="spa"];

  node(area.a)["natural"="hot_spring"];
  way(area.a)["natural"="hot_spring"];
  relation(area.a)["natural"="hot_spring"];

  // hotel con spa flag
  node(area.a)["tourism"="hotel"]["spa"];
  way(area.a)["tourism"="hotel"]["spa"];
  relation(area.a)["tourism"="hotel"]["spa"];
);
out center tags;
`;
  }

  if (category === "cantine") {
    return `
${header}
${area}
(
  node(area.a)["craft"="winery"];
  way(area.a)["craft"="winery"];
  relation(area.a)["craft"="winery"];

  node(area.a)["shop"="wine"];
  way(area.a)["shop"="wine"];
  relation(area.a)["shop"="wine"];

  node(area.a)["amenity"="wine_bar"];
  way(area.a)["amenity"="wine_bar"];
  relation(area.a)["amenity"="wine_bar"];

  // attrazioni wine-related (non sempre perfette ma ci aiuta)
  node(area.a)["tourism"="attraction"]["wine"];
  way(area.a)["tourism"="attraction"]["wine"];
  relation(area.a)["tourism"="attraction"]["wine"];
);
out center tags;
`;
  }

  // borghi
  return `
${header}
${area}
(
  // place nodes
  node(area.a)["place"="village"];
  node(area.a)["place"="hamlet"];
  node(area.a)["place"="suburb"];

  // centri storici / borgo come attraction (alcuni sono ottimi)
  node(area.a)["tourism"="attraction"]["name"];
  way(area.a)["tourism"="attraction"]["name"];
  relation(area.a)["tourism"="attraction"]["name"];

  // historic settlements
  node(area.a)["historic"="city_gate"];
  node(area.a)["historic"="citywalls"];
  node(area.a)["historic"="castle"];
);
out center tags;
`;
}

// ---------------------- SCORING + VISIBILITY ----------------------
function scoreRelax(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  let s = 0;

  if (tagEq(t,"natural","hot_spring")) s += 80;
  if (tagEq(t,"amenity","public_bath")) s += 70;
  if (tagEq(t,"tourism","spa")) s += 65;
  if (tagEq(t,"leisure","spa")) s += 60;
  if (tagEq(t,"amenity","sauna")) s += 55;

  if (String(t["bath:type"]||"").toLowerCase().includes("thermal")) s += 45;
  if (hasAny(n, ["terme","termale","thermal"])) s += 40;
  if (hasAny(n, ["spa","wellness","benessere"])) s += 20;

  if (hasTag(t,"website") || hasTag(t,"contact:website")) s += 8;
  if (hasTag(t,"opening_hours")) s += 5;
  if (hasTag(t,"phone") || hasTag(t,"contact:phone")) s += 5;

  // penalità azienda
  if (n.includes("s.p.a") || n.includes("azienda")) s -= 25;

  return s;
}

function scoreCantine(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  let s = 0;

  if (tagEq(t,"craft","winery")) s += 80;
  if (tagEq(t,"shop","wine")) s += 55;
  if (tagEq(t,"amenity","wine_bar")) s += 35;

  if (hasAny(n, ["cantina","winery","enoteca"])) s += 25;
  if (hasAny(n, ["degustaz","tasting","wine tour"])) s += 20;
  if (hasTag(t,"website") || hasTag(t,"contact:website")) s += 8;
  if (hasTag(t,"opening_hours")) s += 5;

  return s;
}

function isBorgoNoise(p) {
  const t = p.tags || {};
  const ts = Object.entries(t).map(([k,v]) => `${String(k).toLowerCase()}=${String(v).toLowerCase()}`).join(" ");
  const n = normName(p.name || "");

  // fuori tema (montagna/museo/etc)
  if (ts.includes("tourism=museum")) return true;
  if (hasAny(n, ["museo","galleria","mostra","spazio espositivo"])) return true;
  if (hasAny(n, ["monte","cima","passo","rifugio","malga","forte"])) return true;
  if (hasAny(ts, ["natural=peak","tourism=alpine_hut","amenity=shelter"])) return true;

  return false;
}

function scoreBorghi(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  const ts = Object.entries(t).map(([k,v]) => `${String(k).toLowerCase()}=${String(v).toLowerCase()}`).join(" ");
  let s = 0;

  if (ts.includes("place=village")) s += 55;
  if (ts.includes("place=hamlet")) s += 45;
  if (ts.includes("place=suburb")) s += 25;

  if (hasAny(n, ["borgo","centro storico","frazione","paese"])) s += 30;
  if (hasAny(ts, ["historic=castle","historic=citywalls","historic=city_gate"])) s += 15;

  if (hasTag(t,"wikipedia") || hasTag(t,"wikidata")) s += 10;
  if (hasTag(t,"website") || hasTag(t,"contact:website")) s += 6;

  // penalizza attraction generica senza place/keywords
  if (ts.includes("tourism=attraction") && !hasAny(n, ["borgo","centro storico"]) && !hasAny(ts, ["place=village","place=hamlet"])) s -= 12;

  return s;
}

function computeScore(category, p) {
  if (category === "relax") return scoreRelax(p);
  if (category === "cantine") return scoreCantine(p);
  return scoreBorghi(p);
}

function visibilityFromScore(score, category) {
  // chicche = top (relax/cantine un po' più generose)
  const cut = category === "borghi" ? 70 : 60;
  return score >= cut ? "chicca" : "classica";
}

// ---------------------- MAIN ----------------------
async function main() {
  console.log(`[BUILD] ${REGION_ID} • ${CATEGORY} • iso=${region.iso3166_2}`);

  let data;
  try {
    const q = buildQuery(CATEGORY, region.iso3166_2);
    data = await overpass(q, { retries: 7, timeoutMs: 170000 });
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

  // borghi: ulteriore pulizia
  const cleaned = (CATEGORY === "borghi")
    ? raw.filter(p => !isBorgoNoise(p))
    : raw;

  // dedupe: nome + coordinate
  const seen = new Set();
  const deduped = [];
  for (const p of cleaned) {
    const key = `${normName(p.name)}|${Number(p.lat).toFixed(5)}|${Number(p.lon).toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  const places = deduped
    .map(p => {
      const score = computeScore(CATEGORY, p);
      return {
        id: p.id,
        name: p.name,
        lat: p.lat,
        lon: p.lon,
        type: CATEGORY,
        visibility: visibilityFromScore(score, CATEGORY),
        tags: Object.entries(p.tags || {}).slice(0, 70).map(([k,v]) => `${k}=${v}`),
        score
      };
    })
    .sort((a,b) => (b.score - a.score))
    .slice(0, 12000);

  await writeJson(OUT, {
    region_id: `${REGION_ID}-${CATEGORY}`,
    label_it: `${region.name} • ${CATEGORY}`,
    generated_at: new Date().toISOString(),
    places
  });

  console.log(`✔ Written ${OUT} (${places.length} places)`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
