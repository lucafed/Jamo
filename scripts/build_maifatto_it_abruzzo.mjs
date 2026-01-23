// scripts/build_maifatto_it_abruzzo_like_verona.mjs
// (VERONA-STYLE • Abruzzo • completo: family/bici/moto/pioggia/tramonto/food/natura/relax + 1h/2h)
//
// Output: public/data/mai_fatto/mai_fatto_it_abruzzo.json
// Node 20+ (fetch nativo)

import fs from "fs";
import path from "path";

const OUT_PATH = path.join(process.cwd(), "public/data/mai_fatto/mai_fatto_it_abruzzo.json");

// Abruzzo bbox approx (W,S,E,N)
const ABRUZZO_BBOX = { w: 13.0, s: 41.65, e: 14.85, n: 42.95 };

const ENDPOINTS = [
  process.env.OVERPASS_ENDPOINT,
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
].filter(Boolean);

// tuning
const GRID = { cols: Number(process.env.GRID_COLS || 5), rows: Number(process.env.GRID_ROWS || 5) };
const SLEEP_MS_BASE = Number(process.env.SLEEP_MS || 900);
const MAX_TILES = process.env.MAX_TILES ? Number(process.env.MAX_TILES) : null;

// quantità target per “modalità” (poi regoliamo)
const TARGET_TOTAL = Number(process.env.TARGET_TOTAL || 1200);
const PER_MODE_MIN = Number(process.env.PER_MODE_MIN || 70); // garantisce che non resti a 0

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

// ---------- FOOD detector (più “ricco”)
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
    "chocolate","farm_shop","greengrocer","seafood","wine","beverages"
  ].includes(shop)) return true;

  if (["brewery","distillery"].includes(craft)) return true;

  const name = norm(t.name).toLowerCase();
  if (name.includes("agriturismo") || name.includes("osteria") || name.includes("trattoria")) return true;

  if (cuisine) return true;
  return false;
}

// ---------- Base category (come “Verona”)
function baseCategory(t){
  if (isFood(t)) return "mangiare";

  if (t.tourism === "viewpoint") return "tramonto";

  if (t.waterway === "waterfall" || t.natural === "waterfall") return "natura";
  if (t.natural === "cave_entrance" || t.natural === "cave") return "natura";
  if (t.boundary === "protected_area" || t.leisure === "nature_reserve") return "natura";

  if (t.natural === "peak" || t.natural === "cliff" || t.natural === "ridge") return "tramonto";
  if (t.natural === "spring") return "relax";

  if (t.tourism === "zoo" || t.tourism === "theme_park") return "famiglia";
  if (t.leisure === "park" && t.name) return "famiglia";

  // fallback: natura
  return "natura";
}

// ---------- “Modalità Mai Fatto” (per non avere 0 risultati)
const MODES = ["tutti","reset","family","bici","moto","pioggia","tramonto","food","natura"];

function pickModes(t, base){
  const modes = new Set();

  // mappature dirette
  if (base === "famiglia") modes.add("family");
  if (base === "tramonto") modes.add("tramonto");
  if (base === "mangiare") modes.add("food");
  if (base === "natura") modes.add("natura");
  if (base === "relax") modes.add("reset");

  // bici: se c’è hint OSM, altrimenti “cloniamo” alcuni natura/tramonto per non restare a 0
  const hasBikeHint =
    t.route === "bicycle" ||
    t.highway === "cycleway" ||
    t.bicycle === "designated" ||
    String(t.sport || "").toLowerCase() === "cycling";
  if (hasBikeHint) modes.add("bici");

  // moto: hint deboli in OSM → usiamo “scenic” + road-ness
  const hasMotoHint =
    String(t.scenic || "").toLowerCase() === "yes" ||
    String(t.highway || "").length > 0 ||
    String(t["motorcycle:yes"] || "") === "yes";
  if (hasMotoHint && (base === "natura" || base === "tramonto")) modes.add("moto");

  // pioggia: musei / indoor / grotte / luoghi coperti
  const amen = String(t.amenity || "");
  const tourism = String(t.tourism || "");
  const leisure = String(t.leisure || "");
  const isIndoor =
    ["museum","theatre","cinema","arts_centre"].includes(amen) ||
    tourism === "museum" ||
    leisure === "indoor_play" ||
    t.natural === "cave" || t.natural === "cave_entrance";
  if (isIndoor) modes.add("pioggia");

  // sempre “tutti”
  modes.add("tutti");

  return [...modes];
}

function durationBucketFor(base){
  // Verona usa 1h/2h. Qui facciamo “coerente”:
  if (base === "mangiare") return Math.random() < 0.65 ? "1h" : "2h";
  if (base === "famiglia") return Math.random() < 0.45 ? "1h" : "2h";
  if (base === "tramonto") return "1h";
  if (base === "relax") return "1h";
  // natura tende più spesso a 2h
  return Math.random() < 0.55 ? "2h" : "1h";
}

function durationMinFor(bucket){
  if (bucket === "1h") return Math.round(50 + Math.random()*35);   // 50–85
  return Math.round(95 + Math.random()*65);                        // 95–160
}

function buildWhy(t, base, mode){
  if (mode === "food" || base === "mangiare"){
    const cue = [];
    if (t.tourism === "winery" || t.shop === "wine") cue.push("vino locale");
    if (t.craft === "brewery") cue.push("birra artigianale");
    if (t.shop === "cheese") cue.push("caseificio");
    if (t.shop === "bakery") cue.push("forno");
    if (t.amenity === "ice_cream") cue.push("gelato artigianale");
    const extra = cue.length ? ` (${cue.slice(0,2).join(" • ")})` : "";
    return `Sosta “vera” e locale${extra}: spesso non è nel giro ovvio e ti dà quella sensazione da scoperta.`;
  }
  if (mode === "tramonto" || base === "tramonto") return "Punto luce: quando il sole scende cambia tutto. È il classico posto che ti fa dire “ah però…”.";
  if (mode === "family" || base === "famiglia") return "Family giusto: spazio, cose da vedere, zero stress. I bimbi si accendono da soli.";
  if (mode === "pioggia") return "Perfetto se piove: esperienza “coperta” o riparata, ma comunque diversa dal solito giro.";
  if (mode === "bici") return "Mini-avventura in bici: un giro semplice ma bello, che sembra più lungo di quanto sia.";
  if (mode === "moto") return "Giro in moto “scenic”: strade e panorama che valgono la benzina. Senza diventare un viaggio infinito.";
  if (mode === "reset" || base === "relax") return "Reset mentale: ti rimette in pace senza dover organizzare nulla.";
  return "Micro-meta poco ovvia: abbastanza speciale da valere l’uscita, abbastanza vicina da farlo anche al volo.";
}

function scoreWow(t, base){
  let s = 0;
  if (t.tourism === "viewpoint") s += 35;
  if (t.waterway === "waterfall" || t.natural === "waterfall") s += 45;
  if (t.natural === "cave_entrance" || t.natural === "cave") s += 32;
  if (t.natural === "spring") s += 18;
  if (base === "famiglia") s += 20;
  if (base === "mangiare") s += 22;
  if (hasWiki(t)) s -= 25; // “anti-famoso soft”
  if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) s -= 30;
  s += Math.random()*10;
  return Math.round(s);
}

// --- Query: WOW+FAMILY+PIAGGIA “light” + FOOD
function overpassQueryA(b){
  return `
[out:json][timeout:180];
(
  // WOW natura/tramonto
  nwr["tourism"="viewpoint"](${b.s},${b.w},${b.n},${b.e});
  nwr["waterway"="waterfall"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="waterfall"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="spring"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="cave_entrance"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="cave"](${b.s},${b.w},${b.n},${b.e});
  nwr["boundary"="protected_area"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="nature_reserve"](${b.s},${b.w},${b.n},${b.e});

  // FAMILY
  nwr["tourism"="zoo"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="theme_park"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="park"]["name"](${b.s},${b.w},${b.n},${b.e});

  // PIOGGIA (indoor)
  nwr["amenity"="museum"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="museum"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="theatre"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="cinema"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="arts_centre"]["name"](${b.s},${b.w},${b.n},${b.e});

  // BICI hints (spesso pochi, ma li prendiamo)
  nwr["route"="bicycle"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["highway"="cycleway"]["name"](${b.s},${b.w},${b.n},${b.e});
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
          const msg = `HTTP ${r.status} (${ep}) ${txt.slice(0,140)}`;
          if ([429,502,503,504].includes(r.status)){ lastErr = new Error(msg); continue; }
          throw new Error(msg);
        }
        if (!ct.includes("application/json")){
          const txt = await r.text().catch(() => "");
          lastErr = new Error(`Non-JSON response (${ep}): ${txt.slice(0,140)}`);
          continue;
        }
        return await r.json();
      } catch(e){
        lastErr = e;
      }
    }
    const wait = SLEEP_MS_BASE * attempt * 1.6;
    console.warn(`⚠️ Overpass retry ${attempt}/6 — wait ${Math.round(wait)}ms —`, lastErr?.message || "");
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

function infoUrlFromTags(t){
  // prefer wikidata/wikipedia? noi facciamo “anti-famoso soft”: non lo usiamo per filtrare duro
  // ma se c’è un website, usiamolo.
  return t.website || t.url || "";
}

function makeRow({ el, mode, base, bucket, duration_min, wow_score }){
  const t = el.tags || {};
  const center = getCenter(el);
  if (!center) return null;

  const title = norm(t.name);
  if (!title) return null;

  const id = `mf_ab_${mode}_${el.type}_${el.id}`;
  const city = t["addr:city"] || t["is_in:city"] || "";

  return {
    id,
    title,
    place: title,
    city,
    region: "Abruzzo",
    country_code: "IT",
    lat: Number(center.lat),
    lon: Number(center.lon),

    // QUI è la chiave: category = modalità MF (come Verona “Bici:” ecc.)
    category: mode === "food" ? "mangiare"
            : mode === "family" ? "famiglia"
            : mode === "reset" ? "relax"
            : mode, // bici/moto/pioggia/tramonto/natura/tutti

    duration_bucket: bucket,          // "1h" / "2h"
    duration_min,                     // numero
    why: buildWhy(t, base, mode),

    info_url: infoUrlFromTags(t),
    wow_score,

    repeatable: true,
    source: "osm_overpass"
  };
}

function shuffle(a){
  for (let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

function ensureModeCoverage(rows){
  // se una modalità è a 0, la riempiamo clonando roba “compatibile” (natura/tramonto/famiglia)
  const byMode = new Map();
  for (const m of MODES) byMode.set(m, []);
  for (const r of rows){
    const m = r.category === "mangiare" ? "food"
            : r.category === "famiglia" ? "family"
            : r.category === "relax" ? "reset"
            : r.category;
    if (byMode.has(m)) byMode.get(m).push(r);
  }

  const pool = rows.filter(r => ["natura","tramonto","famiglia","relax"].includes(r.category));
  shuffle(pool);

  const extras = [];
  const needModes = ["family","bici","moto","pioggia","tramonto","food","natura","reset"];
  for (const m of needModes){
    if ((byMode.get(m)?.length || 0) >= PER_MODE_MIN) continue;

    const missing = PER_MODE_MIN - (byMode.get(m)?.length || 0);
    for (let i=0;i<missing && i<pool.length;i++){
      const src = pool[(i + Math.floor(Math.random()*pool.length)) % pool.length];
      const clone = { ...src };

      // id unico + categoria target
      clone.id = `${src.id}__fill_${m}_${i}`;
      clone.category = m === "food" ? "mangiare"
                   : m === "family" ? "famiglia"
                   : m === "reset" ? "relax"
                   : m;

      // bucket coerente
      clone.duration_bucket = (m === "tramonto" || m === "pioggia" || m === "reset") ? "1h" : src.duration_bucket;
      clone.duration_min = durationMinFor(clone.duration_bucket);

      // why coerente
      clone.why = src.why.includes("Sosta") && m !== "food" ? buildWhy({}, "natura", m) : buildWhy({}, "natura", m);

      extras.push(clone);
    }
  }

  return rows.concat(extras);
}

async function main(){
  const stats = {
    region: "Abruzzo",
    bbox: ABRUZZO_BBOX,
    grid: GRID,
    endpoints: ENDPOINTS,
    tiles_total: 0,
    tiles_ok_A: 0,
    tiles_fail_A: 0,
    tiles_ok_food: 0,
    tiles_fail_food: 0,
  };

  try{
    console.log("BUILD MAI FATTO ABRUZZO (VERONA-STYLE) — endpoints:", ENDPOINTS);
    console.log("GRID:", GRID.cols, "x", GRID.rows);

    const tiles = tilesForBBox(ABRUZZO_BBOX, GRID);
    const tilesToRun = MAX_TILES ? tiles.slice(0, MAX_TILES) : tiles;
    stats.tiles_total = tilesToRun.length;

    const map = new Map();

    let idx = 0;
    for (const tile of tilesToRun){
      idx++;
      console.log(`Tile ${idx}/${tilesToRun.length} ...`);

      // A) WOW+FAMILY+PIAGGIA+BICI hints
      try{
        const jsonA = await overpassFetch(overpassQueryA(tile));
        const elsA = Array.isArray(jsonA?.elements) ? jsonA.elements : [];
        for (const el of elsA){
          if (!el?.tags?.name) continue;
          if (isBadElement(el)) continue;
          const k = dedupeKey(el);
          if (!map.has(k)) map.set(k, el);
        }
        stats.tiles_ok_A++;
      } catch(e){
        stats.tiles_fail_A++;
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
        stats.tiles_ok_food++;
      } catch(e){
        stats.tiles_fail_food++;
        console.warn("⚠️ Tile FOOD failed:", e.message);
      }

      await sleep(SLEEP_MS_BASE);
    }

    const all = Array.from(map.values());
    console.log("Raw candidates:", all.length);

    // anti-famoso soft: preferiamo no-wiki, ma se scarseggia, molliamo
    let preferred = all.filter(el => !hasWiki(el.tags || {}));
    if (preferred.length < 500) preferred = all;

    // punteggio + shuffle
    const scored = preferred
      .map(el => {
        const t = el.tags || {};
        const base = baseCategory(t);
        const wow = scoreWow(t, base);
        return { el, base, wow };
      })
      .sort((a,b)=>b.wow - a.wow);

    const picked = scored.slice(0, Math.min(TARGET_TOTAL, scored.length));

    // costruiamo righe MULTI-MODE (una stessa idea può generare più “modalità”)
    const rows = [];
    const seen = new Set();

    for (const item of picked){
      const el = item.el;
      const t = el.tags || {};
      const base = item.base;

      const modes = pickModes(t, base);

      for (const mode of modes){
        if (mode === "tutti") {
          // “tutti” lo rappresentiamo come “natura/tramonto/…” (non serve duplicare)
          continue;
        }

        const bucket = durationBucketFor(base);
        const duration_min = durationMinFor(bucket);

        const r = makeRow({
          el,
          mode,
          base,
          bucket,
          duration_min,
          wow_score: item.wow
        });

        if (!r) continue;

        // dedupe per id
        if (seen.has(r.id)) continue;
        seen.add(r.id);

        // no titoli troppo corti
        if (r.title.length < 5) continue;

        rows.push(r);
      }

      // Inseriamo anche una versione “base” per Natura/Tramonto/Relax/Famiglia/Mangiare
      // così se l’engine filtra per category classica, trova comunque.
      const baseMode = base === "mangiare" ? "food"
                    : base === "famiglia" ? "family"
                    : base === "relax" ? "reset"
                    : base; // natura / tramonto
      const bucket2 = durationBucketFor(base);
      const r2 = makeRow({
        el,
        mode: baseMode,
        base,
        bucket: bucket2,
        duration_min: durationMinFor(bucket2),
        wow_score: item.wow
      });
      if (r2 && !seen.has(r2.id)) { seen.add(r2.id); rows.push(r2); }
    }

    // garantiamo che non ci siano “modalità a zero”
    const finalRows = ensureModeCoverage(rows);

    // pulizia finale: dedupe per titolo+lat+lon+category
    const uniq = new Map();
    for (const r of finalRows){
      const key = `${r.title.toLowerCase()}|${r.lat.toFixed(5)}|${r.lon.toFixed(5)}|${r.category}|${r.duration_bucket}`;
      if (!uniq.has(key)) uniq.set(key, r);
    }

    const ideas = Array.from(uniq.values());

    const out = {
      updated_at: new Date().toISOString(),
      count: ideas.length,
      area: "Abruzzo — Mai Fatto (VERONA-STYLE) • tutte le modalità",
      stats,
      ideas
    };

    writeJSON(OUT_PATH, out);
    console.log("✅ Wrote:", OUT_PATH, "| ideas:", ideas.length);

  } catch(e){
    console.error("FATAL:", e);

    // output garantito (così non rompe l’app)
    const out = {
      updated_at: new Date().toISOString(),
      count: 0,
      area: "Abruzzo — build FAILED (placeholder scritto comunque)",
      stats: { ...stats, error: String(e?.message || e) },
      ideas: []
    };

    writeJSON(OUT_PATH, out);
    console.log("✅ Wrote placeholder:", OUT_PATH);
    process.exit(0);
  }
}

main();
