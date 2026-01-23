// scripts/build_maifatto_it_abruzzo.mjs (ROBUST • CATEGORY-FULL • WOW • Abruzzo)
// Output: public/data/mai_fatto/mai_fatto_it_abruzzo.json
//
// ✅ Scrive SEMPRE l'output (anche se Overpass fallisce)
// ✅ Multi-endpoint + retry/backoff
// ✅ Query spezzata per tile:
//    (A) WOW+FAMILY
//    (B) FOOD
//    (C) RELAX + PIOGGIA (indoor + terme/spa)
//    (D) BICI + MOTO (cycleway/route=bicycle + mountain_pass/scenic)
//
// ✅ Bilanciamento categorie: evita 90% ristoranti
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

// target più piccolo per test (poi alziamo)
const TARGET_IDEAS = Number(process.env.TARGET_IDEAS || 2500);

// bilanciamento: mangiare max 25%, il resto distribuito
const CATEGORY_RATIOS = {
  mangiare: 0.25,
  natura:   0.20,
  tramonto: 0.12,
  relax:    0.12,
  pioggia:  0.08,
  famiglia: 0.08,
  bici:     0.07,
  moto:     0.06,
  "1h":     0.01,
  "2h":     0.01,
};
const MIN_PER_CATEGORY = 30; // se ci sono, prendine almeno un po' per categoria

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

  // taglia brand
  if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) return true;

  const amen = String(t.amenity || "");
  if (["fuel","bank","atm","pharmacy","clinic","hospital"].includes(amen)) return true;

  // evita lodging puro
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

// ---------- RELAX
function isRelax(tags){
  const t = tags || {};
  const amen = String(t.amenity || "");
  const leisure = String(t.leisure || "");
  const tourism = String(t.tourism || "");
  const natural = String(t.natural || "");
  const bathType = String(t["bath:type"] || "");
  const name = norm(t.name).toLowerCase();

  if (amen === "spa" || leisure === "spa" || tourism === "spa") return true;
  if (amen === "sauna" || leisure === "sauna") return true;
  if (amen === "public_bath") return true;
  if (natural === "hot_spring") return true;
  if (bathType.toLowerCase().includes("thermal")) return true;

  // name fallback (solo se non è brand)
  if (name.includes("terme") || name.includes("termale") || name.includes("spa") || name.includes("wellness") || name.includes("benessere") || name.includes("sauna") || name.includes("hammam") || name.includes("hamam")) return true;

  return false;
}

// ---------- PIOGGIA / INDOOR
function isIndoor(tags){
  const t = tags || {};
  const tourism = String(t.tourism || "");
  const amen = String(t.amenity || "");
  const leisure = String(t.leisure || "");
  const historic = String(t.historic || "");

  if (tourism === "museum" || tourism === "gallery") return true;
  if (amen === "theatre" || amen === "cinema") return true;
  if (leisure === "indoor_play" || leisure === "escape_game") return true;

  // castelli/forti spesso visitabili = buoni per pioggia
  if (["castle","fort","ruins","archaeological_site","monument","memorial","palace"].includes(historic)) return true;

  return false;
}

// ---------- BICI
function isBike(tags){
  const t = tags || {};
  const route = String(t.route || "");
  const highway = String(t.highway || "");
  const bicycle = String(t.bicycle || "");
  const cycleway = String(t.cycleway || "");
  const name = norm(t.name).toLowerCase();

  if (route === "bicycle") return true;               // relations
  if (highway === "cycleway") return true;            // ways
  if (cycleway) return true;                          // cycleway=lane/track/...
  if (bicycle === "designated") return true;
  if (name.includes("ciclabile") || name.includes("greenway") || name.includes("bike")) return true;

  return false;
}

// ---------- MOTO
function isMoto(tags){
  const t = tags || {};
  const mp = String(t.mountain_pass || "");
  const natural = String(t.natural || "");
  const tourism = String(t.tourism || "");
  const name = norm(t.name).toLowerCase();

  if (mp && mp !== "no") return true;                 // mountain_pass=yes/name
  if (name.includes("passo ") || name.includes("valico")) return true;
  // scenic + viewpoint/peak = moto-friendly
  if (tourism === "viewpoint" && (name.includes("panoram") || name.includes("belvedere") || name.includes("scenic"))) return true;
  if (natural === "peak" && (name.includes("passo") || name.includes("valico") || name.includes("panoram"))) return true;

  return false;
}

function classify(tags){
  const t = tags || {};
  const historic = String(t.historic || "");

  if (isFood(t)) return "mangiare";
  if (isRelax(t)) return "relax";
  if (isBike(t)) return "bici";
  if (isMoto(t)) return "moto";

  // pioggia/indoor prima di “natura”
  if (isIndoor(t)) return "pioggia";

  if (t.tourism === "viewpoint") return "tramonto";
  if (t.waterway === "waterfall" || t.natural === "waterfall") return "natura";
  if (t.natural === "cave_entrance" || t.natural === "cave") return "natura";
  if (t.natural === "peak" || t.natural === "cliff" || t.natural === "ridge") return "tramonto";
  if (t.natural === "spring") return "relax";
  if (t.boundary === "protected_area" || t.leisure === "nature_reserve") return "natura";

  // duration buckets “wow-time”
  if (["ruins","castle","fort","archaeological_site","monument","palace"].includes(historic)) return "2h";
  if (t.man_made === "bridge" || t.bridge) return "1h";

  // family
  if (t.tourism === "zoo" || t.tourism === "theme_park") return "famiglia";
  if (t.leisure === "park" && t.name) return "famiglia";

  return "natura";
}

function durationFor(cat){
  const r = Math.random();
  const ranges = {
    "1h":[45,85], "2h":[95,160],
    "relax":[45,95], "famiglia":[70,150],
    "bici":[55,120], "moto":[70,160],
    "natura":[70,170], "pioggia":[45,90],
    "tramonto":[55,110], "mangiare":[70,160],
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

  if (cat === "relax") return "È relax vero: terme/spa/sauna o acqua calda. Zero sbatti, massimo reset.";
  if (cat === "pioggia") return "Quando fuori è brutto, qui funziona: indoor, visita, atmosfera e niente fango.";
  if (cat === "bici") return "È un giro da bici che vale la pena: scorrevole e con vista/contesto bello.";
  if (cat === "moto") return "È una strada/passo da moto: curve e panorama, con quel feeling da ‘giro serio’.";

  if (cat === "tramonto" && hasView) return "È un punto panoramico spesso fuori dal giro ovvio: quando la luce cambia, diventa una scena da ricordare.";
  if (cat === "natura" && isWater) return "Qui l’acqua fa davvero differenza: aria fresca, suono, atmosfera. È una mini-fuga che sorprende.";
  if (cat === "natura" && isCave) return "È un posto raro e ‘strano’ nel modo giusto: una sorpresa naturale che sembra lontana, invece è qui.";
  if (cat === "2h" && isRuins) return "È storia senza folla: scenografia vera e silenzio, perfetto per un’uscita che diventa racconto.";
  if (cat === "1h" && isBridge) return "È una piccola meraviglia che la maggior parte attraversa senza notare: ideale per un colpo di wow rapido.";
  if (cat === "famiglia") return "È family nel senso giusto: spazio e stimoli reali, senza dover riempire la giornata con mille cose.";

  return "È una micro-meta poco ovvia: abbastanza speciale da valere l’uscita, abbastanza vicina da farlo anche al volo.";
}

function scoreWow(el){
  const t = el.tags || {};
  let s = 0;

  // WOW core
  if (t.tourism === "viewpoint") s += 40;
  if (t.waterway === "waterfall" || t.natural === "waterfall") s += 50;
  if (t.natural === "cave_entrance" || t.natural === "cave") s += 38;
  if (["ruins","castle","fort","archaeological_site","palace"].includes(String(t.historic||""))) s += 30;
  if (t.man_made === "bridge" || t.bridge) s += 14;

  // relax
  if (isRelax(t)) s += 18;

  // indoor/pioggia
  if (isIndoor(t)) s += 16;

  // bici/moto
  if (isBike(t)) s += 14;
  if (isMoto(t)) s += 14;

  // food bonus (ma poi cappiamo)
  if (isFood(t)){
    s += 20;
    if (t.tourism === "winery") s += 10;
    if (t.craft === "brewery" || t.craft === "distillery") s += 10;
    if (t.shop === "cheese" || t.shop === "bakery" || t.shop === "farm_shop" || t.shop === "deli") s += 8;
    if (t.amenity === "ice_cream" || t.shop === "pastry") s += 6;

    const c = norm(t.cuisine).toLowerCase();
    if (c) s += 6;
    if (c && !["pizza","burger","kebab","italian"].includes(c)) s += 4;
  }

  // anti-ovvio (puoi ridurlo quando vuoi)
  if (hasWiki(t)) s -= 40;
  if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) s -= 40;

  const name = norm(t.name);
  if (name.length >= 10) s += 4;

  // jitter
  s += Math.random() * 8;
  return s;
}

// --- Query spezzate
function overpassQueryWowFamily(b){
  return `
[out:json][timeout:180];
(
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
  nwr["historic"="archaeological_site"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="palace"](${b.s},${b.w},${b.n},${b.e});
  nwr["man_made"="bridge"](${b.s},${b.w},${b.n},${b.e});
  way["bridge"](${b.s},${b.w},${b.n},${b.e});
  nwr["boundary"="protected_area"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="nature_reserve"](${b.s},${b.w},${b.n},${b.e});

  // FAMILY
  nwr["tourism"="zoo"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="theme_park"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="park"]["name"](${b.s},${b.w},${b.n},${b.e});
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

// RELAX + PIOGGIA (indoor)
function overpassQueryRelaxPioggia(b){
  return `
[out:json][timeout:180];
(
  // RELAX
  nwr["amenity"="spa"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="spa"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="spa"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="sauna"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="sauna"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="public_bath"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="hot_spring"](${b.s},${b.w},${b.n},${b.e});
  nwr["bath:type"="thermal"](${b.s},${b.w},${b.n},${b.e});

  // PIOGGIA / INDOOR
  nwr["tourism"="museum"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="gallery"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="theatre"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="cinema"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="castle"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="fort"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="palace"]["name"](${b.s},${b.w},${b.n},${b.e});
);
out center tags;
`;
}

// BICI + MOTO
function overpassQueryBiciMoto(b){
  return `
[out:json][timeout:180];
(
  // BICI (ways + relations)
  way["highway"="cycleway"]["name"](${b.s},${b.w},${b.n},${b.e});
  way["cycleway"]["name"](${b.s},${b.w},${b.n},${b.e});
  relation["route"="bicycle"]["name"](${b.s},${b.w},${b.n},${b.e});
  way["bicycle"="designated"]["name"](${b.s},${b.w},${b.n},${b.e});

  // MOTO (passi + scenic)
  nwr["mountain_pass"](${b.s},${b.w},${b.n},${b.e});
  nwr["mountain_pass"="yes"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="viewpoint"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="peak"]["name"](${b.s},${b.w},${b.n},${b.e});
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
  const wow = scoreWow(el);
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
    wow_score: Number(wow.toFixed(2)),
    repeatable: true,
    url: "",
    source: "osm_overpass"
  };
}

// per “pool” top scorato, ma NON facciamo più solo sampleTop globale: bilanciamo per categoria
function scoreAll(elements){
  return elements.map(el => ({ el, s: scoreWow(el) })).sort((a,b)=>b.s-a.s);
}

function balanceByCategory(scored, maxTotal){
  const cats = Object.keys(CATEGORY_RATIOS);
  const buckets = new Map();
  for (const c of cats) buckets.set(c, []);
  buckets.set("other", []);

  for (const x of scored){
    const cat = classify(x.el.tags || {});
    const arr = buckets.get(cat) || buckets.get("other");
    arr.push(x);
  }

  const desired = {};
  for (const c of cats){
    desired[c] = Math.max(
      Math.min(Math.round(maxTotal * (CATEGORY_RATIOS[c] || 0)), maxTotal),
      0
    );
  }

  // garantisci un minimo (se ci sono)
  for (const c of cats){
    if ((buckets.get(c) || []).length > 0) desired[c] = Math.max(desired[c], MIN_PER_CATEGORY);
  }

  const picked = [];
  const seen = new Set();

  function takeFrom(cat, n){
    const arr = buckets.get(cat) || [];
    let k = 0;
    for (const x of arr){
      if (picked.length >= maxTotal) break;
      const key = dedupeKey(x.el);
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(x.el);
      k++;
      if (k >= n) break;
    }
  }

  // 1) prendi quote per categoria
  for (const c of cats) takeFrom(c, desired[c]);

  // 2) fill rest con best global (ma cappando mangiare già preso)
  const remaining = Math.max(0, maxTotal - picked.length);
  if (remaining > 0){
    let added = 0;
    for (const x of scored){
      if (added >= remaining || picked.length >= maxTotal) break;
      const key = dedupeKey(x.el);
      if (seen.has(key)) continue;

      // ulteriore cap "mangiare" duro
      const cat = classify(x.el.tags || {});
      if (cat === "mangiare"){
        const maxFood = Math.floor(maxTotal * CATEGORY_RATIOS.mangiare);
        const curFood = picked.filter(el => classify(el.tags || {}) === "mangiare").length;
        if (curFood >= maxFood) continue;
      }

      seen.add(key);
      picked.push(x.el);
      added++;
    }
  }

  return picked.slice(0, maxTotal);
}

async function main(){
  const outPath = path.join(process.cwd(), "public/data/mai_fatto/mai_fatto_it_abruzzo.json");

  const stats = {
    region: "Abruzzo",
    bbox: ABRUZZO_BBOX,
    grid: GRID,
    endpoints: ENDPOINTS,
    tiles_total: 0,

    tiles_ok_wow: 0,
    tiles_fail_wow: 0,

    tiles_ok_food: 0,
    tiles_fail_food: 0,

    tiles_ok_relax: 0,
    tiles_fail_relax: 0,

    tiles_ok_bici: 0,
    tiles_fail_bici: 0,
  };

  try{
    console.log("BUILD MAI FATTO ABRUZZO — endpoints:", ENDPOINTS);
    console.log("GRID:", GRID.cols, "x", GRID.rows);

    const tiles = tilesForBBox(ABRUZZO_BBOX, GRID);
    const tilesToRun = MAX_TILES ? tiles.slice(0, MAX_TILES) : tiles;
    stats.tiles_total = tilesToRun.length;

    const map = new Map();

    let idx = 0;
    for (const tile of tilesToRun){
      idx++;
      console.log(`Tile ${idx}/${tilesToRun.length} ...`);

      // (A) WOW+FAMILY
      try{
        const jsonA = await overpassFetch(overpassQueryWowFamily(tile));
        const elsA = Array.isArray(jsonA?.elements) ? jsonA.elements : [];
        for (const el of elsA){
          if (!el?.tags?.name) continue;
          if (isBadElement(el)) continue;
          const k = dedupeKey(el);
          if (!map.has(k)) map.set(k, el);
        }
        stats.tiles_ok_wow++;
      } catch(e){
        stats.tiles_fail_wow++;
        console.warn("⚠️ Tile WOW/FAMILY failed:", e.message);
      }

      await sleep(SLEEP_MS_BASE);

      // (B) FOOD
      try{
        const jsonB = await overpassFetch(overpassQueryFood(tile));
        const elsB = Array.isArray(jsonB?.elements) ? jsonB.elements : [];
        for (const el of elsB){
          if (!el?.tags?.name) continue;
          if (isBadElement(el)) continue;
          const k = dedupeKey(el);
          if (!map.has(k)) map.set(k, el);
        }
        stats.tiles_ok_food++;
      } catch(e){
        stats.tiles_fail_food++;
        console.warn("⚠️ Tile FOOD failed:", e.message);
      }

      await sleep(SLEEP_MS_BASE);

      // (C) RELAX + PIOGGIA
      try{
        const jsonC = await overpassFetch(overpassQueryRelaxPioggia(tile));
        const elsC = Array.isArray(jsonC?.elements) ? jsonC.elements : [];
        for (const el of elsC){
          if (!el?.tags?.name) continue;
          if (isBadElement(el)) continue;
          const k = dedupeKey(el);
          if (!map.has(k)) map.set(k, el);
        }
        stats.tiles_ok_relax++;
      } catch(e){
        stats.tiles_fail_relax++;
        console.warn("⚠️ Tile RELAX/PIOGGIA failed:", e.message);
      }

      await sleep(SLEEP_MS_BASE);

      // (D) BICI + MOTO
      try{
        const jsonD = await overpassFetch(overpassQueryBiciMoto(tile));
        const elsD = Array.isArray(jsonD?.elements) ? jsonD.elements : [];
        for (const el of elsD){
          if (!el?.tags?.name) continue;
          if (isBadElement(el)) continue;
          const k = dedupeKey(el);
          if (!map.has(k)) map.set(k, el);
        }
        stats.tiles_ok_bici++;
      } catch(e){
        stats.tiles_fail_bici++;
        console.warn("⚠️ Tile BICI/MOTO failed:", e.message);
      }

      await sleep(SLEEP_MS_BASE);
    }

    const all = Array.from(map.values());
    console.log("Raw candidates:", all.length);

    // anti-ovvio: prima senza wiki
    let filtered = all.filter(el => !hasWiki(el.tags || {}));
    console.log("After filter (no wiki):", filtered.length);

    if (filtered.length < 600){
      console.log("Low no-wiki pool, softening filter...");
      filtered = all;
    }

    // scoring + bilanciamento
    const scored = scoreAll(filtered);
    const pickedEls = balanceByCategory(scored, Math.min(TARGET_IDEAS, scored.length));

    const ideas = [];
    const seenName = new Set();

    const catCount = {};
    for (const el of pickedEls){
      const idea = buildIdea(el);
      if (!idea) continue;

      const kn = idea.title.toLowerCase();
      if (seenName.has(kn)) continue;
      seenName.add(kn);

      if (idea.title.length < 5) continue;
      ideas.push(idea);

      catCount[idea.category] = (catCount[idea.category] || 0) + 1;
    }

    const out = {
      updated_at: new Date().toISOString(),
      count: ideas.length,
      area: "Abruzzo — Mai fatto (WOW + Food + Relax + Pioggia + Bici/Moto, bilanciato)",
      stats: { ...stats, category_counts: catCount },
      ideas
    };

    writeJSON(outPath, out);
    console.log("✅ Wrote:", outPath);
    console.log("Ideas:", ideas.length);
    console.log("Category counts:", catCount);

  } catch(e){
    // ✅ GUARANTEED OUTPUT anche in caso di disastro
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
