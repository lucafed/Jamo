// scripts/build_pois_family_it_region.mjs
// Build FAMILY POIs for ONE IT region using Overpass (CLEAN + richer)
// Usage:
//   REGION_SLUG=piemonte REGION_ISO=IT-21 node scripts/build_pois_family_it_region.mjs
//
// Output:
//   public/data/pois/it/<region_slug>/family.json

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

async function fetchWithTimeout(url, body, timeoutMs = 45000) {
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

function opBody(q) {
  return `data=${encodeURIComponent(q)}`;
}

function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function hasAny(str, arr) { return arr.some(k => str.includes(k)); }

function isClearlyIrrelevant(p) {
  const t = p.tags || {};
  const ts = Object.entries(t).map(([k,v]) => `${String(k).toLowerCase()}=${String(v).toLowerCase()}`).join(" ");
  const n = normName(p.name || "");

  if (hasAny(ts, ["highway=", "railway=", "public_transport=", "route="])) return true;
  if (hasAny(ts, ["amenity=parking","amenity=fuel","amenity=charging_station"])) return true;
  if (hasAny(ts, ["landuse=industrial","building=warehouse","building=office"])) return true;
  if (hasAny(n, ["parcheggio","stazione","fermata","svincolo"])) return true;

  return false;
}

function buildQuery(regionIso) {
  return `
[out:json][timeout:140];
area["ISO3166-2"="${regionIso}"]->.R;

(
  // TOP
  nwr(area.R)["tourism"="theme_park"];
  nwr(area.R)["leisure"="water_park"];
  nwr(area.R)["tourism"="zoo"];
  nwr(area.R)["tourism"="aquarium"];

  // adventure / didattica / safari / kart / minigolf
  nwr(area.R)["tourism"="attraction"]["name"~"parco\\s?avventura|zip\\s?line|safari|fattoria\\s?didattica|parco\\s?faunistico|lunapark|luna\\s?park|giostre|parco\\s?divertimenti|acquapark|aqua\\s?park|water\\s?park|minigolf|go\\s?kart|kart",i];

  // kids museums / science / planetari
  nwr(area.R)["tourism"="museum"]["name"~"bambin|bambini|kids|children|museo\\s?dei\\s?bambini|science\\s?center|planetari|planetarium",i];

  // parchi/giardini (solo con nome)
  nwr(area.R)["leisure"="park"]["name"];
  nwr(area.R)["leisure"="garden"]["name"];

  // playground (anche senza nome)
  nwr(area.R)["leisure"="playground"];

  // piscine (molto richieste)
  nwr(area.R)["leisure"="swimming_pool"];
  nwr(area.R)["amenity"="swimming_pool"];
);

out tags center;
`.trim();
}

function mapElToPlace(el, regionSlug, regionIso) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    id: `poi_family_${regionSlug}_${el.type}_${el.id}`,
    name: String(name).trim(),
    lat,
    lon,
    type: "family",
    primary_category: "family",
    visibility: "classica",
    score: 0,
    tags: Object.entries(tags).slice(0, 50).map(([k,v]) => `${k}=${v}`),
    country: "IT",
    area: regionSlug,
    region_iso: regionIso,
    source: "overpass_region_build",
    live: false,
  };
}

function dedup(places) {
  const seen = new Set();
  const out = [];
  for (const p of places) {
    const k = `${normName(p.name)}_${String(p.lat).slice(0,6)}_${String(p.lon).slice(0,6)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

function scoreFamily(p) {
  const n = normName(p.name || "");
  const tagsStr = (p.tags || []).join(" ").toLowerCase();
  let s = 0;

  if (tagsStr.includes("tourism=theme_park")) s += 90;
  if (tagsStr.includes("leisure=water_park")) s += 85;
  if (tagsStr.includes("tourism=zoo") || tagsStr.includes("tourism=aquarium")) s += 80;
  if (tagsStr.includes("leisure=swimming_pool") || tagsStr.includes("amenity=swimming_pool")) s += 65;
  if (tagsStr.includes("leisure=playground")) s += 55;
  if (tagsStr.includes("leisure=park") || tagsStr.includes("leisure=garden")) s += 45;

  if (hasAny(n, ["parco avventura","zip line","safari","fattoria didattica","lunapark","acquapark","minigolf","kart"])) s += 35;

  return s;
}

async function runOverpass(query) {
  const body = opBody(query);
  let lastErr = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const j = await fetchWithTimeout(endpoint, body, 45000);
        return { ok: true, endpoint, json: j };
      } catch (e) {
        lastErr = e;
        await sleep(900 * attempt);
      }
    }
  }
  return { ok: false, endpoint: "", json: null, error: String(lastErr?.message || lastErr) };
}

async function main() {
  const regionSlug = String(process.env.REGION_SLUG || "").trim().toLowerCase();
  const regionIso  = String(process.env.REGION_ISO  || "").trim().toUpperCase();

  if (!regionSlug || !regionIso) {
    console.error("Missing REGION_SLUG or REGION_ISO. Example: REGION_SLUG=piemonte REGION_ISO=IT-21");
    process.exit(1);
  }

  const outDir = path.join(OUT_BASE, regionSlug);
  ensureDir(outDir);

  console.log(`🛰️ Build FAMILY for region: ${regionSlug} (${regionIso})`);

  const q = buildQuery(regionIso);
  const r = await runOverpass(q);

  if (!r.ok || !r.json) {
    console.error(`❌ Overpass failed: ${r.error || "unknown"}`);
    process.exit(1);
  }

  const els = Array.isArray(r.json.elements) ? r.json.elements : [];
  let mapped = dedup(els.map(el => mapElToPlace(el, regionSlug, regionIso)).filter(Boolean));
  mapped = mapped.filter(p => !isClearlyIrrelevant(p));

  mapped = mapped
    .map(p => {
      const sc = scoreFamily(p);
      return { ...p, score: sc, visibility: sc >= 70 ? "chicca" : "classica" };
    })
    .sort((a,b) => b.score - a.score)
    .slice(0, 12000);

  const meta = {
    built_at: nowIso(),
    category: "family",
    region_slug: regionSlug,
    region_iso: regionIso,
    endpoint: r.endpoint,
    count: mapped.length,
    ok: true,
  };

  const out = { meta, places: mapped };
  const outPath = path.join(outDir, "family.json");
  fs.writeFileSync(outPath, JSON.stringify(out), "utf8");

  console.log(`✅ DONE: ${mapped.length} items -> ${outPath}`);
}

main().catch((e) => {
  console.error("❌ build failed:", e);
  process.exit(1);
});
