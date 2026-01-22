// scripts/build_maifatto_it_tiles.mjs
// Output:
//  - public/data/mai_fatto/tiles/it/it_10x10_index.json
//  - public/data/mai_fatto/tiles/it/it_10x10_y{yy}_x{xx}.json
//
// Node 20+ (fetch nativo)

import fs from "fs";
import path from "path";

const OVERPASS = process.env.OVERPASS_ENDPOINT || "https://overpass-api.de/api/interpreter";
const SLEEP_MS = Number(process.env.SLEEP_MS || 1200);
const GRID_COLS = Number(process.env.GRID_COLS || 10);
const GRID_ROWS = Number(process.env.GRID_ROWS || 10);
const PER_TILE_MAX = Number(process.env.PER_TILE_MAX || 350); // limite per tile (mobile-safe)

// Italia bbox approx (W,S,E,N)
const IT_BBOX = { w: 6.5, s: 36.0, e: 18.7, n: 47.2 };

const OUT_DIR = path.join(process.cwd(), "public/data/mai_fatto/tiles/it");
const INDEX_PATH = path.join(process.cwd(), "public/data/mai_fatto/tiles/it/it_10x10_index.json");

const BAD_WORDS = [
  "outlet","shopping","iper","supermerc","lidl","esselunga","coop","conad","eurospin",
  "md","pam","carrefour","ikea","leroy merlin","centro commerciale","parco commerciale",
  "autogrill","mc don","mcdon","burger king","kfc","starbucks"
];

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function mkdirp(p){ fs.mkdirSync(p, { recursive:true }); }
function writeJSON(p, obj){
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}
function norm(s){ return String(s||"").trim(); }
function hasBadWords(name){
  const n = norm(name).toLowerCase();
  if (!n) return false;
  return BAD_WORDS.some(w => n.includes(w));
}
function hasWiki(tags){ return Boolean(tags?.wikipedia || tags?.wikidata); }
function getCenter(el){
  if (typeof el.lat==="number" && typeof el.lon==="number") return { lat:el.lat, lon:el.lon };
  if (el.center && typeof el.center.lat==="number" && typeof el.center.lon==="number") return { lat:el.center.lat, lon:el.center.lon };
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

  if (t.tourism==="hotel" || t.tourism==="motel" || t.tourism==="hostel") return true;

  return false;
}

function isFood(t){
  const amen = String(t.amenity || "");
  const shop = String(t.shop || "");
  const craft = String(t.craft || "");
  const tourism = String(t.tourism || "");
  const cuisine = norm(t.cuisine);

  if (["restaurant","pub","cafe","bar","fast_food","ice_cream","biergarten"].includes(amen)) return true;
  if (tourism==="winery") return true;
  if (amen==="marketplace") return true;

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

function classify(t){
  if (isFood(t)) return "mangiare";

  if (t.tourism==="viewpoint") return "tramonto";
  if (t.waterway==="waterfall" || t.natural==="waterfall") return "natura";
  if (t.natural==="cave_entrance" || t.natural==="cave") return "natura";
  if (t.natural==="peak" || t.natural==="cliff" || t.natural==="ridge") return "tramonto";
  if (t.natural==="spring") return "relax";
  if (t.boundary==="protected_area" || t.leisure==="nature_reserve") return "natura";

  if (["ruins","castle","fort","archaeological_site"].includes(String(t.historic||""))) return "2h";
  if (t.man_made==="bridge" || t.bridge) return "1h";

  if (t.tourism==="zoo" || t.tourism==="theme_park") return "famiglia";
  if (t.leisure==="park" && t.name) return "famiglia";

  return "natura";
}

function durationFor(cat){
  const r = Math.random();
  const ranges = {
    "1h":[45,85],
    "2h":[95,160],
    "relax":[45,95],
    "famiglia":[70,150],
    "bici":[55,120],
    "moto":[70,160],
    "natura":[70,170],
    "pioggia":[45,90],
    "tramonto":[55,110],
    "mangiare":[70,160],
  };
  const [a,b] = ranges[cat] || [60,120];
  return Math.round(a + (b-a)*r);
}

function buildWhy(t, cat){
  const hasView = (t.tourism==="viewpoint" || t.natural==="peak" || t.natural==="cliff");
  const isWater = (t.waterway==="waterfall" || t.natural==="waterfall" || t.natural==="spring");
  const isCave = (t.natural==="cave_entrance" || t.natural==="cave");
  const isRuins = ["ruins","castle","fort","archaeological_site"].includes(String(t.historic||""));
  const isBridge = (t.man_made==="bridge" || t.bridge);

  if (cat==="mangiare"){
    const cue = [];
    if (t.tourism==="winery" || t.shop==="wine") cue.push("vino locale");
    if (t.craft==="brewery") cue.push("birra artigianale");
    if (t.shop==="cheese") cue.push("caseificio");
    if (t.shop==="bakery") cue.push("forno");
    if (t.amenity==="ice_cream") cue.push("gelato artigianale");
    if (t.amenity==="marketplace") cue.push("mercato");
    const extra = cue.length ? ` (${cue.slice(0,2).join(" • ")})` : "";
    return `Sembra un posto “da gente del posto”${extra}: spesso non è nel giro ovvio, e ti dà quella sensazione di scoperta vera.`;
  }

  if (cat==="tramonto" && hasView) return "È un punto panoramico spesso fuori dal giro ovvio: quando la luce cambia, fa proprio scena.";
  if (cat==="natura" && isWater) return "Qui l’acqua fa differenza: atmosfera immediata e sensazione di mini-fuga che sorprende.";
  if (cat==="natura" && isCave) return "È una sorpresa naturale rara: sembra lontana, invece è qui.";
  if (cat==="2h" && isRuins) return "È storia senza folla: scenografia vera e silenzio, perfetta da raccontare.";
  if (cat==="1h" && isBridge) return "È una piccola meraviglia che tanti attraversano senza notare: wow rapido e pulito.";
  if (cat==="relax") return "È un posto semplice ma non ovvio: ti stacca senza bisogno di organizzare niente.";
  if (cat==="famiglia") return "È family nel senso giusto: spazio e stimoli reali, senza turismo di massa.";

  return "È una micro-meta poco ovvia: abbastanza speciale da valere l’uscita, abbastanza vicina da farla anche al volo.";
}

function scoreWow(el){
  const t = el.tags || {};
  let s = 0;

  if (t.tourism==="viewpoint") s += 40;
  if (t.waterway==="waterfall" || t.natural==="waterfall") s += 55;
  if (t.natural==="cave_entrance" || t.natural==="cave") s += 40;
  if (["ruins","castle","fort","archaeological_site"].includes(String(t.historic||""))) s += 30;
  if (t.man_made==="bridge" || t.bridge) s += 14;
  if (t.natural==="spring") s += 20;

  if (isFood(t)){
    s += 26;
    if (t.tourism==="winery") s += 12;
    if (t.craft==="brewery" || t.craft==="distillery") s += 12;
    if (t.shop==="cheese" || t.shop==="bakery" || t.shop==="farm_shop" || t.shop==="deli") s += 10;
    if (t.amenity==="ice_cream" || t.shop==="pastry") s += 8;

    const c = norm(t.cuisine).toLowerCase();
    if (c) s += 8;
    if (c && !["pizza","burger","kebab","italian"].includes(c)) s += 6;
  }

  // anti-famosi
  if (hasWiki(t)) s -= 45;
  if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) s -= 45;

  const name = norm(t.name);
  if (name.length >= 10) s += 4;

  s += Math.random() * 10;
  return s;
}

function overpassQuery(b){
  return `
[out:json][timeout:180];
(
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

  nwr["tourism"="zoo"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="theme_park"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="park"]["name"](${b.s},${b.w},${b.n},${b.e});

  // FOOD
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

async function overpassFetch(query){
  const r = await fetch(OVERPASS, {
    method:"POST",
    headers:{ "content-type":"application/x-www-form-urlencoded;charset=UTF-8" },
    body:"data=" + encodeURIComponent(query),
  });
  if (!r.ok){
    const text = await r.text().catch(()=> "");
    throw new Error(`Overpass HTTP ${r.status}: ${text.slice(0,160)}`);
  }
  return await r.json();
}

function tilesForBBox(bbox, cols, rows){
  const tiles = [];
  const dx = (bbox.e - bbox.w) / cols;
  const dy = (bbox.n - bbox.s) / rows;
  for (let y=0; y<rows; y++){
    for (let x=0; x<cols; x++){
      const w = bbox.w + dx * x;
      const e = bbox.w + dx * (x+1);
      const s = bbox.s + dy * y;
      const n = bbox.s + dy * (y+1);
      tiles.push({ x, y, w, s, e, n });
    }
  }
  return tiles;
}

function buildIdea(el){
  const t = el.tags || {};
  const center = getCenter(el);
  if (!center) return null;

  const name = norm(t.name);
  if (!name) return null;

  if (isBadElement(el)) return null;

  const cat = classify(t);
  const why = buildWhy(t, cat);

  // link "cosa c'è" (Google Maps query pronta)
  const info_url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}`;

  return {
    id: `it_${el.type}_${el.id}`,
    title: name,
    place: name,
    city: t["addr:city"] || t["is_in:city"] || "",
    region: t["addr:state"] || "",
    country_code: "IT",
    lat: Number(center.lat),
    lon: Number(center.lon),
    category: cat,
    duration_bucket: (cat==="2h" ? "2h" : "1h"),
    duration_min: durationFor(cat),
    why,
    info_url,
    wow_score: Math.round(scoreWow(el)),
    repeatable: true,
    source: "osm_overpass"
  };
}

function tileFileName(x, y){
  const yy = String(y).padStart(2,"0");
  const xx = String(x).padStart(2,"0");
  return `it_${GRID_COLS}x${GRID_ROWS}_y${yy}_x${xx}.json`;
}

async function main(){
  console.log("BUILD MAI FATTO IT TILES — endpoint:", OVERPASS);
  mkdirp(OUT_DIR);

  const tiles = tilesForBBox(IT_BBOX, GRID_COLS, GRID_ROWS);
  console.log("Tiles:", tiles.length, `(grid ${GRID_COLS}x${GRID_ROWS})`);

  const index = {
    updated_at: new Date().toISOString(),
    grid: { cols: GRID_COLS, rows: GRID_ROWS },
    bbox: IT_BBOX,
    per_tile_max: PER_TILE_MAX,
    tiles: []
  };

  let done = 0;

  for (const tile of tiles){
    done++;
    console.log(`Tile ${done}/${tiles.length} y=${tile.y} x=${tile.x}`);

    const q = overpassQuery(tile);
    let elements = [];
    try {
      const json = await overpassFetch(q);
      elements = Array.isArray(json?.elements) ? json.elements : [];
    } catch (e){
      console.warn("⚠️ Overpass tile error:", e.message);
      // scrivi tile vuota per coerenza
      const outPath = path.join(OUT_DIR, tileFileName(tile.x, tile.y));
      writeJSON(outPath, { updated_at: new Date().toISOString(), count: 0, tile: {x:tile.x,y:tile.y}, ideas: [] });
      index.tiles.push({ x: tile.x, y: tile.y, file: `./${tileFileName(tile.x, tile.y)}`, count: 0 });
      await sleep(SLEEP_MS);
      continue;
    }

    // build + filtro anti-wiki duro (per sconosciuti)
    const built = [];
    const seen = new Set();

    for (const el of elements){
      if (!el?.tags?.name) continue;
      if (hasWiki(el.tags || {})) continue; // taglia famosi
      const idea = buildIdea(el);
      if (!idea) continue;

      const k = idea.title.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);

      built.push({ idea, score: idea.wow_score || 0 });
    }

    built.sort((a,b) => (b.score||0) - (a.score||0));
    const ideas = built.slice(0, PER_TILE_MAX).map(x => x.idea);

    const out = {
      updated_at: new Date().toISOString(),
      count: ideas.length,
      tile: { x: tile.x, y: tile.y, bbox: { w: tile.w, s: tile.s, e: tile.e, n: tile.n } },
      ideas
    };

    const outPath = path.join(OUT_DIR, tileFileName(tile.x, tile.y));
    writeJSON(outPath, out);

    index.tiles.push({
      x: tile.x, y: tile.y,
      file: `./${tileFileName(tile.x, tile.y)}`,
      count: ideas.length
    });

    await sleep(SLEEP_MS);
  }

  writeJSON(INDEX_PATH, index);
  console.log("✅ Wrote index:", INDEX_PATH);
}

main().catch((e)=>{ console.error("FATAL:", e); process.exit(1); });
