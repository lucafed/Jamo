// scripts/build_relax_radius.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { overpass, toPlace, writeJson } from "./lib/overpass.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Supporta sia CENTER_* che RADIUS_* (così va bene col workflow)
const CENTER_LAT = Number(process.env.CENTER_LAT ?? process.env.RADIUS_LAT ?? 45.5209);
const CENTER_LON = Number(process.env.CENTER_LON ?? process.env.RADIUS_LON ?? 10.8686);

// ✅ Default un po’ più ampio per non “morire” fuori Verona/Garda
const RADIUS_KM = Number(process.env.RADIUS_KM ?? 160);
const RADIUS_M = Math.round(RADIUS_KM * 1000);

// ✅ Output
const OUT = path.join(__dirname, "..", "public", "data", "pois", "regions", "radius-relax.json");

// ----------------------
// Query Overpass (RELAX) — più precisa, meno spazzatura
// ----------------------
function buildQuery(lat, lon, radiusM) {
  // NB: includiamo “amenity=spa” (esiste), e hotel/resort SOLO se hanno segnali spa/wellness
  return `
[out:json][timeout:180];

(
  // --- Segnali forti (tag standard) ---
  nwr(around:${radiusM},${lat},${lon})["tourism"="spa"];
  nwr(around:${radiusM},${lat},${lon})["amenity"="public_bath"];
  nwr(around:${radiusM},${lat},${lon})["amenity"="sauna"];
  nwr(around:${radiusM},${lat},${lon})["amenity"="spa"];
  nwr(around:${radiusM},${lat},${lon})["leisure"="spa"];
  nwr(around:${radiusM},${lat},${lon})["healthcare"="spa"];
  nwr(around:${radiusM},${lat},${lon})["natural"="hot_spring"];

  // --- “thermal” e simili (spesso su public_bath / spa) ---
  nwr(around:${radiusM},${lat},${lon})["bath:type"~"thermal",i];

  // --- Hotel/resort con indicazione esplicita di spa/wellness ---
  nwr(around:${radiusM},${lat},${lon})["tourism"~"hotel|resort|guest_house|motel"]["spa"];
  nwr(around:${radiusM},${lat},${lon})["tourism"~"hotel|resort|guest_house|motel"]["wellness"];

  // --- Fallback: strutture turistiche che nel NOME dichiarano spa/terme/sauna/wellness ---
  nwr(around:${radiusM},${lat},${lon})["tourism"~"hotel|resort|guest_house|motel"]["name"~"terme|spa|sauna|wellness|thermal",i];

  // --- Fallback “soft”: POI con nome chiarissimo (anche se tag non perfetti) ---
  nwr(around:${radiusM},${lat},${lon})["name"~"terme|bagni termali|hot spring|thermal baths",i];
);

out center tags;
`;
}

// ----------------------
// Helpers
// ----------------------
function hasAnyTag(tags, keys) {
  return keys.some((k) => tags[k] != null && String(tags[k]).trim() !== "");
}

function tagEquals(tags, k, v) {
  return String(tags[k] ?? "").toLowerCase() === String(v).toLowerCase();
}

function nameHasWord(name, word) {
  // match “spa” come parola, non come parte di “spagnolli”
  const re = new RegExp(`\\b${word}\\b`, "i");
  return re.test(name);
}

function hasStrongRelaxSignal(t = {}, name = "") {
  const n = (name || "").toLowerCase();

  return (
    tagEquals(t, "tourism", "spa") ||
    tagEquals(t, "leisure", "spa") ||
    tagEquals(t, "amenity", "public_bath") ||
    tagEquals(t, "amenity", "sauna") ||
    tagEquals(t, "amenity", "spa") ||
    tagEquals(t, "natural", "hot_spring") ||
    String(t["bath:type"] ?? "").toLowerCase().includes("thermal") ||
    (t.spa && String(t.spa).toLowerCase() !== "no") ||
    (t.wellness && String(t.wellness).toLowerCase() !== "no") ||
    n.includes("terme") ||
    nameHasWord(n, "spa") ||
    n.includes("sauna") ||
    n.includes("wellness") ||
    n.includes("thermal")
  );
}

// ----------------------
// Anti-spazzatura (più robusto, meno aggressivo)
// ----------------------
function isClearlyNotRelax(p) {
  const t = p.tags || {};
  const name = (p.name || "").trim();
  const n = name.toLowerCase();

  // Se non abbiamo un nome “serio”, via
  if (!name || name === "(senza nome)") return true;

  // Strade / vie / highway
  if (t.highway) return true;
  if (t.railway) return true;
  if (t.public_transport) return true;
  if (tagEquals(t, "highway", "bus_stop")) return true;

  // Fermate / piattaforme
  if (tagEquals(t, "public_transport", "platform")) return true;
  if (tagEquals(t, "railway", "platform")) return true;

  // Nomi inutili tipici
  if (n.startsWith("via ")) return true;
  if (n.includes("case sparse")) return true;

  // Aziende/uffici/industria: scarto SOLO se NON ho segnali forti di relax
  const strong = hasStrongRelaxSignal(t, name);

  const building = String(t.building ?? "").toLowerCase();
  const landuse = String(t.landuse ?? "").toLowerCase();
  const office = String(t.office ?? "").toLowerCase();

  if (!strong) {
    if (building && ["office", "industrial", "warehouse", "retail", "commercial"].includes(building)) return true;
    if (landuse && ["industrial", "commercial", "retail"].includes(landuse)) return true;
    if (office) return true;

    // servizi chiaramente non relax
    const amenity = String(t.amenity ?? "").toLowerCase();
    if (amenity && ["bank", "school", "clinic", "hospital", "pharmacy", "police", "post_office"].includes(amenity)) return true;

    // “SpA” come società (Openjobmetis SpA ecc.)
    // Qui facciamo: se contiene “s.p.a / spa” MA non contiene parole relax -> scarta
    const looksLikeCompany =
      /\bs\.p\.a\.?\b/i.test(name) || /\bspa\b/i.test(name); // attenzione: questo prende anche “XYZ Spa”
    const relaxWords = n.includes("terme") || n.includes("sauna") || n.includes("wellness") || n.includes("thermal") || n.includes("bagni");
    const spaAsWellness = nameHasWord(n, "spa") && relaxWords; // “spa” + contesto relax

    if (looksLikeCompany && !spaAsWellness && !relaxWords) return true;

    // “azienda” esplicito
    if (n.includes("azienda")) return true;
  }

  return false;
}

// ----------------------
// Scoring (migliorato)
// ----------------------
function scoreRelax(p) {
  const t = p.tags || {};
  const name = (p.name || "").toLowerCase();
  let s = 0;

  // segnali forti
  if (tagEquals(t, "natural", "hot_spring")) s += 90;
  if (tagEquals(t, "amenity", "public_bath")) s += 80;
  if (tagEquals(t, "tourism", "spa")) s += 75;
  if (tagEquals(t, "leisure", "spa")) s += 70;
  if (tagEquals(t, "amenity", "sauna")) s += 60;
  if (tagEquals(t, "amenity", "spa")) s += 60;

  // “thermal”
  const bathType = String(t["bath:type"] ?? "").toLowerCase();
  if (bathType.includes("thermal")) s += 55;

  // parole chiave nel nome
  if (name.includes("terme")) s += 55;
  if (name.includes("bagni")) s += 20;
  if (name.includes("sauna")) s += 25;
  if (name.includes("wellness")) s += 25;
  if (name.includes("thermal")) s += 25;
  if (nameHasWord(name, "spa")) s += 18;

  // hotel/resort: ok ma meno “priorità” rispetto a terme vere
  const tourism = String(t.tourism ?? "").toLowerCase();
  if (["hotel", "resort", "guest_house", "motel"].includes(tourism)) s += 8;

  // info utili
  if (hasAnyTag(t, ["website", "contact:website"])) s += 10;
  if (hasAnyTag(t, ["opening_hours"])) s += 6;
  if (hasAnyTag(t, ["phone", "contact:phone"])) s += 6;

  // penalità se sembra azienda
  if (name.includes("azienda")) s -= 40;
  if (/\bs\.p\.a\.?\b/i.test(p.name || "")) s -= 25;

  // penalità se building/landuse da ufficio/industria (ma non uccidere se è davvero spa)
  const building = String(t.building ?? "").toLowerCase();
  const landuse = String(t.landuse ?? "").toLowerCase();
  if (building && ["office", "industrial", "warehouse"].includes(building)) s -= 70;
  if (landuse && ["industrial", "commercial"].includes(landuse)) s -= 50;

  return s;
}

// ----------------------
// MAIN
// ----------------------
async function main() {
  console.log(`Build RELAX radius: center=${CENTER_LAT},${CENTER_LON} radius=${RADIUS_KM}km`);
  let data;

  try {
    const q = buildQuery(CENTER_LAT, CENTER_LON, RADIUS_M);
    data = await overpass(q, { retries: 7, timeoutMs: 150000 });
  } catch (err) {
    console.error("⚠️ Overpass failed. Keeping previous dataset if it exists.");
    if (fs.existsSync(OUT)) {
      console.log("✔ Existing radius-relax.json found, not failing the build.");
      return;
    }
    throw err;
  }

  const raw = (data.elements || [])
    .map(toPlace)
    .filter((p) => p.lat != null && p.lon != null)
    .filter((p) => !isClearlyNotRelax(p));

  // Dedup (stesso nome + coordinate)
  const seen = new Set();
  const deduped = [];
  for (const p of raw) {
    const key = `${(p.name || "").toLowerCase()}|${p.lat.toFixed(5)}|${p.lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  // Score + sort
  const scored = deduped
    .map((p) => ({
      id: p.id,
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      type: "relax",
      visibility: "classica",
      tags: Object.entries(p.tags || {}).slice(0, 80).map(([k, v]) => `${k}=${v}`),
      score: scoreRelax(p),
    }))
    .sort((a, b) => b.score - a.score);

  // Non stringo troppo: lascio tanto materiale e poi l’app sceglie
  const places = scored.slice(0, 12000);

  await writeJson(OUT, {
    region_id: "radius-relax",
    label_it: `Radius • Relax (${RADIUS_KM}km)`,
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
