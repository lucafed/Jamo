// scripts/build_pois_family_eu_uk.mjs
// Build OFFLINE POIs "FAMILY" EU+UK
// Output:
// - public/data/pois/family.json
// - public/data/pois_index_family.json (debug)

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "public", "data", "pois");
const OUT_INDEX = path.join(ROOT, "public", "data", "pois_index_family.json");
const OUT_FAMILY = path.join(OUT_DIR, "family.json");

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowIso() { return new Date().toISOString(); }

async function fetchWithTimeout(url, body, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
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
function opBody(q) { return `data=${encodeURIComponent(q)}`; }

// EU+UK
const COUNTRIES = [
  "AT","BE","BG","CY","CZ","DE","DK","EE","ES","FI","FR","GR","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK","UK"
];

function areaDefs() {
  return COUNTRIES.map(c => `area["ISO3166-1"="${c}"]->.a${c};`).join("\n");
}
function areaUnion() {
  return `(${COUNTRIES.map(c => `.a${c};`).join("")})->.EUUK;`;
}

/**
 * FAMILY = posti per bambini e famiglie:
 * - Theme parks, Water parks, Zoo, Aquarium
 * - Playground (solo con name -> riduce spam)
 * - Adventure parks / Rope parks (name matching)
 * - Science center / kids museum (name matching)
 * - Inverno: ski area basic (aerialway / piste / snowpark keywords) -> cose "neve" family-friendly
 *
 * IMPORTANT: niente spa/terme qui (quelle sono RELAX)
 */
function buildQueryFamily() {
  return `
[out:json][timeout:240];
${areaDefs()}
${areaUnion()}
(
  // --- CORE FAMILY ---
  nwr["tourism"="theme_park"](area.EUUK);
  nwr["leisure"="water_park"](area.EUUK);
  nwr["tourism"="zoo"](area.EUUK);
  nwr["tourism"="aquarium"](area.EUUK);
  nwr["amenity"="aquarium"](area.EUUK);

  // --- PLAYGROUND (solo se ha nome) ---
  nwr["leisure"="playground"]["name"](area.EUUK);

  // --- KIDS / SCIENCE / PLANETARIUM ---
  nwr["tourism"="museum"]["name"~"children|kids|bambin|museo\\s+dei\\s+bambini|children\\s?museum|science\\s?center|planetari|planetarium",i](area.EUUK);
  nwr["tourism"="attraction"]["name"~"children|kids|bambin|museo\\s+dei\\s+bambini|children\\s?museum|science\\s?center|planetari|planetarium",i](area.EUUK);

  // --- ADVENTURE PARK / ROPE PARK ---
  nwr["tourism"="attraction"]["name"~"parco\\s?avventura|adventure\\s?park|rope\\s?park|forest\\s?park|parco\\s?acrobatico|zip\\s?line",i](area.EUUK);
  nwr["leisure"="park"]["name"~"parco\\s?avventura|adventure\\s?park|rope\\s?park|parco\\s?acrobatico|zip\\s?line",i](area.EUUK);

  // --- INVERNO / NEVE (family: impianti + snowpark keyword) ---
  nwr["aerialway"](area.EUUK);
  nwr["piste:type"](area.EUUK);
  nwr["tourism"="attraction"]["name"~"snow\\s?park|snowpark|pista\\s?sci|ski\\s?park|winter\\s?park|funivia|seggiovia",i](area.EUUK);

  // --- extra: luna park / giostre / acquapark / safari ---
  nwr["tourism"="attraction"]["name"~"lunapark|luna\\s?park|giostre|acquapark|aqua\\s?park|water\\s?park|safari|parco\\s?faunistico",i](area.EUUK);
);
out tags center;
`.trim();
}

function tagListFrom(tags = {}) {
  const out = [];
  const pushKV = (k) => { if (tags[k] != null) out.push(`${k}=${tags[k]}`); };
  [
    "tourism","leisure","historic","natural","amenity","information","place","boundary",
    "aerialway","piste:type","sport","attraction","name"
  ].forEach(pushKV);

  // NON aggiungere spa/terme: le vogliamo fuori dal file family anche se sporcano
  return Array.from(new Set(out)).slice(0, 18);
}

function isClearlyBad(tags = {}) {
  const name = String(tags.name || "").toLowerCase();
  // filtri anti-spazzatura
  if (!name || name.length < 2) return true;
  if (name === "meta") return true;
  // hard block spa/terme anche se finissero dentro
  if (name.includes("terme") || name.includes("spa") || name.includes("thermal") || name.includes("benessere")) return true;
  return false;
}

function classifyFamily(tags = {}) {
  // scegliamo un sotto-tipo utile per UI/filtri futuri (ma restiamo in "family")
  if (tags.tourism === "theme_park") return "theme_park";
  if (tags.leisure === "water_park") return "water_park";
  if (tags.tourism === "zoo") return "zoo";
  if (tags.tourism === "aquarium" || tags.amenity === "aquarium") return "aquarium";
  if (tags.leisure === "playground") return "playground";
  if (String(tags.name || "").match(/snow\s?park|snowpark|pista\s?sci|ski\s?park|funivia|seggiovia/i)) return "snow";
  if (String(tags.name || "").match(/science\s?center|planetari|planetarium|children|kids|bambin/i)) return "kids_museum";
  if (String(tags.name || "").match(/parco\s?avventura|adventure\s?park|rope\s?park|zip\s?line/i)) return "adventure";
  return "family";
}

function mapElementToPlace(el) {
  const tags = el.tags || {};
  if (isClearlyBad(tags)) return null;

  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const sub = classifyFamily(tags);

  return {
    id: `poi_family_${el.type}_${el.id}`,
    name: String(name).trim(),
    lat,
    lon,
    type: "family",                // categoria principale (coerente con app.js)
    family_type: sub,              // sotto-tipo utile
    primary_category: "family",
    visibility: "classica",        // per ora (poi possiamo fare chicche con heuristics)
    beauty_score: 0.72,
    tags: tagListFrom(tags),
    source: "overpass_build",
    live: false,
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

async function runOverpass(query) {
  const body = opBody(query);
  let lastErr = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const j = await fetchWithTimeout(endpoint, body, 120000);
        return { ok: true, endpoint, json: j };
      } catch (e) {
        lastErr = e;
        await sleep(800 * attempt);
      }
    }
  }

  return { ok: false, endpoint: "", json: null, error: String(lastErr?.message || lastErr) };
}

async function main() {
  ensureDir(OUT_DIR);

  const meta = {
    built_at: nowIso(),
    countries: COUNTRIES,
    category: "family",
    notes: [
      "FAMILY offline EU+UK: theme parks, water parks, zoo, aquarium, playground(named), kids/science, adventure parks, snow basics",
      "No spa/terme in family (hard filtered).",
    ],
  };

  console.log("🛰️ Fetch FAMILY EU+UK (Overpass) …");
  const q = buildQueryFamily();
  const r = await runOverpass(q);

  if (!r.ok || !r.json) {
    console.log("❌ FAMILY failed:", r.error || "unknown");
    // scrivo comunque un file valido (vuoto) così non si rompe la build
    const empty = { meta: { ...meta, endpoint: "", ok: false, error: r.error || "unknown" }, places: [] };
    fs.writeFileSync(OUT_FAMILY, JSON.stringify(empty), "utf8");
    fs.writeFileSync(OUT_INDEX, JSON.stringify({ ...empty.meta, total: 0 }, null, 0), "utf8");
    process.exit(1);
  }

  const els = Array.isArray(r.json.elements) ? r.json.elements : [];
  const mapped = dedupPlaces(els.map(mapElementToPlace).filter(Boolean));

  console.log(`✅ FAMILY: ${mapped.length} items (endpoint: ${r.endpoint})`);

  const out = {
    meta: { ...meta, endpoint: r.endpoint, ok: true, raw_elements: els.length, total: mapped.length },
    places: mapped,
  };

  fs.writeFileSync(OUT_FAMILY, JSON.stringify(out), "utf8");
  fs.writeFileSync(OUT_INDEX, JSON.stringify(out.meta), "utf8");

  console.log("🎉 DONE:", OUT_FAMILY);
}

main().catch((e) => {
  console.error("❌ build failed:", e);
  process.exit(1);
});
