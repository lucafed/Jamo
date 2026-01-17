import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const SOURCES_PATH = path.join(ROOT, "events_sources.json");
const OUT_DIR = path.join(ROOT, "public", "data", "events");
const OUT_PATH = path.join(OUT_DIR, "events_all.json");
const CACHE_DIR = path.join(ROOT, "cache");
const GEOCACHE_PATH = path.join(CACHE_DIR, "geocode-cache.json");

const UA = process.env.JAMO_UA || "JamoEventsBot/1.0 (github actions)";
const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";

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
  if (/(sagra|street food|degust|vino|enogastr|food|taste)/.test(s)) return "food";
  if (/(concerto|live|dj|music|festival|show)/.test(s)) return "music";
  if (/(mercatino|market|fiera|expo|fair)/.test(s)) return "market";
  if (/(mostra|museo|arte|theatre|teatro|cultura|conference|talk)/.test(s)) return "culture";
  if (/(bambin|family|kids|giochi|children)/.test(s)) return "family";
  return "other";
}

async function fetchJson(url, headers = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json", ...headers } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return await r.json();
}
async function fetchText(url, headers = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "*/*", ...headers } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return await r.text();
}

/* -------------------- Geocoding (Nominatim) cache + 1req/s -------------------- */
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

  for (const ln of lines) {
    if (ln.startsWith("BEGIN:VEVENT")) { cur = {}; continue; }
    if (ln.startsWith("END:VEVENT")) { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;

    const [k0, ...rest] = ln.split(":");
    const v = rest.join(":").trim();
    const k = k0.split(";")[0].trim().toUpperCase();

    if (k === "SUMMARY") cur.title = v;
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

/* -------------------- Ticketmaster (Discovery API) --------------------
   Key passed as apikey query param. 3
*/
async function fetchTicketmaster({ apikey, cc, lat, lon, radiusKm, startUtc, endUtc, size = 200 }) {
  if (!apikey) return [];
  const base = "https://app.ticketmaster.com/discovery/v2/events.json";
  const url =
    `${base}?apikey=${encodeURIComponent(apikey)}` +
    `&countryCode=${encodeURIComponent(cc)}` +
    `&latlong=${encodeURIComponent(`${lat},${lon}`)}` +
    `&radius=${encodeURIComponent(String(Math.round(radiusKm)))}` +
    `&unit=km` +
    `&sort=date,asc` +
    `&size=${encodeURIComponent(String(size))}` +
    (startUtc ? `&startDateTime=${encodeURIComponent(startUtc)}` : "") +
    (endUtc ? `&endDateTime=${encodeURIComponent(endUtc)}` : "");

  const j = await fetchJson(url);
  const evs = j?._embedded?.events;
  if (!Array.isArray(evs)) return [];

  const out = [];
  for (const e of evs) {
    const title = String(e?.name || "").trim() || "Evento";
    const start = e?.dates?.start?.dateTime || e?.dates?.start?.localDate || null;
    if (!start) continue;
    const d = new Date(start);
    if (!Number.isFinite(d.getTime())) continue;

    const venue = e?._embedded?.venues?.[0] || {};
    const vLat = Number(venue?.location?.latitude);
    const vLon = Number(venue?.location?.longitude);
    if (!Number.isFinite(vLat) || !Number.isFinite(vLon)) continue;

    const city = String(venue?.city?.name || "").trim();
    const country = String(venue?.country?.countryCode || cc).toUpperCase();
    const place = [String(venue?.name || "").trim(), city].filter(Boolean).join(", ");

    out.push({
      title,
      start: iso(d),
      end: null,
      lat: vLat,
      lon: vLon,
      city,
      country_code: country,
      place,
      region: "",
      url: String(e?.url || "").trim(),
      category: guessCategory(title, place),
      source: "ticketmaster"
    });
  }
  return out;
}

/* -------------------- OpenAgenda --------------------
   Dati pubblici in licenza aperta + API REST. 4
   Nota: l’API “globale” varia a seconda delle istanze/archivi. Qui supporto due modalità:
   A) se hai un endpoint OA compatibile (es. via Opendatasoft / dataset OA), mettilo in OA_ENDPOINT env.
   B) se non ce l’hai, lo lasci vuoto e non blocca build.
*/
async function fetchOpenAgenda({ apiKey, endpoint, lat, lon, radiusKm, startIso, endIso, limit = 200 }) {
  if (!apiKey || !endpoint) return [];
  // Endpoint atteso: un endpoint che accetta query geo + date.
  // Esempio tipico Opendatasoft: .../api/explore/v2.1/catalog/datasets/<dataset>/records?where=...
  // (le installazioni cambiano; per questo lo rendo configurabile)
  const where = [];
  if (Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(radiusKm)) {
    // ODS: within_distance(geo, geom'POINT(lon lat)', meters)
    where.push(`within_distance(geo, geom'POINT(${lon} ${lat})', ${Math.round(radiusKm * 1000)})`);
  }
  if (startIso) where.push(`firstdate >= date'${startIso.slice(0,10)}'`);
  if (endIso) where.push(`firstdate <= date'${endIso.slice(0,10)}'`);

  const url =
    `${endpoint}` +
    (endpoint.includes("?") ? "&" : "?") +
    `limit=${encodeURIComponent(String(limit))}` +
    (where.length ? `&where=${encodeURIComponent(where.join(" AND "))}` : "");

  const j = await fetchJson(url, { "Authorization": `Bearer ${apiKey}` }).catch(() => null);
  const recs = j?.results || j?.records || [];
  if (!Array.isArray(recs)) return [];

  const out = [];
  for (const r of recs) {
    const fields = r?.record?.fields || r; // compat
    const title = String(fields?.title || fields?.name || "Evento").trim();
    const start = fields?.firstdate || fields?.date_start || fields?.start || null;
    if (!start) continue;

    const d = new Date(start);
    if (!Number.isFinite(d.getTime())) continue;

    // geo può essere {lat, lon} o [lon,lat]
    let lat2 = null, lon2 = null;
    if (fields?.geo && typeof fields.geo === "object") {
      lat2 = Number(fields.geo.lat ?? fields.geo.latitude);
      lon2 = Number(fields.geo.lon ?? fields.geo.longitude);
    } else if (Array.isArray(fields?.geo)) {
      lon2 = Number(fields.geo[0]); lat2 = Number(fields.geo[1]);
    }
    if (!Number.isFinite(lat2) || !Number.isFinite(lon2)) continue;

    out.push({
      title,
      start: iso(d),
      end: null,
      lat: lat2,
      lon: lon2,
      city: String(fields?.city || "").trim(),
      country_code: String(fields?.country || "").toUpperCase(),
      place: String(fields?.location || fields?.address || "").trim(),
      region: "",
      url: String(fields?.url || "").trim(),
      category: guessCategory(title, String(fields?.description || "")),
      source: "openagenda"
    });
  }
  return out;
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
    const city = "";
    const country_code = "";

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const locCandidate = (desc.match(/(Luogo|Location|Dove)\s*:\s*([^.\n]+)/i)?.[2] || "").trim();
      const q = locCandidate || place;
      if (q) {
        const g = await geocodePlace(q, geocache);
        if (g) { lat = g.lat; lon = g.lon; place = locCandidate || place || g.display; }
      }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    out.push({
      title,
      start: iso(d),
      end: null,
      lat, lon,
      city,
      country_code,
      place,
      region: String(src.default_region || ""),
      url: link,
      category: guessCategory(title, desc),
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
      country_code: "",
      place: place || "",
      region: String(src.default_region || ""),
      url: link || "",
      category: guessCategory(title, place),
      source: String(src.id || "ics")
    });
  }
  return out;
}

/* -------------------- MAIN -------------------- */
async function main() {
  const cfg = readJSON(SOURCES_PATH, null);
  if (!cfg) {
    console.error("events_sources.json mancante.");
    process.exit(2);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const geocache = readJSON(GEOCACHE_PATH, {});
  const now = new Date();
  const daysAhead = Number(cfg.days_ahead || 60);
  const maxEvents = Number(cfg.max_events || 25000);

  const out = [];
  const seen = new Set();

  const startUtc = new Date(now.getTime() - 6 * 3600 * 1000).toISOString();
  const endUtc = new Date(now.getTime() + daysAhead * 24 * 3600 * 1000).toISOString();

  // ---------------- Providers: Ticketmaster ----------------
  const tmEnabled = !!cfg?.providers?.ticketmaster?.enabled;
  const tmKey = process.env[cfg?.providers?.ticketmaster?.apikey_env || "TICKETMASTER_API_KEY"] || "";
  if (tmEnabled && tmKey) {
    // Italy
    if (cfg?.coverage?.italy?.enabled) {
      const cc = String(cfg.coverage.italy.country_code || "IT").toUpperCase();
      for (const c of (cfg.coverage.italy.cities || [])) {
        const evs = await fetchTicketmaster({
          apikey: tmKey, cc,
          lat: c.lat, lon: c.lon,
          radiusKm: c.radius_km || 60,
          startUtc, endUtc
        }).catch(() => []);
        for (const e of evs) out.push(e);
        if (out.length >= maxEvents) break;
        await sleep(250);
      }
    }

    // Europe countries
    if (cfg?.coverage?.europe?.enabled) {
      for (const country of (cfg.coverage.europe.countries || [])) {
        const cc = String(country.cc || "").toUpperCase();
        if (!cc) continue;
        for (const c of (country.cities || [])) {
          const evs = await fetchTicketmaster({
            apikey: tmKey, cc,
            lat: c.lat, lon: c.lon,
            radiusKm: c.radius_km || 70,
            startUtc, endUtc
          }).catch(() => []);
          for (const e of evs) out.push(e);
          if (out.length >= maxEvents) break;
          await sleep(250);
        }
        if (out.length >= maxEvents) break;
      }
    }
  }

  // ---------------- Providers: OpenAgenda (configurable endpoint) ----------------
  const oaEnabled = !!cfg?.providers?.openagenda?.enabled;
  const oaKey = process.env[cfg?.providers?.openagenda?.apikey_env || "OPENAGENDA_API_KEY"] || "";
  const oaEndpoint = process.env.OA_ENDPOINT || ""; // endpoint OA/ODS compatibile
  if (oaEnabled && oaKey && oaEndpoint) {
    // IT
    if (cfg?.coverage?.italy?.enabled) {
      for (const c of (cfg.coverage.italy.cities || [])) {
        const evs = await fetchOpenAgenda({
          apiKey: oaKey,
          endpoint: oaEndpoint,
          lat: c.lat, lon: c.lon,
          radiusKm: c.radius_km || 60,
          startIso: startUtc,
          endIso: endUtc
        }).catch(() => []);
        for (const e of evs) out.push(e);
        if (out.length >= maxEvents) break;
        await sleep(250);
      }
    }
    // EU
    if (cfg?.coverage?.europe?.enabled) {
      for (const country of (cfg.coverage.europe.countries || [])) {
        for (const c of (country.cities || [])) {
          const evs = await fetchOpenAgenda({
            apiKey: oaKey,
            endpoint: oaEndpoint,
            lat: c.lat, lon: c.lon,
            radiusKm: c.radius_km || 70,
            startIso: startUtc,
            endIso: endUtc
          }).catch(() => []);
          for (const e of evs) out.push(e);
          if (out.length >= maxEvents) break;
          await sleep(250);
        }
        if (out.length >= maxEvents) break;
      }
    }
  }

  // ---------------- RSS / ICS sources ----------------
  const localSources = cfg.rss_ics_sources || cfg.sources || [];
  for (const src of localSources) {
    const type = String(src.type || "").toLowerCase();
    if (!src?.url) continue;
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
  }

  // ---------------- Normalize IDs + dedupe ----------------
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

  console.log(`✅ events_all.json scritto: ${normalized.length} eventi`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
