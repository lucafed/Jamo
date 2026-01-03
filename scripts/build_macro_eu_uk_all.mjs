// scripts/build_macro_eu_uk_all.mjs
// Build EU+UK macros from:
// - public/data/places_index_eu_uk.json
// Output:
// - public/data/macros/euuk_macro_all.json                 (EU+UK combined)
// - public/data/macros/euuk_country_<CC>.json              (one per country, CC=IT/FR/ES/.../UK)
// - public/data/macros/macros_index.json                   (auto-updated / merged)
// Usage:
//   node scripts/build_macro_eu_uk_all.mjs
//
// Node 18+ / 20 OK (ESM .mjs)

import fs from "fs";
import path from "path";

const ROOT = process.cwd();

const IN_PLACES = path.join(ROOT, "public", "data", "places_index_eu_uk.json");
const OUT_DIR = path.join(ROOT, "public", "data", "macros");
const OUT_ALL = path.join(OUT_DIR, "euuk_macro_all.json");
const OUT_INDEX = path.join(OUT_DIR, "macros_index.json");

// -------------------- helpers --------------------
function readJson(p) {
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}
function writeJsonCompact(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj), "utf8");
}
function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const BAD_NAME_PATTERNS = [
  "nucleo industriale",
  "zona industriale",
  "area industriale",
  "interporto",
  "autostrada",
  "uscita",
  "casello",
  "stazione di servizio",
  "distributore",
  "parcheggio",
  "deposito",
  "magazzino",
  "capannone",
  "scalo",
  "svincolo",
  "cimitero",
  "ospedale",
  "tribunale",
  "via ",
  "viale ",
  "piazza ",
];

function isBadName(name) {
  const n = norm(name);
  if (!n) return true;
  for (const p of BAD_NAME_PATTERNS) {
    if (n.startsWith("via ") || n.startsWith("viale ") || n.startsWith("piazza ")) return true;
    if (n.includes(p)) return true;
  }
  return false;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// “turisticità” offline: mix di pop + type + euristiche sul nome
function computeTourismScore(p) {
  const pop = Number(p.population || 0) || 0;
  const type = norm(p.type);
  const name = norm(p.name);

  let s = 0;

  // popolazione (log scale)
  // pop 2k->~0.2, 20k->~0.4, 200k->~0.6, 2M->~0.8
  const lp = Math.log10(1 + pop);
  s += clamp((lp - 3.3) / 2.0, 0, 1) * 0.60;

  // type boost
  if (type === "citta" || type === "città" || type === "city") s += 0.18;
  if (type === "borgo" || type === "village") s += 0.10;

  // name heuristics
  if (name.includes("old town") || name.includes("historic") || name.includes("saint") || name.includes("san ")) s += 0.03;
  if (name.includes("beach") || name.includes("plage") || name.includes("strand")) s += 0.03;
  if (name.includes("lake") || name.includes("lago") || name.includes("lac")) s += 0.03;
  if (name.includes("mount") || name.includes("monte") || name.includes("berg")) s += 0.03;

  // visibility boost
  const vis = norm(p.visibility);
  if (vis === "conosciuta") s += 0.05;
  if (vis === "chicca") s += 0.03;

  return clamp(s, 0, 1);
}

// Tags base: qui sono “generici” perché places_index è grezzo.
// (Le macro regionali tipo Abruzzo hanno tags molto più ricchi.)
function baseTags(p) {
  const tags = new Set([norm(p.visibility || "")].filter(Boolean));
  const t = norm(p.type);
  if (t) tags.add(t);
  const n = norm(p.name);
  if (n.includes("beach") || n.includes("plage") || n.includes("strand")) tags.add("mare");
  if (n.includes("lake") || n.includes("lago") || n.includes("lac")) tags.add("lago");
  if (n.includes("mount") || n.includes("monte") || n.includes("berg")) tags.add("montagna");
  return [...tags].filter(Boolean).slice(0, 12);
}

function macroHeader({ id, name, scope, country, label }) {
  return {
    id,
    name,
    version: "1.0.0",
    updated_at: new Date().toISOString().slice(0, 10),
    scope,               // "country" | "euuk"
    country: country || "EUUK",
    label: label || name,
    rules: {
      mode: "car_only",
      offline_and_stable: true,
    },
    schema: {
      place_fields: ["id", "name", "type", "area", "country", "lat", "lon", "tags", "visibility", "beauty_score", "why"],
    },
    places: [],
  };
}

// -------------------- main --------------------
function main() {
  if (!fs.existsSync(IN_PLACES)) {
    console.error("Missing:", IN_PLACES);
    process.exit(1);
  }

  const src = readJson(IN_PLACES);
  const places = Array.isArray(src?.places) ? src.places : [];

  // normalize / filter
  const cleaned = [];
  for (const p of places) {
    if (!p?.name) continue;
    if (isBadName(p.name)) continue;

    const lat = Number(p.lat);
    const lon = Number(p.lng ?? p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    // country normalization
    let cc = String(p.country || "").toUpperCase();
    if (cc === "GB") cc = "UK";

    if (!cc) continue;

    const pop = Number(p.population || 0) || 0;
    if (pop < 1500) continue; // elimina micro-frazioni

    const score = computeTourismScore({ ...p, country: cc });
    cleaned.push({
      ...p,
      country: cc,
      lat,
      lon,
      population: pop,
      _tourism: score,
    });
  }

  // group by country
  const byCountry = new Map();
  for (const p of cleaned) {
    const cc = p.country;
    if (!byCountry.has(cc)) byCountry.set(cc, []);
    byCountry.get(cc).push(p);
  }

  // build per-country macros
  const countryMacros = [];
  for (const [cc, arr] of byCountry.entries()) {
    // order by tourism score then population
    arr.sort((a, b) => (b._tourism - a._tourism) || ((b.population || 0) - (a.population || 0)));

    // keep a LOT, but not insane (file size / performance)
    // You can raise later. This already gives you "tantissimi posti".
    const MAX = 2500; // per country cap
    const take = arr.slice(0, MAX);

    const m = macroHeader({
      id: `euuk_country_${cc.toLowerCase()}`,
      name: `EU/UK — ${cc} — Destinazioni (offline)`,
      scope: "country",
      country: cc,
      label: `${cc} (offline)`,
    });

    m.places = take.map((p) => ({
      id: String(p.id || `gn_${p.geonameid || ""}` || `p_${norm(p.name).replace(/\s+/g, "_")}`),
      name: String(p.name),
      type: String(p.type || "citta"),
      area: String(p.admin1 || p.region || p.country || cc),
      country: cc,
      lat: Number(p.lat),
      lon: Number(p.lon),
      tags: baseTags(p),
      visibility: String(p.visibility || "conosciuta"),
      // beauty_score: usa tourism score come proxy stabile
      beauty_score: Number(clamp(p._tourism * 0.35 + 0.65, 0.65, 1.0).toFixed(2)),
      why: [
        "Meta selezionata automaticamente (offline).",
        "Apri 'Cosa vedere' e 'Foto' per ispirarti subito.",
      ],
    }));

    const outPath = path.join(OUT_DIR, `euuk_country_${cc.toLowerCase()}.json`);
    writeJsonCompact(outPath, m);
    countryMacros.push({ cc, path: `/data/macros/euuk_country_${cc.toLowerCase()}.json`, id: m.id, label: `${cc} (offline)`, scope: "country", country: cc });
  }

  // build EU+UK combined macro (big but manageable)
  // keep top N overall
  cleaned.sort((a, b) => (b._tourism - a._tourism) || ((b.population || 0) - (a.population || 0)));
  const MAX_ALL = 14000; // cap total (keep app fast)
  const topAll = cleaned.slice(0, MAX_ALL);

  const all = macroHeader({
    id: "euuk_macro_all",
    name: "EU+UK — Tutte le destinazioni (offline)",
    scope: "euuk",
    country: "EUUK",
    label: "EU+UK (offline)",
  });

  all.places = topAll.map((p) => ({
    id: String(p.id || `gn_${p.geonameid || ""}` || `p_${norm(p.name).replace(/\s+/g, "_")}`),
    name: String(p.name),
    type: String(p.type || "citta"),
    area: String(p.admin1 || p.region || p.country),
    country: String(p.country),
    lat: Number(p.lat),
    lon: Number(p.lon),
    tags: baseTags(p),
    visibility: String(p.visibility || "conosciuta"),
    beauty_score: Number(clamp(p._tourism * 0.35 + 0.65, 0.65, 1.0).toFixed(2)),
    why: [
      "Meta selezionata automaticamente (offline).",
      "Apri 'Cosa vedere' e 'Foto' per ispirarti subito.",
    ],
  }));

  writeJsonCompact(OUT_ALL, all);

  // update macros_index.json (merge)
  let idx = { version: "1.0.0", updated_at: new Date().toISOString().slice(0, 10), items: [] };
  if (fs.existsSync(OUT_INDEX)) {
    try {
      const prev = readJson(OUT_INDEX);
      if (prev?.items && Array.isArray(prev.items)) idx = prev;
    } catch {}
  }

  // remove old euuk entries
  idx.items = (idx.items || []).filter((x) => !String(x.id || "").startsWith("euuk_"));

  // add all + countries
  idx.items.push({
    id: "euuk_macro_all",
    label: "EU+UK (offline)",
    scope: "euuk",
    country: "EUUK",
    path: "/data/macros/euuk_macro_all.json",
  });

  for (const cm of countryMacros.sort((a, b) => a.cc.localeCompare(b.cc))) {
    idx.items.push({
      id: cm.id,
      label: cm.label,
      scope: cm.scope,
      country: cm.country,
      path: cm.path,
    });
  }

  idx.updated_at = new Date().toISOString().slice(0, 10);
  writeJsonCompact(OUT_INDEX, idx);

  console.log("✅ Built EU+UK macros.");
  console.log(" -", OUT_ALL);
  console.log(" - countries:", countryMacros.length);
  console.log("✅ Updated macros index:", OUT_INDEX);
}

main();
