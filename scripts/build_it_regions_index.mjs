import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { overpass, writeJson } from "./lib/overpass.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REGIONS_CFG_PATH = path.join(__dirname, "..", "configs", "it", "regions.json");
const cfg = JSON.parse(fs.readFileSync(REGIONS_CFG_PATH, "utf-8"));

const OUT = path.join(__dirname, "..", "public", "data", "pois", "regions", "it-regions-index.json");

function bboxFromArea(areaEl) {
  // Overpass area element may not carry bbox; we compute from relation bbox if present.
  // Fallback: keep null and app can still use country-level.
  const b = areaEl?.bounds;
  if (!b) return null;
  return { minLat: b.minlat, minLon: b.minlon, maxLat: b.maxlat, maxLon: b.maxlon };
}

async function main() {
  const items = [];

  for (const r of (cfg.regions || [])) {
    const q = `
[out:json][timeout:180];
(
  relation["boundary"="administrative"]["ISO3166-2"="${r.iso3166_2}"];
);
out bb;
`;
    let data;
    try {
      data = await overpass(q, { retries: 5, timeoutMs: 150000 });
    } catch {
      items.push({ id: r.id, name: r.name, iso3166_2: r.iso3166_2, bbox: null });
      continue;
    }

    const rel = (data.elements || []).find(x => x.type === "relation");
    items.push({
      id: r.id,
      name: r.name,
      iso3166_2: r.iso3166_2,
      bbox: bboxFromArea(rel) // può essere null se non torna bounds
    });
  }

  await writeJson(OUT, {
    country: "IT",
    generated_at: new Date().toISOString(),
    items
  });

  console.log(`✔ Written ${OUT} (${items.length} regions)`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
