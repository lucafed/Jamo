// scripts/build_borghi_veneto.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { overpass, toPlace, writeJson } from "./lib/overpass.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUT = path.join(__dirname, "..", "public", "data", "pois", "regions", "it-veneto-borghi.json");

// ----------------------
// Overpass: BOR GHI (settlements + historic cores)
// ----------------------
function buildQueryVeneto() {
  // Veneto bbox approx (un po' largo): minLat 44.7, minLon 10.3, maxLat 46.7, maxLon 13.1
  // Nota: Overpass non ama bbox enormi con query troppo ampia: qui stiamo già stretti sugli oggetti.
  return `
[out:json][timeout:240];
(
  // Centri abitati (nuclei)
  node(44.7,10.3,46.7,13.1)["place"~"^(hamlet|village|town|city)$"]["name"];
  way (44.7,10.3,46.7,13.1)["place"~"^(hamlet|village|town|city)$"]["name"];
  relation(44.7,10.3,46.7,13.1)["place"~"^(hamlet|village|town|city)$"]["name"];

  // Nuclei storici / old town (a volte mappati così)
  node(44.7,10.3,46.7,13.1)["historic"~"^(city|town|village|hamlet|old_town)$"]["name"];
  way (44.7,10.3,46.7,13.1)["historic"~"^(city|town|village|hamlet|old_town)$"]["name"];
  relation(44.7,10.3,46.7,13.1)["historic"~"^(city|town|village|hamlet|old_town)$"]["name"];

  // Administrative boundary (comuni) — utile per “borghi veri” quando manca place
  relation(44.7,10.3,46.7,13.1)["boundary"="administrative"]["admin_level"~"^(8|9)$"]["name"];
);
out center tags;
`;
}

// ----------------------
// Helpers
// ----------------------
function lower(s) { return String(s ?? "").toLowerCase(); }

function hasAnyTag(tags, keys) {
  return keys.some((k) => tags[k] != null && String(tags[k]).trim() !== "");
}

function isClearlyNotBorgo(p) {
  const t = p.tags || {};
  const name = lower(p.name);

  // roba natura/altimetria (NO borghi)
  if (t.natural) return true;                  // peak, saddle, cave_entrance, etc
  if (t.mountain_pass) return true;
  if (t.peak) return true;

  // infrastrutture/trasporti/strade
  if (t.highway) return true;
  if (t.railway) return true;
  if (t.public_transport) return true;

  // POI singoli tipici (non “borgo”)
  const amenity = lower(t.amenity);
  if (["museum","theatre","cinema","university","hospital","clinic","pharmacy","school","bank","police","post_office"].includes(amenity)) return true;

  const tourism = lower(t.tourism);
  if (["museum","gallery","attraction"].includes(tourism)) {
    // attraction può essere borgo “mappato male”: la teniamo SOLO se è anche un settlement
    const place = lower(t.place);
    const hist = lower(t.historic);
    const isSettlement = ["hamlet","village","town","city"].includes(place) || ["old_town","city","town","village","hamlet"].includes(hist);
    if (!isSettlement) return true;
  }

  // nomi “non borgo”
  if (name.startsWith("via ") || name.includes("case sparse")) return true;

  return false;
}

function isSettlementLike(tags) {
  const place = lower(tags.place);
  const hist = lower(tags.historic);

  if (["hamlet","village","town","city"].includes(place)) return true;
  if (["old_town","city","town","village","hamlet"].includes(hist)) return true;

  // fallback: boundary admin_level (comune) — lo consideriamo “settlement-like”
  if (tags.boundary === "administrative" && /^(8|9)$/.test(String(tags.admin_level ?? ""))) return true;

  return false;
}

function borgoType(tags) {
  // "classico" = settlement + qualche segnale di "storico/turistico"
  const name = lower(tags.name);
  const hist = lower(tags.historic);
  const hasHistoricSignal =
    hist === "old_town" ||
    hasAnyTag(tags, ["wikipedia", "wikidata"]) ||
    lower(tags.tourism) === "attraction" ||
    lower(tags["heritage"]) !== "" ||
    name.includes("borgo") ||
    name.includes("castello") ||     // spesso “Borgo + castello” nel nome
    name.includes("centro storico");

  return hasHistoricSignal ? "classico" : "chicca";
}

function scoreBorgo(p) {
  const t = p.tags || {};
  const name = lower(p.name);
  let s = 0;

  // settlement forti
  const place = lower(t.place);
  if (place === "city") s += 35;
  if (place === "town") s += 45;
  if (place === "village") s += 55;
  if (place === "hamlet") s += 40;

  // storico/turistico
  const hist = lower(t.historic);
  if (hist === "old_town") s += 80;
  if (["city","town","village","hamlet"].includes(hist)) s += 50;

  if (hasAnyTag(t, ["wikipedia", "wikidata"])) s += 25;
  if (lower(t.tourism) === "attraction") s += 15;

  // micro bonus info utili
  if (hasAnyTag(t, ["website", "contact:website"])) s += 5;

  // penalità: se è solo boundary comune senza altri segnali
  const isOnlyBoundary =
    t.boundary === "administrative" &&
    !t.place &&
    !t.historic &&
    !hasAnyTag(t, ["wikipedia", "wikidata", "tourism", "name:it"]);
  if (isOnlyBoundary) s -= 20;

  // keyword nome
  if (name.includes("borgo")) s += 10;
  if (name.includes("centro storico")) s += 12;

  return s;
}

// ----------------------
// MAIN
// ----------------------
async function main() {
  console.log("Build BOR GHI Veneto (pulito) ...");
  let data;

  try {
    data = await overpass(buildQueryVeneto(), { retries: 7, timeoutMs: 180000 });
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
    .filter((p) => (p.name || "").trim() !== "" && (p.name || "").trim() !== "(senza nome)")
    .filter((p) => !isClearlyNotBorgo(p))
    .filter((p) => isSettlementLike(p.tags || {})); // 🔥 chiave: solo settlement

  // Dedup (nome + coordinate)
  const seen = new Set();
  const deduped = [];
  for (const p of raw) {
    const key = `${lower(p.name)}|${p.lat.toFixed(5)}|${p.lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  const places = deduped
    .map((p) => {
      const tagsObj = p.tags || {};
      const bType = borgoType({ ...tagsObj, name: p.name });

      return {
        id: p.id,
        name: p.name,
        lat: p.lat,
        lon: p.lon,
        type: "borgo",
        borgo_type: bType,                  // ✅ "classico" | "chicca"
        visibility: bType === "classico" ? "classica" : "chicca", // ✅ aggancio per UI
        tags: Object.entries(tagsObj).slice(0, 60).map(([k, v]) => `${k}=${v}`),
        score: scoreBorgo(p),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 12000);

  await writeJson(OUT, {
    region_id: "it-veneto-borghi",
    country: "IT",
    area: "Veneto",
    label_it: "Veneto • Borghi (pulito)",
    generated_at: new Date().toISOString(),
    places,
  });

  console.log(`✔ Written ${OUT} (${places.length} places)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
