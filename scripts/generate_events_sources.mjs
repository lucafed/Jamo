#!/usr/bin/env node
/**
 * Jamo — generate_events_sources.mjs (v1.0)
 * Genera events_sources.generated.json (Verona-first), estendibile.
 *
 * - Output: /events_sources.generated.json
 * - Carica opzionale: /events_sources.extra.json (tu ci puoi mettere altre fonti senza toccare codice)
 */

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "events_sources.generated.json");
const EXTRA = path.join(ROOT, "events_sources.extra.json");

function safeReadJson(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function uniqBy(arr, keyFn) {
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const k = keyFn(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

// ✅ Verona center (fallback)
const VERONA = { lat: 45.4384, lon: 10.9916, city: "Verona", region: "Veneto", cc: "IT" };

// ⚠️ Qui mettiamo SOLO fonti “sicure” e già funzionanti nel tuo dataset.
// Poi aggiungiamo altre fonti da /events_sources.extra.json (tu le incolli lì).
const baseSources = [
  // ✅ La tua fonte attuale (Archivio di Stato Verona) — già produce eventi
  {
    id: "italy_it_verona_culture_ics",
    type: "ics",
    url: "https://archiviodistateverona.cultura.gov.it/?tribe_events_ical=1",
    country_code: "IT",
    default_place: "Verona",
    default_region: "Veneto",
    category: "culture",
    fixed_lat: VERONA.lat,
    fixed_lon: VERONA.lon
  }

  // 👉 QUI puoi aggiungere altre ICS/RSS “veronesi”
  // Esempio:
  // {
  //   id: "verona_xxx",
  //   type: "rss",
  //   url: "https://....rss",
  //   country_code: "IT",
  //   default_place: "Verona",
  //   default_region: "Veneto",
  //   category: "events",
  //   fixed_lat: VERONA.lat,
  //   fixed_lon: VERONA.lon
  // }
];

const extra = safeReadJson(EXTRA);
const extraSources = Array.isArray(extra?.rss_ics_sources) ? extra.rss_ics_sources : [];

const merged = uniqBy([...baseSources, ...extraSources], (x) => String(x?.id || x?.url || "").trim());

const out = {
  scope: "verona-first",
  days_ahead: 180,
  max_events: 50000,
  providers: {
    // usato dal build per timeouts, ecc.
    osm_overpass: { enabled: false, timeout_ms: 45000 }
  },
  rss_ics_sources: merged
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
console.log(`✅ Wrote ${path.relative(ROOT, OUT)} with ${merged.length} sources`);
if (!fs.existsSync(EXTRA)) {
  console.log("ℹ️ You can create events_sources.extra.json to add more Verona feeds without editing scripts.");
}
