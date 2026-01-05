// scripts/build_pois_it_all.mjs
// Build POIs IT (offline dataset) per categorie -> usabile in app senza LIVE.
// Output:
// - public/data/pois/it/<category>.json
// - public/data/pois_it_all.json (tutto insieme)
// - public/data/pois_index_it.json (indice)
// Node 20 (ESM). Nessuna dipendenza.

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "public/data");
const OUT_POIS_DIR = path.join(OUT_DIR, "pois/it");

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

async function fetchWithTimeout(url, body, timeoutMs = 60000) {
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
function opBody(query) { return `data=${encodeURIComponent(query)}`; }

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

// ---- Categorie che userai nelle chip (compatibili con la tua app) ----
// Nota: borghi/citta (place=*) possono diventare enormi anche in Italia.
// Li includo ma con filtri per evitare milioni (solo se hanno name e limit su tipi).
const CATEGORIES = {
  // ---- FAMILY ----
  family: `
(
  nwr["tourism"="theme_park"](area.IT);
  nwr["leisure"="water_park"](area.IT);
  nwr["tourism"="zoo"](area.IT);
  nwr["tourism"="aquarium"](area.IT);
  nwr["amenity"="aquarium"](area.IT);

  // kids museum / science center
  nwr["tourism"="museum"]["name"~"bambin|kids|children|museo dei bambini|children\\s?museum|science\\s?center|planetari|planetarium|interattiv",i](area.IT);
  nwr["tourism"="attraction"]["name"~"bambin|kids|children|museo dei bambini|children\\s?museum|science\\s?center|planetari|planetarium|interattiv",i](area.IT);

  // adventure / fattorie didattiche (name-based)
  nwr["tourism"="attraction"]["name"~"parco\\s?avventura|fattoria|didattic|faunistico|safari|luna\\s?park|lunapark|giostre|parco\\s?divertimenti|acquapark|aqua\\s?park|water\\s?park",i](area.IT);

  // playground SOLO se ha name (riduce rumore)
  nwr["leisure"="playground"]["name"](area.IT);
);
`,

  theme_park: `
(
  nwr["tourism"="theme_park"](area.IT);
  nwr["leisure"="water_park"](area.IT);
  nwr["tourism"="attraction"]["name"~"parco\\s?divertimenti|lunapark|luna\\s?park|giostre|acquapark|aqua\\s?park|water\\s?park|parco\\s?acquatico",i](area.IT);
  nwr["leisure"="amusement_arcade"]["name"](area.IT);
);
`,

  kids_museum: `
(
  nwr["tourism"="museum"]["name"~"bambin|kids|children|museo dei bambini|children\\s?museum|science\\s?center|planetari|planetarium|interattiv",i](area.IT);
  nwr["tourism"="attraction"]["name"~"bambin|kids|children|museo dei bambini|children\\s?museum|science\\s?center|planetari|planetarium|interattiv",i](area.IT);
);
`,

  // ---- NATURA ----
  natura: `
(
  nwr["natural"="waterfall"](area.IT);
  nwr["natural"="peak"](area.IT);
  nwr["natural"="spring"](area.IT);
  nwr["leisure"="nature_reserve"](area.IT);
  nwr["boundary"="national_park"](area.IT);
  nwr["natural"="cave_entrance"](area.IT);
  nwr["waterway"="riverbank"]["name"](area.IT);
  nwr["natural"="bay"]["name"](area.IT);
);
`,

  // ---- MARE ----
  mare: `
(
  nwr["natural"="beach"](area.IT);
  nwr["leisure"="marina"](area.IT);
  nwr["tourism"="viewpoint"]["name"~"mare|costa|coast|spiaggia|beach|baia|lido",i](area.IT);
);
`,

  // ---- STORIA ----
  storia: `
(
  nwr["historic"="castle"](area.IT);
  nwr["historic"="ruins"](area.IT);
  nwr["historic"="archaeological_site"](area.IT);
  nwr["tourism"="museum"](area.IT);
  nwr["historic"="monument"](area.IT);
  nwr["historic"="memorial"](area.IT);
  nwr["historic"="fort"](area.IT);
  nwr["amenity"="place_of_worship"]["name"~"abbazia|cattedrale|basilica|duomo|santuario|monastero",i](area.IT);
);
`,

  // ---- RELAX ----
  relax: `
(
  nwr["amenity"="spa"](area.IT);
  nwr["leisure"="spa"](area.IT);
  nwr["natural"="hot_spring"](area.IT);
  nwr["amenity"="public_bath"](area.IT);
  nwr["thermal"="yes"](area.IT);
  nwr["name"~"terme|spa|benessere|thermal",i](area.IT);
);
`,

  // ---- MONTAGNA ----
  montagna: `
(
  nwr["natural"="peak"](area.IT);
  nwr["amenity"="shelter"](area.IT);
  nwr["tourism"="viewpoint"](area.IT);
  nwr["tourism"="alpine_hut"](area.IT);
  nwr["name"~"monte|cima|passo|rifugio",i](area.IT);
);
`,

  // ---- VIEWPOINTS ----
  viewpoints: `
(
  nwr["tourism"="viewpoint"](area.IT);
  nwr["name"~"belvedere|panoram|terrazza|vista|viewpoint|scenic",i](area.IT);
);
`,

  // ---- HIKING ----
  hiking: `
(
  nwr["information"="guidepost"](area.IT);
  nwr["amenity"="shelter"](area.IT);
  nwr["route"="hiking"]["name"](area.IT);
  nwr["name"~"sentiero|trail|trek|trekking|hike|hiking|via\\s?ferrata|anello",i](area.IT);
);
`,

  // ---- BORGHI / CITTA (ridotti, per non esplodere) ----
  // NB: questi sono “place=*” e possono diventare tantissimi: li limitiamo a località nominate.
  borghi: `
(
  nwr["place"="hamlet"]["name"](area.IT);
  nwr["place"="village"]["name"](area.IT);
  nwr["name"~"borgo|castel|rocca|borgo\\s?antico|centro\\s?storico",i](area.IT);
);
`,

  citta: `
(
  nwr["place"="city"]["name"](area.IT);
  nwr["place"="town"]["name"](area.IT);
  nwr["name"~"centro|piazza|duomo",i]["tourism"!="information"](area.IT);
);
`,
};

function buildQuery(catKey) {
  // area IT by ISO
  return `
[out:json][timeout:180];
area["ISO3166-1"="IT"]->.IT;
${CATEGORIES[catKey]}
out tags center;
  `.trim();
}

function mapElementToPlace(el, catKey) {
  const tags = el?.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";
  const cleanedName = String(name || "").trim();
  if (!cleanedName || cleanedName.length < 2) return null;

  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  // tags compact k=v
  const tagList = [];
  const pushKV = (k) => { if (tags[k] != null) tagList.push(`${k}=${tags[k]}`); };
  ["tourism","leisure","historic","natural","amenity","information","place","boundary","route","waterway"].forEach(pushKV);

  // Heuristica "chicca" (semplice ma utile): non brand + nome “natura/particolare”
  const nm = norm(cleanedName);
  const hasBrandish = !!(tags.brand || tags.operator);
  const chiccaHint =
    !hasBrandish &&
    (nm.includes("gola") || nm.includes("cascata") || nm.includes("eremo") || nm.includes("orrido") ||
     nm.includes("riserva") || nm.includes("belvedere") || nm.includes("sentiero") || nm.includes("borgo"));

  const visibility = chiccaHint ? "chicca" : "classica";

  // campi “compatibili” con il tuo ecosistema
  const ideal_for = (() => {
    const out = new Set();
    if (catKey === "family" || catKey === "theme_park" || catKey === "kids_museum") { out.add("famiglie"); out.add("bambini"); }
    if (catKey === "storia") out.add("storia");
    if (catKey === "mare") out.add("mare");
    if (catKey === "natura" || catKey === "hiking" || catKey === "viewpoints" || catKey === "montagna") out.add("natura");
    if (catKey === "relax") out.add("relax");
    if (catKey === "borghi") out.add("borghi");
    if (catKey === "citta") out.add("citta");
    return [...out];
  })();

  const family_level =
    (catKey === "family" || catKey === "theme_park" || catKey === "kids_museum") ? "high" : "low";

  return {
    id: `poi_it_${catKey}_${el.type}_${el.id}`,
    name: cleanedName,
    lat,
    lon,
    country: "IT",
    area: "",
    type: catKey,                 // <-- fondamentale: filtro categoria affidabile
    primary_category: catKey,      // <-- idem
    ideal_for,
    family_level,
    visibility,
    tags: Array.from(new Set(tagList)).slice(0, 22),
    beauty_score: visibility === "chicca" ? 0.78 : 0.72,
    live: false,
    source: "overpass_build_it",
  };
}

function dedupPlaces(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const k = `${norm(p.name)}_${String(p.lat).slice(0, 6)}_${String(p.lon).slice(0, 6)}`;
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
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const j = await fetchWithTimeout(endpoint, body, 70000);
        return { ok: true, endpoint, json: j };
      } catch (e) {
        lastErr = e;
        // backoff + piccola pausa per non essere bannati
        await sleep(800 * attempt);
      }
    }
    // pausa tra endpoint
    await sleep(1000);
  }
  return { ok: false, endpoint: "", json: null, error: String(lastErr?.message || lastErr) };
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj), "utf8");
}

async function main() {
  ensureDir(OUT_DIR);
  ensureDir(OUT_POIS_DIR);

  const metaBase = {
    built_at: nowIso(),
    scope: "IT",
    categories: Object.keys(CATEGORIES),
    notes: [],
  };

  const byCat = {};
  const all = [];

  for (const catKey of Object.keys(CATEGORIES)) {
    console.log(`🛰️ Fetch category: ${catKey}`);

    const q = buildQuery(catKey);
    const r = await runOverpass(q);

    if (!r.ok || !r.json) {
      console.log(`❌ ${catKey} failed: ${r.error || "fetch failed"}`);
      metaBase.notes.push(`fail_${catKey}`);
      byCat[catKey] = [];
      // scriviamo comunque file vuoto (così l’app non crasha)
      writeJson(path.join(OUT_POIS_DIR, `${catKey}.json`), { meta: { ...metaBase, category: catKey }, places: [] });
      continue;
    }

    const els = Array.isArray(r.json.elements) ? r.json.elements : [];
    const mapped = dedupPlaces(els.map(el => mapElementToPlace(el, catKey)).filter(Boolean));

    console.log(`✅ ${catKey}: ${mapped.length} items (endpoint: ${r.endpoint})`);

    byCat[catKey] = mapped;
    all.push(...mapped);

    writeJson(path.join(OUT_POIS_DIR, `${catKey}.json`), {
      meta: { ...metaBase, category: catKey, endpoint: r.endpoint },
      places: mapped,
    });

    // throttle leggero tra categorie per non stressare Overpass
    await sleep(900);
  }

  const allDedup = dedupPlaces(all);

  const index = {
    meta: metaBase,
    counts: Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, v.length])),
    total: allDedup.length,
    files: Object.keys(byCat).map((k) => ({
      category: k,
      path: `/data/pois/it/${k}.json`,
      count: byCat[k].length,
    })),
  };

  writeJson(path.join(OUT_DIR, "pois_index_it.json"), index);
  writeJson(path.join(OUT_DIR, "pois_it_all.json"), { meta: metaBase, places: allDedup });

  console.log(`🎉 DONE: total unique IT POIs = ${allDedup.length}`);
}

main().catch((e) => {
  console.error("❌ build failed:", e);
  process.exit(1);
});
