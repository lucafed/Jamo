#!/usr/bin/env node
/**
 * Jamo — build_events_all.mjs (v2.4 KEEP-LAST-GOOD)
 *
 * Input config priority:
 *   1) events_sources.generated.json (preferred)
 *   2) events_sources.json (fallback)
 *
 * Output:
 *   public/data/events/events_all.json
 *
 * Key behavior:
 *   ✅ Robust fetch with retries + UA
 *   ✅ Detect "Human Verification"/HTML blocks and mark as blocked
 *   ✅ Per-source stats
 *   ✅ If build produces 0 events => KEEP last good output file (no overwrite, exit 0)
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();

const CONFIG_GEN = path.join(ROOT, "events_sources.generated.json");
const CONFIG_FALLBACK = path.join(ROOT, "events_sources.json");

const OUT_PATH = path.join(ROOT, "public", "data", "events", "events_all.json");
const OUT_DIR = path.dirname(OUT_PATH);

const CACHE_DIR = path.join(ROOT, "cache");
const GEOCACHE_PATH = path.join(CACHE_DIR, "geocode-cache.json");

const UA =
  process.env.JAMO_UA ||
  "JamoEventsBuilder/2.4 (+https://jamo-seven.vercel.app)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function nowISO() {
  return new Date().toISOString();
}

function safeText(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function toISO(d) {
  try {
    const x = new Date(d);
    if (!Number.isFinite(x.getTime())) return null;
    return x.toISOString();
  } catch {
    return null;
  }
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 10);
}

// parse numeri "45,123" -> 45.123
function toNum(x) {
  if (x === null || x === undefined) return NaN;
  if (typeof x === "number") return x;
  const s = String(x).trim();
  if (!s) return NaN;
  const norm = s.replace(",", ".");
  const v = Number(norm);
  return Number.isFinite(v) ? v : NaN;
}

function readJSONIfExists(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function readConfig() {
  const gen = readJSONIfExists(CONFIG_GEN);
  if (gen) return gen;
  const fb = readJSONIfExists(CONFIG_FALLBACK);
  if (fb) return fb;
  throw new Error(`Missing config: ${CONFIG_GEN} or ${CONFIG_FALLBACK}`);
}

// --- Robust fetch with retry + block detection ---
function looksLikeHtml(t) {
  const s = String(t || "").trim().slice(0, 500).toLowerCase();
  return (
    s.startsWith("<!doctype html") ||
    s.startsWith("<html") ||
    s.includes("<head") ||
    s.includes("</html>")
  );
}

function looksBlocked(t) {
  const s = String(t || "").toLowerCase();
  return (
    s.includes("human verification") ||
    s.includes("verify you are human") ||
    s.includes("cloudflare") ||
    s.includes("attention required") ||
    s.includes("captcha") ||
    s.includes("are you a robot")
  );
}

async function fetchText(url, { timeoutMs = 45000, retries = 2 } = {}) {
  const u = String(url).trim().replace(/^webcal:\/\//i, "https://");

  let lastErr = null;

  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const r = await fetch(u, {
        headers: {
          "user-agent": UA,
          accept:
            "text/calendar, application/xml, text/xml, application/rss+xml, application/atom+xml, */*",
          "accept-language": "it-IT,it;q=0.9,en;q=0.7",
        },
        redirect: "follow",
        cache: "no-store",
        signal: ctrl.signal,
      });

      const txt = await r.text();

      if (!r.ok) {
        // spesso i siti rispondono HTML con 403/410 ecc.
        const hint = looksBlocked(txt) ? " (blocked)" : "";
        throw new Error(`HTTP ${r.status}${hint}`);
      }

      // ok ma è html “antibot”
      if (looksLikeHtml(txt) && looksBlocked(txt)) {
        throw new Error("BLOCKED (Human Verification)");
      }

      return txt;
    } catch (e) {
      lastErr = e;
      clearTimeout(t);
      if (i < retries) {
        await sleep(350 + i * 450);
        continue;
      }
    } finally {
      clearTimeout(t);
    }
  }

  throw lastErr || new Error("fetch failed");
}

/* ---------------- RSS parser (light) ---------------- */

function extractXmlBlocks(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function extractFirst(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(block);
  if (!m) return "";
  const txt = String(m[1]).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return safeText(txt);
}

function parseRss(xml) {
  const items = extractXmlBlocks(xml, "item").length
    ? extractXmlBlocks(xml, "item")
    : extractXmlBlocks(xml, "entry");

  return items.map((blk) => {
    const title = extractFirst(blk, "title");
    const link = extractFirst(blk, "link") || extractFirst(blk, "id");
    const pubDate =
      extractFirst(blk, "pubDate") ||
      extractFirst(blk, "published") ||
      extractFirst(blk, "updated");
    const description =
      extractFirst(blk, "description") || extractFirst(blk, "summary") || "";
    return { title, link, pubDate, description };
  });
}

/* ---------------- ICS parser (minimal VEVENT) ---------------- */

function unfoldIcsLines(s) {
  return s.replace(/\r?\n[ \t]/g, "");
}

function parseIcsDate(val) {
  if (!val) return null;
  const v = String(val).trim();

  if (/^\d{8}$/.test(v)) {
    const yyyy = v.slice(0, 4);
    const mm = v.slice(4, 6);
    const dd = v.slice(6, 8);
    return toISO(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  }

  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;

  const yyyy = m[1],
    mm = m[2],
    dd = m[3],
    hh = m[4],
    mi = m[5],
    ss = m[6] || "00";

  // se non ha Z assumiamo UTC (non perfetto ma ok per sorting)
  return toISO(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`);
}

function parseIcs(text) {
  const s = unfoldIcsLines(text);
  const blocks = s
    .split("BEGIN:VEVENT")
    .slice(1)
    .map((x) => x.split("END:VEVENT")[0] || "");

  const events = [];

  for (const b of blocks) {
    const get = (key) => {
      const re = new RegExp(`^${key}(?:;[^:]*)?:(.*)$`, "mi");
      const m = b.match(re);
      return m ? safeText(m[1]) : "";
    };

    const summary = get("SUMMARY");
    const url = get("URL");
    const location = get("LOCATION");
    const dtStartRaw = get("DTSTART");
    const dtEndRaw = get("DTEND");

    const dtStart = parseIcsDate(dtStartRaw);
    const dtEnd = parseIcsDate(dtEndRaw);

    if (!dtStart) continue;

    events.push({
      title: summary || "Evento",
      start: dtStart,
      end: dtEnd || null,
      place: location || "",
      url: url || "",
    });
  }

  return events;
}

/* ---------------- Normalize + dedupe ---------------- */

function normalizeEvent(
  e,
  { source, ccFallback, fixedLat, fixedLon, fixedCity, fixedRegion, categoryFallback } = {}
) {
  const title = safeText(e.title || e.name || "Evento");
  const start = e.start ? toISO(e.start) : null;
  const end = e.end ? toISO(e.end) : null;

  const lat = toNum(e.lat ?? fixedLat);
  const lon = toNum(e.lon ?? e.lng ?? fixedLon);
  const hasLL = Number.isFinite(lat) && Number.isFinite(lon);

  const place = safeText(e.place || e.location || fixedCity || "");
  const city = safeText(e.city || fixedCity || "");
  const region = safeText(e.region || fixedRegion || "");
  const country_code = safeText(e.country_code || e.cc || ccFallback || "").toUpperCase();

  const url = safeText(e.url || e.link || "");
  const category = safeText(e.category || e.type || e.kind || categoryFallback || "other");

  const base = `${title}|${start || ""}|${hasLL ? lat : ""}|${hasLL ? lon : ""}|${place}|${country_code}|${
    source || ""
  }`;
  const id = `e_${sha1(base)}`;

  return {
    id,
    title,
    start: start || null,
    end: end || null,
    lat: hasLL ? lat : null,
    lon: hasLL ? lon : null,
    place,
    city,
    region,
    country_code,
    url,
    category,
    source: source || "unknown",
  };
}

function dedupe(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    if (!e?.id) continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

function sortEvents(rows) {
  rows.sort((a, b) => {
    const ta = a.start ? new Date(a.start).getTime() : 9e15;
    const tb = b.start ? new Date(b.start).getTime() : 9e15;
    if (ta !== tb) return ta - tb;
    return String(a.title).localeCompare(String(b.title));
  });
  return rows;
}

/* ---------------- Geocoding (fallback) ---------------- */

function loadGeoCache() {
  try {
    if (!fs.existsSync(GEOCACHE_PATH)) return {};
    const j = JSON.parse(fs.readFileSync(GEOCACHE_PATH, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

function saveGeoCache(cache) {
  ensureDir(CACHE_DIR);
  fs.writeFileSync(GEOCACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
}

function geoKey(q) {
  return safeText(q).toLowerCase();
}

async function geocodeNominatim(q, { timeoutMs = 45000 } = {}) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(
    q
  )}`;
  const txt = await fetchText(url, { timeoutMs, retries: 1 });
  let arr = [];
  try {
    arr = JSON.parse(txt);
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || !arr.length) return null;
  const it = arr[0];
  const lat = toNum(it.lat);
  const lon = toNum(it.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

async function geocodeIfMissingCoords(e, { timeoutMs, cache }) {
  if (Number.isFinite(e.lat) && Number.isFinite(e.lon)) return e;

  const qParts = [e.place, e.city, e.region, e.country_code, "Italia"]
    .map(safeText)
    .filter(Boolean);

  const q = qParts.join(", ");
  if (!q) return e;

  const k = geoKey(q);
  if (cache[k] && Number.isFinite(cache[k].lat) && Number.isFinite(cache[k].lon)) {
    e.lat = cache[k].lat;
    e.lon = cache[k].lon;
    return e;
  }

  const res = await geocodeNominatim(q, { timeoutMs });
  if (!res) return e;

  cache[k] = { lat: res.lat, lon: res.lon, ts: nowISO() };
  e.lat = res.lat;
  e.lon = res.lon;
  return e;
}

/* ---------------- MAIN ---------------- */

async function main() {
  const cfg = readConfig();

  const daysAhead = clamp(Number(cfg.days_ahead) || 90, 1, 365);
  const maxEvents = clamp(Number(cfg.max_events) || 50000, 100, 50000);
  const timeoutMs = clamp(Number(cfg?.providers?.osm_overpass?.timeout_ms) || 45000, 5000, 120000);

  const rssIcs =
    (Array.isArray(cfg?.rss_ics_sources) && cfg.rss_ics_sources) ||
    (Array.isArray(cfg?.sources) && cfg.sources) ||
    (Array.isArray(cfg?.items) && cfg.items) ||
    [];

  const stats = {
    updated_at: nowISO(),
    sources_total: rssIcs.length,
    sources_ok: 0,
    sources_fail: 0,
    raw: 0,
    deduped: 0,
    kept_window: 0,
    geocoded: 0,
    dropped_no_coords: 0,
    dropped_out_of_range: 0,
    kept: 0,
    per_source: {}, // { id: { ok, fail_reason, raw, kept } }
  };

  let all = [];

  for (const src of rssIcs) {
    const sid = String(src?.id || src?.name || src?.url || "source").slice(0, 120);
    stats.per_source[sid] = { ok: false, fail_reason: "", raw: 0, kept: 0 };

    try {
      if (!src?.url) continue;

      const type = String(src.type || "").toLowerCase().trim();
      const url = String(src.url).trim();

      const fixed_lat = toNum(src.fixed_lat ?? src.fixedLat ?? src.lat);
      const fixed_lon = toNum(src.fixed_lon ?? src.fixedLon ?? src.lon);

      const fixedCity = src.default_place || src.city || "";
      const fixedRegion = src.default_region || src.region || "";
      const cc = src.country_code || src.cc || "";
      const catFallback = src.category || src.cat || "other";

      const txt = await fetchText(url, { timeoutMs, retries: 2 });

      if (type === "ics") {
        const rows = parseIcs(txt);
        for (const r of rows) {
          all.push(
            normalizeEvent(
              {
                title: r.title,
                start: r.start,
                end: r.end,
                place: r.place || fixedCity,
                url: r.url,
                lat: Number.isFinite(fixed_lat) ? fixed_lat : null,
                lon: Number.isFinite(fixed_lon) ? fixed_lon : null,
                category: catFallback,
                country_code: cc,
              },
              {
                source: sid,
                ccFallback: cc,
                fixedLat: fixed_lat,
                fixedLon: fixed_lon,
                fixedCity,
                fixedRegion,
                categoryFallback: catFallback,
              }
            )
          );
        }
        stats.sources_ok++;
        stats.per_source[sid].ok = true;
        stats.per_source[sid].raw = rows.length;
      } else if (type === "rss") {
        const items = parseRss(txt);
        let added = 0;

        for (const it of items) {
          const start = toISO(it.pubDate);
          if (!start) continue;
          all.push(
            normalizeEvent(
              {
                title: it.title,
                start,
                end: null,
                place: fixedCity,
                url: it.link,
                lat: Number.isFinite(fixed_lat) ? fixed_lat : null,
                lon: Number.isFinite(fixed_lon) ? fixed_lon : null,
                category: catFallback,
                country_code: cc,
              },
              {
                source: sid,
                ccFallback: cc,
                fixedLat: fixed_lat,
                fixedLon: fixed_lon,
                fixedCity,
                fixedRegion,
                categoryFallback: catFallback,
              }
            )
          );
          added++;
        }

        if (added > 0) {
          stats.sources_ok++;
          stats.per_source[sid].ok = true;
          stats.per_source[sid].raw = added;
        } else {
          stats.sources_fail++;
          stats.per_source[sid].fail_reason = "RSS parsed but no dated items";
        }
      } else {
        // ignore unknown type
        stats.sources_fail++;
        stats.per_source[sid].fail_reason = `Unknown type: ${type || "(empty)"}`;
      }

      await sleep(180);
    } catch (e) {
      stats.sources_fail++;
      stats.per_source[sid].fail_reason = String(e?.message || e);
      console.warn(`⚠️ Source FAIL: ${sid} -> ${stats.per_source[sid].fail_reason}`);
      await sleep(220);
    }
  }

  stats.raw = all.length;
  all = dedupe(all);
  stats.deduped = all.length;

  // time window: keep ONLY [now .. now+daysAhead]
  const now = new Date();
  const nowT = now.getTime();
  const maxT = nowT + daysAhead * 24 * 3600 * 1000;

  all = all.filter((e) => {
    if (!e.start) return false;
    const t = new Date(e.start).getTime();
    const ok = Number.isFinite(t) && t >= nowT && t <= maxT;
    if (!ok) stats.dropped_out_of_range++;
    return ok;
  });
  stats.kept_window = all.length;

  // geocode fallback for missing coords
  const cache = loadGeoCache();
  let geocoded = 0;

  for (const e of all) {
    const before = Number.isFinite(e.lat) && Number.isFinite(e.lon);
    if (before) continue;

    await geocodeIfMissingCoords(e, { timeoutMs, cache });
    const after = Number.isFinite(e.lat) && Number.isFinite(e.lon);
    if (after) {
      geocoded++;
      await sleep(140);
    } else {
      await sleep(35);
    }
  }

  stats.geocoded = geocoded;
  saveGeoCache(cache);

  // drop events without coords (events.js needs coords for distance)
  all = all.filter((e) => {
    const ok = Number.isFinite(e.lat) && Number.isFinite(e.lon);
    if (!ok) stats.dropped_no_coords++;
    return ok;
  });

  all = sortEvents(all).slice(0, maxEvents);
  stats.kept = all.length;

  // ✅ KEEP LAST GOOD if empty
  const prev = readJSONIfExists(OUT_PATH);
  const prevCount = Number(prev?.count || 0);

  if (stats.kept === 0) {
    if (prevCount > 0) {
      console.log(
        `⚠️ Build produced count=0. Keeping existing events_all.json (count=${prevCount}).`
      );
      // also update a small stamp in console, but do not overwrite file
      return;
    }

    // if even previous is empty, still write (but you’ll see why in stats)
    console.log("⚠️ Build produced count=0 and no previous dataset exists. Writing empty dataset.");
  }

  ensureDir(OUT_DIR);
  const out = {
    updated_at: nowISO(),
    count: all.length,
    days_ahead: daysAhead,
    events: all,
    stats,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf8");
  console.log(`✅ Wrote ${OUT_PATH} (${out.count} events)`);
  console.log("Stats:", out.stats);
}

main().catch((e) => {
  console.error("❌ build failed:", e);
  process.exit(1);
});
