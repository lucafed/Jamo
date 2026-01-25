// scripts/build_maifatto_it_abruzzo.mjs
// Output: public/data/mai_fatto/mai_fatto_it_abruzzo.json
// ROBUST (Node20/undici) • categorie “raggiungibili/non stressanti” • quota anti-food • sempre commit (build_id)

import fs from "fs";
import path from "path";

// -------------------- CONFIG --------------------
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
const ABRUZZO_BBOX = { w: 13.0, s: 41.65, e: 14.85, n: 42.95 };

const TARGET_IDEAS = Number(process.env.TARGET_IDEAS || 2400);

// quota per categoria (anti “mangiare infinito”)
const QUOTAS = {
  tramonto: Number(process.env.Q_TRAMONTO || 280),
  natura: Number(process.env.Q_NATURA || 520),
  relax: Number(process.env.Q_RELAX || 320),
  famiglia: Number(process.env.Q_FAMIGLIA || 380),
  pioggia: Number(process.env.Q_PIOGGIA || 300),
  bici: Number(process.env.Q_BICI || 220),
  moto: Number(process.env.Q_MOTO || 220),
  mangiare: Number(process.env.Q_MANGIARE || 260),
};

const TIMEOUT_MS = Number(process.env.OVERPASS_TIMEOUT_MS || 180000);

// blacklist base (evita roba da “spesa” o brand)
const BAD_WORDS = [
  "outlet","shopping","iper","supermerc","discount","lidl","esselunga","coop","conad","eurospin",
  "md","pam","carrefour","ikea","leroy merlin","centro commerciale","parco commerciale","autogrill",
  "mcdon","mc don","burger king","kfc","starbucks","basko","delhaize",
];

// -------------------- helpers --------------------
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

// --- “non meta” / brand / servizi
function isBadElement(el){
  const t = el.tags || {};
  const name = norm(t.name);
  if (!name) return true;
  if (hasBadWords(name)) return true;

  if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) return true;

  const amen = String(t.amenity || "");
  if (["fuel","bank","atm","pharmacy","clinic","hospital","police","post_office"].includes(amen)) return true;

  if (t.tourism === "hotel" || t.tourism === "motel" || t.tourism === "hostel") return true;

  return false;
}

// -------------------- FOOD detection --------------------
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

// -------------------- Category classify (UI keys) --------------------
// Obiettivo: posti “raggiungibili / non stressanti”.
// Nota: FAMILY NON deve essere “playground ovunque”.
function classify(tags){
  const t = tags || {};
  const amen = String(t.amenity || "");
  const leisure = String(t.leisure || "");
  const tourism = String(t.tourism || "");
  const natural = String(t.natural || "");
  const waterway = String(t.waterway || "");
  const highway = String(t.highway || "");
  const route = String(t.route || "");
  const sport = String(t.sport || "");
  const man_made = String(t.man_made || "");
  const historic = String(t.historic || "");
  const name = low(t.name);

  // 1) MANGIARE
  if (isFood(t)) return "mangiare";

  // 2) TRAMONTO (easy): viewpoint / belvedere / torri panoramiche / terrazze
  if (tourism === "viewpoint") return "tramonto";
  if (man_made === "tower" && (name.includes("belvedere") || name.includes("panoram") || name.includes("torre") || name.includes("terraz"))) return "tramonto";
  // peak/cliff SOLO se “belvedere/panoramico” (evita cime stressanti)
  if (["peak","cliff","ridge","saddle"].includes(natural) && (name.includes("belvedere") || name.includes("panoram") || name.includes("vista") || name.includes("terraz"))) {
    return "tramonto";
  }

  // 3) PIOGGIA (indoor “chiaro”)
  if (tourism === "museum" || tourism === "gallery") return "pioggia";
  if (amen === "cinema" || amen === "theatre" || amen === "arts_centre") return "pioggia";
  if (amen === "library") return "pioggia";
  // centri culturali / sale civiche: ok pioggia (ma non “tutti”)
  if (amen === "community_centre" && name && (name.includes("cultur") || name.includes("muse") || name.includes("bibli") || name.includes("teatr"))) return "pioggia";

  // 4) FAMIGLIA (posti belli per bimbi, non “giochini”)
  if (tourism === "zoo" || tourism === "theme_park") return "famiglia";
  if (tourism === "attraction") return "famiglia"; // spesso: grotte visitabili, castelli visitabili, parchi tematici “soft”
  // fattorie didattiche / petting zoo / animal farm (OSM spesso così)
  if (tourism === "zoo" || t.zoo === "petting_zoo") return "famiglia";
  if (t.attraction && String(t.attraction).includes("animal")) return "famiglia";
  // parchi veri / aree verdi grandi (non playground)
  if (leisure === "park" && t.name) return "famiglia";
  // picnic site: family-friendly
  if (tourism === "picnic_site") return "famiglia";
  // sport “family-friendly” (solo alcuni)
  if (sport && ["swimming","climbing","ice_skating"].includes(sport)) return "famiglia";

  // 5) RELAX (tranquillo, facile)
  if (amen === "spa" || leisure === "sauna") return "relax";
  if (leisure === "garden") return "relax";
  if (leisure === "park" && t.name) return "relax"; // sì: relax può includere parchi (poi QUOTA decide)
  if (tourism === "picnic_site") return "relax";
  // acqua “relax” solo se non è roba “da impresa”
  if (natural === "spring" && (name.includes("font") || name.includes("sorg") || name.includes("acqua") || name.includes("fonte"))) return "relax";

  // 6) NATURA (wow naturale, ma non per forza “hard”)
  if (waterway === "waterfall" || natural === "waterfall") return "natura";
  if (natural === "cave_entrance" || natural === "cave") return "natura";
  if (t.boundary === "protected_area" || leisure === "nature_reserve") return "natura";
  if (natural === "wood" || natural === "valley" || natural === "gorge") return "natura";
  // spiagge/coste in Abruzzo ok natura
  if (natural === "beach" || natural === "coastline") return "natura";
  // storico / man_made: SOLO se “visitabile/attraction” (altrimenti è rumore)
  if (historic && (name.includes("eremo") || name.includes("abbaz") || name.includes("castell") || name.includes("forte") || name.includes("santuar"))) return "natura";
  if (man_made && (name.includes("ponte") || name.includes("gola") || name.includes("canyon"))) return "natura";

  // 7) BICI (OSM è scarso: prendiamo SOLO segnali chiari)
  if (highway === "cycleway") return "bici";
  if (route === "bicycle" || route === "mtb") return "bici";
  if (t.network && ["icn","ncn","rcn","lcn"].includes(String(t.network))) return "bici";
  if (t.bicycle === "designated") return "bici";

  // 8) MOTO (passi/valichi/forche: “giro bello”)
  if (t.mountain_pass === "yes") return "moto";
  if (name.includes("passo ")) return "moto";
  if (name.includes("valico")) return "moto";
  if (name.includes("forca ")) return "moto";

  return "natura";
}

// -------------------- duration bucket + mins --------------------
function durationBucketFor(cat){
  if (["pioggia","tramonto","mangiare"].includes(cat)) return "1h";
  return "2h";
}
function durationMinFor(cat){
  const r = Math.random();
  const ranges = {
    "1h":[45,90], "2h":[95,170],
    "relax":[55,115],
    "famiglia":[80,170],
    "bici":[70,160],
    "moto":[75,175],
    "natura":[85,180],
    "pioggia":[45,95],
    "tramonto":[55,120],
    "mangiare":[55,125],
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
    return `Sosta “vera” e locale${extra}: spesso è più autentica dei posti standard e ti fa sentire in gita anche se sei vicino.`;
  }
  if (cat === "tramonto") return "Punto luce easy: belvedere/vista/terrazza dove arrivi senza impresa e la luce fa il resto.";
  if (cat === "pioggia") return "Piano B che sembra piano A: al coperto, interessante, e ti salva la giornata quando fuori non invoglia.";
  if (cat === "famiglia") return "Family nel senso giusto: posto bello e facile dove i bimbi si divertono davvero (non ‘giochini’ a caso).";
  if (cat === "relax") return "Reset mentale: posto tranquillo e semplice, perfetto per staccare senza stress o logistica complicata.";
  if (cat === "bici") return "Giro semplice ma soddisfacente: mini-viaggio senza farti distruggere.";
  if (cat === "moto") return "Giro da moto: strada/spot che ti fa tornare col sorriso (panorama + guida piacevole).";
  return "Micro-meta poco ovvia: abbastanza speciale da valere l’uscita, abbastanza semplice da farla anche al volo.";
}

function scoreWow(el){
  const t = el.tags || {};
  let s = 0;
  const name = low(t.name || "");

  // tramonto easy
  if (t.tourism === "viewpoint") s += 46;
  if (t.man_made === "tower" && (name.includes("belvedere") || name.includes("panoram") || name.includes("vista"))) s += 26;

  // natura wow
  if (t.waterway === "waterfall" || t.natural === "waterfall") s += 55;
  if (t.natural === "cave_entrance" || t.natural === "cave") s += 34;

  // family (ma non playground)
  if (t.tourism === "theme_park" || t.tourism === "zoo") s += 28;
  if (t.tourism === "attraction") s += 16;
  if (t.tourism === "picnic_site") s += 10;
  // penalty se playground (non lo vogliamo)
  if (t.leisure === "playground") s -= 40;

  // pioggia
  if (t.tourism === "museum" || t.tourism === "gallery") s += 18;
  if (t.amenity === "spa") s += 18;

  // bici/moto
  if (t.highway === "cycleway" || t.route === "bicycle" || t.bicycle === "designated") s += 14;
  if (t.mountain_pass === "yes") s += 18;

  // food
  if (isFood(t)){
    s += 22;
    if (t.tourism === "winery") s += 10;
    if (t.craft === "brewery" || t.craft === "distillery") s += 8;
    if (t.shop === "cheese" || t.shop === "bakery" || t.shop === "farm_shop" || t.shop === "deli") s += 6;
    if (t.amenity === "ice_cream" || t.shop === "pastry") s += 5;
    const c = low(t.cuisine);
    if (c) s += 5;
    if (c && !["pizza","burger","kebab","italian"].includes(c)) s += 5;
  }

  // anti-ovvio soft
  if (hasWiki(t)) s -= 28;
  if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) s -= 45;

  if (norm(t.name || "").length >= 10) s += 4;
  s += Math.random() * 12;
  return s;
}

// -------------------- Overpass queries --------------------
// Nota: tolto playground (era spam). Aggiunti: attraction, picnic_site, tower/viewpoint.
function overpassQueryWowFamilyIndoor(b){
  return `
[out:json][timeout:180];
(
  // TRAMONTO easy / belvedere
  nwr["tourism"="viewpoint"](${b.s},${b.w},${b.n},${b.e});
  nwr["man_made"="tower"]["name"](${b.s},${b.w},${b.n},${b.e});

  // NATURA wow
  nwr["waterway"="waterfall"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="waterfall"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="spring"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="cave_entrance"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="cave"](${b.s},${b.w},${b.n},${b.e});
  nwr["boundary"="protected_area"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="nature_reserve"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="wood"](${b.s},${b.w},${b.n},${b.e});

  // FAMILY (bello, non playground)
  nwr["tourism"="zoo"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="theme_park"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="attraction"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="park"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="picnic_site"]["name"](${b.s},${b.w},${b.n},${b.e});

  // PIOGGIA (indoor)
  nwr["tourism"="museum"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="gallery"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="cinema"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="theatre"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="library"]["name"](${b.s},${b.w},${b.n},${b.e});

  // RELAX (parchi/giardini/spa)
  nwr["amenity"="spa"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="garden"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="picnic_site"]["name"](${b.s},${b.w},${b.n},${b.e});

  // BICI
  nwr["highway"="cycleway"](${b.s},${b.w},${b.n},${b.e});
  relation["route"="bicycle"](${b.s},${b.w},${b.n},${b.e});
  relation["route"="mtb"](${b.s},${b.w},${b.n},${b.e});

  // MOTO (passi)
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

// -------------------- ROBUST fetch --------------------
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
        }, TIMEOUT_MS);

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

// -------------------- tiles + build ideas --------------------
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

  if (!["relax","famiglia","bici","moto","natura","pioggia","tramonto","mangiare"].includes(cat)) return null;

  // scarta “playground” a prescindere (non lo vuoi proprio)
  if (String(t.leisure || "") === "playground") return null;

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
    category: cat,
    duration_bucket: bucket,
    duration_min: durationMinFor(cat),
    why,
    repeatable: true,
    url: "",
    source: "osm_overpass"
  };
}

// selezione con QUOTE per categoria
function selectWithQuotas(elements, quotas){
  const buckets = {
    tramonto: [], natura: [], relax: [], famiglia: [],
    pioggia: [], bici: [], moto: [], mangiare: []
  };

  for (const el of elements){
    const idea = buildIdea(el);
    if (!idea) continue;
    buckets[idea.category].push({ el, s: scoreWow(el) });
  }

  for (const k of Object.keys(buckets)){
    buckets[k].sort((a,b)=> b.s - a.s);
  }

  const picked = [];
  const seenName = new Set();
  const order = ["tramonto","natura","relax","famiglia","pioggia","bici","moto","mangiare"];

  // 1) quota per categoria
  for (const cat of order){
    const need = Math.max(0, Number(quotas[cat] || 0));
    let i = 0;
    const countCat = () => picked.filter(x=>x.category===cat).length;

    while (picked.length < TARGET_IDEAS && i < buckets[cat].length && countCat() < need){
      const el = buckets[cat][i].el;
      i++;

      const idea = buildIdea(el);
      if (!idea) continue;

      const kn = idea.title.toLowerCase();
      if (seenName.has(kn)) continue;

      if (idea.title.length < 5) continue;
      seenName.add(kn);
      picked.push(idea);
    }
  }

  // 2) fill restante (ma non esplodere “mangiare”)
  const fillPool = [];
  for (const cat of order){
    for (const x of buckets[cat]){
      const idea = buildIdea(x.el);
      if (idea) fillPool.push({ idea, s: x.s });
    }
  }
  fillPool.sort((a,b)=> b.s - a.s);

  for (const x of fillPool){
    if (picked.length >= TARGET_IDEAS) break;
    const idea = x.idea;

    const kn = idea.title.toLowerCase();
    if (seenName.has(kn)) continue;

    if (idea.category === "mangiare"){
      const maxFood = Math.round((Number(quotas.mangiare || 0) || 250) * 1.4);
      const foodNow = picked.filter(p=>p.category==="mangiare").length;
      if (foodNow >= maxFood) continue;
    }

    seenName.add(kn);
    picked.push(idea);
  }

  return picked;
}

// -------------------- main --------------------
async function main(){
  console.log("BUILD MAI FATTO ABRUZZO — endpoints:", ENDPOINTS);
  console.log("GRID:", GRID.cols, "x", GRID.rows);
  console.log("QUOTAS:", QUOTAS);

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

    // A) WOW+FAMILY+INDOOR+BICI+MOTO
    try{
      const jsonA = await overpassFetch(overpassQueryWowFamilyIndoor(tile));
      const elsA = Array.isArray(jsonA?.elements) ? jsonA.elements : [];
      for (const el of elsA){
        if (!el?.tags?.name) continue;
        if (isBadElement(el)) continue;
        const k = dedupeKey(el);
        if (!map.has(k)) map.set(k, el);
      }
      okTiles++;
    } catch(e){
      failTiles++;
      console.warn("⚠️ Tile WOW/FAMILY/INDOOR failed:", e.message);
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
    } catch(e){
      console.warn("⚠️ Tile FOOD failed:", e.message);
    }

    await sleep(SLEEP_MS_BASE);
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

  // PRE counts
  const preCounts = {};
  for (const el of filtered){
    const idea = buildIdea(el);
    if (!idea) continue;
    preCounts[idea.category] = (preCounts[idea.category] || 0) + 1;
  }
  console.log("PRE counts:", preCounts);

  const ideas = selectWithQuotas(filtered, QUOTAS);

  // POST counts
  const postCounts = {};
  for (const i of ideas){
    postCounts[i.category] = (postCounts[i.category] || 0) + 1;
  }
  console.log("POST counts:", postCounts);

  const out = {
    _build_id: "abruzzo_" + Date.now(),
    updated_at: new Date().toISOString(),
    count: ideas.length,
    area: "Abruzzo — Mai fatto (WOW completo) — quota-balanced — reachable-first",
    stats: {
      region: "Abruzzo",
      bbox: ABRUZZO_BBOX,
      grid: GRID,
      tiles_total: tilesToRun.length,
      tiles_ok: okTiles,
      tiles_failed: failTiles,
      endpoints: ENDPOINTS,
      quotas: QUOTAS,
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
