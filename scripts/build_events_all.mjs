/**
 * Jamo — build_events_all.mjs (OFFLINE MASSIVE)
 * - NO API, NO fetch, NO external config
 * - Reads:  public/data/events/cities_it_eu_min.json
 * - Writes: public/data/events/events_all.json
 *
 * Note: eventi "plausibili" (synthetic=true) + link Google per capire l’evento
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------- PATHS --------------------
const CITIES_FILE = path.join(__dirname, "..", "public", "data", "events", "cities_it_eu_min.json");
const OUT_DIR = path.join(__dirname, "..", "public", "data", "events");
const OUT_FILE = path.join(OUT_DIR, "events_all.json");

// -------------------- TUNING --------------------
const DAYS_AHEAD = 120;        // 90/120/180/365
const EVENTS_PER_CITY = 12;    // 12/24/36/60

// -------------------- UTILS --------------------
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
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function googleSearchUrl(q) {
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

// -------------------- EVENT TEMPLATES --------------------
const EVENT_TEMPLATES = [
  { category: "music",   title: (c) => `Concerto live — ${c.name}` },
  { category: "culture", title: (c) => `Mostra temporanea — ${c.name}` },
  { category: "culture", title: (c) => `Teatro / Spettacolo — ${c.name}` },
  { category: "local",   title: (c) => `Mercatino & sapori locali — ${c.name}` },
  { category: "local",   title: (c) => `Sagra / Festa di quartiere — ${c.name}` },
  { category: "family",  title: (c) => `Evento per famiglie — ${c.name}` },
  { category: "sport",   title: (c) => `Evento sportivo — ${c.name}` },
  { category: "night",   title: (c) => `Serata / Club — ${c.name}` },
];

function pickTemplate(i) {
  return EVENT_TEMPLATES[i % EVENT_TEMPLATES.length];
}

// -------------------- DATE GENERATION --------------------
function makeStart(baseDate, idx) {
  const dayOffset = (idx * 3) % DAYS_AHEAD;
  const d = addDays(baseDate, dayOffset);

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

// -------------------- BUILD --------------------
function buildEventsForCity(city, baseDate) {
  const out = [];

  for (let i = 0; i < EVENTS_PER_CITY; i++) {
    const t = pickTemplate(i);
    const start = makeStart(baseDate, i);
    const end = makeEnd(start, i);

    const cc = String(city.country_code || "").toUpperCase();
    const citySlug = slug(city.name);
    const regionSlug = slug(city.region || "");

    // id stabile
    const id = `${cc}_${citySlug}${regionSlug ? "_" + regionSlug : ""}_${t.category}_${pad2(i + 1)}`;

    const title = t.title(city);

    out.push({
      id,
      title,
      start: toISO(start),
      end: toISO(end),
      lat: city.lat,
      lon: city.lon,
      place: city.name,
      city: city.name,
      region: city.region || null,
      country_code: cc,
      category: t.category,

      // 👇 importantissimo per UX: link per capire “che evento è”
      url: googleSearchUrl(`${title} ${city.name} ${cc}`),

      // 👇 segnala che NON è evento ufficiale
      synthetic: true,
      source: "seed_massive",
    });
  }

  return out;
}

function validateCity(c) {
  if (!c) return false;
  if (!c.name || typeof c.name !== "string") return false;
  if (typeof c.lat !== "number" || typeof c.lon !== "number") return false;
  if (!c.country_code || typeof c.country_code !== "string") return false;
  return true;
}

function main() {
  ensureDir(OUT_DIR);

  if (!fs.existsSync(CITIES_FILE)) {
    throw new Error(`Missing cities file: ${CITIES_FILE}`);
  }

  const doc = loadJSON(CITIES_FILE);
  const cities = Array.isArray(doc?.cities) ? doc.cities : [];

  const base = new Date();
  const events = [];

  let validCities = 0;

  for (const c of cities) {
    if (!validateCity(c)) continue;
    validCities++;
    events.push(...buildEventsForCity(c, base));
  }

  const dataset = {
    updated_at: new Date().toISOString(),
    count: events.length,
    days_ahead: DAYS_AHEAD,
    events_per_city: EVENTS_PER_CITY,
    cities_count: validCities,
    synthetic: true,
    events,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(dataset, null, 2), "utf8");

  console.log("✔ Wrote", OUT_FILE);
  console.log("✔ Cities (valid):", validCities);
  console.log("✔ Events:", dataset.count);
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error("✖ build_events_all failed:", e?.stack || e?.message || e);
  process.exit(1);
}
