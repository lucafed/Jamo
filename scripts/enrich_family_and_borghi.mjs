// scripts/enrich_family_and_borghi.mjs
// Enrichment "CATEGORIES FIRST" per tutte le macro in public/data/macros
// - Non rompe nulla: aggiunge solo campi nuovi ai places
// - Aggiunge: family_level, ideal_for, age_groups, borgho, storia_score, walkable,
//             family_reasons, quick_cards, category_scores, categories, primary_category
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
//
// Obiettivo: ridurre il rumore.
// - familyHigh SOLO cose esplicitamente kids/family oriented
// - familyMed cose "spesso ok con bimbi" ma non garantite
const KW = {
  familyHigh: [
    "parco giochi",
    "playground",
    "luna park",
    "lunapark",
    "giostre",
    "amusement park",
    "theme park",
    "parco divertimenti",
    "waterpark",
    "water park",
    "acquapark",
    "aqua park",
    "parco acquatico",
    "zoo",
    "aquario",
    "acquario",
    "aquarium",
    "fattoria didattica",
    "farm",
    "petting zoo",
    "kids area",
    "area bimbi",
    "museo dei bambini",
    "children museum",
    "science center",
    "centro scientifico",
    "planetario",
    "planetarium"
  ],
  familyMed: [
    "parco",
    "park",
    "giardino",
    "garden",
    "sentiero facile",
    "easy trail",
    "passeggiata",
    "walk",
    "promenade",
    "centro storico",
    "old town",
    "castello",
    "castle",
    "forte",
    "fortress",
    "spiaggia",
    "beach",
    "lido",
    "lago",
    "lake",
    "funivia",
    "cable car",
    "cablecar",
    "belvedere",
    "viewpoint"
  ],
  story: [
    "museo",
    "museum",
    "castello",
    "castle",
    "forte",
    "fortress",
    "rovine",
    "ruins",
    "anfiteatro",
    "amphitheatre",
    "amphitheater",
    "teatro romano",
    "roman theater",
    "roman theatre",
    "basilica",
    "cattedrale",
    "cathedral",
    "chiesa",
    "church",
    "monastero",
    "monastery",
    "abbazia",
    "abbey",
    "necropolis",
    "necropoli",
    "archeologico",
    "archaeological",
    "archeology",
    "archaeology",
    "centro storico",
    "old town"
  ],
  borgo: [
    "borgo",
    "borghi",
    "hamlet",
    "village",
    "villaggio",
    "centro storico",
    "old town",
    "castello",
    "castle",
    "rocca",
    "forte",
    "fortress",
    "paese",
    "paesino"
  ],
  notWalkable: ["trek", "trekking", "hike", "hiking", "vetta", "summit", "rifugio", "hut", "via ferrata", "ferrata", "gola", "canyon"]
};

// DEFINIZIONI CATEGORIE (scoring semplice ma robusto)
// Nota: è pensato per essere usato da API/UI per filtrare correttamente per categoria,
// evitando di dipendere dal solo "type".
const CATEGORY_DEFS = {
  family: {
    must: KW.familyHigh,
    should: ["famigl", "family", "bambin", "kids", "children", ...KW.familyMed],
    avoid: ["nightclub", "discoteca", "strip", "adult", "betting", "scommesse", "casino", "slot"]
  },
  theme_park: {
    must: ["amusement park", "theme park", "parco divertimenti", "lunapark", "luna park", "giostre", "waterpark", "water park", "acquapark", "aqua park", "zoo", "aquarium", "acquario", "aquario"],
    should: ["parco avventura", "adventure park", "zipline", "zip line", "kids", "children", "family"],
    avoid: []
  },
  kids_museum: {
    must: ["museo dei bambini", "children museum", "science center", "planetario", "planetarium", "museo interattivo", "interactive museum"],
    should: ["museo", "museum"],
    avoid: []
  },
  history: {
    must: KW.story,
    should: ["centro storico", "old town", "borgo", "borghi"],
    avoid: ["nightclub", "discoteca"]
  },
  borghi: {
    must: KW.borgo,
    should: ["castello", "rocca", "centro storico", "old town"],
    avoid: []
  },
  nature: {
    must: ["parco", "park", "riserva", "reserve", "giardino", "garden", "lago", "lake", "spiaggia", "beach", "mare", "sea"],
    should: ["belvedere", "viewpoint", "passeggiata", "promenade", "sentiero facile", "easy trail"],
    avoid: ["nightclub", "discoteca"]
  },
  hiking: {
    must: ["trek", "trekking", "hike", "hiking", "vetta", "summit", "rifugio", "hut", "via ferrata", "ferrata", "canyon", "gola"],
    should: ["sentiero", "trail"],
    avoid: []
  },
  spa: {
    must: ["terme", "spa", "hot spring", "hot springs"],
    should: ["relax"],
    avoid: []
  },
  sea: {
    must: ["mare", "sea", "spiaggia", "beach", "lido"],
    should: ["lungomare", "promenade"],
    avoid: []
  },
  viewpoints: {
    must: ["belvedere", "viewpoint", "panorama", "scenic"],
    should: ["centro storico", "borgo", "old town"],
    avoid: []
  }
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
  const med = scoreFromKeywords(name, tags, KW.familyMed, 0.55);

  // Boost solo se esplicito
  let boost = 0;
  if (t.includes("family") || t.includes("famigl")) boost += 0.9;
  if (t.includes("bambin") || t.includes("kids") || t.includes("children")) boost += 0.9;

  const raw = hi + med + boost;

  let level = "low";
  if (raw >= 2.4) level = "high";
  else if (raw >= 1.1) level = "medium";

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

  // Motivi rapidi (UI)
  const reasons = [];
  if (hasAny(t, ["parco giochi", "playground", "giostre", "lunapark", "luna park", "amusement park", "theme park"])) reasons.push("Giochi e divertimento per bambini");
  if (hasAny(t, ["zoo", "acquario", "aquarium", "fattoria", "farm", "petting zoo"])) reasons.push("Animali e attività per famiglie");
  if (hasAny(t, ["waterpark", "acquapark", "aqua park", "piscina", "pool"])) reasons.push("Acqua e attività estive");
  if (hasAny(t, ["museo dei bambini", "children museum", "science center", "planetario"])) reasons.push("Esperienze educative per bambini");
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

// category scoring + categorie principali
function computeCategoryScores(place) {
  const t = `${norm(place?.name)} ${norm((place?.tags || []).join(" "))} ${norm(place?.type)}`;
  const scores = {};

  for (const [cat, def] of Object.entries(CATEGORY_DEFS)) {
    const must = def.must || [];
    const should = def.should || [];
    const avoid = def.avoid || [];

    let s = 0;
    for (const k of must) if (t.includes(norm(k))) s += 3;
    for (const k of should) if (t.includes(norm(k))) s += 1;
    for (const k of avoid) if (t.includes(norm(k))) s -= 4;

    scores[cat] = Math.max(0, Number(s.toFixed(2)));
  }

  // Soglia: 3 = almeno un "must" oppure abbastanza "should"
  const categories = Object.entries(scores)
    .filter(([, v]) => v >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);

  return { scores, categories };
}

// “ideal_for” -> array di profili (rimane, ma ora è più coerente)
function computeIdealFor(familyLevel, storyScore, isBorgo, type, tags, categories) {
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

  // categorie extra come segnali
  if (Array.isArray(categories)) {
    if (categories.includes("nature")) out.add("natura");
    if (categories.includes("spa")) out.add("relax");
    if (categories.includes("sea")) out.add("mare");
    if (categories.includes("hiking")) out.add("montagna");
  }

  // relax / natura (vecchia logica, ma più prudente)
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

// Quick cards (per la tua scheda “cosa fare nei dintorni”)
function computeQuickCards(place) {
  const t = `${norm(place?.name)} ${norm((place?.tags || []).join(" "))} ${norm(place?.type)}`;
  const cards = [];

  // Sempre presenti
  cards.push({ id: "see", label: "Cosa vedere", kind: "internal" });
  cards.push({ id: "do", label: "Cosa fare", kind: "internal" });
  cards.push({ id: "photos", label: "Foto", kind: "external" });
  cards.push({ id: "food", label: "Ristoranti", kind: "external" });
  cards.push({ id: "tickets", label: "Biglietti", kind: "external" });
  cards.push({ id: "events", label: "Eventi", kind: "external" });

  // Se family esplicita
  if (hasAny(t, ["family", "famigl", "bambin", "kids", "children", ...KW.familyHigh])) {
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

  // categorie (NUOVO)
  const { scores: category_scores, categories } = computeCategoryScores({ name, tags, type });

  // ideal_for (agganciato alle categorie)
  const ideal_for = computeIdealFor(fam.family_level, story_score, borgho, type, tags, categories);

  // “consigliato_per” più umano (comodo per UI)
  const consigliato_per = {
    famiglie: fam.family_level !== "low",
    bambini: fam.family_level === "high" || fam.family_level === "medium",
    ragazzi: (fam.age_groups || []).includes("13-17"),
    storia: story_score >= 0.35,
    borghi: borgho
  };

  // categoria primaria: prima categoria calcolata, fallback su vecchio type
  const primary_category = (categories && categories[0]) || type || "classici";

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
    // categorie (NUOVO)
    category_scores,
    categories,
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
  // Scrittura "pretty" per debug/merge più leggibile
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}

function summarizeCounters(enrichedPlaces) {
  const out = {
    total_places: enrichedPlaces.length,
    family_high: 0,
    family_med: 0,
    borghi: 0,
    storia_ok: 0,
    with_categories: 0
  };
  for (const p of enrichedPlaces) {
    if (p.family_level === "high") out.family_high++;
    else if (p.family_level === "medium") out.family_med++;
    if (p.borgho) out.borghi++;
    if ((p.story_score || 0) >= 0.35) out.storia_ok++;
    if (Array.isArray(p.categories) && p.categories.length) out.with_categories++;
  }
  return out;
}

async function run() {
  console.log("🧩 Enrich macros: CATEGORIES / FAMILY / BORGHI / STORIA / WALKABLE");
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
      console.log("⚠️ Skip (no places[]):", path.basename(file));
      continue;
    }

    const originalCount = data.places.length;
    const enrichedPlaces = data.places.map(enrichPlace);

    // metadata file-level
    const enriched = {
      ...data,
      updated_at: new Date().toISOString().slice(0, 10),
      enrichment: {
        version: "1.1.0",
        categories_first: true,
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
          "category_scores",
          "categories",
          "primary_category",
          "quick_cards"
        ]
      },
      places: enrichedPlaces
    };

    // mini report
    const counters = summarizeCounters(enrichedPlaces);
    console.log(
      `✅ ${path.basename(file)} | places=${originalCount} | family(high=${counters.family_high}, med=${counters.family_med}) | borghi=${counters.borghi} | storia=${counters.storia_ok} | categorized=${counters.with_categories}`
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
