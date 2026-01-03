// scripts/build_pois_eu_uk.mjs
// Genera public/data/pois_eu_uk.json con POI "veri" (mare/montagna/natura/relax/storia/bambini)
// Fonte: Wikidata SPARQL (WDQS)
// Uso: node scripts/build_pois_eu_uk.mjs
//
// NOTE IMPORTANTI:
// - Aggiunte categorie FAMILY: zoo, acquari, waterpark, playground, botanical garden, science museum, theme park
// - Aggiunte categorie STORIA: castelli, musei, siti archeologici
// - NATURA ampliata: parchi nazionali + riserve naturali + aree protette
// - Anti-crash: limiti bassi + retry + fallback a limiti più piccoli
//
// Node 18+ / 20 OK (fetch globale)

import fs from "fs";
import path from "path";

const OUT = path.join(process.cwd(), "public", "data", "pois_eu_uk.json");

// EU + UK (ISO2). UK = GB in Wikidata P297.
const EU_UK = [
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT",
  "NL","PL","PT","RO","SK","SI","ES","SE","GB"
];

// -------------------- CATEGORIES (Wikidata QIDs) --------------------
// QID reference (common):
// - Beach: Q40080
// - Mountain: Q8502
// - National park: Q46169
// - Nature reserve: Q179049
// - Protected area: Q473972
// - Hot spring: Q179734
// - Spa: Q152171 (spa town / spa) (broad, but good for relax)
// - Castle: Q23413
// - Museum: Q33506
// - Archaeological site: Q839954
// - Theme park: Q152060
// - Zoo: Q43501
// - Aquarium: Q2281788
// - Water park: Q185113
// - Playground: Q1360262
// - Botanical garden: Q167346
// - Science museum: Q159995
const CATEGORIES = [
  { type: "mare",     label: "Beaches", qids: ["Q40080"] },

  { type: "montagna", label: "Mountains", qids: ["Q8502"] },

  // NATURA ampliata
  { type: "natura",   label: "National parks",  qids: ["Q46169"] },
  { type: "natura",   label: "Nature reserves", qids: ["Q179049"] },
  { type: "natura",   label: "Protected areas", qids: ["Q473972"] },

  // RELAX ampliata
  { type: "relax",    label: "Hot springs", qids: ["Q179734"] },
  { type: "relax",    label: "Spas",       qids: ["Q152171"] },

  // STORIA (molto utile anche in Italia)
  { type: "storia",   label: "Castles",            qids: ["Q23413"] },
  { type: "storia",   label: "Museums",            qids: ["Q33506"] },
  { type: "storia",   label: "Archaeological sites", qids: ["Q839954"] },

  // FAMILY / BAMBINI (questa è la parte che ti mancava)
  { type: "bambini",  label: "Theme parks",      qids: ["Q152060"] },
  { type: "bambini",  label: "Zoos",            qids: ["Q43501"] },
  { type: "bambini",  label: "Aquariums",       qids: ["Q2281788"] },
  { type: "bambini",  label: "Water parks",     qids: ["Q185113"] },
  { type: "bambini",  label: "Playgrounds",     qids: ["Q1360262"] },
  { type: "bambini",  label: "Botanical gardens", qids: ["Q167346"] },
  { type: "bambini",  label: "Science museums", qids: ["Q159995"] },
];

// -------------------- WDQS tuning --------------------
const WDQS_ENDPOINT = "https://query.wikidata.org/sparql";

// Limiti: più categorie = più richieste -> meglio LIMIT un po’ più basso
const LIMIT_DEFAULT = 450;
const LIMIT_FALLBACKS = [300, 220, 150, 90];

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function makeId(wd, type) {
  const w = String(wd || "").replace(/^.*\/(Q\d+)$/, "$1");
  return `wd_${type}_${w}`;
}

function toBeautyScore(sitelinks) {
  // proxy “quanto è noto / interessante”: più sitelinks => più alto
  const x = Number(sitelinks || 0);
  const v = 0.35 + Math.log10(1 + x) * 0.28; // ~0.35..1
  return clamp(v, 0.35, 1.0);
}

async function sleep(ms){ return new Promise(res => setTimeout(res, ms)); }

async function fetchTextWithRetry(url, opts = {}, tries = 6) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts);
      const text = await r.text();

      // WDQS può rispondere 429/503
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
      return text;
    } catch (e) {
      lastErr = e;
      const wait = 1100 * Math.pow(2, i);
      console.log(`    retry in ${wait}ms… (${i + 1}/${tries})`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

function sparqlQueryFor(countryIso2, cat, limit) {
  const valuesQ = cat.qids.map(q => `wd:${q}`).join(" ");

  // Query:
  // - istanza (P31) o sottoclasse (P279*)
  // - coordinate (P625)
  // - country code via P297
  // - sitelinks per ranking
  return `
SELECT ?item ?itemLabel ?coord ?countryCode ?sitelinks WHERE {
  VALUES ?cc { "${countryIso2}" }
  VALUES ?t { ${valuesQ} }

  ?item wdt:P31/wdt:P279* ?t .
  ?item wdt:P625 ?coord .
  ?item wdt:P17 ?country .
  ?country wdt:P297 ?countryCode .
  FILTER(?countryCode = ?cc)

  OPTIONAL { ?item wikibase:sitelinks ?sitelinks. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "it,en". }
}
ORDER BY DESC(COALESCE(?sitelinks, 0))
LIMIT ${Number(limit) || LIMIT_DEFAULT}
`;
}

function parseWKTPoint(wkt) {
  // Format tipico: "Point(13.123 42.456)"
  const m = String(wkt || "").match(/Point\(([-0-9.]+)\s+([-0-9.]+)\)/i);
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

async function fetchWdqsJson(countryIso2, cat) {
  const limitsToTry = [LIMIT_DEFAULT, ...LIMIT_FALLBACKS];

  for (const lim of limitsToTry) {
    const q = sparqlQueryFor(countryIso2, cat, lim);
    const url = `${WDQS_ENDPOINT}?format=json&query=${encodeURIComponent(q)}`;

    const text = await fetchTextWithRetry(url, {
      headers: {
        "accept": "application/sparql-results+json",
        "user-agent": "JamoPOIBuilder/1.2 (github-actions; contact: none)"
      }
    });

    try {
      return JSON.parse(text);
    } catch (e) {
      console.log(`    ${countryIso2}: JSON.parse failed with LIMIT=${lim}. retrying smaller…`);
      await sleep(700);
    }
  }
  return null;
}

function baseTagsForType(type) {
  // Tags “standard” che poi il macro builder può usare
  if (type === "mare") return ["mare", "spiagge", "relax"];
  if (type === "montagna") return ["montagna", "panorama", "trekking"];
  if (type === "natura") return ["natura", "outdoor", "trekking"];
  if (type === "relax") return ["relax", "terme", "spa"];
  if (type === "storia") return ["storia", "musei", "cultura"];
  if (type === "bambini") return ["famiglie", "bambini", "family"];
  return [];
}

async function run() {
  console.log("Building POIs EU+UK via Wikidata…");

  const all = [];
  const seen = new Set();

  // raggruppiamo log per tipo (così capisci subito se FAMILY cresce)
  const countersByType = new Map();

  for (const cat of CATEGORIES) {
    console.log(`\nCategory: ${cat.type} (${cat.label})`);

    for (const iso2 of EU_UK) {
      const json = await fetchWdqsJson(iso2, cat);

      if (!json) {
        process.stdout.write(`  ${iso2}: 0 (failed)\n`);
        await sleep(180);
        continue;
      }

      const rows = Array.isArray(json?.results?.bindings) ? json.results.bindings : [];
      if (!rows.length) {
        process.stdout.write(`  ${iso2}: 0\n`);
        await sleep(160);
        continue;
      }

      let countAdded = 0;

      for (const r of rows) {
        const item = r?.item?.value;
        const label = r?.itemLabel?.value;
        const coord = r?.coord?.value;
        const cc = r?.countryCode?.value || iso2;
        const sitelinks = Number(r?.sitelinks?.value || 0);

        if (!item || !label || !coord) continue;

        const p = parseWKTPoint(coord);
        if (!p) continue;

        const id = makeId(item, cat.type);
        if (seen.has(id)) continue;

        seen.add(id);

        const country = (cc === "GB") ? "UK" : cc;

        const tags = baseTagsForType(cat.type);

        all.push({
          id,
          name: label,
          country,
          lat: p.lat,
          lng: p.lon,
          types: [cat.type],              // IMPORTANT: array (compat con i tuoi script)
          visibility: sitelinks >= 35 ? "conosciuta" : "chicca",
          beauty_score: toBeautyScore(sitelinks),
          source: "wikidata",
          wd: item.replace(/^.*\/(Q\d+)$/, "$1"),
          tags
        });

        countAdded++;
        countersByType.set(cat.type, (countersByType.get(cat.type) || 0) + 1);
      }

      process.stdout.write(`  ${iso2}: +${countAdded}\n`);

      // pausa gentile per WDQS
      await sleep(220);
    }
  }

  // Dedup robusto:
  // stesso nome + paese + type -> tieni beauty_score maggiore
  const dedup = new Map();
  for (const p of all) {
    const k = `${norm(p.name)}|${p.country}|${p.types?.[0] || ""}`;
    const prev = dedup.get(k);
    if (!prev || (Number(p.beauty_score) > Number(prev.beauty_score))) dedup.set(k, p);
  }

  const pois = [...dedup.values()];
  pois.sort((a,b)=> (Number(b.beauty_score)||0) - (Number(a.beauty_score)||0));

  const out = {
    version: "1.2",
    updated: new Date().toISOString().slice(0, 10),
    regions: ["EU", "UK"],
    pois
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out), "utf8");

  console.log("\nSaved:", OUT);
  console.log("POIs:", pois.length);

  const typesToPrint = ["mare","montagna","natura","relax","storia","bambini"];
  for (const t of typesToPrint) {
    const n = pois.filter(x => x.types?.includes(t)).length;
    console.log(`Type ${t}:`, n);
  }
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
