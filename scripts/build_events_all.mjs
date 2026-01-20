/**
 * Jamo — build_events_all.mjs
 * OFFLINE-FIRST • SAFE • NO FETCH BLOCCATI
 *
 * Produce:
 * public/data/events/events_all.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* -------------------- PATHS -------------------- */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUT_DIR = path.join(
  __dirname,
  "..",
  "public",
  "data",
  "events"
);

const OUT_FILE = path.join(OUT_DIR, "events_all.json");

/* -------------------- HELPERS -------------------- */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function iso(date) {
  return new Date(date).toISOString();
}

/* -------------------- SEED EVENTS --------------------
   Questi sono EVENTI REALI / PLAUSIBILI
   (servono come base, fallback e test UI)
---------------------------------------------------- */

const SEED_EVENTS = [
  {
    id: "verona_arena_lirica",
    title: "Arena di Verona – Stagione lirica",
    start: iso("2026-06-01T21:00:00"),
    end: iso("2026-06-01T23:30:00"),
    lat: 45.4386,
    lon: 10.9944,
    place: "Arena di Verona",
    city: "Verona",
    region: "Veneto",
    country_code: "IT",
    category: "music",
    source: "seed"
  },
  {
    id: "verona_teatro_romano",
    title: "Spettacoli estivi al Teatro Romano",
    start: iso("2026-07-01T21:00:00"),
    end: iso("2026-07-01T23:00:00"),
    lat: 45.4457,
    lon: 11.0027,
    place: "Teatro Romano",
    city: "Verona",
    region: "Veneto",
    country_code: "IT",
    category: "culture",
    source: "seed"
  },
  {
    id: "verona_piazza_erbe",
    title: "Mercato di Piazza delle Erbe",
    start: iso("2026-01-25T08:00:00"),
    end: iso("2026-01-25T18:00:00"),
    lat: 45.4424,
    lon: 10.9986,
    place: "Piazza delle Erbe",
    city: "Verona",
    region: "Veneto",
    country_code: "IT",
    category: "local",
    source: "seed"
  }
];

/* -------------------- MAIN -------------------- */

function buildDataset() {
  const now = new Date().toISOString();

  const dataset = {
    updated_at: now,
    count: SEED_EVENTS.length,
    days_ahead: 365,
    events: SEED_EVENTS
  };

  ensureDir(OUT_DIR);
  fs.writeFileSync(OUT_FILE, JSON.stringify(dataset, null, 2), "utf8");

  console.log("✔ Events dataset written:");
  console.log(`  → ${OUT_FILE}`);
  console.log(`  → events: ${dataset.count}`);
}

/* -------------------- RUN -------------------- */

try {
  buildDataset();
  process.exit(0);
} catch (err) {
  console.error("✖ build_events_all FAILED");
  console.error(err);
  process.exit(1);
}
