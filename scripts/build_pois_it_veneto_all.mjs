// scripts/build_pois_it_veneto_all.mjs
// Build OFFLINE POIs for Veneto (IT) — ALL categories in ONE file (TOURISTIC + CLEAN)
// Output: public/data/pois/regions/it-veneto.json
//
// ✅ Categorie turistiche (tag OSM reali) + filtri anti-sporco
// ✅ Natura presente: laghi/cascate/fiumi/parchi/riserv e ecc.
// ✅ Family: NO playground a valanga (solo “forti”: theme park, zoo, aquarium, water park, rope course, farm attraction, ecc.)
// ✅ Storia: taglia le cose troppo minori, punta su castelli/forti/mura/siti/musei/abbazie/chiese importanti
// ✅ Distinzione chicche/classiche (euristica su tag + importanza)
// ✅ Dedup NON schiaccia le categorie (chiave include type)
// ✅ Offline, niente cose “strane” o non inerenti

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
// CATEGORIE TURISTICHE (tag OSM “forti”)
// ------------------------------------------------------------
const CATEGORIES = {
  // FAMILY “forte”: parchi, zoo, acquari, rope course, mini-golf, fattorie attrazione, cinema (ok), ecc.
  // ⚠️ NO playground qui (troppo spam)
  family: `
  (
    nwr["tourism"="theme_park"](area.VENETO);
    nwr["leisure"="water_park"](area.VENETO);

    nwr["tourism"="zoo"](area.VENETO);
    nwr["tourism"="aquarium"](area.VENETO);
    nwr["amenity"="aquarium"](area.VENETO);

    nwr["leisure"="high_ropes_course"](area.VENETO);
    nwr["leisure"="rope_course"](area.VENETO);
    nwr["leisure"="miniature_golf"](area.VENETO);
    nwr["leisure"="trampoline_park"](area.VENETO);
    nwr["leisure"="ice_rink"](area.VENETO);
    nwr["leisure"="bowling_alley"](area.VENETO);

    // attrazioni “family” tipiche
    nwr["tourism"="attraction"]["attraction"="animal"](area.VENETO);
    nwr["tourism"="attraction"]["attraction"="farm"](area.VENETO);

    // musei/esperienze family (tag, non nome)
    nwr["tourism"="museum"]["museum"="children"](area.VENETO);
    nwr["tourism"="museum"]["museum"="science"](area.VENETO);
    nwr["tourism"="museum"]["museum"="interactive"](area.VENETO);
  );
  `,

  // Parchi (subset “forte”)
  theme_park: `
  (
    nwr["tourism"="theme_park"](area.VENETO);
    nwr["leisure"="water_park"](area.VENETO);
  );
  `,

  // Panorami: SOLO viewpoint veri + observation tower
  viewpoints: `
  (
    nwr["tourism"="viewpoint"](area.VENETO);
    nwr["man_made"="observation_tower"](area.VENETO);
    nwr["man_made"="tower"]["tower:type"="observation"](area.VENETO);
  );
  `,

  // Trekking: rifugi/bivacchi + guidepost “importanti” (con name)
  hiking: `
  (
    nwr["tourism"="alpine_hut"](area.VENETO);
    nwr["amenity"="shelter"](area.VENETO);
    nwr["information"="guidepost"]["name"](area.VENETO);
  );
  `,

  // NATURA: laghi/cascate/fiumi/sorgenti/grotte/parchi/riserv e
  natura: `
  (
    // acqua “wow”
    nwr["natural"="waterfall"](area.VENETO);
    nwr["natural"="spring"](area.VENETO);

    // laghi / bacini
    nwr["natural"="water"]["name"](area.VENETO);

    // fiumi / gole / sponde (turistici spesso)
    nwr["waterway"="river"]["name"](area.VENETO);
    nwr["waterway"="stream"]["name"](area.VENETO);
    nwr["waterway"="riverbank"]["name"](area.VENETO);

    // parchi/riserv e
    nwr["leisure"="nature_reserve"](area.VENETO);
    nwr["boundary"="national_park"](area.VENETO);

    // grotte
    nwr["natural"="cave_entrance"](area.VENETO);

    // foreste “note” (solo con nome)
    nwr["natural"="wood"]["name"](area.VENETO);
  );
  `,

  // MONTAGNA: cime, passi, rifugi, impianti, ecc.
  montagna: `
  (
    nwr["natural"="peak"](area.VENETO);
    nwr["natural"="saddle"](area.VENETO);
    nwr["tourism"="alpine_hut"](area.VENETO);
    nwr["amenity"="shelter"](area.VENETO);

    // impianti (invernale/estate)
    nwr["aerialway"](area.VENETO);

    // aree sci / piste
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

  // STORIA: turistica (taglia micro-robe)
  storia: `
  (
    nwr["historic"="castle"](area.VENETO);
    nwr["historic"="fort"](area.VENETO);
    nwr["historic"="citywalls"](area.VENETO);
    nwr["historic"="archaeological_site"](area.VENETO);
    nwr["historic"="ruins"](area.VENETO);

    // musei / siti culturali
    nwr["tourism"="museum"](area.VENETO);
    nwr["tourism"="attraction"]["historic"~"."](area.VENETO);

    // luoghi religiosi “forti” (spesso turismo): solo se historic=* o heritage=*
    nwr["amenity"="place_of_worship"]["historic"~"."](area.VENETO);
    nwr["amenity"="place_of_worship"]["heritage"~"."](area.VENETO);

    // monumenti/memorial SOLO se importanti (heritage o tourism=attraction)
    nwr["historic"="monument"]["heritage"~"."](area.VENETO);
    nwr["historic"="memorial"]["heritage"~"."](area.VENETO);
  );
  `,

  // RELAX: spa/terme/sauna/piscine (ricco ma coerente)
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

  // BORGHI: riduciamo spam -> solo place=village e place=town con population piccola? (non sempre presente)
  // qui restiamo semplici: village + hamlet con name (è già così)
  borghi: `
  (
    nwr["place"="village"]["name"](area.VENETO);
    nwr["place"="hamlet"]["name"](area.VENETO);
  );
  `,

  // CITTA
  citta: `
  (
    nwr["place"="city"]["name"](area.VENETO);
    nwr["place"="town"]["name"](area.VENETO);
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
function normStr(x){ return String(x || "").toLowerCase().trim(); }

function isFoodOrLodging(tags = {}) {
  // lodging
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

function allowIfMountainHut(tags, catKey) {
  return tags.tourism === "alpine_hut" && (catKey === "hiking" || catKey === "montagna");
}

function allowIfAerialway(tags, catKey) {
  return tags.aerialway && catKey === "montagna";
}

function shouldDrop(el, catKey) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";

  // nome obbligatorio
  if (!name || String(name).trim().length < 2) return true;

  // stop “commerciale” (eccetto rifugi/impianti per montagna)
  if (isFoodOrLodging(tags)) {
    if (allowIfMountainHut(tags, catKey)) return false;
    return true;
  }

  // se è place=* deve stare solo in borghi/citta
  if (tags.place && !(catKey === "borghi" || catKey === "citta")) return true;

  // family: escludi spa/terme
  if (catKey === "family") {
    const n = normStr(name);
    if (
      tags.amenity === "spa" ||
      tags.leisure === "spa" ||
      tags.amenity === "public_bath" ||
      tags.natural === "hot_spring" ||
      tags.amenity === "sauna" ||
      tags.leisure === "sauna" ||
      n.includes("terme") || n.includes("spa") || n.includes("thermal") || n.includes("benessere")
    ) return true;
  }

  // hiking: taglia guidepost “spam” (anche se ha name troppo corto)
  if (catKey === "hiking" && tags.information === "guidepost") {
    const n = String(name).trim();
    if (n.length < 6) return true;
    const nn = normStr(n);
    const ok = nn.includes("sentier") || nn.includes("cai") || nn.includes("anello") || nn.includes("trail") || nn.includes("via");
    if (!ok) return true;
  }

  // mare: evita robe che non sono mare
  if (catKey === "mare") {
    if (!(tags.natural === "beach" || tags.leisure === "marina" || tags.natural === "coastline")) return true;
  }

  // montagna: evita place=*
  if (catKey === "montagna") {
    if (tags.place) return true;
    // deve avere almeno un segnale montagna
    const ok = !!(
      tags.natural === "peak" ||
      tags.natural === "saddle" ||
      tags.tourism === "alpine_hut" ||
      tags.amenity === "shelter" ||
      tags.aerialway ||
      tags["piste:type"]
    );
    if (!ok) return true;
  }

  // natura: deve essere davvero natura
  if (catKey === "natura") {
    const ok = !!(
      tags.natural === "waterfall" ||
      tags.natural === "spring" ||
      tags.natural === "water" ||
      tags.waterway === "river" ||
      tags.waterway === "stream" ||
      tags.waterway === "riverbank" ||
      tags.leisure === "nature_reserve" ||
      tags.boundary === "national_park" ||
      tags.natural === "cave_entrance" ||
      tags.natural === "wood"
    );
    if (!ok) return true;
  }

  // viewpoints: solo veri
  if (catKey === "viewpoints") {
    const ok = (tags.tourism === "viewpoint") || (tags.man_made === "observation_tower") || (tags.man_made === "tower" && tags["tower:type"] === "observation");
    if (!ok) return true;
  }

  // storia: taglia micro-monumenti non “forti”
  if (catKey === "storia") {
    const strong =
      tags.historic === "castle" ||
      tags.historic === "fort" ||
      tags.historic === "citywalls" ||
      tags.historic === "archaeological_site" ||
      tags.historic === "ruins" ||
      tags.tourism === "museum" ||
      (tags.tourism === "attraction" && tags.historic) ||
      (tags.amenity === "place_of_worship" && (tags.historic || tags.heritage)) ||
      ((tags.historic === "monument" || tags.historic === "memorial") && tags.heritage);

    if (!strong) return true;
  }

  // relax: deve essere relax vero
  if (catKey === "relax") {
    const ok =
      tags.amenity === "spa" ||
      tags.leisure === "spa" ||
      tags.tourism === "spa" ||
      tags.natural === "hot_spring" ||
      tags.amenity === "public_bath" ||
      tags.amenity === "sauna" ||
      tags.leisure === "sauna" ||
      tags.leisure === "swimming_pool";
    if (!ok) return true;
  }

  // family: deve essere family vero
  if (catKey === "family") {
    const ok =
      tags.tourism === "theme_park" ||
      tags.leisure === "water_park" ||
      tags.tourism === "zoo" ||
      tags.tourism === "aquarium" ||
      tags.amenity === "aquarium" ||
      tags.leisure === "high_ropes_course" ||
      tags.leisure === "rope_course" ||
      tags.leisure === "miniature_golf" ||
      tags.leisure === "trampoline_park" ||
      tags.leisure === "ice_rink" ||
      tags.leisure === "bowling_alley" ||
      (tags.tourism === "attraction" && (tags.attraction === "animal" || tags.attraction === "farm")) ||
      (tags.tourism === "museum" && (tags.museum === "children" || tags.museum === "science" || tags.museum === "interactive"));
    if (!ok) return true;
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
    "boundary","waterway","man_made","attraction","museum","aerialway","piste:type","tower:type","heritage"
  ].forEach(pushKV);

  return Array.from(new Set(out)).slice(0, 28);
}

function visibilityHeuristic(catKey, tags = {}) {
  // chicche: viewpoint, natura “wow”, montagna “wow”, borghi hamlet
  if (catKey === "borghi") return (tags.place === "hamlet") ? "chicca" : "classica";
  if (catKey === "viewpoints") return "chicca";

  if (catKey === "natura") {
    if (tags.natural === "waterfall" || tags.natural === "cave_entrance" || tags.natural === "spring") return "chicca";
    if (tags.leisure === "nature_reserve" || tags.boundary === "national_park") return "classica";
    return "chicca";
  }

  if (catKey === "montagna") {
    if (tags.natural === "peak" || tags["piste:type"] || tags.aerialway) return "classica";
    if (tags.tourism === "alpine_hut") return "chicca";
    return "chicca";
  }

  if (catKey === "storia") {
    // “classica” per castelli/forti/musei grandi, chicca per ruins/archaeological piccoli
    if (tags.historic === "castle" || tags.historic === "fort" || tags.tourism === "museum" || tags.historic === "citywalls") return "classica";
    return "chicca";
  }

  if (catKey === "family") {
    // theme park / zoo classici, rope/farm più chicche
    if (tags.tourism === "theme_park" || tags.leisure === "water_park" || tags.tourism === "zoo" || tags.tourism === "aquarium" || tags.amenity === "aquarium") return "classica";
    return "chicca";
  }

  return "classica";
}

function beautyScoreHeuristic(catKey, tags = {}) {
  let s = 0.72;

  // boost wow
  if (tags.tourism === "theme_park") s += 0.12;
  if (tags.leisure === "water_park") s += 0.12;
  if (tags.tourism === "zoo" || tags.tourism === "aquarium" || tags.amenity === "aquarium") s += 0.10;

  if (tags.tourism === "viewpoint" || tags.man_made === "observation_tower") s += 0.10;

  if (tags.natural === "waterfall") s += 0.12;
  if (tags.natural === "water") s += 0.08;
  if (tags.waterway === "river" || tags.waterway === "riverbank") s += 0.06;
  if (tags.natural === "cave_entrance") s += 0.10;

  if (tags.natural === "peak" || tags.natural === "saddle") s += 0.10;
  if (tags.aerialway || tags["piste:type"]) s += 0.08;

  if (tags.historic === "castle" || tags.historic === "fort") s += 0.12;
  if (tags.tourism === "museum") s += 0.07;
  if (tags.historic === "archaeological_site") s += 0.08;

  if (catKey === "relax" && (tags.amenity === "spa" || tags.leisure === "spa" || tags.natural === "hot_spring")) s += 0.10;

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

// ✅ Dedup “safe”: include type, così non perdi categorie
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
    notes: [
      "touristic_clean_build",
      "family_no_playground_spam",
      "storia_strong_only",
      "natura_lakes_waterfalls_rivers",
    ],
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
