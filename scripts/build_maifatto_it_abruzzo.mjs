// scripts/build_maifatto_it_abruzzo.mjs
// Output: public/data/mai_fatto/mai_fatto_it_abruzzo.json
//
// ✅ ROBUST • MULTI-OVERPASS • RETRY/BACKOFF • FOOD-RICH • WOW • FAMILY • BICI/MOTO/PIOGGIA/TRAMONTO
// Node 20+ (fetch nativo)

import fs from "fs";
import path from "path";

const ENDPOINTS = [
  process.env.OVERPASS_ENDPOINT,
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
].filter(Boolean);

const SLEEP_MS_BASE = Number(process.env.SLEEP_MS || 1200);
const MAX_TILES = process.env.MAX_TILES ? Number(process.env.MAX_TILES) : null;

const GRID = {
  cols: Number(process.env.GRID_COLS || 5),
  rows: Number(process.env.GRID_ROWS || 5),
};

// Abruzzo bbox approx (W,S,E,N)
const ABRUZZO_BBOX = { w: 13.05, s: 41.65, e: 14.85, n: 42.95 };

const TARGET_IDEAS = Number(process.env.TARGET_IDEAS || 3200);

// parole da tagliare (brand/centri commerciali)
const BAD_WORDS = [
  "outlet","shopping","iper","supermerc","lidl","esselunga","coop","conad","eurospin",
  "md","pam","carrefour","ikea","leroy merlin","centro commerciale","parco commerciale",
  "autogrill","mcdon","mc don","burger king","kfc","starbucks"
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

  // evita roba non-idea
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

// ---------- CATEGORY CLASSIFIER (mai fatto)
function classify(tags){
  const t = tags || {};

  // FOOD
  if (isFood(t)) return "food";

  // TRAMONTO / VIEW
  if (t.tourism === "viewpoint") return "tramonto";
  if (t.natural === "peak" || t.natural === "cliff" || t.natural === "ridge") return "tramonto";

  // PIOGGIA (cose al coperto / musei / grotte visitabili / castelli)
  const tourism = String(t.tourism || "");
  const amen = String(t.amenity || "");
  const historic = String(t.historic || "");
  if (tourism === "museum" || amen === "theatre" || amen === "cinema") return "pioggia";
  if (historic === "castle" || historic === "ruins" || historic === "fort" || historic === "archaeological_site") return "pioggia";
  if (t.natural === "cave_entrance" || t.natural === "cave") return "pioggia";

  // FAMILY
  if (tourism === "zoo" || tourism === "theme_park") return "family";
  if (t.leisure === "park" && t.name) return "family";

  // RELAX
  if (t.natural === "spring") return "relax";
  if (amen === "spa" || amen === "sauna") return "relax";
  if (t.leisure === "nature_reserve") return "relax";

  // NATURA
  if (t.waterway === "waterfall" || t.natural === "waterfall") return "natura";
  if (t.boundary === "protected_area") return "natura";

  // BICI / MOTO (routing “leggero”: greenways/piste/ciclabili + passi)
  if (t.highway === "cycleway" || t.route === "bicycle" || t.network === "rcn" || t.network === "lcn") return "bici";
  if (t.natural === "pass" || t.mountain_pass === "yes" || t.highway === "path") return "moto";

  // fallback
  return "natura";
}

function durationBucketFor(cat){
  // in UI ti servono 1h / 2h + categorie.
  // Manteniamo 1h/2h coerente: food spesso 2h, tramonto 1h, bici/moto 2h, ecc.
  if (cat === "tramonto" || cat === "pioggia" || cat === "relax") return "1h";
  return "2h";
}

function durationFor(cat){
  const r = Math.random();
  const ranges = {
    "1h":[45,85],
    "2h":[95,160],
    "relax":[50,100],
    "family":[70,150],
    "bici":[70,150],
    "moto":[85,170],
    "natura":[80,170],
    "pioggia":[60,120],
    "tramonto":[55,110],
    "food":[80,170],
  };
  const [a,b] = ranges[cat] || [60,120];
  return Math.round(a + (b-a)*r);
}

function buildWhy(tags, cat){
  const t = tags || {};
  if (cat === "food"){
    const hint = [];
    if (t.tourism === "winery" || t.shop === "wine") hint.push("vino locale");
    if (t.craft === "brewery") hint.push("birra artigianale");
    if (t.shop === "cheese") hint.push("caseificio");
    if (t.shop === "bakery") hint.push("forno");
    if (t.amenity === "ice_cream") hint.push("gelato artigianale");
    const extra = hint.length ? ` (${hint.slice(0,2).join(" • ")})` : "";
    return `È una tappa “vera” e locale${extra}: spesso non è nei giri più ovvi e ti dà la sensazione di scoperta.`;
  }
  if (cat === "tramonto") return "È un punto luce: quando cambia il cielo, diventa una scena che ti resta addosso.";
  if (cat === "pioggia") return "È perfetto quando il meteo rompe: posto interessante anche al coperto o con visita ‘protetta’.";
  if (cat === "bici") return "È una pedalata semplice ma soddisfacente: ti sembra un’avventura senza essere una fatica.";
  if (cat === "moto") return "È una strada/spot che ‘scorre’: panorama e curve giuste, senza finire nel solito giro.";
  if (cat === "family") return "È family nel senso buono: spazio e stimoli veri, senza dover organizzare mezza giornata.";
  if (cat === "relax") return "È un reset pulito: atmosfera tranquilla, zero caos, ti rimette in pace.";
  return "È una micro-meta poco ovvia: abbastanza speciale da valere l’uscita, abbastanza vicina da farla anche al volo.";
}

function scoreWow(el){
  const t = el.tags || {};
  let s = 0;

  if (t.tourism === "viewpoint") s += 40;
  if (t.waterway === "waterfall" || t.natural === "waterfall") s += 55;
  if (t.natural === "cave_entrance" || t.natural === "cave") s += 35;

  const historic = String(t.historic || "");
  if (["ruins","castle","fort","archaeological_site"].includes(historic)) s += 22;

  if (isFood(t)){
    s += 28;
    if (t.tourism === "winery") s += 12;
    if (t.craft === "brewery" || t.craft === "distillery") s += 10;
    if (t.shop === "cheese" || t.shop === "bakery" || t.shop === "farm_shop") s += 10;
    if (t.amenity === "ice_cream" || t.shop === "pastry") s += 6;
  }

  // anti-ovvio soft: wiki penalizza ma non elimina
  if (hasWiki(t)) s -= 25;

  // brand penalizza forte
  if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) s -= 50;

  const name = norm(t.name);
  if (name.length >= 10) s += 4;

  s += Math.random() * 10;
  return s;
}

// --- Query spezzate: (A) WOW+FAMILY+TRAMONTO+PIOGGIA   (B) FOOD
function overpassQueryA(b){
  return `
[out:json][timeout:180];
(
  // WOW / NATURA / TRAMONTO
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

  // FAMILY
  nwr["tourism"="zoo"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="theme_park"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="park"]["name"](${b.s},${b.w},${b.n},${b.e});

  // PIOGGIA / CULTURA / CASTELLI
  nwr["tourism"="museum"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="theatre"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="cinema"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="castle"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="ruins"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="fort"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="archaeological_site"](${b.s},${b.w},${b.n},${b.e});

  // BICI
  nwr["highway"="cycleway"](${b.s},${b.w},${b.n},${b.e});
  nwr["route"="bicycle"](${b.s},${b.w},${b.n},${b.e});

  // MOTO / PASSI
  nwr["natural"="pass"](${b.s},${b.w},${b.n},${b.e});
  nwr["mountain_pass"="yes"](${b.s},${b.w},${b.n},${b.e});
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

// --- Overpass robust fetch: endpoint fallback + retry
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
  const bucket = durationBucketFor(cat);

  return {
    id: `mf_abruzzo_${el.type}_${el.id}`,
    title: name,
    place: name,
    city: t["addr:city"] || t["is_in:city"] || "",
    region: "Abruzzo",
    country_code: "IT",
    lat: Number(center.lat),
    lon: Number(center.lon),

    // IMPORTANT: categorie attese dalla UI “mai fatto”
    category: cat,                 // food / tramonto / pioggia / bici / moto / family / natura / relax
    duration_bucket: bucket,       // 1h / 2h
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
  console.log("BUILD MAI FATTO ABRUZZO (ROBUST) — endpoints:", ENDPOINTS);
  console.log("GRID:", GRID.cols, "x", GRID.rows);

  const tiles = tilesForBBox(ABRUZZO_BBOX, GRID);
  const tilesToRun = MAX_TILES ? tiles.slice(0, MAX_TILES) : tiles;
  console.log("Tiles:", tilesToRun.length);

  const map = new Map();
  let okA = 0;
  let failA = 0;
  let okFood = 0;
  let failFood = 0;

  let idx = 0;
  for (const tile of tilesToRun){
    idx++;
    console.log(`Tile ${idx}/${tilesToRun.length} ...`);

    // A) WOW+FAMILY+TRAMONTO+PIOGGIA+BICI+MOTO
    try{
      const jsonA = await overpassFetch(overpassQueryA(tile));
      const elsA = Array.isArray(jsonA?.elements) ? jsonA.elements : [];
      for (const el of elsA){
        if (!el?.tags?.name) continue;
        if (isBadElement(el)) continue;
        const k = dedupeKey(el);
        if (!map.has(k)) map.set(k, el);
      }
      okA++;
    } catch(e){
      failA++;
      console.warn("⚠️ Tile A failed:", e.message);
    }

    await sleep(SLEEP_MS_BASE);

    // B) FOOD
    try{
      const jsonB = await overpassFetch(overpassQueryFood(tile));
      const elsB = Array.isArray(jsonB?.elements) ? jsonB.elements : [];
      for (const el of elsB){
        if (!el?.tags?.name) continue;
        if (isBadElement(el)) continue;
        const k = dedupeKey(el);
        if (!map.has(k)) map.set(k, el);
      }
      okFood++;
    } catch(e){
      failFood++;
      console.warn("⚠️ Tile FOOD failed:", e.message);
    }

    await sleep(SLEEP_MS_BASE);
  }

  const all = Array.from(map.values());
  console.log("Raw candidates:", all.length, "| okA:", okA, "failA:", failA, "| okFood:", okFood, "failFood:", failFood);

  // anti-ovvio soft: prima senza wiki, se troppo poco reintroduce
  let filtered = all.filter(el => !hasWiki(el.tags || {}));
  console.log("After no-wiki filter:", filtered.length);

  if (filtered.length < 600){
    console.log("Low pool, softening filter -> using all");
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
    area: "Abruzzo — WOW + Food ricchissimo (robust build)",
    stats: {
      region: "Abruzzo",
      bbox: ABRUZZO_BBOX,
      grid: GRID,
      tiles_total: tilesToRun.length,
      tiles_ok_A: okA,
      tiles_failed_A: failA,
      tiles_ok_food: okFood,
      tiles_failed_food: failFood,
      endpoints: ENDPOINTS
    },
    ideas
  };

  const outPath = path.join(process.cwd(), "public/data/mai_fatto/mai_fatto_it_abruzzo.json");
  writeJSON(outPath, out);

  console.log("✅ Wrote:", outPath);
  console.log("Ideas:", ideas.length);
}

main().catch((e)=>{
  console.error("FATAL:", e);
  process.exit(1);
});
