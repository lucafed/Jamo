// scripts/build_places_index_eu_uk.mjs
// Usage: node scripts/build_places_index_eu_uk.mjs

import fs from "fs";
import path from "path";
import https from "https";
import zlib from "zlib";

const OUT = path.join(process.cwd(), "public", "data", "places_index_eu_uk.json");

// EU + UK country codes (GeoNames)
const EU_UK = new Set([
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT",
  "NL","PL","PT","RO","SK","SI","ES","SE","UK","GB" // includo UK/GB per sicurezza
]);

const URL = "https://download.geonames.org/export/dump/cities500.zip";

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

// mini unzip per zip che contiene 1 file (cities500.txt)
// usa una “scorciatoia” robusta: trova il contenuto del .txt nel buffer zip
// (va bene per GeoNames, che ha layout stabile)
function extractCitiesTxtFromZip(zipBuf) {
  // Cerca la signature del file locale: 0x04034b50
  // Poi salta header variabile e prende i bytes fino al prossimo header.
  // In pratica: cerchiamo direttamente "cities500.txt" e prendiamo lo stream deflate che segue.
  const name = Buffer.from("cities500.txt");
  const idx = zipBuf.indexOf(name);
  if (idx < 0) throw new Error("cities500.txt not found in zip");

  // risali all'inizio local header
  let p = idx;
  while (p > 0 && !(zipBuf[p] === 0x50 && zipBuf[p+1] === 0x4b && zipBuf[p+2] === 0x03 && zipBuf[p+3] === 0x04)) p--;
  if (p <= 0) throw new Error("Local header not found");

  // Local header structure:
  // 30 bytes fixed + fileNameLen + extraLen, then compressed data
  const fileNameLen = zipBuf.readUInt16LE(p + 26);
  const extraLen = zipBuf.readUInt16LE(p + 28);
  const compMethod = zipBuf.readUInt16LE(p + 8);
  const compSize = zipBuf.readUInt32LE(p + 18);

  const dataStart = p + 30 + fileNameLen + extraLen;
  const compData = zipBuf.subarray(dataStart, dataStart + compSize);

  if (compMethod !== 8) throw new Error(`Unexpected zip method: ${compMethod} (expected deflate)`);

  return zlib.inflateRawSync(compData).toString("utf8");
}

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function typeFromFeatureClassAndPop(pop) {
  // semplifico: tutto “citta” ma se vuoi puoi differenziare (town/village)
  // Per Jamo basta: citta/borgo
  if (pop >= 60000) return "citta";
  if (pop >= 8000) return "citta";
  return "borgo";
}

(async function main(){
  console.log("Downloading:", URL);
  const zip = await download(URL);
  console.log("Downloaded", Math.round(zip.length/1024/1024), "MB");

  const txt = extractCitiesTxtFromZip(zip);
  const lines = txt.split("\n");

  // GeoNames columns:
  // geonameid, name, asciiname, alternatenames, latitude, longitude, feature class, feature code,
  // country code, cc2, admin1, admin2, admin3, admin4, population, elevation, dem, timezone, modification date

  const places = [];
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const cols = line.split("\t");
    if (cols.length < 15) continue;

    const geonameid = cols[0];
    const name = cols[1];
    const lat = Number(cols[4]);
    const lng = Number(cols[5]);
    const country = cols[8];
    const population = Number(cols[14] || 0);

    if (!EU_UK.has(country)) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (!name) continue;

    const type = typeFromFeatureClassAndPop(population);
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

  // piccolo check: L'Aquila deve esserci
  const aq = places.find(p => norm(p.name) === "l aquila" || norm(p.name) === "laquila");
  console.log("Check L'Aquila:", aq ? "OK" : "NOT FOUND");
})().catch((e)=>{
  console.error(e);
  process.exit(1);
});
