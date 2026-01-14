import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { overpass, writeJson } from "./lib/overpass.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REGIONS_CFG_PATH = path.join(__dirname, "..", "configs", "it", "regions.json");
const cfg = JSON.parse(fs.readFileSync(REGIONS_CFG_PATH, "utf-8"));

const OUT = path.join(__dirname, "..", "public", "data", "pois", "regions", "it-regions-index.json");

function toBBox(bounds) {
  if (!bounds) return null;

  // Overpass tipicamente: { minlat, minlon, maxlat, maxlon }
  const minLat = Number(bounds.minlat ?? bounds.minLat);
  const minLon = Number(bounds.minlon ?? bounds.minLon);
  const maxLat = Number(bounds.maxlat ?? bounds.maxLat);
  const maxLon = Number(bounds.maxlon ?? bounds.maxLon);

  if (![minLat, minLon, maxLat, maxLon].every(Number.isFinite)) return null;
  return { minLat, minLon, maxLat, maxLon };
}

function bboxFromRelation(rel) {
  // Overpass mette bounds direttamente sulla relation
  // es: rel.bounds = { minlat, minlon, maxlat, maxlon }
  return toBBox(rel?.bounds);
}

async function fetchRegionBBox(iso3166_2) {
  // admin_level=4 è tipico per le regioni italiane
  const q = `
[out:json][timeout:180];
(
  relation["boundary"="administrative"]["ISO3166-2"="${iso3166_2}"]["admin_level"="4"];
  relation["boundary"="administrative"]["ISO3166-2"="${iso3166_2}"];
);
out bb;
`;

  const data = await overpass(q, { retries: 5, timeoutMs: 150000 });

  const rel = (data?.elements || []).find((x) => x.type === "relation");
  if (!rel) return null;

  return bboxFromRelation(rel);
}

async function main() {
  const regions = Array.isArray(cfg?.regions) ? cfg.regions : [];
  const items = [];

  console.log(`▶ Building IT regions index… (${regions.length} regions)`);
  console.log(`CFG: ${REGIONS_CFG_PATH}`);
  console.log(`OUT: ${OUT}`);

  for (const r of regions) {
    const id = r?.id;
    const name = r?.name;
    const iso = r?.iso3166_2;

    if (!id || !name || !iso) {
      console.warn(`⚠ Skipping invalid region entry:`, r);
      continue;
    }

    try {
      const bbox = await fetchRegionBBox(iso);

      if (!bbox) {
        console.warn(`⚠ No bbox for ${id} (${iso}) → bbox:null`);
        items.push({ id, name, iso3166_2: iso, bbox: null });
        continue;
      }

      console.log(`✔ ${id} (${iso}) bbox ok`);
      items.push({ id, name, iso3166_2: iso, bbox });
    } catch (e) {
      console.warn(`⚠ Overpass failed for ${id} (${iso}) → bbox:null`);
      items.push({ id, name, iso3166_2: iso, bbox: null });
    }
  }

  await writeJson(OUT, {
    country: "IT",
    generated_at: new Date().toISOString(),
    items,
  });

  console.log(`✅ Written ${OUT} (${items.length} regions)`);
}

main().catch((e) => {
  console.error("❌ build_it_regions_index failed:", e);
  process.exit(1);
});
