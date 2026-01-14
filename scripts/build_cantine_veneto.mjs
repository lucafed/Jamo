// scripts/build_cantine_veneto.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { overpass, toPlace, writeJson } from "./lib/overpass.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Output Veneto
const OUT = path.join(__dirname, "..", "public", "data", "pois", "regions", "it-veneto-cantine.json");

// ----------------------
// Overpass query (Veneto area)
// ----------------------
function buildQueryVeneto() {
  // Veneto in OSM: boundary=administrative + name=Veneto + admin_level=4
  return `
[out:json][timeout:180];
area["boundary"="administrative"]["name"="Veneto"]["admin_level"="4"]->.a;
(
  node(area.a)["craft"="winery"];
  way(area.a)["craft"="winery"];
  relation(area.a)["craft"="winery"];

  node(area.a)["industrial"="winery"];
  way(area.a)["industrial"="winery"];
  relation(area.a)["industrial"="winery"];

  node(area.a)["shop"="wine"];
  way(area.a)["shop"="wine"];
  relation(area.a)["shop"="wine"];

  node(area.a)["tourism"="attraction"]["wine"];
  way(area.a)["tourism"="attraction"]["wine"];
  relation(area.a)["tourism"="attraction"]["wine"];
);
out center tags;
`;
}

// ----------------------
// Utils
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

  if (tagEquals(t, "shop", "wine") && !tagEquals(t, "craft", "winery") && !tagEquals(t, "industrial", "winery")) {
    s -= 10;
  }

  return s;
}

// ----------------------
// MAIN
// ----------------------
async function main() {
  console.log("Build CANTINE Veneto…");
  let data;

  try {
    const q = buildQueryVeneto();
    data = await overpass(q, { retries: 7, timeoutMs: 150000 });
  } catch (err) {
    console.error("⚠️ Overpass failed. Keeping previous dataset if it exists.");
    if (fs.existsSync(OUT)) {
      console.log("✔ Existing it-veneto-cantine.json found, not failing the build.");
      return;
    }
    throw err;
  }

  const raw = (data.elements || [])
    .map(toPlace)
    .filter((p) => p.lat != null && p.lon != null)
    .filter((p) => (p.name || "").trim() !== "(senza nome)")
    .filter((p) => !isClearlyNotPlace(p));

  const seen = new Set();
  const deduped = [];
  for (const p of raw) {
    const key = `${norm(p.name)}|${Number(p.lat).toFixed(5)}|${Number(p.lon).toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  // In Veneto possiamo distinguere un minimo:
  // - craft/industrial=winery => classici
  // - shop=wine => chicche (enoteche carine) MA solo se ha sito/orari/telefono
  const places = deduped
    .map((p) => {
      const t = p.tags || {};
      const isRealWinery = tagEquals(t, "craft", "winery") || tagEquals(t, "industrial", "winery");
      const isWineShop = tagEquals(t, "shop", "wine") && !isRealWinery;

      const hasInfo = hasAnyTag(t, ["website", "contact:website", "opening_hours", "phone", "contact:phone"]);

      const visibility =
        isRealWinery ? "classica" :
        (isWineShop && hasInfo) ? "chicca" :
        "classica";

      return {
        id: p.id,
        name: p.name,
        lat: p.lat,
        lon: p.lon,
        type: "cantine",
        visibility,
        tags: Object.entries(t).slice(0, 90).map(([k, v]) => `${k}=${v}`),
        score: scoreCantina(p),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 7000);

  await writeJson(OUT, {
    region_id: "it-veneto-cantine",
    label_it: "Veneto • Cantine",
    generated_at: new Date().toISOString(),
    places,
  });

  console.log(`✔ Written ${OUT} (${places.length} places)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
