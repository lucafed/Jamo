/**
 * Jamo — build_events_all.mjs (OFFLINE • IT + EU • MASSIVE)
 * Output: public/data/events/events_all.json
 *
 * ✅ NO API
 * ✅ NO fetch esterni
 * ✅ Tantissime città (da cities_it_eu_min.json)
 * ✅ Titoli + venue più credibili
 * ✅ url di ricerca per capire l’evento
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CITIES_FILE = path.join(__dirname, "..", "public", "data", "events", "cities_it_eu_min.json");
const OUT_DIR = path.join(__dirname, "..", "public", "data", "events");
const OUT_FILE = path.join(OUT_DIR, "events_all.json");

// ---- TUNE QUI ----
const DAYS_AHEAD = 180;          // 90 / 180 / 365
const EVENTS_PER_CITY = 30;      // 12 / 24 / 30 / 60

// Titoli “più umani”
const EVENT_TYPES = [
  { category: "music",   base: ["Concerto live", "Live session", "Festival musicale", "Tribute night"] },
  { category: "culture", base: ["Mostra temporanea", "Teatro & spettacolo", "Musei in serata", "Visita guidata"] },
  { category: "local",   base: ["Mercatino locale", "Street food & sapori", "Sagra di quartiere", "Fiera cittadina"] },
  { category: "family",  base: ["Evento per famiglie", "Laboratorio bambini", "Family day", "Parco & attività"] },
  { category: "sport",   base: ["Evento sportivo", "Gara/torneo", "Corsa cittadina", "Match amichevole"] },
  { category: "night",   base: ["Serata club", "DJ set", "Night event", "Aperitivo + musica"] }
];

// Venue “generiche” ma sensate
const VENUE_HINTS = [
  "Centro storico", "Teatro principale", "Piazza centrale", "Palazzetto", "Arena/Stadio",
  "Museo", "Parco cittadino", "Lungomare", "Centro congressi", "Club"
];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function toISO(d) {
  return new Date(d).toISOString();
}

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function pick(arr, i) {
  return arr[i % arr.length];
}

function makeStart(baseDate, idx) {
  // distribuzione su giorni e orari “realistici”
  const dayOffset = (idx * 2 + (idx % 7)) % DAYS_AHEAD;
  const d = addDays(baseDate, dayOffset);
  const hours = [9, 11, 17, 18, 20, 21];
  const h = hours[idx % hours.length];
  d.setUTCHours(h, 0, 0, 0);
  return d;
}

function makeEnd(start, idx) {
  const d = new Date(start);
  const durHours = [2, 3, 4, 5][idx % 4];
  d.setUTCHours(d.getUTCHours() + durHours);
  return d;
}

function googleSearchUrl(q) {
  // URL semplice, senza dipendenze
  const enc = encodeURIComponent(q);
  return `https://www.google.com/search?q=${enc}`;
}

function buildEventsForCity(city, baseDate) {
  const out = [];
  for (let i = 0; i < EVENTS_PER_CITY; i++) {
    const type = EVENT_TYPES[i % EVENT_TYPES.length];
    const titleBase = pick(type.base, i);
    const venue = `${pick(VENUE_HINTS, i)} — ${city.name}`;
    const title = `${titleBase} — ${city.name}`;

    const start = makeStart(baseDate, i);
    const end = makeEnd(start, i);

    const id = `${city.country_code}_${slug(city.name)}_${type.category}_${pad2(i + 1)}`;

    const query = `${titleBase} ${city.name} ${city.country_code}`;

    out.push({
      id,
      title,
      start: toISO(start),
      end: toISO(end),
      lat: city.lat,
      lon: city.lon,
      place: venue,
      city: city.name,
      region: city.region || null,
      country_code: city.country_code,
      category: type.category,
      url: googleSearchUrl(query),
      synthetic: true,
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
  const cities = Array.isArray(citiesDoc?.cities) ? citiesDoc.cities : [];

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
    events_per_city: EVENTS_PER_CITY,
    cities_count: cities.length,
    synthetic: true,
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
