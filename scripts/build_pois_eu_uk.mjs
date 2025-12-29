// scripts/build_pois_eu_uk.mjs
// Genera public/data/pois_eu_uk.json con POI "veri" (mare/montagna/natura/relax/bambini)
// Fonte: Wikidata SPARQL (WDQS)
// Uso: node scripts/build_pois_eu_uk.mjs

import fs from "fs";
import path from "path";

const OUT = path.join(process.cwd(), "public", "data", "pois_eu_uk.json");

// EU + UK (ISO2). UK = GB in Wikidata P297.
const EU_UK = [
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT",
  "NL","PL","PT","RO","SK","SI","ES","SE","GB"
];

// Categorie -> Wikidata QID principali
const CATEGORIES = [
  { type: "mare",      label: "Beaches",         qids: ["Q40080"] },  // beach
  { type: "montagna",  label: "Mountains",       qids: ["Q8502"] },   // mountain
  { type: "natura",    label: "National parks",  qids: ["Q46169"] },  // national park
  { type: "relax",     label: "Hot springs",     qids: ["Q179734"] }, // hot spring
  { type: "bambini",   label: "Theme parks",     qids: ["Q152060"] }  // amusement/theme park
];

// --- tuning anti-crash ---
const WDQS_ENDPOINT = "https://query.wikidata.org/sparql";

// LIMIT basso = risposte non troncate. Prendiamo qualità via ORDER BY.
const LIMIT_DEFAULT = 900;
// se JSON.parse fallisce, riproviamo con limiti più bassi
const LIMIT_FALLBACKS = [600, 400, 250, 150];

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

async function fetchTextWithRetry(url, opts = {}, tries = 5) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts);
      const text = await r.text();

      // WDQS a volte risponde 429/503: qui vogliamo retry
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 220)}`);

      return text;
    } catch (e) {
      lastErr = e;
      const wait = 1200 * Math.pow(2, i);
      console.log(`  retry in ${wait}ms… (${i + 1}/${tries})`);
      await new Promise(res => setTimeout(res, wait));
    }
  }
  throw lastErr;
}

function sparqlQueryFor(countryIso2, cat, limit) {
  const valuesQ = cat.qids.map(q => `wd:${q}`).join(" ");

  // NOTA:
  // - OPTIONAL sitelinks
  // - ORDER BY desc(sitelinks) per prendere “cose belle/nota” prima
  // - LIMIT basso per evitare risposte troncate
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
        "user-agent": "JamoPOIBuilder/1.1 (github-actions; contact: none)"
      }
    });

    try {
      return JSON.parse(text);
    } catch (e) {
      // tipico caso: risposta troncata o html “strano”
      console.log(`  ${countryIso2}: JSON.parse failed with LIMIT=${lim}. retrying with smaller LIMIT…`);
      // una pausa prima di riprovare
      await new Promise(res => setTimeout(res, 800));
    }
  }

  // se siamo qui, niente da fare
  return null;
}

async function run() {
  console.log("Building POIs EU+UK via Wikidata…");

  const all = [];
  const seen = new Set();

  for (const cat of CATEGORIES) {
    console.log(`\nCategory: ${cat.type} (${cat.label})`);

    for (const iso2 of EU_UK) {
      const json = await fetchWdqsJson(iso2, cat);

      if (!json) {
        process.stdout.write(`  ${iso2}: 0 (failed)\n`);
        continue;
      }

      const rows = Array.isArray(json?.results?.bindings) ? json.results.bindings : [];
      if (!rows.length) {
        process.stdout.write(`  ${iso2}: 0\n`);
        // pausa piccola
        await new Promise(res => setTimeout(res, 150));
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

        all.push({
          id,
          name: label,
          country: cc === "GB" ? "UK" : cc,
          lat: p.lat,
          lng: p.lon,
          types: [cat.type],
          visibility: sitelinks >= 35 ? "conosciuta" : "chicca",
          beauty_score: toBeautyScore(sitelinks),
          source: "wikidata",
          wd: item.replace(/^.*\/(Q\d+)$/, "$1"),
          tags: []
        });

        countAdded++;
      }

      process.stdout.write(`  ${iso2}: +${countAdded}\n`);

      // pausa “gentile” con WDQS
      await new Promise(res => setTimeout(res, 220));
    }
  }

  // Dedup: stesso nome + paese + tipo -> tieni beauty_score maggiore
  const dedup = new Map();
  for (const p of all) {
    const k = `${norm(p.name)}|${p.country}|${p.types[0]}`;
    const prev = dedup.get(k);
    if (!prev || (p.beauty_score > prev.beauty_score)) dedup.set(k, p);
  }

  const pois = [...dedup.values()];
  pois.sort((a,b)=> (b.beauty_score||0) - (a.beauty_score||0));

  const out = {
    version: "1.1",
    updated: new Date().toISOString().slice(0,10),
    regions: ["EU","UK"],
    pois
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out), "utf8");

  console.log("\nSaved:", OUT);
  console.log("POIs:", pois.length);

  for (const t of ["mare","montagna","natura","relax","bambini"]) {
    const n = pois.filter(x => x.types?.includes(t)).length;
    console.log(`Type ${t}:`, n);
  }
}

run().catch(e=>{
  console.error(e);
  process.exit(1);
});
