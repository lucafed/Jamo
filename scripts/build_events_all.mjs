// scripts/build_events_all.mjs
// Jamo — Events Builder (IT + EU) — NO API KEY required
// - Italia: Parks.it (auto-scopre link iCal per ogni regione) + geocoding Nominatim con cache
// - Europa: RSS/ICS da events_sources.json (tu aggiungi feed reali)
// - Output: /public/data/events/events_all.json

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
  // tolleranza: includi 6 ore prima per timezone/ICS strani
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
  if (/(bambin|family|kids|giochi|children|ragazz|baby)/.test(s)) return "family";

  // moto / motor
  if (/(motoradun|motogp|moto\s?club|enduro|motocross|vespa|harley|ducati|ride\s?out|biker)/.test(s))
    return "moto";

  // bici / cycling
  if (/(ciclotur|cicl|mtb|gravel|bike|bici|pedalat|granfondo|cycl)/.test(s)) return "bike";

  // sport generico
  if (/(gara|race|marathon|trail\s?run|running|triathlon|sport|torneo|match)/.test(s)) return "sport";

  // altri
  if (/(sagra|street\s?food|degust|vino|enogastr|food|taste)/.test(s)) return "food";
  if (/(concerto|live|dj|music|festival|show)/.test(s)) return "music";
  if (/(mercatino|market|fiera|expo|fair)/.test(s)) return "market";
  if (/(mostra|museo|arte|theatre|teatro|cultura|conference|talk|cinema)/.test(s)) return "culture";

  return "other";
}

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

  // YYYYMMDD
  if (/^\d{8}$/.test(x)) {
    const y = x.slice(0, 4),
      m = x.slice(4, 6),
      d = x.slice(6, 8);
    const dt = new Date(`${y}-${m}-${d}T12:00:00Z`);
    return Number.isFinite(dt.getTime()) ? dt : null;
  }

  // YYYYMMDDTHHMMSSZ? (gestisce anche senza Z)
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

    // Prova ad estrarre un “luogo” dal testo (best effort)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const locCandidate =
        (desc.match(/(Luogo|Location|Dove)\s*:\s*([^.\n]+)/i)?.[2] || "").trim();
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

/* -------------------- Parks.it (Italia auto) -------------------- */
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
  { slug: "sardegna", region: "Sardegna" },
];

function absolutize(baseUrl, href) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

function extractParksIcalUrl(html, baseUrl) {
  // Cerco un href che contenga ical oppure che finisca .ics
  const candidates = [];

  // href="..."
  const re = /href\s*=\s*"([^"]+)"/gi;
  let m;
  while ((m = re.exec(html))) {
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

  return candidates.find(Boolean) || null;
}

async function fetchParksItaly(now, daysAhead, geocache) {
  const out = [];
  let okRegions = 0;

  for (const r of IT_REGIONS) {
    const regionPage = `https://www.parks.it/regione.${r.slug}/man.php`;

    try {
      const html = await fetchText(regionPage);
      const icsUrl = extractParksIcalUrl(html, regionPage);
      if (!icsUrl) {
        console.log(`Parks.it: ${r.region} — NO ICS link found`);
        continue;
      }

      const icsText = await fetchText(icsUrl);
      const evs = parseIcs(icsText);

      let regionCount = 0;

      for (const ev of evs) {
        const title = String(ev.title || "").trim() || "Evento";
        const sd = parseIcsDate(ev.start);
        if (!sd || !withinWindow(sd, now, daysAhead)) continue;

        const ed = parseIcsDate(ev.end);
        const loc = String(ev.location || "").trim();
        const desc = String(ev.description || "").trim();
        const url = String(ev.url || "").trim();

        // Geocoding: senza location non possiamo mappare
        if (!loc) continue;

        const g = await geocodePlace(loc, geocache);
        if (!g) continue;

        out.push({
          title,
          start: iso(sd),
          end: ed ? iso(ed) : null,
          lat: g.lat,
          lon: g.lon,
          place: loc,
          city: "",
          region: r.region,
          country_code: "IT",
          url,
          category: guessCategory(title, `${loc} ${desc}`),
          source: "parks_it",
        });

        regionCount++;
      }

      okRegions++;
      console.log(`Parks.it: ${r.region} — events kept: ${regionCount} (raw VEVENT: ${evs.length})`);
    } catch (e) {
      console.log(`Parks.it: ${r.region} — FAILED: ${String(e?.message || e)}`);
    }

    // piccola pausa per rispettare i server
    await sleep(250);
  }

  console.log(`Parks.it: regions OK ${okRegions}/${IT_REGIONS.length} — total kept: ${out.length}`);
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

  // 1) Italia automatico via Parks.it
  const parksEnabled = !!cfg?.providers?.parks_it?.enabled;
  const italyEnabled = !!cfg?.coverage?.italy?.enabled;

  if (parksEnabled && italyEnabled) {
    console.log("▶ Building IT events from Parks.it…");
    const evs = await fetchParksItaly(now, daysAhead, geocache).catch(() => []);
    rawOut.push(...evs);
  } else {
    console.log("ℹ Parks.it disabled or Italy coverage disabled.");
  }

  // 2) RSS/ICS extra (Italia + Europa)
  const localSources = cfg.rss_ics_sources || cfg.sources || [];
  console.log(`▶ Building RSS/ICS sources… sources: ${localSources.length}`);

  for (const src of localSources) {
    const type = String(src.type || "").toLowerCase();
    if (!src?.url || !String(src.url).includes("http")) {
      console.log(`- skip source ${src?.id || "unknown"} (missing/invalid url)`);
      continue;
    }

    const sid = String(src.id || src.url);
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

  // 3) Normalize + dedupe + cap
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
      source,
    });

    if (normalized.length >= maxEvents) break;
  }

  normalized.sort((a, b) => String(a.start).localeCompare(String(b.start)));

  // salva cache e output
  writeJSON(GEOCACHE_PATH, geocache);
  writeJSON(OUT_PATH, {
    updated_at: new Date().toISOString(),
    count: normalized.length,
    days_ahead: daysAhead,
    events: normalized,
  });

  console.log(`✅ events_all.json scritto: ${normalized.length} eventi → ${OUT_PATH}`);
}

main().catch((e) => {
  console.error("❌ Build failed:", e);
  process.exit(1);
});
