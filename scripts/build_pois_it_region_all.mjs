// scripts/build_pois_it_region_all.mjs
// Build POIs for ALL categories for ONE IT region via Overpass (safe + retry)
// Usage:
//   REGION_SLUG=veneto REGION_ISO=IT-34 node scripts/build_pois_it_region_all.mjs
//
// Output files:
//   public/data/pois/it/<region_slug>/<category>.json
//   public/data/pois/it/<region_slug>/index.json

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const OUT_BASE = path.join(ROOT, "public", "data", "pois", "it");

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

async function fetchWithTimeout(url, body, timeoutMs = 55000) {
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

function dedup(places) {
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

function mapElToPlace(el, catKey, regionSlug, regionIso) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const tagList = [];
  const pushKV = (k) => { if (tags[k] != null) tagList.push(`${k}=${tags[k]}`); };
  ["tourism","leisure","amenity","historic","natural","sport","information","place","boundary","aerialway"].forEach(pushKV);

  return {
    id: `poi_${catKey}_${regionSlug}_${el.type}_${el.id}`,
    name: String(name).trim(),
    lat,
    lon,
    type: catKey,
    primary_category: catKey,
    visibility: "classica",
    beauty_score: 0.72,
    tags: Array.from(new Set(tagList)).slice(0, 18),
    country: "IT",
    area: regionSlug,
    region_iso: regionIso,
    source: "overpass_region_build",
    live: false,
  };
}

async function runOverpass(query) {
  const body = opBody(query);
  let lastErr = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const j = await fetchWithTimeout(endpoint, body, 55000);
        return { ok: true, endpoint, json: j };
      } catch (e) {
        lastErr = e;
        await sleep(1000 * attempt);
      }
    }
  }
  return { ok: false, endpoint: "", json: null, error: String(lastErr?.message || lastErr) };
}

// ------------------- CATEGORIES (region-scoped) -------------------
// Nota: qui NON metto "borghi/citta" perché sono enormi e ti rallentano tutto.
// Le mete "borghi/città" le hai già nei macro offline.
// Qui puntiamo a POI "attività" utili per la domanda "che facciamo oggi?".
const CATEGORIES = {
  family: `
(
  nwr["tourism"="theme_park"](area.R);
  nwr["leisure"="water_park"](area.R);
  nwr["tourism"="zoo"](area.R);
  nwr["tourism"="aquarium"](area.R);

  nwr["tourism"="attraction"]["name"~"parco\\s?avventura|avventura|zip\\s?line|safari|fattoria\\s?didattica|parco\\s?faunistico|giostre|lunapark|luna\\s?park|parco\\s?divertimenti|acquapark|aqua\\s?park|water\\s?park",i](area.R);

  nwr["tourism"="museum"]["name"~"bambin|bambini|kids|children|museo\\s?dei\\s?bambini|science\\s?center|planetari|planetarium",i](area.R);
  nwr["tourism"="attraction"]["name"~"bambin|bambini|kids|children|science\\s?center|planetari|planetarium",i](area.R);

  nwr["leisure"="playground"]["name"](area.R);
);
`,

  theme_park: `
(
  nwr["tourism"="theme_park"](area.R);
  nwr["leisure"="water_park"](area.R);
  nwr["tourism"="attraction"]["name"~"parco\\s?divertimenti|lunapark|luna\\s?park|giostre|acquapark|aqua\\s?park|water\\s?park",i](area.R);
);
`,

  kids_museum: `
(
  nwr["tourism"="museum"]["name"~"bambin|bambini|kids|children|museo\\s?dei\\s?bambini|science\\s?center|planetari|planetarium",i](area.R);
  nwr["tourism"="attraction"]["name"~"bambin|bambini|kids|children|science\\s?center|planetari|planetarium",i](area.R);
);
`,

  viewpoints: `
(
  nwr["tourism"="viewpoint"](area.R);
  nwr["name"~"belvedere|panoram|viewpoint|scenic|terrazza|vista",i](area.R);
);
`,

  hiking: `
(
  nwr["information"="guidepost"](area.R);
  nwr["amenity"="shelter"](area.R);
  nwr["name"~"sentiero|trail|trek|trekking|hike|hiking|via\\s?ferrata|rifugio|anello",i](area.R);
);
`,

  mare: `
(
  nwr["natural"="beach"](area.R);
  nwr["leisure"="marina"](area.R);
  nwr["tourism"="viewpoint"]["name"~"mare|spiaggia|beach|costa|coast|lido",i](area.R);
);
`,

  natura: `
(
  nwr["natural"="waterfall"](area.R);
  nwr["natural"="spring"](area.R);
  nwr["natural"="peak"](area.R);
  nwr["leisure"="nature_reserve"](area.R);
  nwr["boundary"="national_park"](area.R);
  nwr["natural"="cave_entrance"](area.R);
);
`,

  storia: `
(
  nwr["historic"="castle"](area.R);
  nwr["historic"="ruins"](area.R);
  nwr["historic"="archaeological_site"](area.R);
  nwr["tourism"="museum"](area.R);
  nwr["historic"="monument"](area.R);
  nwr["historic"="memorial"](area.R);
);
`,

  montagna: `
(
  nwr["natural"="peak"](area.R);
  nwr["tourism"="viewpoint"](area.R);
  nwr["amenity"="shelter"](area.R);
  nwr["aerialway"](area.R);
  nwr["name"~"rifugio|cima|vetta|passo\\s|funivia|seggiovia|ski|pista",i](area.R);
);
`,

  relax: `
(
  nwr["amenity"="spa"](area.R);
  nwr["leisure"="spa"](area.R);
  nwr["natural"="hot_spring"](area.R);
  nwr["amenity"="public_bath"](area.R);
  nwr["thermal"="yes"](area.R);
  nwr["name"~"terme|spa|thermal|benessere",i](area.R);
);
`,
};

// Query wrapper (region area by ISO3166-2)
function buildQuery(regionIso, catKey) {
  return `
[out:json][timeout:120];
area["ISO3166-2"="${regionIso}"]->.R;
${CATEGORIES[catKey]}
out tags center;
`.trim();
}

async function main() {
  const regionSlug = String(process.env.REGION_SLUG || "").trim().toLowerCase();
  const regionIso  = String(process.env.REGION_ISO  || "").trim().toUpperCase();

  if (!regionSlug || !regionIso) {
    console.error("Missing REGION_SLUG or REGION_ISO. Example: REGION_SLUG=veneto REGION_ISO=IT-34");
    process.exit(1);
  }

  const outDir = path.join(OUT_BASE, regionSlug);
  ensureDir(outDir);

  const index = {
    meta: {
      built_at: nowIso(),
      region_slug: regionSlug,
      region_iso: regionIso,
      categories: Object.keys(CATEGORIES),
    },
    counts: {},
    files: [],
  };

  for (const catKey of Object.keys(CATEGORIES)) {
    console.log(`🛰️ ${regionSlug} (${regionIso}) -> ${catKey}`);

    const q = buildQuery(regionIso, catKey);
    const r = await runOverpass(q);

    if (!r.ok || !r.json) {
      console.log(`❌ ${catKey} failed: ${r.error || "unknown"}`);
      index.counts[catKey] = 0;
      index.files.push({ category: catKey, path: `/data/pois/it/${regionSlug}/${catKey}.json`, count: 0, ok: false });
      // non blocchiamo tutto: continuiamo con le altre categorie
      fs.writeFileSync(
        path.join(outDir, `${catKey}.json`),
        JSON.stringify({ meta: { built_at: nowIso(), region_slug: regionSlug, region_iso: regionIso, category: catKey, ok: false, error: r.error || "overpass_failed" }, places: [] }),
        "utf8"
      );
      continue;
    }

    const els = Array.isArray(r.json.elements) ? r.json.elements : [];
    const mapped = dedup(els.map(el => mapElToPlace(el, catKey, regionSlug, regionIso)).filter(Boolean));

    const meta = {
      built_at: nowIso(),
      region_slug: regionSlug,
      region_iso: regionIso,
      category: catKey,
      endpoint: r.endpoint,
      count: mapped.length,
      ok: true,
    };

    fs.writeFileSync(
      path.join(outDir, `${catKey}.json`),
      JSON.stringify({ meta, places: mapped }),
      "utf8"
    );

    index.counts[catKey] = mapped.length;
    index.files.push({ category: catKey, path: `/data/pois/it/${regionSlug}/${catKey}.json`, count: mapped.length, ok: true });

    console.log(`✅ ${catKey}: ${mapped.length}`);
    // mini-pausa per non stressare Overpass
    await sleep(600);
  }

  fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify(index), "utf8");
  console.log(`🎉 DONE index -> public/data/pois/it/${regionSlug}/index.json`);
}

main().catch((e) => {
  console.error("❌ build failed:", e);
  process.exit(1);
});
