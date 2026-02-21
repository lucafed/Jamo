#!/usr/bin/env node
/**
 * build_curated_borghi.mjs
 * Genera dataset "A" Borghi WOW per tutte le regioni IT.
 *
 * INPUT:
 *   public/data/pois/regions/it-*-borghi.json
 *
 * OUTPUT:
 *   public/data/curated/regions/it-*-borghi.json
 *
 * ESEGUI:
 *   node scripts/build_curated_borghi.mjs
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const IN_DIR = path.join(ROOT, "public", "data", "pois", "regions");
const OUT_DIR = path.join(ROOT, "public", "data", "curated", "regions");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonPretty(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tagsStr(place) {
  const tags = Array.isArray(place?.tags) ? place.tags : [];
  return tags.map((t) => String(t).toLowerCase()).join(" ");
}

function hasAny(str, arr) {
  for (const k of arr) if (str.includes(k)) return true;
  return false;
}

// Segnali qualità (ti tengono dentro mete “vere”)
function hasQualitySignals(place) {
  const t = tagsStr(place);
  return (
    t.includes("wikipedia=") ||
    t.includes("wikidata=") ||
    t.includes("website=") ||
    t.includes("contact:website=") ||
    t.includes("opening_hours=") ||
    t.includes("phone=") ||
    t.includes("contact:phone=")
  );
}

// Segnali turistici (WOW + servito)
function hasTouristSignals(place) {
  const t = tagsStr(place);
  const n = norm(place?.name || "");

  const osmTourism =
    t.includes("tourism=attraction") ||
    t.includes("tourism=museum") ||
    t.includes("tourism=gallery") ||
    t.includes("tourism=viewpoint") ||
    t.includes("tourism=information") ||
    t.includes("historic=") ||
    t.includes("heritage=") ||
    t.includes("leisure=park") ||
    t.includes("leisure=garden");

  const services =
    t.includes("amenity=restaurant") ||
    t.includes("amenity=cafe") ||
    t.includes("amenity=bar") ||
    t.includes("amenity=toilets") ||
    t.includes("tourism=hotel") ||
    t.includes("tourism=guest_house");

  const wowName = hasAny(n, [
    "centro storico",
    "borgo",
    "castello",
    "rocca",
    "torre",
    "abbazia",
    "duomo",
    "cattedrale",
    "santuario",
    "pieve",
    "belvedere",
    "panorama",
    "muraglia",
    "mura",
  ]);

  return hasQualitySignals(place) || osmTourism || services || wowName;
}

// Escludi roba che ti sta uscendo (case sparse, cascine, ristoranti, ecc.)
function isJunkBorgoByName(place) {
  const n = norm(place?.name || "");
  if (!n) return true;

  // roba NON borgo
  if (
    hasAny(n, [
      "case sparse",
      "cascina",
      "azienda agricola",
      "agriturismo",
      "albergo",
      "hotel",
      "pizzeria",
      "ristorante",
      "trattoria",
      "bar ",
      "pub ",
      "b b",
      "b&b",
      "residence",
      "campeggio",
      "camping",
      "museo", // un museo non è borgo
      "centro commerciale",
      "outlet",
      "supermercato",
      "market",
      "stazione",
      "parcheggio",
      "area di servizio",
      "distributore",
      "ospedale",
      "clinica",
      "farmacia",
      "studio",
      "palestra",
      "scuola",
      "universita",
      "municipio",
      "comune",
      "cimitero",
    ])
  )
    return true;

  // “Borgo della salute” ecc: spesso è brand/struttura
  if (hasAny(n, ["borgo della salute", "borgo del benessere", "borgo wellness"])) return true;

  // nomi troppo generici
  if (n.length < 4) return true;

  return false;
}

function isSpaLike(place) {
  const t = tagsStr(place);
  const n = norm(place?.name || "");
  return (
    t.includes("amenity=spa") ||
    t.includes("leisure=spa") ||
    t.includes("tourism=spa") ||
    t.includes("natural=hot_spring") ||
    hasAny(n, ["terme", "termale", "spa", "wellness", "benessere", "sauna", "hammam", "hamam"])
  );
}

// Regola “A” Borghi: settlement vero + segnali turistici.
// NO frazioni random senza segnali, NO spa, NO castelli (quelli vanno in “storia”).
function isBorgoA(place) {
  const t = tagsStr(place);
  const n = norm(place?.name || "");

  if (isJunkBorgoByName(place)) return false;
  if (isSpaLike(place)) return false;

  // castelli/fortificazioni NON sono borghi
  if (
    t.includes("historic=castle") ||
    t.includes("historic=fort") ||
    t.includes("historic=citywalls") ||
    t.includes("historic=ruins")
  )
    return false;

  // settlement vero
  const isSettlement =
    t.includes("place=village") ||
    t.includes("place=town") ||
    t.includes("place=city");

  // hamlet/suburb/neighbourhood ammessi SOLO se super forti (qualità + turismo)
  const isWeakSettlement =
    t.includes("place=hamlet") || t.includes("place=suburb") || t.includes("place=neighbourhood");

  const saysBorgo =
    hasAny(n, ["borgo", "centro storico"]) ||
    t.includes("place=village") ||
    t.includes("place=town");

  const strongSignals = hasTouristSignals(place);
  const quality = hasQualitySignals(place);

  if (isSettlement) return strongSignals; // borgo “vero” ma deve essere visitabile
  if (isWeakSettlement) return strongSignals && quality; // qui stringiamo: evita “case sparse”
  if (saysBorgo) return strongSignals && (quality || t.includes("historic=") || t.includes("heritage="));

  return false;
}

// scoring: preferisci chicche + qualità + storico, penalizza robe “anonime”
function scoreBorgoA(place) {
  const t = tagsStr(place);
  const n = norm(place?.name || "");

  let s = 0;

  // qualità
  if (hasQualitySignals(place)) s += 3;

  // storico/heritage = wow
  if (t.includes("heritage=")) s += 2;
  if (t.includes("historic=")) s += 2;

  // segnali turismo
  if (t.includes("tourism=attraction")) s += 2;
  if (t.includes("tourism=viewpoint")) s += 1;

  // name wow
  if (hasAny(n, ["centro storico", "borgo", "pieve", "duomo", "abbazia"])) s += 1;

  // se “solo villaggio” ma senza niente: giù
  if (!hasTouristSignals(place)) s -= 3;

  return s;
}

function stableId(place) {
  if (place?.id) return String(place.id);
  const nm = norm(place?.name || "x").slice(0, 40);
  const lat = String(place?.lat ?? "").slice(0, 8);
  const lon = String(place?.lon ?? place?.lng ?? "").slice(0, 8);
  return `p_${nm}_${lat}_${lon}`;
}

function main() {
  if (!fs.existsSync(IN_DIR)) {
    console.error("❌ Input dir non trovato:", IN_DIR);
    process.exit(1);
  }

  ensureDir(OUT_DIR);

  const files = fs
    .readdirSync(IN_DIR)
    .filter((f) => /^it-[a-z0-9_-]+-borghi\.json$/i.test(f))
    .sort();

  if (!files.length) {
    console.error("❌ Nessun file it-*-borghi.json trovato in:", IN_DIR);
    process.exit(1);
  }

  let totalIn = 0;
  let totalOut = 0;

  for (const f of files) {
    const inPath = path.join(IN_DIR, f);
    const j = readJsonSafe(inPath);
    const placesRaw = Array.isArray(j?.places) ? j.places : [];

    totalIn += placesRaw.length;

    // normalizza
    const normed = placesRaw
      .map((p) => {
        const lat = Number(p?.lat);
        const lon = Number(p?.lon ?? p?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return {
          ...p,
          lat,
          lon,
          name: String(p?.name || "").trim(),
          tags: Array.isArray(p?.tags) ? p.tags.map((x) => String(x).toLowerCase()) : [],
          area: String(p?.area || ""),
          country: String(p?.country || "").toUpperCase(),
        };
      })
      .filter(Boolean);

    // filtro A
    const filtered = normed.filter(isBorgoA);

    // de-duplica per id
    const seen = new Set();
    const dedup = [];
    for (const p of filtered) {
      const pid = stableId(p);
      if (seen.has(pid)) continue;
      seen.add(pid);
      dedup.push(p);
    }

    // ordina per score (WOW)
    dedup.sort((a, b) => scoreBorgoA(b) - scoreBorgoA(a));

    const out = {
      updated_at: new Date().toISOString(),
      kind: "curated",
      category: "borghi",
      source: `pois/regions/${f}`,
      count_in: placesRaw.length,
      count_out: dedup.length,
      places: dedup,
    };

    const outPath = path.join(OUT_DIR, f);
    writeJsonPretty(outPath, out);

    totalOut += dedup.length;

    console.log(`✅ ${f}: ${placesRaw.length} -> ${dedup.length}`);
  }

  console.log("—");
  console.log(`DONE ✅ Totale: ${totalIn} -> ${totalOut}`);
  console.log("Output in:", OUT_DIR);
}

main();
