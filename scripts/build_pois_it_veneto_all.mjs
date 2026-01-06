// scripts/build_pois_it_veneto_all.mjs
// Build OFFLINE POIs for Veneto (IT) — ALL categories in ONE file (CLEAN + RICH)
// Output: public/data/pois/regions/it-veneto.json
//
// ✅ Categorie "reali": no regex per nome (anti hotel/ristoranti “Belvedere” ecc.)
// ✅ kids_museum -> dentro FAMILY
// ✅ natura -> dentro MONTAGNA
// ✅ relax + storia + family molto più ricche (ma coerenti)
// ✅ Dedup NON schiaccia le categorie (chiave include type)

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "public/data/pois/regions");
const OUT_FILE = path.join(OUT_DIR, "it-veneto.json");

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function nowIso(){ return new Date().toISOString(); }
function ensureDir(p){ if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

async function fetchWithTimeout(url, body, timeoutMs = 65000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": "Jamo/1.0 (GitHub Actions; Veneto POIs build)",
      },
      body,
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json().catch(() => null);
    if (!j) throw new Error("Bad JSON");
    return j;
  } finally {
    clearTimeout(t);
  }
}

function opBody(q){ return `data=${encodeURIComponent(q)}`; }

async function runOverpass(query) {
  const body = opBody(query);
  let lastErr = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const j = await fetchWithTimeout(endpoint, body, 65000);
        return { ok: true, endpoint, json: j };
      } catch (e) {
        lastErr = e;
        await sleep(900 * attempt);
      }
    }
  }
  return { ok: false, endpoint: "", json: null, error: String(lastErr?.message || lastErr) };
}

// ---- Veneto area (admin_level=4, name=Veneto) ----
function venetoAreaBlock() {
  return `
  area["boundary"="administrative"]["admin_level"="4"]["name"="Veneto"]->.VENETO;
  `.trim();
}

// ------------------------------------------------------------
// CATEGORIE (PULITE + RICCHE)
// - Niente regex per name per “indovinare” categorie
// - Solo tag OSM coerenti
// ------------------------------------------------------------
const CATEGORIES = {
  // FAMILY = cose realmente family (NO terme/spa qui)
  family: `
  (
    // 🎢 Parchi divertimento / acquapark
    nwr["tourism"="theme_park"](area.VENETO);
    nwr["leisure"="water_park"](area.VENETO);

    // 🦁 Zoo / acquari veri
    nwr["tourism"="zoo"](area.VENETO);
    nwr["tourism"="aquarium"](area.VENETO);
    nwr["amenity"="aquarium"](area.VENETO);

    // 🧒 Musei per bambini (tag, NON nome)
    nwr["tourism"="museum"]["museum"="children"](area.VENETO);
    nwr["tourism"="museum"]["museum"="science"](area.VENETO);
    nwr["tourism"="museum"]["museum"="interactive"](area.VENETO);

    // 🛝 Playground (solo con nome per evitare spam)
    nwr["leisure"="playground"]["name"](area.VENETO);

    // 🌲 Parchi avventura / percorsi acrobatici (tag)
    nwr["leisure"="high_ropes_course"](area.VENETO);
    nwr["leisure"="rope_course"](area.VENETO);

    // 🎳 / 🕹️ attività family indoor “reali”
    nwr["leisure"="miniature_golf"](area.VENETO);
    nwr["leisure"="trampoline_park"](area.VENETO);
    nwr["leisure"="ice_rink"](area.VENETO);
    nwr["leisure"="bowling_alley"](area.VENETO);
    nwr["amenity"="cinema"](area.VENETO);

    // 🐴 fattorie/educational (tag)
    nwr["tourism"="attraction"]["attraction"="animal"](area.VENETO);
    nwr["tourism"="attraction"]["attraction"="farm"](area.VENETO);
  );
  `,

  // PARCHI (subset forte)
  theme_park: `
  (
    nwr["tourism"="theme_park"](area.VENETO);
    nwr["leisure"="water_park"](area.VENETO);
    nwr["tourism"="zoo"](area.VENETO);
    nwr["tourism"="aquarium"](area.VENETO);
    nwr["amenity"="aquarium"](area.VENETO);
  );
  `,

  // PANORAMI (solo viewpoint veri + torri/osservatori)
  viewpoints: `
  (
    nwr["tourism"="viewpoint"](area.VENETO);
    nwr["man_made"="observation_tower"](area.VENETO);
    nwr["man_made"="tower"]["tower:type"="observation"](area.VENETO);
  );
  `,

  // TREKKING (solo oggetti “da trekking” veri, niente “nomi”)
  hiking: `
  (
    nwr["information"="guidepost"](area.VENETO);
    nwr["amenity"="shelter"](area.VENETO);
    nwr["tourism"="alpine_hut"](area.VENETO);
  );
  `,

  // MONTAGNA (include anche la vecchia “natura” qui dentro)
  montagna: `
  (
    // cime / passi / gole / grotte / cascate / laghi / riserve
    nwr["natural"="peak"](area.VENETO);
    nwr["natural"="saddle"](area.VENETO);
    nwr["natural"="waterfall"](area.VENETO);
    nwr["natural"="spring"](area.VENETO);
    nwr["natural"="cave_entrance"](area.VENETO);

    nwr["natural"="wood"](area.VENETO);
    nwr["leisure"="nature_reserve"](area.VENETO);
    nwr["boundary"="national_park"](area.VENETO);

    // acqua “naturale” sensata
    nwr["waterway"="riverbank"](area.VENETO);
    nwr["natural"="water"](area.VENETO);

    // rifugi già in hiking, ma ok duplicare (dedup include type)
    nwr["tourism"="alpine_hut"](area.VENETO);
  );
  `,

  // MARE (spiagge / marine / costa)
  mare: `
  (
    nwr["natural"="beach"](area.VENETO);
    nwr["leisure"="marina"](area.VENETO);
    nwr["natural"="coastline"](area.VENETO);
  );
  `,

  // STORIA (molto più ricca ma “vera”)
  storia: `
  (
    nwr["historic"="castle"](area.VENETO);
    nwr["historic"="fort"](area.VENETO);
    nwr["historic"="citywalls"](area.VENETO);
    nwr["historic"="tower"](area.VENETO);
    nwr["historic"="ruins"](area.VENETO);
    nwr["historic"="archaeological_site"](area.VENETO);
    nwr["historic"="monument"](area.VENETO);
    nwr["historic"="memorial"](area.VENETO);

    // musei e attrazioni culturali vere
    nwr["tourism"="museum"](area.VENETO);
    nwr["tourism"="attraction"]["historic"~"."](area.VENETO);
  );
  `,

  // RELAX (ricchissima ma solo relax vero)
  relax: `
  (
    nwr["amenity"="spa"](area.VENETO);
    nwr["leisure"="spa"](area.VENETO);
    nwr["natural"="hot_spring"](area.VENETO);
    nwr["amenity"="public_bath"](area.VENETO);

    // piscine / terme / centri benessere (tag)
    nwr["leisure"="swimming_pool"](area.VENETO);
    nwr["amenity"="sauna"](area.VENETO);
    nwr["leisure"="sauna"](area.VENETO);

    // in OSM esiste anche tourism=spa in alcuni casi
    nwr["tourism"="spa"](area.VENETO);
  );
  `,

  // BORGHI (place piccoli)
  borghi: `
  (
    nwr["place"="village"](area.VENETO);
    nwr["place"="hamlet"](area.VENETO);
  );
  `,

  // CITTA
  citta: `
  (
    nwr["place"="city"](area.VENETO);
    nwr["place"="town"](area.VENETO);
  );
  `,
};

const CATEGORY_KEYS = Object.keys(CATEGORIES);

function buildQuery(catKey) {
  return `
[out:json][timeout:180];
${venetoAreaBlock()}
${CATEGORIES[catKey]}
out tags center;
`.trim();
}

// ------------------------------------------------------------
// FILTRI ANTI-SPAZZATURA (hotel/ristoranti/negozi/robe non inerenti)
// ------------------------------------------------------------
function normStr(x){ return String(x || "").toLowerCase().trim(); }

function isBadGeneric(tags = {}) {
  const t = tags;

  // hospitality / accomodation
  if (t.tourism && [
    "hotel","motel","hostel","guest_house","apartment","chalet",
    "camp_site","caravan_site","alpine_hut" // NB: alpine_hut lo vogliamo per hiking/montagna -> gestito dopo
  ].includes(t.tourism)) return true;

  // food & drink
  if (t.amenity && [
    "restaurant","cafe","bar","fast_food","pub","ice_cream","food_court"
  ].includes(t.amenity)) return true;

  // shopping
  if (t.shop) return true;

  // uffici/aziende
  if (t.office) return true;

  return false;
}

function allowTourismAlpineHutFor(catKey) {
  return (catKey === "hiking" || catKey === "montagna");
}

function shouldDrop(el, catKey) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";

  // deve avere un nome “vero”
  if (!name || String(name).trim().length < 2) return true;

  // scarta POI chiaramente commerciali / non coerenti
  // eccezione: alpine_hut lo teniamo per hiking/montagna
  if (isBadGeneric(tags)) {
    if (tags.tourism === "alpine_hut" && allowTourismAlpineHutFor(catKey)) {
      // ok
    } else {
      return true;
    }
  }

  // scarta “place=city/town/village/hamlet” fuori dalle categorie place
  if (tags.place && !(catKey === "borghi" || catKey === "citta")) return true;

  // family: escludi sempre spa/terme
  if (catKey === "family") {
    const n = normStr(name);
    if (
      tags.amenity === "spa" ||
      tags.leisure === "spa" ||
      tags.amenity === "public_bath" ||
      tags.natural === "hot_spring" ||
      n.includes("terme") || n.includes("spa") || n.includes("thermal") || n.includes("benessere")
    ) return true;
  }

  return false;
}

// ------------------------------------------------------------
// Map OSM element -> "place" (compat app.js)
// ------------------------------------------------------------
function tagListCompact(tags) {
  const out = [];
  const pushKV = (k) => { if (tags?.[k] != null) out.push(`${k}=${tags[k]}`); };

  [
    "tourism","leisure","historic","natural","amenity","information","place",
    "boundary","waterway","man_made","attraction","museum","tower:type"
  ].forEach(pushKV);

  return Array.from(new Set(out)).slice(0, 26);
}

function visibilityHeuristic(catKey, tags = {}) {
  // semplice, ma utile:
  if (catKey === "borghi") return (tags.place === "hamlet") ? "chicca" : "classica";
  if (catKey === "viewpoints") return "chicca";
  if (catKey === "montagna") return "chicca";
  return "classica";
}

function beautyScoreHeuristic(catKey, tags = {}) {
  // base
  let s = 0.72;

  // boost "wow"
  if (tags.tourism === "theme_park") s += 0.10;
  if (tags.leisure === "water_park") s += 0.10;
  if (tags.tourism === "zoo" || tags.tourism === "aquarium" || tags.amenity === "aquarium") s += 0.08;

  if (tags.tourism === "viewpoint" || tags.man_made === "observation_tower") s += 0.08;
  if (tags.natural === "waterfall") s += 0.08;
  if (tags.natural === "peak" || tags.natural === "saddle") s += 0.06;

  if (tags.historic === "castle" || tags.historic === "fort") s += 0.08;
  if (tags.tourism === "museum") s += 0.04;

  if (catKey === "relax" && (tags.amenity === "spa" || tags.leisure === "spa" || tags.natural === "hot_spring")) s += 0.08;

  // clamp
  s = Math.max(0.55, Math.min(0.92, s));
  return Number(s.toFixed(3));
}

function mapElementToPlace(el, catKey) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  if (shouldDrop(el, catKey)) return null;

  return {
    id: `poi_it-veneto_${catKey}_${el.type}_${el.id}`,
    name: String(name).trim(),
    lat, lon,
    type: catKey,
    primary_category: catKey,
    visibility: visibilityHeuristic(catKey, tags),
    beauty_score: beautyScoreHeuristic(catKey, tags),
    tags: tagListCompact(tags),
    live: false,
    source: "overpass_veneto_build",
  };
}

// ✅ Dedup “safe”: include anche type, così non perdi categorie
function dedupPlaces(places) {
  const seen = new Set();
  const out = [];
  for (const p of places) {
    const k = `${p.type}__${p.name.toLowerCase()}__${p.lat.toFixed(5)}__${p.lon.toFixed(5)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

async function main() {
  ensureDir(OUT_DIR);

  const meta = {
    built_at: nowIso(),
    region_id: "it-veneto",
    label: "Veneto",
    categories: CATEGORY_KEYS,
    notes: [],
  };

  const allByCat = {};
  const all = [];

  for (const catKey of CATEGORY_KEYS) {
    console.log(`🛰️ Veneto category: ${catKey}`);
    const q = buildQuery(catKey);
    const r = await runOverpass(q);

    if (!r.ok || !r.json) {
      console.log(`❌ ${catKey} failed: ${r.error || "unknown"}`);
      meta.notes.push(`fail_${catKey}`);
      allByCat[catKey] = [];
      continue;
    }

    const els = Array.isArray(r.json.elements) ? r.json.elements : [];
    const mapped = dedupPlaces(els.map(el => mapElementToPlace(el, catKey)).filter(Boolean));

    console.log(`✅ ${catKey}: ${mapped.length} items (endpoint: ${r.endpoint})`);
    allByCat[catKey] = mapped;
    all.push(...mapped);
  }

  const allDedup = dedupPlaces(all);

  const out = {
    meta,
    counts: Object.fromEntries(Object.entries(allByCat).map(([k,v]) => [k, v.length])),
    total: allDedup.length,
    places: allDedup,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(out), "utf8");
  console.log(`🎉 DONE Veneto: total unique POIs = ${allDedup.length}`);
}

main().catch((e) => {
  console.error("❌ build failed:", e);
  process.exit(1);
});
