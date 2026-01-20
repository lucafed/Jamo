/**
 * Jamo — build_events_all.mjs (OFFLINE, “REALISTIC-SEEDS”)
 * - NO API / NO fetch
 * - Genera eventi plausibili con titoli NON generici, venue più credibili, date più sensate
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

// TUNING (puoi cambiare)
const DAYS_AHEAD = 180;
const EVENTS_PER_CITY = 30;

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
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// --- Venues “credibili” per IT (fallback per EU) ---
const IT_VENUES_BY_CITY = {
  "Verona": ["Arena di Verona", "Teatro Filarmonico", "Teatro Romano", "Piazza Bra", "Piazza delle Erbe", "Castelvecchio"],
  "Roma": ["Auditorium Parco della Musica", "Teatro dell’Opera", "Foro Italico", "Trastevere", "MAXXI", "Piazza Navona"],
  "Milano": ["Teatro alla Scala", "Mediolanum Forum", "Triennale Milano", "Navigli", "Duomo", "Castello Sforzesco"],
  "Torino": ["Teatro Regio", "Pala Alpitour", "Museo Egizio", "Piazza Castello", "Lingotto", "Parco del Valentino"],
  "Venezia": ["Teatro La Fenice", "Arsenale", "Piazza San Marco", "Dorsoduro", "Giardini della Biennale", "Rialto"],
  "Napoli": ["Teatro San Carlo", "Lungomare Caracciolo", "Piazza del Plebiscito", "Museo Madre", "Vomero", "Castel dell’Ovo"],
  "Firenze": ["Teatro del Maggio", "Piazza della Signoria", "Palazzo Pitti", "Santa Croce", "Leopolda", "Uffizi"],
  "Bologna": ["Teatro Comunale", "Unipol Arena", "Piazza Maggiore", "FICO", "MAMbo", "Giardini Margherita"],
  "Genova": ["Porto Antico", "Teatro Carlo Felice", "Aquario", "Boccadasse", "Piazza De Ferrari", "Palazzo Ducale"]
};

const GENERIC_VENUES = ["Centro storico", "Teatro principale", "Piazza centrale", "Museo", "Arena/Stadio", "Parco cittadino"];

// --- “Vocabolario” per titoli realistici ---
const TITLE_BANK = {
  music: [
    "Concerto tributo {X}",
    "Live acustico: {X}",
    "Serata jazz: {X}",
    "Festival musicale: {X}"
  ],
  culture: [
    "Mostra: {X}",
    "Visita guidata speciale: {X}",
    "Apertura serale: {X}",
    "Teatro: {X}"
  ],
  local: [
    "Mercatino {X}",
    "Sagra {X}",
    "Fiera {X}",
    "Degustazione {X}"
  ],
  family: [
    "Laboratorio bambini: {X}",
    "Parco & attività: {X}",
    "Spettacolo per famiglie: {X}",
    "Caccia al tesoro: {X}"
  ],
  sport: [
    "Evento sportivo: {X}",
    "Corsa cittadina: {X}",
    "Torneo amatoriale: {X}",
    "Partita speciale: {X}"
  ],
  night: [
    "DJ set: {X}",
    "Serata club: {X}",
    "Party a tema: {X}",
    "Live + aftershow: {X}"
  ]
};

const TOPIC_BANK = [
  "in centro", "in Arena", "d’inverno", "del weekend", "al tramonto", "sotto le stelle",
  "con degustazione", "con guida", "special edition", "open air", "night session"
];

function pick(arr, i) {
  if (!arr || !arr.length) return null;
  return arr[i % arr.length];
}

function cityVenues(cityName) {
  const v = IT_VENUES_BY_CITY[cityName];
  return (v && v.length) ? v : GENERIC_VENUES;
}

// --- Date “credibili”: più weekend + orari serali ---
function makeStart(baseDate, idx) {
  // spingiamo verso weekend: usiamo offset e poi correggiamo al ven/sab/dom spesso
  let d = addDays(baseDate, (idx * 2) % DAYS_AHEAD);

  // porta verso weekend ~70% delle volte
  const day = d.getUTCDay(); // 0 dom, 5 ven, 6 sab
  const wantWeekend = (idx % 10) < 7;
  if (wantWeekend) {
    // se non è ven/sab/dom, spostalo al prossimo sabato
    if (![5, 6, 0].includes(day)) {
      const toSat = (6 - day + 7) % 7;
      d = addDays(d, toSat);
    }
  }

  // orari sensati per categoria
  const hoursBySlot = [10, 11, 16, 18, 19, 21];
  const h = hoursBySlot[idx % hoursBySlot.length];

  d.setUTCHours(h, 0, 0, 0);
  return d;
}

function makeEnd(start, idx) {
  const d = new Date(start);
  const durHours = [2, 2, 3, 3, 4, 5][idx % 6];
  d.setUTCHours(d.getUTCHours() + durHours);
  return d;
}

function buildTitle(category, city, idx) {
  const templates = TITLE_BANK[category] || ["Evento: {X}"];
  const t = pick(templates, idx);
  const topic = pick(TOPIC_BANK, idx + city.name.length);
  const venueHint = pick(cityVenues(city.name), idx + 2);

  // X = qualcosa che “sembra” un titolo
  const X = `${topic} — ${city.name}`;
  // alcuni template più “specifici”
  return t.replace("{X}", X).replace("{CITY}", city.name).replace("{VENUE}", venueHint);
}

function buildSubtitle(category, city, idx) {
  const venue = pick(cityVenues(city.name), idx);
  const bits = {
    music: `Live in ${venue}`,
    culture: `Evento culturale in ${venue}`,
    local: `Sapori & tradizioni in ${venue}`,
    family: `Per famiglie in ${venue}`,
    sport: `Sport & movimento in ${venue}`,
    night: `Nightlife in ${venue}`
  };
  return bits[category] || `Evento in ${venue}`;
}

function buildGoogleUrl(title, city) {
  const q = encodeURIComponent(`${title} ${city.name} ${city.country_code || ""}`.trim());
  return `https://www.google.com/search?q=${q}`;
}

const CATEGORIES = ["music", "culture", "local", "family", "sport", "night"];

function buildEventsForCity(city, baseDate) {
  const out = [];
  const venues = cityVenues(city.name);

  for (let i = 0; i < EVENTS_PER_CITY; i++) {
    const category = CATEGORIES[i % CATEGORIES.length];

    const start = makeStart(baseDate, i + city.name.length);
    const end = makeEnd(start, i);

    const title = buildTitle(category, city, i);
    const subtitle = buildSubtitle(category, city, i);
    const place = pick(venues, i + 1);

    const id = `${city.country_code}_${slug(city.name)}_${slug(city.region || "na")}_${category}_${pad2(i + 1)}`;

    out.push({
      id,
      title,
      subtitle,
      start: toISO(start),
      end: toISO(end),
      lat: city.lat,
      lon: city.lon,
      place,
      city: city.name,
      region: city.region || null,
      country_code: city.country_code,
      category,
      url: buildGoogleUrl(title, city),
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
  const cities = Array.isArray(citiesDoc.cities) ? citiesDoc.cities : [];

  const base = new Date();
  const events = [];

  for (const c of cities) {
    if (!c?.name || typeof c.lat !== "number" || typeof c.lon !== "number" || !c.country_code) continue;
    events.push(...buildEventsForCity(c, base));
  }

  // ordina per start
  events.sort((a, b) => String(a.start).localeCompare(String(b.start)));

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
