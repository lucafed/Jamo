#!/usr/bin/env node
/**
 * scripts/build_pois_it_region.mjs — Jamo POIs builder (REGION)
 * v1.0 — robust, offline-first
 *
 * Usage:
 *   node scripts/build_pois_it_region.mjs --region=it-abruzzo
 *   node scripts/build_pois_it_region.mjs --region it-abruzzo
 *
 * Expects:
 *   public/data/regions/<region>.json with:
 *     { "bbox": [minLon, minLat, maxLon, maxLat] }
 *
 * Outputs:
 *   public/data/pois/it/<region>/<category>.json
 *   public/data/pois/it/<region>/index.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

// ---------------------------- CONFIG ----------------------------

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

// Per GitHub Actions: meglio essere pazienti ma non infiniti
const FETCH_TIMEOUT_MS = 120_000; // 120s per query
const ENDPOINT_RETRY = 2;         // retry per endpoint
const GLOBAL_RETRY_DELAY_MS = 1200;

const MAX_SPLIT_DEPTH = 2;        // bbox split: 0 = no split, 2 = fino a 4^2 tile
const MIN_TILE_SPAN_DEG = 0.12;   // evita split assurdi su bbox piccole

// Limitiamo i tag salvati (ti bastano per matching)
const TAG_WHITELIST = new Set([
  "name","name:it","alt_name","short_name",
  "tourism","amenity","leisure","historic","natural","place","boundary",
  "sport","information","man_made",
  "website","contact:website","phone","contact:phone",
  "opening_hours","fee",
  "wikipedia","wikidata",
  "brand","operator"
]);

const CATEGORIES = [
  "family",
  "theme_park",
  "kids_museum",
  "relax",
  "mare",
  "natura",
  "storia",
  "borghi",
  "citta",
  "montagna",
  "viewpoints",
  "hiking",
];

// ---------------------------- ARG PARSE ----------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;

    if (a.includes("=")) {
      const [k, v] = a.split("=");
      out[k.replace(/^--/, "")] = v ?? "";
      continue;
    }

    const k = a.replace(/^--/, "");
    const v = argv[i + 1];
    if (v && !v.startsWith("--")) {
      out[k] = v;
      i++;
    } else {
      out[k] = true;
    }
  }
  return out;
}

// ---------------------------- IO ----------------------------

function readJson(p) {
  const raw = fs.readFileSync(p, "utf-8");
  return JSON.parse(raw);
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf-8");
}

// ---------------------------- HELPERS ----------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function safePickName(tags = {}) {
  return (
    tags["name:it"] ||
    tags.name ||
    tags.short_name ||
    tags.alt_name ||
    ""
  );
}

function bboxToOverpassBox(bbox) {
  // region JSON is [minLon, minLat, maxLon, maxLat]
  const [minLon, minLat, maxLon, maxLat] = bbox.map(Number);
  // Overpass bbox order: (south,west,north,east) = (minLat, minLon, maxLat, maxLon)
  return { south: minLat, west: minLon, north: maxLat, east: maxLon };
}

function bboxSpanDeg(b) {
  const { south, west, north, east } = b;
  return { latSpan: Math.abs(north - south), lonSpan: Math.abs(east - west) };
}

function splitBbox(b) {
  const midLat = (b.south + b.north) / 2;
  const midLon = (b.west + b.east) / 2;
  return [
    { south: b.south, west: b.west, north: midLat, east: midLon },
    { south: b.south, west: midLon, north: midLat, east: b.east },
    { south: midLat, west: b.west, north: b.north, east: midLon },
    { south: midLat, west: midLon, north: b.north, east: b.east },
  ];
}

function isAbortLike(err) {
  const m = String(err?.name || err?.message || "");
  return m.includes("Abort") || m.includes("aborted");
}

async function fetchWithTimeout(url, { method = "POST", headers = {}, body } = {}, timeoutMs = 30_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", ...headers },
      body,
      signal: ctrl.signal,
    });

    // overpass spesso manda HTML/504: gestiamolo
    const text = await r.text().catch(() => "");
    if (!r.ok) {
      const msg = `HTTP ${r.status} ${r.statusText}` + (text ? ` | ${text.slice(0, 120)}` : "");
      throw new Error(msg);
    }

    let j = null;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error("Bad JSON from Overpass");
    }

    // Overpass può tornare { remark: "...runtime error..." }
    if (j?.remark && String(j.remark).toLowerCase().includes("runtime")) {
      throw new Error(`Overpass runtime error: ${String(j.remark).slice(0, 140)}`);
    }

    return j;
  } finally {
    clearTimeout(t);
  }
}

function overpassBody(query) {
  return `data=${encodeURIComponent(query)}`;
}

function boxStr(b) {
  // (south,west,north,east)
  return `${b.south},${b.west},${b.north},${b.east}`;
}

// ---------------------------- QUERIES ----------------------------

function buildCategoryQuery(cat, b) {
  const BB = `(${boxStr(b)})`;

  // NB: teniamo query “mirate”, niente parchi generici ovunque.
  // Usiamo node+way per molti POI; out center per ways.

  const header = `[out:json][timeout:120];`;
  const out = `out tags center qt;`;

  const Q = (body) => `${header}\n(\n${body}\n);\n${out}`;

  if (cat === "theme_park") {
    return Q(`
  node[tourism=theme_park]${BB};
  way[tourism=theme_park]${BB};
  node[leisure=water_park]${BB};
  way[leisure=water_park]${BB};
  node[leisure=amusement_arcade]${BB};
  node["name"~"parco divertimenti|lunapark|luna\\s?park|parco acquatico|acquapark|aqua\\s?park|water\\s?park|giostre",i]${BB};
    `.trim());
  }

  if (cat === "kids_museum") {
    return Q(`
  node[tourism=museum]["name"~"bambin|kids|children|ragazz|interattiv|science|planetari|museo dei bambini|children\\s?museum|science\\s?center",i]${BB};
  way[tourism=museum]["name"~"bambin|kids|children|ragazz|interattiv|science|planetari|museo dei bambini|children\\s?museum|science\\s?center",i]${BB};
  node["name"~"museo dei bambini|children\\s?museum|science\\s?center|planetari|planetarium",i]${BB};
    `.trim());
  }

  if (cat === "viewpoints") {
    return Q(`
  node[tourism=viewpoint]${BB};
  node["name"~"belvedere|panoram|viewpoint|scenic|terrazza|vista",i]${BB};
  node[natural=peak]${BB};
    `.trim());
  }

  if (cat === "hiking") {
    return Q(`
  node[information=guidepost]${BB};
  node[amenity=shelter]${BB};
  node["name"~"sentiero|trail|trek|trekking|hike|hiking|via\\s?ferrata|rifugio|anello",i]${BB};
    `.trim());
  }

  if (cat === "relax") {
    return Q(`
  node[amenity=spa]${BB};
  node[leisure=spa]${BB};
  node[natural=hot_spring]${BB};
  node[amenity=public_bath]${BB};
  node["sauna"="yes"]${BB};
  node["thermal"="yes"]${BB};
  node["name"~"terme|spa|thermal|benessere",i]${BB};

  node[leisure=swimming_pool]${BB};
  node[amenity=swimming_pool]${BB};
  node["sport"="swimming"]${BB};
    `.trim());
  }

  if (cat === "mare") {
    return Q(`
  node[natural=beach]${BB};
  way[natural=beach]${BB};
  node[leisure=marina]${BB};
  node["name"~"spiaggia|lido|baia|mare",i]${BB};
    `.trim());
  }

  if (cat === "natura") {
    return Q(`
  node[natural=waterfall]${BB};
  node[natural=peak]${BB};
  node[natural=spring]${BB};
  node[leisure=nature_reserve]${BB};
  way[leisure=nature_reserve]${BB};
  node[boundary=national_park]${BB};
  way[boundary=national_park]${BB};
  node["name"~"cascata|lago|gola|riserva|parco naturale|sentiero|eremo|forra",i]${BB};
    `.trim());
  }

  if (cat === "storia") {
    return Q(`
  node[historic=castle]${BB};
  way[historic=castle]${BB};
  node[historic=ruins]${BB};
  node[historic=archaeological_site]${BB};
  node[tourism=museum]${BB};
  way[tourism=museum]${BB};
  node[historic=monument]${BB};
  node[historic=memorial]${BB};
  node["name"~"castello|rocca|forte|abbazia|museo|anfiteatro|tempio|scavi|necropol|eremo|centro\\s?storico",i]${BB};
    `.trim());
  }

  if (cat === "borghi") {
    return Q(`
  node[place=hamlet]${BB};
  node[place=village]${BB};
  node["name"~"borgo|castel|rocca|monte|san\\s",i]${BB};
    `.trim());
  }

  if (cat === "citta") {
    return Q(`
  node[place=town]${BB};
  node[place=city]${BB};
  node["name"~"centro|piazza|duomo",i]${BB};
    `.trim());
  }

  if (cat === "montagna") {
    return Q(`
  node[natural=peak]${BB};
  node["name"~"monte|cima|passo|rifugio",i]${BB};
  node[tourism=viewpoint]${BB};
  node[amenity=shelter]${BB};
    `.trim());
  }

  if (cat === "family") {
    // Family = SOLO cose veramente family (no borghi/città)
    return Q(`
  node[tourism=theme_park]${BB};
  way[tourism=theme_park]${BB};
  node[leisure=water_park]${BB};
  way[leisure=water_park]${BB};

  node[tourism=zoo]${BB};
  way[tourism=zoo]${BB};
  node[tourism=aquarium]${BB};
  way[tourism=aquarium]${BB};
  node[amenity=aquarium]${BB};

  node[leisure=playground]${BB};
  way[leisure=playground]${BB};
  node[leisure=trampoline_park]${BB};

  node[tourism=attraction]["name"~"parco\\s?avventura|avventura|fattoria|didattica|safari|faunistico|kids|bambin|children|science\\s?center|planetari",i]${BB};

  node["name"~"parco divertimenti|parco acquatico|acquapark|aqua\\s?park|water\\s?park|luna\\s?park|zoo|acquario|parco\\s?avventura|fattoria\\s?didattica|museo\\s?dei\\s?bambini|children\\s?museum|science\\s?center|planetari",i]${BB};
    `.trim());
  }

  // default
  return Q(`node[tourism=attraction]${BB};`.trim());
}

// ---------------------------- NORMALIZE ----------------------------

function pickLatLon(el) {
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function slimTags(tags = {}) {
  const out = {};
  for (const [k, v] of Object.entries(tags)) {
    if (TAG_WHITELIST.has(k)) out[k] = v;
    // salva anche qualche "k=v" utile senza esplodere
    if (k === "tourism" || k === "leisure" || k === "amenity" || k === "historic" || k === "natural" || k === "place") {
      out[k] = v;
    }
  }
  return out;
}

function visibilityHeuristic(tags = {}, cat) {
  // euristica semplice ma utile:
  // - se ha wikipedia/wikidata => classica
  // - se è theme park / zoo / museo => classica
  // - se è natura "specifica" e non super-nota => chicca
  const hasWiki = !!(tags.wikipedia || tags.wikidata);
  const t = `${tags.tourism || ""} ${tags.leisure || ""} ${tags.amenity || ""} ${tags.historic || ""} ${tags.natural || ""}`.toLowerCase();

  if (hasWiki) return "classica";
  if (t.includes("theme_park") || t.includes("water_park") || t.includes("zoo") || t.includes("aquarium") || t.includes("museum")) return "classica";
  if (cat === "natura" && (t.includes("waterfall") || t.includes("spring") || t.includes("nature_reserve") || t.includes("national_park"))) return "chicca";
  if (cat === "viewpoints") return "chicca";
  return "classica";
}

function elementToPoi(el, cat) {
  const tags = el.tags || {};
  const name = safePickName(tags);
  if (!name || String(name).trim().length < 2) return null;

  const ll = pickLatLon(el);
  if (!ll) return null;

  const id = `${el.type}_${el.id}`;
  const sTags = slimTags(tags);

  return {
    id,
    name: String(name).trim(),
    lat: ll.lat,
    lon: ll.lon,
    category: cat,
    visibility: visibilityHeuristic(sTags, cat),
    tags: sTags,
    // room per future: beauty_score ecc.
    beauty_score: 0.72
  };
}

function dedupPois(pois) {
  const seen = new Set();
  const out = [];
  for (const p of pois) {
    const k = `${normName(p.name)}_${String(p.lat).slice(0, 6)}_${String(p.lon).slice(0, 6)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

// ---------------------------- OVERPASS RUNNER (with split) ----------------------------

async function runOverpassOnce(query) {
  let lastErr = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= ENDPOINT_RETRY + 1; attempt++) {
      try {
        const j = await fetchWithTimeout(
          endpoint,
          { method: "POST", body: overpassBody(query) },
          FETCH_TIMEOUT_MS
        );
        return { ok: true, endpoint, json: j };
      } catch (e) {
        lastErr = e;
        if (isAbortLike(e)) {
          // abort = timeout: meglio provare next attempt/endpoint
        }
        const wait = GLOBAL_RETRY_DELAY_MS * attempt;
        await sleep(wait);
      }
    }
  }

  return { ok: false, endpoint: "", json: null, error: String(lastErr?.message || lastErr) };
}

function elementsFromJson(j) {
  return Array.isArray(j?.elements) ? j.elements : [];
}

async function runOverpassWithSplit(cat, bbox, depth = 0) {
  const { latSpan, lonSpan } = bboxSpanDeg(bbox);

  const query = buildCategoryQuery(cat, bbox);
  const r = await runOverpassOnce(query);

  if (r.ok) {
    const els = elementsFromJson(r.json);
    return { ok: true, endpoint: r.endpoint, elements: els, notes: depth ? [`split_depth_${depth}`] : [] };
  }

  // se fallisce e possiamo splittare, splitta
  const canSplit =
    depth < MAX_SPLIT_DEPTH &&
    latSpan > MIN_TILE_SPAN_DEG &&
    lonSpan > MIN_TILE_SPAN_DEG;

  if (!canSplit) {
    return { ok: false, endpoint: "", elements: [], notes: [`fail:${r.error || "unknown"}`] };
  }

  const parts = splitBbox(bbox);
  const merged = [];
  const notes = [`split_${depth}_to_${depth + 1}`];

  // esegui i tile in serie (meno stress su Overpass)
  for (const part of parts) {
    const rr = await runOverpassWithSplit(cat, part, depth + 1);
    notes.push(...(rr.notes || []));
    if (rr.elements?.length) merged.push(...rr.elements);
    // micro-delay
    await sleep(350);
  }

  return { ok: merged.length > 0, endpoint: "split", elements: merged, notes };
}

// ---------------------------- MAIN ----------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const regionId = String(args.region || "").trim();

  if (!regionId) {
    console.error("❌ Missing --region argument (example: --region=it-abruzzo)");
    process.exit(1);
  }

  const regionPath = path.join(REPO_ROOT, "public", "data", "regions", `${regionId}.json`);
  if (!fs.existsSync(regionPath)) {
    console.error(`❌ Region file not found: ${regionPath}`);
    process.exit(1);
  }

  const regionJson = readJson(regionPath);
  const bbox = regionJson?.bbox;

  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((x) => !Number.isFinite(Number(x)))) {
    console.error("❌ Region JSON must contain bbox: [minLon, minLat, maxLon, maxLat]");
    console.error('   Example: { "bbox": [13.0, 41.9, 14.9, 42.9] }');
    process.exit(1);
  }

  const box = bboxToOverpassBox(bbox);

  const outDir = path.join(REPO_ROOT, "public", "data", "pois", "it", regionId);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`📦 Build POIs for region: ${regionId}`);
  console.log(`🧭 bbox (south,west,north,east): ${boxStr(box)}`);
  console.log("");

  const index = {
    region: regionId,
    generatedAt: new Date().toISOString(),
    bbox: bbox,
    categories: {},
    notes: [],
  };

  for (const cat of CATEGORIES) {
    console.log(`🧩 Fetch category: ${cat}`);

    const t0 = Date.now();
    const r = await runOverpassWithSplit(cat, box, 0);

    const els = r.elements || [];
    const poisRaw = els.map((el) => elementToPoi(el, cat)).filter(Boolean);
    const pois = dedupPois(poisRaw);

    // Post-filter per evitare roba “fuori categoria” su place
    const filtered = (() => {
      if (cat === "borghi") {
        return pois.filter(p => {
          const place = String(p.tags?.place || "").toLowerCase();
          return place === "village" || place === "hamlet" || normName(p.name).includes("borgo");
        });
      }
      if (cat === "citta") {
        return pois.filter(p => {
          const place = String(p.tags?.place || "").toLowerCase();
          return place === "town" || place === "city";
        });
      }
      return pois;
    })();

    // Salva
    const file = path.join(outDir, `${cat}.json`);
    writeJson(file, {
      ok: true,
      region: regionId,
      category: cat,
      generatedAt: new Date().toISOString(),
      bbox,
      count: filtered.length,
      endpoint: r.endpoint || "",
      notes: r.notes || [],
      pois: filtered,
    });

    const ms = Date.now() - t0;
    index.categories[cat] = {
      count: filtered.length,
      file: `/${path.relative(path.join(REPO_ROOT, "public"), file).replace(/\\/g, "/")}`,
      endpoint: r.endpoint || "",
      elapsedMs: ms,
      notes: r.notes || [],
    };

    console.log(`   ${filtered.length} items • ${Math.round(ms / 1000)}s • endpoint: ${r.endpoint || "-"}`);

    // micro-delay per non martellare Overpass
    await sleep(650);
  }

  // index.json
  const indexFile = path.join(outDir, "index.json");
  writeJson(indexFile, index);

  console.log("");
  console.log("✅ Done.");
  console.log(`🗂️  Index: ${indexFile}`);
}

main().catch((e) => {
  console.error("❌ Fatal:", e);
  process.exit(1);
});
