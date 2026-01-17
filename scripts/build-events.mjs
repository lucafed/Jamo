import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const SOURCES_PATH = path.join(ROOT, "events_sources.json");
const OUT_DIR = path.join(ROOT, "public", "data", "events");
const OUT_PATH = path.join(OUT_DIR, "events_it.json");
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

function parseDateMaybe(x) {
  const s = String(x || "").trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

function iso(d) { return d.toISOString(); }

function withinWindow(d, now, daysAhead) {
  const t = d.getTime();
  const a = now.getTime();
  const b = a + daysAhead * 24 * 3600 * 1000;
  return t >= a - 6 * 3600 * 1000 && t <= b; // tolleranza 6h
}

// --- Minimal RSS parser (senza dipendenze) ---
function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1].trim() : "";
}
function stripCdata(s) {
  return String(s || "").replace(/^<!\[CDATA\[/i, "").replace(/\]\]>$/i, "").trim();
}
function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function splitItems(xml) {
  // RSS: <item>...</item>
  const items = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) items.push(m[1]);
  return items;
}

async function fetchText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "*/*" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return await r.text();
}

// --- Minimal ICS parser (line-based) ---
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

// ICS date formats: 20260117T203000Z or 20260117
function parseIcsDate(s) {
  const x = String(s || "").trim();
  if (!x) return null;
  // YYYYMMDD
  if (/^\d{8}$/.test(x)) {
    const y = x.slice(0,4), m = x.slice(4,6), d = x.slice(6,8);
    const dt = new Date(`${y}-${m}-${d}T12:00:00Z`);
    return Number.isFinite(dt.getTime()) ? dt : null;
  }
  // YYYYMMDDTHHMMSSZ or without Z
  if (/^\d{8}T\d{6}Z?$/.test(x)) {
    const y = x.slice(0,4), mo = x.slice(4,6), d = x.slice(6,8);
    const hh = x.slice(9,11), mm = x.slice(11,13), ss = x.slice(13,15);
    const z = x.endsWith("Z") ? "Z" : "";
    const dt = new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss}${z}`);
    return Number.isFinite(dt.getTime()) ? dt : null;
  }
  // fallback
  return parseDateMaybe(x);
}

// --- Geocoding (Nominatim) con cache + rate limit ---
async function geocodePlace(q, cache) {
  const key = norm(q);
  if (!key) return null;

  if (cache[key]) return cache[key];

  // rate limit gentile
  await sleep(1100);

  const url = `${NOMINATIM_ENDPOINT}?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "application/json"
    }
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const first = Array.isArray(j) && j[0] ? j[0] : null;
  if (!first) return null;

  const lat = Number(first.lat);
  const lon = Number(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const out = { lat, lon, display: first.display_name || "" };
  cache[key] = out;
  return out;
}

// --- Normalizzazione eventi output (schema per la tua app) ---
function makeId(srcId, title, startIso, lat, lon) {
  const base = `${srcId}|${norm(title)}|${startIso}|${String(lat).slice(0,7)}|${String(lon).slice(0,7)}`;
  // hash semplice
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
  return `e_${h.toString(16)}`;
}

function guessCategory(title, text) {
  const s = norm(`${title} ${text}`);
  if (!s) return "other";
  if (/(sagra|street food|degust|vino|enogastr)/.test(s)) return "food";
  if (/(concerto|live|dj|music|festival)/.test(s)) return "music";
  if (/(mercatino|market|fiera|expo)/.test(s)) return "market";
  if (/(mostra|museo|arte|teatro|cultura|convegno)/.test(s)) return "culture";
  if (/(bambin|family|kids|giochi)/.test(s)) return "family";
  return "other";
}

async function main() {
  const cfg = readJSON(SOURCES_PATH, null);
  if (!cfg?.sources?.length) {
    console.error("events_sources.json mancante o vuoto.");
    process.exit(2);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const geocache = readJSON(GEOCACHE_PATH, {});
  const now = new Date();
  const daysAhead = Number(cfg.days_ahead || 60);
  const maxEvents = Number(cfg.max_events || 5000);

  const out = [];
  const seen = new Set();

  for (const src of cfg.sources) {
    const id = String(src.id || "").trim();
    const type = String(src.type || "").trim().toLowerCase();
    const url = String(src.url || "").trim();
    if (!id || !type || !url) continue;

    try {
      const txt = await fetchText(url);

      if (type === "rss") {
        const items = splitItems(txt);
        for (const it of items) {
          const title = stripHtml(stripCdata(extractTag(it, "title")));
          const link = stripCdata(extractTag(it, "link")) || src.homepage || "";
          const pubDateRaw = stripCdata(extractTag(it, "pubDate")) || stripCdata(extractTag(it, "dc:date"));
          const desc = stripHtml(stripCdata(extractTag(it, "description")));
          const d = parseDateMaybe(pubDateRaw) || parseDateMaybe(extractTag(it, "published")) || null;
          if (!d || !withinWindow(d, now, daysAhead)) continue;

          const locationHint = src.default_place || "";
          let lat = Number(src.fixed_lat);
          let lon = Number(src.fixed_lon);
          let place = String(src.default_place || "").trim();

          if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            // prova a trovare una location nel testo
            const locCandidate = (desc.match(/(Luogo|Location|Dove)\s*:\s*([^.\n]+)/i)?.[2] || "").trim();
            const q = locCandidate || locationHint;
            if (q) {
              const g = await geocodePlace(q, geocache);
              if (g) { lat = g.lat; lon = g.lon; place = locCandidate || src.default_place || g.display; }
            }
          }

          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue; // senza coordinate non serve alla tua app

          const startIso = iso(d);
          const eid = makeId(id, title, startIso, lat, lon);
          if (seen.has(eid)) continue;
          seen.add(eid);

          out.push({
            id: eid,
            title: title || "Evento",
            start: startIso,
            end: null,
            lat,
            lon,
            place: place || src.default_place || "",
            region: src.default_region || "",
            url: link,
            category: guessCategory(title, desc),
            source: id
          });

          if (out.length >= maxEvents) break;
        }
      }

      if (type === "ics") {
        const evs = parseIcs(txt);
        for (const ev of evs) {
          const title = String(ev.title || "").trim();
          const sd = parseIcsDate(ev.start);
          if (!sd || !withinWindow(sd, now, daysAhead)) continue;

          const ed = parseIcsDate(ev.end);
          const loc = String(ev.location || src.default_place || "").trim();
          const link = String(ev.url || src.homepage || "").trim();

          let lat = Number(src.fixed_lat);
          let lon = Number(src.fixed_lon);
          let place = loc || src.default_place || "";

          if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            if (place) {
              const g = await geocodePlace(place, geocache);
              if (g) { lat = g.lat; lon = g.lon; }
            }
          }

          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

          const startIso = iso(sd);
          const eid = makeId(id, title, startIso, lat, lon);
          if (seen.has(eid)) continue;
          seen.add(eid);

          out.push({
            id: eid,
            title: title || "Evento",
            start: startIso,
            end: ed ? iso(ed) : null,
            lat,
            lon,
            place: place || "",
            region: src.default_region || "",
            url: link || "",
            category: guessCategory(title, place),
            source: id
          });

          if (out.length >= maxEvents) break;
        }
      }

    } catch (e) {
      console.error(`Source ${id} failed:`, e?.message || e);
    }
  }

  // sort + pulizia
  out.sort((a, b) => String(a.start).localeCompare(String(b.start)));

  writeJSON(GEOCACHE_PATH, geocache);
  writeJSON(OUT_PATH, { updated_at: new Date().toISOString(), count: out.length, events: out });

  console.log(`✅ events_it.json scritto: ${out.length} eventi`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
