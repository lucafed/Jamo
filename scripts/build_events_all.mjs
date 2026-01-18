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
  if (/(sagra|street food|degust|vino|enogastr|food|taste|birra|beer)/.test(s)) return "food";
  if (/(concerto|live|dj|music|festival|show|spettacol)/.test(s)) return "music";
  if (/(mercatino|market|fiera|expo|fair)/.test(s)) return "market";
  if (/(mostra|museo|arte|theatre|teatro|cultura|conference|talk|cinema)/.test(s)) return "culture";
  if (/(bambin|family|kids|giochi|children|ragazz)/.test(s)) return "family";
  if (/(corsa|maratona|trail running|gara|sport|bike|bici|cicl|mtb|motoclub|moto|enduro|raduno)/.test(s)) return "sport";
  return "other";
}

/* -------------------- URL utils -------------------- */
function absolutize(baseUrl, href) {
  try { return new URL(href, baseUrl).toString(); }
  catch { return href; }
}
function isParksUrl(u) {
  const s = String(u || "");
  return s.includes("://www.parks.it") || s.includes("://parks.it") || s.includes("://www.parks.") || s.includes("parks.it");
}
function httpsToHttpIfParks(u) {
  const s = String(u || "");
  if (!isParksUrl(s)) return s;
  return s.replace(/^https:\/\//i, "http://");
}

/* -------------------- HTTP fetch with retries + parks http fallback -------------------- */
async function fetchWithRetries(url, { accept = "*/*", extraHeaders = {}, attempts = 3 } = {}) {
  let lastErr = null;
  const headers = { "User-Agent": UA, "Accept": accept, ...extraHeaders };

  const tries = [];
  tries.push(url);

  // Se parks.it e https, prova anche http
  const httpAlt = httpsToHttpIfParks(url);
  if (httpAlt && httpAlt !== url) tries.push(httpAlt);

  for (const u0 of tries) {
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetch(u0, { headers, redirect: "follow" });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${u0}`);
        return r;
      } catch (e) {
        lastErr = e;
        const wait = 500 * (i + 1) * (i + 1);
        await sleep(wait);
      }
    }
  }

  throw lastErr || new Error("fetch failed");
}

async function fetchJson(url, headers = {}) {
  const r = await fetchWithRetries(url, { accept: "application/json", extraHeaders: headers });
  return await r.json();
}
async function fetchText(url, headers = {}) {
  const r = await fetchWithRetries(url, { accept: "*/*", extraHeaders: headers });
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

/* -------------------- Parks.it Italy -------------------- */
const IT_REGIONS = [
  { region: "Piemonte", slug: "piemonte" },
  { region: "Valle d'Aosta", slug: "valledaosta" },
  { region: "Lombardia", slug: "lombardia" },
  { region: "Trentino-Alto Adige", slug: "trentinoaltoadige" },
  { region: "Veneto", slug: "veneto" },
  { region: "Friuli-Venezia Giulia", slug: "friuliveneziagiulia" },
  { region: "Liguria", slug: "liguria" },
  { region: "Emilia-Romagna", slug: "emiliaromagna" },
  { region: "Toscana", slug: "toscana" },
  { region: "Umbria", slug: "umbria" },
  { region: "Marche", slug: "marche" },
  { region: "Lazio", slug: "lazio" },
  { region: "Abruzzo", slug: "abruzzo" },
  { region: "Molise", slug: "molise" },
  { region: "Campania", slug: "campania" },
  { region: "Puglia", slug: "puglia" },
  { region: "Basilicata", slug: "basilicata" },
  { region: "Calabria", slug: "calabria" },
  { region: "Sicilia", slug: "sicilia" },
  { region: "Sardegna", slug: "sardegna" }
];

// fallback coordinate centro regione (così non perdi eventi se LOCATION generica)
const IT_REGION_CENTROIDS = {
  "Piemonte": { lat: 45.0667, lon: 7.7000 },
  "Valle d'Aosta": { lat: 45.7372, lon: 7.3201 },
  "Lombardia": { lat: 45.4642, lon: 9.1900 },
  "Trentino-Alto Adige": { lat: 46.0667, lon: 11.1167 },
  "Veneto": { lat: 45.4384, lon: 10.9916 },
  "Friuli-Venezia Giulia": { lat: 45.6495, lon: 13.7768 },
  "Liguria": { lat: 44.4056, lon: 8.9463 },
  "Emilia-Romagna": { lat: 44.4949, lon: 11.3426 },
  "Toscana": { lat: 43.7696, lon: 11.2558 },
  "Umbria": { lat: 43.1122, lon: 12.3888 },
  "Marche": { lat: 43.6167, lon: 13.5167 },
  "Lazio": { lat: 41.9028, lon: 12.4964 },
  "Abruzzo": { lat: 42.3500, lon: 13.4000 },
  "Molise": { lat: 41.5610, lon: 14.6680 },
  "Campania": { lat: 40.8518, lon: 14.2681 },
  "Puglia": { lat: 41.1253, lon: 16.8667 },
  "Basilicata": { lat: 40.6400, lon: 15.8000 },
  "Calabria": { lat: 38.9108, lon: 16.5870 },
  "Sicilia": { lat: 37.5079, lon: 14.0610 },
  "Sardegna": { lat: 39.2238, lon: 9.1217 }
};

function extractParksIcalUrl(html, baseUrl) {
  const candidates = [];

  const re1 = /href\s*=\s*"([^"]+)"/gi;
  let m;
  while ((m = re1.exec(html))) {
    const href = m[1];
    const h = href.toLowerCase();
    if (h.includes("ical") || h.endsWith(".ics") || h.includes(".ics?")) {
      candidates.push(absolutize(baseUrl, href));
    }
  }

  const re2 = /href\s*=\s*'([^']+)'/gi;
  while ((m = re2.exec(html))) {
    const href = m[1];
    const h = href.toLowerCase();
    if (h.includes("ical") || h.endsWith(".ics") || h.includes(".ics?")) {
      candidates.push(absolutize(baseUrl, href));
    }
  }

  const re3 = /(https?:\/\/[^\s"'<>]+\.ics[^\s"'<>]*)/gi;
  while ((m = re3.exec(html))) candidates.push(m[1]);

  const re4 = /([^\s"'<>]+\.ics(?:\?[^\s"'<>]+)?)/gi;
  while ((m = re4.exec(html))) {
    const u = m[1];
    candidates.push(u.startsWith("http") ? u : absolutize(baseUrl, u));
  }

  const seen = new Set();
  const uniq = [];
  for (const u of candidates) {
    const s = String(u || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    uniq.push(s);
  }

  return uniq[0] || null;
}

async function fetchParksItaly(now, daysAhead, geocache) {
  const out = [];

  let regionsOk = 0;
  let regionsWithIcs = 0;
  let totalVEVENT = 0;
  let keptGeocoded = 0;
  let keptFallback = 0;

  for (const r of IT_REGIONS) {
    // IMPORTANTISSIMO: per parks.it uso base http per facilitare i link ICS http-only
    const regionPage = `http://www.parks.it/regione.${r.slug}/man.php`;

    try {
      const html = await fetchText(regionPage, { "Accept-Language": "it-IT,it;q=0.9,en;q=0.7" });

      const icsUrl = extractParksIcalUrl(html, regionPage);
      if (!icsUrl) {
        console.log(`Parks.it: ${r.region} — NO ICS link found`);
        continue;
      }
      regionsWithIcs++;

      // fetchText ha fallback https->http per parks, quindi qui copriamo entrambi
      const icsText = await fetchText(icsUrl, { "Accept-Language": "it-IT,it;q=0.9,en;q=0.7" });

      const evs = parseIcs(icsText);
      totalVEVENT += evs.length;

      let regionKept = 0;

      for (const ev of evs) {
        const title = String(ev.title || "").trim() || "Evento";
        const sd = parseIcsDate(ev.start);
        if (!sd || !withinWindow(sd, now, daysAhead)) continue;

        const ed = parseIcsDate(ev.end);
        const loc = String(ev.location || "").trim();
        const desc = String(ev.description || "").trim();
        const url = String(ev.url || "").trim();

        let lat = NaN, lon = NaN, place = "";

        if (loc) {
          const g = await geocodePlace(loc, geocache);
          if (g) {
            lat = g.lat;
            lon = g.lon;
            place = loc;
            keptGeocoded++;
          }
        }

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          const c = IT_REGION_CENTROIDS[r.region];
          if (!c) continue;
          lat = c.lat;
          lon = c.lon;
          place = loc ? `${loc} (${r.region})` : r.region;
          keptFallback++;
        }

        out.push({
          title,
          start: iso(sd),
          end: ed ? iso(ed) : null,
          lat,
          lon,
          place,
          city: "",
          region: r.region,
          country_code: "IT",
          url,
          category: guessCategory(title, `${place} ${desc}`),
          source: "parks_it"
        });

        regionKept++;
      }

      regionsOk++;
      console.log(`Parks.it: ${r.region} — kept: ${regionKept} (VEVENT: ${evs.length})`);
    } catch (e) {
      console.log(`Parks.it: ${r.region} — FAILED: ${String(e?.message || e)}`);
    }

    await sleep(250);
  }

  console.log(
    `Parks.it summary: regionsOk=${regionsOk}/${IT_REGIONS.length} regionsWithIcs=${regionsWithIcs} ` +
    `totalVEVENT=${totalVEVENT} kept=${out.length} (geocoded=${keptGeocoded}, fallback=${keptFallback})`
  );

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
    const city = String(src.default_city || "").trim();
    const country_code = String(src.country_code || "").toUpperCase();

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const locCandidate = (desc.match(/(Luogo|Location|Dove)\s*:\s*([^.\n]+)/i)?.[2] || "").trim();
      const q = locCandidate || place || title;
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
      region: String(src.default_region || ""),
      country_code,
      place,
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
      city: String(src.default_city || "").trim(),
      region: String(src.default_region || ""),
      country_code: String(src.country_code || "").toUpperCase(),
      place: place || "",
      url: link || "",
      category: String(src.category || guessCategory(title, `${place} ${desc}`)),
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
  const maxEvents = Number(cfg.max_events || 30000);

  const out = [];
  const seen = new Set();

  // Parks.it Italy
  const parksEnabled = !!cfg?.providers?.parks_it?.enabled;
  if (parksEnabled && cfg?.coverage?.italy?.enabled) {
    const evs = await fetchParksItaly(now, daysAhead, geocache).catch(() => []);
    for (const e of evs) out.push(e);
  }

  // RSS/ICS extra sources (se sono placeholder verranno skippati)
  console.log(`► Building RSS/ICS sources... sources: ${(cfg.rss_ics_sources || []).length}`);
  for (const src of (cfg.rss_ics_sources || [])) {
    const type = String(src.type || "").toLowerCase();
    const url = String(src.url || "").trim();
    if (!url || url.includes("INCOLLA_QUI")) {
      console.log(`- skip source ${src.id} (missing/invalid url)`);
      continue;
    }
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

  // Normalize IDs + dedupe + limit
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
