// scripts/build_borghi_veneto.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { overpass, toPlace, writeJson } from "./lib/overpass.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
// Overpass: BOR GHI (settlements + historic cores)
// ----------------------
function buildQueryVeneto() {
  // Veneto bbox approx: minLat 44.7, minLon 10.3, maxLat 46.7, maxLon 13.1
  return `
[out:json][timeout:240];
(
  // Centri abitati (nuclei)
  node(44.7,10.3,46.7,13.1)["place"~"^(hamlet|village|town|city)$"]["name"];
  way (44.7,10.3,46.7,13.1)["place"~"^(hamlet|village|town|city)$"]["name"];
  relation(44.7,10.3,46.7,13.1)["place"~"^(hamlet|village|town|city)$"]["name"];

  // Nuclei storici / old town
  node(44.7,10.3,46.7,13.1)["historic"~"^(city|town|village|hamlet|old_town)$"]["name"];
  way (44.7,10.3,46.7,13.1)["historic"~"^(city|town|village|hamlet|old_town)$"]["name"];
  relation(44.7,10.3,46.7,13.1)["historic"~"^(city|town|village|hamlet|old_town)$"]["name"];

  // Administrative boundary (comuni) — SOLO come fallback, poi filtriamo forte
  relation(44.7,10.3,46.7,13.1)["boundary"="administrative"]["admin_level"~"^(8|9)$"]["name"];
);
out center tags;
`;
}

// ----------------------
// Helpers
// ----------------------
function lower(s) {
  return String(s ?? "").toLowerCase();
}
function norm(s) {
  return lower(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hasAnyTag(tags, keys) {
  return keys.some((k) => tags[k] != null && String(tags[k]).trim() !== "");
}

function tagEq(tags, k, v) {
  return lower(tags?.[k]) === lower(v);
}

function nameHasAny(name, arr) {
  const n = norm(name);
  return arr.some((x) => n.includes(norm(x)));
}

// ----------------------
// Hard exclusions: roba NON borgo
// ----------------------
function isClearlyNotBorgo(p) {
  const t = p.tags || {};
  const name = norm(p.name);

  // natura/altimetria (NO borghi)
  if (t.natural) return true; // peak, saddle, cave_entrance, etc
  if (t.mountain_pass) return true;

  // infrastrutture/trasporti/strade
  if (t.highway) return true;
  if (t.railway) return true;
  if (t.public_transport) return true;

  // POI singoli tipici (non “borgo”)
  const amenity = lower(t.amenity);
  if (
    [
      "museum",
      "theatre",
      "cinema",
      "university",
      "hospital",
      "clinic",
      "pharmacy",
      "school",
      "bank",
      "police",
      "post_office",
    ].includes(amenity)
  )
    return true;

  const tourism = lower(t.tourism);
  if (["museum", "gallery"].includes(tourism)) return true;

  // nomi “non borgo”
  if (name.startsWith("via ")) return true;
  if (name.includes("case sparse")) return true;

  return false;
}

// ----------------------
// Settlement detection
// ----------------------
function settlementKind(tags) {
  const place = lower(tags.place);
  const hist = lower(tags.historic);

  if (["city", "town", "village", "hamlet"].includes(place)) return place;
  if (hist === "old_town") return "old_town";
  if (["city", "town", "village", "hamlet"].includes(hist)) return `historic_${hist}`;

  if (tags.boundary === "administrative" && /^(8|9)$/.test(String(tags.admin_level ?? "")))
    return "admin";

  return "";
}

// ----------------------
// Tourist/quality signals (quello che rende un borgo “visitabile”)
// ----------------------
function hasTouristSignals(p) {
  const t = p.tags || {};
  const name = p.name || "";

  // segnali qualità forti
  const quality =
    hasAnyTag(t, ["wikipedia", "wikidata"]) ||
    hasAnyTag(t, ["website", "contact:website", "opening_hours"]) ||
    hasAnyTag(t, ["heritage"]);

  // segnali turistici/storici forti
  const strongHistoric =
    t.historic != null &&
    [
      "old_town",
      "castle",
      "fort",
      "citywalls",
      "ruins",
      "monument",
      "archaeological_site",
      "memorial",
      "palace",
    ].includes(lower(t.historic));

  const tourismStrong =
    t.tourism != null &&
    ["attraction", "information", "museum", "viewpoint"].includes(lower(t.tourism));

  // punto panoramico / centro storico “mappato”
  const viewpoint = tagEq(t, "tourism", "viewpoint") || tagEq(t, "natural", "peak");

  // keyword nome (soft, ma utile)
  const nameSoft =
    nameHasAny(name, [
      "centro storico",
      "borgo",
      "castello",
      "rocca",
      "forte",
      "pieve",
      "abbazia",
      "duomo",
      "cattedrale",
      "belvedere",
      "panorama",
      "mura",
    ]);

  // turismo/servizi minimi (soft): se è piccolo ma ha almeno “vita”
  const amenity = lower(t.amenity);
  const hasLifeAmenity = ["restaurant", "cafe", "bar", "pub"].includes(amenity);

  return quality || strongHistoric || tourismStrong || viewpoint || (nameSoft && hasLifeAmenity);
}

// ----------------------
// Main filter: piccoli sì, ma devono essere turistici
// ----------------------
function isTouristicBorgoCandidate(p) {
  const t = p.tags || {};
  const kind = settlementKind(t);
  const name = p.name || "";

  // città/paesi grossi: ok
  if (kind === "city" || kind === "town") return true;

  // old_town: ok (già di suo è segnale forte)
  if (kind === "old_town") return true;

  // comuni (boundary): SOLO se hanno segnali forti (wiki / historic / tourism)
  if (kind === "admin") {
    const ok =
      hasAnyTag(t, ["wikipedia", "wikidata"]) ||
      (t.historic && lower(t.historic) === "old_town") ||
      (t.tourism && ["attraction", "viewpoint"].includes(lower(t.tourism)));
    return ok;
  }

  // village/hamlet: SOLO se turistico/qualità
  if (kind === "village" || kind === "hamlet" || kind.startsWith("historic_")) {
    // caso tipico “Borgo X” random: tagliato se non ha segnali
    const looksLikeFakeBorgo =
      norm(name).startsWith("borgo ") && !hasTouristSignals(p);

    if (looksLikeFakeBorgo) return false;

    return hasTouristSignals(p);
  }

  return false;
}

// ----------------------
// Classificazione
// ----------------------
function borgoType(tags, name) {
  const t = tags || {};
  const nm = String(name || "");

  const strong =
    hasAnyTag(t, ["wikipedia", "wikidata"]) ||
    lower(t.historic) === "old_town" ||
    lower(t.tourism) === "attraction" ||
    lower(t.tourism) === "viewpoint" ||
    hasAnyTag(t, ["heritage"]) ||
    nameHasAny(nm, ["centro storico", "borgo", "castello", "rocca"]);

  return strong ? "classico" : "chicca";
}

function scoreBorgo(p) {
  const t = p.tags || {};
  const name = p.name || "";
  let s = 0;

  const kind = settlementKind(t);

  // settlement
  if (kind === "city") s += 35;
  if (kind === "town") s += 50;
  if (kind === "village") s += 55;
  if (kind === "hamlet") s += 40;
  if (kind === "old_town") s += 90;
  if (kind.startsWith("historic_")) s += 65;

  // qualità
  if (hasAnyTag(t, ["wikipedia", "wikidata"])) s += 30;
  if (hasAnyTag(t, ["website", "contact:website"])) s += 8;
  if (hasAnyTag(t, ["opening_hours"])) s += 6;

  // turismo/storia
  if (t.historic) s += 10;
  if (["castle", "fort", "citywalls", "ruins", "monument", "archaeological_site"].includes(lower(t.historic)))
    s += 20;

  if (["attraction", "viewpoint", "information"].includes(lower(t.tourism))) s += 18;

  // keyword nome
  if (nameHasAny(name, ["centro storico"])) s += 10;
  if (nameHasAny(name, ["borgo"])) s += 6;
  if (nameHasAny(name, ["castello", "rocca", "forte", "abbazia", "pieve"])) s += 8;

  // penalità: admin-only
  if (kind === "admin") s -= 18;

  // penalità: “borgo X” senza segnali (doppia sicurezza)
  if (norm(name).startsWith("borgo ") && !hasTouristSignals(p)) s -= 60;

  return s;
}

// ----------------------
// MAIN
// ----------------------
async function main() {
  console.log("Build BOR GHI Veneto (turistici + piccoli) ...");
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
    .filter((p) => settlementKind(p.tags || {}))          // deve essere settlement-like
    .filter((p) => isTouristicBorgoCandidate(p));         // 🔥 QUI la magia: piccoli sì, ma turistici

  // Dedup (nome + coordinate)
  const seen = new Set();
  const deduped = [];
  for (const p of raw) {
    const key = `${norm(p.name)}|${Number(p.lat).toFixed(5)}|${Number(p.lon).toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  const places = deduped
    .map((p) => {
      const tagsObj = p.tags || {};
      const bType = borgoType(tagsObj, p.name);

      return {
        id: p.id,
        name: p.name,
        lat: p.lat,
        lon: p.lon,
        type: "borgo",
        borgo_type: bType, // "classico" | "chicca"
        visibility: bType === "classico" ? "classica" : "chicca",
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
    label_it: "Veneto • Borghi (turistici + piccoli)",
    generated_at: new Date().toISOString(),
    places,
  });

  console.log(`✔ Written ${OUT} (${places.length} places)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
