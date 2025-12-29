// scripts/build_places_index_eu_uk.mjs
// Usage: node scripts/build_places_index_eu_uk.mjs

import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import zlib from "zlib";

const OUT = path.join(process.cwd(), "public", "data", "places_index_eu_uk.json");

// EU + UK country codes (GeoNames)
const EU_UK = new Set([
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT",
  "NL","PL","PT","RO","SK","SI","ES","SE","UK","GB"
]);

const URL = "https://download.geonames.org/export/dump/cities500.zip";

function isZip(buf) {
  // ZIP signature: 50 4B 03 04
  return buf && buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

function snippet(buf, max = 220) {
  try {
    const s = buf.toString("utf8", 0, Math.min(buf.length, max));
    return s.replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function requestBuffer(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? http : https;

    const req = lib.request(
      u,
      {
        method: "GET",
        headers: {
          "User-Agent": "jamo-index-builder/1.0 (+https://github.com/)",
          "Accept": "application/zip,application/octet-stream,*/*",
          "Accept-Encoding": "identity"
        }
      },
      (res) => {
        const code = res.statusCode || 0;

        // Redirect handling
        if ([301, 302, 303, 307, 308].includes(code)) {
          const loc = res.headers.location;
          if (!loc) return reject(new Error(`Redirect ${code} without Location header`));
          if (redirectsLeft <= 0) return reject(new Error(`Too many redirects. Last: ${loc}`));
          const next = new URL(loc, u).toString();
          res.resume();
          return resolve(requestBuffer(next, redirectsLeft - 1));
        }

        if (code !== 200) {
          const chunksErr = [];
          res.on("data", (d) => chunksErr.push(d));
          res.on("end", () => {
            const b = Buffer.concat(chunksErr);
            reject(new Error(`Download failed: ${code}. Body: ${snippet(b)}`));
          });
          return;
        }

        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          let buf = Buffer.concat(chunks);

          // Rare: server could gzip (unlikely here), but keep safe
          const enc = String(res.headers["content-encoding"] || "").toLowerCase();
          if (enc === "gzip") {
            try { buf = zlib.gunzipSync(buf); }
            catch (e) { return reject(new Error(`Gunzip failed: ${e.message}`)); }
          }

          resolve({ buf, headers: res.headers });
        });
      }
    );

    req.on("error", reject);
    req.end();
  });
}

async function downloadZip(url) {
  const { buf, headers } = await requestBuffer(url);

  const ct = String(headers["content-type"] || "");
  console.log("Content-Type:", ct || "(none)");

  if (!isZip(buf)) {
    throw new Error(
      "Downloaded content is not a ZIP (missing PK header). " +
      `First bytes: ${buf.slice(0, 16).toString("hex")} | Snippet: ${snippet(buf)}`
    );
  }
  return buf;
}

// unzip per zip che contiene 1 file (cities500.txt)
// (ok per GeoNames: struttura stabile)
function extractCitiesTxtFromZip(zipBuf) {
  const name = Buffer.from("cities500.txt");
  const idx = zipBuf.indexOf(name);
  if (idx < 0) throw new Error("cities500.txt not found in zip");

  // risali all'inizio local header (PK 03 04)
  let p = idx;
  while (p > 0 && !(zipBuf[p] === 0x50 && zipBuf[p+1] === 0x4b && zipBuf[p+2] === 0x03 && zipBuf[p+3] === 0x04)) p--;
  if (p <= 0) throw new Error("Local header not found (zip is likely corrupted)");

  const fileNameLen = zipBuf.readUInt16LE(p + 26);
  const extraLen    = zipBuf.readUInt16LE(p + 28);
  const compMethod  = zipBuf.readUInt16LE(p + 8);
  const compSize    = zipBuf.readUInt32LE(p + 18);

  const dataStart = p + 30 + fileNameLen + extraLen;
  const compData  = zipBuf.subarray(dataStart, dataStart + compSize);

  if (compMethod !== 8) throw new Error(`Unexpected zip method: ${compMethod} (expected deflate)`);

  return zlib.inflateRawSync(compData).toString("utf8");
}

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function typeFromPop(pop) {
  if (pop >= 8000) return "citta";
  return "borgo";
}

(async function main(){
  console.log("Downloading:", URL);
  const zip = await downloadZip(URL);
  console.log("Downloaded", Math.round(zip.length/1024/1024), "MB");

  const txt = extractCitiesTxtFromZip(zip);
  const lines = txt.split("\n");

  const places = [];
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const cols = line.split("\t");
    if (cols.length < 15) continue;

    const geonameid   = cols[0];
    const name        = cols[1];
    const lat         = Number(cols[4]);
    const lng         = Number(cols[5]);
    const country     = cols[8];
    const population  = Number(cols[14] || 0);

    if (!EU_UK.has(country)) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (!name) continue;

    const type = typeFromPop(population);
    const visibility = population >= 250000 ? "conosciuta" : "chicca";

    places.push({
      id: `gn_${geonameid}`,
      name,
      country: country === "GB" ? "UK" : country,
      type,
      visibility,
      lat,
      lng,
      tags: [],
      vibes: [],
      best_when: [],
      why: [],
      what_to_do: [],
      what_to_eat: []
    });
  }

  const out = {
    version: "1.0",
    updated: new Date().toISOString().slice(0,10),
    regions: ["EU","UK"],
    places
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out), "utf8");
  console.log("Saved:", OUT, "places:", places.length);

  const aq = places.find(p => {
    const n = norm(p.name).replace(/\s+/g," ");
    return n === "l aquila" || n === "laquila" || n === "l'aquila";
  });
  console.log("Check L'Aquila:", aq ? "OK" : "NOT FOUND");
})().catch((e)=>{
  console.error(e);
  process.exit(1);
});
