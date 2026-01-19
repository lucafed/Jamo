#!/usr/bin/env node
/**
 * Jamo — build_events_all.mjs (v2.1 FIXED)
 * - Config:
 *    1) events_sources.generated.json (preferred)
 *    2) events_sources.json (fallback)
 * - Output: public/data/events/events_all.json
 * - Sources: RSS + ICS (Overpass gestito via config, ma qui lo lasciamo spento di default)
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();

const CONFIG_GEN = path.join(ROOT, "events_sources.generated.json");
const CONFIG_FALLBACK = path.join(ROOT, "events_sources.json");
const OUT_PATH = path.join(ROOT, "public", "data", "events", "events_all.json");

const UA = process.env.JAMO_UA || "JamoEventsBuilder/2.1 (+https://jamo-seven.vercel.app)";
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

function toISODateOnly(d) {
  try {
    const x = new Date(d);
    if (!Number.isFinite(x.getTime())) return null;
    return x.toISOString();
  } catch {
    return null;
  }
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 8);
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
        "accept": "text/calendar, application/xml, text/xml, application/rss+xml, application/atom+xml, */*",
      },
      signal: ctrl.signal,
      cache: "no-store",
      redirect: "follow",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- RSS parser (light, safe) ---------------- */

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

  // ✅ FIX: regex CDATA corretta (NO doppio escaping)
  const txt = String(m[1]).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return safeText(txt);
}

function parseRss(xml) {
  const items = extractXmlBlocks(xml, "item").length
    ? extractXmlBlocks(xml, "item")
    : extractXmlBlocks(xml, "entry"); // atom-ish

  return items.map((blk) => {
    const title = extractFirst(blk, "title");
    const link = extractFirst(blk, "link") || extractFirst(blk, "id");
    const pubDate =
      extractFirst(blk, "pubDate") || extractFirst(blk, "published") || extractFirst(blk, "updated");
    const description = extractFirst(blk, "description") || extractFirst(blk, "summary") || "";
    return { title, link, pubDate, description };
  });
}

/* ---------------- ICS parser (minimal VEVENT) ---------------- */

function unfoldIcsLines(s) {
  // RFC5545 unfold: lines that start with space/tab are continuations
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
    return toISODateOnly(`${yyyy}-${mm}-${dd}T00:00:00Z`);
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
  // trattiamo come UTC per semplicità
  return toISODateOnly(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`);
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
  const category = safeText(e.category || e.type || e.kind || categoryFallback || "other");

  const base = `${title}|${start || ""}|${lat || ""}|${lon || ""}|${place}|${country_code}|${source || ""}`;
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

function dropNoCoords(events) {
  // events.js richiede lat/lon per distanza
  return events.filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon));
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

  const rssIcs = Array.isArray(cfg?.rss_ics_sources) ? cfg.rss_ics_sources : [];

  const stats = {
    sources_total: rssIcs.length,
    sources_ok: 0,
    sources_fail: 0,
    kept: 0,
  };

  let all = [];

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
      const catFallback = src.category || "other";

      const txt = await fetchText(url, { timeoutMs });

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
                category: catFallback,
                country_code: cc,
              },
              {
                source: src.id || "ics",
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
      } else if (type === "rss") {
        const items = parseRss(txt);
        let added = 0;

        for (const it of items) {
          const start = toISODateOnly(it.pubDate);
          if (!start) continue; // RSS senza data => scarto (per evitare rumore)
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
                category: catFallback,
                country_code: cc,
              },
              {
                source: src.id || "rss",
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

        if (added > 0) stats.sources_ok++;
        else stats.sources_fail++;
      } else {
        // ignore unknown type
      }

      await sleep(120);
    } catch (e) {
      stats.sources_fail++;
      console.warn(`⚠️ Source fail: ${src?.id || src?.url} → ${e.message || e}`);
    }
  }

  all = dedupe(all);
  all = dropNoCoords(all);

  const now = new Date();
  const maxT = now.getTime() + daysAhead * 24 * 3600 * 1000;

  // Keep only in range (start required here)
  all = all.filter((e) => {
    if (!e.start) return false;
    const t = new Date(e.start).getTime();
    return Number.isFinite(t) && t <= maxT;
  });

  all = sortEvents(all).slice(0, maxEvents);
  stats.kept = all.length;

  ensureDir(path.dirname(OUT_PATH));
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
