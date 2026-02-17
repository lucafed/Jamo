// scripts/build_pois_it_region_all.mjs
// Build POIs for ALL categories for ONE IT region via Overpass (safe + retry)
// Usage:
//   REGION_SLUG=veneto REGION_ISO=IT-34 node scripts/build_pois_it_region_all.mjs
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
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

function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function hasAny(str, arr) {
  for (const k of arr) if (str.includes(k)) return true;
  return false;
}
function hasTag(tags, k) { return tags?.[k] != null && String(tags[k]).trim() !== ""; }
function tagEq(tags, k, v) { return String(tags?.[k] ?? "").toLowerCase() === String(v).toLowerCase(); }

function tagsToStr(tags) {
  if (!tags) return "";
  return Object.entries(tags)
    .map(([k,v]) => `${String(k).toLowerCase()}=${String(v).toLowerCase()}`)
    .join(" ");
}

function isCompanySpaNoise(nameNorm) {
  // evita SPA (società per azioni), non spa/benessere
  // es: "ABC S.p.A.", "XYZ Spa"
  const looksCompany =
    nameNorm.endsWith(" spa") ||
    nameNorm.includes(" s p a") ||
    nameNorm.includes(" s.p.a") ||
    nameNorm.includes(" societa per azioni") ||
    nameNorm.includes(" azienda ") ||
    nameNorm.includes(" srl") ||
    nameNorm.includes(" s.n.c") ||
    nameNorm.includes(" snc") ||
    nameNorm.includes(" s a s") ||
    nameNorm.includes(" sas") ||
    nameNorm.includes(" coop") ||
    nameNorm.includes(" consorzio");

  const looksWellness = hasAny(nameNorm, ["terme","termale","thermal","spa","wellness","benessere","sauna","hammam","hamam"]);
  return looksCompany && !looksWellness;
}

function isClearlyIrrelevantGlobal(place) {
  const tags = place.tagsRaw || {};
  const ts = place.tagsStr || "";
  const n = place.nameNorm || "";

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
  if (hasAny(n, ["parcheggio","stazione","fermata","svincolo","uscita","cabina","impianto","linea","tratto","km "])) return true;

  // aziende "SpA" (non spa)
  if (isCompanySpaNoise(n)) return true;

  return false;
}

function dedup(places) {
  const seen = new Set();
  const out = [];
  for (const p of places) {
    const k = `${p.nameNorm}|${Number(p.lat).toFixed(5)}|${Number(p.lon).toFixed(5)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

function mapElToPlace(el, catKey, regionSlug, regionIso) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  // taglist più ricca (ma compatta)
  const tagList = [];
  const pushKV = (k) => { if (tags[k] != null) tagList.push(`${k}=${tags[k]}`); };
  [
    "tourism","leisure","amenity","historic","natural","sport","information","place","boundary",
    "aerialway","water","waterway","man_made","heritage","website","contact:website","opening_hours","wikidata","wikipedia"
  ].forEach(pushKV);

  const nm = String(name).trim();
  const nameNorm = normName(nm);
  const tagsStr = tagsToStr(tags);

  return {
    id: `poi_${catKey}_${regionSlug}_${el.type}_${el.id}`,
    name: nm,
    nameNorm,
    lat,
    lon,
    type: catKey,
    primary_category: catKey,
    visibility: "classica",       // verrà ricalcolata
    beauty_score: 0.72,           // verrà migliorata via score
    tags: Array.from(new Set(tagList)).slice(0, 26),
    tagsRaw: tags,
    tagsStr,
    country: "IT",
    area: regionSlug,
    region_iso: regionIso,
    source: "overpass_region_build",
    live: false,
  };
}

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
        await sleep(1100 * attempt);
      }
    }
  }
  return { ok: false, endpoint: "", json: null, error: String(lastErr?.message || lastErr) };
}

// ------------------- CATEGORIES (region-scoped) -------------------
// Qui NON includiamo borghi/citta (enormi). Qui POI utili e "wow visitabili".
const CATEGORIES = {
  family: `
(
  nwr["tourism"="theme_park"](area.R);
  nwr["leisure"="water_park"](area.R);
  nwr["tourism"="zoo"](area.R);
  nwr["tourism"="aquarium"](area.R);

  nwr["tourism"="attraction"]["name"~"parco\\s?avventura|avventura|zip\\s?line|safari|fattoria\\s?didattica|parco\\s?faunistico|giostre|lunapark|luna\\s?park|parco\\s?divertimenti|acquapark|aqua\\s?park|water\\s?park",i](area.R);

  nwr["tourism"="museum"]["name"~"bambin|bambini|kids|children|museo\\s?dei\\s?bambini|science\\s?center|planetari|planetarium",i](area.R);
  nwr["tourism"="attraction"]["name"~"bambin|bambini|kids|children|science\\s?center|planetari|planetarium",i](area.R);

  nwr["leisure"="playground"]["name"](area.R);
);
`,

  viewpoints: `
(
  nwr["tourism"="viewpoint"](area.R);
  nwr["name"~"belvedere|panoram|viewpoint|scenic|terrazza|vista",i](area.R);
);
`,

  hiking: `
(
  nwr["information"="guidepost"](area.R);
  nwr["amenity"="shelter"](area.R);
  nwr["tourism"="alpine_hut"](area.R);
  nwr["name"~"sentiero|trail|trek|trekking|hike|hiking|via\\s?ferrata|rifugio|anello",i](area.R);
);
`,

  mare: `
(
  nwr["natural"="beach"](area.R);
  nwr["tourism"="beach_resort"](area.R);
  nwr["man_made"="lighthouse"](area.R);
  nwr["natural"="bay"](area.R);
  nwr["tourism"="viewpoint"]["name"~"mare|spiaggia|beach|costa|coast|lido|scogliera|baia|cala",i](area.R);
  // marina è rumorosa: la teniamo, ma poi filtriamo duro sotto
  nwr["leisure"="marina"](area.R);
);
`,

  natura: `
(
  nwr["natural"="waterfall"](area.R);
  nwr["waterway"="waterfall"](area.R);
  nwr["natural"="spring"](area.R);
  nwr["boundary"="national_park"](area.R);
  nwr["leisure"="nature_reserve"](area.R);
  nwr["natural"="cave_entrance"](area.R);
  // tolto peak da Natura: i picchi vanno in Montagna (meno rumore)
);
`,

  storia: `
(
  nwr["historic"="castle"](area.R);
  nwr["historic"="ruins"](area.R);
  nwr["historic"="archaeological_site"](area.R);
  nwr["tourism"="museum"](area.R);
  nwr["historic"="monument"](area.R);
  nwr["historic"="memorial"](area.R);
);
`,

  montagna: `
(
  nwr["natural"="peak"](area.R);
  nwr["natural"="saddle"](area.R);
  nwr["tourism"="viewpoint"](area.R);
  nwr["amenity"="shelter"](area.R);
  nwr["tourism"="alpine_hut"](area.R);
  nwr["aerialway"](area.R);
  nwr["name"~"rifugio|cima|vetta|passo\\s|funivia|seggiovia|ski|pista",i](area.R);
);
`,

  relax: `
(
  nwr["tourism"="spa"](area.R);
  nwr["amenity"="spa"](area.R);
  nwr["leisure"="spa"](area.R);

  nwr["amenity"="public_bath"](area.R);
  nwr["amenity"="sauna"](area.R);

  nwr["natural"="hot_spring"](area.R);
  nwr["bath:type"="thermal"](area.R);
  nwr["thermal"="yes"](area.R);

  // name match è utile ma rumoroso: lo teniamo, poi filtriamo duro
  nwr["name"~"terme|termale|thermal|spa|wellness|benessere|sauna|hammam|hamam",i](area.R);
);
`,
};

// Query wrapper (region area by ISO3166-2)
function buildQuery(regionIso, catKey) {
  return `
[out:json][timeout:160];
area["ISO3166-2"="${regionIso}"]->.R;
${CATEGORIES[catKey]}
out tags center;
`.trim();
}

// ---------------------- CATEGORY FILTERS + SCORE ----------------------
function scoreAndFilter(cat, p) {
  const t = p.tagsRaw || {};
  const ts = p.tagsStr || "";
  const n = p.nameNorm || "";

  // global garbage
  if (isClearlyIrrelevantGlobal(p)) return null;

  // helper signals
  const hasQuality =
    hasTag(t, "wikipedia") || hasTag(t, "wikidata") ||
    hasTag(t, "website") || hasTag(t, "contact:website") ||
    hasTag(t, "opening_hours");

  // -------------------------------- RELAX --------------------------------
  if (cat === "relax") {
    const strong =
      tagEq(t, "tourism", "spa") ||
      tagEq(t, "amenity", "spa") ||
      tagEq(t, "leisure", "spa") ||
      tagEq(t, "amenity", "public_bath") ||
      tagEq(t, "amenity", "sauna") ||
      tagEq(t, "natural", "hot_spring") ||
      tagEq(t, "bath:type", "thermal") ||
      tagEq(t, "thermal", "yes");

    const nameLooks = hasAny(n, ["terme","termale","thermal","spa","wellness","benessere","sauna","hammam","hamam"]);

    // escludi sanità/cliniche/centri medici
    if (hasAny(ts, ["amenity=hospital","amenity=clinic","healthcare="])) return null;
    // escludi aziende “SpA”
    if (isCompanySpaNoise(n)) return null;

    // deve essere davvero relax: strong tag O nameLooks + un segnale qualità
    if (!strong && !(nameLooks && hasQuality)) return null;

    let s = 0;
    if (tagEq(t,"natural","hot_spring")) s += 90;
    if (tagEq(t,"bath:type","thermal") || tagEq(t,"thermal","yes")) s += 70;
    if (tagEq(t,"amenity","public_bath")) s += 65;
    if (tagEq(t,"tourism","spa") || tagEq(t,"amenity","spa") || tagEq(t,"leisure","spa")) s += 60;
    if (tagEq(t,"amenity","sauna")) s += 45;

    if (hasAny(n, ["terme","termale","thermal"])) s += 25;
    if (hasAny(n, ["spa","wellness","benessere"])) s += 15;

    if (hasQuality) s += 10;
    if (hasTag(t,"phone") || hasTag(t,"contact:phone")) s += 3;

    return { ...p, score: s, beauty_score: 0.70 + Math.min(0.25, s/400), visibility: (s >= 70 ? "chicca" : "classica") };
  }

  // -------------------------------- MARE --------------------------------
  if (cat === "mare") {
    const isBeach = tagEq(t,"natural","beach") || tagEq(t,"tourism","beach_resort");
    const isLighthouse = tagEq(t,"man_made","lighthouse");
    const isBay = tagEq(t,"natural","bay");
    const isMarina = tagEq(t,"leisure","marina");

    // marina è spesso rumore: tienila solo se nome “porto turistico” o segnali qualità
    if (isMarina && !(hasAny(n, ["porto","porticciolo","marina","darsena"]) && (hasQuality || hasAny(ts, ["tourism=", "amenity=restaurant", "amenity=bar"])))) {
      return null;
    }

    const nameSea = hasAny(n, ["spiaggia","lido","baia","cala","scogliera","lungomare","beach","costa","coast"]);
    if (!isBeach && !isLighthouse && !isBay && !nameSea && !hasAny(ts, ["tourism=viewpoint"])) return null;

    let s = 0;
    if (isBeach) s += 85;
    if (tagEq(t,"tourism","beach_resort")) s += 20;
    if (isBay) s += 45;
    if (isLighthouse) s += 50;
    if (hasAny(ts, ["tourism=viewpoint"])) s += 30;
    if (nameSea) s += 20;
    if (hasQuality) s += 10;

    return { ...p, score: s, beauty_score: 0.70 + Math.min(0.25, s/380), visibility: (s >= 75 ? "chicca" : "classica") };
  }

  // -------------------------------- NATURA --------------------------------
  if (cat === "natura") {
    // evita roba “tecnica” acqua/impianti
    if (hasAny(ts, ["man_made=works","power=","waterway=canal","waterway=ditch","pipeline="])) return null;

    const strong =
      tagEq(t,"natural","waterfall") || tagEq(t,"waterway","waterfall") ||
      tagEq(t,"natural","cave_entrance") ||
      tagEq(t,"natural","spring") ||
      tagEq(t,"boundary","national_park") ||
      tagEq(t,"leisure","nature_reserve");

    if (!strong) return null;

    let s = 0;
    if (tagEq(t,"natural","waterfall") || tagEq(t,"waterway","waterfall")) s += 90;
    if (tagEq(t,"natural","cave_entrance")) s += 75;
    if (tagEq(t,"natural","spring")) s += 55;
    if (tagEq(t,"boundary","national_park")) s += 60;
    if (tagEq(t,"leisure","nature_reserve")) s += 55;
    if (hasAny(n, ["cascata","grotta","grotte","sorgente","parco","riserva","oasi","forra","gola"])) s += 15;
    if (hasQuality) s += 10;

    return { ...p, score: s, beauty_score: 0.70 + Math.min(0.25, s/420), visibility: (s >= 75 ? "chicca" : "classica") };
  }

  // -------------------------------- STORIA --------------------------------
  if (cat === "storia") {
    // musei generici senza segnali (troppo rumore) -> fuori
    if (tagEq(t,"tourism","museum") && !hasQuality && !hasAny(n, ["museo","castello","rocca","forte","abbazia","duomo","cattedrale","anfiteatro","archeologic"])) {
      return null;
    }

    const strong =
      hasAny(ts, ["historic=castle","historic=ruins","historic=archaeological_site","historic=monument","historic=memorial"]) ||
      tagEq(t,"tourism","museum");

    if (!strong) return null;

    let s = 0;
    if (tagEq(t,"historic","castle")) s += 90;
    if (tagEq(t,"historic","archaeological_site")) s += 85;
    if (tagEq(t,"historic","ruins")) s += 70;
    if (tagEq(t,"historic","monument")) s += 60;
    if (tagEq(t,"historic","memorial")) s += 40;
    if (tagEq(t,"tourism","museum")) s += 55;
    if (hasAny(n, ["castello","rocca","forte","abbazia","duomo","cattedrale","mura","porta","anfiteatro","archeologic"])) s += 15;
    if (hasQuality) s += 12;

    return { ...p, score: s, beauty_score: 0.70 + Math.min(0.25, s/420), visibility: (s >= 78 ? "chicca" : "classica") };
  }

  // -------------------------------- MONTAGNA --------------------------------
  if (cat === "montagna") {
    const strong =
      tagEq(t,"natural","peak") ||
      tagEq(t,"tourism","alpine_hut") ||
      tagEq(t,"amenity","shelter") ||
      hasAny(ts, ["aerialway="]) ||
      tagEq(t,"natural","saddle") ||
      tagEq(t,"tourism","viewpoint");

    if (!strong) return null;

    let s = 0;
    if (tagEq(t,"natural","peak")) s += 80;
    if (tagEq(t,"tourism","alpine_hut")) s += 75;
    if (tagEq(t,"amenity","shelter")) s += 55;
    if (hasAny(ts, ["aerialway="])) s += 45;
    if (tagEq(t,"tourism","viewpoint")) s += 40;
    if (tagEq(t,"natural","saddle")) s += 30;
    if (hasAny(n, ["monte","cima","vetta","passo","rifugio","malga","alpe"])) s += 15;
    if (hasQuality) s += 10;

    return { ...p, score: s, beauty_score: 0.70 + Math.min(0.25, s/420), visibility: (s >= 75 ? "chicca" : "classica") };
  }

  // -------------------------------- HIKING --------------------------------
  if (cat === "hiking") {
    const strong =
      tagEq(t,"information","guidepost") ||
      tagEq(t,"tourism","alpine_hut") ||
      tagEq(t,"amenity","shelter") ||
      hasAny(n, ["sentiero","trail","trek","trekking","via ferrata","anello","rifugio"]);

    if (!strong) return null;

    let s = 0;
    if (tagEq(t,"information","guidepost")) s += 70;
    if (tagEq(t,"tourism","alpine_hut")) s += 70;
    if (tagEq(t,"amenity","shelter")) s += 55;
    if (hasAny(n, ["via ferrata"])) s += 35;
    if (hasAny(n, ["sentiero","trail","trek","trekking","anello"])) s += 20;
    if (hasQuality) s += 8;

    return { ...p, score: s, beauty_score: 0.70 + Math.min(0.25, s/420), visibility: (s >= 72 ? "chicca" : "classica") };
  }

  // -------------------------------- VIEWPOINTS --------------------------------
  if (cat === "viewpoints") {
    const strong = tagEq(t,"tourism","viewpoint") || hasAny(n, ["belvedere","panoram","terrazza","vista","scenic","viewpoint"]);
    if (!strong) return null;

    let s = 0;
    if (tagEq(t,"tourism","viewpoint")) s += 85;
    if (hasAny(n, ["belvedere","panoram","terrazza","vista","scenic","viewpoint"])) s += 20;
    if (hasQuality) s += 10;

    return { ...p, score: s, beauty_score: 0.70 + Math.min(0.25, s/420), visibility: (s >= 75 ? "chicca" : "classica") };
  }

  // -------------------------------- FAMILY --------------------------------
  if (cat === "family") {
    const strong =
      tagEq(t,"tourism","theme_park") ||
      tagEq(t,"leisure","water_park") ||
      tagEq(t,"tourism","zoo") ||
      tagEq(t,"tourism","aquarium") ||
      tagEq(t,"leisure","playground") ||
      hasAny(n, ["parco avventura","zip line","fattoria didattica","lunapark","luna park","parco divertimenti","acquapark","aqua park"]);

    if (!strong) return null;

    let s = 0;
    if (tagEq(t,"tourism","theme_park")) s += 90;
    if (tagEq(t,"leisure","water_park")) s += 85;
    if (tagEq(t,"tourism","zoo")) s += 75;
    if (tagEq(t,"tourism","aquarium")) s += 75;
    if (tagEq(t,"leisure","playground")) s += 55;
    if (hasQuality) s += 8;

    return { ...p, score: s, beauty_score: 0.70 + Math.min(0.25, s/420), visibility: (s >= 75 ? "chicca" : "classica") };
  }

  return null;
}

// ---------------------- MAIN ----------------------
async function main() {
  const regionSlug = String(process.env.REGION_SLUG || "").trim().toLowerCase();
  const regionIso  = String(process.env.REGION_ISO  || "").trim().toUpperCase();

  if (!regionSlug || !regionIso) {
    console.error("Missing REGION_SLUG or REGION_ISO. Example: REGION_SLUG=veneto REGION_ISO=IT-34");
    process.exit(1);
  }

  const outDir = path.join(OUT_BASE, regionSlug);
  ensureDir(outDir);

  const index = {
    meta: {
      built_at: nowIso(),
      region_slug: regionSlug,
      region_iso: regionIso,
      categories: Object.keys(CATEGORIES),
      note: "Filtered+scored (wow-first). Relax is strict. Natura excludes peaks. Mare filters marinas.",
    },
    counts: {},
    files: [],
  };

  for (const catKey of Object.keys(CATEGORIES)) {
    console.log(`🛰️ ${regionSlug} (${regionIso}) -> ${catKey}`);

    const q = buildQuery(regionIso, catKey);
    const r = await runOverpass(q);

    if (!r.ok || !r.json) {
      console.log(`❌ ${catKey} failed: ${r.error || "unknown"}`);
      index.counts[catKey] = 0;
      index.files.push({ category: catKey, path: `/data/pois/it/${regionSlug}/${catKey}.json`, count: 0, ok: false });

      fs.writeFileSync(
        path.join(outDir, `${catKey}.json`),
        JSON.stringify({
          meta: {
            built_at: nowIso(),
            region_slug: regionSlug,
            region_iso: regionIso,
            category: catKey,
            ok: false,
            error: r.error || "overpass_failed"
          },
          places: []
        }),
        "utf8"
      );
      continue;
    }

    const els = Array.isArray(r.json.elements) ? r.json.elements : [];
    const mappedRaw = els
      .map(el => mapElToPlace(el, catKey, regionSlug, regionIso))
      .filter(Boolean);

    // filter + score
    const scored = mappedRaw
      .map(p => scoreAndFilter(catKey, p))
      .filter(Boolean);

    // dedupe + sort
    const mapped = dedup(scored)
      .sort((a,b) => (Number(b.score||0) - Number(a.score||0)))
      .slice(0, 9000)
      .map(p => {
        // pulizia campi interni
        const { tagsRaw, tagsStr, nameNorm, ...clean } = p;
        return clean;
      });

    const meta = {
      built_at: nowIso(),
      region_slug: regionSlug,
      region_iso: regionIso,
      category: catKey,
      endpoint: r.endpoint,
      count_raw: mappedRaw.length,
      count_kept: mapped.length,
      ok: true,
    };

    fs.writeFileSync(
      path.join(outDir, `${catKey}.json`),
      JSON.stringify({ meta, places: mapped }),
      "utf8"
    );

    index.counts[catKey] = mapped.length;
    index.files.push({ category: catKey, path: `/data/pois/it/${regionSlug}/${catKey}.json`, count: mapped.length, ok: true });

    console.log(`✅ ${catKey}: raw=${mappedRaw.length} kept=${mapped.length}`);
    await sleep(650);
  }

  fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify(index), "utf8");
  console.log(`🎉 DONE index -> public/data/pois/it/${regionSlug}/index.json`);
}

main().catch((e) => {
  console.error("❌ build failed:", e);
  process.exit(1);
});
