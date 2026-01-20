#!/usr/bin/env node
/**
 * Jamo — build_events_all.mjs (v3.0 SAFE-NO-ZERO)
 *
 * ✅ Legge config:
 *    1) events_sources.generated.json (preferred)
 *    2) events_sources.json (fallback)
 * ✅ Supporta config keys: rss_ics_sources / sources / items
 * ✅ Output: public/data/events/events_all.json
 * ✅ IMPORTANTISSIMO:
 *    - Se il build produce count=0 => NON sovrascrive il file esistente
 *      (scrive un file .tmp e poi decide)
 * ✅ Log chiaro: HTTP status / parsing / quanti eventi presi per source
 *
 * Fonti: RSS + ICS
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();

const CONFIG_GEN = path.join(ROOT, "events_sources.generated.json");
const CONFIG_FALLBACK = path.join(ROOT, "events_sources.json");

const OUT_DIR = path.join(ROOT, "public", "data", "events");
const OUT_PATH = path.join(OUT_DIR, "events_all.json");
const TMP_PATH = path.join(OUT_DIR, "events_all.json.tmp");

const UA =
  process.env.JAMO_UA ||
  "JamoEventsBuilder/3.0 (+https://jamo-seven.vercel.app)";

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
  return crypto
    .createHash("sha1")
    .update(String(s))
    .digest("hex")
    .slice(0, 10);
}

function toNum(x) {
  if (x === null || x === undefined) return NaN;
  if (typeof x === "number") return x;
  const s = String(x).trim();
  if (!s) return NaN;
  const norm = s.replace(",", ".");
  const v = Number(norm);
  return Number.isFinite(v) ? v : NaN;
}

function readConfig() {
  if (fs.existsSync(CONFIG_GEN)) {
    return JSON.parse(fs.readFileSync(CONFIG_GEN, "utf8"));
  }
  if (fs.existsSync(CONFIG_FALLBACK)) {
    return JSON.parse(fs.readFileSync(CONFIG_FALLBACK, "utf8"));
  }
  throw new Error(`Missing config. Expected ${CONFIG_GEN} or ${CONFIG_FALLBACK}`);
}

async function fetchText(url, { timeoutMs = 45000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      headers: {
        "user-agent": UA,
        accept:
          "text/calendar, application/xml, text/xml, application/rss+xml, application/atom+xml, */*",
      },
      signal: ctrl.signal,
      cache: "no-store",
      redirect: "follow",
    });
    const body = await r.text();
    if (!r.ok) {
      const hint = body?.slice?.(0, 180)?.replace(/\s+/g, " ") || "";
      throw new Error(`HTTP ${r.status} ${r.statusText} :: ${hint}`);
    }
    return body;
  } finally {
    clearTimeout(t);
  }
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

  // DATE only: 20260122
  if (/^\d{8}$/.test(v)) {
    const yyyy = v.slice(0, 4);
    const mm = v.slice(4, 6);
    const dd = v.slice(6, 8);
    return toISO(`${assertYYYYMMDD(yyyy, mm, dd)}T00:00:00Z`);
  }

  // DATE-TIME: 20260122T010000Z or 20260122T010000
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;

  const yyyy = m[1],
    mm = m[2],
    dd = m[3],
    hh = m[4],
    mi = m[5],
    ss = m[6] || "00";

  return toISO(`${assertYYYYMMDD(yyyy, mm, dd)}T${hh}:${mi}:${ss}Z`);
}

function assertYYYYMMDD(yyyy, mm, dd) {
  // Solo una safety: evita date impossibili che rompono Date()
  const y = Number(yyyy), m = Number(mm), d = Number(dd);
  if (!(y >= 1900 && y <= 2100)) return `${yyyy}-${mm}-${dd}`;
  if (!(m >= 1 && m <= 12)) return `${yyyy}-${mm}-${dd}`;
  if (!(d >= 1 && d <= 31)) return `${yyyy}-${mm}-${dd}`;
  return `${yyyy}-${mm}-${dd}`;
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

/* ---------------- Normalize + filters ---------------- */

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

  const base = `${title}|${start || ""}|${hasLL ? lat : ""}|${hasLL ? lon : ""}|${place}|${country_code}|${source || ""}`;
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

/* ---------------- MAIN ---------------- */

async function main() {
  const cfg = readConfig();

  const daysAhead = clamp(Number(cfg.days_ahead) || 90, 1, 365);
  const maxEvents = clamp(Number(cfg.max_events) || 50000, 100, 50000);
  const timeoutMs = clamp(Number(cfg?.providers?.osm_overpass?.timeout_ms) || 45000, 5000, 120000);

  // ✅ tollerante: il tuo config usa "sources"
  const sources =
    (Array.isArray(cfg?.rss_ics_sources) && cfg.rss_ics_sources) ||
    (Array.isArray(cfg?.sources) && cfg.sources) ||
    (Array.isArray(cfg?.items) && cfg.items) ||
    [];

  const stats = {
    sources_total: sources.length,
    sources_ok: 0,
    sources_fail: 0,
    per_source: [],
    raw: 0,
    deduped: 0,
    dropped_no_coords: 0,
    dropped_out_of_range: 0,
    kept: 0,
  };

  let all = [];

  const now = new Date();
  const nowT = now.getTime();
  const maxT = nowT + daysAhead * 24 * 3600 * 1000;

  for (const src of sources) {
    const sid = src.id || src.name || src.url || "source";
    let added = 0;

    try {
      if (!src?.url) throw new Error("missing url");

      const type = String(src.type || "").toLowerCase().trim();
      const url = String(src.url).trim();

      const fixed_lat = toNum(src.fixed_lat ?? src.lat);
      const fixed_lon = toNum(src.fixed_lon ?? src.lon);

      const fixedCity = src.default_place || src.city || "";
      const fixedRegion = src.default_region || src.region || "";
      const cc = src.country_code || src.cc || "IT";
      const catFallback = src.category || "other";

      const txt = await fetchText(url, { timeoutMs });

      if (type === "ics") {
        const rows = parseIcs(txt);
        for (const r of rows) {
          const ev = normalizeEvent(
            {
              title: r.title,
              start: r.start,
              end: r.end,
              place: r.place,
              url: r.url,
              lat: fixed_lat,
              lon: fixed_lon,
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
          );

          // range filter subito
          if (!ev.start) continue;
          const t = new Date(ev.start).getTime();
          if (!(Number.isFinite(t) && t >= nowT && t <= maxT)) {
            stats.dropped_out_of_range++;
            continue;
          }

          all.push(ev);
          added++;
        }
      } else if (type === "rss") {
        const items = parseRss(txt);
        for (const it of items) {
          const start = toISO(it.pubDate);
          if (!start) continue;

          const ev = normalizeEvent(
            {
              title: it.title,
              start,
              end: null,
              place: fixedCity,
              url: it.link,
              lat: fixed_lat,
              lon: fixed_lon,
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
          );

          const t = new Date(ev.start).getTime();
          if (!(Number.isFinite(t) && t >= nowT && t <= maxT)) {
            stats.dropped_out_of_range++;
            continue;
          }

          all.push(ev);
          added++;
        }
      } else {
        throw new Error(`unknown type '${type}' (use 'ics' or 'rss')`);
      }

      stats.sources_ok++;
      stats.per_source.push({ id: sid, ok: true, added });
    } catch (e) {
      stats.sources_fail++;
      stats.per_source.push({ id: sid, ok: false, added: 0, error: String(e?.message || e) });
      console.warn(`⚠️ Source FAIL: ${sid} -> ${e?.message || e}`);
    }

    // tiny throttle
    await sleep(150);
  }

  stats.raw = all.length;

  all = dedupe(all);
  stats.deduped = all.length;

  // drop no coords (events.js usa distanza)
  const beforeCoords = all.length;
  all = all.filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon));
  stats.dropped_no_coords = beforeCoords - all.length;

  all = sortEvents(all).slice(0, maxEvents);
  stats.kept = all.length;

  ensureDir(OUT_DIR);

  const out = {
    updated_at: nowISO(),
    count: all.length,
    days_ahead: daysAhead,
    events: all,
    stats,
  };

  // ✅ SCRIVE SEMPRE TMP
  fs.writeFileSync(TMP_PATH, JSON.stringify(out, null, 2), "utf8");

  // ✅ Se count==0 e già esiste un dataset: NON sovrascrivere
  if (!out.count && fs.existsSync(OUT_PATH)) {
    console.error("❌ Build produced count=0. Keeping existing events_all.json. (tmp written)");
    console.error("   Check stats.per_source for errors.");
    process.exit(2); // fa fallire workflow così NON committa
  }

  // ✅ Altrimenti promuove tmp a definitivo
  fs.renameSync(TMP_PATH, OUT_PATH);

  console.log(`✅ Wrote ${OUT_PATH} (${out.count} events)`);
  console.log("Stats:", JSON.stringify(out.stats, null, 2));
}

main().catch((e) => {
  console.error("❌ build failed:", e?.message || e);
  process.exit(1);
});
