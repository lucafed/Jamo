#!/usr/bin/env node
/**
 * Jamo — build_events_all.mjs (v1)
 * Legge config da ROOT: ./events_sources.json
 * Genera: public/data/events/events_all.json
 *
 * Fonti:
 *  - Overpass (mercati/fiere ecc. via amenity=marketplace + eventi “deboli”)
 *  - RSS / ICS (se presenti in config.rss_ics_sources)
 *
 * NOTE:
 * - RSS “wikidata Qxxx?format=rss” NON è un feed eventi vero: spesso produce roba che non sono eventi.
 *   Però lo gestiamo comunque: se non contiene date => viene scartato.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "events_sources.json");
const OUT_PATH = path.join(ROOT, "public", "data", "events", "events_all.json");

const UA = "JamoEventsBuilder/1.0 (+https://jamo-seven.vercel.app)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 8);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function nowISO() {
  return new Date().toISOString();
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

function safeText(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

async function fetchText(url, { timeoutMs = 45000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, "accept": "*/*" },
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, opts) {
  const txt = await fetchText(url, opts);
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error("JSON parse error");
  }
}

/** ------------------ RSS PARSER (light) ------------------ **/
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
  return m ? safeText(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")) : "";
}

function parseRss(xml) {
  const items = extractXmlBlocks(xml, "item").length
    ? extractXmlBlocks(xml, "item")
    : extractXmlBlocks(xml, "entry"); // atom-ish

  return items.map((blk) => {
    const title = extractFirst(blk, "title");
    const link = extractFirst(blk, "link") || extractFirst(blk, "id");
    const pubDate = extractFirst(blk, "pubDate") || extractFirst(blk, "published") || extractFirst(blk, "updated");
    const description = extractFirst(blk, "description") || extractFirst(blk, "summary") || "";
    return { title, link, pubDate, description };
  });
}

/** ------------------ ICS PARSER (minimal VEVENT) ------------------ **/
function unfoldIcsLines(s) {
  // unfold RFC5545: lines starting with space/tab are continuations
  return s.replace(/\r?\n[ \t]/g, "");
}

function parseIcsDate(val) {
  // supports:
  //  - 20260122T010000Z
  //  - 20260122T010000
  //  - 20260122
  if (!val) return null;
  const v = String(val).trim();

  // DATE only
  if (/^\d{8}$/.test(v)) {
    const yyyy = v.slice(0, 4);
    const mm = v.slice(4, 6);
    const dd = v.slice(6, 8);
    return toISODateOnly(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  }

  // DATE-TIME
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  const yyyy = m[1], mm = m[2], dd = m[3], hh = m[4], mi = m[5], ss = m[6] || "00";
  const z = m[7] ? "Z" : "Z"; // trattiamo come UTC per semplicità
  return toISODateOnly(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${z}`);
}

function parseIcs(text) {
  const s = unfoldIcsLines(text);
  const blocks = s.split("BEGIN:VEVENT").slice(1).map(x => x.split("END:VEVENT")[0] || "");
  const events = [];

  for (const b of blocks) {
    const get = (key) => {
      // match "KEY" or "KEY;PARAM=..." then ":" value
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

    // senza data, scartiamo
    if (!dtStart) continue;

    events.push({
      title: summary || "Evento",
      start: dtStart,
      end: dtEnd || null,
      place: location || "",
      url: url || "",
      raw: { summary, location, dtStartRaw, dtEndRaw }
    });
  }

  return events;
}

/** ------------------ OVERPASS (fallback) ------------------ **/
function overpassQueryMarketplace(lat, lon, radiusKm) {
  const r = Math.round(radiusKm * 1000);
  // marketplace + name. (Molti non hanno date: li mettiamo con start=null => verranno scartati dai filtri “oggi/weekend/7giorni”
  // però li teniamo come fallback in dataset (events.js poi sceglie in base ai filtri).
  return `
[out:json][timeout:45];
(
  node(around:${r},${lat},${lon})["amenity"="marketplace"]["name"];
  way(around:${r},${lat},${lon})["amenity"="marketplace"]["name"];
  relation(around:${r},${lat},${lon})["amenity"="marketplace"]["name"];
);
out center tags;
`;
}

function pickOverpassCenter(el) {
  if (el.type === "node") return { lat: el.lat, lon: el.lon };
  if (el.center?.lat && el.center?.lon) return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

async function queryOverpass(endpoints, query, timeoutMs) {
  let lastErr = null;
  for (const ep of endpoints) {
    try {
      const url = `${ep}?data=${encodeURIComponent(query)}`;
      const j = await fetchJson(url, { timeoutMs });
      return { endpoint: ep, json: j };
    } catch (e) {
      lastErr = e;
      // piccola pausa e prova altro endpoint
      await sleep(600);
    }
  }
  throw lastErr || new Error("Overpass failed");
}

/** ------------------ NORMALIZE & BUILD ------------------ **/
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

  // id stabile
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
    category: category || "tutti",
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
  // events.js richiede lat/lon per calcolare distanza: senza coord non servono
  return events.filter(e => Number.isFinite(e.lat) && Number.isFinite(e.lon));
}

function dropNoStart(events) {
  // filtri (oggi/weekend/7giorni) richiedono date: se start null non comparirà mai
  // però se vuoi tenerli come fallback “sempre”, dimmelo e cambiamo events.js.
  return events.filter(e => !!e.start);
}

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`❌ Manca ${CONFIG_PATH}`);
    process.exit(1);
  }

  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

  const daysAhead = clamp(Number(cfg.days_ahead) || 60, 1, 365);
  const maxEvents = clamp(Number(cfg.max_events) || 30000, 100, 30000);

  const endpoints = cfg?.providers?.osm_overpass?.endpoints || [];
  const overpassEnabled = !!cfg?.providers?.osm_overpass?.enabled;
  const overpassTimeout = clamp(Number(cfg?.providers?.osm_overpass?.timeout_ms) || 45000, 5000, 120000);

  const rssIcs = Array.isArray(cfg?.rss_ics_sources) ? cfg.rss_ics_sources : [];

  let all = [];

  /** 1) RSS / ICS (prioritari) **/
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
      } else {
        // rss (default)
        const items = parseRss(txt);
        for (const it of items) {
          // prova a prendere una data: pubDate; se non c’è, scarta (altrimenti non passa filtri)
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
                category: src.category || "culture",
                country_code: cc
              },
              { source: src.id || "rss", ccFallback: cc, fixedLat: fixed_lat, fixedLon: fixed_lon, fixedCity, fixedRegion }
            )
          );
        }
      }
    } catch (e) {
      console.warn(`⚠️ RSS/ICS fail: ${src?.id || src?.url} → ${e.message || e}`);
    }
  }

  /** 2) Overpass (fallback) **/
  if (overpassEnabled && endpoints.length) {
    const covIt = cfg?.coverage?.italy?.enabled ? (cfg.coverage.italy.cities || []) : [];
    const covEu = cfg?.coverage?.europe?.enabled ? (cfg.coverage.europe.cities || []) : [];
    const cities = [...covIt, ...covEu];

    for (const c of cities) {
      try {
        const name = c.name || "city";
        const lat = Number(c.lat);
        const lon = Number(c.lon);
        const radiusKm = Number(c.radius_km) || 30;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        const q = overpassQueryMarketplace(lat, lon, radiusKm);
        const { json } = await queryOverpass(endpoints, q, overpassTimeout);

        const els = Array.isArray(json?.elements) ? json.elements : [];
        for (const el of els) {
          const center = pickOverpassCenter(el);
          if (!center) continue;

          const title = safeText(el.tags?.name || "Mercato");
          // Overpass non ha date -> mettiamo start = oggi (così entra in “7 giorni” ecc.)
          // Se NON vuoi questa forzatura, dimmelo e la togliamo.
          const forcedStart = nowISO();

          all.push(
            normalizeEvent(
              {
                title,
                start: forcedStart,
                end: null,
                lat: center.lat,
                lon: center.lon,
                place: name,
                city: name,
                country_code: c.cc || "IT",
                category: "market",
                url: ""
              },
              { source: "osm_overpass", ccFallback: c.cc || "IT" }
            )
          );
        }

        // piccolo delay per non farsi bloccare
        await sleep(350);
      } catch (e) {
        console.warn(`⚠️ Overpass fail: ${c?.name} → ${e.message || e}`);
      }
    }
  }

  // pulizia
  all = dedupe(all);
  all = dropNoCoords(all);

  // limita al periodo giorni_ahead
  const now = new Date();
  const maxT = now.getTime() + daysAhead * 24 * 3600 * 1000;
  all = all.filter(e => {
    const t = e.start ? new Date(e.start).getTime() : NaN;
    return Number.isFinite(t) && t >= now.getTime() - 2 * 24 * 3600 * 1000 && t <= maxT;
  });

  // cap
  all = all.slice(0, maxEvents);

  // output
  ensureDir(path.dirname(OUT_PATH));
  const out = {
    updated_at: nowISO(),
    count: all.length,
    days_ahead: daysAhead,
    events: all
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf8");
  console.log(`✅ Wrote ${OUT_PATH} (${out.count} events)`);
}

main().catch((e) => {
  console.error("❌ build failed:", e);
  process.exit(1);
});
