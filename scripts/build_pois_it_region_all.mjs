// scripts/build_pois_it_region_all.mjs
// Build POIs for ALL categories for ONE IT region via Overpass (safe + retry + CLEAN)
// Usage:
//   REGION_SLUG=piemonte REGION_ISO=IT-21 node scripts/build_pois_it_region_all.mjs
//
// Output files:
//   public/data/pois/it/<region_slug>/<category>.json
//   public/data/pois/it/<region_slug>/index.json

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const OUT_BASE = path.join(ROOT, "public", "data", "pois", "it");

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function nowIso() { return new Date().toISOString(); }

async function fetchWithTimeout(url, body, timeoutMs = 65000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body,
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json().catch(() => null);
    if (!j) throw new Error("Bad JSON");
    return j;
  } finally {
    clearTimeout(t);
  }
}
function opBody(q) { return `data=${encodeURIComponent(q)}`; }

async function runOverpass(query) {
  const body = opBody(query);
  let lastErr = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const j = await fetchWithTimeout(endpoint, body, 65000);
        return { ok: true, endpoint, json: j };
      } catch (e) {
        lastErr = e;
        await sleep(1200 * attempt);
      }
    }
  }
  return {
    ok: false,
    endpoint: "",
    json: null,
    error: String(lastErr?.message || lastErr),
  };
}

// ---------------------- NORMALIZE + FILTERS ----------------------
function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function hasAny(str, arr) {
  return arr.some((k) => str.includes(k));
}
function tagEq(tags, k, v) {
  return String(tags?.[k] ?? "").toLowerCase() === String(v).toLowerCase();
}
function hasTag(tags, k) {
  return tags?.[k] != null && String(tags[k]).trim() !== "";
}

function tagsToStr(tags) {
  const t = tags || {};
  return Object.entries(t)
    .map(([k, v]) => `${String(k).toLowerCase()}=${String(v).toLowerCase()}`)
    .join(" ");
}

function isClearlyIrrelevant(p) {
  const ts = tagsToStr(p.tags);
  const n = normName(p.name || "");

  // trasporti/strade
  if (hasAny(ts, ["highway=", "railway=", "public_transport=", "route=", "junction="])) return true;
  if (hasAny(ts, ["amenity=bus_station", "highway=bus_stop", "highway=platform"])) return true;

  // parking/fuel/charging
  if (hasAny(ts, ["amenity=parking", "amenity=parking_entrance", "amenity=parking_space", "highway=rest_area", "amenity=fuel", "amenity=charging_station"])) return true;

  // industrial/commercial/office
  if (hasAny(ts, ["landuse=industrial", "landuse=commercial", "building=industrial", "building=warehouse", "building=office", "man_made=works"])) return true;

  // rumore tecnico
  if (hasAny(ts, ["man_made=survey_point", "power=", "telecom=", "pipeline="])) return true;

  // nomi spazzatura
  if (hasAny(n, ["parcheggio", "stazione", "fermata", "svincolo", "uscita", "cabina", "impianto", "linea", "tratto", "km "])) return true;

  // “SpA azienda” (ma non spa benessere)
  const looksCompany = (n.endsWith(" spa") || n.includes(" s p a") || n.includes(" s.p.a") || n.includes(" azienda "));
  const looksWellness = hasAny(n, ["terme", "spa", "wellness", "termale", "thermal", "sauna", "hammam", "benessere"]);
  if (looksCompany && !looksWellness) return true;

  return false;
}

function hasQualitySignals(p) {
  const t = p.tags || {};
  return (
    hasTag(t, "wikipedia") ||
    hasTag(t, "wikidata") ||
    hasTag(t, "website") ||
    hasTag(t, "contact:website") ||
    hasTag(t, "opening_hours") ||
    hasTag(t, "phone") ||
    hasTag(t, "contact:phone")
  );
}

function hasTouristSignals(p) {
  const ts = tagsToStr(p.tags);
  const n = normName(p.name || "");

  // tag turistici frequenti
  const taggy =
    ts.includes("tourism=attraction") ||
    ts.includes("tourism=museum") ||
    ts.includes("tourism=viewpoint") ||
    ts.includes("tourism=information") ||
    ts.includes("historic=") ||
    ts.includes("heritage=") ||
    ts.includes("leisure=park") ||
    ts.includes("leisure=garden") ||
    ts.includes("boundary=national_park") ||
    ts.includes("leisure=nature_reserve") ||
    ts.includes("natural=waterfall") ||
    ts.includes("waterway=waterfall") ||
    ts.includes("natural=cave_entrance") ||
    ts.includes("natural=gorge");

  // parole “wow”
  const wowName = hasAny(n, [
    "centro storico", "borgo",
    "castello", "rocca", "forte", "torre",
    "abbazia", "duomo", "cattedrale", "santuario",
    "riserva", "oasi", "parco",
    "cascata", "gole", "belvedere", "panorama",
    "lago", "laghetto", "spiaggia", "baia", "cala",
    "rifugio", "passo", "cima"
  ]);

  return hasQualitySignals(p) || taggy || wowName;
}

// Relax: NO musei / NO "spazio" / NO roba culturale spacciata per spa
function isRelaxNoise(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  const ts = tagsToStr(t);

  if (ts.includes("tourism=museum")) return true;
  if (hasAny(ts, ["amenity=arts_centre", "amenity=theatre", "amenity=cinema", "amenity=library"])) return true;
  if (hasAny(n, ["museo", "mostra", "galleria", "spazio multimediale", "multimediale", "centro culturale", "auditorium"])) return true;

  // bug "spa" dentro "spazio"
  if (n.includes("spazio") && !hasAny(n, [" spa", "spa ", "terme", "wellness", "benessere"])) return true;

  const hasWellnessTag =
    tagEq(t, "tourism", "spa") ||
    tagEq(t, "leisure", "spa") ||
    tagEq(t, "amenity", "spa") ||
    tagEq(t, "amenity", "sauna") ||
    tagEq(t, "amenity", "public_bath") ||
    tagEq(t, "natural", "hot_spring") ||
    tagEq(t, "thermal", "yes") ||
    hasAny(ts, ["bath:type=thermal", "healthcare=spa"]);

  if (!hasWellnessTag && !hasAny(n, ["terme", "termale", "thermal", "wellness", "benessere", "hammam", "sauna"])) return true;

  return false;
}

// Borghi: solo settlement + segnali turistici (NO frazioni random senza nulla)
function isBorgoNoise(p) {
  const t = p.tags || {};
  const ts = tagsToStr(t);
  const n = normName(p.name || "");

  const place = String(t.place || "").toLowerCase();
  const hist = String(t.historic || "").toLowerCase();

  const isSettlement =
    ["hamlet", "village", "town", "city", "suburb"].includes(place) ||
    ["old_town", "city", "town", "village", "hamlet"].includes(hist) ||
    (String(t.boundary || "") === "administrative" && /^(8|9)$/.test(String(t.admin_level || "")));

  if (!isSettlement) return true;

  if (hasAny(n, ["monumento", "memorial", "statua", "lapide", "case sparse"])) return true;

  // castelli/abbazie singoli non sono borghi
  if (!hasAny(n, ["borgo", "centro storico", "paese", "frazione"]) && hasAny(ts, ["historic=castle", "historic=ruins", "historic=monument"])) {
    return true;
  }

  // REGOLA FORTE: un borgo deve avere qualche segnale turistico (quality/heritage/historic/tourism o parole)
  if (!hasTouristSignals(p)) return true;

  return false;
}

// Trekking: tag sensati o segnali forti (evita “sentiero X” senza nulla)
function isTrekkingNoise(p) {
  const t = p.tags || {};
  const ts = tagsToStr(t);
  const n = normName(p.name || "");

  const hasTrailSignals =
    ts.includes("route=hiking") ||
    ts.includes("route=foot") ||
    ts.includes("highway=path") ||
    ts.includes("highway=footway") ||
    ts.includes("highway=track") ||
    ts.includes("sac_scale=") ||
    ts.includes("trail_visibility=") ||
    ts.includes("information=guidepost") ||
    ts.includes("tourism=alpine_hut") ||
    ts.includes("amenity=shelter");

  // se ha SOLO nome generico e niente segnale, buttalo
  if (!hasTrailSignals && !hasAny(n, ["sentiero", "trail", "anello", "cai", "via ferrata", "rifugio"])) return true;

  // serve almeno qualità o trail signals
  if (!hasQualitySignals(p) && !hasTrailSignals) return true;

  return false;
}

// Family: evita roba micro (playground senza nome, parchi generici senza qualità)
function isFamilyNoise(p) {
  const t = p.tags || {};
  const ts = tagsToStr(t);
  const n = normName(p.name || "");

  // se è park/garden ma senza qualità e senza nome “forte”, scarta
  if ((ts.includes("leisure=park") || ts.includes("leisure=garden")) && !hasQualitySignals(p) && !hasAny(n, ["parco", "giardino"])) {
    return true;
  }

  // scarta cose senza nome
  if (!String(p.name || "").trim()) return true;

  return false;
}

function overpassAreaSelectorByISO(iso3166_2) {
  return `area["ISO3166-2"="${iso3166_2}"]["boundary"="administrative"]->.a;`;
}

// ---------------------- QUERIES ----------------------
// Fix principale: "spa" con confini (NO spazio). Overpass regex: (^|\\W)spa(\\W|$)
function buildQuery(category, iso3166_2) {
  const header = `[out:json][timeout:260];`;
  const area = overpassAreaSelectorByISO(iso3166_2);

  if (category === "relax") {
    return `
${header}
${area}
(
  // tags veri
  nwr(area.a)["tourism"="spa"];
  nwr(area.a)["leisure"="spa"];
  nwr(area.a)["amenity"="spa"];
  nwr(area.a)["amenity"="sauna"];
  nwr(area.a)["amenity"="public_bath"];
  nwr(area.a)["natural"="hot_spring"];
  nwr(area.a)["thermal"="yes"];
  nwr(area.a)["healthcare"="spa"];

  // nomi (con confini di parola): NO "spazio"
  nwr(area.a)["name"~"terme|termal|thermal|wellness|benessere|hammam|sauna",i];
  nwr(area.a)["name"~"(^|\\\\W)spa(\\\\W|$)",i];
);
out tags center;
`;
  }

  if (category === "family") {
    return `
${header}
${area}
(
  // family strong
  nwr(area.a)["tourism"="theme_park"];
  nwr(area.a)["leisure"="water_park"];
  nwr(area.a)["tourism"="zoo"];
  nwr(area.a)["tourism"="aquarium"];
  nwr(area.a)["leisure"="adventure_park"];

  // attrazioni family nominate
  nwr(area.a)["tourism"="attraction"]["name"~"parco\\\\s?avventura|zip\\\\s?line|safari|fattoria\\\\s?didattica|parco\\\\s?faunistico|parco\\\\s?divertimenti|lunapark|luna\\\\s?park|giostre|acquapark|aqua\\\\s?park|minigolf|go\\\\s?kart|kart",i];

  // musei kids/scienza/planetari
  nwr(area.a)["tourism"="museum"]["name"~"bambin|bambini|kids|children|science\\\\s?center|planetari|planetarium|museo\\\\s?dei\\\\s?bambini",i];
);
out tags center;
`;
  }

  if (category === "cantine") {
    return `
${header}
${area}
(
  nwr(area.a)["craft"="winery"];
  nwr(area.a)["shop"="wine"];
  nwr(area.a)["amenity"="wine_bar"];
  nwr(area.a)["tourism"="attraction"]["name"~"cantina|enoteca|degust",i];
);
out tags center;
`;
  }

  if (category === "borghi") {
    return `
${header}
${area}
(
  nwr(area.a)["place"~"^(hamlet|village|town|city|suburb)$"]["name"];
  nwr(area.a)["historic"~"^(old_town|village|town|city|hamlet)$"]["name"];
  nwr(area.a)["boundary"="administrative"]["admin_level"~"^(8|9)$"]["name"];
);
out tags center;
`;
  }

  if (category === "mare") {
    return `
${header}
${area}
(
  nwr(area.a)["natural"="beach"];
  nwr(area.a)["natural"="coastline"];
  nwr(area.a)["natural"="bay"];
  nwr(area.a)["tourism"="beach_resort"];
  nwr(area.a)["leisure"="marina"];
  nwr(area.a)["man_made"="pier"];
  nwr(area.a)["man_made"="lighthouse"];
);
out tags center;
`;
  }

  if (category === "lago") {
    return `
${header}
${area}
(
  // laghi e bacini
  nwr(area.a)["water"="lake"];
  nwr(area.a)["natural"="water"]["water"="lake"];
  nwr(area.a)["water"="reservoir"];
  nwr(area.a)["landuse"="reservoir"];

  // segnali turistici legati al lago
  nwr(area.a)["leisure"="swimming_area"];
  nwr(area.a)["amenity"="boat_rental"];
  nwr(area.a)["leisure"="marina"];
  nwr(area.a)["tourism"="camp_site"];
  nwr(area.a)["tourism"="picnic_site"];
);
out tags center;
`;
  }

  if (category === "natura") {
    return `
${header}
${area}
(
  // cascate (tag corretti)
  nwr(area.a)["natural"="waterfall"];
  nwr(area.a)["waterway"="waterfall"];

  // grotte / gole / sorgenti
  nwr(area.a)["natural"="cave_entrance"];
  nwr(area.a)["natural"="gorge"];
  nwr(area.a)["natural"="spring"];
  nwr(area.a)["natural"="hot_spring"];

  // parchi / riserve / aree protette
  nwr(area.a)["boundary"="national_park"];
  nwr(area.a)["boundary"="protected_area"];
  nwr(area.a)["leisure"="nature_reserve"];

  // spot nominati "oasi/riserva/parco"
  nwr(area.a)["tourism"="attraction"]["name"~"riserva|oasi|parco|cascat|gole|grotta",i];
);
out tags center;
`;
  }

  if (category === "trekking") {
    return `
${header}
${area}
(
  // segnali trekking veri
  nwr(area.a)["route"="hiking"];
  nwr(area.a)["route"="foot"];
  nwr(area.a)["sac_scale"];
  nwr(area.a)["trail_visibility"];

  // sentieri e percorsi
  nwr(area.a)["highway"="path"];
  nwr(area.a)["highway"="footway"];

  // guidepost / rifugi / shelter
  nwr(area.a)["tourism"="information"]["information"="guidepost"];
  nwr(area.a)["tourism"="alpine_hut"];
  nwr(area.a)["amenity"="shelter"];

  // nomi tipici (aiuta tantissimo)
  nwr(area.a)["name"~"sentiero|trail|trek|trekking|via\\\\s?ferrata|ferrata|rifugio|anello|cai",i];
);
out tags center;
`;
  }

  if (category === "storia") {
    return `
${header}
${area}
(
  nwr(area.a)["historic"="castle"];
  nwr(area.a)["historic"="ruins"];
  nwr(area.a)["historic"="archaeological_site"];
  nwr(area.a)["historic"="fort"];
  nwr(area.a)["historic"="monument"];
  nwr(area.a)["historic"="memorial"];
  nwr(area.a)["historic"="citywalls"];
  nwr(area.a)["tourism"="museum"];
  nwr(area.a)["heritage"];
);
out tags center;
`;
  }

  if (category === "montagna") {
    return `
${header}
${area}
(
  nwr(area.a)["natural"="peak"];
  nwr(area.a)["natural"="saddle"];
  nwr(area.a)["mountain_pass"];
  nwr(area.a)["natural"="valley"];

  nwr(area.a)["tourism"="alpine_hut"];
  nwr(area.a)["amenity"="shelter"];

  nwr(area.a)["aerialway"];
  nwr(area.a)["piste:type"];
  nwr(area.a)["sport"="skiing"];

  nwr(area.a)["tourism"="viewpoint"];
  nwr(area.a)["name"~"monte|cima|passo|rifugio|malga|alpe|valico",i];
);
out tags center;
`;
  }

  throw new Error(`Unknown category "${category}"`);
}

// ---------------------- MAP + DEDUP ----------------------
function mapElToPlace(el, catKey, regionSlug, regionIso) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    id: `poi_${catKey}_${regionSlug}_${el.type}_${el.id}`,
    name: String(name).trim(),
    lat,
    lon,
    type: catKey,
    primary_category: catKey,
    visibility: "classica",
    score: 0,
    tags: Object.entries(tags).slice(0, 70).map(([k, v]) => `${k}=${v}`),
    country: "IT",
    area: regionSlug,
    region_iso: regionIso,
    source: "overpass_region_build",
    live: false,
  };
}

function dedup(places) {
  const seen = new Set();
  const out = [];
  for (const p of places) {
    const k = `${normName(p.name)}_${String(p.lat).slice(0, 6)}_${String(p.lon).slice(0, 6)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

// ---------------------- SCORING ----------------------
function tagsArrToObj(tagsArr) {
  const o = {};
  for (const x of (tagsArr || [])) {
    const i = x.indexOf("=");
    if (i <= 0) continue;
    const k = x.slice(0, i);
    const v = x.slice(i + 1);
    o[k] = v;
  }
  return o;
}

function scoreFor(category, p) {
  const t = tagsArrToObj(p.tags || []);
  const ts = tagsToStr(t);
  const n = normName(p.name || "");
  let s = 0;

  // qualità info (vale per tutti)
  if (t.wikipedia) s += 28;
  if (t.wikidata) s += 22;
  if (t.website || t["contact:website"]) s += 18;
  if (t.opening_hours) s += 10;
  if (t.phone || t["contact:phone"]) s += 8;

  // bonus turismo/historic
  if (t.tourism === "attraction") s += 18;
  if (t.tourism === "museum") s += 16;
  if (t.tourism === "viewpoint") s += 14;
  if (t.historic) s += 14;
  if (t.heritage) s += 10;

  if (category === "relax") {
    if (t.natural === "hot_spring") s += 95;
    if (t.amenity === "public_bath") s += 80;
    if (t.amenity === "sauna") s += 70;
    if (t.tourism === "spa" || t.leisure === "spa" || t.amenity === "spa") s += 75;
    if (t.thermal === "yes") s += 40;
    if (hasAny(n, ["terme", "termale", "thermal"])) s += 30;
    if (hasAny(n, ["wellness", "benessere", "hammam"])) s += 18;
  }

  if (category === "family") {
    if (t.tourism === "theme_park") s += 95;
    if (t.leisure === "water_park") s += 90;
    if (t.leisure === "adventure_park") s += 85;
    if (t.tourism === "zoo" || t.tourism === "aquarium") s += 82;
    if (t.tourism === "museum") s += 50;
    if (hasAny(n, ["parco avventura", "zip line", "safari", "fattoria didattica", "lunapark", "acquapark", "minigolf", "kart"])) s += 28;
  }

  if (category === "borghi") {
    if (hasAny(n, ["borgo", "centro storico", "paese", "frazione"])) s += 35;
    if (hasAny(n, ["case sparse"])) s -= 55;
    if (hasAny(n, ["monumento", "statua", "lapide"])) s -= 55;
    if (hasTouristSignals(p)) s += 25;
  }

  if (category === "natura") {
    if (t.natural === "waterfall" || t.waterway === "waterfall") s += 70;
    if (t.natural === "cave_entrance") s += 58;
    if (t.natural === "gorge") s += 58;
    if (t.boundary === "national_park" || t.boundary === "protected_area") s += 45;
    if (t.leisure === "nature_reserve") s += 45;
  }

  if (category === "trekking") {
    if (t.route === "hiking" || t.route === "foot") s += 40;
    if (t.sac_scale) s += 30;
    if (t.trail_visibility) s += 18;
    if (t.highway === "path" || t.highway === "footway") s += 12;
    if (t.tourism === "alpine_hut") s += 55;
    if (t.amenity === "shelter") s += 35;
    if (t.information === "guidepost") s += 45;
    if (hasAny(n, ["sentiero", "trail", "anello", "cai", "via ferrata", "rifugio"])) s += 16;
  }

  if (category === "montagna") {
    if (t.natural === "peak") s += 60;
    if (t.tourism === "alpine_hut") s += 55;
    if (t.amenity === "shelter") s += 35;
    if (t.aerialway) s += 25;
    if (t["piste:type"] || t.sport === "skiing") s += 30;
    if (hasAny(n, ["monte", "cima", "passo", "rifugio", "malga", "alpe", "valico"])) s += 18;
  }

  if (category === "lago") {
    if (t.water === "lake") s += 70;
    if (t.natural === "water" && t.water === "lake") s += 60;
    if (t.water === "reservoir" || t.landuse === "reservoir") s += 38;
    if (t.leisure === "swimming_area") s += 30;
    if (t.amenity === "boat_rental") s += 25;
    if (hasAny(n, ["lago", "laghetto", "laguna"])) s += 18;
  }

  if (category === "mare") {
    if (t.natural === "beach") s += 75;
    if (t.tourism === "beach_resort") s += 55;
    if (t.leisure === "marina") s += 35;
    if (t["man_made"] === "lighthouse" || t["man_made"] === "pier") s += 25;
    if (hasAny(n, ["spiaggia", "baia", "cala", "lido", "scogliera", "lungomare"])) s += 18;
  }

  if (category === "storia") {
    if (t.historic === "castle") s += 75;
    if (t.historic === "fort") s += 65;
    if (t.historic === "archaeological_site") s += 72;
    if (t.historic === "ruins") s += 58;
    if (t.tourism === "museum") s += 55;
  }

  // penalità generiche
  if (hasAny(n, ["parcheggio", "stazione", "svincolo"])) s -= 60;

  // se non ha nessun segnale turistico e non è category “forte”, penalizza
  if (!hasTouristSignals(p) && !["trekking", "montagna", "natura"].includes(category)) s -= 25;

  return s;
}

function visibilityFromScore(score, category) {
  const cut = {
    relax: 85,
    family: 85,
    borghi: 55,
    cantine: 70,
    mare: 75,
    lago: 70,
    natura: 70,
    trekking: 70,
    storia: 75,
    montagna: 70,
  }[category] ?? 70;

  return score >= cut ? "chicca" : "classica";
}

// ---------------------- MAIN ----------------------
const CATEGORIES = [
  "montagna",
  "mare",
  "lago",
  "relax",
  "cantine",
  "family",
  "borghi",
  "storia",
  "natura",
  "trekking",
];

async function main() {
  const regionSlug = String(process.env.REGION_SLUG || "").trim().toLowerCase();
  const regionIso = String(process.env.REGION_ISO || "").trim().toUpperCase();

  if (!regionSlug || !regionIso) {
    console.error("Missing REGION_SLUG or REGION_ISO. Example: REGION_SLUG=piemonte REGION_ISO=IT-21");
    process.exit(1);
  }

  const outDir = path.join(OUT_BASE, regionSlug);
  ensureDir(outDir);

  const index = {
    meta: {
      built_at: nowIso(),
      region_slug: regionSlug,
      region_iso: regionIso,
      categories: CATEGORIES,
    },
    counts: {},
    files: [],
  };

  for (const catKey of CATEGORIES) {
    console.log(`🛰️ ${regionSlug} (${regionIso}) -> ${catKey}`);

    let q;
    try {
      q = buildQuery(catKey, regionIso);
    } catch (e) {
      console.log(`❌ ${catKey} query error: ${String(e?.message || e)}`);
      index.counts[catKey] = 0;
      index.files.push({ category: catKey, path: `/data/pois/it/${regionSlug}/${catKey}.json`, count: 0, ok: false });
      continue;
    }

    const r = await runOverpass(q);

    if (!r.ok || !r.json) {
      console.log(`❌ ${catKey} failed: ${r.error || "unknown"}`);
      index.counts[catKey] = 0;
      index.files.push({ category: catKey, path: `/data/pois/it/${regionSlug}/${catKey}.json`, count: 0, ok: false });

      fs.writeFileSync(
        path.join(outDir, `${catKey}.json`),
        JSON.stringify({
          meta: { built_at: nowIso(), region_slug: regionSlug, region_iso: regionIso, category: catKey, ok: false, error: r.error || "overpass_failed" },
          places: [],
        }),
        "utf8"
      );
      continue;
    }

    const els = Array.isArray(r.json.elements) ? r.json.elements : [];
    let mapped = dedup(els.map((el) => mapElToPlace(el, catKey, regionSlug, regionIso)).filter(Boolean));

    // filtri globali
    mapped = mapped.filter((p) => !isClearlyIrrelevant(p));

    // filtri specifici
    if (catKey === "relax") mapped = mapped.filter((p) => !isRelaxNoise(p));
    if (catKey === "borghi") mapped = mapped.filter((p) => !isBorgoNoise(p));
    if (catKey === "trekking") mapped = mapped.filter((p) => !isTrekkingNoise(p));
    if (catKey === "family") mapped = mapped.filter((p) => !isFamilyNoise(p));

    // scoring + visibility
    mapped = mapped
      .map((p) => {
        const sc = scoreFor(catKey, p);
        return { ...p, score: sc, visibility: visibilityFromScore(sc, catKey) };
      })
      .sort((a, b) => (b.score - a.score))
      .slice(0, 12000);

    const meta = {
      built_at: nowIso(),
      region_slug: regionSlug,
      region_iso: regionIso,
      category: catKey,
      endpoint: r.endpoint,
      count: mapped.length,
      ok: true,
    };

    fs.writeFileSync(path.join(outDir, `${catKey}.json`), JSON.stringify({ meta, places: mapped }, null, 0), "utf8");

    index.counts[catKey] = mapped.length;
    index.files.push({ category: catKey, path: `/data/pois/it/${regionSlug}/${catKey}.json`, count: mapped.length, ok: true });

    console.log(`✅ ${catKey}: ${mapped.length}`);
    await sleep(650);
  }

  fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify(index), "utf8");
  console.log(`🎉 DONE index -> public/data/pois/it/${regionSlug}/index.json`);
}

main().catch((e) => {
  console.error("❌ build failed:", e);
  process.exit(1);
});
