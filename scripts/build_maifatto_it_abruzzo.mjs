// scripts/build_maifatto_it_abruzzo.mjs (FOOD-RICH • WOW • Anti-ovvio • Abruzzo only)
// Output: public/data/mai_fatto/mai_fatto_it_abruzzo.json
//
// Node 20+ (fetch nativo)
// Anti-504: rotate endpoints + retry + backoff + output always written

import fs from "fs";
import path from "path";

// ---------- Overpass endpoints (fallback + rotate) ----------
const OVERPASS_ENDPOINTS = (process.env.OVERPASS_ENDPOINTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/cgi/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
];

const ENDPOINTS = OVERPASS_ENDPOINTS.length ? OVERPASS_ENDPOINTS : DEFAULT_ENDPOINTS;

// ---------- Tuning ----------
const SLEEP_MS = Number(process.env.SLEEP_MS || 1400);
const GRID = { cols: 3, rows: 3 }; // 9 tiles -> leggerissimo
const TARGET_IDEAS = Number(process.env.TARGET_IDEAS || 2200);

// Abruzzo bbox approx (W,S,E,N)
const ABRUZZO_BBOX = { w: 13.02, s: 41.67, e: 14.78, n: 42.90 };

// blacklist brand/commerciale
const BAD_WORDS = [
  "outlet", "shopping", "iper", "supermerc", "lidl", "esselunga", "coop", "conad", "eurospin",
  "md", "pam", "carrefour", "ikea", "leroy merlin", "centro commerciale", "parco commerciale",
  "autogrill", "mc don", "mcdon", "burger king", "kfc", "starbucks"
];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function writeJSON(filePath, obj) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}
function norm(s) { return String(s || "").trim(); }
function hasBadWords(name) {
  const n = norm(name).toLowerCase();
  if (!n) return false;
  return BAD_WORDS.some((w) => n.includes(w));
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

  if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) return true;

  const amen = String(t.amenity || "");
  if (["fuel", "bank", "atm", "pharmacy", "clinic", "hospital"].includes(amen)) return true;

  if (t.tourism === "hotel" || t.tourism === "motel" || t.tourism === "hostel") return true;

  return false;
}

// ---------- FOOD classifier (ricchissimo) ----------
function isFood(tags) {
  const t = tags || {};
  const amen = String(t.amenity || "");
  const shop = String(t.shop || "");
  const craft = String(t.craft || "");
  const tourism = String(t.tourism || "");
  const cuisine = norm(t.cuisine);

  if (["restaurant", "pub", "cafe", "bar", "fast_food", "ice_cream", "biergarten"].includes(amen)) return true;
  if (tourism === "winery") return true;
  if (amen === "marketplace") return true;

  if ([
    "deli", "cheese", "butcher", "bakery", "pastry", "confectionery",
    "chocolate", "farm", "farm_shop", "greengrocer", "seafood", "wine", "beverages"
  ].includes(shop)) return true;

  if (["brewery", "distillery"].includes(craft)) return true;

  const name = norm(t.name).toLowerCase();
  if (name.includes("agriturismo") || name.includes("osteria") || name.includes("trattoria") || name.includes("frantoio") || name.includes("caseificio")) return true;

  if (cuisine) return true;
  return false;
}

function classify(tags) {
  const t = tags || {};

  if (isFood(t)) return "mangiare";

  // WOW natura
  if (t.tourism === "viewpoint") return "tramonto";
  if (t.waterway === "waterfall" || t.natural === "waterfall") return "natura";
  if (t.natural === "cave_entrance" || t.natural === "cave") return "natura";
  if (t.natural === "peak" || t.natural === "cliff" || t.natural === "ridge") return "tramonto";
  if (t.natural === "spring") return "relax";
  if (t.boundary === "protected_area" || t.leisure === "nature_reserve") return "natura";

  // Storia
  if (["ruins", "castle", "fort", "archaeological_site"].includes(String(t.historic || ""))) return "2h";

  // Ponti / manufatti
  if (t.man_made === "bridge" || t.bridge) return "1h";

  // Family
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

function buildWhy(tags, cat) {
  const t = tags || {};
  const hasView = (t.tourism === "viewpoint" || t.natural === "peak" || t.natural === "cliff");
  const isWater = (t.waterway === "waterfall" || t.natural === "waterfall" || t.natural === "spring");
  const isCave = (t.natural === "cave_entrance" || t.natural === "cave");
  const isRuins = ["ruins", "castle", "fort", "archaeological_site"].includes(String(t.historic || ""));
  const isBridge = (t.man_made === "bridge" || t.bridge);

  if (cat === "mangiare") {
    const cue = [];
    if (t.tourism === "winery" || t.shop === "wine") cue.push("vino locale");
    if (t.craft === "brewery") cue.push("birra artigianale");
    if (t.shop === "cheese" || norm(t.name).toLowerCase().includes("caseificio")) cue.push("caseificio");
    if (t.shop === "bakery") cue.push("forno");
    if (t.amenity === "ice_cream") cue.push("gelato artigianale");
    if (t.amenity === "marketplace") cue.push("mercato");
    if (norm(t.name).toLowerCase().includes("frantoio") || t.shop === "farm_shop") cue.push("sapori veri");
    const extra = cue.length ? ` (${cue.slice(0, 2).join(" • ")})` : "";
    return `Sembra “di paese” nel modo migliore${extra}: spesso non è nei giri ovvi, ma ti lascia la sensazione di scoperta vera.`;
  }

  if (cat === "tramonto" && hasView) return "Punto panoramico spesso fuori dal giro ovvio: quando la luce cambia diventa una scena da raccontare.";
  if (cat === "natura" && isWater) return "Qui l’acqua cambia l’atmosfera: suono, aria fresca, wow immediato senza fatica.";
  if (cat === "natura" && isCave) return "Una sorpresa naturale ‘strana’ al punto giusto: sembra lontana, invece è qui.";
  if (cat === "2h" && isRuins) return "Storia senza folla: scenografia vera e silenzio, perfetto per un’uscita che diventa racconto.";
  if (cat === "1h" && isBridge) return "Piccola meraviglia che molti attraversano senza notare: colpo di wow rapido.";
  if (cat === "relax") return "Semplice ma pulito (non da massa): ti stacca la testa senza organizzare nulla.";
  if (cat === "famiglia") return "Family vero: spazio e stimoli reali, senza dover intrattenere i bambini ogni secondo.";

  return "Micro-meta poco ovvia: abbastanza speciale da valere l’uscita, abbastanza semplice da farla al volo.";
}

function scoreWow(el) {
  const t = el.tags || {};
  let s = 0;

  if (t.tourism === "viewpoint") s += 40;
  if (t.waterway === "waterfall" || t.natural === "waterfall") s += 52;
  if (t.natural === "cave_entrance" || t.natural === "cave") s += 38;
  if (["ruins", "castle", "fort", "archaeological_site"].includes(String(t.historic || ""))) s += 30;
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
    if (c && !["pizza", "burger", "kebab", "italian"].includes(c)) s += 6;
  }

  if (hasWiki(t)) s -= 40;
  if (t.brand || t["brand:wikidata"] || t["brand:wikipedia"]) s -= 40;

  const name = norm(t.name);
  if (name.length >= 10) s += 4;

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
  let lastErr = null;

  for (let attempt = 1; attempt <= 6; attempt++) {
    const endpoint = ENDPOINTS[(attempt - 1) % ENDPOINTS.length];

    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: "data=" + encodeURIComponent(query),
      });

      if (!r.ok) {
        const text = await r.text().catch(() => "");
        if ([429, 502, 503, 504].includes(r.status)) {
          lastErr = new Error(`Overpass HTTP ${r.status} @ ${endpoint}: ${text.slice(0, 120)}`);
          await sleep(900 * attempt);
          continue;
        }
        throw new Error(`Overpass HTTP ${r.status} @ ${endpoint}: ${text.slice(0, 160)}`);
      }

      return await r.json();
    } catch (e) {
      lastErr = e;
      await sleep(900 * attempt);
      continue;
    }
  }

  throw lastErr || new Error("Overpass fetch failed");
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
    id: `it_abruzzo_${el.type}_${el.id}`,
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

function sampleTop(elements, max) {
  const scored = elements.map((el) => ({ el, s: scoreWow(el) }));
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, max).map((x) => x.el);
}

async function main() {
  console.log("BUILD MAI FATTO — ABRUZZO");
  console.log("Endpoints:", ENDPOINTS.join(" | "));
  console.log("Grid:", `${GRID.cols}x${GRID.rows}`);

  const tiles = tilesForBBox(ABRUZZO_BBOX, GRID);

  const map = new Map();
  let tileIdx = 0;

  for (const tile of tiles) {
    tileIdx++;
    console.log(`Tile ${tileIdx}/${tiles.length} ...`);
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

  // prima passata anti-ovvio
  let filtered = all.filter((el) => !hasWiki(el.tags || {}));
  console.log("After filter (no wiki):", filtered.length);

  // se troppo pochi, riapri
  if (filtered.length < 350) filtered = all;

  const selected = sampleTop(filtered, Math.min(TARGET_IDEAS, filtered.length));

  const ideas = [];
  const seenName = new Set();

  for (const el of selected) {
    const idea = buildIdea(el);
    if (!idea) continue;

    const keyName = idea.title.toLowerCase();
    if (seenName.has(keyName)) continue;
    seenName.add(keyName);

    if (idea.title.length < 5) continue;
    ideas.push(idea);
  }

  const out = {
    updated_at: new Date().toISOString(),
    count: ideas.length,
    area: "Abruzzo — WOW + Food ricchissimo (Overpass)",
    ideas
  };

  const outPath = path.join(process.cwd(), "public/data/mai_fatto/mai_fatto_it_abruzzo.json");
  writeJSON(outPath, out);

  console.log("✅ Wrote:", outPath);
  console.log("Ideas:", ideas.length);
}

main().catch((e) => {
  // IMPORTANT: scrivi comunque un file vuoto ma valido
  console.error("FATAL:", e);

  const outPath = path.join(process.cwd(), "public/data/mai_fatto/mai_fatto_it_abruzzo.json");
  const out = {
    updated_at: new Date().toISOString(),
    count: 0,
    area: "Abruzzo — WOW + Food (FAILED RUN, file scritto comunque)",
    ideas: []
  };
  writeJSON(outPath, out);
  process.exit(0); // non far fallire l'action
});
