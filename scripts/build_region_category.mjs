import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { overpass, toPlace, writeJson } from "./lib/overpass.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REGION_ID = String(process.env.REGION_ID || "").trim();
const CATEGORY = String(process.env.CATEGORY || "").trim().toLowerCase();

if (!REGION_ID) throw new Error("Missing env REGION_ID (e.g. it-veneto)");

const CATEGORIES = [
  "relax",
  "borghi",
  "cantine",
  "mare",
  "natura",
  "panorami",
  "trekking",
  "family",
  "storia",
  "montagna",
  "citta",
];

if (!CATEGORIES.includes(CATEGORY)) {
  throw new Error(`Missing/invalid env CATEGORY (${CATEGORIES.join("|")})`);
}

const REGIONS_CFG_PATH = path.join(__dirname, "..", "configs", "it", "regions.json");
const cfg = JSON.parse(fs.readFileSync(REGIONS_CFG_PATH, "utf-8"));
const region = (cfg.regions || []).find(r => String(r.id) === REGION_ID);
if (!region) throw new Error(`Region not found in configs: ${REGION_ID}`);

const OUT = path.join(
  __dirname,
  "..",
  "public",
  "data",
  "pois",
  "regions",
  `${REGION_ID}-${CATEGORY}.json`
);

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

function overpassAreaSelectorByISO(iso3166_2) {
  return `area["ISO3166-2"="${iso3166_2}"]["boundary"="administrative"]->.a;`;
}

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

  // rumore tecnico
  if (hasAny(ts, ["man_made=survey_point","power=","telecom=","pipeline=","boundary=","place=locality"])) return true;

  // nomi spazzatura
  if (hasAny(n, ["parcheggio","stazione","fermata","svincolo","uscita","cabina","impianto","linea","tratto","km "])) return true;

  // “SpA azienda” (ma non spa terme)
  const looksCompany = (n.endsWith(" spa") || n.includes(" s p a") || n.includes(" s.p.a") || n.includes(" azienda "));
  const looksWellness = hasAny(n, ["terme","spa","wellness","termale","thermal"]);
  if (looksCompany && !looksWellness) return true;

  return false;
}

// ---------------------- OVERPASS QUERIES (CATEGORIE UI) ----------------------
function buildQuery(category, iso3166_2) {
  const header = `[out:json][timeout:240];`;
  const area = overpassAreaSelectorByISO(iso3166_2);

  // NOTE: "out center tags;" per ways/relations e node lat/lon
  // Manteniamo query "robuste" ma non eccessivamente gigantesche.

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
);
out center tags;
`;
  }

  if (category === "borghi") {
    return `
${header}
${area}
(
  node(area.a)["place"="village"];
  node(area.a)["place"="hamlet"];
  node(area.a)["place"="suburb"];

  node(area.a)["tourism"="attraction"]["name"];
  way(area.a)["tourism"="attraction"]["name"];
  relation(area.a)["tourism"="attraction"]["name"];

  node(area.a)["historic"="castle"];
  node(area.a)["historic"="citywalls"];
  node(area.a)["historic"="city_gate"];
);
out center tags;
`;
  }

  if (category === "mare") {
    return `
${header}
${area}
(
  node(area.a)["natural"="beach"];
  way(area.a)["natural"="beach"];
  relation(area.a)["natural"="beach"];

  node(area.a)["tourism"="beach_resort"];
  way(area.a)["tourism"="beach_resort"];
  relation(area.a)["tourism"="beach_resort"];

  node(area.a)["leisure"="marina"];
  way(area.a)["leisure"="marina"];
  relation(area.a)["leisure"="marina"];

  node(area.a)["man_made"="lighthouse"];
  way(area.a)["man_made"="lighthouse"];
  relation(area.a)["man_made"="lighthouse"];
);
out center tags;
`;
  }

  if (category === "natura") {
    return `
${header}
${area}
(
  node(area.a)["waterway"="waterfall"];
  way(area.a)["waterway"="waterfall"];
  relation(area.a)["waterway"="waterfall"];

  node(area.a)["natural"="cave_entrance"];
  way(area.a)["natural"="cave_entrance"];
  relation(area.a)["natural"="cave_entrance"];

  node(area.a)["natural"="spring"];
  way(area.a)["natural"="spring"];
  relation(area.a)["natural"="spring"];

  node(area.a)["natural"="hot_spring"];
  way(area.a)["natural"="hot_spring"];
  relation(area.a)["natural"="hot_spring"];

  relation(area.a)["boundary"="protected_area"];
  way(area.a)["leisure"="nature_reserve"];
  relation(area.a)["leisure"="nature_reserve"];
);
out center tags;
`;
  }

  if (category === "panorami") {
    return `
${header}
${area}
(
  node(area.a)["tourism"="viewpoint"];
  way(area.a)["tourism"="viewpoint"];
  relation(area.a)["tourism"="viewpoint"];

  node(area.a)["man_made"="tower"]["tourism"="attraction"];
  way(area.a)["man_made"="tower"]["tourism"="attraction"];
  relation(area.a)["man_made"="tower"]["tourism"="attraction"];

  node(area.a)["man_made"="observation_tower"];
  way(area.a)["man_made"="observation_tower"];
  relation(area.a)["man_made"="observation_tower"];
);
out center tags;
`;
  }

  if (category === "trekking") {
    // Evitiamo route=hiking (troppo grande). Prendiamo punti utili: guidepost/trailhead/Alpine huts
    return `
${header}
${area}
(
  node(area.a)["tourism"="information"]["information"="guidepost"];
  way(area.a)["tourism"="information"]["information"="guidepost"];
  relation(area.a)["tourism"="information"]["information"="guidepost"];

  node(area.a)["tourism"="information"]["information"="map"];
  node(area.a)["tourism"="information"]["information"="board"];

  node(area.a)["tourism"="alpine_hut"];
  way(area.a)["tourism"="alpine_hut"];
  relation(area.a)["tourism"="alpine_hut"];

  node(area.a)["amenity"="shelter"];
  way(area.a)["amenity"="shelter"];
  relation(area.a)["amenity"="shelter"];
);
out center tags;
`;
  }

  if (category === "family") {
    return `
${header}
${area}
(
  node(area.a)["leisure"="park"];
  way(area.a)["leisure"="park"];
  relation(area.a)["leisure"="park"];

  node(area.a)["leisure"="playground"];
  way(area.a)["leisure"="playground"];
  relation(area.a)["leisure"="playground"];

  node(area.a)["tourism"="theme_park"];
  way(area.a)["tourism"="theme_park"];
  relation(area.a)["tourism"="theme_park"];

  node(area.a)["tourism"="zoo"];
  way(area.a)["tourism"="zoo"];
  relation(area.a)["tourism"="zoo"];

  node(area.a)["tourism"="aquarium"];
  way(area.a)["tourism"="aquarium"];
  relation(area.a)["tourism"="aquarium"];
);
out center tags;
`;
  }

  if (category === "storia") {
    return `
${header}
${area}
(
  node(area.a)["historic"="castle"];
  way(area.a)["historic"="castle"];
  relation(area.a)["historic"="castle"];

  node(area.a)["historic"="ruins"];
  way(area.a)["historic"="ruins"];
  relation(area.a)["historic"="ruins"];

  node(area.a)["historic"="archaeological_site"];
  way(area.a)["historic"="archaeological_site"];
  relation(area.a)["historic"="archaeological_site"];

  node(area.a)["historic"="monument"];
  way(area.a)["historic"="monument"];
  relation(area.a)["historic"="monument"];

  node(area.a)["historic"="memorial"];
  way(area.a)["historic"="memorial"];
  relation(area.a)["historic"="memorial"];

  node(area.a)["historic"="citywalls"];
  node(area.a)["historic"="city_gate"];
  node(area.a)["historic"="fort"];
  way(area.a)["historic"="fort"];
  relation(area.a)["historic"="fort"];
);
out center tags;
`;
  }

  if (category === "montagna") {
    return `
${header}
${area}
(
  node(area.a)["natural"="peak"];
  node(area.a)["natural"="saddle"];

  node(area.a)["tourism"="alpine_hut"];
  way(area.a)["tourism"="alpine_hut"];
  relation(area.a)["tourism"="alpine_hut"];

  node(area.a)["tourism"="viewpoint"];
  // viewpoint anche in montagna: ok

  node(area.a)["amenity"="shelter"];
  way(area.a)["amenity"="shelter"];
  relation(area.a)["amenity"="shelter"];
);
out center tags;
`;
  }

  // citta
  return `
${header}
${area}
(
  node(area.a)["place"="city"];
  node(area.a)["place"="town"];
  node(area.a)["place"="suburb"];

  // anche attrazioni urbane (non musei qui, quelli rientrano in storia/panorami ecc.)
  node(area.a)["tourism"="attraction"]["name"];
  way(area.a)["tourism"="attraction"]["name"];
  relation(area.a)["tourism"="attraction"]["name"];
);
out center tags;
`;
}

// ---------------------- CATEGORY CLEANUP (rumori specifici) ----------------------
function isBorgoNoise(p) {
  const t = p.tags || {};
  const ts = Object.entries(t).map(([k,v]) => `${String(k).toLowerCase()}=${String(v).toLowerCase()}`).join(" ");
  const n = normName(p.name || "");

  if (ts.includes("tourism=museum")) return true;
  if (hasAny(n, ["museo","galleria","mostra","spazio espositivo"])) return true;

  if (hasAny(n, ["monte","cima","passo","rifugio","malga"])) return true;
  if (hasAny(ts, ["natural=peak","tourism=alpine_hut","amenity=shelter"])) return true;

  return false;
}

function isCittaNoise(p) {
  const t = p.tags || {};
  const pt = String(t.place || "").toLowerCase();
  const n = normName(p.name || "");

  // Evita robe “zona industriale” ecc.
  if (hasAny(n, ["zona industriale","area industriale","interporto"])) return true;

  // Suburb ok ma penalizzato in score, non filtrato.
  if (pt === "locality") return true;
  return false;
}

// ---------------------- SCORING ----------------------
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
  if (hasAny(n, ["degustaz","tasting","wine tour","wine tasting"])) s += 20;

  if (hasTag(t,"website") || hasTag(t,"contact:website")) s += 8;
  if (hasTag(t,"opening_hours")) s += 5;

  return s;
}

function scoreBorghi(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  const ts = Object.entries(t).map(([k,v]) => `${String(k).toLowerCase()}=${String(v).toLowerCase()}`).join(" ");
  let s = 0;

  if (ts.includes("place=village")) s += 55;
  if (ts.includes("place=hamlet")) s += 45;
  if (ts.includes("place=suburb")) s += 20;

  if (hasAny(n, ["borgo","centro storico","frazione","paese"])) s += 30;
  if (hasAny(ts, ["historic=castle","historic=citywalls","historic=city_gate"])) s += 15;

  if (hasTag(t,"wikipedia") || hasTag(t,"wikidata")) s += 10;
  if (hasTag(t,"website") || hasTag(t,"contact:website")) s += 6;

  if (ts.includes("tourism=attraction") && !hasAny(n, ["borgo","centro storico"]) && !hasAny(ts, ["place=village","place=hamlet"])) s -= 12;

  return s;
}

function scoreMare(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  let s = 0;

  if (tagEq(t,"natural","beach")) s += 80;
  if (tagEq(t,"tourism","beach_resort")) s += 60;
  if (tagEq(t,"leisure","marina")) s += 45;
  if (tagEq(t,"man_made","lighthouse")) s += 35;

  if (hasAny(n, ["spiaggia","lido","mare","baia","cala"])) s += 20;

  if (hasTag(t,"wikipedia") || hasTag(t,"wikidata")) s += 10;
  if (hasTag(t,"website") || hasTag(t,"contact:website")) s += 6;

  return s;
}

function scoreNatura(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  let s = 0;

  if (tagEq(t,"waterway","waterfall")) s += 85;
  if (tagEq(t,"natural","cave_entrance")) s += 70;
  if (tagEq(t,"natural","spring")) s += 55;
  if (tagEq(t,"natural","hot_spring")) s += 75;
  if (tagEq(t,"boundary","protected_area")) s += 45;
  if (tagEq(t,"leisure","nature_reserve")) s += 45;

  if (hasAny(n, ["cascata","grotte","grotta","sorgente","riserva","parco","oasi"])) s += 15;

  if (hasTag(t,"wikipedia") || hasTag(t,"wikidata")) s += 10;
  if (hasTag(t,"website") || hasTag(t,"contact:website")) s += 6;

  return s;
}

function scorePanorami(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  let s = 0;

  if (tagEq(t,"tourism","viewpoint")) s += 85;
  if (tagEq(t,"man_made","observation_tower")) s += 70;
  if (tagEq(t,"man_made","tower")) s += 45;

  if (hasAny(n, ["belvedere","panorama","vedetta","viewpoint"])) s += 15;

  if (hasTag(t,"wikipedia") || hasTag(t,"wikidata")) s += 10;

  return s;
}

function scoreTrekking(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  let s = 0;

  if (tagEq(t,"tourism","alpine_hut")) s += 80;
  if (tagEq(t,"amenity","shelter")) s += 60;
  if (tagEq(t,"tourism","information") && String(t.information||"").toLowerCase() === "guidepost") s += 65;
  if (tagEq(t,"tourism","information") && hasAny(String(t.information||"").toLowerCase(), ["map","board"])) s += 40;

  if (hasAny(n, ["sentiero","trek","trekking","escurs","rifugio"])) s += 15;

  if (hasTag(t,"wikipedia") || hasTag(t,"wikidata")) s += 8;

  return s;
}

function scoreFamily(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  let s = 0;

  if (tagEq(t,"leisure","playground")) s += 80;
  if (tagEq(t,"leisure","park")) s += 55;
  if (tagEq(t,"tourism","theme_park")) s += 85;
  if (tagEq(t,"tourism","zoo")) s += 75;
  if (tagEq(t,"tourism","aquarium")) s += 75;

  if (hasAny(n, ["parco","giochi","playground","zoo","acquario"])) s += 10;

  if (hasTag(t,"website") || hasTag(t,"contact:website")) s += 6;
  if (hasTag(t,"opening_hours")) s += 5;

  return s;
}

function scoreStoria(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  let s = 0;

  if (tagEq(t,"historic","castle")) s += 90;
  if (tagEq(t,"historic","archaeological_site")) s += 85;
  if (tagEq(t,"historic","ruins")) s += 70;
  if (tagEq(t,"historic","fort")) s += 75;
  if (tagEq(t,"historic","monument")) s += 60;
  if (tagEq(t,"historic","memorial")) s += 45;
  if (tagEq(t,"historic","citywalls")) s += 55;
  if (tagEq(t,"historic","city_gate")) s += 55;

  if (hasAny(n, ["castello","rocca","forte","mura","porta","anfiteatro","sito archeologico"])) s += 15;

  if (hasTag(t,"wikipedia") || hasTag(t,"wikidata")) s += 12;
  if (hasTag(t,"website") || hasTag(t,"contact:website")) s += 6;

  return s;
}

function scoreMontagna(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  let s = 0;

  if (tagEq(t,"natural","peak")) s += 80;
  if (tagEq(t,"tourism","alpine_hut")) s += 75;
  if (tagEq(t,"amenity","shelter")) s += 55;
  if (tagEq(t,"tourism","viewpoint")) s += 45;
  if (tagEq(t,"natural","saddle")) s += 35;

  if (hasAny(n, ["monte","cima","vetta","passo","rifugio","malga"])) s += 15;
  if (hasTag(t,"wikipedia") || hasTag(t,"wikidata")) s += 10;

  return s;
}

function scoreCitta(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  const pt = String(t.place || "").toLowerCase().trim();
  let s = 0;

  if (pt === "city") s += 85;
  else if (pt === "town") s += 70;
  else if (pt === "suburb") s += 35;

  // keywords “città”
  if (hasAny(n, ["centro","downtown","city"])) s += 6;

  // qualità info
  if (hasTag(t,"wikipedia") || hasTag(t,"wikidata")) s += 10;
  if (hasTag(t,"website") || hasTag(t,"contact:website")) s += 6;

  // penalizza attraction generica che non è un place
  const isAttraction = String(t.tourism || "").toLowerCase() === "attraction";
  if (isAttraction && !pt) s -= 10;

  return s;
}

function computeScore(category, p) {
  if (category === "relax") return scoreRelax(p);
  if (category === "cantine") return scoreCantine(p);
  if (category === "borghi") return scoreBorghi(p);
  if (category === "mare") return scoreMare(p);
  if (category === "natura") return scoreNatura(p);
  if (category === "panorami") return scorePanorami(p);
  if (category === "trekking") return scoreTrekking(p);
  if (category === "family") return scoreFamily(p);
  if (category === "storia") return scoreStoria(p);
  if (category === "montagna") return scoreMontagna(p);
  return scoreCitta(p);
}

function visibilityFromScore(score, category) {
  // “chicche” = top. Soglie tarate per categorie.
  const map = {
    borghi: 70,
    relax: 60,
    cantine: 60,
    mare: 65,
    natura: 65,
    panorami: 70,
    trekking: 65,
    family: 65,
    storia: 70,
    montagna: 65,
    citta: 70,
  };
  const cut = map[category] ?? 65;
  return score >= cut ? "chicca" : "classica";
}

// ---------------------- MAIN ----------------------
async function main() {
  console.log(`[BUILD] ${REGION_ID} • ${CATEGORY} • iso=${region.iso3166_2}`);

  let data;
  try {
    const q = buildQuery(CATEGORY, region.iso3166_2);
    data = await overpass(q, { retries: 9, timeoutMs: 180000 });
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

  let cleaned = raw;

  if (CATEGORY === "borghi") cleaned = raw.filter(p => !isBorgoNoise(p));
  if (CATEGORY === "citta") cleaned = raw.filter(p => !isCittaNoise(p));

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
