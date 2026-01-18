// scripts/generate_events_sources.mjs
// Generate events_sources.generated.json from data/events/feeds_catalog.json
// - IT + EU structure once-and-for-all
// - You only update the catalog, not the code.
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
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
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

// Build one source record that matches your build_events_all.mjs expectations
function buildSource(entry, { ccFallback, defaultRegionFallback }) {
  const type = String(entry.type || "").toLowerCase();
  if (type !== "rss" && type !== "ics") return null;

  const url = String(entry.url || "").trim();
  if (!url) return null;

  // avoid placeholders
  if (url.includes("INCOLLA_QUI")) return null;

  const idBase =
    entry.id ||
    [
      entry.scope || "src",
      entry.cc || ccFallback || "",
      entry.city || entry.place || entry.region || "",
      entry.category || "",
      type,
    ]
      .map(norm)
      .filter(Boolean)
      .join("_");

  const fixed_lat = asNum(entry.fixed_lat);
  const fixed_lon = asNum(entry.fixed_lon);

  // Note: your builder can geocode if fixed_lat/lon missing but it will be slow and may rate-limit.
  // So we prefer fixed coords whenever possible in the catalog.
  const src = {
    id: idBase || `src_${Math.random().toString(16).slice(2)}`,
    type,
    url,

    // Used by your builder
    default_region: String(entry.default_region || defaultRegionFallback || "").trim(),
    default_place: String(entry.default_place || entry.city || entry.place || "").trim(),
    category: pickCategory(entry.category),

    // Optional but recommended
    country_code: String(entry.cc || ccFallback || "").toUpperCase(),
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

  // Providers block: keep compatible with your build_events_all.mjs
  // We enable Overpass by default (no API key). You can disable from catalog.
  const providers = {
    osm_overpass: {
      enabled: !!(catalog.providers?.osm_overpass?.enabled ?? true),
      timeout_ms: Number(catalog.providers?.osm_overpass?.timeout_ms || 30000),
      // optional fallback endpoints list (your builder uses OVERPASS_ENDPOINT env,
      // but we keep this here for future extensions)
    },
  };

  // Coverage: cities list for Overpass (fast-ish, no API key, but not always reliable)
  const coverage = {
    italy: {
      enabled: !!(catalog.coverage?.italy?.enabled ?? true),
      cities: Array.isArray(catalog.coverage?.italy?.cities) ? catalog.coverage.italy.cities : [],
    },
    europe: {
      enabled: !!(catalog.coverage?.europe?.enabled ?? true),
      cities: Array.isArray(catalog.coverage?.europe?.cities) ? catalog.coverage.europe.cities : [],
    },
  };

  // RSS/ICS sources list
  const rss_ics_sources = [];
  const items = Array.isArray(catalog.sources) ? catalog.sources : [];

  for (const entry of items) {
    const scope = String(entry.scope || "").toLowerCase(); // "italy" | "europe" | ...
    const ccFallback = String(entry.cc || "").toUpperCase();

    const defaultRegionFallback =
      scope === "italy" ? "Italia" : scope === "europe" ? "EU" : (entry.default_region || "");

    const src = buildSource(entry, {
      ccFallback,
      defaultRegionFallback,
    });

    if (src) rss_ics_sources.push(src);
  }

  // Output
  const out = {
    // Keep the format expected by build_events_all.mjs
    days_ahead,
    max_events,
    providers,
    coverage,
    rss_ics_sources,
    generated_at: new Date().toISOString(),
    catalog_path: "data/events/feeds_catalog.json",
  };

  writeJSON(OUT_PATH, out);

  console.log(`✅ Generated: ${path.relative(ROOT, OUT_PATH)}`);
  console.log(`   sources: ${rss_ics_sources.length}`);
  console.log(`   overpass IT cities: ${coverage.italy.cities.length}`);
  console.log(`   overpass EU cities: ${coverage.europe.cities.length}`);
}

main();
