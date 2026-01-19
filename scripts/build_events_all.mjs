#!/usr/bin/env node
import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();
const CFG = path.join(ROOT, "configs/it/verona_events_sources.json");
const OUT = path.join(ROOT, "public/data/events/events_all.json");

const sha = (s) =>
  crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 8);

const fetchText = async (url) => {
  const r = await fetch(url, {
    headers: { "user-agent": "Jamo/Verona" },
    redirect: "follow"
  });
  if (!r.ok) throw new Error(url);
  return r.text();
};

const parseRSS = (xml) => {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  return items.map(m => {
    const g = (t) =>
      (m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, "i")) || [])[1] || "";
    return {
      title: g("title"),
      link: g("link"),
      date: g("pubDate")
    };
  });
};

const parseICS = (txt) => {
  return txt.split("BEGIN:VEVENT").slice(1).map(b => {
    const g = (k) =>
      (b.match(new RegExp(`${k}:(.*)`)) || [])[1] || "";
    return {
      title: g("SUMMARY"),
      start: g("DTSTART"),
      place: g("LOCATION")
    };
  });
};

(async () => {
  const cfg = JSON.parse(fs.readFileSync(CFG, "utf8"));
  let all = [];

  for (const src of cfg.rss_ics_sources) {
    try {
      const txt = await fetchText(src.url);

      if (src.type === "rss") {
        for (const e of parseRSS(txt)) {
          all.push({
            id: "e_" + sha(e.title + e.date),
            title: e.title,
            start: new Date(e.date).toISOString(),
            lat: src.fixed_lat,
            lon: src.fixed_lon,
            city: src.default_place,
            region: src.default_region,
            country_code: "IT",
            category: src.category,
            source: src.id
          });
        }
      }

      if (src.type === "ics") {
        for (const e of parseICS(txt)) {
          all.push({
            id: "e_" + sha(e.title + e.start),
            title: e.title,
            start: e.start ? new Date(e.start).toISOString() : null,
            lat: src.fixed_lat,
            lon: src.fixed_lon,
            city: src.default_place,
            region: src.default_region,
            country_code: "IT",
            category: src.category,
            source: src.id
          });
        }
      }
    } catch (e) {
      console.warn("SKIP", src.id);
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    JSON.stringify({
      updated_at: new Date().toISOString(),
      count: all.length,
      events: all
    }, null, 2)
  );

  console.log("✅ Verona events:", all.length);
})();
