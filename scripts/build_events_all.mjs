// scripts/build_events_all.mjs
// Jamo — Events builder (IT + EU) — offline output
// - Reads events_sources.generated.json (preferred) or events_sources.json
// - Providers: OSM Overpass (no key) + RSS/ICS
// - Robust Overpass: endpoints fallback + retries + backoff
// Node >= 20, type=module

import fs from "fs";
import path from "path";

const ROOT = process.cwd();

// Prefer generated sources
const SOURCES_PATH_GEN = path.join(ROOT, "events_sources.generated.json");
const SOURCES_PATH = path.join(ROOT, "events_sources.json");

const OUT_DIR = path.join(ROOT, "public", "data", "events");
const OUT_PATH = path.join(OUT_DIR, "events_all.json");

const CACHE_DIR = path.join(ROOT, "cache");
const GEOCACHE_PATH = path.join(CACHE_DIR, "geocode-cache.json");

const UA = process.env.JAMO_UA || "JamoEventsBot/1.0 (github actions)";
const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";

// Default Overpass fallback endpoints (can be overridden by cfg.providers.osm_overpass.endpoints)
const DEFAULT_OVERPASS_ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter"
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJSON(p, fallback) {
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
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function iso(d) {
  return d.toISOString();
}

function withinWindow(d, now, daysAhead) {
  const t = d.getTime();
  const a = now.getTime();
  const b = a + daysAhead * 24 * 3600 * 1000;
  // allow a little past (6h) to catch "today" feeds
  return t >= a - 6 * 3600 * 1000 && t <= b;
}

function makeId(src, title, startIso, lat, lon) {
  const base = `${src}|${norm(title)}|${startIso}|${String(lat).slice(0, 7)}|${String(lon).slice(0, 7)}`;
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
  return `e_${h.toString(16)}`;
}

function guessCategory(title, text) {
  const s = norm(`${title} ${text}`);
  if (!s) return "other";
  if (/(sagra|street food|degust|vino|enogastr|food|taste|beer|birra)/.test(s)) return "food";
  if (/(concerto|live|dj|music|festival|show|spettacol)/.test(s)) return "music";
  if (/(mercatino|market|fiera|expo|fair)/.test(s)) return "market";
  if (/(mostra|museo|arte|theatre|teatro|cultura|conference|talk|cinema)/.test(s)) return "culture";
  if (/(bambin|family|kids|giochi|children|ragazz|parco|zoo|acquario)/.test(s)) return "family";
  if (/(corsa|maratona|trail|gara|sport|bike|bici|cicl|mtb|cycling|motoclub|moto|enduro|raduno|run)/.test(s)) return "sport";
  if (/(trek|hike|outdoor|escurs|cammin|mountain|montagna|rifugio)/.test(s)) return "outdoor";
  return "other";
}

/* -------------------- fetch helpers -------------------- */
async function fetchJson(url, headers = {}) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json", ...headers },
    redirect: "follow"
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return await r.json();
}

async function fetchText(url, headers = {}) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "*/*", ...headers },
    redirect: "follow"
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return await r.text();
}

async function postText(url, body, headers = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      ...headers
    },
    body
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} POST ${url}`);
  return await r.text();
}

function isRetryableHttp(msg) {
  // Overpass often yields 429/504/502/503 timeouts
  return /HTTP (429|502|503|504)\b/.test(String(msg || ""));
}

/* -------------------- Geocoding (Nominatim) cache + 1req/s (only RSS/ICS) -------------------- */
async function geocodePlace(q, cache) {
  const key = norm(q);
  if (!key) return null;
  if (cache[key]) return cache[key];

  await sleep(1100);

  const url = `${NOMINATIM_ENDPOINT}?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
  const j = await fetchJson(url);
  const first = Array.isArray(j) && j[0] ? j[0] : null;
  if (!first) return null;

  const lat = Number(first.lat);
  const lon = Number(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const out = { lat, lon, display: first.display_name || "" };
  cache[key] = out;
  return out;
}

/* -------------------- Minimal RSS parsing -------------------- */
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

/* -------------------- Minimal ICS parsing -------------------- */
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
    if (ln.startsWith("BEGIN:VEVENT")) {
      cur = {};
      continue;
    }
    if (ln.startsWith("END:VEVENT")) {
      if (cur) events.push(cur);
      cur = null;
      continue;
    }
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
    const y = x.slice(0, 4),
      m = x.slice(4, 6),
      d = x.slice(6, 8);
    const dt = new Date(`${y}-${m}-${d}T12:00:00Z`);
    return Number.isFinite(dt.getTime()) ? dt : null;
  }
  if (/^\d{8}T\d{6}Z?$/.test(x)) {
    const y = x.slice(0, 4),
      mo = x.slice(4, 6),
      d = x.slice(6, 8);
    const hh = x.slice(9, 11),
      mm = x.slice(11, 13),
      ss = x.slice(13, 15);
    const z = x.endsWith("Z") ? "Z" : "";
    const dt = new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss}${z}`);
    return Number.isFinite(dt.getTime()) ? dt : null;
  }
  return parseDateMaybe(x);
}

/* -------------------- RSS / ICS sources -------------------- */
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
        if (g) {
          lat = g.lat;
          lon = g.lon;
          place = place || g.display;
        }
      }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    out.push({
      title,
      start: iso(d),
      end: null,
      lat,
      lon,
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
        if (g) {
          lat = g.lat;
          lon = g.lon;
        }
      }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    out.push({
      title,
      start: iso(sd),
      end: ed ? iso(ed) : null,
      lat,
      lon,
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

/* -------------------- OSM Overpass (NO API KEY) -------------------- */
/**
 * Parse date formats commonly found in OSM tags:
 * - YYYY-MM-DD
 * - YYYY-MM
 * - YYYY
 * - ISO-ish
 */
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
  const blob = `${title} ${Object.entries(t)
    .map(([k, v]) => `${k}:${v}`)
    .join(" ")}`;
  return guessCategory(title, blob);
}

function buildOverpassQuery({ lat, lon, radiusMeters, timeoutSeconds }) {
  // NOTE: Overpass cannot reliably filter by date in query, so we filter in JS.
  // We only take items that have likely date tags.
  return `
[out:json][timeout:${timeoutSeconds}];
(
  nwr(around:${radiusMeters},${lat},${lon})["event"]["start_date"];
  nwr(around:${radiusMeters},${lat},${lon})["event"]["date"];
  nwr(around:${radiusMeters},${lat},${lon})["event"]["opening_date"];

  nwr(around:${radiusMeters},${lat},${lon})["festival"]["start_date"];
  nwr(around:${radiusMeters},${lat},${lon})["festival"]["date"];

  nwr(around:${radiusMeters},${lat},${lon})["start_date"]["name"];
  nwr(around:${radiusMeters},${lat},${lon})["date"]["name"];
);
out center tags;
  `.trim();
}

// POST with fallback + retry
async function overpassPostWithFallback(endpoints, body, { maxAttempts = 2 } = {}) {
  const eps = (Array.isArray(endpoints) && endpoints.length ? endpoints : DEFAULT_OVERPASS_ENDPOINTS).filter(Boolean);

  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    for (const ep of eps) {
      try {
        return await postText(ep, body);
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || e);
        console.error(`Overpass failed (attempt ${attempt}/${maxAttempts}) ${ep} → ${msg}`);

        // backoff on retryable
        if (isRetryableHttp(msg)) {
          await sleep(900 + attempt * 700);
        } else {
          await sleep(400);
        }
      }
    }
  }
  throw lastErr || new Error("All Overpass endpoints failed");
}

async function fetchOverpassForCity(city, now, daysAhead, timeoutMs, endpoints) {
  const name = String(city?.name || "").trim();
  const lat = Number(city?.lat);
  const lon = Number(city?.lon);
  const radius_km = Number(city?.radius_km || 40);

  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];

  const radiusMeters = Math.max(5000, Math.round(radius_km * 1000));
  const timeoutSeconds = Math.max(10, Math.round((timeoutMs || 30000) / 1000));

  const q = buildOverpassQuery({ lat, lon, radiusMeters, timeoutSeconds });
  const body = `data=${encodeURIComponent(q)}`;

  const txt = await overpassPostWithFallback(endpoints, body, { maxAttempts: 2 });
  const j = JSON.parse(txt);

  const elements = Array.isArray(j?.elements) ? j.elements : [];
  const out = [];

  for (const el of elements) {
    const tags = el.tags || {};
    const title = String(tags.name || tags.title || tags.event || "Evento").trim();
    if (!title) continue;

    const startRaw = tags.start_date || tags.date || tags.opening_date || "";
    const endRaw = tags.end_date || tags["end_date:date"] || "";

    const sd = parseOsmDate(startRaw);
    if (!sd) continue;

    if (!withinWindow(sd, now, daysAhead)) continue;

    const ed = parseOsmDate(endRaw);

    const lat2 = Number(el.lat ?? el.center?.lat);
    const lon2 = Number(el.lon ?? el.center?.lon);
    if (!Number.isFinite(lat2) || !Number.isFinite(lon2)) continue;

    const url = osmPickUrl(tags);
    const place = osmPlaceString(tags, name);
    const cat = osmCategoryFromTags(title, tags);

    out.push({
      title,
      start: iso(sd),
      end: ed ? iso(ed) : null,
      lat: lat2,
      lon: lon2,
      city: name,
      country_code: String(city?.cc || "").toUpperCase(),
      place,
      region: "",
      url,
      category: cat,
      source: "osm_overpass"
    });
  }

  return out;
}

/* -------------------- MAIN -------------------- */
async function main() {
  // pick sources
  const cfg = fs.existsSync(SOURCES_PATH_GEN)
    ? readJSON(SOURCES_PATH_GEN, null)
    : readJSON(SOURCES_PATH, null);

  if (!cfg) {
    console.error("❌ events_sources.generated.json o events_sources.json mancante.");
    process.exit(2);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const geocache = readJSON(GEOCACHE_PATH, {});
  const now = new Date();
  const daysAhead = Number(cfg.days_ahead || 60);
  const maxEvents = Number(cfg.max_events || 30000);

  const out = [];
  const seen = new Set();

  const osmEnabled = !!cfg?.providers?.osm_overpass?.enabled;
  const osmTimeout = Number(cfg?.providers?.osm_overpass?.timeout_ms || 30000);

  const overpassEndpoints =
    (cfg?.providers?.osm_overpass?.endpoints || DEFAULT_OVERPASS_ENDPOINTS)
      .map(String)
      .filter(Boolean);

  // ----- OSM Overpass -----
  if (osmEnabled) {
    const itEnabled = !!cfg?.coverage?.italy?.enabled;
    const euEnabled = !!cfg?.coverage?.europe?.enabled;

    const itCities = Array.isArray(cfg?.coverage?.italy?.cities) ? cfg.coverage.italy.cities : [];
    const euCities = Array.isArray(cfg?.coverage?.europe?.cities) ? cfg.coverage.europe.cities : [];

    console.log(`► Overpass: endpoints=${overpassEndpoints.length} IT_cities=${itCities.length} EU_cities=${euCities.length}`);

    // IMPORTANT: throttling to reduce 504
    const perCityDelay = 650;

    if (itEnabled) {
      for (const c of itCities) {
        try {
          const evs = await fetchOverpassForCity({ ...c, cc: "IT" }, now, daysAhead, osmTimeout, overpassEndpoints);
          for (const e of evs) out.push(e);
        } catch (e) {
          console.error(`Overpass IT city failed (${c?.name || "?"}):`, e?.message || e);
        }
        await sleep(perCityDelay);
        if (out.length >= maxEvents) break;
      }
    }

    if (euEnabled && out.length < maxEvents) {
      for (const c of euCities) {
        try {
          const evs = await fetchOverpassForCity(c, now, daysAhead, osmTimeout, overpassEndpoints);
          for (const e of evs) out.push(e);
        } catch (e) {
          console.error(`Overpass EU city failed (${c?.name || "?"}):`, e?.message || e);
        }
        await sleep(perCityDelay);
        if (out.length >= maxEvents) break;
      }
    }
  }

  // ----- RSS/ICS -----
  const localSources = cfg.rss_ics_sources || cfg.sources || [];
  console.log(`► RSS/ICS sources: ${localSources.length}`);

  for (const src of localSources) {
    const type = String(src.type || "").toLowerCase();
    const url = String(src.url || "").trim();

    if (!url) continue;
    if (url.includes("INCOLLA_QUI")) continue;

    try {
      const evs =
        type === "rss"
          ? await fetchRssSource(src, now, daysAhead, geocache)
          : type === "ics"
          ? await fetchIcsSource(src, now, daysAhead, geocache)
          : [];

      for (const e of evs) out.push(e);
    } catch (e) {
      console.error(`Source failed ${src?.id}:`, e?.message || e);
    }

    // Soft cap
    if (out.length >= maxEvents) break;
  }

  // ----- Normalize + dedupe -----
  const normalized = [];
  for (const e of out) {
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

  normalized.sort((a, b) => String(a.start).localeCompare(String(b.start)));

  writeJSON(GEOCACHE_PATH, geocache);
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
