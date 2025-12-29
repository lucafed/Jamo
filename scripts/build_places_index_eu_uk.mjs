// scripts/build_places_index_eu_uk.mjs
// Usage: node scripts/build_places_index_eu_uk.mjs

import fs from "fs";
import path from "path";
import https from "https";
import unzipper from "unzipper";

const OUT = path.join(process.cwd(), "public", "data", "places_index_eu_uk.json");

const EU_UK = new Set([
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT",
  "NL","PL","PT","RO","SK","SI","ES","SE","UK","GB"
]);

const URL = "https://download.geonames.org/export/dump/cities500.zip";

function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const file = fs.createWriteStream(destPath);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (err) => {
      try { fs.unlinkSync(destPath); } catch {}
      reject(err);
    });
  });
}

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function typeFromPop(pop) {
  if (pop >= 60000) return "citta";
  if (pop >= 8000) return "citta";
  return "borgo";
}

async function extractTxtFromZip(zipPath, wantedName) {
  const directory = await unzipper.Open.file(zipPath);
  const file = directory.files.find(f => f.path === wantedName);
  if (!file) throw new Error(`${wantedName} not found in zip`);
  return (await file.buffer()).toString("utf8");
}

(async function main(){
  const tmpZip = path.join(process.cwd(), ".tmp", "cities500.zip");

  console.log("Downloading:", URL);
  await downloadToFile(URL, tmpZip);
  const stat = fs.statSync(tmpZip);
  console.log("Downloaded", Math.round(stat.size/1024/1024), "MB");

  const txt = await extractTxtFromZip(tmpZip, "cities500.txt");
  const lines = txt.split("\n");

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

  const aq = places.find(p => norm(p.name) === "l aquila" || norm(p.name) === "laquila");
  console.log("Saved:", OUT, "places:", places.length);
  console.log("Check L'Aquila:", aq ? "OK" : "NOT FOUND");
})().catch((e)=>{
  console.error(e);
  process.exit(1);
});
