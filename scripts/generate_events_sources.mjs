// scripts/generate_events_sources.mjs
// Generate events_sources.generated.json from data/events/feeds_catalog.json
// Node >= 20, type: module

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const CATALOG_PATH = path.join(ROOT, "data", "events", "feeds_catalog.json");
const OUT_PATH = path.join(ROOT, "events_sources.generated.json");

function readJSON(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function norm(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function asNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function pickCategory(cat) {
  const c = String(cat || "").trim().toLowerCase();
  const allowed = new Set(["family", "sport", "culture", "music", "food", "market", "outdoor", "other"]);
  return allowed.has(c) ? c : "other";
}

function buildSource(entry, { ccFallback, defaultRegionFallback }) {
  const type = String(entry.type || "").toLowerCase().trim();
  if (type !== "rss" && type !== "ics") return null;

  const url = String(entry.url || "").trim();
  if (!url || url.includes("INCOLLA_QUI")) return null;

  const idBase =
    entry.id ||
    [
      entry.scope || "src",
      entry.cc || ccFallback || "",
      entry.city || entry.place || entry.region || entry.default_place || "",
      entry.category || "",
      type,
    ]
      .map(norm)
      .filter(Boolean)
      .join("_");

  const fixed_lat = asNum(entry.fixed_lat);
  const fixed_lon = asNum(entry.fixed_lon);

  const src = {
    id: idBase || `src_${Math.random().toString(16).slice(2)}`,
    type,
    url,
    default_region: String(entry.default_region || defaultRegionFallback || "").trim(),
    default_place: String(entry.default_place || entry.city || entry.place || "").trim(),
    category: pickCategory(entry.category),
    country_code: String(entry.cc || ccFallback || "").toUpperCase()
  };

  if (fixed_lat != null) src.fixed_lat = fixed_lat;
  if (fixed_lon != null) src.fixed_lon = fixed_lon;

  return src;
}

function main() {
  const catalog = readJSON(CATALOG_PATH, null);
  if (!catalog) {
    console.error(`❌ Missing catalog: ${CATALOG_PATH}`);
    process.exit(2);
  }

  const days_ahead = Number(catalog.days_ahead || 60);
  const max_events = Number(catalog.max_events || 30000);

  const providers = {
    osm_overpass: {
      enabled: !!(catalog.providers?.osm_overpass?.enabled ?? true),
      timeout_ms: Number(catalog.providers?.osm_overpass?.timeout_ms || 45000)
    }
  };

  const coverage = {
    italy: {
      enabled: !!(catalog.coverage?.italy?.enabled ?? true),
      cities: Array.isArray(catalog.coverage?.italy?.cities) ? catalog.coverage.italy.cities : []
    },
    europe: {
      enabled: !!(catalog.coverage?.europe?.enabled ?? false),
      cities: Array.isArray(catalog.coverage?.europe?.cities) ? catalog.coverage.europe.cities : []
    }
  };

  const rss_ics_sources = [];
  const items = Array.isArray(catalog.sources) ? catalog.sources : [];

  for (const entry of items) {
    const scope = String(entry.scope || "").toLowerCase();
    const ccFallback = String(entry.cc || "").toUpperCase();

    const defaultRegionFallback =
      scope === "italy" ? "Italia" : scope === "europe" ? "EU" : (entry.default_region || "");

    const src = buildSource(entry, { ccFallback, defaultRegionFallback });
    if (src) rss_ics_sources.push(src);
  }

  const out = {
    days_ahead,
    max_events,
    providers,
    coverage,
    rss_ics_sources,
    generated_at: new Date().toISOString(),
    catalog_path: "data/events/feeds_catalog.json"
  };

  writeJSON(OUT_PATH, out);

  console.log(`✅ Generated: ${path.relative(ROOT, OUT_PATH)}`);
  console.log(`   sources: ${rss_ics_sources.length}`);
  console.log(`   overpass IT cities: ${coverage.italy.cities.length}`);
  console.log(`   overpass EU cities: ${coverage.europe.cities.length}`);
}

main();
