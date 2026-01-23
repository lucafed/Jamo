// scripts/build_maifatto_it_abruzzo.mjs (ROBUST • FULL-CATS • WOW • Abruzzo)
// Output: public/data/mai_fatto/mai_fatto_it_abruzzo.json
//
// ✅ Scrive SEMPRE l'output (anche se Overpass fallisce)
// ✅ Multi-endpoint + retry/backoff
// ✅ Query spezzata: (A) WOW+FAMILY+RELAX+PIOGGIA  (B) BIKE+MOTO  (C) FOOD
//
// Node 20+ (fetch nativo)

import fs from "fs";
import path from "path";

const ENDPOINTS = [
  process.env.OVERPASS_ENDPOINT,
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
].filter(Boolean);

const SLEEP_MS_BASE = Number(process.env.SLEEP_MS || 1800);
const MAX_TILES = process.env.MAX_TILES ? Number(process.env.MAX_TILES) : null;

const GRID = {
  cols: Number(process.env.GRID_COLS || 5),
  rows: Number(process.env.GRID_ROWS || 5),
};

// ✅ Abruzzo bbox approx (W,S,E,N)
const ABRUZZO_BBOX = { w: 13.0, s: 41.65, e: 14.85, n: 42.95 };

// target più alto (hai già 2341, ma ora più categorie entrano)
const TARGET_IDEAS = Number(process.env.TARGET_IDEAS || 3000);

// blacklist brand / centri commerciali
const BAD_WORDS = [
  "outlet","shopping","iper","supermerc","lidl","esselunga","coop","conad","eurospin",
  "md","pam","carrefour","ikea","leroy merlin","centro commerciale","parco commerciale",
  "autogrill","mc don","mcdon","burger king","kfc","starbucks"
];

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function mkdirp(p){ fs.mkdirSync(p, { recursive:true }); }
function writeJSON(filePath, obj){
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

function norm(s){ return String(s || "").trim(); }
function hasBadWords(name){
  const n = norm(name).toLowerCase();
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

  if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) return true;

  const amen = String(t.amenity || "");
  if (["fuel","bank","atm","pharmacy","clinic","hospital"].includes(amen)) return true;

  if (t.tourism === "hotel" || t.tourism === "motel" || t.tourism === "hostel") return true;

  return false;
}

// ---------- FOOD
function isFood(tags){
  const t = tags || {};
  const amen = String(t.amenity || "");
  const shop = String(t.shop || "");
  const craft = String(t.craft || "");
  const tourism = String(t.tourism || "");
  const cuisine = norm(t.cuisine);

  if (["restaurant","pub","cafe","bar","fast_food","ice_cream","biergarten"].includes(amen)) return true;
  if (tourism === "winery") return true;
  if (amen === "marketplace") return true;

  if ([
    "deli","cheese","butcher","bakery","pastry","confectionery",
    "chocolate","farm","farm_shop","greengrocer","seafood","wine","beverages"
  ].includes(shop)) return true;

  if (["brewery","distillery"].includes(craft)) return true;

  const name = norm(t.name).toLowerCase();
  if (name.includes("agriturismo") || name.includes("osteria") || name.includes("trattoria")) return true;

  if (cuisine) return true;
  return false;
}

// ---------- RELAX / PIOGGIA / BIKE / MOTO / FAMILY helpers
function isRelax(tags){
  const t = tags || {};
  const amen = String(t.amenity || "");
  const leisure = String(t.leisure || "");
  const tourism = String(t.tourism || "");
  const natural = String(t.natural || "");
  const healthcare = String(t.healthcare || "");
  const bathType = String(t["bath:type"] || "");
  const name = norm(t.name).toLowerCase();

  if (amen === "spa" || amen === "sauna" || amen === "public_bath") return true;
  if (leisure === "spa" || leisure === "sauna") return true;
  if (tourism === "spa") return true;
  if (natural === "hot_spring" || bathType.includes("thermal")) return true;
  if (healthcare === "spa" || healthcare === "sauna") return true;
  if (name.includes("terme") || name.includes("termale") || name.includes("spa") || name.includes("wellness") || name.includes("benessere")) return true;
  return false;
}

function isRainy(tags){
  const t = tags || {};
  const tourism = String(t.tourism || "");
  const amen = String(t.amenity || "");
  const leisure = String(t.leisure || "");
  const historic = String(t.historic || "");
  const natural = String(t.natural || "");

  // indoor / ok con pioggia
  if (tourism === "museum" || tourism === "gallery") return true;
  if (amen === "theatre" || amen === "cinema") return true;
  if (tourism === "aquarium" || amen === "aquarium") return true;
  if (amen === "planetarium") return true;

  // anche grotte/castelli/forti spesso sono “rain-friendly”
  if (natural === "cave" || natural === "cave_entrance") return true;
  if (["castle","fort","palace","ruins","archaeological_site"].includes(historic)) return true;

  // water park NO (pioggia non è la vibe)
  if (leisure === "water_park") return false;

  return false;
}

function isBike(tags){
  const t = tags || {};
  const highway = String(t.highway || "");
  const route = String(t.route || "");
  const tourism = String(t.tourism || "");
  const leisure = String(t.leisure || "");

  if (highway === "cycleway") return true;
  if (route === "bicycle") return true;
  if (tourism === "cycle_route") return true;
  if (leisure === "track" && String(t.bicycle || "") === "yes") return true;
  if (leisure === "sports_centre" && String(t.sport || "").includes("cycling")) return true;
  return false;
}

function isMoto(tags){
  const t = tags || {};
  const mp = String(t.mountain_pass || "");
  const natural = String(t.natural || "");
  const tourism = String(t.tourism || "");
  const name = norm(t.name).toLowerCase();

  // proxy “giro in moto”
  if (mp) return true;
  if (tourism === "viewpoint" && (name.includes("passo") || name.includes("valico") || name.includes("forca"))) return true;
  if ((natural === "peak" || natural === "ridge" || natural === "cliff") && (name.includes("passo") || name.includes("valico") || name.includes("forca"))) return true;

  // anche alcuni viewpoint generici aiutano la moto come “giro panoramico”
  if (tourism === "viewpoint") return true;

  return false;
}

function isFamily(tags){
  const t = tags || {};
  const tourism = String(t.tourism || "");
  const leisure = String(t.leisure || "");
  const amen = String(t.amenity || "");

  if (tourism === "zoo" || tourism === "theme_park") return true;
  if (leisure === "water_park" || leisure === "playground") return true;
  if (tourism === "attraction" && (leisure === "park" || amen === "aquarium")) return true;
  if (leisure === "park" && t.name) return true;
  return false;
}

// ---------- CLASSIFY
function classify(tags){
  const t = tags || {};

  if (isFood(t)) return "mangiare";
  if (isRelax(t)) return "relax";
  if (isRainy(t)) return "pioggia";
  if (isBike(t)) return "bici";
  if (isFamily(t)) return "famiglia";
  if (isMoto(t)) return "moto";

  if (t.tourism === "viewpoint") return "tramonto";
  if (t.waterway === "waterfall" || t.natural === "waterfall") return "natura";
  if (t.natural === "cave_entrance" || t.natural === "cave") return "natura";
  if (t.natural === "peak" || t.natural === "cliff" || t.natural === "ridge") return "tramonto";
  if (t.natural === "spring") return "relax";
  if (t.boundary === "protected_area" || t.leisure === "nature_reserve") return "natura";

  if (["ruins","castle","fort","archaeological_site","palace"].includes(String(t.historic || ""))) return "2h";
  if (t.man_made === "bridge" || t.bridge) return "1h";

  return "natura";
}

function durationFor(cat){
  const r = Math.random();
  const ranges = {
    "1h":[45,85], "2h":[95,160],
    "relax":[50,110], "famiglia":[70,160],
    "bici":[60,140], "moto":[70,180],
    "natura":[70,180], "pioggia":[60,130],
    "tramonto":[55,115], "mangiare":[70,170],
  };
  const [a,b] = ranges[cat] || [60,120];
  return Math.round(a + (b-a)*r);
}

function buildWhy(tags, cat){
  const t = tags || {};
  const hasView = (t.tourism === "viewpoint" || t.natural === "peak" || t.natural === "cliff");
  const isWater = (t.waterway === "waterfall" || t.natural === "waterfall" || t.natural === "spring");
  const isCave  = (t.natural === "cave_entrance" || t.natural === "cave");
  const isRuins = ["ruins","castle","fort","archaeological_site","palace"].includes(String(t.historic || ""));
  const isBridge = (t.man_made === "bridge" || t.bridge);

  if (cat === "mangiare"){
    const cue = [];
    if (t.tourism === "winery" || t.shop === "wine") cue.push("vino locale");
    if (t.craft === "brewery") cue.push("birra artigianale");
    if (t.shop === "cheese") cue.push("caseificio");
    if (t.shop === "bakery") cue.push("forno");
    if (t.amenity === "ice_cream") cue.push("gelato artigianale");
    if (t.amenity === "marketplace") cue.push("mercato");
    const extra = cue.length ? ` (${cue.slice(0,2).join(" • ")})` : "";
    return `È una sosta “vera” e locale${extra}: spesso non è nei giri ovvi e dà quella sensazione da scoperta, non da posto standard.`;
  }

  if (cat === "relax") return "È relax vero (terme/spa/benessere): ti resetta senza dover organizzare niente.";
  if (cat === "pioggia") return "Quando fuori è brutto, qui ti godi qualcosa di bello lo stesso: perfetto anti-pioggia.";
  if (cat === "bici") return "È un giro che scorre: bello, fotografabile, e ti dà quella sensazione da mini-avventura.";
  if (cat === "moto") return "Strada da sorriso: curve/panorami/valico. Ci vai e torni con la testa più leggera.";
  if (cat === "famiglia") return "È family nel senso giusto: stimoli veri, spazio e zero stress di organizzazione.";

  if (cat === "tramonto" && hasView) return "È un punto panoramico spesso fuori dal giro ovvio: quando la luce cambia, diventa una scena da ricordare.";
  if (cat === "natura" && isWater) return "Qui l’acqua fa davvero differenza: aria fresca, suono, atmosfera. È una mini-fuga che sorprende.";
  if (cat === "natura" && isCave) return "È un posto raro e ‘strano’ nel modo giusto: una sorpresa naturale che sembra lontana, invece è qui.";
  if (cat === "2h" && isRuins) return "È storia senza folla: scenografia vera e silenzio, perfetto per un’uscita che diventa racconto.";
  if (cat === "1h" && isBridge) return "È una piccola meraviglia che la maggior parte attraversa senza notare: ideale per un colpo di wow rapido.";

  return "È una micro-meta poco ovvia: abbastanza speciale da valere l’uscita, abbastanza vicina da farlo anche al volo.";
}

function scoreWow(el){
  const t = el.tags || {};
  let s = 0;

  // wow naturali / iconici
  if (t.tourism === "viewpoint") s += 38;
  if (t.waterway === "waterfall" || t.natural === "waterfall") s += 55;
  if (t.natural === "cave_entrance" || t.natural === "cave") s += 34;
  if (["ruins","castle","fort","archaeological_site","palace"].includes(String(t.historic||""))) s += 28;
  if (t.man_made === "bridge" || t.bridge) s += 12;
  if (t.natural === "spring" || t.natural === "hot_spring") s += 18;

  // categorie “riempitive”
  if (isRelax(t)) s += 24;
  if (isRainy(t)) s += 18;
  if (isFamily(t)) s += 18;
  if (isBike(t)) s += 14;
  if (isMoto(t)) s += 12;

  // FOOD boost
  if (isFood(t)){
    s += 24;
    if (t.tourism === "winery") s += 12;
    if (t.craft === "brewery" || t.craft === "distillery") s += 12;
    if (t.shop === "cheese" || t.shop === "bakery" || t.shop === "farm_shop" || t.shop === "deli") s += 10;
    if (t.amenity === "ice_cream" || t.shop === "pastry") s += 8;

    const c = norm(t.cuisine).toLowerCase();
    if (c) s += 8;
    if (c && !["pizza","burger","kebab","italian"].includes(c)) s += 6;
  }

  // anti-ovvio: wiki penalizza
  if (hasWiki(t)) s -= 36;
  if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) s -= 40;

  const name = norm(t.name);
  if (name.length >= 10) s += 4;

  s += Math.random() * 10;
  return s;
}

// --- Query spezzate
function overpassQueryWowFamilyRelaxRain(b){
  return `
[out:json][timeout:180];
(
  // WOW / NATURA
  nwr["tourism"="viewpoint"](${b.s},${b.w},${b.n},${b.e});
  nwr["waterway"="waterfall"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="waterfall"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="spring"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="hot_spring"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="cave_entrance"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="cave"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="ruins"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="castle"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="fort"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="palace"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="archaeological_site"](${b.s},${b.w},${b.n},${b.e});
  nwr["man_made"="bridge"](${b.s},${b.w},${b.n},${b.e});
  way["bridge"](${b.s},${b.w},${b.n},${b.e});
  nwr["boundary"="protected_area"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="nature_reserve"](${b.s},${b.w},${b.n},${b.e});

  // FAMILY
  nwr["tourism"="zoo"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="theme_park"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="water_park"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="playground"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="park"]["name"](${b.s},${b.w},${b.n},${b.e});

  // RELAX
  nwr["amenity"="spa"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="spa"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="sauna"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="public_bath"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="spa"]["name"](${b.s},${b.w},${b.n},${b.e});

  // PIOGGIA (indoor)
  nwr["tourism"="museum"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="gallery"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="theatre"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="cinema"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="aquarium"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="planetarium"]["name"](${b.s},${b.w},${b.n},${b.e});
);
out center tags;
`;
}

function overpassQueryBikeMoto(b){
  return `
[out:json][timeout:180];
(
  // BICI
  nwr["highway"="cycleway"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["route"="bicycle"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="cycle_route"]["name"](${b.s},${b.w},${b.n},${b.e});

  // MOTO (proxy)
  nwr["mountain_pass"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="viewpoint"]["name"](${b.s},${b.w},${b.n},${b.e});
);
out center tags;
`;
}

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

async function fetchWithTimeout(url, options, timeoutMs){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try{
    return await fetch(url, { ...options, signal: ctrl.signal });
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
          lastErr = new Error(`Non-JSON response (${ep}): ${txt.slice(0,120)}`);
          continue;
        }

        return await r.json();
      } catch(e){
        lastErr = e;
      }
    }

    const wait = SLEEP_MS_BASE * attempt * 1.6;
    console.warn(`⚠️ Overpass retry ${attempt}/6 — waiting ${Math.round(wait)}ms —`, lastErr?.message || "");
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
  const why = buildWhy(t, cat);

  return {
    id: `abruzzo_${el.type}_${el.id}`,
    title: name,
    place: name,
    city: t["addr:city"] || t["is_in:city"] || "",
    region: "Abruzzo",
    country_code: "IT",
    lat: Number(center.lat),
    lon: Number(center.lon),
    category: cat,
    duration_bucket: (cat === "2h" ? "2h" : "1h"),
    duration_min: durationFor(cat),
    why,
    repeatable: true,
    url: "",
    source: "osm_overpass"
  };
}

function sampleTop(elements, max){
  const scored = elements.map(el => ({ el, s: scoreWow(el) }));
  scored.sort((a,b)=>b.s-a.s);
  return scored.slice(0, max).map(x=>x.el);
}

async function main(){
  const outPath = path.join(process.cwd(), "public/data/mai_fatto/mai_fatto_it_abruzzo.json");

  const stats = {
    region: "Abruzzo",
    bbox: ABRUZZO_BBOX,
    grid: GRID,
    endpoints: ENDPOINTS,
    tiles_total: 0,
    tiles_ok_a: 0,
    tiles_fail_a: 0,
    tiles_ok_b: 0,
    tiles_fail_b: 0,
    tiles_ok_c: 0,
    tiles_fail_c: 0,
  };

  try{
    console.log("BUILD MAI FATTO ABRUZZO (FULL-CATS) — endpoints:", ENDPOINTS);
    console.log("GRID:", GRID.cols, "x", GRID.rows);

    const tiles = tilesForBBox(ABRUZZO_BBOX, GRID);
    const tilesToRun = MAX_TILES ? tiles.slice(0, MAX_TILES) : tiles;
    stats.tiles_total = tilesToRun.length;

    const map = new Map();

    let idx = 0;
    for (const tile of tilesToRun){
      idx++;
      console.log(`Tile ${idx}/${tilesToRun.length} ...`);

      // (A) WOW+FAMILY+RELAX+PIOGGIA
      try{
        const jsonA = await overpassFetch(overpassQueryWowFamilyRelaxRain(tile));
        const elsA = Array.isArray(jsonA?.elements) ? jsonA.elements : [];
        for (const el of elsA){
          if (!el?.tags?.name) continue;
          if (isBadElement(el)) continue;
          const k = dedupeKey(el);
          if (!map.has(k)) map.set(k, el);
        }
        stats.tiles_ok_a++;
      } catch(e){
        stats.tiles_fail_a++;
        console.warn("⚠️ Tile A failed:", e.message);
      }

      await sleep(SLEEP_MS_BASE);

      // (B) BIKE+MOTO
      try{
        const jsonB = await overpassFetch(overpassQueryBikeMoto(tile));
        const elsB = Array.isArray(jsonB?.elements) ? jsonB.elements : [];
        for (const el of elsB){
          if (!el?.tags?.name) continue;
          if (isBadElement(el)) continue;
          const k = dedupeKey(el);
          if (!map.has(k)) map.set(k, el);
        }
        stats.tiles_ok_b++;
      } catch(e){
        stats.tiles_fail_b++;
        console.warn("⚠️ Tile B failed:", e.message);
      }

      await sleep(SLEEP_MS_BASE);

      // (C) FOOD
      try{
        const jsonC = await overpassFetch(overpassQueryFood(tile));
        const elsC = Array.isArray(jsonC?.elements) ? jsonC.elements : [];
        for (const el of elsC){
          if (!el?.tags?.name) continue;
          if (isBadElement(el)) continue;
          const k = dedupeKey(el);
          if (!map.has(k)) map.set(k, el);
        }
        stats.tiles_ok_c++;
      } catch(e){
        stats.tiles_fail_c++;
        console.warn("⚠️ Tile C failed:", e.message);
      }

      await sleep(SLEEP_MS_BASE);
    }

    const all = Array.from(map.values());
    console.log("Raw candidates:", all.length);

    let filtered = all.filter(el => !hasWiki(el.tags || {}));
    console.log("After filter (no wiki):", filtered.length);

    if (filtered.length < 700){
      console.log("Low no-wiki pool, softening filter...");
      filtered = all;
    }

    const selected = sampleTop(filtered, Math.min(TARGET_IDEAS, filtered.length));

    const ideas = [];
    const seenName = new Set();
    for (const el of selected){
      const idea = buildIdea(el);
      if (!idea) continue;
      const kn = idea.title.toLowerCase();
      if (seenName.has(kn)) continue;
      seenName.add(kn);
      if (idea.title.length < 5) continue;
      ideas.push(idea);
    }

    const out = {
      updated_at: new Date().toISOString(),
      count: ideas.length,
      area: "Abruzzo — FULL CATS (WOW + Relax + Pioggia + Bici + Moto + Family + Food)",
      stats,
      ideas
    };

    writeJSON(outPath, out);
    console.log("✅ Wrote:", outPath);
    console.log("Ideas:", ideas.length);

  } catch(e){
    console.error("FATAL:", e);

    const out = {
      updated_at: new Date().toISOString(),
      count: 0,
      area: "Abruzzo — build FAILED (output placeholder scritto comunque)",
      stats: { ...stats, error: String(e?.message || e) },
      ideas: []
    };

    writeJSON(outPath, out);
    console.log("✅ Wrote placeholder:", outPath);
    process.exit(0);
  }
}

main();
