// scripts/build_events_all.mjs
// Jamo — Events Builder (IT + EU) — NO API KEY required
// Output: /public/data/events/events_all.json
//
// ✅ Italia: Parks.it (auto-scopre link ICS per ogni regione) + geocoding Nominatim con cache
// ✅ Fallback anti-zero: se LOCATION non geocodificabile → usa centro regione (non perdi eventi)
// ✅ Europa: RSS/ICS da events_sources.json (aggiungi feed reali per massima copertura)
// ✅ Categories: family / sport / bike / moto / music / food / market / culture / other

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const CFG_PATH = path.join(ROOT, "events_sources.json");

const OUT_DIR = path.join(ROOT, "public", "data", "events");
const OUT_PATH = path.join(OUT_DIR, "events_all.json");

const CACHE_DIR = path.join(ROOT, "cache");
const GEOCACHE_PATH = path.join(CACHE_DIR, "geocode-cache.json");

const UA = process.env.JAMO_UA || "JamoEventsBot/1.0 (github actions)";
const NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";

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
  return t >= a - 6 * 3600 * 1000 && t <= b;
}
function makeId(src, title, startIso, lat, lon) {
  const base = `${src}|${norm(title)}|${startIso}|${String(lat).slice(0, 7)}|${String(lon).slice(0, 7)}`;
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
  return `e_${h.toString(16)}`;
}

/* -------------------- Category guessing (esteso) -------------------- */
function guessCategory(title, text) {
  const s = norm(`${title} ${text}`);
  if (!s) return "other";

  // family / kids
  if (/(bambin|family|kids|giochi|children|ragazz|baby|animazion|parco\s?giochi)/.test(s)) return "family";

  // moto / motor
  if (/(motoradun|motogp|moto\s?club|enduro|motocross|vespa|harley|ducati|ride\s?out|biker|motori|moto\s?tour)/.test(s))
    return "moto";

  // bike / cycling
  if (/(ciclotur|cicl|mtb|gravel|bike|bici|pedalat|granfondo|cycl|giro|randonn)/.test(s)) return "bike";

  // sport generico
  if (/(gara|race|marathon|mezza\s?maratona|trail\s?run|running|triathlon|sport|torneo|match|campionato|fitness)/.test(s))
    return "sport";

  // altri
  if (/(sagra|street\s?food|degust|vino|enogastr|food|taste|beer|birra)/.test(s)) return "food";
  if (/(concerto|live|dj|music|festival|show|spettacolo)/.test(s)) return "music";
  if (/(mercatino|market|fiera|expo|fair|artigian)/.test(s)) return "market";
  if (/(mostra|museo|arte|theatre|teatro|cultura|conference|talk|cinema|rassegna|presentazione)/.test(s))
    return "culture";

  return "other";
}

/* -------------------- HTTP fetch helpers -------------------- */
async function fetchText(url, headers = {}) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "*/*", ...headers },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return await r.text();
}
async function fetchJson(url, headers = {}) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json", ...headers },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return await r.json();
}

/* -------------------- Geocoding (Nominatim) cache + 1req/s -------------------- */
async function geocodePlace(q, cache) {
  const key = norm(q);
  if (!key) return null;
  if (cache[key]) return cache[key];

  await sleep(1100);

  const url = `${NOMINATIM_ENDPOINT}?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
  const j = await fetchJson(url).catch(() => null);
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
    if (k === "DTSTART") cur.start = v;
    if (k === "DTEND") cur.end = v;
    if (k === "LOCATION") cur.location = v;
    if (k === "URL") cur.url = v;
    if (k === "DESCRIPTION") cur.description = v;
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

/* -------------------- RSS / ICS sources from events_sources.json -------------------- */
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
      const locCandidate = (desc.match(/(Luogo|Location|Dove)\s*:\s*([^.\n]+)/i)?.[2] || "").trim();
      const q = locCandidate || place;
      if (q) {
        const g = await geocodePlace(q, geocache);
        if (g) {
          lat = g.lat;
          lon = g.lon;
          place = locCandidate || place || g.display;
        }
      }
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const forcedCat = String(src.category || "").trim();

    out.push({
      title,
      start: iso(d),
      end: null,
      lat,
      lon,
      place,
      city: "",
      region: String(src.default_region || ""),
      country_code: String(src.country_code || "").toUpperCase(),
      url: link,
      category: forcedCat || guessCategory(title, desc),
      source: String(src.id || "rss"),
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

    const forcedCat = String(src.category || "").trim();

    out.push({
      title,
      start: iso(sd),
      end: ed ? iso(ed) : null,
      lat,
      lon,
      place: place || "",
      city: "",
      region: String(src.default_region || ""),
      country_code: String(src.country_code || "").toUpperCase(),
      url: link || "",
      category: forcedCat || guessCategory(title, `${place} ${desc}`),
      source: String(src.id || "ics"),
    });
  }
  return out;
}

/* -------------------- Parks.it (Italia) -------------------- */
const IT_REGIONS = [
  { slug: "piemonte", region: "Piemonte" },
  { slug: "valle.d.aosta", region: "Valle d'Aosta" },
  { slug: "lombardia", region: "Lombardia" },
  { slug: "trentino.alto.adige", region: "Trentino-Alto Adige" },
  { slug: "veneto", region: "Veneto" },
  { slug: "friuli.venezia.giulia", region: "Friuli-Venezia Giulia" },
  { slug: "liguria", region: "Liguria" },
  { slug: "emilia-romagna", region: "Emilia-Romagna" },
  { slug: "toscana", region: "Toscana" },
  { slug: "umbria", region: "Umbria" },
  { slug: "marche", region: "Marche" },
  { slug: "lazio", region: "Lazio" },
  { slug: "abruzzo", region: "Abruzzo" },
  { slug: "molise", region: "Molise" },
  { slug: "campania", region: "Campania" },
  { slug: "puglia", region: "Puglia" },
  { slug: "basilicata", region: "Basilicata" },
  { slug: "calabria", region: "Calabria" },
  { slug: "sicilia", region: "Sicilia" },
  { slug: "sardegna", region: "Sardegna" }
];

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

function absolutize(baseUrl, href) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function extractParksIcalUrl(html, baseUrl) {
  const candidates = [];

  // href="..."
  const re1 = /href\s*=\s*"([^"]+)"/gi;
  let m;
  while ((m = re1.exec(html))) {
    const href = m[1];
    const h = href.toLowerCase();
    if (h.includes("ical") || h.endsWith(".ics") || h.includes(".ics?")) {
      candidates.push(absolutize(baseUrl, href));
    }
  }

  // href='...'
  const re2 = /href\s*=\s*'([^']+)'/gi;
  while ((m = re2.exec(html))) {
    const href = m[1];
    const h = href.toLowerCase();
    if (h.includes("ical") || h.endsWith(".ics") || h.includes(".ics?")) {
      candidates.push(absolutize(baseUrl, href));
    }
  }

  // URL .ics in chiaro
  const re3 = /(https?:\/\/[^\s"'<>]+\.ics[^\s"'<>]*)/gi;
  while ((m = re3.exec(html))) candidates.push(m[1]);

  // path relativo con .ics
  const re4 = /([^\s"'<>]+\.ics(?:\?[^\s"'<>]+)?)/gi;
  while ((m = re4.exec(html))) {
    const u = m[1];
    if (u.startsWith("http")) candidates.push(u);
    else candidates.push(absolutize(baseUrl, u));
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
    const regionPage = `https://www.parks.it/regione.${r.slug}/man.php`;

    try {
      const html = await fetchText(regionPage, { "Accept-Language": "it-IT,it;q=0.9,en;q=0.7" });
      const icsUrl = extractParksIcalUrl(html, regionPage);

      if (!icsUrl) {
        console.log(`Parks.it: ${r.region} — NO ICS link found`);
        continue;
      }
      regionsWithIcs++;

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

        // fallback centro regione
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

/* -------------------- MAIN -------------------- */
async function main() {
  const cfg = readJSON(CFG_PATH, null);
  if (!cfg) {
    console.error("❌ events_sources.json mancante.");
    process.exit(2);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const geocache = readJSON(GEOCACHE_PATH, {});
  const now = new Date();
  const daysAhead = Number(cfg.days_ahead || 60);
  const maxEvents = Number(cfg.max_events || 25000);

  const rawOut = [];

  const italyEnabled = !!cfg?.coverage?.italy?.enabled;
  const parksEnabled = !!cfg?.providers?.parks_it?.enabled;

  // 1) Italia automatico (Parks.it)
  if (italyEnabled && parksEnabled) {
    console.log("▶ Building IT events from Parks.it…");
    const evs = await fetchParksItaly(now, daysAhead, geocache).catch(() => []);
    rawOut.push(...evs);
  } else {
    console.log("ℹ Parks.it disabled or Italy coverage disabled.");
  }

  // 2) RSS/ICS extra (EU)
  const localSources = cfg.rss_ics_sources || cfg.sources || [];
  console.log(`▶ Building RSS/ICS sources… sources: ${localSources.length}`);

  for (const src of localSources) {
    const type = String(src.type || "").toLowerCase();
    const url = String(src?.url || "").trim();
    if (!url || !url.startsWith("http")) {
      console.log(`- skip source ${src?.id || "unknown"} (missing/invalid url)`);
      continue;
    }

    const sid = String(src.id || url);
    try {
      const evs =
        type === "rss"
          ? await fetchRssSource(src, now, daysAhead, geocache)
          : type === "ics"
          ? await fetchIcsSource(src, now, daysAhead, geocache)
          : [];

      console.log(`- source OK ${sid} (${type}) → ${evs.length}`);
      rawOut.push(...evs);
    } catch (e) {
      console.log(`- source FAIL ${sid} (${type}) → ${String(e?.message || e)}`);
    }
  }

  // 3) Normalize + dedupe
  const seen = new Set();
  const normalized = [];

  for (const e of rawOut) {
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

    const category = String(e.category || guessCategory(title, e.place)).toLowerCase().trim() || "other";

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
      category,
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
  console.error("❌ Build failed:", e);
  process.exit(1);
});
