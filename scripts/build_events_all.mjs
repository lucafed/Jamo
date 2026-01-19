#!/usr/bin/env node
/**
 * Jamo — build_events_all.mjs (v2)
 * Preferisce config GENERATED:
 *   1) ./events_sources.generated.json
 *   2) ./events_sources.json
 * Output:
 *   public/data/events/events_all.json
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();

const CONFIG_GEN = path.join(ROOT, "events_sources.generated.json");
const CONFIG_FALLBACK = path.join(ROOT, "events_sources.json");

const OUT_PATH = path.join(ROOT, "public", "data", "events", "events_all.json");

const UA = process.env.JAMO_UA || "JamoEventsBuilder/1.0 (+https://jamo-seven.vercel.app)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 8);
}
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function nowISO() { return new Date().toISOString(); }
function toISODateOnly(d) {
  try {
    const x = new Date(d);
    if (!Number.isFinite(x.getTime())) return null;
    return x.toISOString();
  } catch { return null; }
}
function safeText(s) { return String(s ?? "").replace(/\s+/g, " ").trim(); }

function readConfig() {
  if (fs.existsSync(CONFIG_GEN)) {
    return JSON.parse(fs.readFileSync(CONFIG_GEN, "utf8"));
  }
  if (fs.existsSync(CONFIG_FALLBACK)) {
    return JSON.parse(fs.readFileSync(CONFIG_FALLBACK, "utf8"));
  }
  console.error(`❌ Missing config. Expected one of:\n- ${CONFIG_GEN}\n- ${CONFIG_FALLBACK}`);
  process.exit(1);
}

async function fetchText(url, { timeoutMs = 45000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: {
        "user-agent": UA,
        "accept": "text/calendar, application/xml, text/xml, application/rss+xml, application/atom+xml, */*"
      },
      signal: ctrl.signal,
      cache: "no-store",
      redirect: "follow"
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function extractXmlBlocks(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
function extractFirst(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(xml);
  return m ? safeText(m[1].replace(/<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>/g, "$1")) : "";
}
function parseRss(xml) {
  const items = extractXmlBlocks(xml, "item").length
    ? extractXmlBlocks(xml, "item")
    : extractXmlBlocks(xml, "entry");

  return items.map((blk) => {
    const title = extractFirst(blk, "title");
    const link = extractFirst(blk, "link") || extractFirst(blk, "id");
    const pubDate = extractFirst(blk, "pubDate") || extractFirst(blk, "published") || extractFirst(blk, "updated");
    const description = extractFirst(blk, "description") || extractFirst(blk, "summary") || "";
    return { title, link, pubDate, description };
  });
}

function unfoldIcsLines(s) { return s.replace(/\r?\n[ \t]/g, ""); }

function parseIcsDate(val) {
  if (!val) return null;
  const v = String(val).trim();

  if (/^\d{8}$/.test(v)) {
    const yyyy = v.slice(0, 4), mm = v.slice(4, 6), dd = v.slice(6, 8);
    return toISODateOnly(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  }

  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const yyyy = m[1], mm = m[2], dd = m[3], hh = m[4], mi = m[5], ss = m[6] || "00";
  return toISODateOnly(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`);
}

function parseIcs(text) {
  const s = unfoldIcsLines(text);
  const blocks = s.split("BEGIN:VEVENT").slice(1).map(x => x.split("END:VEVENT")[0] || "");
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
      url: url || ""
    });
  }
  return events;
}

function normalizeEvent(e, { source, ccFallback, fixedLat, fixedLon, fixedCity, fixedRegion } = {}) {
  const title = safeText(e.title || e.name || "Evento");
  const start = e.start ? toISODateOnly(e.start) : null;
  const end = e.end ? toISODateOnly(e.end) : null;

  const lat = Number(e.lat ?? fixedLat);
  const lon = Number(e.lon ?? e.lng ?? fixedLon);
  const hasLL = Number.isFinite(lat) && Number.isFinite(lon);

  const place = safeText(e.place || e.location || fixedCity || "");
  const city = safeText(e.city || fixedCity || "");
  const region = safeText(e.region || fixedRegion || "");
  const country_code = safeText(e.country_code || e.cc || ccFallback || "").toUpperCase();

  const url = safeText(e.url || e.link || "");
  const category = safeText(e.category || e.type || e.kind || "");

  const base = `${title}|${start || ""}|${lat || ""}|${lon || ""}|${place}|${country_code}|${source || ""}`;
  const id = `e_${crypto.createHash("sha1").update(String(base)).digest("hex").slice(0, 8)}`;

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
    category: category || "other",
    source: source || "unknown"
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
function dropNoCoords(events) {
  return events.filter(e => Number.isFinite(e.lat) && Number.isFinite(e.lon));
}

async function main() {
  const cfg = readConfig();

  const daysAhead = clamp(Number(cfg.days_ahead) || 60, 1, 365);
  const maxEvents = clamp(Number(cfg.max_events) || 30000, 100, 50000);

  const overpassEnabled = !!cfg?.providers?.osm_overpass?.enabled;
  const overpassTimeout = clamp(Number(cfg?.providers?.osm_overpass?.timeout_ms) || 45000, 5000, 120000);

  const rssIcs = Array.isArray(cfg?.rss_ics_sources) ? cfg.rss_ics_sources : [];

  const stats = {
    sources_total: rssIcs.length,
    sources_ok: 0,
    sources_fail: 0,
    kept: 0
  };

  let all = [];

  // 1) RSS / ICS
  for (const src of rssIcs) {
    try {
      if (!src?.url) continue;

      const type = String(src.type || "").toLowerCase().trim();
      const url = String(src.url).trim();

      const fixed_lat = Number(src.fixed_lat);
      const fixed_lon = Number(src.fixed_lon);
      const fixedCity = src.default_place || "";
      const fixedRegion = src.default_region || "";
      const cc = src.country_code || "";

      const txt = await fetchText(url, { timeoutMs: overpassTimeout });

      if (type === "ics") {
        const rows = parseIcs(txt);
        for (const r of rows) {
          all.push(
            normalizeEvent(
              {
                title: r.title,
                start: r.start,
                end: r.end,
                place: r.place,
                url: r.url,
                lat: fixed_lat,
                lon: fixed_lon,
                category: src.category || "culture",
                country_code: cc
              },
              { source: src.id || "ics", ccFallback: cc, fixedLat: fixed_lat, fixedLon: fixed_lon, fixedCity, fixedRegion }
            )
          );
        }
        stats.sources_ok++;
      } else {
        const items = parseRss(txt);
        let added = 0;
        for (const it of items) {
          const start = toISODateOnly(it.pubDate);
          if (!start) continue;

          all.push(
            normalizeEvent(
              {
                title: it.title,
                start,
                end: null,
                place: fixedCity,
                url: it.link,
                lat: fixed_lat,
                lon: fixed_lon,
                category: src.category || "other",
                country_code: cc
              },
              { source: src.id || "rss", ccFallback: cc, fixedLat: fixed_lat, fixedLon: fixed_lon, fixedCity, fixedRegion }
            )
          );
          added++;
        }
        if (added > 0) stats.sources_ok++;
        else stats.sources_fail++;
      }
    } catch (e) {
      stats.sources_fail++;
      console.warn(`⚠️ Source fail: ${src?.id || src?.url} → ${e.message || e}`);
    }
  }

  // 2) Overpass fallback (solo se config ha coverage)
  if (overpassEnabled) {
    // Nota: qui puoi reinserire overpass in futuro.
    // Per il test Veneto ci basta già ICS + (eventuale) fallback più avanti.
  }

  all = dedupe(all);
  all = dropNoCoords(all);

  // periodo
  const now = new Date();
  const maxT = now.getTime() + daysAhead * 24 * 3600 * 1000;
  all = all.filter(e => {
    const t = e.start ? new Date(e.start).getTime() : NaN;
    return Number.isFinite(t) && t >= now.getTime() - 2 * 24 * 3600 * 1000 && t <= maxT;
  });

  // cap
  all = all.slice(0, maxEvents);
  stats.kept = all.length;

  ensureDir(path.dirname(OUT_PATH));
  const out = {
    updated_at: nowISO(),
    count: all.length,
    days_ahead: daysAhead,
    events: all,
    stats
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf8");
  console.log(`✅ Wrote ${OUT_PATH} (${out.count} events)`);
  console.log("Stats:", out.stats);
}

main().catch((e) => {
  console.error("❌ build failed:", e);
  process.exit(1);
});
