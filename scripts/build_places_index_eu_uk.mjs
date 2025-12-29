// scripts/build_places_index_eu_uk.mjs
// Robust version using system unzip (GitHub Actions friendly)

import fs from "fs";
import path from "path";
import https from "https";
import { execSync } from "child_process";

const OUT = path.join(process.cwd(), "public", "data", "places_index_eu_uk.json");
const TMP_ZIP = "/tmp/cities500.zip";
const TMP_TXT = "/tmp/cities500.txt";

const EU_UK = new Set([
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT",
  "LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE","GB","UK"
]);

const URL = "https://download.geonames.org/export/dump/cities500.zip";

function download(url, out) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(out);
    https.get(url, res => {
      if (res.statusCode !== 200) {
        reject(new Error("Download failed: " + res.statusCode));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", reject);
  });
}

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();
}

(async () => {
  console.log("Downloading cities500.zip…");
  await download(URL, TMP_ZIP);

  console.log("Extracting cities500.txt…");
  execSync(`unzip -p ${TMP_ZIP} cities500.txt > ${TMP_TXT}`);

  const txt = fs.readFileSync(TMP_TXT, "utf8");
  const lines = txt.split("\n");

  const places = [];

  for (const line of lines) {
    if (!line) continue;
    const c = line.split("\t");
    if (c.length < 15) continue;

    const id = c[0];
    const name = c[1];
    const lat = Number(c[4]);
    const lng = Number(c[5]);
    const country = c[8];
    const pop = Number(c[14] || 0);

    if (!EU_UK.has(country)) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    places.push({
      id: `gn_${id}`,
      name,
      country: country === "GB" ? "UK" : country,
      type: pop >= 8000 ? "citta" : "borgo",
      visibility: pop >= 250000 ? "conosciuta" : "chicca",
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

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    JSON.stringify({
      version: "1.0",
      updated: new Date().toISOString().slice(0,10),
      regions: ["EU","UK"],
      places
    })
  );

  console.log("Saved", places.length, "places");

  const aq = places.find(p => norm(p.name).includes("aquila"));
  console.log("Check L'Aquila:", aq ? "OK" : "NOT FOUND");
})();
