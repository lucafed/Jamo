// scripts/build_borghi_radius.mjs
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
const OUT = path.join(
  __dirname,
  "..",
  "public",
  "data",
  "pois",
  "regions",
  "radius-borghi.json"
);

// ----------------------
// Query Overpass (BORGHl radius)
// ----------------------
function buildQuery(lat, lon, radiusM) {
  return `
[out:json][timeout:220];
(
  // “Classici” (ampio)
  nwr(around:${radiusM},${lat},${lon})["place"~"town|village|hamlet|suburb|quarter|neighbourhood"];

  // centri storici
  nwr(around:${radiusM},${lat},${lon})["historic"="city_centre"];

  // località con nome (utile per lago/colline)
  nwr(around:${radiusM},${lat},${lon})["place"="locality"]["name"];

  // segnali turistici (per chicche, ma restano borghi)
  nwr(around:${radiusM},${lat},${lon})["historic"~"castle|fort|ruins|monument|archaeological_site"];
  nwr(around:${radiusM},${lat},${lon})["tourism"~"attraction|viewpoint|museum"];
  nwr(around:${radiusM},${lat},${lon})["heritage"];
);
out center tags;
`;
}

// ----------------------
// Anti-spazzatura
// ----------------------
function tagEquals(tags, k, v) {
  return String(tags?.[k] ?? "").toLowerCase() === String(v).toLowerCase();
}

function isJunk(p) {
  const t = p.tags || {};
  const name = (p.name || "").trim();
  const n = name.toLowerCase();

  if (!name || name === "(senza nome)") return true;

  // strade/fermate
  if (t.highway) return true;
  if (t.railway) return true;
  if (t.public_transport) return true;
  if (tagEquals(t, "highway", "bus_stop")) return true;

  // aziende/uffici/industria
  const building = String(t.building ?? "").toLowerCase();
  const landuse = String(t.landuse ?? "").toLowerCase();
  const office = String(t.office ?? "").toLowerCase();
  if (office) return true;
  if (["office", "industrial", "warehouse"].includes(building)) return true;
  if (["industrial", "commercial"].includes(landuse)) return true;

  // nomi inutili
  if (n.startsWith("via ") || n.includes("case sparse")) return true;

  // SpA aziendale
  if (/\bs\.p\.a\.?\b/i.test(name)) return true;
  if (n.includes("openjobmetis")) return true;

  return false;
}

// ----------------------
// Score + visibility
// ----------------------
function hasAny(tags, keys) {
  return keys.some((k) => tags[k] != null && String(tags[k]).trim() !== "");
}

function scoreBorgo(p) {
  const t = p.tags || {};
  const name = (p.name || "").toLowerCase();
  let s = 0;

  const place = String(t.place ?? "").toLowerCase();
  if (place === "town") s += 35;
  if (place === "village") s += 30;
  if (place === "hamlet") s += 22;
  if (["suburb", "quarter", "neighbourhood"].includes(place)) s += 10;
  if (place === "locality") s += 12; // ✅ per lago/colline, ma non troppo alto

  const historic = String(t.historic ?? "").toLowerCase();
  if (historic === "city_centre") s += 35;
  if (["castle", "fort", "ruins", "monument", "archaeological_site"].includes(historic)) s += 35;

  const tourism = String(t.tourism ?? "").toLowerCase();
  if (["attraction", "viewpoint", "museum"].includes(tourism)) s += 25;

  if (t.heritage) s += 18;

  if (hasAny(t, ["wikipedia"])) s += 25;
  if (hasAny(t, ["wikidata"])) s += 22;

  if (name.includes("borgo")) s += 10;
  if (name.includes("castello")) s += 10;

  if (hasAny(t, ["website", "contact:website"])) s += 5;

  return s;
}

function visibilityFromScore(score) {
  // ✅ soglia ALTA per mantenere TANTI "classica"
  return score >= 70 ? "chicca" : "classica";
}

// ----------------------
// MAIN
// ----------------------
async function main() {
  console.log(
    `Build BORGHl radius: center=${CENTER_LAT},${CENTER_LON} radius=${RADIUS_KM}km`
  );

  let data;
  try {
    const q = buildQuery(CENTER_LAT, CENTER_LON, RADIUS_M);
    data = await overpass(q, { retries: 7, timeoutMs: 160000 });
  } catch (err) {
    console.error("⚠️ Overpass failed. Keeping previous dataset if it exists.");
    if (fs.existsSync(OUT)) {
      console.log("✔ Existing radius-borghi.json found, not failing the build.");
      return;
    }
    throw err;
  }

  const raw = (data.elements || [])
    .map(toPlace)
    .filter((p) => p.lat != null && p.lon != null)
    .filter((p) => !isJunk(p));

  // Dedup: nome + coordinate
  const seen = new Set();
  const deduped = [];
  for (const p of raw) {
    const key = `${(p.name || "").toLowerCase()}|${p.lat.toFixed(
      5
    )}|${p.lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  const places = deduped
    .map((p) => {
      const score = scoreBorgo(p);
      return {
        id: p.id,
        name: p.name,
        lat: p.lat,
        lon: p.lon,
        type: "borgo",
        visibility: visibilityFromScore(score),
        tags: Object.entries(p.tags || {})
          .slice(0, 80)
          .map(([k, v]) => `${k}=${v}`),
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 12000);

  await writeJson(OUT, {
    region_id: "radius-borghi",
    label_it: `Radius • Borghi (${RADIUS_KM}km)`,
    bbox_hint: { lat: CENTER_LAT, lng: CENTER_LON, radius_km: RADIUS_KM },
    generated_at: new Date().toISOString(),
    places,
  });

  const countClassica = places.filter((p) => p.visibility === "classica").length;
  const countChicca = places.filter((p) => p.visibility === "chicca").length;
  console.log(
    `✔ Written ${OUT} (${places.length} places) classica=${countClassica} chicca=${countChicca}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
