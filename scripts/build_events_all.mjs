/* Jamo — build_events_all.mjs v2.0 (ROBUST • IT+EU • OFFLINE RECURRING + OVERPASS FALLBACK)
 * - Output: public/data/events/events_all.json
 * - Resilient Overpass (multi-endpoint + retry + backoff)
 * - Optional RSS/ICS (skip if blocked)
 * - Always-on recurring offline seed (IT+EU) to avoid empty datasets
 *
 * Schema eventi (per app.js):
 * { id,title,start,end,lat,lon,place,city,region,country_code,url,category,source }
 */

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const SOURCES_PATH = path.join(ROOT, "events_sources.json");
const OUT_DIR = path.join(ROOT, "public", "data", "events");
const OUT_PATH = path.join(OUT_DIR, "events_all.json");
const CACHE_DIR = path.join(ROOT, "cache");
const GEOCACHE_PATH = path.join(CACHE_DIR, "geocode-cache.json");

const UA = process.env.JAMO_UA || "JamoEventsBot/2.0 (github actions)";
const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";

// Overpass: prova in sequenza (molto importante!)
const OVERPASS_ENDPOINTS = [
  process.env.OVERPASS_ENDPOINT,
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
].filter(Boolean);

// -------------------- utils --------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function iso(d) { return d.toISOString(); }

function withinWindow(d, now, daysAhead) {
  const t = d.getTime();
  const a = now.getTime();
  const b = a + daysAhead * 24 * 3600 * 1000;
  // tolleranza -6h per fusi/overnight
  return t >= a - 6 * 3600 * 1000 && t <= b;
}

function makeId(src, title, startIso, lat, lon) {
  const base = `${src}|${norm(title)}|${startIso}|${String(lat).slice(0,7)}|${String(lon).slice(0,7)}`;
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
  return `e_${h.toString(16)}`;
}

function guessCategory(title, text) {
  const s = norm(`${title} ${text}`);
  if (!s) return "other";
  if (/(sagra|street food|degust|vino|enogastr|food|taste|beer|birra|mercato contadino)/.test(s)) return "food";
  if (/(concerto|live|dj|music|festival|show|spettacol|club|serata)/.test(s)) return "music";
  if (/(mercatino|market|fiera|expo|fair|bazar|antiquari)/.test(s)) return "market";
  if (/(mostra|museo|arte|theatre|teatro|cultura|conference|talk|cinema|rassegna)/.test(s)) return "culture";
  if (/(bambin|family|kids|giochi|children|ragazz|parco|zoo|acquario)/.test(s)) return "family";
  if (/(corsa|maratona|trail|gara|sport|bike|bici|cicl|mtb|cycling|moto|enduro|raduno|run)/.test(s)) return "sport";
  return "other";
}

// -------------------- fetch helpers --------------------
async function fetchJson(url, headers = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json", ...headers }, redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return await r.json();
}
async function fetchText(url, headers = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "*/*", ...headers }, redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return await r.text();
}
async function postText(url, body, headers = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "User-Agent": UA, "Accept": "*/*", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", ...headers },
    body
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} POST ${url}`);
  return await r.text();
}

// -------------------- retry wrapper --------------------
async function withRetry(fn, { tries = 3, baseDelay = 900, label = "op" } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      if (i > 0) await sleep(baseDelay * Math.pow(1.6, i - 1));
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      // se 429/504/timeout ecc: ritenta
      console.error(`⚠️ ${label} try ${i + 1}/${tries} failed: ${msg}`);
    }
  }
  throw lastErr;
}

// -------------------- Geocoding cache (solo per RSS/ICS e seed se manca lat/lon) --------------------
async function geocodePlace(q, cache) {
  const key = norm(q);
  if (!key) return null;
  if (cache[key]) return cache[key];

  // Nominatim: 1 req/s
  await sleep(1100);

  const url = `${NOMINATIM_ENDPOINT}?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
  const j = await withRetry(() => fetchJson(url), { tries: 2, baseDelay: 1200, label: "nominatim" }).catch(() => null);
  const first = Array.isArray(j) && j[0] ? j[0] : null;
  if (!first) return null;

  const lat = Number(first.lat);
  const lon = Number(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const out = { lat, lon, display: first.display_name || "" };
  cache[key] = out;
  return out;
}

// -------------------- minimal RSS parsing --------------------
function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}
function stripCdata(s) {
  return String(s || "").replace(/^<!\[CDATA\[/i, "").replace(/\]\]>$/i, "").trim();
}
function splitItems(xml) {
  const items = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) items.push(m[1]);
  return items;
}
function parseDateMaybe(x) {
  const s = String(x || "").trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

// -------------------- minimal ICS parsing --------------------
function unfoldIcsLines(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (!out.length) out.push(line);
    else if (/^[ \t]/.test(line)) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}
function parseIcs(text) {
  const lines = unfoldIcsLines(text);
  const events = [];
  let cur = null;

  for (const ln0 of lines) {
    const ln = String(ln0 || "").trimEnd();
    if (ln.startsWith("BEGIN:VEVENT")) { cur = {}; continue; }
    if (ln.startsWith("END:VEVENT")) { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;

    const [k0, ...rest] = ln.split(":");
    const v = rest.join(":").trim();
    const k = k0.split(";")[0].trim().toUpperCase();

    if (k === "SUMMARY") cur.title = v;
    if (k === "DESCRIPTION") cur.description = v;
    if (k === "DTSTART") cur.start = v;
    if (k === "DTEND") cur.end = v;
    if (k === "LOCATION") cur.location = v;
    if (k === "URL") cur.url = v;
  }
  return events;
}
function parseIcsDate(s) {
  const x = String(s || "").trim();
  if (!x) return null;
  if (/^\d{8}$/.test(x)) {
    const y = x.slice(0,4), m = x.slice(4,6), d = x.slice(6,8);
    const dt = new Date(`${y}-${m}-${d}T12:00:00Z`);
    return Number.isFinite(dt.getTime()) ? dt : null;
  }
  if (/^\d{8}T\d{6}Z?$/.test(x)) {
    const y = x.slice(0,4), mo = x.slice(4,6), d = x.slice(6,8);
    const hh = x.slice(9,11), mm = x.slice(11,13), ss = x.slice(13,15);
    const z = x.endsWith("Z") ? "Z" : "";
    const dt = new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss}${z}`);
    return Number.isFinite(dt.getTime()) ? dt : null;
  }
  return parseDateMaybe(x);
}

// -------------------- RSS / ICS sources --------------------
async function fetchRssSource(src, now, daysAhead, geocache) {
  const txt = await fetchText(src.url);
  const items = splitItems(txt);
  const out = [];

  for (const it of items) {
    const title = stripHtml(stripCdata(extractTag(it, "title"))) || "Evento";
    const link = stripCdata(extractTag(it, "link")) || "";
    const pubDateRaw = stripCdata(extractTag(it, "pubDate")) || stripCdata(extractTag(it, "dc:date"));
    const desc = stripHtml(stripCdata(extractTag(it, "description")));
    const d = parseDateMaybe(pubDateRaw);
    if (!d || !withinWindow(d, now, daysAhead)) continue;

    let lat = Number(src.fixed_lat);
    let lon = Number(src.fixed_lon);
    let place = String(src.default_place || "").trim();

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const q = place || title;
      if (q) {
        const g = await geocodePlace(q, geocache);
        if (g) { lat = g.lat; lon = g.lon; place = place || g.display; }
      }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    out.push({
      title,
      start: iso(d),
      end: null,
      lat, lon,
      city: "",
      country_code: String(src.country_code || "").toUpperCase(),
      place,
      region: String(src.default_region || ""),
      url: link,
      category: String(src.category || guessCategory(title, desc)),
      source: String(src.id || "rss")
    });
  }
  return out;
}

async function fetchIcsSource(src, now, daysAhead, geocache) {
  const txt = await fetchText(src.url);
  const evs = parseIcs(txt);
  const out = [];

  for (const ev of evs) {
    const title = String(ev.title || "").trim() || "Evento";
    const sd = parseIcsDate(ev.start);
    if (!sd || !withinWindow(sd, now, daysAhead)) continue;

    const ed = parseIcsDate(ev.end);
    const loc = String(ev.location || src.default_place || "").trim();
    const link = String(ev.url || "").trim();
    const desc = String(ev.description || "").trim();

    let lat = Number(src.fixed_lat);
    let lon = Number(src.fixed_lon);
    let place = loc || String(src.default_place || "").trim();

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      if (place) {
        const g = await geocodePlace(place, geocache);
        if (g) { lat = g.lat; lon = g.lon; }
      }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    out.push({
      title,
      start: iso(sd),
      end: ed ? iso(ed) : null,
      lat, lon,
      city: "",
      country_code: String(src.country_code || "").toUpperCase(),
      place: place || "",
      region: String(src.default_region || ""),
      url: link || "",
      category: String(src.category || guessCategory(title, `${place} ${desc}`)),
      source: String(src.id || "ics")
    });
  }
  return out;
}

// -------------------- Overpass parsing --------------------
function parseOsmDate(x) {
  const s = String(x || "").trim();
  if (!s) return null;

  const d1 = new Date(s);
  if (Number.isFinite(d1.getTime())) return d1;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T12:00:00Z`);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (/^\d{4}-\d{2}$/.test(s)) {
    const d = new Date(`${s}-15T12:00:00Z`);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (/^\d{4}$/.test(s)) {
    const d = new Date(`${s}-07-01T12:00:00Z`);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

function osmPickUrl(tags) {
  const t = tags || {};
  return (t.website || t["contact:website"] || t.url || t["contact:url"] || "").trim();
}

function osmPlaceString(tags, fallbackCity) {
  const t = tags || {};
  const parts = [];
  const street = [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" ");
  if (street) parts.push(street);
  if (t["addr:postcode"]) parts.push(t["addr:postcode"]);
  if (t["addr:city"]) parts.push(t["addr:city"]);
  if (!t["addr:city"] && fallbackCity) parts.push(fallbackCity);
  if (t["addr:country"]) parts.push(t["addr:country"]);
  return parts.join(", ").trim();
}

function osmCategoryFromTags(title, tags) {
  const t = tags || {};
  const blob = `${title} ${Object.entries(t).map(([k,v]) => `${k}:${v}`).join(" ")}`;
  return guessCategory(title, blob);
}

// Query più larga: eventi + festival + attraction con date tag comuni
function buildOverpassQuery({ lat, lon, radius_m, daysAhead }) {
  // NOTA: Overpass non filtra bene per data, filtriamo in JS.
  const r = Math.max(7000, Math.min(80000, Math.round(radius_m || 40000)));
  const timeoutSec = 40;

  return `
[out:json][timeout:${timeoutSec}];
(
  // event/festival/date fields
  nwr(around:${r},${lat},${lon})["event"]["start_date"];
  nwr(around:${r},${lat},${lon})["event"]["date"];
  nwr(around:${r},${lat},${lon})["event"]["opening_date"];
  nwr(around:${r},${lat},${lon})["event"]["end_date"];

  nwr(around:${r},${lat},${lon})["festival"]["start_date"];
  nwr(around:${r},${lat},${lon})["festival"]["date"];
  nwr(around:${r},${lat},${lon})["festival"]["end_date"];

  // generic dated POIs with name
  nwr(around:${r},${lat},${lon})["start_date"]["name"];
  nwr(around:${r},${lat},${lon})["date"]["name"];
  nwr(around:${r},${lat},${lon})["opening_date"]["name"];
);
out center tags;
  `.trim();
}

async function postOverpass(endpoint, query) {
  const body = `data=${encodeURIComponent(query)}`;
  const txt = await postText(endpoint, body);
  return JSON.parse(txt);
}

async function fetchOverpassForCity(city, now, daysAhead) {
  const { name, lat, lon } = city;
  const radiusKm = Number(city.radius_km || 40);
  const query = buildOverpassQuery({ lat, lon, radius_m: radiusKm * 1000, daysAhead });

  // prova endpoint in sequenza
  let lastErr = null;
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      const j = await withRetry(() => postOverpass(ep, query), { tries: 3, baseDelay: 1200, label: `overpass(${name})` });
      const elements = Array.isArray(j?.elements) ? j.elements : [];
      const out = [];

      for (const el of elements) {
        const tags = el.tags || {};
        const title = String(tags.name || tags.title || tags.event || tags.festival || "Evento").trim();
        if (!title) continue;

        const startRaw = tags.start_date || tags.date || tags.opening_date || "";
        const endRaw = tags.end_date || tags["end_date:date"] || tags["event:end_date"] || "";

        const sd = parseOsmDate(startRaw);
        if (!sd) continue;
        if (!withinWindow(sd, now, daysAhead)) continue;

        const ed = parseOsmDate(endRaw);

        const lat2 = Number(el.lat ?? el.center?.lat);
        const lon2 = Number(el.lon ?? el.center?.lon);
        if (!Number.isFinite(lat2) || !Number.isFinite(lon2)) continue;

        const url = osmPickUrl(tags);
        const place = osmPlaceString(tags, name);

        out.push({
          title,
          start: iso(sd),
          end: ed ? iso(ed) : null,
          lat: lat2,
          lon: lon2,
          city: name || "",
          country_code: String(city.cc || "").toUpperCase(),
          place,
          region: String(city.region || ""),
          url,
          category: osmCategoryFromTags(title, tags),
          source: "osm_overpass"
        });
      }

      return out;
    } catch (e) {
      lastErr = e;
      console.error(`❌ Overpass endpoint failed for ${name}: ${String(e?.message || e)}`);
      // passa al prossimo endpoint
      await sleep(400);
    }
  }
  throw lastErr || new Error(`Overpass failed for ${city?.name || "city"}`);
}

// -------------------- OFFLINE RECURRING SEED (IT+EU) --------------------
// Regola: generiamo eventi "ricorrenti" per città importanti, nei prossimi N giorni.
// Sono “placeholder realistici” (mercati, fiere, sagre generiche) utilissimi per non avere mai dataset vuoto.
function nextDowAtLocalNoon(now, dow /*0-6*/, tzOffsetMinutes = 0) {
  // semplificazione: usiamo UTC e piazziamo a mezzogiorno UTC (va bene per app)
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0));
  const cur = d.getUTCDay();
  let add = (dow - cur + 7) % 7;
  if (add === 0) add = 7;
  d.setUTCDate(d.getUTCDate() + add);
  return d;
}

function seedTemplatesForCity(city) {
  // eventType mapping: market/food/culture/music/family/sport
  return [
    { title: "Mercato settimanale", category: "market", dow: 6 }, // sabato
    { title: "Mercatino dell’artigianato", category: "market", dow: 0 }, // domenica
    { title: "Street Food & Sapori locali", category: "food", dow: 5 }, // venerdì
    { title: "Mostra / evento culturale", category: "culture", dow: 3 }, // mercoledì
    { title: "Concerto / Live night", category: "music", dow: 5 }, // venerdì
    { title: "Evento Family (bimbi)", category: "family", dow: 6 }, // sabato
  ];
}

function buildRecurringSeed(cities, now, daysAhead) {
  const out = [];
  const endLimit = new Date(now.getTime() + daysAhead * 86400000);

  for (const c of cities) {
    if (!Number.isFinite(Number(c.lat)) || !Number.isFinite(Number(c.lon))) continue;
    const tpl = seedTemplatesForCity(c);

    for (const t of tpl) {
      let d = nextDowAtLocalNoon(now, t.dow, 0);
      while (d <= endLimit) {
        out.push({
          title: `${t.title} • ${c.name}`,
          start: iso(d),
          end: null,
          lat: Number(c.lat),
          lon: Number(c.lon),
          city: c.name,
          country_code: String(c.cc || "").toUpperCase(),
          place: `${c.name}${c.cc ? ", " + c.cc : ""}`,
          region: String(c.region || ""),
          url: "",
          category: t.category,
          source: "seed_recurring"
        });

        // evento ricorrente settimanale
        d = new Date(d.getTime() + 7 * 86400000);
      }
    }
  }

  return out;
}

// -------------------- DEFAULT CONFIG (se events_sources.json manca) --------------------
function defaultConfig() {
  return {
    days_ahead: 60,
    max_events: 50000,
    providers: {
      osm_overpass: { enabled: true }
    },
    coverage: {
      italy: {
        enabled: true,
        cities: [
          { name:"Milano", lat:45.4642, lon:9.1900, radius_km:55, cc:"IT", region:"Lombardia" },
          { name:"Roma", lat:41.9028, lon:12.4964, radius_km:55, cc:"IT", region:"Lazio" },
          { name:"Torino", lat:45.0703, lon:7.6869, radius_km:45, cc:"IT", region:"Piemonte" },
          { name:"Venezia", lat:45.4408, lon:12.3155, radius_km:45, cc:"IT", region:"Veneto" },
          { name:"Verona", lat:45.4384, lon:10.9916, radius_km:40, cc:"IT", region:"Veneto" },
          { name:"Napoli", lat:40.8518, lon:14.2681, radius_km:45, cc:"IT", region:"Campania" },
          { name:"Bologna", lat:44.4949, lon:11.3426, radius_km:40, cc:"IT", region:"Emilia-Romagna" },
          { name:"Firenze", lat:43.7696, lon:11.2558, radius_km:40, cc:"IT", region:"Toscana" },
          { name:"Genova", lat:44.4056, lon:8.9463, radius_km:40, cc:"IT", region:"Liguria" },
          { name:"Palermo", lat:38.1157, lon:13.3615, radius_km:40, cc:"IT", region:"Sicilia" },
          { name:"Bari", lat:41.1171, lon:16.8719, radius_km:40, cc:"IT", region:"Puglia" },
        ]
      },
      europe: {
        enabled: true,
        cities: [
          { name:"Paris", lat:48.8566, lon:2.3522, radius_km:55, cc:"FR" },
          { name:"London", lat:51.5074, lon:-0.1278, radius_km:55, cc:"GB" },
          { name:"Berlin", lat:52.5200, lon:13.4050, radius_km:55, cc:"DE" },
          { name:"Madrid", lat:40.4168, lon:-3.7038, radius_km:60, cc:"ES" },
          { name:"Barcelona", lat:41.3851, lon:2.1734, radius_km:55, cc:"ES" },
          { name:"Amsterdam", lat:52.3676, lon:4.9041, radius_km:45, cc:"NL" },
          { name:"Vienna", lat:48.2082, lon:16.3738, radius_km:45, cc:"AT" },
          { name:"Prague", lat:50.0755, lon:14.4378, radius_km:45, cc:"CZ" },
          { name:"Zurich", lat:47.3769, lon:8.5417, radius_km:40, cc:"CH" },
          { name:"Stockholm", lat:59.3293, lon:18.0686, radius_km:45, cc:"SE" },
          { name:"Lisbon", lat:38.7223, lon:-9.1393, radius_km:50, cc:"PT" },
          { name:"Athens", lat:37.9838, lon:23.7275, radius_km:55, cc:"GR" },
        ]
      }
    },
    // RSS/ICS opzionali (spesso bloccati)
    rss_ics_sources: []
  };
}

// -------------------- MAIN --------------------
async function main() {
  const cfg = readJSON(SOURCES_PATH, null) || defaultConfig();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const geocache = readJSON(GEOCACHE_PATH, {});
  const now = new Date();
  const daysAhead = Number(cfg.days_ahead || 60);
  const maxEvents = Number(cfg.max_events || 50000);

  const rawEvents = [];

  // 0) SEED ricorrenti (sempre)
  const seedCities = [
    ...(cfg?.coverage?.italy?.cities || []),
    ...(cfg?.coverage?.europe?.cities || []),
  ];
  const seeded = buildRecurringSeed(seedCities, now, daysAhead);
  rawEvents.push(...seeded);
  console.log(`► Seed recurring: ${seeded.length} events`);

  // 1) Overpass (se enabled)
  const osmEnabled = !!cfg?.providers?.osm_overpass?.enabled;
  if (osmEnabled) {
    const itEnabled = !!cfg?.coverage?.italy?.enabled;
    const euEnabled = !!cfg?.coverage?.europe?.enabled;

    // rate-limit per non ammazzare overpass
    const perCityDelay = 700;

    if (itEnabled) {
      const cities = Array.isArray(cfg.coverage.italy.cities) ? cfg.coverage.italy.cities : [];
      for (const c of cities) {
        try {
          const evs = await fetchOverpassForCity(c, now, daysAhead);
          rawEvents.push(...evs.map(e => ({ ...e, country_code: e.country_code || "IT" })));
          console.log(`✓ Overpass IT ${c.name}: +${evs.length}`);
        } catch (e) {
          console.error(`Overpass IT city failed (${c?.name || "?"}):`, e?.message || e);
        }
        await sleep(perCityDelay);
        if (rawEvents.length >= maxEvents) break;
      }
    }

    if (euEnabled && rawEvents.length < maxEvents) {
      const cities = Array.isArray(cfg.coverage.europe.cities) ? cfg.coverage.europe.cities : [];
      for (const c of cities) {
        try {
          const evs = await fetchOverpassForCity(c, now, daysAhead);
          rawEvents.push(...evs);
          console.log(`✓ Overpass EU ${c.name}: +${evs.length}`);
        } catch (e) {
          console.error(`Overpass EU city failed (${c?.name || "?"}):`, e?.message || e);
        }
        await sleep(perCityDelay);
        if (rawEvents.length >= maxEvents) break;
      }
    }
  }

  // 2) RSS/ICS (best-effort)
  const rssIcs = Array.isArray(cfg.rss_ics_sources) ? cfg.rss_ics_sources : [];
  console.log(`► RSS/ICS sources: ${rssIcs.length}`);
  for (const src of rssIcs) {
    const type = String(src.type || "").toLowerCase();
    const url = String(src.url || "").trim();
    if (!url || url.includes("INCOLLA_QUI")) continue;

    try {
      const evs =
        type === "rss"
          ? await fetchRssSource(src, now, daysAhead, geocache)
          : type === "ics"
          ? await fetchIcsSource(src, now, daysAhead, geocache)
          : [];

      rawEvents.push(...evs);
      console.log(`✓ ${type.toUpperCase()} ${src.id || "src"}: +${evs.length}`);
    } catch (e) {
      console.error(`Source failed ${src?.id}:`, e?.message || e);
    }
    if (rawEvents.length >= maxEvents) break;
  }

  // 3) Normalize + dedupe
  const seen = new Set();
  const normalized = [];

  for (const e of rawEvents) {
    const title = String(e.title || "Evento").trim();
    const start = new Date(e.start);
    if (!Number.isFinite(start.getTime())) continue;
    if (!withinWindow(start, now, daysAhead)) continue;

    const lat = Number(e.lat);
    const lon = Number(e.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const source = String(e.source || "unknown");
    const startIso = iso(start);
    const id = makeId(source, title, startIso, lat, lon);
    if (seen.has(id)) continue;
    seen.add(id);

    normalized.push({
      id,
      title,
      start: startIso,
      end: e.end ? String(e.end) : null,
      lat,
      lon,
      place: String(e.place || "").trim(),
      city: String(e.city || "").trim(),
      region: String(e.region || "").trim(),
      country_code: String(e.country_code || "").toUpperCase(),
      url: String(e.url || "").trim(),
      category: String(e.category || guessCategory(title, e.place)).trim(),
      source
    });

    if (normalized.length >= maxEvents) break;
  }

  // sort: prossimi prima
  normalized.sort((a, b) => String(a.start).localeCompare(String(b.start)));

  // persist cache
  writeJSON(GEOCACHE_PATH, geocache);

  // output
  writeJSON(OUT_PATH, {
    updated_at: new Date().toISOString(),
    count: normalized.length,
    days_ahead: daysAhead,
    events: normalized
  });

  console.log(`✅ events_all.json scritto: ${normalized.length} eventi → ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
