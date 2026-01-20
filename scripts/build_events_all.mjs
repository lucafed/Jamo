/**
 * Jamo — build_events_all.mjs (ITALY + EUROPE, OFFLINE MASSIVE)
 *
 * ✅ NO fetch esterni (niente blocchi 403/410/405)
 * ✅ Genera tanti eventi "plausibili" per città
 * ✅ Supporta config: /configs/events.config.json
 * ✅ Tenta anche auto-discovery città da altri dataset offline se presenti
 *
 * Output: public/data/events/events_all.json
 *
 * Nota: questi eventi sono "synthetic" (seed). Per eventi reali serve un feed esterno.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- PATHS ----------
const ROOT = path.join(__dirname, "..");
const CONFIG_FILE = path.join(ROOT, "configs", "events.config.json");

// default cities file (fallback)
const DEFAULT_CITIES_FILE = path.join(
  ROOT,
  "public",
  "data",
  "events",
  "cities_it_eu_min.json"
);

// output
const OUT_DIR = path.join(ROOT, "public", "data", "events");
const OUT_FILE = path.join(OUT_DIR, "events_all.json");

// ---------- DEFAULT TUNING ----------
const DEFAULT_CFG = {
  days_ahead: 90,          // 180/365 quando vuoi
  events_per_city: 12,     // 30/60 quando vuoi “tantissimi”
  // Se vuoi limitare: ["IT","FR","DE"...]
  country_allowlist: null,
  // Se vuoi escludere: ["RU", ...]
  country_blocklist: null,
  // files addizionali da cui provare a leggere città (oltre al default)
  city_sources: [
    "public/data/events/cities_it_eu_min.json"
  ],
  // auto-discovery: prova anche questi se esistono
  autodiscover_sources: [
    "public/data/places/places_index.json",
    "public/data/pois/places_index.json",
    "public/data/pois/pois_index.json",
    "public/data/pois/regions/it-regions-index.json",
    "public/data/pois/regions/it_regions_index.json",
    "public/data/places/places_it.json",
    "public/data/places/places_eu.json"
  ],
  // coordinate fallback (se una città non ha lat/lon, viene saltata)
  require_coords: true
};

// ---------- HELPERS ----------
function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}
function ensureDir(dir) {
  if (!exists(dir)) fs.mkdirSync(dir, { recursive: true });
}
function readText(p) {
  return fs.readFileSync(p, "utf8");
}
function loadJSON(p) {
  return JSON.parse(readText(p));
}
function safeLoadJSON(p) {
  try { return loadJSON(p); } catch { return null; }
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
    .replace(/[\u0300-\u036f]/g, "")      // remove accents
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
function clampStr(x, max = 140) {
  const s = String(x ?? "");
  return s.length > max ? s.slice(0, max) : s;
}
function googleSearchUrl(q) {
  const qs = encodeURIComponent(q);
  return `https://www.google.com/search?q=${qs}`;
}
function uniqKeyCity(c) {
  // chiave città: paese + nome + (region se presente)
  return [
    (c.country_code || "").toUpperCase(),
    slug(c.name),
    slug(c.region || "")
  ].join("|");
}

// ---------- EVENT TEMPLATES ----------
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
function makeStart(baseDate, idx, daysAhead) {
  const dayOffset = (idx * 3) % Math.max(1, daysAhead);
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

// ---------- CITY NORMALIZER ----------
function normalizeCity(raw) {
  if (!raw) return null;

  const name = raw.name || raw.city || raw.town || raw.label || raw.title;
  const country_code = (raw.country_code || raw.country || raw.cc || "").toUpperCase();

  // lat/lon in vari formati
  const lat =
    typeof raw.lat === "number" ? raw.lat :
    typeof raw.latitude === "number" ? raw.latitude :
    (typeof raw.lat === "string" ? Number(raw.lat) : NaN);

  const lon =
    typeof raw.lon === "number" ? raw.lon :
    typeof raw.lng === "number" ? raw.lng :
    typeof raw.longitude === "number" ? raw.longitude :
    (typeof raw.lon === "string" ? Number(raw.lon) : NaN);

  const region = raw.region || raw.state || raw.admin1 || raw.province || null;

  if (!name || !country_code) return null;

  return {
    name: clampStr(name, 80),
    region: region ? clampStr(region, 80) : null,
    country_code,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null
  };
}

// ---------- CITY LOADERS ----------
function extractCitiesFromDoc(doc) {
  // supporta vari shape:
  // { cities: [...] } oppure [...] oppure { items: [...] } ecc.
  if (!doc) return [];
  if (Array.isArray(doc)) return doc;
  if (Array.isArray(doc.cities)) return doc.cities;
  if (Array.isArray(doc.items)) return doc.items;
  if (Array.isArray(doc.places)) return doc.places;
  if (Array.isArray(doc.data)) return doc.data;
  return [];
}

function loadCitiesFromFile(absPath) {
  const doc = safeLoadJSON(absPath);
  const arr = extractCitiesFromDoc(doc);
  const out = [];
  for (const x of arr) {
    const c = normalizeCity(x);
    if (c) out.push(c);
  }
  return out;
}

function autodiscoverCities(cfg) {
  // prova a leggere file "place-like" e ricavare città
  const out = [];
  for (const rel of cfg.autodiscover_sources || []) {
    const abs = path.join(ROOT, rel);
    if (!exists(abs)) continue;

    const doc = safeLoadJSON(abs);
    if (!doc) continue;

    const arr = extractCitiesFromDoc(doc);

    // Heuristics: se sono POI/places, tentiamo di estrarre "city" o "name"
    for (const x of arr) {
      const rawCity =
        x.city ? { name: x.city, country_code: x.country_code || x.country, region: x.region, lat: x.lat, lon: x.lon } :
        x.town ? { name: x.town, country_code: x.country_code || x.country, region: x.region, lat: x.lat, lon: x.lon } :
        x.name && (x.kind === "city" || x.type === "city") ? x :
        null;

      const c = normalizeCity(rawCity);
      if (c) out.push(c);
    }
  }
  return out;
}

function applyCountryFilters(cities, cfg) {
  const allow = Array.isArray(cfg.country_allowlist) ? cfg.country_allowlist.map(s => String(s).toUpperCase()) : null;
  const block = Array.isArray(cfg.country_blocklist) ? cfg.country_blocklist.map(s => String(s).toUpperCase()) : null;

  return cities.filter(c => {
    if (!c.country_code) return false;
    if (allow && !allow.includes(c.country_code)) return false;
    if (block && block.includes(c.country_code)) return false;
    return true;
  });
}

function dedupCities(cities, requireCoords) {
  const seen = new Set();
  const out = [];
  for (const c of cities) {
    if (requireCoords && (!Number.isFinite(c.lat) || !Number.isFinite(c.lon))) continue;
    const k = uniqKeyCity(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

// ---------- EVENTS ----------
function buildEventsForCity(city, baseDate, cfg) {
  const out = [];
  const daysAhead = Number(cfg.days_ahead || DEFAULT_CFG.days_ahead);
  const perCity = Number(cfg.events_per_city || DEFAULT_CFG.events_per_city);

  for (let i = 0; i < perCity; i++) {
    const t = pickTemplate(i);
    const start = makeStart(baseDate, i, daysAhead);
    const end = makeEnd(start, i);

    const id = `${city.country_code}_${slug(city.name)}_${slug(city.region || "")}_${t.category}_${pad2(i + 1)}`.replace(/__+/g, "_");

    const title = t.title(city);

    // link: google search dell’evento (utile subito)
    const url = googleSearchUrl(`${title} ${city.name} ${city.country_code}`);

    out.push({
      id,
      title,
      start: toISO(start),
      end: toISO(end),
      lat: city.lat,
      lon: city.lon,
      place: city.name,
      city: city.name,
      region: city.region,
      country_code: city.country_code,
      category: t.category,
      url,
      synthetic: true,            // ✅ trasparenza: non sono eventi reali
      source: "seed_massive"
    });
  }
  return out;
}

function dedupEvents(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    const k = e.id || `${slug(e.title)}|${e.start}|${e.city}|${e.country_code}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

// ---------- CONFIG ----------
function loadConfig() {
  if (!exists(CONFIG_FILE)) return { ...DEFAULT_CFG };

  const doc = safeLoadJSON(CONFIG_FILE);
  if (!doc || typeof doc !== "object") return { ...DEFAULT_CFG };

  return {
    ...DEFAULT_CFG,
    ...doc
  };
}

// ---------- MAIN ----------
function main() {
  ensureDir(OUT_DIR);

  const cfg = loadConfig();

  // 1) carica città da sources (config o default)
  const sourceList = Array.isArray(cfg.city_sources) && cfg.city_sources.length
    ? cfg.city_sources
    : [ "public/data/events/cities_it_eu_min.json" ];

  let cities = [];
  for (const rel of sourceList) {
    const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    if (!exists(abs)) {
      console.warn("⚠ Missing city source:", rel);
      continue;
    }
    const loaded = loadCitiesFromFile(abs);
    cities.push(...loaded);
  }

  // fallback hard al tuo file originale se config era vuota
  if (cities.length === 0 && exists(DEFAULT_CITIES_FILE)) {
    cities = loadCitiesFromFile(DEFAULT_CITIES_FILE);
  }

  // 2) autodiscovery (se attivo)
  const auto = autodiscoverCities(cfg);
  if (auto.length) cities.push(...auto);

  // 3) filtri + dedup
  cities = applyCountryFilters(cities, cfg);
  cities = dedupCities(cities, cfg.require_coords !== false);

  if (cities.length === 0) {
    throw new Error("No cities loaded. Check configs/events.config.json and city sources.");
  }

  // 4) genera eventi
  const base = new Date();
  let events = [];
  for (const c of cities) {
    events.push(...buildEventsForCity(c, base, cfg));
  }
  events = dedupEvents(events);

  const dataset = {
    updated_at: new Date().toISOString(),
    count: events.length,
    days_ahead: Number(cfg.days_ahead || DEFAULT_CFG.days_ahead),
    events_per_city: Number(cfg.events_per_city || DEFAULT_CFG.events_per_city),
    cities_count: cities.length,
    synthetic: true,
    events
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(dataset, null, 2), "utf8");

  console.log("✔ Wrote", OUT_FILE);
  console.log("✔ Cities:", cities.length);
  console.log("✔ Events:", dataset.count);
  console.log("✔ Synthetic:", dataset.synthetic);
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error("✖ build_events_all failed:", e?.message || e);
  process.exit(1);
}
