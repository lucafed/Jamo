#!/usr/bin/env node
/**
 * Jamo — build_events_all.mjs (v3.0 MAI-FATTO OFFLINE)
 * - NO API keys
 * - Usa SOLO dataset offline POI già presenti in repo
 * - Output: public/data/events/events_all.json
 *
 * Idea:
 *  - Genera "Mai fatto" (suggestioni) ancorate a POI reali (lat/lon)
 *  - Aggiunge: come_fare / perche / durata / url (website se presente)
 *  - Mantiene start date per filtri "oggi / weekend / 7 / 30 giorni"
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();

const IT_REGIONS_INDEX = path.join(ROOT, "public", "data", "pois", "regions", "it-regions-index.json");
const OUT_PATH = path.join(ROOT, "public", "data", "events", "events_all.json");

// tuning
const DAYS_AHEAD = 90;
const MAX_EVENTS = 50000;

// quante idee per regione (poi scala: aumenti questi numeri)
const PER_REGION_CORE_PICK = 220;     // pool massimo per regione (dal dataset core)
const PER_REGION_PER_CAT = 40;        // quante idee per categoria per regione (prima del dedupe)

// categorie "Mai fatto" (UI)
const CATS = [
  "relax",
  "family",
  "natura",
  "borghi",
  "storia",
  "cantine",
  "hiking",
  "mare",
  "montagna",
  "pioggia",
  "bici",
  "moto",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJSON(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function safeText(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function normName(s) {
  return safeText(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 10);
}

function nowISO() { return new Date().toISOString(); }

function addDaysUTC(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function startSlotDate(base, idx) {
  // distribuisci su giorni + orari (9, 11, 18, 21)
  const dayOffset = (idx * 2) % DAYS_AHEAD;
  const d = addDaysUTC(base, dayOffset);
  const hours = [9, 11, 18, 21];
  d.setUTCHours(hours[idx % hours.length], 0, 0, 0);
  return d;
}

function getWebsiteFromTags(place) {
  const tags = Array.isArray(place?.tags) ? place.tags : [];
  for (const t of tags) {
    const s = String(t);
    if (s.startsWith("website=")) return s.slice("website=".length).trim();
    if (s.startsWith("contact:website=")) return s.slice("contact:website=".length).trim();
  }
  return "";
}

function googleSearchUrl(q) {
  return `https://www.google.com/search?q=${encodeURIComponent(String(q || "").trim())}`;
}

function pickTitle(cat, placeName, regionName) {
  const n = safeText(placeName);
  const r = safeText(regionName);

  const t = {
    relax:     `Relax vero vicino a te: ${n}`,
    family:    `Bambini in modalità WOW: ${n}`,
    natura:    `Respira: vai a ${n}`,
    borghi:    `Mai visto così: ${n}`,
    storia:    `Storia che non ti aspetti: ${n}`,
    cantine:   `Degustazione easy: ${n}`,
    hiking:    `Trekking corto ma bellissimo: ${n}`,
    mare:      `Aria di mare (anche senza sbatti): ${n}`,
    montagna:  `Montagna “senza fatica”: ${n}`,
    pioggia:   `Piove? Fai questo: ${n}`,
    bici:      `Bici: pedalata bella e semplice da ${n}`,
    moto:      `Moto: curve + vista partendo da ${n}`,
  };

  return t[cat] || `${n} • ${r}`;
}

function buildHow(cat, placeName) {
  const n = safeText(placeName);

  // Niente “divieti”, solo consigli pratici (come mi hai chiesto)
  const how = {
    relax: [
      `Arriva a ${n} e fai 10 minuti “lenti” (senza fretta).`,
      "Scegli un punto panoramico o tranquillo e fermati davvero.",
      "Chiudi con una cosa semplice: un caffè/una passeggiata breve."
    ],
    family: [
      `Arriva a ${n} e fai scegliere ai bambini “la prima cosa da fare”.`,
      "Fai una mini-missione: foto, caccia ai dettagli, micro-esplorazione.",
      "Chiudi con uno snack in zona o una sosta breve in un parco vicino."
    ],
    natura: [
      `Vai a ${n} e fai un giro ad anello (anche corto).`,
      "Fermati nel punto più “aperto” e guarda 2 minuti senza telefono.",
      "Se ti va: foto unica (una sola) e poi riparti."
    ],
    borghi: [
      `Arriva a ${n}, parcheggia e vai diretto verso il centro/parte alta.`,
      "Fai un giro di vicoli senza mappa per 15 minuti.",
      "Trova un punto vista e segnati un posto dove tornare."
    ],
    storia: [
      `Vai a ${buildShort(n)} e cerca “il punto più antico” (muro, torre, lapide).`,
      "Fai 3 foto: un dettaglio, una vista larga, una cosa strana.",
      "Chiudi con una sosta breve in un bar vicino."
    ],
    cantine: [
      `Arriva a ${n} e chiedi una degustazione “easy” (anche solo 2 calici).`,
      "Se c’è shop: prendi una bottiglia “da raccontare” (non la solita).",
      "Fai una foto etichetta + posto per ricordarti."
    ],
    hiking: [
      `Vai a ${n} e imposta un giro corto: 45–90 min.`,
      "Sali fino al primo punto panoramico e fermati 5 minuti.",
      "Rientra con calma, senza accelerare la fine."
    ],
    mare: [
      `Vai a ${n} e fai 20 minuti sul lungomare/sentiero vista acqua.`,
      "Trova un punto “riparato” e stai lì 10 minuti.",
      "Chiudi con una sosta semplice (gelato/caffè) vicino."
    ],
    montagna: [
      `Vai a ${n} e scegli un punto “alto ma facile”.`,
      "Fai una passeggiata breve, poi fermati dove si vede lontano.",
      "Chiudi con una sosta in rifugio/bar di montagna in zona."
    ],
    pioggia: [
      `Vai a ${n} e scegli un punto al coperto ma con vista (portico/vetrata).`,
      "Fai una cosa calda (caffè/cioccolata) e guarda la pioggia 5 minuti.",
      "Poi mini-giro: 10 minuti a piedi, giusto per cambiare testa."
    ],
    bici: [
      `Parti da ${n} e fai un’andata 30–45 min a ritmo facile.`,
      "Fermati 2 volte: una per vista, una per foto “da ricordare”.",
      "Rientra tranquillo e chiudi con una sosta breve."
    ],
    moto: [
      `Parti da ${n} e fai un giro “curve + vista” senza fretta.`,
      "Fermati in un punto panoramico (anche solo 10 minuti).",
      "Rientra da una strada diversa se possibile."
    ],
  };

  return how[cat] || [`Vai a ${n}.`, "Fai una cosa semplice lì.", "Torna con calma."];
}

function buildShort(s) { return safeText(s); }

function buildWhy(cat) {
  const why = {
    relax: "Ti rimette in pace senza dover “organizzare” nulla.",
    family: "Non è la solita cosa: qui i bimbi si accendono da soli.",
    natura: "È il reset che ti mancava, anche se hai poca voglia.",
    borghi: "È quel posto che poi dici: “com’è possibile non esserci mai stato?”",
    storia: "Ti fa sentire dentro a qualcosa di più grande, in poco tempo.",
    cantine: "È un’esperienza semplice ma raccontabile il giorno dopo.",
    hiking: "È ‘wow’ senza essere una faticata.",
    mare: "Anche solo l’aria cambia la giornata.",
    montagna: "Ti dà vista e respiro, senza sbatti.",
    pioggia: "Trasforma la pioggia da ‘rovina tutto’ a ‘atmosfera’.",
    bici: "È una micro-avventura che sembra più lunga di quanto sia.",
    moto: "Curve, aria, panorama: la giornata cambia davvero."
  };
  return why[cat] || "È un’idea semplice, ma ti sblocca.";
}

function durationFor(cat) {
  // durata esperienza (non viaggio)
  const d = {
    relax: 90,
    family: 120,
    natura: 90,
    borghi: 120,
    storia: 90,
    cantine: 120,
    hiking: 120,
    mare: 150,
    montagna: 150,
    pioggia: 75,
    bici: 120,
    moto: 150,
  };
  return d[cat] || 90;
}

function scorePlace(place) {
  // qualità: website/wikidata/wikipedia ecc. (proxy rapido)
  const tags = Array.isArray(place?.tags) ? place.tags.join(" ") : "";
  let s = 0;
  if (tags.includes("website=") || tags.includes("contact:website=")) s += 2;
  if (tags.includes("wikidata=") || tags.includes("wikipedia=")) s += 2;
  if (tags.includes("opening_hours=")) s += 1;
  if ((place?.name || "").length >= 4) s += 1;
  return s;
}

function catMatch(cat, place) {
  // mapping veloce basato su type + tags
  const type = String(place?.type || place?.primary_category || place?.category || "").toLowerCase();
  const tags = Array.isArray(place?.tags) ? place.tags.join(" ").toLowerCase() : "";
  const name = normName(place?.name || "");

  if (cat === "relax") {
    return tags.includes("amenity=spa") || tags.includes("tourism=spa") || tags.includes("natural=hot_spring") ||
      name.includes("terme") || name.includes("spa") || name.includes("wellness") || name.includes("sauna");
  }

  if (cat === "borghi") {
    return tags.includes("place=village") || tags.includes("place=hamlet") || tags.includes("place=town") ||
      name.includes("borgo") || name.includes("centro storico");
  }

  if (cat === "storia") {
    return tags.includes("historic=") || tags.includes("heritage=") ||
      tags.includes("tourism=museum") || tags.includes("historic=castle") || name.includes("castel") || name.includes("rocca");
  }

  if (cat === "cantine") {
    return tags.includes("craft=winery") || tags.includes("shop=wine") || name.includes("cantina") || name.includes("winery") || name.includes("enoteca");
  }

  if (cat === "hiking") {
    return tags.includes("route=hiking") || tags.includes("highway=path") || tags.includes("tourism=alpine_hut") ||
      name.includes("sentier") || name.includes("trail") || name.includes("cai");
  }

  if (cat === "mare") {
    return tags.includes("natural=beach") || tags.includes("leisure=marina") || name.includes("spiaggia") || name.includes("lido");
  }

  if (cat === "montagna") {
    return tags.includes("natural=peak") || tags.includes("mountain_pass=") || tags.includes("aerialway=") ||
      name.includes("monte") || name.includes("cima") || name.includes("rifugio") || name.includes("malga");
  }

  if (cat === "family") {
    return tags.includes("tourism=theme_park") || tags.includes("leisure=water_park") || tags.includes("tourism=zoo") ||
      name.includes("parco") || name.includes("acquario") || name.includes("zoo");
  }

  if (cat === "natura") {
    return tags.includes("natural=") || tags.includes("water=lake") || tags.includes("boundary=national_park") ||
      name.includes("cascat") || name.includes("lago") || name.includes("gola");
  }

  // categorie “esperienza” (non POI puro) → le ancoriamo a POI “belli”
  if (cat === "pioggia") return scorePlace(place) >= 2;
  if (cat === "bici") return scorePlace(place) >= 2;
  if (cat === "moto") return scorePlace(place) >= 2;

  // fallback generico
  return type.length > 0 || scorePlace(place) > 0;
}

function normalizePlace(p) {
  const lat = Number(p?.lat);
  const lon = Number(p?.lon ?? p?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    id: String(p?.id || ""),
    name: safeText(p?.name || ""),
    lat,
    lon,
    type: safeText(p?.type || p?.primary_category || p?.category || ""),
    tags: Array.isArray(p?.tags) ? p.tags.map((x) => String(x)) : [],
    area: safeText(p?.area || ""),
    country: safeText(p?.country || "").toUpperCase(),
  };
}

function buildSuggestion({ region, place, cat, idx, baseDate }) {
  const regionName = safeText(region?.name || "");
  const placeName = safeText(place?.name || "");

  const start = startSlotDate(baseDate, idx);
  const end = new Date(start);
  end.setUTCHours(end.getUTCHours() + 2);

  const q = `${placeName} ${regionName}`.trim();
  const website = getWebsiteFromTags(place);
  const url = website || googleSearchUrl(q);

  const how = buildHow(cat, placeName);
  const why = buildWhy(cat);

  const idBase = `${cat}|${placeName}|${place.lat}|${place.lon}|${regionName}|${start.toISOString()}`;
  const id = `mf_${sha1(idBase)}`;

  return {
    id,
    title: pickTitle(cat, placeName, regionName),
    start: start.toISOString(),
    end: end.toISOString(),
    lat: place.lat,
    lon: place.lon,
    place: placeName,
    city: place.area || "",
    region: regionName,
    country_code: "IT",
    category: cat,
    source: "mai_fatto_offline_poi",
    url,

    // campi extra (events.js li ignora finché non lo aggiorniamo)
    kind: "mai_fatto",
    why,
    how,
    duration_min: durationFor(cat),
  };
}

function dedupeById(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r?.id) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

async function main() {
  if (!fs.existsSync(IT_REGIONS_INDEX)) {
    throw new Error(`Missing: ${IT_REGIONS_INDEX}`);
  }

  const idx = readJSON(IT_REGIONS_INDEX);
  const items = Array.isArray(idx?.items) ? idx.items : [];
  if (!items.length) throw new Error("it-regions-index.json has no items");

  const baseDate = new Date();
  const all = [];

  const stats = {
    regions: items.length,
    regions_ok: 0,
    region_fail: 0,
    per_cat: {},
    kept: 0,
  };

  for (const cat of CATS) stats.per_cat[cat] = 0;

  for (const region of items) {
    try {
      const corePath = region?.paths?.core || `/data/pois/regions/${region.id}.json`;
      const coreAbs = path.join(ROOT, "public", corePath.replace(/^\//, ""));

      if (!fs.existsSync(coreAbs)) {
        stats.region_fail++;
        continue;
      }

      const j = readJSON(coreAbs);
      const rawPlaces = Array.isArray(j?.places) ? j.places : [];
      if (!rawPlaces.length) {
        stats.region_fail++;
        continue;
      }

      // normalizza + punteggia e prendi un pool “buono”
      const pool = rawPlaces
        .map(normalizePlace)
        .filter(Boolean)
        .map((p) => ({ p, s: scorePlace(p) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, PER_REGION_CORE_PICK)
        .map((x) => x.p);

      if (!pool.length) {
        stats.region_fail++;
        continue;
      }

      // per categoria pesca POI coerenti
      let localIdx = 0;
      for (const cat of CATS) {
        const candidates = pool.filter((p) => catMatch(cat, p));

        // se pochi, allarga un po’ (più inclusivo)
        const picked = (candidates.length ? candidates : pool).slice(0, PER_REGION_PER_CAT);

        for (const place of picked) {
          all.push(buildSuggestion({ region, place, cat, idx: localIdx++, baseDate }));
          stats.per_cat[cat]++;
        }
      }

      stats.regions_ok++;
      // micro sleep per non stressare runner (IO)
      await sleep(5);
    } catch {
      stats.region_fail++;
      continue;
    }
  }

  // dedupe + clamp
  let rows = dedupeById(all);

  // solo nel range [now .. now+DAYS_AHEAD]
  const nowT = Date.now();
  const maxT = nowT + DAYS_AHEAD * 24 * 3600 * 1000;

  rows = rows.filter((e) => {
    const t = new Date(e.start).getTime();
    return Number.isFinite(t) && t >= nowT && t <= maxT;
  });

  // ordina per data
  rows.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  rows = rows.slice(0, MAX_EVENTS);

  stats.kept = rows.length;

  const out = {
    updated_at: nowISO(),
    count: rows.length,
    days_ahead: DAYS_AHEAD,
    events: rows,
    stats,
  };

  writeJSON(OUT_PATH, out);

  console.log("✅ Wrote:", OUT_PATH);
  console.log("Stats:", out.stats);
}

main().catch((e) => {
  console.error("❌ build_events_all failed:", e?.message || e);
  process.exit(1);
});
