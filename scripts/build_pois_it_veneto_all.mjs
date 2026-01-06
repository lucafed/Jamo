// scripts/build_pois_it_veneto_all.mjs
// Build OFFLINE POIs for Veneto (IT) — ALL categories in ONE file (CLEAN + RICH + COHERENT)
// Output: public/data/pois/regions/it-veneto.json
//
// ✅ Natura RIPRISTINATA: laghi, cascate, fiumi, grotte, gole, riserve, parchi
// ✅ Montagna ripulita: cime, passi, rifugi, impianti, winter sports
// ✅ Family ricca ma coerente (NO spa/terme)
// ✅ Anti-spazzatura (hotel/ristoranti/negozi/uffici)
// ✅ No regex su name per indovinare categorie (anti "Hotel Belvedere")
// ✅ Dedup include type (non schiaccia categorie)

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
        "User-Agent": "Jamo/1.0 (Veneto POIs build)",
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
// CATEGORIE (PULITE + RICCHE) — SOLO TAG COERENTI
// ------------------------------------------------------------
const CATEGORIES = {
  // FAMILY: attività family reali (NO spa/terme)
  family: `
  (
    // parchi / acqua / zoo / acquari
    nwr["tourism"="theme_park"](area.VENETO);
    nwr["leisure"="water_park"](area.VENETO);
    nwr["tourism"="zoo"](area.VENETO);
    nwr["tourism"="aquarium"](area.VENETO);
    nwr["amenity"="aquarium"](area.VENETO);

    // musei/science center “taggati” (no name-guessing)
    nwr["tourism"="museum"]["museum"="children"](area.VENETO);
    nwr["tourism"="museum"]["museum"="science"](area.VENETO);
    nwr["tourism"="museum"]["museum"="interactive"](area.VENETO);

    // playground: solo con name per evitare spam
    nwr["leisure"="playground"]["name"](area.VENETO);

    // parchi avventura / rope course
    nwr["leisure"="high_ropes_course"](area.VENETO);
    nwr["leisure"="rope_course"](area.VENETO);

    // family indoor “reali”
    nwr["leisure"="miniature_golf"](area.VENETO);
    nwr["leisure"="trampoline_park"](area.VENETO);
    nwr["leisure"="ice_rink"](area.VENETO);
    nwr["leisure"="bowling_alley"](area.VENETO);
    nwr["amenity"="cinema"](area.VENETO);

    // attrazioni educational (tag)
    nwr["tourism"="attraction"]["attraction"="animal"](area.VENETO);
    nwr["tourism"="attraction"]["attraction"="farm"](area.VENETO);
  );
  `,

  // PARCHI (subset “forte”)
  theme_park: `
  (
    nwr["tourism"="theme_park"](area.VENETO);
    nwr["leisure"="water_park"](area.VENETO);
    nwr["tourism"="zoo"](area.VENETO);
    nwr["tourism"="aquarium"](area.VENETO);
    nwr["amenity"="aquarium"](area.VENETO);
  );
  `,

  // PANORAMI: solo viewpoint veri + torri/osservatori
  viewpoints: `
  (
    nwr["tourism"="viewpoint"](area.VENETO);
    nwr["man_made"="observation_tower"](area.VENETO);
    nwr["man_made"="tower"]["tower:type"="observation"](area.VENETO);
  );
  `,

  // TREKKING: cose “da trekking” vere (no regex su nomi)
  hiking: `
  (
    nwr["information"="guidepost"](area.VENETO);
    nwr["amenity"="shelter"](area.VENETO);
    nwr["tourism"="alpine_hut"](area.VENETO);
  );
  `,

  // NATURA: laghi/cascate/fiumi/sorgenti/grotte/gole/riserve/parchi
  natura: `
  (
    // 💧 Cascate / sorgenti / grotte / gole
    nwr["natural"="waterfall"](area.VENETO);
    nwr["natural"="spring"](area.VENETO);
    nwr["natural"="cave_entrance"](area.VENETO);
    nwr["natural"="gorge"](area.VENETO);

    // 🏞️ Laghi e acque: OSM spesso usa natural=water + water=lake
    nwr["natural"="water"]["water"="lake"](area.VENETO);
    nwr["natural"="water"]["water"="reservoir"](area.VENETO);
    nwr["natural"="water"]["water"="pond"](area.VENETO);
    nwr["natural"="water"]["water"="lagoon"](area.VENETO);

    // 🌊 Fiumi/zone fluviali (manteniamo “pulito”: river + riverbank)
    nwr["waterway"="river"](area.VENETO);
    nwr["waterway"="riverbank"](area.VENETO);

    // 🌿 Parchi/riserve
    nwr["leisure"="nature_reserve"](area.VENETO);
    nwr["boundary"="national_park"](area.VENETO);
    nwr["boundary"="protected_area"](area.VENETO);
  );
  `,

  // MONTAGNA: esperienza montagna (cime/passi/rifugi/impianti/winter sports)
  montagna: `
  (
    // 🏔️ Cime e passi
    nwr["natural"="peak"](area.VENETO);
    nwr["natural"="saddle"](area.VENETO);

    // 🏕️ Rifugi / bivacchi
    nwr["tourism"="alpine_hut"](area.VENETO);
    nwr["amenity"="shelter"](area.VENETO);

    // 🚠 Impianti
    nwr["aerialway"](area.VENETO);

    // 🎿 Winter sports (stagionale): piste / sport invernali
    nwr["piste:type"](area.VENETO);
    nwr["leisure"="sports_centre"]["sport"="skiing"](area.VENETO);
  );
  `,

  // MARE: spiagge / marine / costa
  mare: `
  (
    nwr["natural"="beach"](area.VENETO);
    nwr["leisure"="marina"](area.VENETO);
    nwr["natural"="coastline"](area.VENETO);
  );
  `,

  // STORIA: più ricca ma vera
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

    nwr["tourism"="museum"](area.VENETO);
    nwr["tourism"="attraction"]["historic"~"."](area.VENETO);
  );
  `,

  // RELAX: solo relax vero (ricco)
  relax: `
  (
    nwr["amenity"="spa"](area.VENETO);
    nwr["leisure"="spa"](area.VENETO);
    nwr["tourism"="spa"](area.VENETO);

    nwr["natural"="hot_spring"](area.VENETO);
    nwr["amenity"="public_bath"](area.VENETO);

    nwr["leisure"="swimming_pool"](area.VENETO);
    nwr["amenity"="sauna"](area.VENETO);
    nwr["leisure"="sauna"](area.VENETO);
  );
  `,

  // BORGHI
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
// FILTRI ANTI-SPAZZATURA
// ------------------------------------------------------------
function isBadGeneric(tags = {}) {
  // hospitality / accomodation
  if (tags.tourism && [
    "hotel","motel","hostel","guest_house","apartment","chalet",
    "camp_site","caravan_site"
  ].includes(tags.tourism)) return true;

  // food & drink
  if (tags.amenity && [
    "restaurant","cafe","bar","fast_food","pub","ice_cream","food_court"
  ].includes(tags.amenity)) return true;

  // shopping / office
  if (tags.shop) return true;
  if (tags.office) return true;

  return false;
}

function allowAlpineHut(catKey) {
  return (catKey === "hiking" || catKey === "montagna");
}

function shouldDrop(el, catKey) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";

  // vogliamo un nome vero (anti spam)
  if (!name || String(name).trim().length < 2) return true;

  // scarta commerciali (eccetto alpine_hut per hiking/montagna)
  if (isBadGeneric(tags)) return true;

  if (tags.tourism === "alpine_hut" && !allowAlpineHut(catKey)) return true;

  // place=... solo in borghi/citta
  if (tags.place && !(catKey === "borghi" || catKey === "citta")) return true;

  // family: escludi sempre spa/terme
  if (catKey === "family") {
    if (
      tags.amenity === "spa" ||
      tags.leisure === "spa" ||
      tags.amenity === "public_bath" ||
      tags.natural === "hot_spring"
    ) return true;
  }

  return false;
}

function tagListCompact(tags) {
  const out = [];
  const pushKV = (k) => { if (tags?.[k] != null) out.push(`${k}=${tags[k]}`); };

  [
    "tourism","leisure","historic","natural","amenity","information","place",
    "boundary","waterway","man_made","attraction","museum","tower:type",
    "water","aerialway","piste:type","sport"
  ].forEach(pushKV);

  return Array.from(new Set(out)).slice(0, 30);
}

function visibilityHeuristic(catKey, tags = {}) {
  if (catKey === "borghi") return (tags.place === "hamlet") ? "chicca" : "classica";
  if (catKey === "viewpoints") return "chicca";
  if (catKey === "natura") return "chicca";
  if (catKey === "montagna") return "chicca";
  return "classica";
}

function beautyScoreHeuristic(catKey, tags = {}) {
  let s = 0.72;

  // family wow
  if (tags.tourism === "theme_park") s += 0.10;
  if (tags.leisure === "water_park") s += 0.10;
  if (tags.tourism === "zoo" || tags.tourism === "aquarium" || tags.amenity === "aquarium") s += 0.08;

  // viewpoints / natura wow
  if (tags.tourism === "viewpoint" || tags.man_made === "observation_tower") s += 0.08;
  if (tags.natural === "waterfall") s += 0.09;
  if (tags.natural === "gorge") s += 0.07;
  if (tags.natural === "water" && (tags.water === "lake" || tags.water === "lagoon")) s += 0.08;

  // montagna
  if (tags.natural === "peak" || tags.natural === "saddle") s += 0.06;
  if (tags.aerialway) s += 0.04;
  if (tags["piste:type"]) s += 0.05; // inverno

  // storia
  if (tags.historic === "castle" || tags.historic === "fort") s += 0.08;
  if (tags.tourism === "museum") s += 0.04;

  // relax
  if (catKey === "relax" && (tags.amenity === "spa" || tags.leisure === "spa" || tags.natural === "hot_spring")) s += 0.08;

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

// Dedup “safe”: include type, così non perdi categorie
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
