// scripts/build_maifatto_it_abruzzo_verona_style.mjs
// Output: public/data/mai_fatto/mai_fatto_it_abruzzo.json
// ✅ Stile Verona: file leggero + categorie piene + info_url

import fs from "fs";
import path from "path";

const ENDPOINTS = [
  process.env.OVERPASS_ENDPOINT,
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
].filter(Boolean);

const SLEEP_MS_BASE = Number(process.env.SLEEP_MS || 1200);

// Abruzzo bbox approx (W,S,E,N)
const ABRUZZO = { w: 13.0, s: 41.65, e: 14.85, n: 42.95 };

// “Stile Verona” = poche idee ma buone, bilanciate
const QUOTAS = {
  relax: 22,
  famiglia: 22,
  bici: 22,
  moto: 22,
  natura: 26,
  pioggia: 20,
  tramonto: 22,
  mangiare: 34,
  "1h": 15,
  "2h": 15,
};

const MAX_TOTAL = Object.values(QUOTAS).reduce((a,b)=>a+b,0);

// filtri anti-spazzatura
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

function norm(s){ return String(s||"").trim(); }
function lc(s){ return norm(s).toLowerCase(); }

function hasBadWords(name){
  const n = lc(name);
  if (!n) return false;
  return BAD_WORDS.some(w => n.includes(w));
}

function getCenter(el){
  if (typeof el.lat === "number" && typeof el.lon === "number") return { lat: el.lat, lon: el.lon };
  if (el.center && typeof el.center.lat === "number" && typeof el.center.lon === "number") return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

function dedupeKey(el){ return `${el.type}:${el.id}`; }

function isBadElement(el){
  const t = el.tags || {};
  const name = norm(t.name);
  if (!name) return true;
  if (hasBadWords(name)) return true;

  // scarta brand / catene
  if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) return true;

  // roba inutile
  const amen = String(t.amenity || "");
  if (["fuel","bank","atm","pharmacy","clinic","hospital"].includes(amen)) return true;

  // hotel ecc non sono “mai fatto”
  if (t.tourism === "hotel" || t.tourism === "motel" || t.tourism === "hostel") return true;

  return false;
}

// ---------- categorie ----------
function isFood(t){
  const amen = String(t.amenity||"");
  const shop = String(t.shop||"");
  const craft = String(t.craft||"");
  const tourism = String(t.tourism||"");
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

function looksBici(t){
  // piste ciclabili, percorsi bici, cycleway, route=bicycle, mtb
  const name = lc(t.name);
  const route = String(t.route||"");
  const network = String(t.network||"");
  const highway = String(t.highway||"");
  const cycleway = String(t.cycleway||"");
  const sport = String(t.sport||"");

  if (route === "bicycle") return true;
  if (sport === "cycling") return true;
  if (network && route === "bicycle") return true;
  if (cycleway) return true;
  if (highway === "cycleway") return true;
  if (name.includes("ciclab") || name.includes("bike") || name.includes("mtb")) return true;
  return false;
}

function looksMoto(t){
  // “moto” in OSM è raro: facciamo euristica su passi, panoramiche, strade scenic
  const name = lc(t.name);
  const highway = String(t.highway||"");
  const scenic = String(t.scenic||"");
  const mountainPass = String(t.mountain_pass||"");

  if (name.includes("passo") || name.includes("valico")) return true;
  if (mountainPass === "yes") return true;
  if (scenic === "yes") return true;
  if (highway && (name.includes("panoram") || name.includes("belvedere"))) return true;
  return false;
}

function looksPioggia(t){
  // indoor / riparo: musei, grotte, terme, castelli visitabili, centri storici coperti, etc.
  const tourism = String(t.tourism||"");
  const amenity = String(t.amenity||"");
  const historic = String(t.historic||"");
  const natural = String(t.natural||"");
  const name = lc(t.name);

  if (tourism === "museum" || tourism === "gallery" || tourism === "aquarium") return true;
  if (amenity === "theatre" || amenity === "cinema") return true;
  if (historic === "castle" || historic === "ruins") return true;
  if (natural === "cave" || natural === "cave_entrance") return true;
  if (name.includes("terme") || name.includes("spa")) return true;
  return false;
}

function classify(t){
  // ordine: prima categorie “specifiche”
  if (isFood(t)) return "mangiare";
  if (looksBici(t)) return "bici";
  if (looksMoto(t)) return "moto";
  if (looksPioggia(t)) return "pioggia";

  if (t.tourism === "viewpoint") return "tramonto";
  if (t.waterway === "waterfall" || t.natural === "waterfall") return "natura";
  if (t.natural === "cave_entrance" || t.natural === "cave") return "pioggia"; // grotte = perfette se piove
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
    "1h":[45,85], "2h":[95,160],
    "relax":[45,95], "famiglia":[70,150],
    "bici":[55,120], "moto":[70,160],
    "natura":[70,170], "pioggia":[45,105],
    "tramonto":[55,110], "mangiare":[70,160],
  };
  const [a,b] = ranges[cat] || [60,120];
  return Math.round(a + (b-a)*r);
}

function buildWhy(t, cat){
  if (cat === "mangiare") return "È una sosta locale vera: non il solito posto standard, ma una mini-scoperta da ricordare.";
  if (cat === "tramonto") return "Quando cambia la luce diventa una scena da foto: posto perfetto per chiudere la giornata in WOW.";
  if (cat === "natura") return "È una micro-fuga naturale: aria diversa, ritmo lento, e quella sensazione di “sto bene qui”.";
  if (cat === "pioggia") return "È perfetto anche se piove: non dipende dal meteo e ti salva l’uscita senza stress.";
  if (cat === "bici") return "Giro bello e semplice: ti dà subito la sensazione di avventura senza essere una spedizione.";
  if (cat === "moto") return "Strada o passaggio che vale la guida: curve, panorama e quel gusto da giro “fatto bene”.";
  if (cat === "relax") return "Ti stacca senza dover organizzare nulla: posto “pulito”, con vibe di reset.";
  if (cat === "famiglia") return "Family nel senso giusto: spazio, stimoli, zero sbatti. I bimbi se lo ricordano.";
  if (cat === "1h") return "È un colpo di WOW rapido: perfetto se hai poco tempo ma vuoi sentirti in giro davvero.";
  if (cat === "2h") return "Uscita piena ma fattibile: ti riempie la giornata senza diventare un viaggio infinito.";
  return "Micro-meta poco ovvia: abbastanza speciale da valere l’uscita, abbastanza vicina da farla anche al volo.";
}

function infoUrlFor(title, city){
  const q = [title, city, "Abruzzo"].filter(Boolean).join(" ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function score(el, cat){
  const t = el.tags || {};
  let s = 0;

  if (cat === "tramonto" && t.tourism === "viewpoint") s += 50;
  if (cat === "natura" && (t.waterway === "waterfall" || t.natural === "waterfall")) s += 60;
  if (cat === "pioggia" && (t.tourism === "museum" || t.natural === "cave")) s += 45;
  if (cat === "relax" && (lc(t.name).includes("terme") || t.natural === "spring")) s += 45;

  if (cat === "bici" && looksBici(t)) s += 40;
  if (cat === "moto" && looksMoto(t)) s += 35;
  if (cat === "famiglia" && (t.tourism === "zoo" || t.tourism === "theme_park" || t.leisure === "park")) s += 40;

  if (cat === "mangiare") {
    s += 30;
    if (t.tourism === "winery") s += 12;
    if (t.craft === "brewery" || t.craft === "distillery") s += 10;
    if (t.shop === "cheese" || t.shop === "bakery" || t.shop === "farm_shop") s += 8;
    if (t.cuisine && !["pizza","burger","kebab","italian"].includes(lc(t.cuisine))) s += 6;
  }

  // preferisci nomi “non banali”
  const name = norm(t.name);
  if (name.length >= 10) s += 4;

  // random leggero per varietà
  s += Math.random() * 8;
  return s;
}

// --- Overpass query (unica, più “larga”, poi classifichiamo noi)
function overpassQueryAll(b){
  return `
[out:json][timeout:180];
(
  // natura / tramonto / relax
  nwr["tourism"="viewpoint"](${b.s},${b.w},${b.n},${b.e});
  nwr["waterway"="waterfall"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="waterfall"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="spring"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="cave_entrance"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="cave"](${b.s},${b.w},${b.n},${b.e});
  nwr["boundary"="protected_area"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="nature_reserve"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="park"]["name"](${b.s},${b.w},${b.n},${b.e});

  // pioggia (indoor)
  nwr["tourism"="museum"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="gallery"](${b.s},${b.w},${b.n},${b.e});

  // storia (per 1h/2h)
  nwr["historic"="ruins"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="castle"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="fort"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="archaeological_site"](${b.s},${b.w},${b.n},${b.e});
  nwr["man_made"="bridge"](${b.s},${b.w},${b.n},${b.e});
  way["bridge"](${b.s},${b.w},${b.n},${b.e});

  // bici
  nwr["highway"="cycleway"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["route"="bicycle"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["cycleway"]["name"](${b.s},${b.w},${b.n},${b.e});

  // food
  nwr["amenity"="restaurant"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="pub"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="cafe"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="bar"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="ice_cream"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="winery"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["craft"="brewery"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["craft"="distillery"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["shop"="farm_shop"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["shop"="cheese"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["shop"="bakery"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["shop"="pastry"]["name"](${b.s},${b.w},${b.n},${b.e});
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

  for (let attempt=1; attempt<=6; attempt++){
    for (const ep of ENDPOINTS){
      try{
        const r = await fetchWithTimeout(ep, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body,
        }, 180000);

        const ct = (r.headers.get("content-type") || "").toLowerCase();

        if (!r.ok){
          const txt = await r.text().catch(()=> "");
          const msg = `HTTP ${r.status} (${ep}) ${txt.slice(0,120)}`;
          if ([429,502,503,504].includes(r.status)){ lastErr = new Error(msg); continue; }
          throw new Error(msg);
        }

        if (!ct.includes("application/json")){
          const txt = await r.text().catch(()=> "");
          lastErr = new Error(`Non-JSON (${ep}): ${txt.slice(0,120)}`);
          continue;
        }

        return await r.json();
      } catch(e){
        lastErr = e;
      }
    }

    const wait = SLEEP_MS_BASE * attempt * 1.5;
    console.warn(`⚠️ retry ${attempt}/6 — wait ${Math.round(wait)}ms —`, lastErr?.message || "");
    await sleep(wait);
  }

  throw lastErr || new Error("Overpass failed");
}

function buildIdea(el){
  const t = el.tags || {};
  const center = getCenter(el);
  if (!center) return null;

  const title = norm(t.name);
  if (!title) return null;

  const cat = classify(t);
  const city = t["addr:city"] || t["is_in:city"] || "";

  return {
    id: `mf_ab_${el.type}_${el.id}`,
    title,
    place: title,
    city,
    region: "Abruzzo",
    country_code: "IT",
    lat: Number(center.lat),
    lon: Number(center.lon),
    category: cat,
    duration_bucket: (cat === "2h" ? "2h" : "1h"),
    duration_min: durationFor(cat),
    why: buildWhy(t, cat),
    info_url: infoUrlFor(title, city),
    wow_score: 10, // non serve reale: lo usa solo l’ordinamento interno
    repeatable: true,
    source: "osm_overpass"
  };
}

function bboxTiles(bbox, cols=4, rows=4){
  const tiles = [];
  const dx = (bbox.e - bbox.w) / cols;
  const dy = (bbox.n - bbox.s) / rows;
  for (let y=0;y<rows;y++){
    for (let x=0;x<cols;x++){
      tiles.push({
        w: bbox.w + dx*x,
        e: bbox.w + dx*(x+1),
        s: bbox.s + dy*y,
        n: bbox.s + dy*(y+1),
      });
    }
  }
  return tiles;
}

async function main(){
  const outPath = path.join(process.cwd(), "public/data/mai_fatto/mai_fatto_it_abruzzo.json");

  const map = new Map();
  const tiles = bboxTiles(ABRUZZO, 4, 4); // leggero

  for (let i=0;i<tiles.length;i++){
    const tile = tiles[i];
    console.log(`Tile ${i+1}/${tiles.length}...`);
    try{
      const json = await overpassFetch(overpassQueryAll(tile));
      const els = Array.isArray(json?.elements) ? json.elements : [];
      for (const el of els){
        if (!el?.tags?.name) continue;
        if (isBadElement(el)) continue;
        const k = dedupeKey(el);
        if (!map.has(k)) map.set(k, el);
      }
    } catch(e){
      console.warn("⚠️ tile failed:", e.message);
    }
    await sleep(SLEEP_MS_BASE);
  }

  const all = Array.from(map.values());
  console.log("Candidates:", all.length);

  // bucket per categoria
  const buckets = new Map(Object.keys(QUOTAS).map(k => [k, []]));
  for (const el of all){
    const t = el.tags || {};
    const cat = classify(t);
    if (!buckets.has(cat)) continue;
    buckets.get(cat).push(el);
  }

  // ordina per score dentro ogni bucket
  for (const [cat, arr] of buckets.entries()){
    arr.sort((a,b)=> score(b, cat) - score(a, cat));
  }

  // seleziona rispettando quote
  const ideas = [];
  const seenName = new Set();

  function take(cat, n){
    const arr = buckets.get(cat) || [];
    let taken = 0;
    for (const el of arr){
      if (taken >= n) break;
      const idea = buildIdea(el);
      if (!idea) continue;
      const key = idea.title.toLowerCase();
      if (seenName.has(key)) continue;
      seenName.add(key);
      ideas.push(idea);
      taken++;
    }
    return taken;
  }

  // 1) prendi per quote
  for (const [cat, n] of Object.entries(QUOTAS)){
    const got = take(cat, n);
    // se una categoria è povera, non blocchiamo: si riempie dopo
    console.log(cat, "=>", got, "/", n);
  }

  // 2) fill con le migliori rimanenti (natura + food + tramonto tipicamente)
  if (ideas.length < MAX_TOTAL){
    const flat = [];
    for (const [cat, arr] of buckets.entries()){
      for (const el of arr) flat.push({ el, cat });
    }
    flat.sort((a,b)=> score(b.el, b.cat) - score(a.el, a.cat));

    for (const x of flat){
      if (ideas.length >= MAX_TOTAL) break;
      const idea = buildIdea(x.el);
      if (!idea) continue;
      const key = idea.title.toLowerCase();
      if (seenName.has(key)) continue;
      seenName.add(key);
      ideas.push(idea);
    }
  }

  // micro-wow_score “decorativo” per ordinamento in app (se serve)
  ideas.forEach((it, idx) => { it.wow_score = 10 + ((MAX_TOTAL - idx) / MAX_TOTAL) * 10; });

  const out = {
    updated_at: new Date().toISOString(),
    count: ideas.length,
    area: "Abruzzo • Mai fatto (Verona-style) • bilanciato",
    ideas
  };

  writeJSON(outPath, out);
  console.log("✅ Wrote:", outPath, "ideas:", ideas.length);
}

main().catch((e)=>{
  console.error("FATAL:", e);
  const outPath = path.join(process.cwd(), "public/data/mai_fatto/mai_fatto_it_abruzzo.json");
  writeJSON(outPath, {
    updated_at: new Date().toISOString(),
    count: 0,
    area: "Abruzzo • build FAILED (placeholder)",
    ideas: []
  });
  process.exit(0);
});
