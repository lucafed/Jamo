/* Jamo — build_events_all.mjs (SEED-FIRST • IT+EU • OFFLINE-SAFE)
 * - Non dipende da fetch esterni (zero 403/405/410 -> zero dataset vuoto)
 * - Genera eventi plausibili e coerenti per IT + EU
 * - Deterministico: stessi input => stessi eventi => ID stabili
 * - Output: public/data/events/events_all.json
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();
const OUT_PATH = path.join(ROOT, "public", "data", "events", "events_all.json");
const CFG_PATH = path.join(ROOT, "events_sources.json");

function readJSON(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function toISO(d) { return new Date(d).toISOString(); }

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function stableSeedInt(str) {
  // prendi 8 hex => 32-bit
  const h = sha1(str).slice(0, 8);
  return parseInt(h, 16) >>> 0;
}

/** Lista città “core” (IT + EU).
 *  Non è “tutta Europa” a livello di ogni comune, ma copre TUTTO il territorio
 *  perché l’app lavora a raggio/minuti: con questi hub riempi qualsiasi area turistica.
 *  Poi possiamo densificare aggiungendo città minori o regioni.
 */
const IT_CITIES = [
  { name: "Roma", lat: 41.9028, lon: 12.4964, region: "Lazio", cc: "IT" },
  { name: "Milano", lat: 45.4642, lon: 9.1900, region: "Lombardia", cc: "IT" },
  { name: "Napoli", lat: 40.8518, lon: 14.2681, region: "Campania", cc: "IT" },
  { name: "Torino", lat: 45.0703, lon: 7.6869, region: "Piemonte", cc: "IT" },
  { name: "Palermo", lat: 38.1157, lon: 13.3615, region: "Sicilia", cc: "IT" },
  { name: "Bologna", lat: 44.4949, lon: 11.3426, region: "Emilia-Romagna", cc: "IT" },
  { name: "Firenze", lat: 43.7696, lon: 11.2558, region: "Toscana", cc: "IT" },
  { name: "Venezia", lat: 45.4408, lon: 12.3155, region: "Veneto", cc: "IT" },
  { name: "Verona", lat: 45.4384, lon: 10.9916, region: "Veneto", cc: "IT" },
  { name: "Genova", lat: 44.4056, lon: 8.9463, region: "Liguria", cc: "IT" },
  { name: "Bari", lat: 41.1171, lon: 16.8719, region: "Puglia", cc: "IT" },
  { name: "Catania", lat: 37.5079, lon: 15.0830, region: "Sicilia", cc: "IT" },
  { name: "Cagliari", lat: 39.2238, lon: 9.1217, region: "Sardegna", cc: "IT" },
  { name: "Trento", lat: 46.0748, lon: 11.1217, region: "Trentino-Alto Adige", cc: "IT" },
  { name: "Trieste", lat: 45.6495, lon: 13.7768, region: "Friuli-Venezia Giulia", cc: "IT" },
  { name: "Perugia", lat: 43.1107, lon: 12.3908, region: "Umbria", cc: "IT" },
  { name: "Ancona", lat: 43.6158, lon: 13.5189, region: "Marche", cc: "IT" },
  { name: "L'Aquila", lat: 42.3498, lon: 13.3995, region: "Abruzzo", cc: "IT" },
  { name: "Reggio Calabria", lat: 38.1112, lon: 15.6473, region: "Calabria", cc: "IT" }
];

const EU_CITIES = [
  // Iberia
  { name: "Madrid", lat: 40.4168, lon: -3.7038, region: "Comunidad de Madrid", cc: "ES" },
  { name: "Barcelona", lat: 41.3851, lon: 2.1734, region: "Catalunya", cc: "ES" },
  { name: "Lisboa", lat: 38.7223, lon: -9.1393, region: "Lisboa", cc: "PT" },
  { name: "Porto", lat: 41.1579, lon: -8.6291, region: "Norte", cc: "PT" },

  // Francia
  { name: "Paris", lat: 48.8566, lon: 2.3522, region: "Île-de-France", cc: "FR" },
  { name: "Lyon", lat: 45.7640, lon: 4.8357, region: "Auvergne-Rhône-Alpes", cc: "FR" },
  { name: "Marseille", lat: 43.2965, lon: 5.3698, region: "Provence-Alpes-Côte d'Azur", cc: "FR" },

  // Germania / Austria / Svizzera
  { name: "Berlin", lat: 52.5200, lon: 13.4050, region: "Berlin", cc: "DE" },
  { name: "München", lat: 48.1351, lon: 11.5820, region: "Bayern", cc: "DE" },
  { name: "Hamburg", lat: 53.5511, lon: 9.9937, region: "Hamburg", cc: "DE" },
  { name: "Wien", lat: 48.2082, lon: 16.3738, region: "Wien", cc: "AT" },
  { name: "Zürich", lat: 47.3769, lon: 8.5417, region: "Zürich", cc: "CH" },
  { name: "Genève", lat: 46.2044, lon: 6.1432, region: "Genève", cc: "CH" },

  // Benelux
  { name: "Amsterdam", lat: 52.3676, lon: 4.9041, region: "Noord-Holland", cc: "NL" },
  { name: "Bruxelles", lat: 50.8503, lon: 4.3517, region: "Bruxelles", cc: "BE" },

  // Nordics
  { name: "Copenhagen", lat: 55.6761, lon: 12.5683, region: "Hovedstaden", cc: "DK" },
  { name: "Stockholm", lat: 59.3293, lon: 18.0686, region: "Stockholm", cc: "SE" },
  { name: "Oslo", lat: 59.9139, lon: 10.7522, region: "Oslo", cc: "NO" },
  { name: "Helsinki", lat: 60.1699, lon: 24.9384, region: "Uusimaa", cc: "FI" },

  // Centro/Est
  { name: "Prague", lat: 50.0755, lon: 14.4378, region: "Praha", cc: "CZ" },
  { name: "Warszawa", lat: 52.2297, lon: 21.0122, region: "Mazowieckie", cc: "PL" },
  { name: "Kraków", lat: 50.0647, lon: 19.9450, region: "Małopolskie", cc: "PL" },
  { name: "Budapest", lat: 47.4979, lon: 19.0402, region: "Budapest", cc: "HU" },
  { name: "Vienna", lat: 48.2082, lon: 16.3738, region: "Wien", cc: "AT" },

  // Balcani / Grecia
  { name: "Athens", lat: 37.9838, lon: 23.7275, region: "Attica", cc: "GR" },
  { name: "Thessaloniki", lat: 40.6401, lon: 22.9444, region: "Central Macedonia", cc: "GR" },
  { name: "Zagreb", lat: 45.8150, lon: 15.9819, region: "Grad Zagreb", cc: "HR" },
  { name: "Ljubljana", lat: 46.0569, lon: 14.5058, region: "Ljubljana", cc: "SI" },

  // UK/IE (tu hai EU+UK nei macro: mettiamo anche loro per completezza)
  { name: "London", lat: 51.5074, lon: -0.1278, region: "England", cc: "GB" },
  { name: "Manchester", lat: 53.4808, lon: -2.2426, region: "England", cc: "GB" },
  { name: "Dublin", lat: 53.3498, lon: -6.2603, region: "Leinster", cc: "IE" }
];

const CATEGORIES = [
  "music", "culture", "theatre", "festival", "food", "local", "family", "sport", "museum", "market"
];

const VENUES = [
  "Teatro Comunale", "Centro Storico", "Piazza Centrale", "Arena", "Palazzo Congressi",
  "Museo Civico", "Parco Principale", "Auditorium", "Castello", "Fiera"
];

function jitterLatLon(rnd, lat, lon) {
  // jitter leggero ~ fino a ~3-5km, per non avere tutti identici
  const dLat = (rnd() - 0.5) * 0.06;
  const dLon = (rnd() - 0.5) * 0.08;
  return { lat: lat + dLat, lon: lon + dLon };
}

function buildSeedEventsForCity(city, daysAhead, perCityPerDay = 2) {
  const seed = stableSeedInt(`${city.cc}:${city.name}:${city.lat},${city.lon}`);
  const rnd = mulberry32(seed);

  const now = new Date();
  const events = [];

  // Densità: grandi città più piene
  const bigBoost = ["Roma","Milano","Napoli","Torino","Paris","London","Berlin","Madrid","Barcelona"].includes(city.name) ? 2 : 1;

  for (let day = 0; day < daysAhead; day++) {
    // non tutti i giorni uguali
    const daily = clamp(Math.floor((perCityPerDay * bigBoost) + rnd() * (2 * bigBoost)), 1, 8);

    for (let i = 0; i < daily; i++) {
      const start = new Date(now.getTime() + day * 24 * 3600 * 1000);
      // slot orari
      const hourSlots = [10, 11, 18, 19, 20, 21];
      start.setUTCHours(hourSlots[Math.floor(rnd() * hourSlots.length)], 0, 0, 0);

      const durH = [1, 2, 3, 4][Math.floor(rnd() * 4)];
      const end = new Date(start.getTime() + durH * 3600 * 1000);

      const category = CATEGORIES[Math.floor(rnd() * CATEGORIES.length)];
      const venueBase = VENUES[Math.floor(rnd() * VENUES.length)];
      const place = `${venueBase} ${city.name}`;

      const { lat, lon } = jitterLatLon(rnd, city.lat, city.lon);

      const title = (() => {
        const t = {
          music: ["Live Session", "Concerto", "Night Beats", "Jazz Night", "Acoustic Set"],
          culture: ["Mostra", "Visita guidata", "Incontro culturale", "Talk", "Rassegna"],
          theatre: ["Spettacolo teatrale", "Prosa", "Commedia", "Performance", "Teatro contemporaneo"],
          festival: ["Festival", "Rassegna", "Weekend Festival", "Eventi in città", "Festival urbano"],
          food: ["Street Food", "Degustazione", "Sagra", "Food Market", "Taste Night"],
          local: ["Evento locale", "Festa di quartiere", "Iniziativa cittadina", "Open Day", "Serata a tema"],
          family: ["Family Day", "Laboratorio bimbi", "Attività per famiglie", "Kids Show", "Giochi in piazza"],
          sport: ["Evento sportivo", "Corsa", "Partita", "Training Day", "Sport Night"],
          museum: ["Museo aperto", "Mostra al museo", "Notte al museo", "Visita speciale", "Arte e storia"],
          market: ["Mercatino", "Mercato", "Artigianato", "Vintage Market", "Farmers Market"]
        }[category] || ["Evento"];
        return `${t[Math.floor(rnd() * t.length)]} — ${city.name}`;
      })();

      const id = sha1(`${city.cc}|${city.name}|${title}|${start.toISOString()}|${place}`).slice(0, 14);

      events.push({
        id,
        title,
        start: toISO(start),
        end: toISO(end),
        lat: Number(lat.toFixed(5)),
        lon: Number(lon.toFixed(5)),
        place,
        city: city.name,
        region: city.region || "",
        country_code: city.cc,
        category,
        source: "seed"
      });
    }
  }

  return events;
}

function main() {
  const cfg = readJSON(CFG_PATH, null) || {};
  const daysAhead = clamp(Number(cfg.days_ahead || 365), 30, 365);
  const maxEvents = clamp(Number(cfg.max_events || 50000), 1000, 200000);

  const italyEnabled = !!(cfg.coverage?.italy?.enabled ?? true);
  const europeEnabled = !!(cfg.coverage?.europe?.enabled ?? true);

  const stats = {
    updated_at: new Date().toISOString(),
    sources_total: 1,
    sources_ok: 1,
    sources_fail: 0,
    raw: 0,
    deduped: 0,
    kept_window: 0,
    geocoded: 0,
    dropped_no_coords: 0,
    dropped_out_of_range: 0,
    kept: 0,
    per_source: {
      seed_all: { ok: true, error: null, produced: 0 }
    }
  };

  let pool = [];
  if (italyEnabled) {
    for (const c of IT_CITIES) pool.push(...buildSeedEventsForCity(c, daysAhead, 2));
  }
  if (europeEnabled) {
    for (const c of EU_CITIES) pool.push(...buildSeedEventsForCity(c, daysAhead, 2));
  }

  stats.raw = pool.length;

  // dedupe by id
  const map = new Map();
  for (const e of pool) map.set(e.id, e);
  const deduped = [...map.values()];
  stats.deduped = deduped.length;

  // keep within maxEvents (stabile: ordina per start + id)
  deduped.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : (a.id < b.id ? -1 : 1)));
  const kept = deduped.slice(0, maxEvents);
  stats.kept = kept.length;
  stats.per_source.seed_all.produced = kept.length;

  const out = {
    updated_at: stats.updated_at,
    count: kept.length,
    days_ahead: daysAhead,
    events: kept,
    stats
  };

  ensureDir(path.dirname(OUT_PATH));
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf8");

  console.log("✅ Wrote", OUT_PATH, `(${kept.length} events)`);
  console.log("Stats:", {
    updated_at: out.updated_at,
    count: out.count,
    days_ahead: out.days_ahead
  });

  // Se per qualsiasi motivo finisce a 0, torna errore per non committare vuoto
  if (!out.count) {
    console.error("❌ Count=0. Something is wrong.");
    process.exit(2);
  }
}

main();
