// scripts/enrich_family_and_borghi.mjs
// Enrichment "FAMILY FIRST" per tutte le macro in public/data/macros
// - Non rompe nulla: aggiunge solo campi nuovi ai places
// - Aggiunge: family_level, ideal_for, age_groups, borgho, storia_score, walkable, family_reasons, quick_cards
//
// Uso:
//   node scripts/enrich_family_and_borghi.mjs
// Opzioni:
//   node scripts/enrich_family_and_borghi.mjs --dry
//   node scripts/enrich_family_and_borghi.mjs --dir public/data/macros
//
// Nota: ESM (Node 20). Nessuna dipendenza.

import fs from "fs";
import path from "path";

const ROOT = process.cwd();

function argValue(name, def = null) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return def;
}

const DRY = process.argv.includes("--dry");
const MACROS_DIR = path.join(ROOT, argValue("--dir", "public/data/macros"));

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

// keyword packs (italiano + inglese)
// FAMILY = qualsiasi cosa che un genitore considera "adatta e comoda"
const KW = {
  familyHigh: [
    "parco giochi", "playground", "luna park", "lunapark", "giostre",
    "zoo", "acquario", "aquarium",
    "parco avventura", "adventure park", "zipline", "zip line",
    "waterpark", "acquapark", "aqua park", "piscina", "pool",
    "fattoria didattica", "farm", "petting zoo",
    "castello", "castle", "forte", "fortress",
    "spiaggia", "beach", "lido",
    "lago", "lake",
    "funivia", "cable car", "cablecar",
    "museo dei bambini", "children museum", "science center", "planetario", "planetarium"
  ],
  familyMed: [
    "parco", "park", "giardino", "garden",
    "sentiero facile", "easy trail", "passeggiata", "walk",
    "centro storico", "old town", "promenade",
    "belvedere", "viewpoint",
    "terme", "spa", "hot spring", "hot springs",
    "riserva", "reserve",
    "santuario", "abbazia", "abbey"
  ],
  story: [
    "museo", "museum",
    "castello", "castle",
    "forte", "fortress",
    "rovine", "ruins",
    "anfiteatro", "amphitheatre", "amphitheater",
    "teatro romano", "roman theater", "roman theatre",
    "basilica", "cattedrale", "cathedral",
    "chiesa", "church",
    "monastero", "monastery",
    "abbazia", "abbey",
    "necropolis", "necropoli",
    "archeologico", "archaeological", "archeology", "archaeology",
    "centro storico", "old town"
  ],
  borgo: [
    "borgo", "borghi", "hamlet", "village", "villaggio",
    "centro storico", "old town",
    "castello", "castle",
    "rocca", "forte", "fortress",
    "paese", "paesino"
  ],
  notWalkable: [
    "trek", "trekking", "hike", "hiking",
    "vetta", "summit",
    "rifugio", "hut",
    "via ferrata", "ferrata",
    "gola", "canyon"
  ]
};

function hasAny(text, list) {
  const t = norm(text);
  for (const k of list) {
    if (t.includes(norm(k))) return true;
  }
  return false;
}

function scoreFromKeywords(name, tags, list, weight = 1) {
  const t = `${norm(name)} ${norm((tags || []).join(" "))}`;
  let hit = 0;
  for (const k of list) if (t.includes(norm(k))) hit++;
  return hit * weight;
}

// Calcolo “storia_score” 0..1
function computeStoryScore(name, tags) {
  const base = scoreFromKeywords(name, tags, KW.story, 1);
  // normalizza con soft cap
  const s = Math.min(1, base / 6);
  return Number(s.toFixed(2));
}

// Calcolo “family_level” + età
function computeFamily(name, tags, type) {
  const t = `${norm(name)} ${norm((tags || []).join(" "))} ${norm(type)}`;

  const hi = scoreFromKeywords(name, tags, KW.familyHigh, 1);
  const med = scoreFromKeywords(name, tags, KW.familyMed, 0.6);

  // Boost se già etichettato come family/bambini/famiglie
  let boost = 0;
  if (t.includes("family") || t.includes("famigl")) boost += 1.2;
  if (t.includes("bambin") || t.includes("kids") || t.includes("children")) boost += 1.1;

  const raw = hi + med + boost;

  let level = "low";
  if (raw >= 2.2) level = "high";
  else if (raw >= 1.0) level = "medium";

  // Età consigliate (euristiche)
  const age = new Set();
  if (level === "high") {
    age.add("0-3");
    age.add("4-6");
    age.add("7-12");
  }
  if (hasAny(t, ["zip", "avventura", "adventure", "funivia", "cable"])) age.add("7-12");
  if (hasAny(t, ["museo", "museum", "castello", "castle", "centro storico"])) age.add("4-6");
  if (hasAny(t, ["trek", "hike", "ferrata", "canyon"])) age.add("13-17");

  // se non abbiamo nulla ma level medium/high, default 4-12
  if ((level === "medium" || level === "high") && age.size === 0) {
    age.add("4-6");
    age.add("7-12");
  }

  // Motivi rapidi (mostrabili nella UI)
  const reasons = [];
  if (hasAny(t, ["parco giochi", "playground", "giostre", "lunapark", "luna park"])) reasons.push("Giochi e divertimento per bambini");
  if (hasAny(t, ["zoo", "acquario", "aquarium", "fattoria", "farm"])) reasons.push("Animali e attività per famiglie");
  if (hasAny(t, ["spiaggia", "beach", "lago", "lake"])) reasons.push("Relax facile con i bimbi");
  if (hasAny(t, ["centro storico", "old town", "borgo"])) reasons.push("Passeggiata semplice e scenica");
  if (hasAny(t, ["parco", "park", "giardino", "garden"])) reasons.push("Spazi aperti e aria buona");
  if (reasons.length === 0 && level !== "low") reasons.push("Buona scelta per un’uscita in famiglia");

  return {
    family_level: level,
    age_groups: uniq([...age]),
    family_reasons: uniq(reasons).slice(0, 4)
  };
}

function computeBorgo(name, tags, type) {
  const t = `${norm(name)} ${norm((tags || []).join(" "))} ${norm(type)}`;
  // borgho true se match forte
  const strong = hasAny(t, ["borgo", "borghi", "hamlet", "village", "centro storico"]);
  const weak = hasAny(t, KW.borgo);
  return strong || weak;
}

function computeWalkable(name, tags, type) {
  const t = `${norm(name)} ${norm((tags || []).join(" "))} ${norm(type)}`;
  if (hasAny(t, KW.notWalkable)) return false;
  if (t.includes("montagna") || t.includes("trekking")) return false;

  // borghi e centri storici in genere walkable
  if (hasAny(t, ["borgo", "centro storico", "old town", "passeggiata"])) return true;

  // default: true (meglio dare “walkable” se non è chiaramente trekking)
  return true;
}

// “ideal_for” -> array di profili
function computeIdealFor(familyLevel, storyScore, isBorgo, type, tags) {
  const out = new Set();

  // family
  if (familyLevel === "high" || familyLevel === "medium") {
    out.add("famiglie");
    out.add("bambini");
  }

  // story
  if (storyScore >= 0.35) out.add("storia");

  // borghi
  if (isBorgo) out.add("borghi");

  // relax / natura
  const t = `${norm(type)} ${norm((tags || []).join(" "))}`;
  if (t.includes("relax") || t.includes("terme") || t.includes("spa")) out.add("relax");
  if (t.includes("natura") || t.includes("parco") || t.includes("riserva")) out.add("natura");
  if (t.includes("mare") || t.includes("spiaggia")) out.add("mare");
  if (t.includes("montagna")) out.add("montagna");
  if (t.includes("citta") || t.includes("city")) out.add("citta");

  // fallback
  if (out.size === 0) out.add("classici");

  return uniq([...out]);
}

// Quick cards (per la tua scheda “cosa fare nei dintorni” – STEP 2)
function computeQuickCards(place) {
  const t = `${norm(place?.name)} ${norm((place?.tags || []).join(" "))} ${norm(place?.type)}`;
  const cards = [];

  // Sempre presenti (la UI poi li usa per link/azioni)
  cards.push({ id: "see", label: "Cosa vedere", kind: "internal" });
  cards.push({ id: "do", label: "Cosa fare", kind: "internal" });
  cards.push({ id: "photos", label: "Foto", kind: "external" });
  cards.push({ id: "food", label: "Ristoranti", kind: "external" });
  cards.push({ id: "tickets", label: "Biglietti", kind: "external" });
  cards.push({ id: "events", label: "Eventi", kind: "external" });

  // Se family alta/medium, evidenziamo "Family" lato dati
  if (hasAny(t, ["family", "famigl", "bambin", "playground", "zoo", "acquario", "parco giochi"])) {
    cards.unshift({ id: "family", label: "Family", kind: "internal" });
  }

  return cards.slice(0, 8);
}

function enrichPlace(p) {
  const name = p?.name || "";
  const tags = Array.isArray(p?.tags) ? p.tags : [];
  const type = p?.type || "";

  const story_score = computeStoryScore(name, tags);
  const borgho = computeBorgo(name, tags, type);

  // family
  const fam = computeFamily(name, tags, type);

  // walkable
  const walkable = computeWalkable(name, tags, type);

  // ideal_for
  const ideal_for = computeIdealFor(fam.family_level, story_score, borgho, type, tags);

  // “consigliato_per” più umano (comodo per UI)
  const consigliato_per = {
    famiglie: fam.family_level !== "low",
    bambini: fam.family_level === "high" || fam.family_level === "medium",
    ragazzi: (fam.age_groups || []).includes("13-17"),
    storia: story_score >= 0.35,
    borghi: borgho
  };

  // non cambiamo type esistente (per non rompere filtri attuali),
  // ma aggiungiamo “primary_category” che la UI potrà usare dopo (STEP 3)
  let primary_category = type;
  if (fam.family_level === "high") primary_category = "family";
  else if (borgho) primary_category = "borghi";
  else if (story_score >= 0.55) primary_category = "storia";

  return {
    ...p,
    // nuovi campi safe
    story_score,
    borgho,
    walkable,
    family_level: fam.family_level,
    age_groups: fam.age_groups,
    family_reasons: fam.family_reasons,
    ideal_for,
    consigliato_per,
    primary_category,
    quick_cards: computeQuickCards(p)
  };
}

function listMacroFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const items = fs.readdirSync(dir);
  return items
    .filter((f) => f.endsWith(".json"))
    .filter((f) => f !== "macros_index.json") // non tocchiamo l’index
    .map((f) => path.join(dir, f));
}

function safeReadJson(file) {
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw);
}

function safeWriteJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj), "utf8");
}

function summarizeCounters(before, after) {
  const out = {
    total_places: after,
    family_high: 0,
    family_med: 0,
    borghi: 0,
    storia_ok: 0
  };
  for (const p of before) {
    if (p.family_level === "high") out.family_high++;
    else if (p.family_level === "medium") out.family_med++;
    if (p.borgo) out.borghi++;
    if ((p.story_score || 0) >= 0.35) out.storia_ok++;
  }
  return out;
}

async function run() {
  console.log("🧩 Enrich macros: FAMILY / BORGHI / STORIA / WALKABLE");
  console.log("DIR:", MACROS_DIR);
  console.log("DRY:", DRY);

  const files = listMacroFiles(MACROS_DIR);
  if (!files.length) {
    console.error("❌ Nessun file macro trovato in:", MACROS_DIR);
    process.exit(1);
  }

  let totalFiles = 0;
  let totalPlaces = 0;

  for (const file of files) {
    let data;
    try {
      data = safeReadJson(file);
    } catch (e) {
      console.log("⚠️ Skip (JSON invalido):", path.basename(file));
      continue;
    }

    if (!data || !Array.isArray(data.places)) {
      // alcune macro "country" potrebbero avere una struttura diversa in futuro
      console.log("⚠️ Skip (no places[]):", path.basename(file));
      continue;
    }

    const originalCount = data.places.length;
    const enrichedPlaces = data.places.map(enrichPlace);

    // aggiungiamo metadata file-level
    const enriched = {
      ...data,
      updated_at: new Date().toISOString().slice(0, 10),
      enrichment: {
        version: "1.0.0",
        family_first: true,
        fields_added: [
          "family_level",
          "age_groups",
          "family_reasons",
          "borgho",
          "story_score",
          "walkable",
          "ideal_for",
          "consigliato_per",
          "primary_category",
          "quick_cards"
        ]
      },
      places: enrichedPlaces
    };

    // mini report
    const counters = summarizeCounters(enrichedPlaces, originalCount);
    console.log(
      `✅ ${path.basename(file)} | places=${originalCount} | family(high=${counters.family_high}, med=${counters.family_med}) | borghi=${counters.borghi} | storia=${counters.storia_ok}`
    );

    if (!DRY) safeWriteJson(file, enriched);

    totalFiles++;
    totalPlaces += originalCount;
  }

  console.log(`\n🎉 Done. files=${totalFiles} total_places=${totalPlaces}`);
  if (DRY) console.log("ℹ️ DRY mode: nessun file è stato scritto.");
}

run().catch((e) => {
  console.error("❌ Failed:", e);
  process.exit(1);
});
