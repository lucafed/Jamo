// scripts/build_pois_eu_uk.mjs
// Genera public/data/pois_eu_uk.json con POI "veri" (EU+UK) e FAMILY forte
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
// Nota: qui potenziamo FAMILY: non solo parchi a tema, ma anche zoo, acquari, parchi, playground.
const CATEGORIES = [
  // natura / outdoor
  { type: "mare",      label: "Beaches",        qids: ["Q40080"] },   // beach
  { type: "montagna",  label: "Mountains",      qids: ["Q8502"] },    // mountain
  { type: "natura",    label: "National parks", qids: ["Q46169"] },   // national park

  // relax
  { type: "relax",     label: "Hot springs",    qids: ["Q179734"] },  // hot spring

  // FAMILY (molto più ampio)
  // amusement/theme park, zoo, aquarium, park, playground
  { type: "bambini",   label: "Family places",  qids: [
      "Q152060",   // amusement park / theme park
      "Q43501",    // zoo
      "Q2281788",  // aquarium
      "Q22698",    // park
      "Q18972"     // playground
    ]
  },

  // (opzionale ma utile per trovare “storia” vicina casa)
  { type: "storia",    label: "Museums",        qids: ["Q33506"] },   // museum
  { type: "storia",    label: "Castles",        qids: ["Q23413"] },   // castle
];

// --- tuning anti-crash ---
const WDQS_ENDPOINT = "https://query.wikidata.org/sparql";

// LIMIT basso = risposte non troncate. Prendiamo qualità via ORDER BY.
const LIMIT_DEFAULT = 650;
// se JSON.parse fallisce, riproviamo con limiti più bassi
const LIMIT_FALLBACKS = [450, 320, 220, 140];

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function qidFromUrl(wdUrl) {
  return String(wdUrl || "").replace(/^.*\/(Q\d+)$/, "$1");
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
        "user-agent": "JamoPOIBuilder/1.2 (github-actions; contact: none)"
      }
    });

    try {
      return JSON.parse(text);
    } catch (e) {
      console.log(`  ${countryIso2}: JSON.parse failed with LIMIT=${lim}. retrying with smaller LIMIT…`);
      await new Promise(res => setTimeout(res, 800));
    }
  }
  return null;
}

function addType(tagsSet, type) {
  const t = norm(type);
  if (t) tagsSet.add(t);
}

function inferTagsFromTypes(types) {
  const s = new Set();
  const t = new Set((types || []).map(norm));

  if (t.has("mare")) { s.add("mare"); s.add("spiagge"); s.add("relax"); }
  if (t.has("montagna")) { s.add("montagna"); s.add("panorama"); s.add("trekking"); }
  if (t.has("natura")) { s.add("natura"); s.add("trekking"); s.add("family"); }
  if (t.has("relax")) { s.add("relax"); s.add("terme"); }
  if (t.has("bambini")) { s.add("bambini"); s.add("famiglie"); s.add("family"); s.add("attivita"); }
  if (t.has("storia")) { s.add("storia"); s.add("musei"); }

  return [...s];
}

async function run() {
  console.log("Building POIs EU+UK via Wikidata…");

  // Dedup robusto: unisci per QID (stesso item) e accumula types
  const byQid = new Map(); // qid -> poi

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

        const qid = qidFromUrl(item);
        const country = cc === "GB" ? "UK" : cc;

        const existing = byQid.get(qid);

        if (!existing) {
          byQid.set(qid, {
            id: `wd_${qid}`,
            wd: qid,
            name: label,
            country,
            lat: p.lat,
            lng: p.lon,
            types: [cat.type],                 // verrà arricchito
            visibility: sitelinks >= 35 ? "conosciuta" : "chicca",
            beauty_score: toBeautyScore(sitelinks),
            source: "wikidata",
            tags: []                            // verrà calcolato
          });
          countAdded++;
        } else {
          // stesso item ricade in più categorie: aggiungi type e aggiorna score se migliore
          if (!existing.types.includes(cat.type)) existing.types.push(cat.type);
          existing.beauty_score = Math.max(existing.beauty_score || 0, toBeautyScore(sitelinks));
          // se per qualche motivo cambia label, tieni quella “più lunga” (di solito più descrittiva)
          if ((label || "").length > (existing.name || "").length) existing.name = label;
        }
      }

      process.stdout.write(`  ${iso2}: +${countAdded}\n`);
      await new Promise(res => setTimeout(res, 220));
    }
  }

  // Finalize tags + sort
  const pois = [...byQid.values()].map(p => {
    const tags = inferTagsFromTypes(p.types);
    return { ...p, tags };
  });

  // Dedup extra: stesso nome+country+coord ~ (3 decimali) => tieni beauty maggiore e unisci types
  const dedup = new Map();
  for (const p of pois) {
    const k = `${norm(p.name)}|${p.country}|${p.lat.toFixed(3)}|${p.lng.toFixed(3)}`;
    const prev = dedup.get(k);
    if (!prev) dedup.set(k, p);
    else {
      const types = Array.from(new Set([...(prev.types||[]), ...(p.types||[])]));
      const tags = Array.from(new Set([...(prev.tags||[]), ...(p.tags||[])]));
      dedup.set(k, {
        ...prev,
        types,
        tags,
        beauty_score: Math.max(prev.beauty_score||0, p.beauty_score||0),
      });
    }
  }

  const finalPois = [...dedup.values()];
  finalPois.sort((a,b)=> (b.beauty_score||0) - (a.beauty_score||0));

  const out = {
    version: "1.2",
    updated: new Date().toISOString().slice(0,10),
    regions: ["EU","UK"],
    pois: finalPois
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out), "utf8");

  console.log("\nSaved:", OUT);
  console.log("POIs:", finalPois.length);

  const typesCount = {};
  for (const p of finalPois) {
    for (const t of (p.types||[])) typesCount[t] = (typesCount[t]||0) + 1;
  }
  console.log("Types:", typesCount);
}

run().catch(e=>{
  console.error(e);
  process.exit(1);
});
