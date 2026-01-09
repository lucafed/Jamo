// scripts/build_borghi_veneto.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { overpass, toPlace, writeJson } from "./lib/overpass.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Output
const OUT = path.join(
  __dirname,
  "..",
  "public",
  "data",
  "pois",
  "regions",
  "it-veneto-borghi.json"
);

// ----------------------
// Overpass query: Veneto area + borghi/centri
// ----------------------
function buildQuery() {
  // Veneto = admin_level=4. Usiamo area da relation.
  return `
[out:json][timeout:240];

area
  ["boundary"="administrative"]
  ["admin_level"="4"]
  ["name"="Veneto"]
->.veneto;

(
  // Paesi e borgate (lista ampia = classici)
  nwr(area.veneto)["place"~"town|village|hamlet|suburb|quarter|neighbourhood"];

  // Centri storici / city centre
  nwr(area.veneto)["historic"="city_centre"];
  nwr(area.veneto)["place"="locality"]["name"];  // locality solo se ha name

  // Indicatori “turistici” utili per chicche (ma restano borghi)
  nwr(area.veneto)["historic"~"castle|fort|ruins|monument|archaeological_site"];
  nwr(area.veneto)["tourism"~"attraction|viewpoint|museum"];
  nwr(area.veneto)["heritage"];
);

out center tags;
`;
}

// ----------------------
// Anti-spazzatura (borghi)
// ----------------------
function tagEquals(tags, k, v) {
  return String(tags?.[k] ?? "").toLowerCase() === String(v).toLowerCase();
}

function isJunk(p) {
  const t = p.tags || {};
  const name = (p.name || "").trim();
  const n = name.toLowerCase();

  if (!name || name === "(senza nome)") return true;

  // strade/fermate ecc.
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

  // “SpA” aziendale (non borgo)
  if (/\bs\.p\.a\.?\b/i.test(name)) return true;
  if (n.includes("openjobmetis")) return true;

  return false;
}

// ----------------------
// Scoring + visibility
// ----------------------
function hasAny(tags, keys) {
  return keys.some((k) => tags[k] != null && String(tags[k]).trim() !== "");
}

function scoreBorgo(p) {
  const t = p.tags || {};
  const name = (p.name || "").toLowerCase();
  let s = 0;

  // base se è un place “vero”
  const place = String(t.place ?? "").toLowerCase();
  if (["town"].includes(place)) s += 35;
  if (["village"].includes(place)) s += 30;
  if (["hamlet"].includes(place)) s += 22;
  if (["suburb", "quarter", "neighbourhood"].includes(place)) s += 10;

  // centro storico / storico
  const historic = String(t.historic ?? "").toLowerCase();
  if (historic === "city_centre") s += 35;
  if (["castle", "fort", "ruins", "monument", "archaeological_site"].includes(historic)) s += 35;

  // tourism/heritage
  const tourism = String(t.tourism ?? "").toLowerCase();
  if (["attraction", "viewpoint", "museum"].includes(tourism)) s += 25;

  if (t.heritage) s += 18;

  // wikipedia/wikidata = “importante / turistico”
  if (hasAny(t, ["wikipedia"])) s += 25;
  if (hasAny(t, ["wikidata"])) s += 22;

  // keyword
  if (name.includes("borgo")) s += 10;
  if (name.includes("castello")) s += 10;

  // info utili
  if (hasAny(t, ["website", "contact:website"])) s += 5;

  return s;
}

// “chicca” solo se davvero alto, altrimenti classica
function visibilityFromScore(score) {
  // soglia volutamente ALTA per non svuotare i classici
  return score >= 70 ? "chicca" : "classica";
}

// ----------------------
// MAIN
// ----------------------
async function main() {
  console.log("Build BORGHl Veneto...");
  let data;

  try {
    data = await overpass(buildQuery(), { retries: 7, timeoutMs: 170000 });
  } catch (err) {
    console.error("⚠️ Overpass failed. Keeping previous dataset if it exists.");
    if (fs.existsSync(OUT)) {
      console.log("✔ Existing it-veneto-borghi.json found, not failing the build.");
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
    const key = `${(p.name || "").toLowerCase()}|${p.lat.toFixed(5)}|${p.lon.toFixed(5)}`;
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
        visibility: visibilityFromScore(score), // ✅ ecco la fix: classici pieni
        tags: Object.entries(p.tags || {}).slice(0, 80).map(([k, v]) => `${k}=${v}`),
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 12000); // largo: l’app sceglie poi

  await writeJson(OUT, {
    region_id: "it-veneto-borghi",
    country: "IT",
    label_it: "Veneto • Borghi",
    bbox_hint: { lat: 45.5, lng: 11.9, radius_km: 240 },
    generated_at: new Date().toISOString(),
    places,
  });

  const countClassica = places.filter((p) => p.visibility === "classica").length;
  const countChicca = places.filter((p) => p.visibility === "chicca").length;
  console.log(`✔ Written ${OUT} (${places.length} places) classica=${countClassica} chicca=${countChicca}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
