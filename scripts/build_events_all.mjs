#!/usr/bin/env node
/**
 * Jamo — build_events_all.mjs (FINAL)
 * - Reads config from events_sources.generated.json
 * - Generates public/data/events/events_all.json
 * - RSS / ICS + Overpass
 * - Filters OUT past events
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "events_sources.generated.json");
const OUT_PATH = path.join(ROOT, "public", "data", "events", "events_all.json");

const UA = "JamoEventsBuilder/1.0 (+https://jamo-seven.vercel.app)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------ utils ------------------ */

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 8);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function nowISO() {
  return new Date().toISOString();
}

function toISO(d) {
  const x = new Date(d);
  return Number.isFinite(x.getTime()) ? x.toISOString() : null;
}

function safeText(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

async function fetchText(url, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA },
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

/* ------------------ RSS ------------------ */

function extractBlocks(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  return [...xml.matchAll(re)].map((m) => m[1]);
}

function extractFirst(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(xml);
  if (!m) return "";
  return safeText(
    m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  );
}

function parseRss(xml) {
  const items =
    extractBlocks(xml, "item").length > 0
      ? extractBlocks(xml, "item")
      : extractBlocks(xml, "entry");

  return items.map((blk) => ({
    title: extractFirst(blk, "title"),
    link: extractFirst(blk, "link") || extractFirst(blk, "id"),
    date:
      extractFirst(blk, "pubDate") ||
      extractFirst(blk, "published") ||
      extractFirst(blk, "updated"),
  }));
}

/* ------------------ ICS ------------------ */

function unfoldIcs(s) {
  return s.replace(/\r?\n[ \t]/g, "");
}

function parseIcsDate(v) {
  if (!v) return null;
  if (/^\d{8}$/.test(v)) {
    return toISO(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T00:00:00Z`);
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  return toISO(
    `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || "00"}Z`
  );
}

function parseIcs(txt) {
  const s = unfoldIcs(txt);
  const blocks = s.split("BEGIN:VEVENT").slice(1);
  const out = [];

  for (const b of blocks) {
    const get = (k) => {
      const re = new RegExp(`^${k}(?:;[^:]*)?:(.*)$`, "mi");
      const m = b.match(re);
      return m ? safeText(m[1]) : "";
    };

    const start = parseIcsDate(get("DTSTART"));
    if (!start) continue;

    out.push({
      title: get("SUMMARY") || "Evento",
      start,
      end: parseIcsDate(get("DTEND")),
      place: get("LOCATION"),
      url: get("URL"),
    });
  }
  return out;
}

/* ------------------ normalize ------------------ */

function normalizeEvent(e, src) {
  const base = `${e.title}|${e.start}|${src.id}`;
  return {
    id: `e_${sha1(base)}`,
    title: safeText(e.title),
    start: e.start,
    end: e.end || null,
    lat: src.fixed_lat ?? null,
    lon: src.fixed_lon ?? null,
    place: safeText(e.place || src.default_place || ""),
    city: safeText(src.default_place || ""),
    region: safeText(src.default_region || ""),
    country_code: String(src.country_code || "").toUpperCase(),
    url: safeText(e.url || ""),
    category: safeText(src.category || "other"),
    source: src.id,
  };
}

/* ------------------ MAIN ------------------ */

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`❌ Missing ${CONFIG_PATH}`);
    process.exit(1);
  }

  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const daysAhead = Number(cfg.days_ahead || 60);
  const maxEvents = Number(cfg.max_events || 30000);
  const now = Date.now();
  const minT = now - 2 * 24 * 3600 * 1000;
  const maxT = now + daysAhead * 24 * 3600 * 1000;

  let all = [];

  for (const src of cfg.rss_ics_sources || []) {
    try {
      const txt = await fetchText(src.url);
      if (src.type === "ics") {
        for (const ev of parseIcs(txt)) {
          all.push(normalizeEvent(ev, src));
        }
      } else {
        for (const it of parseRss(txt)) {
          const start = toISO(it.date);
          if (!start) continue;
          all.push(
            normalizeEvent(
              { title: it.title, start, end: null, place: src.default_place, url: it.link },
              src
            )
          );
        }
      }
    } catch (e) {
      console.warn(`⚠️ source fail: ${src.id}`);
    }
    await sleep(200);
  }

  // dedupe + coords + future-only
  const seen = new Set();
  all = all.filter((e) => {
    if (!e.start) return false;
    const t = new Date(e.start).getTime();
    if (!Number.isFinite(t) || t < minT || t > maxT) return false;
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  all = all.slice(0, maxEvents);

  ensureDir(path.dirname(OUT_PATH));
  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        updated_at: nowISO(),
        count: all.length,
        days_ahead: daysAhead,
        events: all,
      },
      null,
      2
    )
  );

  console.log(`✅ events_all.json written (${all.length})`);
}

main().catch((e) => {
  console.error("❌ build failed", e);
  process.exit(1);
});
