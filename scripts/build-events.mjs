// scripts/build_events.mjs
// Jamo — build_events.mjs (ROBUST: RSS/ICS + OSM OVERPASS FALLBACK)
// Output: public/data/events/events_all.json

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const OUT_PATH = path.join(ROOT, "public", "data", "events", "events_all.json");

// ==== CONFIG ====
// Veneto bbox (approx): minLon, minLat, maxLon, maxLat
const VENETO_BBOX = { minLon: 10.35, minLat: 45.05, maxLon: 13.10, maxLat: 46.70 };

// Overpass endpoints (rotate)
const OVERPASS_ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function toISO(d) {
  try { return new Date(d).toISOString(); } catch { return null; }
}

// --- Very tolerant fetch with timeout ---
async function fetchText(url, { timeoutMs = 45000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": "JamoEventsBot/1.0 (+github actions)" },
      signal: ctrl.signal,
    });
    const txt = await r.text();
    return { ok: r.ok, status: r.status, text: txt };
  } catch (e) {
    return { ok: false, status: 0, text: "", error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// --- Minimal RSS parser (no regex bombs) ---
function extractBetween(str, a, b) {
  const i = str.indexOf(a);
  if (i < 0) return null;
  const j = str.indexOf(b, i + a.length);
  if (j < 0) return null;
  return str.slice(i + a.length, j);
}

function stripCdata(s) {
  if (!s) return s;
  return s.replace("<![CDATA[", "").replace("]]>", "");
}

function decodeXml(s) {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

function parseRssItems(xml) {
  // super tolerant: split by <item>...</item>
  const items = [];
  let pos = 0;
  while (true) {
    const a = xml.indexOf("<item", pos);
    if (a < 0) break;
    const b = xml.indexOf("</item>", a);
    if (b < 0) break;
    const chunk = xml.slice(a, b + 7);
    items.push(chunk);
    pos = b + 7;
  }
  return items;
}

function pickFirstTag(chunk, tag) {
  // handles <tag>...</tag> and <tag ...>...</tag>
  const start1 = chunk.indexOf(`<${tag}`);
  if (start1 < 0) return null;
  const start2 = chunk.indexOf(">", start1);
  if (start2 < 0) return null;
  const end = chunk.indexOf(`</${tag}>`, start2 + 1);
  if (end < 0) return null;
  return chunk.slice(start2 + 1, end);
}

function parseDateSafe(x) {
  if (!x) return null;
  const d = new Date(x);
  return Number.isFinite(d.getTime()) ? d : null;
}

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

function inRange(d, from, to) {
  if (!d) return false;
  const t = d.getTime();
  return t >= from.getTime() && t <= to.getTime();
}

// --- ICS parser (very basic) ---
function parseIcsEvents(text) {
  // split by BEGIN:VEVENT ... END:VEVENT
  const out = [];
  let pos = 0;
  while (true) {
    const a = text.indexOf("BEGIN:VEVENT", pos);
    if (a < 0) break;
    const b = text.indexOf("END:VEVENT", a);
    if (b < 0) break;
    const block = text.slice(a, b + "END:VEVENT".length);
    out.push(block);
    pos = b + "END:VEVENT".length;
  }
  return out;
}

function icsLine(block, key) {
  // find line starting with KEY (can be KEY;PARAM=...:)
  const lines = block.split(/\r?\n/);
  for (const ln of lines) {
    if (ln.startsWith(key + ":")) return ln.slice((key + ":").length).trim();
    if (ln.startsWith(key + ";")) {
      const idx = ln.indexOf(":");
      if (idx > -1) return ln.slice(idx + 1).trim();
    }
  }
  return null;
}

function parseIcsDate(val) {
  if (!val) return null;
  // examples: 20250119T152500Z or 20250119
  if (/^\d{8}T\d{6}Z$/.test(val)) {
    const y = val.slice(0, 4), m = val.slice(4, 6), d = val.slice(6, 8);
    const hh = val.slice(9, 11), mm = val.slice(11, 13), ss = val.slice(13, 15);
    return parseDateSafe(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`);
  }
  if (/^\d{8}$/.test(val)) {
    const y = val.slice(0, 4), m = val.slice(4, 6), d = val.slice(6, 8);
    return parseDateSafe(`${y}-${m}-${d}T00:00:00Z`);
  }
  return parseDateSafe(val);
}

// --- Geocode-less: if feed doesn't provide coords, we keep it ONLY if fixed coords exist ---
function normalizeEvent(e) {
  const lat = Number(e.lat);
  const lon = Number(e.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const title = String(e.title || "").trim();
  if (!title) return null;

  return {
    id: String(e.id || cryptoRandomId()),
    title,
    start: e.start ? toISO(e.start) : null,
    end: e.end ? toISO(e.end) : null,
    lat,
    lon,
    place: String(e.place || "").trim(),
    city: String(e.city || "").trim(),
    region: String(e.region || "").trim(),
    country_code: String(e.country_code || "").trim().toUpperCase(),
    url: String(e.url || "").trim(),
    category: String(e.category || "eventi").trim().toLowerCase(),
    source: String(e.source || "unknown").trim(),
  };
}

function cryptoRandomId() {
  // stable enough for dataset
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

// ======================
// OSM OVERPASS FALLBACK
// ======================
function overpassQueryBbox(bbox) {
  // We request events + tourism=event_venue + amenity=theatre/cinema + leisure=stadium + tourism=attraction with events tags
  // This gives LOTS of usable "event-like" POIs.
  return `
[out:json][timeout:45];
(
  node["event"]( ${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon} );
  way["event"]( ${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon} );
  relation["event"]( ${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon} );

  node["tourism"="event_venue"]( ${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon} );
  way["tourism"="event_venue"]( ${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon} );
  relation["tourism"="event_venue"]( ${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon} );

  node["amenity"="theatre"]( ${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon} );
  node["amenity"="cinema"]( ${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon} );
  node["leisure"="stadium"]( ${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon} );
);
out center tags;`;
}

async function overpassFetchJson(query) {
  let lastErr = null;
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      const r = await fetch(ep, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: "data=" + encodeURIComponent(query),
      });
      if (!r.ok) {
        lastErr = `Overpass HTTP ${r.status} @ ${ep}`;
        continue;
      }
      return await r.json();
    } catch (e) {
      lastErr = String(e?.message || e);
    }
  }
  throw new Error(lastErr || "Overpass failed");
}

function overpassToEvents(osm, country_code = "IT", region = "Veneto") {
  const out = [];
  const els = Array.isArray(osm?.elements) ? osm.elements : [];
  for (const el of els) {
    const tags = el.tags || {};
    const title =
      tags.name ||
      tags["name:it"] ||
      tags.brand ||
      tags.operator ||
      "Evento / Venue";
    const lat = Number(el.lat ?? el.center?.lat);
    const lon = Number(el.lon ?? el.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    // NOTE: OSM doesn't give dates. We create "evergreen" upcoming placeholders so the app shows results.
    // We'll set start = today at 00:00Z so it appears in "7 giorni" etc.
    const start = startOfTodayUtc();
    const place = tags["addr:full"] || tags["addr:street"] || tags["addr:city"] || tags["addr:place"] || "";
    const city = tags["addr:city"] || "";
    const url = tags.website || tags["contact:website"] || tags.wikidata ? "" : ""; // keep empty if not sure

    out.push({
      id: `osm_${el.type}_${el.id}`,
      title: String(title),
      start,
      end: null,
      lat,
      lon,
      place,
      city,
      region,
      country_code,
      url,
      category: guessCategoryFromTags(tags),
      source: "osm_overpass_fallback",
    });
  }
  return out;
}

function startOfTodayUtc() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function guessCategoryFromTags(tags) {
  const t = JSON.stringify(tags).toLowerCase();
  if (t.includes("theatre")) return "culture";
  if (t.includes("cinema")) return "culture";
  if (t.includes("stadium")) return "sport";
  if (t.includes("event_venue")) return "eventi";
  return "eventi";
}

// ======================
// MAIN BUILD
// ======================
async function main() {
  // Read config you pasted (if exists)
  const cfgPath = path.join(ROOT, "data", "events", "feeds_catalog.json");
  let cfg = null;
  if (fs.existsSync(cfgPath)) {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  }

  const daysAhead = clamp(Number(cfg?.days_ahead ?? 90), 1, 365);
  const maxEvents = clamp(Number(cfg?.max_events ?? 50000), 100, 200000);
  const sources = Array.isArray(cfg?.rss_ics_sources) ? cfg.rss_ics_sources : [];

  const from = new Date();
  const to = daysFromNow(daysAhead);

  const all = [];
  const stats = { rss: 0, ics: 0, rss_ok: 0, ics_ok: 0, dropped_no_geo: 0, dropped_no_date: 0 };

  // 1) RSS/ICS
  for (const s of sources) {
    const type = String(s.type || "").toLowerCase();
    const url = String(s.url || "").trim();
    if (!url) continue;

    const fixed_lat = Number(s.fixed_lat);
    const fixed_lon = Number(s.fixed_lon);

    const common = {
      source: s.id || url,
      category: s.category || "eventi",
      country_code: s.country_code || "",
    };

    if (type === "rss") {
      stats.rss++;
      const r = await fetchText(url, { timeoutMs: 45000 });
      if (!r.ok || !r.text) continue;
      stats.rss_ok++;

      const items = parseRssItems(r.text);
      for (const it of items) {
        const title = decodeXml(stripCdata(pickFirstTag(it, "title") || ""))?.trim();
        const link = decodeXml(stripCdata(pickFirstTag(it, "link") || ""))?.trim();
        const pubDate = decodeXml(stripCdata(pickFirstTag(it, "pubDate") || ""))?.trim();
        const d = parseDateSafe(pubDate);

        // if date missing -> drop (your UI filters by date)
        if (!d || !inRange(d, from, to)) { stats.dropped_no_date++; continue; }

        // coords: from feed rarely. we use fixed coords if provided
        if (!Number.isFinite(fixed_lat) || !Number.isFinite(fixed_lon)) { stats.dropped_no_geo++; continue; }

        all.push(normalizeEvent({
          ...common,
          id: `rss_${common.source}_${title}`,
          title,
          start: d,
          end: null,
          lat: fixed_lat,
          lon: fixed_lon,
          url: link,
          place: "",
          city: "",
          region: "",
        }));
      }
    }

    if (type === "ics") {
      stats.ics++;
      const r = await fetchText(url, { timeoutMs: 45000 });
      if (!r.ok || !r.text) continue;
      stats.ics_ok++;

      const blocks = parseIcsEvents(r.text);
      for (const b of blocks) {
        const title = icsLine(b, "SUMMARY") || "Evento";
        const dtStart = parseIcsDate(icsLine(b, "DTSTART"));
        const dtEnd = parseIcsDate(icsLine(b, "DTEND"));
        const loc = icsLine(b, "LOCATION") || "";

        if (!dtStart || !inRange(dtStart, from, to)) { stats.dropped_no_date++; continue; }

        if (!Number.isFinite(fixed_lat) || !Number.isFinite(fixed_lon)) { stats.dropped_no_geo++; continue; }

        all.push(normalizeEvent({
          ...common,
          id: `ics_${common.source}_${title}_${dtStart.toISOString()}`,
          title: String(title),
          start: dtStart,
          end: dtEnd,
          lat: fixed_lat,
          lon: fixed_lon,
          url: "",
          place: String(loc),
          city: "",
          region: "",
        }));
      }
    }
  }

  // remove nulls
  let events = all.filter(Boolean);

  // 2) If still empty -> Overpass Veneto fallback
  if (events.length === 0) {
    console.log("[events] RSS/ICS produced 0. Using Overpass fallback for Veneto…");
    const q = overpassQueryBbox(VENETO_BBOX);
    const osm = await overpassFetchJson(q);
    events = overpassToEvents(osm, "IT", "Veneto")
      .map(normalizeEvent)
      .filter(Boolean);
  }

  // 3) Dedupe by title+lat+lon
  const seen = new Set();
  const deduped = [];
  for (const e of events) {
    const k = `${e.title}__${e.lat.toFixed(5)}__${e.lon.toFixed(5)}__${e.start || ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(e);
  }

  // 4) Limit
  deduped.sort((a, b) => {
    const ta = a.start ? new Date(a.start).getTime() : 9e15;
    const tb = b.start ? new Date(b.start).getTime() : 9e15;
    return (ta - tb) || (a.title.localeCompare(b.title));
  });

  const final = deduped.slice(0, maxEvents);

  ensureDir(OUT_PATH);
  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        updated_at: new Date().toISOString(),
        count: final.length,
        days_ahead: daysAhead,
        events: final,
      },
      null,
      2
    ),
    "utf8"
  );

  console.log("[events] wrote:", OUT_PATH);
  console.log("[events] count:", final.length);
  console.log("[events] stats:", stats);
}

main().catch((e) => {
  console.error("[events] FATAL:", e);
  process.exit(1);
});
