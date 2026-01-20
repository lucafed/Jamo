/**
 * Jamo — build_events_all.mjs (ITALY + EUROPE, OFFLINE MASSIVE)
 * - NO fetch esterni (niente blocchi 403/410/405)
 * - Genera tanti eventi "plausibili" per città
 * Output: public/data/events/events_all.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// input cities (offline)
const CITIES_FILE = path.join(__dirname, "..", "public", "data", "events", "cities_it_eu_min.json");

// output
const OUT_DIR = path.join(__dirname, "..", "public", "data", "events");
const OUT_FILE = path.join(OUT_DIR, "events_all.json");

// tune
const DAYS_AHEAD = 90;         // aumenta a 180/365 quando vuoi
const EVENTS_PER_CITY = 12;    // aumenta a 30/60 se vuoi “tantissimi”

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function toISO(d) {
  return new Date(d).toISOString();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// “template” eventi plausibili (multi categoria)
const EVENT_TEMPLATES = [
  { category: "music",   title: (c) => `Concerto live – ${c.name}` },
  { category: "culture", title: (c) => `Mostra temporanea – ${c.name}` },
  { category: "culture", title: (c) => `Teatro / Spettacolo – ${c.name}` },
  { category: "local",   title: (c) => `Mercatino & sapori locali – ${c.name}` },
  { category: "local",   title: (c) => `Sagra / Festa di quartiere – ${c.name}` },
  { category: "family",  title: (c) => `Evento per famiglie – ${c.name}` },
  { category: "sport",   title: (c) => `Evento sportivo – ${c.name}` },
  { category: "night",   title: (c) => `Serata / Club – ${c.name}` }
];

function pickTemplate(i) {
  return EVENT_TEMPLATES[i % EVENT_TEMPLATES.length];
}

// crea una data/ora “carina”
function makeStart(baseDate, idx) {
  // distribuiamo su giorni diversi e orari vari
  const dayOffset = (idx * 3) % DAYS_AHEAD;
  const d = addDays(baseDate, dayOffset);

  // orari: 09:00, 11:00, 18:00, 21:00
  const hours = [9, 11, 18, 21];
  const h = hours[idx % hours.length];

  d.setUTCHours(h, 0, 0, 0);
  return d;
}

function makeEnd(start, idx) {
  const d = new Date(start);
  const durHours = [2, 3, 4, 6][idx % 4];
  d.setUTCHours(d.getUTCHours() + durHours);
  return d;
}

function buildEventsForCity(city, baseDate) {
  const out = [];
  for (let i = 0; i < EVENTS_PER_CITY; i++) {
    const t = pickTemplate(i);
    const start = makeStart(baseDate, i);
    const end = makeEnd(start, i);

    const id = `${city.country_code}_${slug(city.name)}_${t.category}_${pad2(i + 1)}`;

    out.push({
      id,
      title: t.title(city),
      start: toISO(start),
      end: toISO(end),
      lat: city.lat,
      lon: city.lon,
      place: city.name,
      city: city.name,
      region: city.region || null,
      country_code: city.country_code,
      category: t.category,
      source: "seed_massive"
    });
  }
  return out;
}

function main() {
  ensureDir(OUT_DIR);

  if (!fs.existsSync(CITIES_FILE)) {
    throw new Error(`Missing cities file: ${CITIES_FILE}`);
  }

  const citiesDoc = loadJSON(CITIES_FILE);
  const cities = Array.isArray(citiesDoc.cities) ? citiesDoc.cities : [];

  const base = new Date();
  const events = [];

  for (const c of cities) {
    if (!c?.name || typeof c.lat !== "number" || typeof c.lon !== "number" || !c.country_code) continue;
    events.push(...buildEventsForCity(c, base));
  }

  const dataset = {
    updated_at: new Date().toISOString(),
    count: events.length,
    days_ahead: DAYS_AHEAD,
    events
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(dataset, null, 2), "utf8");

  console.log("✔ Wrote", OUT_FILE);
  console.log("✔ Cities:", cities.length);
  console.log("✔ Events:", dataset.count);
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error("✖ build_events_all failed:", e?.message || e);
  process.exit(1);
}
