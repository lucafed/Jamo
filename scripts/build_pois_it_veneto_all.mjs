// scripts/build_pois_it_veneto_all.mjs
// Build OFFLINE POIs for Veneto (IT) — ALL categories in ONE file (TOURISTIC + CLEAN + RICH)
// Output: public/data/pois/regions/it-veneto.json
//
// ✅ Natura REINTRODOTTA: laghi/cascate/fiumi/gole/sorgenti/riserve
// ✅ Family pulita: NO playground piccoli/spam
// ✅ Storia turistica: preferisce wikipedia/wikidata/heritage/attraction, taglia minori
// ✅ Chicche vs Classici: euristiche robuste (non “a caso”)
// ✅ Anti-sporco: hotel/ristoranti/negozi/uffici esclusi
// ✅ Dedup non schiaccia categorie (include type)

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
// CATEGORIE (TOURISTIC + RICCHE, ma coerenti)
// ------------------------------------------------------------
const CATEGORIES = {
  // FAMILY (turistico): grandi attrazioni, NO playground piccoli
  family: `
  (
    nwr["tourism"="theme_park"](area.VENETO);
    nwr["leisure"="water_park"](area.VENETO);

    nwr["tourism"="zoo"](area.VENETO);
    nwr["tourism"="aquarium"](area.VENETO);
    nwr["amenity"="aquarium"](area.VENETO);

    // adventure / rope
    nwr["leisure"="high_ropes_course"](area.VENETO);
    nwr["leisure"="rope_course"](area.VENETO);

    // indoor family monetizzabile spesso
    nwr["leisure"="trampoline_park"](area.VENETO);
    nwr["leisure"="bowling_alley"](area.VENETO);
    nwr["leisure"="ice_rink"](area.VENETO);
    nwr["leisure"="miniature_golf"](area.VENETO);
    nwr["amenity"="cinema"](area.VENETO);

    // attrazioni "animal/farm" (se taggate)
    nwr["tourism"="attraction"]["attraction"="animal"](area.VENETO);
    nwr["tourism"="attraction"]["attraction"="farm"](area.VENETO);

    // kids museum SOLO se veramente taggati (pochi ma ok)
    nwr["tourism"="museum"]["museum"="children"](area.VENETO);
    nwr["tourism"="museum"]["museum"="science"](area.VENETO);
    nwr["tourism"="museum"]["museum"="interactive"](area.VENETO);
  );
  `,

  // PANORAMI: solo viewpoint veri + observation tower
  viewpoints: `
  (
    nwr["tourism"="viewpoint"](area.VENETO);
    nwr["man_made"="observation_tower"](area.VENETO);
    nwr["man_made"="tower"]["tower:type"="observation"](area.VENETO);
  );
  `,

  // TREKKING: guidepost/shelter/alpine_hut
  hiking: `
  (
    nwr["information"="guidepost"](area.VENETO);
    nwr["amenity"="shelter"](area.VENETO);
    nwr["tourism"="alpine_hut"](area.VENETO);
  );
  `,

  // NATURA: laghi/cascate/fiumi/gole/sorgenti/riserve
  natura: `
  (
    nwr["natural"="water"](area.VENETO);           // laghi / bacini
    nwr["water"="lake"](area.VENETO);
    nwr["water"="reservoir"](area.VENETO);

    nwr["natural"="waterfall"](area.VENETO);
    nwr["natural"="spring"](area.VENETO);
    nwr["natural"="gorge"](area.VENETO);
    nwr["natural"="cave_entrance"](area.VENETO);

    nwr["waterway"="riverbank"](area.VENETO);
    nwr["waterway"="river"](area.VENETO);

    nwr["leisure"="nature_reserve"](area.VENETO);
    nwr["boundary"="national_park"](area.VENETO);
  );
  `,

  // MONTAGNA (cime, passi, rifugi, impianti)
  montagna: `
  (
    nwr["natural"="peak"](area.VENETO);
    nwr["natural"="saddle"](area.VENETO);
    nwr["natural"="ridge"](area.VENETO);

    nwr["tourism"="alpine_hut"](area.VENETO);
    nwr["amenity"="shelter"](area.VENETO);

    nwr["aerialway"](area.VENETO);
    nwr["piste:type"](area.VENETO);
  );
  `,

  // MARE
  mare: `
  (
    nwr["natural"="beach"](area.VENETO);
    nwr["leisure"="marina"](area.VENETO);
    nwr["natural"="coastline"](area.VENETO);
  );
  `,

  // STORIA (turistica)
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

    // attrazione storica taggata
    nwr["tourism"="attraction"]["historic"](area.VENETO);
  );
  `,

  // RELAX (ricchissima)
  relax: `
  (
    nwr["amenity"="spa"](area.VENETO);
    nwr["leisure"="spa"](area.VENETO);
    nwr["tourism"="spa"](area.VENETO);
    nwr["natural"="hot_spring"](area.VENETO);
    nwr["amenity"="public_bath"](area.VENETO);

    nwr["amenity"="sauna"](area.VENETO);
    nwr["leisure"="sauna"](area.VENETO);

    nwr["leisure"="swimming_pool"](area.VENETO);
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
// FILTRI ANTI-SPAZZATURA + “TURISTICO”
// ------------------------------------------------------------
function normStr(x){ return String(x || "").toLowerCase().trim(); }

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

function isTouristicSignal(tags = {}) {
  // segnali forti di “posto turistico”
  if (tags.wikipedia || tags.wikidata) return true;
  if (tags.heritage) return true;
  if (tags.tourism && ["museum","theme_park","zoo","aquarium","viewpoint","spa","attraction"].includes(tags.tourism)) return true;
  if (tags.historic && ["castle","fort","citywalls","tower","ruins","archaeological_site","monument"].includes(tags.historic)) return true;
  if (tags.natural && ["waterfall","peak","gorge","cave_entrance","spring","water"].includes(tags.natural)) return true;
  if (tags.leisure && ["water_park","spa","nature_reserve"].includes(tags.leisure)) return true;
  if (tags.place && ["city","town","village","hamlet"].includes(tags.place)) return true;
  return false;
}

function allowSmallNature(tags = {}) {
  // per natura possiamo accettare anche senza wiki se è “oggetto naturale” vero
  if (tags.natural && ["waterfall","gorge","spring","cave_entrance"].includes(tags.natural)) return true;
  if (tags.water && ["lake","reservoir"].includes(tags.water)) return true;
  if (tags.natural === "water") return true;
  return false;
}

function shouldDrop(el, catKey) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";

  if (!name || String(name).trim().length < 2) return true;
  if (isBadGeneric(tags)) return true;

  // place=* solo in borghi/citta
  if (tags.place && !(catKey === "borghi" || catKey === "citta")) return true;

  // family: NO spa/terme
  if (catKey === "family") {
    const n = normStr(name);
    if (
      tags.amenity === "spa" || tags.leisure === "spa" || tags.tourism === "spa" ||
      tags.amenity === "public_bath" || tags.natural === "hot_spring" ||
      n.includes("terme") || n.includes("spa") || n.includes("thermal") || n.includes("benessere")
    ) return true;
  }

  // viewpoints: escludi tower generiche non observation
  if (catKey === "viewpoints") {
    if (tags.man_made === "tower" && tags["tower:type"] && tags["tower:type"] !== "observation") return true;
  }

  // hiking: riduci spam -> guidepost deve avere name sensato o ref CAI
  if (catKey === "hiking") {
    if (tags.information === "guidepost") {
      const n = String(name).trim();
      if (n.length < 6 && !tags.ref) return true;
    }
  }

  // “turistico” per storia: se è monumentino senza segnali forti, scarta
  if (catKey === "storia") {
    const strong = !!(tags.wikipedia || tags.wikidata || tags.heritage || tags.tourism === "museum" || tags.tourism === "attraction");
    const okHistoric = !!tags.historic;
    if (!strong && okHistoric && !["castle","fort","citywalls","tower","archaeological_site"].includes(tags.historic)) {
      return true; // taglia minori
    }
  }

  // “turistico” generale: per tutte tranne natura, richiedi almeno un segnale
  if (catKey !== "natura") {
    if (!isTouristicSignal(tags)) return true;
  } else {
    // natura: accetta anche oggetti naturali veri senza wiki
    if (!isTouristicSignal(tags) && !allowSmallNature(tags)) return true;
  }

  // family: NO playground (spam)
  if (catKey === "family") {
    if (tags.leisure === "playground") return true;
  }

  return false;
}

// ------------------------------------------------------------
// Map OSM -> place (compat app.js)
// ------------------------------------------------------------
function tagListCompact(tags) {
  const out = [];
  const pushKV = (k) => { if (tags?.[k] != null) out.push(`${k}=${tags[k]}`); };

  [
    "tourism","leisure","historic","natural","amenity","information","place",
    "boundary","waterway","man_made","attraction","museum","tower:type",
    "wikipedia","wikidata","heritage","water","aerialway","piste:type"
  ].forEach(pushKV);

  return Array.from(new Set(out)).slice(0, 30);
}

function visibilityHeuristic(catKey, tags = {}) {
  // Classico se ha segnali forti (wiki/wikidata/heritage)
  const strong = !!(tags.wikipedia || tags.wikidata || tags.heritage);
  if (strong) return "classica";

  // Natura/montagna/viewpoints spesso chicche
  if (catKey === "natura" || catKey === "montagna" || catKey === "viewpoints") return "chicca";

  // Borghi hamlet spesso chicche
  if (catKey === "borghi" && tags.place === "hamlet") return "chicca";

  return "classica";
}

function beautyScoreHeuristic(catKey, tags = {}) {
  let s = 0.72;

  if (tags.tourism === "theme_park") s += 0.10;
  if (tags.leisure === "water_park") s += 0.10;
  if (tags.tourism === "zoo" || tags.tourism === "aquarium" || tags.amenity === "aquarium") s += 0.08;

  if (tags.tourism === "viewpoint" || tags.man_made === "observation_tower") s += 0.08;

  if (tags.natural === "waterfall") s += 0.10;
  if (tags.natural === "gorge") s += 0.08;
  if (tags.water === "lake" || tags.natural === "water") s += 0.06;
  if (tags.natural === "peak" || tags.natural === "saddle") s += 0.06;

  if (tags.historic === "castle" || tags.historic === "fort") s += 0.10;
  if (tags.tourism === "museum") s += 0.05;

  if (catKey === "relax" && (tags.amenity === "spa" || tags.leisure === "spa" || tags.natural === "hot_spring")) s += 0.08;

  // segnali forti -> più alto
  if (tags.wikipedia || tags.wikidata) s += 0.04;

  s = Math.max(0.58, Math.min(0.92, s));
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
