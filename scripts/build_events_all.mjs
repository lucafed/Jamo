#!/usr/bin/env node
/**
 * Jamo — build_events_all.mjs v3.0 (SAFE-NONEMPTY)
 * - Legge events_sources.generated.json (o events_sources.json)
 * - Prova a scaricare RSS/ICS
 * - Se non ottiene nulla:
 *    ✅ se esiste già public/data/events/events_all.json => NON lo sovrascrive
 *    ✅ se non esiste => crea un dataset vuoto MA non cancella quello seed che hai in repo
 *
 * NB: Le fonti italiane spesso bloccano GitHub Actions (403/405/410).
 * Questo script è progettato per NON distruggere il dataset offline.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();
const CONFIG_GEN = path.join(ROOT, "events_sources.generated.json");
const CONFIG_FALLBACK = path.join(ROOT, "events_sources.json");
const OUT_PATH = path.join(ROOT, "public", "data", "events", "events_all.json");

const UA = process.env.JAMO_UA || "JamoEventsBuilder/3.0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function nowISO() { return new Date().toISOString(); }
function safeText(s) { return String(s ?? "").replace(/\s+/g, " ").trim(); }
function sha1(s) { return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 8); }
function toISO(d) {
  try {
    const x = new Date(d);
    if (!Number.isFinite(x.getTime())) return null;
    return x.toISOString();
  } catch { return null; }
}
function readConfig() {
  if (fs.existsSync(CONFIG_GEN)) return JSON.parse(fs.readFileSync(CONFIG_GEN, "utf8"));
  if (fs.existsSync(CONFIG_FALLBACK)) return JSON.parse(fs.readFileSync(CONFIG_FALLBACK, "utf8"));
  return { days_ahead: 90, max_events: 50000, sources: [] };
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

/* ------------ RSS minimal ------------ */

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
  const items = extractXmlBlocks(xml, "item").length ? extractXmlBlocks(xml, "item") : extractXmlBlocks(xml, "entry");
  return items.map((blk) => {
    const title = extractFirst(blk, "title");
    const link = extractFirst(blk, "link") || extractFirst(blk, "id");
    const pubDate = extractFirst(blk, "pubDate") || extractFirst(blk, "published") || extractFirst(blk, "updated");
    return { title, link, pubDate };
  });
}

/* ------------ ICS minimal VEVENT ------------ */

function unfoldIcsLines(s) { return s.replace(/\r?\n[ \t]/g, ""); }
function parseIcsDate(val) {
  if (!val) return null;
  const v = String(val).trim();
  if (/^\d{8}$/.test(v)) return toISO(`${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}T00:00:00Z`);
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  return toISO(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || "00"}Z`);
}
function parseIcs(text) {
  const s = unfoldIcsLines(text);
  const blocks = s.split("BEGIN:VEVENT").slice(1).map((x) => x.split("END:VEVENT")[0] || "");
  const out = [];
  for (const b of blocks) {
    const get = (key) => {
      const re = new RegExp(`^${key}(?:;[^:]*)?:(.*)$`, "mi");
      const m = b.match(re);
      return m ? safeText(m[1]) : "";
    };
    const summary = get("SUMMARY");
    const location = get("LOCATION");
    const url = get("URL");
    const dtStart = parseIcsDate(get("DTSTART"));
    const dtEnd = parseIcsDate(get("DTEND"));
    if (!dtStart) continue;
    out.push({ title: summary || "Evento", start: dtStart, end: dtEnd || null, place: location || "", url: url || "" });
  }
  return out;
}

function normalizeEvent(e, { source, fixedCity, fixedRegion, fixedLat, fixedLon, categoryFallback, cc } = {}) {
  const title = safeText(e.title || "Evento");
  const start = e.start ? toISO(e.start) : null;
  if (!start) return null;

  const lat = Number.isFinite(Number(e.lat)) ? Number(e.lat) : (Number.isFinite(Number(fixedLat)) ? Number(fixedLat) : null);
  const lon = Number.isFinite(Number(e.lon)) ? Number(e.lon) : (Number.isFinite(Number(fixedLon)) ? Number(fixedLon) : null);

  // Se non hai coords, per ora scarta (tu in app vuoi coords)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const place = safeText(e.place || fixedCity || "");
  const city = safeText(e.city || fixedCity || "");
  const region = safeText(e.region || fixedRegion || "");
  const country_code = safeText(e.country_code || cc || "IT").toUpperCase();
  const url = safeText(e.url || e.link || "");
  const category = safeText(e.category || categoryFallback || "other");

  const id = `e_${sha1(`${title}|${start}|${lat}|${lon}|${place}|${country_code}|${source || ""}`)}`;

  return { id, title, start, end: e.end || null, lat, lon, place, city, region, country_code, url, category, source: source || "unknown" };
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const e of arr) {
    if (!e?.id) continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

async function main() {
  const cfg = readConfig();
  const sources = Array.isArray(cfg.sources) ? cfg.sources : [];
  const timeoutMs = 45000;

  const stats = {
    sources_total: sources.length,
    sources_ok: 0,
    sources_fail: 0,
    raw: 0,
    deduped: 0,
    kept: 0,
    per_source: {}
  };

  let all = [];

  for (const src of sources) {
    const id = String(src.id || src.name || src.url || "src");
    stats.per_source[id] = { ok: false, err: null, n: 0 };
    try {
      if (!src?.url) continue;
      const type = String(src.type || "").toLowerCase().trim();

      const fixedLat = src.fixed_lat ?? src.fixedLat ?? src.lat;
      const fixedLon = src.fixed_lon ?? src.fixedLon ?? src.lon;
      const fixedCity = src.default_place || src.city || "";
      const fixedRegion = src.default_region || src.region || "";
      const cc = src.country_code || src.cc || "IT";
      const categoryFallback = src.category || "other";

      const txt = await fetchText(String(src.url).trim(), { timeoutMs });

      if (type === "ics") {
        const rows = parseIcs(txt);
        for (const r of rows) {
          const ev = normalizeEvent(
            { title: r.title, start: r.start, end: r.end, place: r.place, url: r.url },
            { source: id, fixedCity, fixedRegion, fixedLat, fixedLon, categoryFallback, cc }
          );
          if (ev) all.push(ev);
        }
      } else if (type === "rss") {
        const items = parseRss(txt);
        for (const it of items) {
          const start = toISO(it.pubDate);
          if (!start) continue;
          const ev = normalizeEvent(
            { title: it.title, start, end: null, place: fixedCity, url: it.link },
            { source: id, fixedCity, fixedRegion, fixedLat, fixedLon, categoryFallback, cc }
          );
          if (ev) all.push(ev);
        }
      }

      stats.sources_ok++;
      stats.per_source[id].ok = true;
      stats.per_source[id].n = all.length;
      await sleep(120);
    } catch (e) {
      stats.sources_fail++;
      stats.per_source[id].ok = false;
      stats.per_source[id].err = String(e?.message || e);
      console.warn(`⚠️ Source FAIL: ${id} -> ${stats.per_source[id].err}`);
      await sleep(180);
    }
  }

  stats.raw = all.length;
  all = dedupe(all);
  stats.deduped = all.length;

  // Se non abbiamo nulla, NON distruggere il dataset esistente
  if (all.length === 0) {
    if (fs.existsSync(OUT_PATH)) {
      console.log("⚠️ Build produced count=0. Keeping existing events_all.json (NOT overwriting).");
      // aggiorna solo una nota in console, ma non scrive
      process.exit(0);
    } else {
      console.log("⚠️ Build produced count=0 and no previous dataset exists. Writing empty dataset.");
    }
  }

  // write
  ensureDir(path.dirname(OUT_PATH));
  const out = {
    updated_at: nowISO(),
    count: all.length,
    days_ahead: Number(cfg.days_ahead || 90),
    events: all,
    stats
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf8");
  console.log(`✅ Wrote ${OUT_PATH} (${out.count} events)`);
}

main().catch((e) => {
  console.error("❌ build failed:", e);
  process.exit(1);
});
