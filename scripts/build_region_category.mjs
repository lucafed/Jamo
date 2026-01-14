import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { overpass, toPlace, writeJson } from "./lib/overpass.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REGION_ID = String(process.env.REGION_ID || "").trim();
const CATEGORY = String(process.env.CATEGORY || "").trim().toLowerCase();

if (!REGION_ID) throw new Error("Missing env REGION_ID (e.g. it-veneto)");

const VALID = [
  "relax",
  "borghi",
  "cantine",
  "citta",
  "storia",
  "natura",
  "panorami",
  "trekking",
  "montagna",
  "mare",
  "family",
];

if (!VALID.includes(CATEGORY)) {
  throw new Error(`Missing/invalid env CATEGORY (${VALID.join("|")})`);
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
function tagsToString(tags) {
  return Object.entries(tags || {})
    .map(([k,v]) => `${String(k).toLowerCase()}=${String(v).toLowerCase()}`)
    .join(" ");
}

// ---------------------- GLOBAL ANTI-SPAZZATURA ----------------------
function isClearlyIrrelevant(p) {
  const t = p.tags || {};
  const ts = tagsToString(t);
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

  // roba palesemente non “luogo da visitare”
  if (hasAny(ts, ["amenity=school","amenity=university","amenity=police","amenity=fire_station"])) return true;

  return false;
}

// ---------------------- AREA SELECTOR ----------------------
function overpassAreaSelectorByISO(iso3166_2) {
  return `area["ISO3166-2"="${iso3166_2}"]["boundary"="administrative"]->.a;`;
}

// ---------------------- CATEGORY QUERIES ----------------------
function buildQuery(category, iso3166_2) {
  const header = `[out:json][timeout:240];`;
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

  node(area.a)["natural"="hot_spring"];
  way(area.a)["natural"="hot_spring"];
  relation(area.a)["natural"="hot_spring"];

  node(area.a)["tourism"="hotel"]["spa"];
  way(area.a)["tourism"="hotel"]["spa"];
  relation(area.a)["tourism"="hotel"]["spa"];
);
out center tags;`;
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
);
out center tags;`;
  }

  if (category === "borghi") {
    return `
${header}
${area}
(
  node(area.a)["place"="village"];
  node(area.a)["place"="hamlet"];

  // centri storici/borghi spesso mappati come attraction
  node(area.a)["tourism"="attraction"]["name"];
  way(area.a)["tourism"="attraction"]["name"];
  relation(area.a)["tourism"="attraction"]["name"];

  // castelli e mura a supporto
  node(area.a)["historic"="castle"]["name"];
  way(area.a)["historic"="castle"]["name"];
  relation(area.a)["historic"="castle"]["name"];

  node(area.a)["historic"="citywalls"]["name"];
  node(area.a)["historic"="city_gate"]["name"];
);
out center tags;`;
  }

  if (category === "citta") {
    return `
${header}
${area}
(
  node(area.a)["place"="city"]["name"];
  node(area.a)["place"="town"]["name"];
);
out center tags;`;
  }

  if (category === "storia") {
    return `
${header}
${area}
(
  node(area.a)["historic"]["name"];
  way(area.a)["historic"]["name"];
  relation(area.a)["historic"]["name"];

  node(area.a)["tourism"="museum"]["name"];
  way(area.a)["tourism"="museum"]["name"];
  relation(area.a)["tourism"="museum"]["name"];

  node(area.a)["tourism"="attraction"]["heritage"~"."]["name"];
  way(area.a)["tourism"="attraction"]["heritage"~"."]["name"];
  relation(area.a)["tourism"="attraction"]["heritage"~"."]["name"];
);
out center tags;`;
  }

  if (category === "natura") {
    return `
${header}
${area}
(
  node(area.a)["natural"="waterfall"]["name"];
  way(area.a)["natural"="waterfall"]["name"];
  relation(area.a)["natural"="waterfall"]["name"];

  node(area.a)["natural"="spring"]["name"];
  node(area.a)["natural"="cave_entrance"]["name"];

  node(area.a)["natural"="wood"]["name"];
  way(area.a)["natural"="wood"]["name"];

  node(area.a)["leisure"="nature_reserve"]["name"];
  way(area.a)["leisure"="nature_reserve"]["name"];
  relation(area.a)["leisure"="nature_reserve"]["name"];

  node(area.a)["boundary"="national_park"]["name"];
  way(area.a)["boundary"="national_park"]["name"];
  relation(area.a)["boundary"="national_park"]["name"];

  node(area.a)["natural"="beach"]["name"];
);
out center tags;`;
  }

  if (category === "panorami") {
    return `
${header}
${area}
(
  node(area.a)["tourism"="viewpoint"]["name"];
  way(area.a)["tourism"="viewpoint"]["name"];
  relation(area.a)["tourism"="viewpoint"]["name"];

  node(area.a)["natural"="peak"]["name"];
  node(area.a)["man_made"="tower"]["name"];
);
out center tags;`;
  }

  if (category === "trekking") {
    return `
${header}
${area}
(
  // sentieri: prendiamo info point + aree note
  node(area.a)["information"="guidepost"]["name"];
  node(area.a)["information"="map"]["name"];
  node(area.a)["tourism"="information"]["information"="office"]["name"];

  node(area.a)["tourism"="alpine_hut"]["name"];
  way(area.a)["tourism"="alpine_hut"]["name"];
  relation(area.a)["tourism"="alpine_hut"]["name"];

  node(area.a)["leisure"="park"]["name"];
  way(area.a)["leisure"="park"]["name"];
);
out center tags;`;
  }

  if (category === "montagna") {
    return `
${header}
${area}
(
  node(area.a)["natural"="peak"]["name"];
  node(area.a)["natural"="saddle"]["name"];

  node(area.a)["tourism"="alpine_hut"]["name"];
  way(area.a)["tourism"="alpine_hut"]["name"];
  relation(area.a)["tourism"="alpine_hut"]["name"];

  node(area.a)["aerialway"]["name"];
  way(area.a)["aerialway"]["name"];
);
out center tags;`;
  }

  if (category === "mare") {
    return `
${header}
${area}
(
  node(area.a)["natural"="beach"]["name"];
  way(area.a)["natural"="beach"]["name"];
  relation(area.a)["natural"="beach"]["name"];

  node(area.a)["tourism"="attraction"]["name"]["water"~"."]; // alcune attrazioni costiere
  node(area.a)["man_made"="lighthouse"]["name"];

  node(area.a)["leisure"="marina"]["name"];
  way(area.a)["leisure"="marina"]["name"];
);
out center tags;`;
  }

  // family
  return `
${header}
${area}
(
  node(area.a)["tourism"="zoo"]["name"];
  way(area.a)["tourism"="zoo"]["name"];

  node(area.a)["tourism"="theme_park"]["name"];
  way(area.a)["tourism"="theme_park"]["name"];

  node(area.a)["leisure"="park"]["name"];
  way(area.a)["leisure"="park"]["name"];

  node(area.a)["leisure"="playground"]["name"];
  node(area.a)["amenity"="aquarium"]["name"];
);
out center tags;`;
}

// ---------------------- CATEGORY FILTERS (extra pulizia) ----------------------
function categoryReject(category, p) {
  const t = p.tags || {};
  const ts = tagsToString(t);
  const n = normName(p.name || "");

  if (category === "borghi") {
    // elimina musei/robe a tema che inquina “borghi”
    if (ts.includes("tourism=museum")) return true;
    if (hasAny(n, ["museo","galleria","mostra"])) return true;
    return false;
  }

  if (category === "trekking") {
    // togli guidepost/map senza nome (spazzatura)
    if (!String(p.name || "").trim()) return true;
    // togli uffici generici
    if (ts.includes("tourism=information") && !ts.includes("information=office")) return true;
    return false;
  }

  if (category === "montagna") {
    // evita “peak” senza nome
    if ((ts.includes("natural=peak") || ts.includes("natural=saddle")) && !String(p.name || "").trim()) return true;
    return false;
  }

  if (category === "mare") {
    // evita porti industriali
    if (hasAny(ts, ["landuse=industrial","industrial="])) return true;
    return false;
  }

  return false;
}

// ---------------------- SCORING ----------------------
function scoreRelax(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  let s = 0;

  if (tagEq(t,"natural","hot_spring")) s += 85;
  if (tagEq(t,"amenity","public_bath")) s += 75;
  if (tagEq(t,"tourism","spa")) s += 65;
  if (tagEq(t,"amenity","sauna")) s += 55;

  if (String(t["bath:type"]||"").toLowerCase().includes("thermal")) s += 40;
  if (hasAny(n, ["terme","termale","thermal"])) s += 35;
  if (hasAny(n, ["spa","wellness","benessere"])) s += 15;

  if (hasTag(t,"website") || hasTag(t,"contact:website")) s += 8;
  if (hasTag(t,"opening_hours")) s += 5;
  if (hasTag(t,"phone") || hasTag(t,"contact:phone")) s += 5;

  if (n.includes("s.p.a") || n.includes("azienda")) s -= 25;
  return s;
}

function scoreCantine(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  let s = 0;

  if (tagEq(t,"craft","winery")) s += 85;
  if (tagEq(t,"shop","wine")) s += 55;
  if (tagEq(t,"amenity","wine_bar")) s += 35;

  if (hasAny(n, ["cantina","winery","enoteca"])) s += 25;
  if (hasAny(n, ["degustaz","tasting","wine tour"])) s += 20;
  if (hasTag(t,"website") || hasTag(t,"contact:website")) s += 8;
  if (hasTag(t,"opening_hours")) s += 5;

  return s;
}

function scoreBorghi(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  const ts = tagsToString(t);
  let s = 0;

  if (ts.includes("place=city")) s += 10;
  if (ts.includes("place=town")) s += 20;
  if (ts.includes("place=village")) s += 55;
  if (ts.includes("place=hamlet")) s += 45;

  if (hasAny(n, ["borgo","centro storico","frazione","paese"])) s += 30;
  if (ts.includes("historic=castle") || ts.includes("historic=citywalls") || ts.includes("historic=city_gate")) s += 10;

  if (hasTag(t,"wikipedia") || hasTag(t,"wikidata")) s += 10;
  if (hasTag(t,"website") || hasTag(t,"contact:website")) s += 6;

  if (ts.includes("tourism=attraction") && !hasAny(n, ["borgo","centro storico"]) && !hasAny(ts, ["place=village","place=hamlet","place=town"])) s -= 12;

  return s;
}

function scoreCitta(p) {
  const t = p.tags || {};
  const ts = tagsToString(t);
  let s = 0;
  if (ts.includes("place=city")) s += 85;
  if (ts.includes("place=town")) s += 70;
  if (hasTag(t,"wikipedia") || hasTag(t,"wikidata")) s += 10;
  return s;
}

function scoreStoria(p) {
  const t = p.tags || {};
  const ts = tagsToString(t);
  const n = normName(p.name || "");
  let s = 0;

  if (ts.includes("historic=castle")) s += 70;
  else if (ts.includes("historic=ruins")) s += 60;
  else if (ts.includes("historic=archaeological_site")) s += 65;
  else if (ts.includes("historic=monument")) s += 55;
  else if (ts.includes("historic=")) s += 40;

  if (ts.includes("tourism=museum")) s += 35;

  if (hasAny(n, ["castello","abbazia","anfiteatro","teatro romano","duomo","cattedrale"])) s += 15;
  if (hasTag(t,"wikipedia") || hasTag(t,"wikidata")) s += 10;

  return s;
}

function scoreNatura(p) {
  const t = p.tags || {};
  const ts = tagsToString(t);
  let s = 0;

  if (ts.includes("boundary=national_park")) s += 85;
  if (ts.includes("leisure=nature_reserve")) s += 75;
  if (ts.includes("natural=waterfall")) s += 70;
  if (ts.includes("natural=cave_entrance")) s += 55;
  if (ts.includes("natural=spring")) s += 45;
  if (ts.includes("natural=wood")) s += 35;
  if (ts.includes("natural=beach")) s += 35;

  if (hasTag(t,"wikipedia") || hasTag(t,"wikidata")) s += 8;
  return s;
}

function scorePanorami(p) {
  const t = p.tags || {};
  const ts = tagsToString(t);
  let s = 0;

  if (ts.includes("tourism=viewpoint")) s += 85;
  if (ts.includes("natural=peak")) s += 55;
  if (ts.includes("man_made=tower")) s += 35;
  if (hasTag(t,"wikipedia") || hasTag(t,"wikidata")) s += 8;

  return s;
}

function scoreTrekking(p) {
  const t = p.tags || {};
  const ts = tagsToString(t);
  let s = 0;

  if (ts.includes("tourism=alpine_hut")) s += 70;
  if (ts.includes("leisure=park")) s += 35;
  if (ts.includes("information=guidepost")) s += 25;
  if (ts.includes("information=map")) s += 20;
  if (ts.includes("tourism=information") && ts.includes("information=office")) s += 30;

  if (hasTag(t,"wikipedia") || hasTag(t,"wikidata")) s += 8;
  return s;
}

function scoreMontagna(p) {
  const t = p.tags || {};
  const ts = tagsToString(t);
  let s = 0;

  if (ts.includes("natural=peak")) s += 80;
  if (ts.includes("natural=saddle")) s += 45;
  if (ts.includes("tourism=alpine_hut")) s += 55;
  if (ts.includes("aerialway=")) s += 25;

  if (hasTag(t,"wikipedia") || hasTag(t,"wikidata")) s += 8;
  return s;
}

function scoreMare(p) {
  const t = p.tags || {};
  const ts = tagsToString(t);
  let s = 0;

  if (ts.includes("natural=beach")) s += 85;
  if (ts.includes("man_made=lighthouse")) s += 55;
  if (ts.includes("leisure=marina")) s += 35;
  if (hasTag(t,"wikipedia") || hasTag(t,"wikidata")) s += 8;

  return s;
}

function scoreFamily(p) {
  const t = p.tags || {};
  const ts = tagsToString(t);
  let s = 0;

  if (ts.includes("tourism=theme_park")) s += 85;
  if (ts.includes("tourism=zoo")) s += 70;
  if (ts.includes("amenity=aquarium")) s += 65;
  if (ts.includes("leisure=park")) s += 35;
  if (ts.includes("leisure=playground")) s += 25;

  if (hasTag(t,"website") || hasTag(t,"contact:website")) s += 6;
  return s;
}

function computeScore(category, p) {
  if (category === "relax") return scoreRelax(p);
  if (category === "cantine") return scoreCantine(p);
  if (category === "borghi") return scoreBorghi(p);
  if (category === "citta") return scoreCitta(p);
  if (category === "storia") return scoreStoria(p);
  if (category === "natura") return scoreNatura(p);
  if (category === "panorami") return scorePanorami(p);
  if (category === "trekking") return scoreTrekking(p);
  if (category === "montagna") return scoreMontagna(p);
  if (category === "mare") return scoreMare(p);
  return scoreFamily(p);
}

function visibilityFromScore(score) {
  // soglia “chicca”
  return score >= 70 ? "chicca" : "classica";
}

// ---------------------- MAIN ----------------------
async function main() {
  console.log(`[BUILD] ${REGION_ID} • ${CATEGORY} • iso=${region.iso3166_2}`);

  let data;
  try {
    const q = buildQuery(CATEGORY, region.iso3166_2);
    data = await overpass(q, { retries: 7, timeoutMs: 190000 });
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
    .filter(p => !isClearlyIrrelevant(p))
    .filter(p => !categoryReject(CATEGORY, p));

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
      const score = computeScore(CATEGORY, p);
      return {
        id: p.id,
        name: p.name,
        lat: p.lat,
        lon: p.lon,
        type: CATEGORY,
        visibility: visibilityFromScore(score),
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
