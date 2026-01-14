// scripts/build_cantine_radius.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { overpass, toPlace, writeJson } from "./lib/overpass.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Default: Bussolengo (cambiabile via ENV)
const CENTER_LAT = Number(process.env.CENTER_LAT ?? 45.5209);
const CENTER_LON = Number(process.env.CENTER_LON ?? 10.8686);
const RADIUS_KM = Number(process.env.RADIUS_KM ?? 120);
const RADIUS_M = Math.round(RADIUS_KM * 1000);

// ✅ Output
const OUT = path.join(__dirname, "..", "public", "data", "pois", "regions", "radius-cantine.json");

// ----------------------
// Query Overpass (CANTINE)
// ----------------------
function buildQuery(lat, lon, radiusM) {
  return `
[out:json][timeout:180];
(
  node(around:${radiusM},${lat},${lon})["craft"="winery"];
  way(around:${radiusM},${lat},${lon})["craft"="winery"];
  relation(around:${radiusM},${lat},${lon})["craft"="winery"];

  node(around:${radiusM},${lat},${lon})["industrial"="winery"];
  way(around:${radiusM},${lat},${lon})["industrial"="winery"];
  relation(around:${radiusM},${lat},${lon})["industrial"="winery"];

  node(around:${radiusM},${lat},${lon})["shop"="wine"];
  way(around:${radiusM},${lat},${lon})["shop"="wine"];
  relation(around:${radiusM},${lat},${lon})["shop"="wine"];

  node(around:${radiusM},${lat},${lon})["tourism"="attraction"]["wine"];
  way(around:${radiusM},${lat},${lon})["tourism"="attraction"]["wine"];
  relation(around:${radiusM},${lat},${lon})["tourism"="attraction"]["wine"];
);
out center tags;
`;
}

// ----------------------
// Utils filtro
// ----------------------
function hasAnyTag(tags, keys) {
  return keys.some((k) => tags[k] != null && String(tags[k]).trim() !== "");
}
function tagEquals(tags, k, v) {
  return String(tags[k] ?? "").toLowerCase() === String(v).toLowerCase();
}
function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isClearlyNotPlace(p) {
  const t = p.tags || {};
  const name = norm(p.name || "");

  if (!name || name === "meta" || name.startsWith("via ") || name.includes("case sparse")) return true;
  if (t.highway || t.railway || t.public_transport) return true;

  if (t.amenity && ["bank","school","clinic","hospital","pharmacy","police","post_office"].includes(String(t.amenity).toLowerCase()))
    return true;

  // industria/warehouse senza segnali vino (evita roba che non c'entra)
  const hasWine =
    tagEquals(t, "craft", "winery") ||
    tagEquals(t, "industrial", "winery") ||
    tagEquals(t, "shop", "wine") ||
    (t.product && String(t.product).toLowerCase().includes("wine")) ||
    (t["drink:wine"] && String(t["drink:wine"]).toLowerCase() !== "no") ||
    (t.wine && String(t.wine).toLowerCase() !== "no");

  if (!hasWine && t.building && ["industrial","warehouse","retail"].includes(String(t.building).toLowerCase())) return true;

  return false;
}

function scoreCantina(p) {
  const t = p.tags || {};
  const name = norm(p.name || "");
  let s = 0;

  if (tagEquals(t, "craft", "winery")) s += 80;
  if (tagEquals(t, "industrial", "winery")) s += 65;

  if (tagEquals(t, "shop", "wine")) s += 35;

  if (t.tourism === "attraction" && (t.wine || t.product)) s += 20;

  if (hasAnyTag(t, ["website", "contact:website"])) s += 10;
  if (hasAnyTag(t, ["opening_hours"])) s += 6;
  if (hasAnyTag(t, ["phone", "contact:phone"])) s += 6;

  if (name.includes("cantina")) s += 12;
  if (name.includes("azienda agricola")) s += 6;
  if (name.includes("agritur")) s += 4;
  if (name.includes("wine")) s += 6;

  // solo enoteca: ok, ma meno monetizzabile come "visita cantina"
  if (tagEquals(t, "shop", "wine") && !tagEquals(t, "craft", "winery") && !tagEquals(t, "industrial", "winery")) {
    s -= 10;
  }

  return s;
}

async function main() {
  console.log(`Build CANTINE radius: center=${CENTER_LAT},${CENTER_LON} radius=${RADIUS_KM}km`);
  let data;

  try {
    const q = buildQuery(CENTER_LAT, CENTER_LON, RADIUS_M);
    data = await overpass(q, { retries: 7, timeoutMs: 150000 });
  } catch (err) {
    console.error("⚠️ Overpass failed. Keeping previous dataset if it exists.");
    if (fs.existsSync(OUT)) {
      console.log("✔ Existing radius-cantine.json found, not failing the build.");
      return;
    }
    throw err;
  }

  const raw = (data.elements || [])
    .map(toPlace)
    .filter((p) => p.lat != null && p.lon != null)
    .filter((p) => (p.name || "").trim() !== "(senza nome)")
    .filter((p) => !isClearlyNotPlace(p));

  // Dedup (stesso nome + coordinate)
  const seen = new Set();
  const deduped = [];
  for (const p of raw) {
    const key = `${norm(p.name)}|${Number(p.lat).toFixed(5)}|${Number(p.lon).toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  const places = deduped
    .map((p) => ({
      id: p.id,
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      type: "cantine",
      visibility: "classica",
      tags: Object.entries(p.tags || {}).slice(0, 90).map(([k, v]) => `${k}=${v}`),
      score: scoreCantina(p),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8000);

  await writeJson(OUT, {
    region_id: "radius-cantine",
    label_it: `Radius • Cantine (${RADIUS_KM}km)`,
    bbox_hint: { lat: CENTER_LAT, lng: CENTER_LON, radius_km: RADIUS_KM },
    generated_at: new Date().toISOString(),
    places,
  });

  console.log(`✔ Written ${OUT} (${places.length} places)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
