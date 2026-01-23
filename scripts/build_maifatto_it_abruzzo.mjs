// scripts/build_maifatto_it_abruzzo.mjs (ROBUST • WOW • Abruzzo • Categorie piene)
// Output: public/data/mai_fatto/mai_fatto_it_abruzzo.json
//
// ✅ Scrive SEMPRE l'output (anche se Overpass fallisce)
// ✅ Multi-endpoint + retry/backoff
// ✅ Query spezzate per tile:
//    (A) WOW+FAMILY (B) FOOD (C) BICI+MOTO+PIOGGIA
// ✅ Post-process: genera anche categorie 1h/2h (cloni) per riempire i filtri UI
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

const SLEEP_MS_BASE = Number(process.env.SLEEP_MS || 1600);
const MAX_TILES = process.env.MAX_TILES ? Number(process.env.MAX_TILES) : null;

const GRID = {
  cols: Number(process.env.GRID_COLS || 5),
  rows: Number(process.env.GRID_ROWS || 5),
};

// ✅ Abruzzo bbox approx (W,S,E,N)
const ABRUZZO_BBOX = { w: 13.0, s: 41.65, e: 14.85, n: 42.95 };

// target (poi alziamo)
const TARGET_IDEAS = Number(process.env.TARGET_IDEAS || 3200);

// parole da tagliare
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

// ---------- EXTRA SIGNALS (BICI / MOTO / PIOGGIA / FAMILY SOFT)
function isBike(tags){
  const t = tags || {};
  const rt = String(t.route || "");
  const hw = String(t.highway || "");
  const cyc = String(t.cycleway || "");
  const sport = String(t.sport || "");
  if (rt === "bicycle" || rt === "mtb") return true;
  if (hw === "cycleway") return true;
  if (cyc) return true;
  if (sport === "cycling") return true;
  if (t["mtb:scale"] || t["sac_scale"]) return true;
  return false;
}

function isMoto(tags){
  const t = tags || {};
  const name = norm(t.name).toLowerCase();
  // “moto” = passi/valichi/strade panoramiche
  if (name.includes("passo") || name.includes("valico") || name.includes("forca") || name.includes("sella")) return true;
  if (t.mountain_pass) return true;
  if (t["highway"] === "mountain_pass") return true;
  // viewpoint + strada scenica = spesso ok
  if (t.tourism === "viewpoint" && (name.includes("panoram") || name.includes("belvedere"))) return true;
  return false;
}

function isRain(tags){
  const t = tags || {};
  const amen = String(t.amenity || "");
  const tourism = String(t.tourism || "");
  const historic = String(t.historic || "");
  const natural = String(t.natural || "");
  if (natural === "cave" || natural === "cave_entrance") return true;
  if (tourism === "museum" || tourism === "gallery") return true;
  if (amen === "cinema" || amen === "theatre") return true;
  if (historic && ["castle","fort","ruins","archaeological_site","monument","palace"].includes(historic)) return true;
  if (t.amenity === "spa" || t.leisure === "spa" || t.amenity === "sauna" || t.leisure === "sauna") return true;
  return false;
}

function isFamilySoft(tags){
  const t = tags || {};
  const tourism = String(t.tourism || "");
  const leisure = String(t.leisure || "");
  const amen = String(t.amenity || "");
  // oltre zoo/theme_park, prendiamo anche aquarium, water_park, playground, park con nome
  if (tourism === "zoo" || tourism === "theme_park" || tourism === "aquarium") return true;
  if (leisure === "water_park" || leisure === "playground") return true;
  if (leisure === "park" && t.name) return true;
  if (amen === "planetarium") return true;
  return false;
}

// ---------- CLASSIFY
function classify(tags){
  const t = tags || {};

  // order: specific -> broad
  if (isFood(t)) return "mangiare";

  if (isRain(t)) return "pioggia";
  if (isBike(t)) return "bici";
  if (isMoto(t)) return "moto";

  if (t.tourism === "viewpoint") return "tramonto";
  if (t.waterway === "waterfall" || t.natural === "waterfall") return "natura";
  if (t.natural === "cave_entrance" || t.natural === "cave") return "pioggia"; // cave = perfetta quando piove

  if (t.natural === "peak" || t.natural === "cliff" || t.natural === "ridge") return "tramonto";
  if (t.natural === "spring") return "relax";
  if (t.boundary === "protected_area" || t.leisure === "nature_reserve") return "natura";

  // “1h/2h” come categoria: li usiamo soprattutto col post-process
  if (["ruins","castle","fort","archaeological_site"].includes(String(t.historic || ""))) return "2h";
  if (t.man_made === "bridge" || t.bridge) return "1h";

  if (isFamilySoft(t)) return "famiglia";

  return "natura";
}

function durationFor(cat){
  const r = Math.random();
  const ranges = {
    "1h":[45,85], "2h":[95,160],
    "relax":[45,95], "famiglia":[70,150],
    "bici":[55,125], "moto":[70,170],
    "natura":[70,180], "pioggia":[50,110],
    "tramonto":[55,120], "mangiare":[70,160],
  };
  const [a,b] = ranges[cat] || [60,120];
  return Math.round(a + (b-a)*r);
}

function buildWhy(tags, cat){
  const t = tags || {};
  const name = norm(t.name).toLowerCase();

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

  if (cat === "pioggia"){
    if (t.natural === "cave" || t.natural === "cave_entrance") return "È il classico colpo di scena quando fuori è brutto: al coperto (o semi), atmosfera, e ti sembra di essere lontano.";
    if (t.tourism === "museum" || t.tourism === "gallery") return "Perfetto quando piove: ti fai un’uscita vera senza dipendere dal meteo, e spesso trovi chicche sottovalutate.";
    if (String(t.historic||"")) return "È un posto che regge bene anche con meteo brutto: scenografia, storia e ‘wow’ senza dover fare trekking.";
    return "Quando piove, questo tipo di posto funziona: zero stress e ti porta fuori dal solito giro.";
  }

  if (cat === "bici") return "È un giro bici con ‘punto wow’: panorama/strada bella/spot che dà soddisfazione anche in mezza giornata.";
  if (cat === "moto") return "È una meta da moto ‘giusta’: strada scenica, curva/passo/veduta. Non è solo arrivare, è il viaggio.";
  if (cat === "tramonto") return "È un punto panoramico spesso fuori dal giro ovvio: quando la luce cambia, diventa una scena da ricordare.";
  if (cat === "natura" && (t.waterway === "waterfall" || t.natural === "waterfall")) return "Qui l’acqua fa davvero differenza: aria fresca, suono, atmosfera. È una mini-fuga che sorprende.";
  if (cat === "2h") return "È un’uscita ‘piena’: scenografia vera e la sensazione di aver fatto qualcosa che resta.";
  if (cat === "1h") return "È un colpo di wow rapido: perfetto se vuoi uscire senza organizzare mezza giornata.";
  if (cat === "relax") return "È un posto semplice ma ‘pulito’: ti stacca senza chiederti fatica o organizzazione.";
  if (cat === "famiglia") return "È family nel senso giusto: spazio e stimoli reali, senza dover riempire la giornata con mille cose.";

  if (name.includes("belvedere") || name.includes("panoram")) return "È un posto piccolo ma soddisfacente: arrivi e capisci subito perché valeva la pena.";
  return "È una micro-meta poco ovvia: abbastanza speciale da valere l’uscita, abbastanza vicina da farlo anche al volo.";
}

function scoreWow(el){
  const t = el.tags || {};
  let s = 0;

  if (t.tourism === "viewpoint") s += 38;
  if (t.waterway === "waterfall" || t.natural === "waterfall") s += 52;
  if (t.natural === "cave_entrance" || t.natural === "cave") s += 42;
  if (["ruins","castle","fort","archaeological_site"].includes(String(t.historic||""))) s += 30;
  if (t.man_made === "bridge" || t.bridge) s += 14;
  if (t.natural === "spring") s += 18;

  if (isFamilySoft(t)) s += 16;
  if (isBike(t)) s += 14;
  if (isMoto(t)) s += 14;
  if (isRain(t)) s += 12;

  if (isFood(t)){
    s += 24;
    if (t.tourism === "winery") s += 10;
    if (t.craft === "brewery" || t.craft === "distillery") s += 10;
    if (t.shop === "cheese" || t.shop === "bakery" || t.shop === "farm_shop" || t.shop === "deli") s += 8;
    if (t.amenity === "ice_cream" || t.shop === "pastry") s += 6;

    const c = norm(t.cuisine).toLowerCase();
    if (c) s += 8;
    if (c && !["pizza","burger","kebab","italian"].includes(c)) s += 6;
  }

  if (hasWiki(t)) s -= 35;
  if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) s -= 45;

  const name = norm(t.name);
  if (name.length >= 10) s += 4;

  s += Math.random() * 10;
  return s;
}

// --- Query spezzate
function overpassQueryWowFamily(b){
  return `
[out:json][timeout:180];
(
  // WOW
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

  // FAMILY (soft)
  nwr["tourism"="zoo"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="theme_park"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="aquarium"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="water_park"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="playground"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="park"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="planetarium"](${b.s},${b.w},${b.n},${b.e});
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

function overpassQueryMobilityRain(b){
  return `
[out:json][timeout:180];
(
  // BICI
  relation["route"="bicycle"](${b.s},${b.w},${b.n},${b.e});
  relation["route"="mtb"](${b.s},${b.w},${b.n},${b.e});
  way["highway"="cycleway"]["name"](${b.s},${b.w},${b.n},${b.e});
  way["cycleway"]["name"](${b.s},${b.w},${b.n},${b.e});

  // MOTO (passi/valichi + viewpoint già in A)
  nwr["mountain_pass"]["name"](${b.s},${b.w},${b.n},${b.e});

  // PIOGGIA (indoor / semi-indoor)
  nwr["tourism"="museum"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="gallery"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="cinema"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="theatre"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="spa"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="spa"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="sauna"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="sauna"]["name"](${b.s},${b.w},${b.n},${b.e});
);
out center tags;
`;
}

// --- Overpass robust fetch
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

function cloneIdeaForCategory(idea, newCat){
  return {
    ...idea,
    id: `${idea.id}__${newCat}`,
    category: newCat,
    // leggero tweak durata coerente
    duration_min:
      newCat === "1h" ? Math.min(90, Math.max(45, Number(idea.duration_min) || 75)) :
      newCat === "2h" ? Math.max(95, Math.min(170, Number(idea.duration_min) || 120)) :
      (Number(idea.duration_min) || 90),
  };
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

      // (A) WOW + FAMILY
      try{
        const jsonA = await overpassFetch(overpassQueryWowFamily(tile));
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
        stats.tiles_ok_b++;
      } catch(e){
        stats.tiles_fail_b++;
        console.warn("⚠️ Tile B failed:", e.message);
      }
      await sleep(SLEEP_MS_BASE);

      // (C) BICI + MOTO + PIOGGIA
      try{
        const jsonC = await overpassFetch(overpassQueryMobilityRain(tile));
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

    // build base ideas
    const ideasBase = [];
    const seenName = new Set();
    for (const el of selected){
      const idea = buildIdea(el);
      if (!idea) continue;
      const kn = idea.title.toLowerCase();
      if (seenName.has(kn)) continue;
      seenName.add(kn);
      if (idea.title.length < 5) continue;
      ideasBase.push(idea);
    }

    // ✅ post-process: crea anche 1h e 2h come categorie REALI (cloni),
    // così i filtri UI trovano sempre roba.
    const ideas = [];
    const seenId = new Set();

    for (const idea of ideasBase){
      if (!seenId.has(idea.id)) { ideas.push(idea); seenId.add(idea.id); }

      const d = Number(idea.duration_min) || 0;
      // Se è una chicca rapida => 1h
      if (d && d <= 90){
        const c1 = cloneIdeaForCategory(idea, "1h");
        if (!seenId.has(c1.id)) { ideas.push(c1); seenId.add(c1.id); }
      }
      // Se è più “piena” => 2h
      if (d && d >= 95){
        const c2 = cloneIdeaForCategory(idea, "2h");
        if (!seenId.has(c2.id)) { ideas.push(c2); seenId.add(c2.id); }
      }
    }

    const out = {
      updated_at: new Date().toISOString(),
      count: ideas.length,
      area: "Abruzzo — WOW + Food + Pioggia/Bici/Moto + 1h/2h (robust build)",
      stats,
      ideas
    };

    writeJSON(outPath, out);
    console.log("✅ Wrote:", outPath);
    console.log("Ideas:", ideas.length, "| base:", ideasBase.length);

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
