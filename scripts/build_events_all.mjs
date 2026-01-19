#!/usr/bin/env node
/**
 * Jamo — build_events_all.mjs (v2.0)
 * Input:
 *  - Preferisce: ./events_sources.generated.json (creato dal workflow)
 *  - Fallback:   ./events_sources.json
 *
 * Output:
 *  - public/data/events/events_all.json
 *
 * Cosa cambia rispetto alla v1:
 * ✅ Niente più "finti eventi" (market/food/shop) da Overpass
 * ✅ RSS/Atom: prova a ricavare una data evento (non solo pubDate)
 * ✅ ICS: parsing VEVENT come prima (più robusto)
 * ✅ Geocoding con cache (cache/geocode-cache.json) se mancano lat/lon
 * ✅ Dedup serio + filtri periodo days_ahead
 *
 * Nota: per Offline-first vero, gli eventi devono essere "eventi veri".
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();

const CONFIG_FALLBACK = path.join(ROOT, "events_sources.json");
const CONFIG_GENERATED = path.join(ROOT, "events_sources.generated.json");
const OUT_PATH = path.join(ROOT, "public", "data", "events", "events_all.json");

const GEO_CACHE_PATH = path.join(ROOT, "cache", "geocode-cache.json");

// UA: importantissimo per richieste a servizi pubblici
const UA = process.env.JAMO_UA || "JamoEventsBuilder/2.0 (+https://jamo-seven.vercel.app)";

// Limiti/ritmi (Nominatim chiede 1 req/sec)
const NOMINATIM_DELAY_MS = 1100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 10);
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
function startOfDayTs(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

async function fetchText(url, { timeoutMs = 45000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, "accept": "*/*" },
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

async function fetchJson(url, opts) {
  const txt = await fetchText(url, opts);
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error("JSON parse error");
  }
}

/* -------------------- RSS/ATOM (light) -------------------- */
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
  if (!m) return "";
  return safeText(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
}
function extractLinkAtomish(entryXml) {
  // Atom spesso: <link href="..."/>
  const m = entryXml.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/i);
  if (m) return safeText(m[1]);
  return extractFirst(entryXml, "link") || extractFirst(entryXml, "id") || "";
}

function parseRssOrAtom(xml) {
  const items = extractXmlBlocks(xml, "item").length
    ? extractXmlBlocks(xml, "item")
    : extractXmlBlocks(xml, "entry");

  return items.map((blk) => {
    const title = extractFirst(blk, "title");
    const link = extractLinkAtomish(blk);
    const pubDate =
      extractFirst(blk, "pubDate") ||
      extractFirst(blk, "published") ||
      extractFirst(blk, "updated") ||
      extractFirst(blk, "dc:date") ||
      "";
    const description =
      extractFirst(blk, "description") ||
      extractFirst(blk, "summary") ||
      extractFirst(blk, "content") ||
      "";
    // se ci sono campi custom "start"/"date" nei feed, prova:
    const startHint =
      extractFirst(blk, "event:startdate") ||
      extractFirst(blk, "startdate") ||
      extractFirst(blk, "dtstart") ||
      extractFirst(blk, "start") ||
      "";
    return { title, link, pubDate, description, startHint };
  });
}

// Heuristica: prova a estrarre una data evento da testo (dd/mm/yyyy o yyyy-mm-dd)
function guessDateFromText(text) {
  const s = String(text || "");

  // yyyy-mm-dd
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return toISO(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);

  // dd/mm/yyyy
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const dd = String(m[1]).padStart(2, "0");
    const mm = String(m[2]).padStart(2, "0");
    const yyyy = m[3];
    return toISO(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  }

  // dd.mm.yyyy
  m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) {
    const dd = String(m[1]).padStart(2, "0");
    const mm = String(m[2]).padStart(2, "0");
    const yyyy = m[3];
    return toISO(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  }

  return null;
}

/* -------------------- ICS (minimal VEVENT) -------------------- */
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
  const yyyy = m[1], mm = m[2], dd = m[3], hh = m[4], mi = m[5], ss = m[6] || "00";
  const z = m[7] ? "Z" : "Z"; // semplificazione UTC
  return toISO(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${z}`);
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
      url: url || "",
    });
  }

  return events;
}

/* -------------------- GEOCODE (Nominatim + cache) -------------------- */
function loadGeoCache() {
  try {
    if (!fs.existsSync(GEO_CACHE_PATH)) return {};
    const j = JSON.parse(fs.readFileSync(GEO_CACHE_PATH, "utf8"));
    return (j && typeof j === "object") ? j : {};
  } catch {
    return {};
  }
}
function saveGeoCache(cacheObj) {
  try {
    ensureDir(path.dirname(GEO_CACHE_PATH));
    fs.writeFileSync(GEO_CACHE_PATH, JSON.stringify(cacheObj, null, 2), "utf8");
  } catch {
    // ignore
  }
}
function geoKey(q, cc) {
  return `${safeText(q).toLowerCase()}|${String(cc||"").toUpperCase()}`;
}

async function geocodeNominatim(q, countryCode, cache) {
  const key = geoKey(q, countryCode);
  if (cache[key]) return cache[key];

  const url =
    "https://nominatim.openstreetmap.org/search?" +
    new URLSearchParams({
      q: q,
      format: "json",
      limit: "1",
      addressdetails: "1",
      "accept-language": "it,en",
      ...(countryCode ? { countrycodes: String(countryCode).toLowerCase() } : {})
    }).toString();

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);

  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, "accept": "application/json" },
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const first = Array.isArray(j) ? j[0] : null;
    if (!first) {
      cache[key] = null;
      return null;
    }
    const lat = Number(first.lat);
    const lon = Number(first.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      cache[key] = null;
      return null;
    }
    const out = {
      lat,
      lon,
      display_name: String(first.display_name || ""),
    };
    cache[key] = out;
    return out;
  } catch {
    cache[key] = null;
    return null;
  } finally {
    clearTimeout(t);
    await sleep(NOMINATIM_DELAY_MS);
  }
}

/* -------------------- NORMALIZE -------------------- */
function normalizeEvent(e, { source, ccFallback, fixedLat, fixedLon, fixedCity, fixedRegion } = {}) {
  const title = safeText(e.title || e.name || "Evento");
  const start = e.start ? toISO(e.start) : null;
  const end = e.end ? toISO(e.end) : null;

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
  const base = `${title}|${start || ""}|${place}|${city}|${country_code}|${source || ""}`;
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
    category: category || "eventi",
    source: source || "unknown",
  };
}

function dedupeByKey(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    const key = `${safeText(e.title).toLowerCase()}|${String(e.start||"").slice(0,10)}|${safeText(e.city||e.place).toLowerCase()}|${e.country_code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function dropBadCategories(events) {
  // Se qualcuno prova a infilare POI come eventi, li buttiamo.
  const bad = new Set(["market", "food", "restaurant", "supermarket", "shop", "poi"]);
  return events.filter(e => !bad.has(String(e.category || "").toLowerCase().trim()));
}

/* -------------------- MAIN -------------------- */
async function main() {
  const configPath = fs.existsSync(CONFIG_GENERATED) ? CONFIG_GENERATED : CONFIG_FALLBACK;
  if (!fs.existsSync(configPath)) {
    console.error(`❌ Manca config: ${configPath}`);
    process.exit(1);
  }

  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));

  const daysAhead = clamp(Number(cfg.days_ahead) || 60, 1, 365);
  const maxEvents = clamp(Number(cfg.max_events) || 30000, 100, 50000);

  const rssIcs = Array.isArray(cfg?.rss_ics_sources) ? cfg.rss_ics_sources : [];

  const geoCache = loadGeoCache();

  const stats = {
    sources_total: rssIcs.length,
    sources_ok: 0,
    sources_fail: 0,
    raw_items: 0,
    kept_after_date: 0,
    geocoded: 0,
    dropped_no_date: 0,
    dropped_no_coords: 0,
  };

  let all = [];

  // Periodo
  const nowTs = Date.now();
  const fromTs = startOfDayTs(nowTs) - 2 * 24 * 3600 * 1000; // tolleranza -2gg
  const toTs = startOfDayTs(nowTs) + daysAhead * 24 * 3600 * 1000;

  // 1) RSS / ICS
  for (const src of rssIcs) {
    const id = src?.id || src?.url || "source";
    try {
      if (!src?.url) continue;

      const type = String(src.type || "rss").toLowerCase().trim();
      const url = String(src.url).trim();

      const fixedLat = Number(src.fixed_lat);
      const fixedLon = Number(src.fixed_lon);
      const fixedCity = src.default_place || src.fixed_city || "";
      const fixedRegion = src.default_region || src.fixed_region || "";
      const cc = src.country_code || "";

      const txt = await fetchText(url, { timeoutMs: 45000 });

      if (type === "ics") {
        const rows = parseIcs(txt);
        stats.raw_items += rows.length;

        for (const r of rows) {
          const ev = normalizeEvent(
            {
              title: r.title,
              start: r.start,
              end: r.end,
              place: r.place,
              url: r.url,
              lat: fixedLat,
              lon: fixedLon,
              city: fixedCity,
              region: fixedRegion,
              category: src.category || "eventi",
              country_code: cc,
            },
            { source: id, ccFallback: cc, fixedLat, fixedLon, fixedCity, fixedRegion }
          );

          if (!ev.start) { stats.dropped_no_date++; continue; }

          const t = new Date(ev.start).getTime();
          if (!Number.isFinite(t) || t < fromTs || t > toTs) continue;

          all.push(ev);
        }
      } else {
        const items = parseRssOrAtom(txt);
        stats.raw_items += items.length;

        for (const it of items) {
          // Prima prova: startHint
          let start =
            toISO(it.startHint) ||
            guessDateFromText(it.startHint) ||
            guessDateFromText(it.title) ||
            guessDateFromText(it.description);

          // fallback SOLO se pubDate sembra "evento" (altrimenti è data di pubblicazione e fa schifo)
          // accettiamo pubDate solo se non è troppo vecchia e se nel testo c'è almeno una data oppure parole evento
          if (!start) {
            const pub = toISO(it.pubDate);
            const looksEventy = /evento|concert|mostra|sagra|festival|fiera|teatro|spettac/i.test(`${it.title} ${it.description}`);
            if (pub && looksEventy) start = pub;
          }

          if (!start) { stats.dropped_no_date++; continue; }

          const ev = normalizeEvent(
            {
              title: it.title || "Evento",
              start,
              end: null,
              place: fixedCity,
              url: it.link,
              lat: fixedLat,
              lon: fixedLon,
              city: fixedCity,
              region: fixedRegion,
              category: src.category || "eventi",
              country_code: cc,
            },
            { source: id, ccFallback: cc, fixedLat, fixedLon, fixedCity, fixedRegion }
          );

          const t = new Date(ev.start).getTime();
          if (!Number.isFinite(t) || t < fromTs || t > toTs) continue;

          all.push(ev);
        }
      }

      stats.sources_ok++;
    } catch (e) {
      stats.sources_fail++;
      console.warn(`⚠️ Source fail: ${id} → ${e?.message || e}`);
    }
  }

  // 2) Geocode dove mancano coordinate (solo se abbiamo un testo sensato)
  for (const ev of all) {
    if (Number.isFinite(ev.lat) && Number.isFinite(ev.lon)) continue;

    // prova query: "title, city" oppure "place"
    const q1 = safeText(`${ev.title} ${ev.city || ""}`.trim());
    const q2 = safeText(`${ev.place || ""}`.trim());
    const q = (q2 && q2.length >= 6) ? q2 : q1;

    if (!q || q.length < 4) continue;

    const geo = await geocodeNominatim(q, ev.country_code, geoCache);
    if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lon)) {
      ev.lat = geo.lat;
      ev.lon = geo.lon;
      stats.geocoded++;
    }
  }

  saveGeoCache(geoCache);

  // 3) pulizia finale
  all = dropBadCategories(all);
  all = dedupeByKey(all);

  // coord obbligatorie (events.js calcola distanza)
  const beforeCoords = all.length;
  all = all.filter(e => Number.isFinite(e.lat) && Number.isFinite(e.lon));
  stats.dropped_no_coords += (beforeCoords - all.length);

  // ordina: prima eventi imminenti, poi distanza non possiamo qui (dipende dall’utente)
  all.sort((a, b) => {
    const ta = a.start ? new Date(a.start).getTime() : 9e15;
    const tb = b.start ? new Date(b.start).getTime() : 9e15;
    return ta - tb;
  });

  // cap
  if (all.length > maxEvents) all = all.slice(0, maxEvents);

  // output
  ensureDir(path.dirname(OUT_PATH));
  const out = {
    updated_at: nowISO(),
    count: all.length,
    days_ahead: daysAhead,
    stats,
    events: all
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf8");
  console.log(`✅ Wrote ${OUT_PATH} (${out.count} events)`);
  console.log("ℹ️ stats:", stats);
}

main().catch((e) => {
  console.error("❌ build failed:", e);
  process.exit(1);
});
