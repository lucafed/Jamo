// scripts/build_maifatto_it_abruzzo.mjs
// Output: public/data/mai_fatto/mai_fatto_it_abruzzo.json
// ROBUST • categorie complete • bilanciamento anti-food-only • sempre commit (build_id)

import fs from "fs";
import path from "path";

// Node 18+ ha fetch globale. Se non c'è, aggiungi: import fetch from "node-fetch";

const ENDPOINTS = [
  process.env.OVERPASS_ENDPOINT,
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
].filter(Boolean);

const SLEEP_MS_BASE = Number(process.env.SLEEP_MS || 1100);
const MAX_TILES = process.env.MAX_TILES ? Number(process.env.MAX_TILES) : null;

const GRID = {
  cols: Number(process.env.GRID_COLS || 5),
  rows: Number(process.env.GRID_ROWS || 5),
};

// Abruzzo bbox approx (W,S,E,N)
const ABRUZZO_BBOX = { w: 13.0, s: 41.65, e: 14.85, n: 42.95 };

// totale massimo (alto ok, ma poi bilanciamo)
const TARGET_IDEAS = Number(process.env.TARGET_IDEAS || 2600);

// quote minime “per non rimanere vuoto”
const MIN_QUOTA = {
  relax: Number(process.env.MIN_RELAX || 160),
  famiglia: Number(process.env.MIN_FAMIGLIA || 200),
  bici: Number(process.env.MIN_BICI || 160),
  moto: Number(process.env.MIN_MOTO || 140),
  pioggia: Number(process.env.MIN_PIOGGIA || 160),
  natura: Number(process.env.MIN_NATURA || 220),
  tramonto: Number(process.env.MIN_TRAMONTO || 220),
  mangiare: Number(process.env.MIN_MANGIARE || 260),
};

// blacklist base (evita roba da “spesa” o brand)
const BAD_WORDS = [
  "outlet","shopping","iper","supermerc","discount","lidl","esselunga","coop","conad","eurospin",
  "md","pam","carrefour","ikea","leroy merlin","centro commerciale","parco commerciale","autogrill",
  "mcdon","mc don","burger king","kfc","starbucks","basko","delhaize",
];

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function mkdirp(p){ fs.mkdirSync(p, { recursive:true }); }
function writeJSON(filePath, obj){
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

function norm(s){ return String(s || "").trim(); }
function low(s){ return norm(s).toLowerCase(); }

function hasBadWords(name){
  const n = low(name);
  if (!n) return false;
  return BAD_WORDS.some(w => n.includes(w));
}

function hasWiki(tags){ return Boolean(tags?.wikipedia || tags?.wikidata); }

function getCenter(el){
  if (typeof el.lat === "number" && typeof el.lon === "number") return { lat: el.lat, lon: el.lon };
  if (el.center && typeof el.center.lat === "number" && typeof el.center.lon === "number") return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

function isBadElement(el){
  const t = el.tags || {};
  const name = norm(t.name);
  if (!name) return true;
  if (hasBadWords(name)) return true;

  // taglia brand/chain
  if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) return true;

  // roba non “meta”
  const amen = String(t.amenity || "");
  if (["fuel","bank","atm","pharmacy","clinic","hospital","police","post_office"].includes(amen)) return true;

  // lodging puro
  if (t.tourism === "hotel" || t.tourism === "motel" || t.tourism === "hostel") return true;

  return false;
}

// ---------------- FOOD / MANGIARE ----------------
function isFood(tags){
  const t = tags || {};
  const amen = String(t.amenity || "");
  const shop = String(t.shop || "");
  const craft = String(t.craft || "");
  const tourism = String(t.tourism || "");
  const cuisine = norm(t.cuisine);

  if (["restaurant","pub","cafe","bar","fast_food","ice_cream","biergarten"].includes(amen)) return true;
  if (amen === "marketplace") return true;
  if (tourism === "winery") return true;

  if ([
    "deli","cheese","butcher","bakery","pastry","confectionery","chocolate",
    "farm","farm_shop","greengrocer","seafood","wine","beverages"
  ].includes(shop)) return true;

  if (["brewery","distillery"].includes(craft)) return true;

  const name = low(t.name);
  if (name.includes("agriturismo") || name.includes("osteria") || name.includes("trattoria") || name.includes("enoteca")) return true;

  if (cuisine) return true;

  return false;
}

// --- Classificazione “Mai fatto” (CHIAVI UI)
function classify(tags){
  const t = tags || {};
  const amen = String(t.amenity || "");
  const leisure = String(t.leisure || "");
  const tourism = String(t.tourism || "");
  const natural = String(t.natural || "");
  const waterway = String(t.waterway || "");
  const highway = String(t.highway || "");

  // MANGIARE
  if (isFood(t)) return "mangiare";

  // TRAMONTO / viewpoint / peaks / cliffs
  if (tourism === "viewpoint") return "tramonto";
  if (["peak","cliff","ridge","saddle"].includes(natural)) return "tramonto";

  // PIOGGIA (indoor-ish)
  if (amen === "cinema" || amen === "theatre" || amen === "library" || amen === "arts_centre") return "pioggia";
  if (tourism === "museum" || tourism === "gallery" || tourism === "aquarium") return "pioggia";
  if (amen === "planetarium") return "pioggia";

  // FAMIGLIA
  if (tourism === "zoo" || tourism === "theme_park" || tourism === "aquarium") return "famiglia";
  if (leisure === "water_park" || leisure === "playground") return "famiglia";
  if (leisure === "park" && t.name) return "famiglia";
  if (amen === "community_centre" && t.name) return "famiglia";
  if (tourism === "attraction" && t.name) return "famiglia";

  // RELAX
  if (natural === "spring") return "relax";
  if (amen === "spa" || leisure === "sauna") return "relax";
  if (leisure === "garden" || leisure === "nature_reserve") return "relax";

  // NATURA
  if (waterway === "waterfall" || natural === "waterfall") return "natura";
  if (natural === "cave_entrance" || natural === "cave") return "natura";
  if (t.boundary === "protected_area" || leisure === "nature_reserve") return "natura";
  if (natural === "beach" || natural === "coastline") return "natura";
  if (natural === "wood" || natural === "heath" || natural === "scrub") return "natura";

  // BICI (OSM: spesso relations route=bicycle)
  if (t.route === "bicycle") return "bici";
  if (highway === "cycleway") return "bici";
  if (t.cycleway || t["cycleway:left"] || t["cycleway:right"]) return "bici";
  if (t.bicycle === "designated" || t.bicycle === "yes" || t.bicycle_road === "yes") return "bici";
  if (t.network && ["lcn","rcn","ncn"].includes(String(t.network))) return "bici";

  // MOTO (proxy “giro bello”: passi + scenic)
  if (t.mountain_pass === "yes") return "moto";
  if (t.scenic === "yes" && highway) return "moto";

  // fallback
  return "natura";
}

// bucket tempo coerente (serve alla UI 1h/2h)
function durationBucketFor(cat){
  if (["pioggia","tramonto","mangiare"].includes(cat)) return "1h";
  return "2h";
}

function durationMinFor(cat){
  const r = Math.random();
  const ranges = {
    "1h":[45,90], "2h":[95,170],
    "relax":[55,120],
    "famiglia":[80,165],
    "bici":[70,155],
    "moto":[75,170],
    "natura":[85,175],
    "pioggia":[45,95],
    "tramonto":[55,115],
    "mangiare":[55,130],
  };
  const b = durationBucketFor(cat);
  const [a,c] = ranges[cat] || ranges[b] || [60,120];
  return Math.round(a + (c-a)*r);
}

function buildWhy(tags, cat){
  const t = tags || {};
  if (cat === "mangiare"){
    const cue = [];
    if (t.tourism === "winery" || t.shop === "wine") cue.push("vino locale");
    if (t.craft === "brewery") cue.push("birra artigianale");
    if (t.shop === "cheese") cue.push("caseificio");
    if (t.shop === "bakery") cue.push("forno");
    if (t.amenity === "ice_cream") cue.push("gelato artigianale");
    if (t.amenity === "marketplace") cue.push("mercato");
    const extra = cue.length ? ` (${cue.slice(0,2).join(" • ")})` : "";
    return `Sosta “vera” e locale${extra}: più autentica dei posti standard e ti fa sentire in gita anche se sei vicino.`;
  }
  if (cat === "tramonto") return "Punto luce: al tramonto cambia faccia e diventa una scena. Perfetto se vuoi wow senza organizzare nulla.";
  if (cat === "pioggia") return "Ottimo piano B: al coperto, interessante, e ti salva la giornata quando fuori non invoglia.";
  if (cat === "famiglia") return "Family nel senso giusto: spazio e stimoli reali, senza stress. I bimbi si divertono davvero.";
  if (cat === "relax") return "Stacca la testa: atmosfera tranquilla e pulita, senza turismo di massa.";
  if (cat === "bici") return "Giro in bici semplice ma soddisfacente: ti dà la sensazione di mini-viaggio senza farti distruggere.";
  if (cat === "moto") return "Giro da moto: guida piacevole + panorama. Roba che ti rimane addosso.";
  return "È una micro-meta poco ovvia: abbastanza speciale da valere l’uscita, abbastanza vicina da farla anche al volo.";
}

function scoreWow(el){
  const t = el.tags || {};
  let s = 0;

  // boost wow
  if (t.tourism === "viewpoint") s += 45;
  if (t.waterway === "waterfall" || t.natural === "waterfall") s += 55;
  if (t.natural === "cave_entrance" || t.natural === "cave") s += 35;
  if (t.natural === "peak" || t.natural === "cliff") s += 22;

  // family/relax/indoor
  if (t.tourism === "theme_park" || t.tourism === "zoo" || t.leisure === "water_park") s += 22;
  if (t.leisure === "playground") s += 18;
  if (t.tourism === "museum" || t.tourism === "gallery" || t.amenity === "library") s += 16;
  if (t.amenity === "spa") s += 18;
  if (t.natural === "spring") s += 14;

  // bici/moto
  if (t.route === "bicycle" || t.highway === "cycleway") s += 14;
  if (t.mountain_pass === "yes" || t.scenic === "yes") s += 16;

  // mangiare
  if (isFood(t)){
    s += 28;
    if (t.tourism === "winery") s += 12;
    if (t.craft === "brewery" || t.craft === "distillery") s += 10;
    if (t.shop === "cheese" || t.shop === "bakery" || t.shop === "farm_shop" || t.shop === "deli") s += 8;
    if (t.amenity === "ice_cream" || t.shop === "pastry") s += 6;
    const c = low(t.cuisine);
    if (c) s += 6;
    if (c && !["pizza","burger","kebab","italian"].includes(c)) s += 5;
  }

  // anti-ovvio soft: wiki penalizza ma non uccide
  if (hasWiki(t)) s -= 30;
  if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) s -= 45;

  const name = norm(t.name || "");
  if (name.length >= 10) s += 4;

  s += Math.random() * 12;
  return s;
}

// ---------------- Overpass Queries ----------------

// 1) WOW + NATURA + RELAX + TRAMONTO + BASE FAMILY/PIOGGIA
function overpassQueryWowFamilyIndoor(b){
  return `
[out:json][timeout:180];
(
  // NATURA / WOW
  nwr["tourism"="viewpoint"](${b.s},${b.w},${b.n},${b.e});
  nwr["waterway"="waterfall"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="waterfall"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="spring"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="cave_entrance"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="cave"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="peak"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="cliff"](${b.s},${b.w},${b.n},${b.e});
  nwr["boundary"="protected_area"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="nature_reserve"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="wood"](${b.s},${b.w},${b.n},${b.e});

  // FAMILY base
  nwr["tourism"="zoo"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="theme_park"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="park"]["name"](${b.s},${b.w},${b.n},${b.e});

  // PIOGGIA base (indoor)
  nwr["tourism"="museum"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="gallery"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="cinema"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="theatre"]["name"](${b.s},${b.w},${b.n},${b.e});

  // RELAX
  nwr["amenity"="spa"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="garden"]["name"](${b.s},${b.w},${b.n},${b.e});
);
out center tags;
`;
}

// 2) FOOD / MANGIARE
function overpassQueryFood(b){
  return `
[out:json][timeout:180];
(
  nwr["amenity"="restaurant"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="pub"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="cafe"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="bar"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="fast_food"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="ice_cream"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="marketplace"]["name"](${b.s},${b.w},${b.n},${b.e});

  nwr["tourism"="winery"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["craft"="brewery"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["craft"="distillery"]["name"](${b.s},${b.w},${b.n},${b.e});

  nwr["shop"="farm_shop"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["shop"="deli"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["shop"="cheese"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["shop"="bakery"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["shop"="pastry"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["shop"="confectionery"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["shop"="wine"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["shop"="beverages"]["name"](${b.s},${b.w},${b.n},${b.e});
);
out center tags;
`;
}

// 3) FAMILY EXTRA (per riempire davvero)
function overpassQueryFamilyExtra(b){
  return `
[out:json][timeout:180];
(
  nwr["leisure"="playground"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="water_park"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="community_centre"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="aquarium"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="attraction"]["name"](${b.s},${b.w},${b.n},${b.e});
);
out center tags;
`;
}

// 4) PIOGGIA EXTRA
function overpassQueryRainExtra(b){
  return `
[out:json][timeout:180];
(
  nwr["amenity"="library"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="arts_centre"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="planetarium"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="museum"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="gallery"]["name"](${b.s},${b.w},${b.n},${b.e});
);
out center tags;
`;
}

// 5) BICI EXTRA (relations route=bicycle + cycleways)
function overpassQueryBikeExtra(b){
  return `
[out:json][timeout:180];
(
  relation["route"="bicycle"](${b.s},${b.w},${b.n},${b.e});
  way["highway"="cycleway"](${b.s},${b.w},${b.n},${b.e});
  way["bicycle"="designated"](${b.s},${b.w},${b.n},${b.e});
  way["bicycle_road"="yes"](${b.s},${b.w},${b.n},${b.e});
  way["cycleway"](${b.s},${b.w},${b.n},${b.e});
);
out center tags;
`;
}

// 6) MOTO EXTRA (passi + scenic=yes su roads)
function overpassQueryMotoExtra(b){
  return `
[out:json][timeout:180];
(
  nwr["mountain_pass"="yes"](${b.s},${b.w},${b.n},${b.e});
  way["scenic"="yes"]["highway"](${b.s},${b.w},${b.n},${b.e});
);
out center tags;
`;
}

async function fetchWithTimeout(url, options, timeoutMs){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try{
    const r = await fetch(url, { ...options, signal: ctrl.signal });
    return r;
  } finally {
    clearTimeout(t);
  }
}

async function overpassFetch(query){
  const body = "data=" + encodeURIComponent(query);
  let lastErr = null;

  for (let attempt = 1; attempt <= 6; attempt++){
    for (const ep of ENDPOINTS){
      try{
        const r = await fetchWithTimeout(ep, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body,
        }, 180000);

        const ct = (r.headers.get("content-type") || "").toLowerCase();

        if (!r.ok){
          const txt = await r.text().catch(() => "");
          const msg = `HTTP ${r.status} (${ep}) ${txt.slice(0,120)}`;
          if ([429,502,503,504].includes(r.status)){
            lastErr = new Error(msg);
            continue;
          }
          throw new Error(msg);
        }

        if (!ct.includes("application/json")){
          const txt = await r.text().catch(() => "");
          lastErr = new Error(`Non-JSON (${ep}): ${txt.slice(0,120)}`);
          continue;
        }

        return await r.json();
      } catch(e){
        lastErr = e;
      }
    }

    const wait = SLEEP_MS_BASE * attempt * 1.6;
    console.warn(`⚠️ retry ${attempt}/6 — wait ${Math.round(wait)}ms —`, lastErr?.message || "");
    await sleep(wait);
  }

  throw lastErr || new Error("Overpass failed");
}

function tilesForBBox(bbox, grid){
  const tiles = [];
  const dx = (bbox.e - bbox.w) / grid.cols;
  const dy = (bbox.n - bbox.s) / grid.rows;
  for (let y=0;y<grid.rows;y++){
    for (let x=0;x<grid.cols;x++){
      const w = bbox.w + dx*x;
      const e = bbox.w + dx*(x+1);
      const s = bbox.s + dy*y;
      const n = bbox.s + dy*(y+1);
      tiles.push({ w,s,e,n });
    }
  }
  return tiles;
}

function dedupeKey(el){ return `${el.type}:${el.id}`; }

function buildIdea(el){
  const t = el.tags || {};
  const center = getCenter(el);
  if (!center) return null;

  const name = norm(t.name);
  if (!name) return null;

  const cat = classify(t);
  const bucket = durationBucketFor(cat);
  const why = buildWhy(t, cat);

  return {
    id: `it_${el.type}_${el.id}`,
    title: name,
    place: name,
    city: t["addr:city"] || t["is_in:city"] || "",
    region: "Abruzzo",
    country_code: "IT",
    lat: Number(center.lat),
    lon: Number(center.lon),
    category: cat,             // <-- CHIAVI UI: relax/famiglia/bici/moto/natura/pioggia/tramonto/mangiare
    duration_bucket: bucket,   // "1h" o "2h"
    duration_min: durationMinFor(cat),
    why,
    repeatable: true,
    url: "",
    source: "osm_overpass"
  };
}

function scoreIdea(idea){
  // punteggio stabile basato su durata + category (wow implicito)
  let s = 0;
  if (idea.category === "tramonto") s += 18;
  if (idea.category === "natura") s += 16;
  if (idea.category === "famiglia") s += 15;
  if (idea.category === "pioggia") s += 14;
  if (idea.category === "relax") s += 13;
  if (idea.category === "moto") s += 12;
  if (idea.category === "bici") s += 12;
  if (idea.category === "mangiare") s += 10;

  if (idea.duration_bucket === "1h") s += 2;
  s += Math.random() * 8;
  return s;
}

function pickBalanced(ideas, target){
  const byCat = new Map();
  for (const it of ideas){
    const c = it.category || "natura";
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(it);
  }

  // ordina ogni categoria
  for (const [c, arr] of byCat.entries()){
    arr.sort((a,b)=> scoreIdea(b) - scoreIdea(a));
    byCat.set(c, arr);
  }

  const out = [];
  const used = new Set();

  function take(cat, n){
    const arr = byCat.get(cat) || [];
    let taken = 0;
    for (const x of arr){
      if (taken >= n) break;
      if (used.has(x.id)) continue;
      used.add(x.id);
      out.push(x);
      taken++;
    }
  }

  // 1) quote minime
  for (const [cat, min] of Object.entries(MIN_QUOTA)){
    take(cat, min);
  }

  // 2) riempi fino a target con mix globale
  const allSorted = ideas.slice().sort((a,b)=> scoreIdea(b) - scoreIdea(a));
  for (const x of allSorted){
    if (out.length >= target) break;
    if (used.has(x.id)) continue;
    used.add(x.id);
    out.push(x);
  }

  return out.slice(0, target);
}

async function runQueryIntoMap(map, queryFn, tile, label){
  try{
    const json = await overpassFetch(queryFn(tile));
    const els = Array.isArray(json?.elements) ? json.elements : [];
    for (const el of els){
      if (!el?.tags?.name) continue;
      if (isBadElement(el)) continue;
      const k = dedupeKey(el);
      if (!map.has(k)) map.set(k, el);
    }
    return { ok: true, count: els.length };
  } catch(e){
    console.warn(`⚠️ Tile ${label} failed:`, e.message);
    return { ok: false, count: 0 };
  }
}

async function main(){
  console.log("BUILD MAI FATTO ABRUZZO — endpoints:", ENDPOINTS);
  console.log("GRID:", GRID.cols, "x", GRID.rows);

  const tiles = tilesForBBox(ABRUZZO_BBOX, GRID);
  const tilesToRun = MAX_TILES ? tiles.slice(0, MAX_TILES) : tiles;
  console.log("Tiles:", tilesToRun.length);

  const map = new Map();
  let okTiles = 0;
  let failTiles = 0;

  let idx = 0;
  for (const tile of tilesToRun){
    idx++;
    console.log(`Tile ${idx}/${tilesToRun.length}...`);

    // A) WOW + family/pioggia base + relax
    {
      const r = await runQueryIntoMap(map, overpassQueryWowFamilyIndoor, tile, "WOW/FAMILY/INDOOR/RELAX");
      if (r.ok) okTiles++; else failTiles++;
      await sleep(SLEEP_MS_BASE);
    }

    // B) FOOD (mangiare)
    {
      await runQueryIntoMap(map, overpassQueryFood, tile, "FOOD");
      await sleep(SLEEP_MS_BASE);
    }

    // C) EXTRA: family/pioggia/bici/moto (per evitare “manca proprio”)
    {
      await runQueryIntoMap(map, overpassQueryFamilyExtra, tile, "FAMILY_EXTRA");
      await sleep(Math.round(SLEEP_MS_BASE * 0.7));

      await runQueryIntoMap(map, overpassQueryRainExtra, tile, "RAIN_EXTRA");
      await sleep(Math.round(SLEEP_MS_BASE * 0.7));

      await runQueryIntoMap(map, overpassQueryBikeExtra, tile, "BIKE_EXTRA");
      await sleep(Math.round(SLEEP_MS_BASE * 0.7));

      await runQueryIntoMap(map, overpassQueryMotoExtra, tile, "MOTO_EXTRA");
      await sleep(Math.round(SLEEP_MS_BASE * 0.7));
    }
  }

  const all = Array.from(map.values());
  console.log("Raw candidates:", all.length, "| ok tiles:", okTiles, "| failed tiles:", failTiles);

  // anti-ovvio soft: prima senza wiki
  let filtered = all.filter(el => !hasWiki(el.tags || {}));
  console.log("After filter (no wiki):", filtered.length);

  if (filtered.length < 700){
    console.log("Low no-wiki pool => soften filter");
    filtered = all;
  }

  // build ideas (dedupe per nome)
  const ideas = [];
  const seenName = new Set();

  // ordina per wow raw (su elementi) per scegliere meglio
  const scoredEls = filtered.map(el => ({ el, s: scoreWow(el) }));
  scoredEls.sort((a,b)=> b.s - a.s);

  for (const { el } of scoredEls){
    const idea = buildIdea(el);
    if (!idea) continue;

    const kn = idea.title.toLowerCase();
    if (seenName.has(kn)) continue;
    seenName.add(kn);

    if (idea.title.length < 5) continue;
    ideas.push(idea);

    if (ideas.length >= Math.min(TARGET_IDEAS, filtered.length)) break;
  }

  // report distribuzione PRE
  const preCounts = ideas.reduce((acc,x)=>{
    acc[x.category] = (acc[x.category]||0)+1;
    return acc;
  }, {});
  console.log("PRE counts:", preCounts);

  // bilanciamento finale
  const finalIdeas = pickBalanced(ideas, Math.min(TARGET_IDEAS, ideas.length));

  // report distribuzione POST
  const postCounts = finalIdeas.reduce((acc,x)=>{
    acc[x.category] = (acc[x.category]||0)+1;
    return acc;
  }, {});
  console.log("POST counts:", postCounts);

  const out = {
    _build_id: "abruzzo_" + Date.now(), // forza commit / bust cache
    updated_at: new Date().toISOString(),
    count: finalIdeas.length,
    area: "Abruzzo — Mai fatto (WOW bilanciato: Natura+Tramonto+Mangiare+Family+Bici+Moto+Pioggia+Relax) — robust build",
    stats: {
      region: "Abruzzo",
      bbox: ABRUZZO_BBOX,
      grid: GRID,
      tiles_total: tilesToRun.length,
      tiles_ok: okTiles,
      tiles_failed: failTiles,
      endpoints: ENDPOINTS,
      pre_counts: preCounts,
      post_counts: postCounts,
    },
    ideas: finalIdeas
  };

  const outPath = path.join(process.cwd(), "public/data/mai_fatto/mai_fatto_it_abruzzo.json");
  writeJSON(outPath, out);

  console.log("✅ Wrote:", outPath);
  console.log("Ideas:", finalIdeas.length);
}

main().catch((e)=>{
  console.error("FATAL:", e);
  process.exit(1);
});
