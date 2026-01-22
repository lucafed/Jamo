// scripts/build_maifatto_it_all.mjs  (FOOD-RICH • WOW • Anti-ovvio)
// Output: public/data/mai_fatto/mai_fatto_it_all.json
//
// WOW+sconosciuti:
// - forte filtro wikipedia/wikidata (spesso luoghi famosi)
// - blacklist brand/commerciale
// - FOOD ricchissimo: agriturismi, osterie, trattorie, enoteche, cantine, birrifici, frantoi, caseifici,
//   panifici, pasticcerie, gelaterie, street_food, mercati, farm shop, botteghe tipiche
//
// Node 20+ (fetch nativo)

import fs from "fs";
import path from "path";

const OVERPASS = process.env.OVERPASS_ENDPOINT || "https://overpass-api.de/api/interpreter";
const SLEEP_MS = Number(process.env.SLEEP_MS || 1200);
const MAX_TILES = process.env.MAX_TILES ? Number(process.env.MAX_TILES) : null;

// Italia bbox approx (W,S,E,N)
const IT_BBOX = { w: 6.5, s: 36.0, e: 18.7, n: 47.2 };
const GRID = { cols: 10, rows: 10 };

// grande: vogliamo tanti posti
const TARGET_IDEAS = 16000;

// parole da tagliare (brand/centri commerciali)
const BAD_WORDS = [
  "outlet", "shopping", "iper", "supermerc", "lidl", "esselunga", "coop", "conad", "eurospin",
  "md", "pam", "carrefour", "ikea", "leroy merlin", "centro commerciale", "parco commerciale",
  "autogrill", "mc don", "mcdon", "burger king", "kfc", "starbucks"
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function writeJSON(filePath, obj) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

function norm(s) { return String(s || "").trim(); }
function hasBadWords(name) {
  const n = norm(name).toLowerCase();
  if (!n) return false;
  return BAD_WORDS.some(w => n.includes(w));
}
function hasWiki(tags) { return Boolean(tags?.wikipedia || tags?.wikidata); }

function getCenter(el) {
  if (typeof el.lat === "number" && typeof el.lon === "number") return { lat: el.lat, lon: el.lon };
  if (el.center && typeof el.center.lat === "number" && typeof el.center.lon === "number") return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

function isBadElement(el) {
  const t = el.tags || {};
  const name = norm(t.name);
  if (!name) return true;
  if (hasBadWords(name)) return true;

  // taglia cose “commercial brand”
  if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) return true;

  // evita supermercati/pompe ecc
  const amen = String(t.amenity || "");
  if (["fuel", "bank", "atm", "pharmacy", "clinic", "hospital"].includes(amen)) return true;

  // evita hotel/strutture “non idea”
  if (t.tourism === "hotel" || t.tourism === "motel" || t.tourism === "hostel") return true;

  return false;
}

// ---------- Classificazione: tutto ciò che è food -> "mangiare"
function isFood(tags) {
  const t = tags || {};
  const amen = String(t.amenity || "");
  const shop = String(t.shop || "");
  const craft = String(t.craft || "");
  const tourism = String(t.tourism || "");
  const cuisine = norm(t.cuisine);

  // ristorazione
  if (["restaurant", "pub", "cafe", "bar", "fast_food", "ice_cream", "biergarten"].includes(amen)) return true;

  // enoteche / cantine
  if (tourism === "winery") return true;

  // mercati
  if (amen === "marketplace") return true;

  // botteghe tipiche / food shop
  if ([
    "deli", "cheese", "butcher", "bakery", "pastry", "confectionery",
    "chocolate", "farm", "farm_shop", "greengrocer", "seafood", "wine", "beverages"
  ].includes(shop)) return true;

  // birrifici / distillerie
  if (["brewery", "distillery"].includes(craft)) return true;

  // agriturismo (spesso tourism=guest_house + name… ma non vogliamo lodging; quindi teniamo solo se “agriturismo” nel nome)
  const name = norm(t.name).toLowerCase();
  if (name.includes("agriturismo") || name.includes("osteria") || name.includes("trattoria")) return true;

  // se c’è cuisine è molto spesso food
  if (cuisine) return true;

  return false;
}

function classify(tags) {
  const t = tags || {};

  // FOOD prima: deve essere ricchissimo
  if (isFood(t)) return "mangiare";

  // NATURA / WOW
  if (t.tourism === "viewpoint") return "tramonto";
  if (t.waterway === "waterfall" || t.natural === "waterfall") return "natura";
  if (t.natural === "cave_entrance" || t.natural === "cave") return "natura";
  if (t.natural === "peak" || t.natural === "cliff" || t.natural === "ridge") return "tramonto";
  if (t.natural === "spring") return "relax";
  if (t.boundary === "protected_area" || t.leisure === "nature_reserve") return "natura";

  // STORIA “da raccontare”
  if (["ruins", "castle", "fort", "archaeological_site"].includes(String(t.historic || ""))) return "2h";

  // ponti / manufatti
  if (t.man_made === "bridge" || t.bridge) return "1h";

  // family
  if (t.tourism === "zoo" || t.tourism === "theme_park") return "famiglia";
  if (t.leisure === "park" && t.name) return "famiglia";

  return "natura";
}

function durationFor(cat) {
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
  const [a, b] = ranges[cat] || [60, 120];
  return Math.round(a + (b - a) * r);
}

// WHY: solo perché lo proponi (niente “cosa fare”)
function buildWhy(tags, cat) {
  const t = tags || {};
  const hasView = (t.tourism === "viewpoint" || t.natural === "peak" || t.natural === "cliff");
  const isWater = (t.waterway === "waterfall" || t.natural === "waterfall" || t.natural === "spring");
  const isCave = (t.natural === "cave_entrance" || t.natural === "cave");
  const isRuins = ["ruins", "castle", "fort", "archaeological_site"].includes(String(t.historic || ""));
  const isBridge = (t.man_made === "bridge" || t.bridge);

  if (cat === "mangiare") {
    // più “concreto” ma senza dire cosa fare
    const cue = [];
    if (t.tourism === "winery" || t.shop === "wine") cue.push("vino locale");
    if (t.craft === "brewery") cue.push("birra artigianale");
    if (t.shop === "cheese") cue.push("caseificio");
    if (t.shop === "bakery") cue.push("forno");
    if (t.amenity === "ice_cream") cue.push("gelato artigianale");
    if (t.amenity === "marketplace") cue.push("mercato");
    const extra = cue.length ? ` (${cue.slice(0, 2).join(" • ")})` : "";
    return `È una sosta “vera” e locale${extra}: di solito non è nei giri ovvi e ti dà quella sensazione da scoperta, non da posto turistico standard.`;
  }

  if (cat === "tramonto" && hasView) return "È un punto panoramico spesso fuori dal giro ovvio: quando la luce cambia, diventa una scena da ricordare.";
  if (cat === "natura" && isWater) return "Qui l’acqua fa davvero differenza: aria fresca, suono, atmosfera. È una mini-fuga che sorprende.";
  if (cat === "natura" && isCave) return "È un posto raro e ‘strano’ nel modo giusto: una sorpresa naturale che sembra lontana, invece è qui.";
  if (cat === "2h" && isRuins) return "È storia senza folla: scenografia vera e silenzio, perfetto per un’uscita che diventa racconto.";
  if (cat === "1h" && isBridge) return "È una piccola meraviglia che la maggior parte attraversa senza notare: ideale per un colpo di wow rapido.";
  if (cat === "relax") return "È un posto semplice ma ‘pulito’ (non da turismo di massa): ti stacca senza chiederti fatica o organizzazione.";
  if (cat === "famiglia") return "È family nel senso giusto: spazio e stimoli reali, senza dover riempire la giornata con mille cose.";

  return "È una micro-meta poco ovvia: abbastanza speciale da valere l’uscita, abbastanza vicina da farlo anche al volo.";
}

// score WOW: mix “wow” + “non famoso” + “food di qualità”
function scoreWow(el) {
  const t = el.tags || {};
  let s = 0;

  // wow naturali
  if (t.tourism === "viewpoint") s += 40;
  if (t.waterway === "waterfall" || t.natural === "waterfall") s += 50;
  if (t.natural === "cave_entrance" || t.natural === "cave") s += 38;
  if (["ruins", "castle", "fort", "archaeological_site"].includes(String(t.historic || ""))) s += 30;
  if (t.man_made === "bridge" || t.bridge) s += 14;
  if (t.natural === "spring") s += 18;

  // food ricco: boost se “sembra artigianale/locale”
  if (isFood(t)) {
    s += 26;
    if (t.tourism === "winery") s += 12;
    if (t.craft === "brewery" || t.craft === "distillery") s += 12;
    if (t.shop === "cheese" || t.shop === "bakery" || t.shop === "farm_shop" || t.shop === "deli") s += 10;
    if (t.amenity === "ice_cream" || t.shop === "pastry") s += 8;

    // cuisine aiuta (ma non deve essere “pizza” generic)
    const c = norm(t.cuisine).toLowerCase();
    if (c) s += 8;
    if (c && !["pizza", "burger", "kebab", "italian"].includes(c)) s += 6;
  }

  // anti-famosi
  if (hasWiki(t)) s -= 40;
  if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) s -= 40;

  // name non troppo corto
  const name = norm(t.name);
  if (name.length >= 10) s += 4;

  // un filo di random per varietà settimanale
  s += Math.random() * 10;

  return s;
}

function overpassQuery(b) {
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

  // FOOD RICCHISSIMO (solo con name)
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

async function overpassFetch(query) {
  const r = await fetch(OVERPASS, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "data=" + encodeURIComponent(query),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Overpass HTTP ${r.status}: ${text.slice(0, 160)}`);
  }
  return await r.json();
}

function tilesForBBox(bbox, grid) {
  const tiles = [];
  const dx = (bbox.e - bbox.w) / grid.cols;
  const dy = (bbox.n - bbox.s) / grid.rows;
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.cols; x++) {
      const w = bbox.w + dx * x;
      const e = bbox.w + dx * (x + 1);
      const s = bbox.s + dy * y;
      const n = bbox.s + dy * (y + 1);
      tiles.push({ w, s, e, n });
    }
  }
  return tiles;
}

function dedupeKey(el) { return `${el.type}:${el.id}`; }

function buildIdea(el) {
  const t = el.tags || {};
  const center = getCenter(el);
  if (!center) return null;

  const name = norm(t.name);
  if (!name) return null;

  const cat = classify(t);
  const why = buildWhy(t, cat);

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
    duration_bucket: (cat === "2h" ? "2h" : "1h"),
    duration_min: durationFor(cat),
    why,
    repeatable: true,
    url: "",
    source: "osm_overpass"
  };
}

function sampleTop(elements, max) {
  const scored = elements.map(el => ({ el, s: scoreWow(el) }));
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, max).map(x => x.el);
}

async function main() {
  console.log("BUILD MAI FATTO IT (FOOD RICH) — endpoint:", OVERPASS);

  const tiles = tilesForBBox(IT_BBOX, GRID);
  const tilesToRun = MAX_TILES ? tiles.slice(0, MAX_TILES) : tiles;

  console.log("Tiles:", tilesToRun.length, `(grid ${GRID.cols}x${GRID.rows})`);

  const map = new Map();
  let tileIdx = 0;

  for (const tile of tilesToRun) {
    tileIdx++;
    console.log(`Tile ${tileIdx}/${tilesToRun.length} ...`);
    const q = overpassQuery(tile);

    try {
      const json = await overpassFetch(q);
      const els = Array.isArray(json?.elements) ? json.elements : [];
      for (const el of els) {
        if (!el?.tags?.name) continue;
        if (isBadElement(el)) continue;

        const key = dedupeKey(el);
        if (!map.has(key)) map.set(key, el);
        else {
          const prev = map.get(key);
          if (scoreWow(el) > scoreWow(prev)) map.set(key, el);
        }
      }
    } catch (e) {
      console.warn("⚠️ Overpass tile error:", e.message);
    }

    await sleep(SLEEP_MS);
  }

  const all = Array.from(map.values());
  console.log("Raw candidates:", all.length);

  // filtro “anti-ovvio”: prima passata senza wiki
  let filtered = all.filter(el => !hasWiki(el.tags || {}));
  console.log("After filter (no wiki):", filtered.length);

  // se scende troppo, riapri un po’ (ma score penalizza comunque wiki)
  if (filtered.length < 6000) {
    console.log("Low no-wiki pool, softening filter...");
    filtered = all;
  }

  // pick top by score
  const selected = sampleTop(filtered, Math.min(TARGET_IDEAS, filtered.length));

  // build ideas
  const ideas = [];
  const seenName = new Set();

  for (const el of selected) {
    const idea = buildIdea(el);
    if (!idea) continue;

    // dedupe nome (evita 3 volte lo stesso posto)
    const keyName = idea.title.toLowerCase();
    if (seenName.has(keyName)) continue;
    seenName.add(keyName);

    // evita nomi troppo “generici”
    if (idea.title.length < 5) continue;

    ideas.push(idea);
  }

  const out = {
    updated_at: new Date().toISOString(),
    count: ideas.length,
    area: "Italia (tutto il territorio) — WOW + Food ricchissimo",
    ideas
  };

  const outPath = path.join(process.cwd(), "public/data/mai_fatto/mai_fatto_it_all.json");
  writeJSON(outPath, out);

  console.log("✅ Wrote:", outPath);
  console.log("Ideas:", ideas.length);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
