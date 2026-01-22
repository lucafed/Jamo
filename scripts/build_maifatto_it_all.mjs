// scripts/build_maifatto_it_all.mjs
// Genera dataset "Mai Fatto" WOW per tutta Italia usando OSM Overpass
// Output: public/data/mai_fatto/mai_fatto_it_all.json
//
// Filosofia "WOW e sconosciuto":
// - Penalizza/filtra POI con wikipedia/wikidata (spesso famosi)
// - Preferisce: viewpoint, waterfall, gorge, cave, hermitage/chapel isolata, bridge, ruin, spring, scenic routes
// - Evita "centri ovvi": riduce place=city/town e POI con brand/commerciale
//
// Requisiti: Node 20+ (fetch nativo)
// Env opzionali:
//  OVERPASS_ENDPOINT (default: https://overpass-api.de/api/interpreter)
//  MAX_TILES (debug, limita numero di tile)
//  SLEEP_MS (default 1200)

import fs from "fs";
import path from "path";

const OVERPASS = process.env.OVERPASS_ENDPOINT || "https://overpass-api.de/api/interpreter";
const SLEEP_MS = Number(process.env.SLEEP_MS || 1200);
const MAX_TILES = process.env.MAX_TILES ? Number(process.env.MAX_TILES) : null;

// Italia bbox approx (W,S,E,N)
const IT_BBOX = { w: 6.5, s: 36.0, e: 18.7, n: 47.2 };

// griglia: più piccola = meno timeout (ma più chiamate)
const GRID = { cols: 10, rows: 10 };

// quanti POI finali vogliamo (dataset unico): grande ma non assurdo
const TARGET_IDEAS = 12000;

// hard excludes “commercial/brand”
const BAD_WORDS = [
  "outlet", "shopping", "iper", "supermerc", "lidl", "esselunga", "coop",
  "conad", "eurospin", "md", "pam", "carrefour", "ikea", "leroy merlin",
  "centro commerciale", "parco commerciale", "autogrill"
];

// evita che “wow” diventi “centro città”
const BAD_TAGS = new Set([
  "place=city",
  "place=town",
  "boundary=administrative"
]);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJSON(filePath, obj) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] != null) out[k] = obj[k];
  return out;
}

function norm(s) {
  return String(s || "").trim();
}

function hasBadWords(name) {
  const n = norm(name).toLowerCase();
  if (!n) return false;
  return BAD_WORDS.some(w => n.includes(w));
}

function hasWiki(tags) {
  return Boolean(tags?.wikipedia || tags?.wikidata);
}

function getCenter(el) {
  // Overpass può dare lat/lon diretti o "center"
  if (typeof el.lat === "number" && typeof el.lon === "number") return { lat: el.lat, lon: el.lon };
  if (el.center && typeof el.center.lat === "number" && typeof el.center.lon === "number") return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

// euristica per “wow category” (usa le categorie che app già filtra: relax/famiglia/bici/moto/natura/pioggia/tramonto/mangiare/1h/2h)
function classify(tags) {
  const t = tags || {};
  const k = (x) => (t[x] ? String(t[x]) : "");

  // NATURA WOW
  if (k("waterway") === "waterfall" || k("natural") === "waterfall") return "natura";
  if (k("natural") === "cave_entrance" || k("natural") === "cave") return "natura";
  if (k("natural") === "peak" || k("natural") === "ridge" || k("natural") === "cliff") return "tramonto";
  if (k("tourism") === "viewpoint") return "tramonto";
  if (k("natural") === "spring") return "relax";
  if (k("leisure") === "nature_reserve" || k("boundary") === "protected_area") return "natura";

  // STORIA / “da raccontare”
  if (k("historic") === "ruins" || k("historic") === "castle" || k("historic") === "fort" || k("historic") === "archaeological_site")
    return "2h";

  // CHIESE/EREMI (wow silenzioso)
  if (k("amenity") === "place_of_worship" && (k("religion") === "christian" || k("building") === "chapel" || k("denomination")))
    return "relax";

  // PONTI / COSE “strane”
  if (k("man_made") === "bridge" || k("bridge")) return "1h";

  // FAMILY: zoo/fattorie didattiche/aree avventura (OSM spesso: tourism=zoo, leisure=park, attraction=* specifico)
  if (k("tourism") === "zoo" || k("tourism") === "theme_park") return "famiglia";
  if (k("leisure") === "park" && k("name")) return "famiglia";

  // MANGIARE: se è un punto “food local” (senza brand)
  if ((k("amenity") === "restaurant" || k("amenity") === "pub" || k("amenity") === "cafe") && k("name")) return "mangiare";

  // default
  return "natura";
}

// stima durata (non troppo importante: app filtra per minuti auto, ma serve un “~” sensato)
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
    "mangiare": [70, 150]
  };
  const [a, b] = ranges[cat] || [60, 120];
  return Math.round(a + (b - a) * r);
}

// “Perché te lo propongo” template (solo WHY, niente “how”)
function buildWhy(tags, cat) {
  const t = tags || {};
  const name = norm(t.name);
  const hasView = (t.tourism === "viewpoint" || t.natural === "peak" || t.natural === "cliff");
  const isWater = (t.waterway === "waterfall" || t.natural === "waterfall" || t.natural === "spring");
  const isCave = (t.natural === "cave_entrance" || t.natural === "cave");
  const isRuins = (t.historic === "ruins" || t.historic === "castle" || t.historic === "fort" || t.historic === "archaeological_site");
  const isBridge = (t.man_made === "bridge" || t.bridge);

  // poche frasi, “wow” ma concreto
  if (cat === "tramonto" && hasView) return "È un punto alto/panoramico che spesso non ha folla: la luce cambia tutto e sembra di essere lontanissimo, anche se sei vicino.";
  if (cat === "natura" && isWater) return "Qui l’acqua fa scena davvero: rumore, aria fresca e una sensazione da mini-viaggio che pochi si aspettano in zona.";
  if (cat === "natura" && isCave) return "È un posto ‘strano’ e sorprendente: un taglio nella roccia che ti fa dire “ma davvero esiste qui?”.";
  if (cat === "2h" && isRuins) return "È storia vera ma fuori dal giro ‘ovvio’: ti dà quel mix di scenografia e silenzio che resta addosso.";
  if (cat === "1h" && isBridge) return "È una piccola meraviglia ‘di passaggio’ che quasi tutti ignorano: perfetta per una pausa wow senza organizzare nulla.";
  if (cat === "relax") return "È un posto tranquillo e ‘pulito’ (non da turismo di massa): ideale quando vuoi staccare senza fare chilometri.";
  if (cat === "famiglia") return "È un posto che funziona in famiglia perché dà spazio e stimoli reali, senza dover ‘inventare’ intrattenimento.";
  if (cat === "mangiare") return "È una sosta che diventa racconto: atmosfera locale e ritmo lento, senza il caos dei posti troppo famosi.";

  // fallback
  return "È una micro-meta poco ovvia: abbastanza speciale da valere l’uscita, abbastanza vicina da farlo anche al volo.";
}

function isBadElement(el) {
  const t = el.tags || {};
  const name = norm(t.name);
  if (!name) return true;
  if (hasBadWords(name)) return true;

  // filtra “place=city/town” e simili (non sono POI wow)
  for (const [k, v] of Object.entries(t)) {
    const kv = `${k}=${v}`;
    if (BAD_TAGS.has(kv)) return true;
  }
  return false;
}

// punteggio WOW: più alto = più probabile
function scoreWow(el) {
  const t = el.tags || {};
  let s = 0;

  // forte boost a cose tipicamente wow
  if (t.tourism === "viewpoint") s += 40;
  if (t.waterway === "waterfall" || t.natural === "waterfall") s += 45;
  if (t.natural === "cave_entrance" || t.natural === "cave") s += 35;
  if (t.historic === "ruins" || t.historic === "castle" || t.historic === "fort") s += 30;
  if (t.man_made === "bridge" || t.bridge) s += 16;
  if (t.natural === "spring") s += 18;
  if (t.boundary === "protected_area" || t.leisure === "nature_reserve") s += 15;

  // penalizza cose “famosette”
  if (hasWiki(t)) s -= 35;

  // penalizza “ristoranti generici” (se non vuoi: togli)
  if (t.amenity === "restaurant") s -= 8;

  // piccoli boost se ha "information=board" ecc (meta escursionistica)
  if (t.information) s += 6;

  // se ha “name” non troppo generico
  const name = norm(t.name);
  if (name.length >= 10) s += 4;

  return s;
}

// build query Overpass per un bbox tile
function overpassQuery(b) {
  // usiamo out center per avere coordinate anche per relation/way
  // Prendiamo un set “wow-friendly” (POI + small places)
  return `
[out:json][timeout:180];
(
  // viewpoint / panorama
  nwr["tourism"="viewpoint"](${b.s},${b.w},${b.n},${b.e});

  // waterfall / spring / cave
  nwr["waterway"="waterfall"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="waterfall"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="spring"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="cave_entrance"](${b.s},${b.w},${b.n},${b.e});
  nwr["natural"="cave"](${b.s},${b.w},${b.n},${b.e});

  // ruins/castle/fort/archaeology
  nwr["historic"="ruins"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="castle"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="fort"](${b.s},${b.w},${b.n},${b.e});
  nwr["historic"="archaeological_site"](${b.s},${b.w},${b.n},${b.e});

  // bridges / structures
  nwr["man_made"="bridge"](${b.s},${b.w},${b.n},${b.e});
  way["bridge"](${b.s},${b.w},${b.n},${b.e});

  // nature reserves / protected areas (quando ci sono)
  nwr["boundary"="protected_area"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="nature_reserve"](${b.s},${b.w},${b.n},${b.e});

  // family-ish
  nwr["tourism"="zoo"](${b.s},${b.w},${b.n},${b.e});
  nwr["tourism"="theme_park"](${b.s},${b.w},${b.n},${b.e});
  nwr["leisure"="park"](${b.s},${b.w},${b.n},${b.e});

  // food (solo se ha name; verrà penalizzato in score)
  nwr["amenity"="restaurant"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="pub"]["name"](${b.s},${b.w},${b.n},${b.e});
  nwr["amenity"="cafe"]["name"](${b.s},${b.w},${b.n},${b.e});
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

function dedupeKey(el) {
  return `${el.type}:${el.id}`;
}

function buildIdea(el) {
  const t = el.tags || {};
  const center = getCenter(el);
  if (!center) return null;

  const name = norm(t.name);
  if (!name) return null;

  const cat = classify(t);
  const why = buildWhy(t, cat);

  // campi base per UI Jamo
  return {
    id: `it_${el.type}_${el.id}`,
    title: name, // title = nome “vero”
    place: name, // puoi sostituire con t["addr:place"] se vuoi
    city: t["addr:city"] || t["is_in:city"] || "", // spesso vuoto: ok
    region: t["addr:state"] || "",                 // spesso vuoto: ok
    country_code: "IT",
    lat: Number(center.lat),
    lon: Number(center.lon),
    category: cat,
    duration_bucket: (cat === "2h" ? "2h" : "1h"),
    duration_min: durationFor(cat),
    why,
    repeatable: true,
    // link “info” opzionale: preferisci Wikipedia? NO -> meglio maps search (lo fa già UI).
    url: "",
    source: "osm_overpass"
  };
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sampleTopWow(elements, max) {
  // ordina per score desc, ma aggiunge un po’ di random per varietà settimanale
  const scored = elements.map(el => ({ el, s: scoreWow(el) + (Math.random() * 8) }));
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, max).map(x => x.el);
}

async function main() {
  console.log("BUILD MAI FATTO IT — endpoint:", OVERPASS);

  const tiles = tilesForBBox(IT_BBOX, GRID);
  const tilesToRun = MAX_TILES ? tiles.slice(0, MAX_TILES) : tiles;

  console.log("Tiles:", tilesToRun.length, `(grid ${GRID.cols}x${GRID.rows})`);

  const map = new Map(); // dedupe OSM elements
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
        // tieni l’elemento con score migliore se duplicato
        if (!map.has(key)) {
          map.set(key, el);
        } else {
          const prev = map.get(key);
          if (scoreWow(el) > scoreWow(prev)) map.set(key, el);
        }
      }
    } catch (e) {
      console.warn("⚠️ Overpass tile error:", e.message);
      // continua: meglio un dataset parziale che niente
    }

    await sleep(SLEEP_MS);
  }

  const all = Array.from(map.values());

  console.log("Raw candidates:", all.length);

  // Togli quelli troppo “famosi” (wiki) e/o troppo generici
  const filtered = all.filter(el => {
    const t = el.tags || {};
    if (hasWiki(t)) return false;            // fortissimo filtro “sconosciuti”
    if (hasBadWords(t.name)) return false;
    return true;
  });

  console.log("After filter (no wiki):", filtered.length);

  // prendi i migliori “wow” e poi costruisci ideas
  const selected = sampleTopWow(filtered, Math.min(TARGET_IDEAS, filtered.length));
  shuffleInPlace(selected); // mix per varietà

  const ideas = [];
  for (const el of selected) {
    const idea = buildIdea(el);
    if (!idea) continue;
    // ultima barriera: evita title troppo corto/generico
    if (idea.title.length < 4) continue;
    ideas.push(idea);
  }

  // se ancora troppo poche, fallback “meno duro”: reinserisci anche POI con wiki ma penalizzati
  if (ideas.length < 2500) {
    console.log("Low ideas, softening filter (allow wiki but low score) ...");
    const selected2 = sampleTopWow(all, Math.min(TARGET_IDEAS, all.length));
    for (const el of selected2) {
      const idea = buildIdea(el);
      if (!idea) continue;
      if (ideas.find(x => x.id === idea.id)) continue;
      ideas.push(idea);
      if (ideas.length >= 5000) break;
    }
  }

  // output
  const out = {
    updated_at: new Date().toISOString(),
    count: ideas.length,
    area: "Italia (tutto il territorio)",
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
