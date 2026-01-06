// scripts/build_pois_it_veneto_all.mjs
// Build OFFLINE POIs for Veneto (IT) — ALL categories in ONE file
// Output: public/data/pois/regions/it-veneto.json

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
        // importante: alcuni endpoint Overpass “gradiscono” uno user-agent chiaro
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
// N.B. Questo evita di fare Italia intera (troppo grande) e rende il build fattibile.
function venetoAreaBlock() {
  return `
  area["boundary"="administrative"]["admin_level"="4"]["name"="Veneto"]->.VENETO;
  `.trim();
}

// ---- CATEGORIE: “tutto quello che c’è intorno” MA inerente ----
// Obiettivo: includere anche cose PICCOLE vicino all’utente, non solo i big.
const CATEGORIES = {
  // FAMILY = posti per bimbi/famiglie (NO terme)
  family: `
  (
    nwr["tourism"="theme_park"](area.VENETO);
    nwr["leisure"="water_park"](area.VENETO);
    nwr["tourism"="zoo"](area.VENETO);
    nwr["tourism"="aquarium"](area.VENETO);
    nwr["amenity"="aquarium"](area.VENETO);

    // parchi avventura / rope park / adventure park
    nwr["tourism"="attraction"]["name"~"parco\\s?avventura|adventure\\s?park|rope\\s?park|zip\\s?line|percorsi\\s?acrobatici",i](area.VENETO);

    // playground (tantissimi: prendiamo SOLO quelli con name per ridurre spam)
    nwr["leisure"="playground"]["name"](area.VENETO);

    // musei kids / science center / planetari / musei bimbi
    nwr["tourism"="museum"]["name"~"bambin|children|kids|museo\\s?dei\\s?bambini|science\\s?center|planetari|planetarium",i](area.VENETO);
    nwr["tourism"="attraction"]["name"~"bambin|children|kids|science\\s?center|planetari|planetarium",i](area.VENETO);

    // luna park / giostre (a volte sono attraction)
    nwr["tourism"="attraction"]["name"~"lunapark|luna\\s?park|giostr|parco\\s?divertimenti",i](area.VENETO);
  );
  `,

  // THEME PARK (subset “forte”)
  theme_park: `
  (
    nwr["tourism"="theme_park"](area.VENETO);
    nwr["leisure"="water_park"](area.VENETO);
    nwr["tourism"="attraction"]["name"~"parco\\s?divertimenti|lunapark|luna\\s?park|giostr|acquapark|aqua\\s?park|water\\s?park",i](area.VENETO);
  );
  `,

  // KIDS MUSEUM
  kids_museum: `
  (
    nwr["tourism"="museum"]["name"~"bambin|children|kids|museo\\s?dei\\s?bambini|science\\s?center|planetari|planetarium",i](area.VENETO);
    nwr["tourism"="attraction"]["name"~"bambin|children|kids|science\\s?center|planetari|planetarium",i](area.VENETO);
  );
  `,

  // VIEWPOINTS
  viewpoints: `
  (
    nwr["tourism"="viewpoint"](area.VENETO);
    nwr["name"~"belvedere|panoram|viewpoint|scenic|terrazza|vista",i](area.VENETO);
  );
  `,

  // HIKING / trekking (guidepost + shelter + nomi)
  hiking: `
  (
    nwr["information"="guidepost"](area.VENETO);
    nwr["amenity"="shelter"](area.VENETO);
    nwr["name"~"sentiero|trail|trek|trekking|hike|hiking|via\\s?ferrata|rifugio|anello",i](area.VENETO);
  );
  `,

  // NATURA
  natura: `
  (
    nwr["natural"="waterfall"](area.VENETO);
    nwr["natural"="peak"](area.VENETO);
    nwr["natural"="spring"](area.VENETO);
    nwr["leisure"="nature_reserve"](area.VENETO);
    nwr["boundary"="national_park"](area.VENETO);
    nwr["natural"="cave_entrance"](area.VENETO);
    nwr["natural"="wood"](area.VENETO);
    nwr["waterway"="riverbank"](area.VENETO);
    nwr["name"~"cascat|lago|forra|gola|riserva|parco\\s?naturale|grotta|bosco",i](area.VENETO);
  );
  `,

  // MARE (Veneto: spiagge, laguna, lidi, marine)
  mare: `
  (
    nwr["natural"="beach"](area.VENETO);
    nwr["leisure"="marina"](area.VENETO);
    nwr["tourism"="attraction"]["name"~"lido|spiaggia|baia|mare|laguna",i](area.VENETO);
  );
  `,

  // STORIA (castelli, rocche, musei, siti)
  storia: `
  (
    nwr["historic"="castle"](area.VENETO);
    nwr["historic"="ruins"](area.VENETO);
    nwr["historic"="archaeological_site"](area.VENETO);
    nwr["historic"="monument"](area.VENETO);
    nwr["tourism"="museum"](area.VENETO);
    nwr["name"~"castell|rocca|forte|museo|abbazia|villa\\s?veneta|anfiteatro|scavi",i](area.VENETO);
  );
  `,

  // RELAX (qui sì: terme/spa/piscine)
  relax: `
  (
    nwr["amenity"="spa"](area.VENETO);
    nwr["leisure"="spa"](area.VENETO);
    nwr["natural"="hot_spring"](area.VENETO);
    nwr["amenity"="public_bath"](area.VENETO);
    nwr["leisure"="swimming_pool"](area.VENETO);
    nwr["name"~"terme|spa|benessere|thermal|piscina",i](area.VENETO);
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

function buildQuery(catKey) {
  return `
[out:json][timeout:180];
${venetoAreaBlock()}
${CATEGORIES[catKey]}
out tags center;
`.trim();
}

// Mappa in “place” compatibile con il tuo stile (simile ai POI buildati prima)
function mapElementToPlace(el, catKey) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const tagList = [];
  const pushKV = (k) => { if (tags[k] != null) tagList.push(`${k}=${tags[k]}`); };
  ["tourism","leisure","historic","natural","amenity","information","place","boundary","waterway"].forEach(pushKV);

  return {
    id: `poi_it-veneto_${catKey}_${el.type}_${el.id}`,
    name: String(name).trim(),
    lat, lon,
    type: catKey,                 // per filtro rapido
    primary_category: catKey,
    visibility: "classica",
    beauty_score: 0.70,
    tags: Array.from(new Set(tagList)).slice(0, 22),
    live: false,
    source: "overpass_veneto_build",
  };
}

function dedupPlaces(places) {
  const seen = new Set();
  const out = [];
  for (const p of places) {
    const k = `${p.name.toLowerCase()}_${String(p.lat).slice(0,6)}_${String(p.lon).slice(0,6)}`;
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
    categories: Object.keys(CATEGORIES),
    notes: [],
  };

  const allByCat = {};
  const all = [];

  for (const catKey of Object.keys(CATEGORIES)) {
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
