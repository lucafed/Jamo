// scripts/build_maifatto_it_abruzzo.mjs
// (FORMATO VERONA • BALANCED • WOW • Abruzzo)
//
// Output: public/data/mai_fatto/mai_fatto_it_abruzzo.json
//
// ✅ Formato uguale a Verona: { updated_at, count, area, ideas: [...] }
// ✅ Sempre output (anche se Overpass fallisce)
// ✅ Multi endpoint + retry/backoff
// ✅ Query spezzata: WOW/relax/family/tramonto/pioggia/1h/2h + FOOD + BICI + MOTO
// ✅ Bilanciamento categorie (riempie tutte le chip)
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

const SLEEP_MS_BASE = Number(process.env.SLEEP_MS || 1400);
const MAX_TILES = process.env.MAX_TILES ? Number(process.env.MAX_TILES) : null;

const GRID = {
  cols: Number(process.env.GRID_COLS || 5),
  rows: Number(process.env.GRID_ROWS || 5),
};

// ✅ Abruzzo bbox approx (W,S,E,N)
const ABRUZZO_BBOX = { w: 13.0, s: 41.65, e: 14.85, n: 42.95 };

// Dimensione dataset “stile Verona”: piccolo e curato
const TARGET_IDEAS = Number(process.env.TARGET_IDEAS || 220);

// Quante per categoria (minimi): se non ci arriviamo, si compensa con "natura"
const MIN_PER_CAT = {
  relax: 18,
  famiglia: 18,
  bici: 18,
  moto: 18,
  natura: 28,
  pioggia: 16,
  tramonto: 18,
  mangiare: 32,
  "1h": 18,
  "2h": 18,
};

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
function lc(s){ return norm(s).toLowerCase(); }

function hasBadWords(name){
  const n = lc(name);
  if (!n) return false;
  return BAD_WORDS.some(w => n.includes(w));
}

function hasWiki(tags){
  return Boolean(tags?.wikipedia || tags?.wikidata);
}

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

  // brand / catene
  if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) return true;

  // roba non wow
  const amen = String(t.amenity || "");
  if (["fuel","bank","atm","pharmacy","clinic","hospital"].includes(amen)) return true;

  // alloggi (non ci interessa in "mai fatto")
  if (t.tourism === "hotel" || t.tourism === "motel" || t.tourism === "hostel") return true;

  return false;
}

// ---------- CATEGORY LOGIC (stabile, per chip) ----------
function isFood(t){
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

  const name = lc(t.name);
  if (name.includes("agriturismo") || name.includes("osteria") || name.includes("trattoria")) return true;

  if (cuisine) return true;
  return false;
}

function isRainFriendly(t){
  const tourism = String(t.tourism || "");
  const amen = String(t.amenity || "");
  const leisure = String(t.leisure || "");
  const historic = String(t.historic || "");
  const man_made = String(t.man_made || "");

  // indoor / coperto “probabile”
  if (tourism === "museum") return true;
  if (amen === "arts_centre" || amen === "theatre" || amen === "cinema") return true;
  if (historic === "castle" || historic === "ruins") return true; // spesso visitabili/aree
  if (man_made === "bridge") return true;
  if (leisure === "spa") return true;
  return false;
}

function isBiciCandidate(t){
  // Non possiamo calcolare percorsi qui (offline), quindi prendiamo POI “da giro”
  // e li etichettiamo come bici quando ha segnali OSM coerenti
  return Boolean(
    t?.route === "bicycle" ||
    t?.bicycle === "yes" ||
    t?.highway === "cycleway" ||
    t?.cycleway ||
    t?.sport === "cycling" ||
    t?.leisure === "track"
  );
}

function isMotoCandidate(t){
  // Segnali “moto” = passi, viewpoint, strade sceniche/panoramiche (best effort)
  const man_made = String(t.man_made || "");
  const tourism = String(t.tourism || "");
  const natural = String(t.natural || "");
  const mountain_pass = String(t.mountain_pass || "");
  const highway = String(t.highway || "");
  const name = lc(t.name);

  if (mountain_pass === "yes") return true;
  if (tourism === "viewpoint") return true;
  if (natural === "peak" || natural === "ridge" || natural === "cliff") return true;
  if (highway && ["secondary","tertiary","unclassified"].includes(highway) && (name.includes("panoram") || name.includes("passo") || name.includes("valico"))) {
    return true;
  }
  if (man_made === "bridge") return true;
  return false;
}

function classify(t){
  // priorità: FOOD prima (così non sparisce)
  if (isFood(t)) return "mangiare";

  // tramonto / viewpoint / creste / picchi
  if (t.tourism === "viewpoint") return "tramonto";
  if (t.natural === "peak" || t.natural === "cliff" || t.natural === "ridge") return "tramonto";

  // relax / acqua / terme/spa/sorgenti
  if (t.natural === "spring") return "relax";
  if (String(t.leisure || "") === "spa") return "relax";

  // natura “forte”
  if (t.waterway === "waterfall" || t.natural === "waterfall") return "natura";
  if (t.natural === "cave_entrance" || t.natural === "cave") return "natura";
  if (t.boundary === "protected_area" || t.leisure === "nature_reserve") return "natura";

  // family
  if (t.tourism === "zoo" || t.tourism === "theme_park") return "famiglia";
  if (t.leisure === "park" && t.name) return "famiglia";
  if (String(t.attraction || "") === "animal") return "famiglia";

  // bici / moto (best effort)
  if (isBiciCandidate(t)) return "bici";
  if (isMotoCandidate(t)) return "moto";

  // 2h / 1h (storia / ponti / archeologia)
  const hist = String(t.historic || "");
  if (["ruins","castle","fort","archaeological_site"].includes(hist)) return "2h";
  if (t.man_made === "bridge" || t.bridge) return "1h";

  // pioggia (indoor-friendly)
  if (isRainFriendly(t)) return "pioggia";

  // default
  return "natura";
}

function durationBucket(cat){
  if (cat === "2h") return "2h";
  // per bici/moto/natura spesso più lungo: ma lasciamo 1h per chip e usiamo duration_min
  return "1h";
}

function durationFor(cat){
  const r = Math.random();
  const ranges = {
    "1h":[45,90], "2h":[100,170],
    relax:[45,95], famiglia:[70,150],
    bici:[55,130], moto:[70,170],
    natura:[70,170], pioggia:[45,95],
    tramonto:[55,120], mangiare:[70,160],
  };
  const [a,b] = ranges[cat] || [60,120];
  return Math.round(a + (b-a)*r);
}

function buildWhy(t, cat){
  const name = norm(t.name);
  const isView = (t.tourism === "viewpoint" || t.natural === "peak" || t.natural === "cliff");
  const isWater = (t.waterway === "waterfall" || t.natural === "waterfall" || t.natural === "spring");
  const isCave  = (t.natural === "cave_entrance" || t.natural === "cave");
  const isHist  = ["ruins","castle","fort","archaeological_site"].includes(String(t.historic || ""));
  const isPark  = (t.leisure === "park");
  const isMuseum = (t.tourism === "museum");

  if (cat === "mangiare"){
    const cue = [];
    if (t.tourism === "winery" || t.shop === "wine") cue.push("vino locale");
    if (t.craft === "brewery") cue.push("birra artigianale");
    if (t.shop === "cheese") cue.push("caseificio");
    if (t.shop === "bakery") cue.push("forno");
    if (t.amenity === "ice_cream") cue.push("gelato artigianale");
    if (t.amenity === "marketplace") cue.push("mercato");
    const extra = cue.length ? ` (${cue.slice(0,2).join(" • ")})` : "";
    return `È una sosta “vera” e locale${extra}: più scoperta che “solito posto”.`;
  }

  if (cat === "tramonto" && isView) return "Punto luce: quando il sole cala cambia tutto. È il tipo di posto che ti rimane in testa.";
  if (cat === "natura" && isWater) return "Qui l’aria cambia: acqua, frescura e atmosfera. Mini-fuga con effetto wow.";
  if (cat === "natura" && isCave) return "È ‘strano’ nel modo giusto: una sorpresa naturale che sembra lontana, invece è qui.";
  if (cat === "2h" && isHist) return "Storia senza caos: scenografia vera, perfetta per un’uscita che diventa racconto.";
  if (cat === "1h") return "È un wow rapido: vai, respiri, foto, e torni con la sensazione di aver fatto qualcosa di diverso.";
  if (cat === "relax") return "Reset pulito: ti stacca senza chiederti organizzazione o sbatti.";
  if (cat === "famiglia" && (isPark || t.tourism === "theme_park" || t.tourism === "zoo"))
    return "Family nel senso giusto: spazio e stimoli reali, senza ‘riempire’ per forza la giornata.";
  if (cat === "pioggia" && (isMuseum || isHist))
    return "Quando piove, qui non rovini l’uscita: è ‘coperto’ (o visitabile) e resta interessante.";

  // bici/moto “soft”
  if (cat === "bici") return "Giro semplice ma con vista/obiettivo: ti dà quella sensazione di mini-avventura senza diventare impegnativo.";
  if (cat === "moto") return "Strada o spot con vibe panoramica: perfetto per un giro ‘bello’ senza finire nel solito.";
  return `Micro-meta poco ovvia: abbastanza speciale da valere l’uscita, abbastanza vicina da farla anche al volo.`;
}

function scoreWow(el){
  const t = el.tags || {};
  let s = 0;

  // wow naturali
  if (t.tourism === "viewpoint") s += 44;
  if (t.waterway === "waterfall" || t.natural === "waterfall") s += 52;
  if (t.natural === "cave_entrance" || t.natural === "cave") s += 38;
  if (t.natural === "spring" || t.leisure === "spa") s += 22;

  // storia
  if (["ruins","castle","fort","archaeological_site"].includes(String(t.historic||""))) s += 30;

  // bici/moto
  if (isBiciCandidate(t)) s += 18;
  if (isMotoCandidate(t)) s += 18;

  // food
  if (isFood(t)){
    s += 28;
    if (t.tourism === "winery") s += 14;
    if (t.craft === "brewery" || t.craft === "distillery") s += 12;
    if (t.shop === "cheese" || t.shop === "bakery" || t.shop === "farm_shop" || t.shop === "deli") s += 10;
    if (t.amenity === "ice_cream" || t.shop === "pastry") s += 8;
    const c = lc(t.cuisine);
    if (c) s += 8;
    if (c && !["pizza","burger","kebab","italian"].includes(c)) s += 6;
  }

  // anti-famoso: wiki abbassa ma NON uccide (soft)
  if (hasWiki(t)) s -= 18;

  // brand/catene -> quasi zero (ma comunque filtrate prima)
  if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) s -= 60;

  const name = norm(t.name);
  if (name.length >= 10) s += 4;

  // random jitter
  s += Math.random() * 8;
  return s;
}

// ---------- URLS ----------
function mapsSearchUrl(q){
  const query = norm(q);
  if (!query) return "";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function buildInfoUrl(t){
  // Se c’è website, usa quello. Altrimenti Maps search.
  const website = norm(t.website) || norm(t.url) || norm(t.contact?.website);
  if (website) return website;
  const q = [t.name, t["addr:city"], "Abruzzo"].filter(Boolean).join(" ");
  return mapsSearchUrl(q);
}

// ---------- Queries ----------
function overpassQueryCoreWow(b){
  // WOW/relax/family/tramonto/natura/pioggia/1h/2h (core)
  return `
[out:json][timeout:180];
(
  nwr["tourism"="viewpoint"](${b.s},${b.w},${b.n},${b.e});
  nwr["waterway"="waterfall"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="waterfall"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="spring"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="spa"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="cave_entrance"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="cave"](${b.s},${b.w},${b.n},${b.e});

  nwr["historic"="ruins"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="castle"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="fort"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="archaeological_site"](${b.s},${b.w},${b.n},${b.e});
  nwr["man_made"="bridge"](${b.s},${b.w},${b.n},${b.e});
  way["bridge"](${b.s},${b.w},${b.n},${b.e});

  nwr["boundary"="protected_area"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="nature_reserve"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="park"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="zoo"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="theme_park"](${b.s},${b.w},${b.n},${b.e});

  // pioggia / indoor
  nwr["tourism"="museum"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="theatre"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="arts_centre"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="cinema"]["name"](${b.s},${b.w},${b.n},${b.e});
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
  nwr["shop"="butcher"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["shop"="bakery"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["shop"="pastry"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["shop"="confectionery"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["shop"="wine"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["shop"="beverages"]["name"](${b.s},${b.w},${b.n},${b.e});
);
out center tags;
`;
}

function overpassQueryBici(b){
  // “Segnali bici”: track/cycleway + sport=cycling + route=bicycle (best effort)
  return `
[out:json][timeout:180];
(
  nwr["highway"="cycleway"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["cycleway"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["sport"="cycling"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="track"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["route"="bicycle"]["name"](${b.s},${b.w},${b.n},${b.e});
);
out center tags;
`;
}

function overpassQueryMoto(b){
  // “Segnali moto”: passi + viewpoint + nomi “panoramica/passo/valico”
  return `
[out:json][timeout:180];
(
  nwr["mountain_pass"="yes"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="viewpoint"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="peak"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="cliff"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["man_made"="bridge"]["name"](${b.s},${b.w},${b.n},${b.e});
);
out center tags;
`;
}

// ---------- Overpass fetch (robust) ----------
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

// ---------- tiling ----------
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

// ---------- Build idea (FORMATO VERONA) ----------
function buildIdea(el){
  const t = el.tags || {};
  const center = getCenter(el);
  if (!center) return null;

  const name = norm(t.name);
  if (!name) return null;

  const cat = classify(t);
  const why = buildWhy(t, cat);
  const wow = scoreWow(el);

  const city = norm(t["addr:city"] || t["is_in:city"] || t["addr:suburb"] || "");
  const info_url = buildInfoUrl(t);

  // FORMATO VERONA: campi “puliti”
  return {
    id: `mf_ab_wow_${el.type}_${el.id}`,
    title: name,
    place: name,
    city,
    region: "Abruzzo",
    country_code: "IT",
    lat: Number(center.lat),
    lon: Number(center.lon),
    category: cat,
    duration_bucket: durationBucket(cat),
    duration_min: durationFor(cat),
    why,
    info_url,
    wow_score: Math.round(wow),
    repeatable: true,
    source: "osm_overpass"
  };
}

// ---------- Selection (balanced) ----------
function shuffle(a){
  for (let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function balancedPick(ideas, target, minPerCat){
  const byCat = new Map();
  for (const it of ideas){
    const c = it.category || "natura";
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(it);
  }

  // ordina per wow_score discendente in ogni categoria
  for (const [c, arr] of byCat.entries()){
    arr.sort((a,b)=> (b.wow_score||0)-(a.wow_score||0));
  }

  const out = [];
  const seen = new Set();

  function takeFrom(cat, n){
    const arr = byCat.get(cat) || [];
    let k = 0;
    for (const it of arr){
      if (out.length >= target) break;
      if (k >= n) break;
      const key = lc(it.title);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(it);
      k++;
    }
  }

  // 1) minimi per categoria
  const cats = Object.keys(minPerCat);
  for (const c of cats){
    takeFrom(c, minPerCat[c] || 0);
  }

  // 2) riempi fino a target: prendi a round-robin dalle categorie migliori
  const poolCats = cats.slice();
  shuffle(poolCats);

  while (out.length < target){
    let progressed = false;
    for (const c of poolCats){
      if (out.length >= target) break;
      const arr = byCat.get(c) || [];
      // prendi il primo non ancora preso
      const it = arr.find(x => !seen.has(lc(x.title)));
      if (!it) continue;
      seen.add(lc(it.title));
      out.push(it);
      progressed = true;
    }
    if (!progressed) break;
  }

  // 3) se ancora corto: usa natura come tappabuchi
  if (out.length < target){
    takeFrom("natura", target - out.length);
  }

  return out.slice(0, target);
}

// ---------- main ----------
async function main(){
  const outPath = path.join(process.cwd(), "public/data/mai_fatto/mai_fatto_it_abruzzo.json");

  const stats = {
    region: "Abruzzo",
    bbox: ABRUZZO_BBOX,
    grid: GRID,
    endpoints: ENDPOINTS,
    tiles_total: 0,
    tiles_ok: 0,
    tiles_fail: 0,
    total_candidates: 0,
    total_after_filters: 0,
    out_count: 0,
  };

  try{
    console.log("BUILD MAI FATTO ABRUZZO (FORMATO VERONA) — endpoints:", ENDPOINTS);
    console.log("GRID:", GRID.cols, "x", GRID.rows);

    const tiles = tilesForBBox(ABRUZZO_BBOX, GRID);
    const tilesToRun = MAX_TILES ? tiles.slice(0, MAX_TILES) : tiles;
    stats.tiles_total = tilesToRun.length;

    const map = new Map();

    let idx = 0;
    for (const tile of tilesToRun){
      idx++;
      console.log(`Tile ${idx}/${tilesToRun.length} ...`);

      // core wow
      try{
        const j = await overpassFetch(overpassQueryCoreWow(tile));
        const els = Array.isArray(j?.elements) ? j.elements : [];
        for (const el of els){
          if (!el?.tags?.name) continue;
          if (isBadElement(el)) continue;
          map.set(dedupeKey(el), el);
        }
        stats.tiles_ok++;
      } catch(e){
        stats.tiles_fail++;
        console.warn("⚠️ Tile CORE failed:", e.message);
      }

      await sleep(SLEEP_MS_BASE);

      // food
      try{
        const j = await overpassFetch(overpassQueryFood(tile));
        const els = Array.isArray(j?.elements) ? j.elements : [];
        for (const el of els){
          if (!el?.tags?.name) continue;
          if (isBadElement(el)) continue;
          map.set(dedupeKey(el), el);
        }
      } catch(e){
        console.warn("⚠️ Tile FOOD failed:", e.message);
      }

      await sleep(SLEEP_MS_BASE);

      // bici
      try{
        const j = await overpassFetch(overpassQueryBici(tile));
        const els = Array.isArray(j?.elements) ? j.elements : [];
        for (const el of els){
          if (!el?.tags?.name) continue;
          if (isBadElement(el)) continue;
          map.set(dedupeKey(el), el);
        }
      } catch(e){
        console.warn("⚠️ Tile BICI failed:", e.message);
      }

      await sleep(SLEEP_MS_BASE);

      // moto
      try{
        const j = await overpassFetch(overpassQueryMoto(tile));
        const els = Array.isArray(j?.elements) ? j.elements : [];
        for (const el of els){
          if (!el?.tags?.name) continue;
          if (isBadElement(el)) continue;
          map.set(dedupeKey(el), el);
        }
      } catch(e){
        console.warn("⚠️ Tile MOTO failed:", e.message);
      }

      await sleep(SLEEP_MS_BASE);
    }

    const all = Array.from(map.values());
    stats.total_candidates = all.length;
    console.log("Raw candidates:", all.length);

    // filtro “soft”: NON buttiamo via tutto. Wiki abbassa score, ma teniamo un po' se serve.
    let filtered = all;

    // togli roba troppo scarsa (nome mini)
    filtered = filtered.filter(el => norm(el?.tags?.name).length >= 5);

    // se vuoi super-soft, commenta questa riga:
    // filtered = filtered.filter(el => !hasWiki(el.tags || {}));

    stats.total_after_filters = filtered.length;
    console.log("After base filters:", filtered.length);

    // costruisci idee
    const built = [];
    const seen = new Set();

    for (const el of filtered){
      const idea = buildIdea(el);
      if (!idea) continue;
      const key = lc(idea.title);
      if (seen.has(key)) continue;
      seen.add(key);
      built.push(idea);
    }

    // ordina per wow
    built.sort((a,b)=> (b.wow_score||0)-(a.wow_score||0));

    // pick bilanciato
    const picked = balancedPick(built, TARGET_IDEAS, MIN_PER_CAT);
    stats.out_count = picked.length;

    const out = {
      updated_at: new Date().toISOString(),
      count: picked.length,
      area: "Abruzzo • Mai fatto (WOW bilanciato) • formato Verona",
      ideas: picked
    };

    writeJSON(outPath, out);
    console.log("✅ Wrote:", outPath);
    console.log("Ideas:", picked.length);

  } catch(e){
    console.error("FATAL:", e);

    const out = {
      updated_at: new Date().toISOString(),
      count: 0,
      area: "Abruzzo • build FAILED (placeholder scritto comunque)",
      ideas: []
    };

    writeJSON(outPath, out);
    console.log("✅ Wrote placeholder:", outPath);
    process.exit(0);
  }
}

main();
