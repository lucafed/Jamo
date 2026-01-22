// scripts/build_maifatto_it_abruzzo.mjs
// Output: public/data/mai_fatto/mai_fatto_it_abruzzo.json
// Node 20+ (fetch nativo)

import fs from "fs";
import path from "path";

// --- Overpass endpoints (fallback automatico) ---
const OVERPASS_ENDPOINTS = [
  process.env.OVERPASS_ENDPOINT || "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

const SLEEP_MS = Number(process.env.SLEEP_MS || 1200);
const MAX_TILES = process.env.MAX_TILES ? Number(process.env.MAX_TILES) : null;

// Abruzzo bbox approx (W,S,E,N)
const ABRUZZO_BBOX = { w: 13.0, s: 41.65, e: 14.85, n: 42.9 };

// più piccolo per ridurre 504
const GRID = { cols: 4, rows: 4 };

// target: test “funziona davvero”
const TARGET_IDEAS = Number(process.env.TARGET_IDEAS || 2500);

// blacklist brand/commerciale (minimo indispensabile)
const BAD_WORDS = [
  "outlet", "shopping", "iper", "supermerc", "lidl", "esselunga", "coop", "conad", "eurospin",
  "md", "pam", "carrefour", "ikea", "leroy", "centro commerciale", "autogrill", "mcdon", "burger king", "kfc", "starbucks"
];

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function mkdirp(p){ fs.mkdirSync(p, { recursive: true }); }
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

  // hotel/motel/hostel fuori dal concept
  if (t.tourism === "hotel" || t.tourism === "motel" || t.tourism === "hostel") return true;

  return false;
}

// ---------- FOOD ricchissimo ----------
function isFood(tags){
  const t = tags || {};
  const amen = String(t.amenity || "");
  const shop = String(t.shop || "");
  const craft = String(t.craft || "");
  const tourism = String(t.tourism || "");
  const cuisine = norm(t.cuisine);
  const name = norm(t.name).toLowerCase();

  if (["restaurant","pub","cafe","bar","fast_food","ice_cream","biergarten"].includes(amen)) return true;
  if (amen === "marketplace") return true;

  if (tourism === "winery") return true;
  if (["brewery","distillery"].includes(craft)) return true;

  if ([
    "deli","cheese","butcher","bakery","pastry","confectionery",
    "chocolate","farm","farm_shop","greengrocer","seafood","wine","beverages"
  ].includes(shop)) return true;

  // nomi tipici
  if (name.includes("agriturismo") || name.includes("osteria") || name.includes("trattoria") || name.includes("cantina")) return true;
  if (cuisine) return true;

  return false;
}

function classify(tags){
  const t = tags || {};

  if (isFood(t)) return "mangiare";

  if (t.tourism === "viewpoint") return "tramonto";
  if (t.waterway === "waterfall" || t.natural === "waterfall") return "natura";
  if (t.natural === "cave_entrance" || t.natural === "cave") return "natura";
  if (t.natural === "peak" || t.natural === "cliff" || t.natural === "ridge") return "tramonto";
  if (t.natural === "spring") return "relax";
  if (t.boundary === "protected_area" || t.leisure === "nature_reserve") return "natura";

  if (["ruins","castle","fort","archaeological_site"].includes(String(t.historic || ""))) return "2h";
  if (t.man_made === "bridge" || t.bridge) return "1h";

  if (t.tourism === "zoo" || t.tourism === "theme_park") return "famiglia";
  if (t.leisure === "park" && t.name) return "famiglia";

  return "natura";
}

function durationFor(cat){
  const r = Math.random();
  const ranges = {
    "1h": [45, 85],
    "2h": [95, 160],
    "relax": [45, 95],
    "famiglia": [70, 150],
    "bici": [55, 120],
    "moto": [70, 160],
    "natura": [70, 170],
    "pioggia": [45, 90],
    "tramonto": [55, 110],
    "mangiare": [70, 160],
  };
  const [a,b] = ranges[cat] || [60,120];
  return Math.round(a + (b-a)*r);
}

// “title” stile Verona: hook + nome (semplice ma efficace)
function hookTitle(placeName, cat){
  const base = norm(placeName);
  const hooks = {
    natura: [
      "Un angolo naturale che sembra irreale",
      "Natura vera, lontana dal giro ovvio",
      "Un posto verde che ti resetta",
    ],
    tramonto: [
      "Un punto alto che ti fa dire “wow”",
      "Un belvedere che sembra cinema",
      "Orizzonte enorme, zero folla",
    ],
    relax: [
      "Un posto quieto che sembra tuo",
      "Pace vera (senza turismo di massa)",
      "Una sosta che ti rimette a posto",
    ],
    famiglia: [
      "Un posto dove i bambini diventano esploratori",
      "Family “giusto” (non il solito parco giochi)",
      "Avventura facile, ricordi sicuri",
    ],
    mangiare: [
      "Mangiare: locale, vero, senza teatro",
      "Food: piccola scoperta che poi consigli",
      "Una sosta golosa non mainstream",
    ],
    "1h": [
      "Un colpo di wow rapido (1 ora)",
      "Una micro-gita che vale più di quanto sembra",
      "Un’idea corta ma potente",
    ],
    "2h": [
      "Due ore che sembrano una mini-vacanza",
      "Una meta da raccontare (2 ore)",
      "Un giro “vero” senza esagerare",
    ],
  };
  const arr = hooks[cat] || ["Una meta poco ovvia che funziona"];
  const h = arr[Math.floor(Math.random()*arr.length)];
  return `${h} — ${base}`;
}

function buildWhy(tags, cat){
  const t = tags || {};
  if (cat === "mangiare") {
    const cue = [];
    if (t.tourism === "winery" || t.shop === "wine") cue.push("vino locale");
    if (t.craft === "brewery") cue.push("birra artigianale");
    if (t.shop === "cheese") cue.push("caseificio");
    if (t.shop === "bakery") cue.push("forno");
    if (t.amenity === "ice_cream") cue.push("gelato artigianale");
    if (t.amenity === "marketplace") cue.push("mercato");
    const extra = cue.length ? ` (${cue.slice(0,2).join(" • ")})` : "";
    return `È una sosta “vera” e locale${extra}: non è il posto turistico standard, è la scoperta che poi consigli.`;
  }
  if (cat === "tramonto") return "È un punto panoramico spesso fuori dal giro ovvio: quando la luce cambia, diventa una scena da ricordare.";
  if (cat === "natura") return "Qui la natura fa davvero differenza: atmosfera, aria buona, e quella sensazione di scoperta non ovvia.";
  if (cat === "relax") return "È un posto semplice ma pulito: ti stacca senza fatica e senza caos.";
  if (cat === "famiglia") return "È family nel modo giusto: stimoli reali e spazio, senza dover organizzare mille cose.";
  if (cat === "1h") return "È una micro-meta poco ovvia: breve, ma con effetto ‘wow’ vero.";
  if (cat === "2h") return "È una meta che diventa racconto: scenografia vera e sensazione da mini-gita completa.";
  return "È una meta poco ovvia: abbastanza speciale da valere l’uscita, abbastanza semplice da farla spesso.";
}

function scoreWow(el){
  const t = el.tags || {};
  let s = 0;

  if (t.tourism === "viewpoint") s += 40;
  if (t.waterway === "waterfall" || t.natural === "waterfall") s += 50;
  if (t.natural === "cave_entrance" || t.natural === "cave") s += 38;
  if (["ruins","castle","fort","archaeological_site"].includes(String(t.historic || ""))) s += 30;
  if (t.man_made === "bridge" || t.bridge) s += 14;
  if (t.natural === "spring") s += 18;

  if (isFood(t)) {
    s += 26;
    if (t.tourism === "winery") s += 12;
    if (t.craft === "brewery" || t.craft === "distillery") s += 12;
    if (t.shop === "cheese" || t.shop === "bakery" || t.shop === "farm_shop" || t.shop === "deli") s += 10;
    if (t.amenity === "ice_cream" || t.shop === "pastry") s += 8;
    const c = norm(t.cuisine).toLowerCase();
    if (c) s += 8;
    if (c && !["pizza","burger","kebab","italian"].includes(c)) s += 6;
  }

  if (hasWiki(t)) s -= 40;
  if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) s -= 40;

  const name = norm(t.name);
  if (name.length >= 10) s += 4;

  s += Math.random()*10;
  return s;
}

function overpassQuery(b){
  return `
[out:json][timeout:180];
(
  // WOW natura
  nwr["tourism"="viewpoint"](${b.s},${b.w},${b.n},${b.e});
  nwr["waterway"="waterfall"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="waterfall"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="spring"](${b.s},${b.w},${b.n},${b.e});
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

  // FAMILY
  nwr["tourism"="zoo"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="theme_park"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="park"]["name"](${b.s},${b.w},${b.n},${b.e});

  // FOOD (solo con name)
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

async function postOverpass(endpoint, query){
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "data=" + encodeURIComponent(query),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Overpass ${endpoint} HTTP ${r.status}: ${txt.slice(0,160)}`);
  }
  return await r.json();
}

async function overpassFetchWithRetry(query){
  let lastErr = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await postOverpass(endpoint, query);
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || e);
        // backoff
        const wait = 800 * attempt + Math.round(Math.random()*400);
        console.warn(`⚠️ Overpass error (attempt ${attempt}/3) on ${endpoint}: ${msg}`);
        await sleep(wait);
        // se 429/504 ecc continua a retryare
      }
    }
  }

  throw lastErr || new Error("Overpass failed on all endpoints.");
}

function tilesForBBox(bbox, grid){
  const tiles = [];
  const dx = (bbox.e - bbox.w) / grid.cols;
  const dy = (bbox.n - bbox.s) / grid.rows;
  for (let y=0; y<grid.rows; y++){
    for (let x=0; x<grid.cols; x++){
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

  const place = norm(t.name);
  if (!place) return null;

  const cat = classify(t);
  const why = buildWhy(t, cat);

  const duration_bucket = (cat === "2h" ? "2h" : "1h");
  const duration_min = durationFor(cat);

  // title “hook + place”
  const title = hookTitle(place, cat);

  // campi “come Verona”
  return {
    id: `mf_ab_${el.type}_${el.id}`,
    title,
    place,
    city: t["addr:city"] || t["is_in:city"] || t["addr:hamlet"] || "",
    region: "Abruzzo",
    country_code: "IT",
    lat: Number(center.lat),
    lon: Number(center.lon),
    category: cat,
    duration_bucket,
    duration_min,
    why,
    info_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`,
    wow_score: Math.max(1, Math.min(10, Math.round(scoreWow(el)/12))), // scala 1-10
    repeatable: true,
    source: "osm_overpass",
  };
}

function sampleTop(elements, max){
  const scored = elements.map(el => ({ el, s: scoreWow(el) }));
  scored.sort((a,b) => b.s - a.s);
  return scored.slice(0, max).map(x => x.el);
}

async function main(){
  console.log("BUILD MAI FATTO ABRUZZO — endpoints:", OVERPASS_ENDPOINTS.join(" | "));
  const tiles = tilesForBBox(ABRUZZO_BBOX, GRID);
  const tilesToRun = MAX_TILES ? tiles.slice(0, MAX_TILES) : tiles;

  console.log("Tiles:", tilesToRun.length, `(grid ${GRID.cols}x${GRID.rows})`);

  const map = new Map();
  let i = 0;

  for (const tile of tilesToRun){
    i++;
    console.log(`Tile ${i}/${tilesToRun.length} ...`);
    const q = overpassQuery(tile);

    try {
      const json = await overpassFetchWithRetry(q);
      const els = Array.isArray(json?.elements) ? json.elements : [];
      for (const el of els){
        if (!el?.tags?.name) continue;
        if (isBadElement(el)) continue;

        const key = dedupeKey(el);
        if (!map.has(key)) map.set(key, el);
        else {
          // tieni quello col punteggio più alto
          const prev = map.get(key);
          if (scoreWow(el) > scoreWow(prev)) map.set(key, el);
        }
      }
    } catch (e) {
      console.warn("⚠️ Tile error:", e.message);
    }

    await sleep(SLEEP_MS);
  }

  const all = Array.from(map.values());
  console.log("Raw candidates:", all.length);

  let filtered = all.filter(el => !hasWiki(el.tags || {}));
  console.log("After filter (no wiki):", filtered.length);

  // se troppo poco, allenta (ma score penalizza comunque wiki)
  if (filtered.length < 800) {
    console.log("Low no-wiki pool, softening filter...");
    filtered = all;
  }

  const selected = sampleTop(filtered, Math.min(TARGET_IDEAS, filtered.length));

  const ideas = [];
  const seenName = new Set();

  for (const el of selected){
    const idea = buildIdea(el);
    if (!idea) continue;

    const k = idea.place.toLowerCase();
    if (seenName.has(k)) continue;
    seenName.add(k);

    if (idea.place.length < 5) continue;
    ideas.push(idea);
  }

  const out = {
    updated_at: new Date().toISOString(),
    count: ideas.length,
    area: "Abruzzo (tutto il territorio) — WOW + Food ricchissimo (non ovvio)",
    ideas
  };

  const outPath = path.join(process.cwd(), "public/data/mai_fatto/mai_fatto_it_abruzzo.json");
  writeJSON(outPath, out);

  console.log("✅ Wrote:", outPath);
  console.log("Ideas:", ideas.length);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
