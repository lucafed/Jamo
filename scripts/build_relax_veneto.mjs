/* scripts/build_relax_veneto.mjs
 * Jamo — Veneto RELAX (pulito, anti-504)
 * - Slicing bbox (riduce timeout)
 * - Retry + multi-endpoint Overpass
 * - Filtri duri: solo vere terme/spa/saune, NO aziende/strade/fermate
 * Output: public/data/pois/regions/it-veneto-relax.json
 */

import fs from "node:fs";
import path from "node:path";

const OUT_FILE = "public/data/pois/regions/it-veneto-relax.json";

/** Veneto bbox "macro" (coerente con la tua app.js) */
const VENETO_BBOX = { minLat: 44.70, maxLat: 46.70, minLon: 10.20, maxLon: 13.20 };

/** Slicing: 12 box (4x3) dentro al bbox Veneto */
const BBOXES = buildGridBBoxes(VENETO_BBOX, 4, 3);

/** Overpass endpoints (fallback) */
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

/** Retry policy */
const RETRIES = 3;
const TIMEOUT_MS = 60_000; // per call
const BACKOFF_BASE_MS = 8_000;

/** Relax tags ammessi (super stretti) */
const RELAX_QUERIES = [
  // spa
  `nwr["amenity"="spa"]`,
  `nwr["leisure"="spa"]`,
  `nwr["tourism"="spa"]`,
  `nwr["healthcare"="spa"]`,

  // terme / bagni termali
  `nwr["natural"="hot_spring"]`,
  `nwr["amenity"="public_bath"]`,
  `nwr["bath:type"="thermal"]`,

  // sauna
  `nwr["amenity"="sauna"]`,
  `nwr["leisure"="sauna"]`,
  `nwr["healthcare"="sauna"]`,
];

/** keyword di nome (usate SOLO come supporto nei filtri, non per includere) */
const NAME_POSITIVE = [
  "terme",
  "termale",
  "thermal",
  "hot spring",
  "spa",
  "wellness",
  "benessere",
  "sauna",
  "hammam",
  "hamam",
  "bagno turco",
  "idr",
];

const NAME_NEGATIVE_COMPANY = [
  // forme societarie
  /\bs\.?p\.?a\.?\b/i,
  /\bs\.?r\.?l\.?\b/i,
  /\bs\.?n\.?c\.?\b/i,
  /\bs\.?a\.?s\.?\b/i,
  /\bss\b/i,
  /\bcoop\b/i,
  /\bcooperativa\b/i,
  /\bimpresa\b/i,
  /\bazienda\b/i,
  /\bgroup\b/i,
  /\bholding\b/i,
  /\bindustr/i,
  /\bspa\b/i, // attenzione: "SPA" aziendale (uppercase) verrà colpito da questo solo se in CAPS nel nome; gestiamo sotto meglio
];

const NAME_NEGATIVE_PLACES = [
  /^via\b/i,
  /^viale\b/i,
  /^piazza\b/i,
  /^corte\b/i,
  /^localit[aà]\b/i,
  /^strada\b/i,
  /^vicolo\b/i,
  /^lungo\b/i,
  /^ponte\b/i,
  /^rotonda\b/i,
  /^parcheggio\b/i,
  /^fermata\b/i,
  /^stazione\b/i,
  /^cimitero\b/i,
];

/** tags da escludere sempre */
function hasBannedTags(tags) {
  // NO trasporti/strade
  if (tags.highway) return true;
  if (tags.public_transport) return true;
  if (tags.railway) return true;
  if (tags.aeroway) return true;
  if (tags.route) return true;

  // NO uffici/industrie/banche ecc
  const building = (tags.building || "").toLowerCase();
  if (building && ["office", "industrial", "warehouse", "commercial", "retail"].includes(building)) return true;

  const amenity = (tags.amenity || "").toLowerCase();
  if (["bank", "atm", "bureau_de_change", "post_office", "school", "university", "clinic", "hospital"].includes(amenity)) {
    // clinic/hospital: spesso NON relax
    return true;
  }

  const shop = (tags.shop || "").toLowerCase();
  if (shop) return true;

  const office = (tags.office || "").toLowerCase();
  if (office) return true;

  // Se è un semplice "building=*" ma NON ha tag relax solidi, lo buttiamo fuori più sotto.
  return false;
}

function looksLikeCompanyName(name) {
  const n = (name || "").trim();
  if (!n) return true;

  // Se contiene " SpA " come azienda (Openjobmetis SpA)
  if (/\bSpA\b/.test(n) || /\bS\.p\.A\.?\b/.test(n)) return true;
  if (/\bSrl\b/i.test(n) || /\bS\.r\.l\.?\b/i.test(n)) return true;
  if (/\bSas\b/i.test(n) || /\bSnc\b/i.test(n) || /\bS\.n\.c\.?\b/i.test(n)) return true;

  // parole tipiche azienda
  const low = n.toLowerCase();
  if (low.includes("openjobmetis") || low.includes("agenzia") || low.includes("assicur") || low.includes("banca")) return true;

  // regex negative generiche (azienda/impresa ecc)
  for (const r of NAME_NEGATIVE_COMPANY) {
    if (r.test(n)) {
      // Attenzione: "spa" in minuscolo può essere benessere.
      // Qui intercettiamo solo se è usato in contesto aziendale: spesso è "SpA" o "S.p.A".
      // Quindi se è solo "spa" minuscolo e ci sono tag relax validi, NON consideriamo azienda.
      if (String(r) === String(/\bspa\b/i)) {
        // se è "spa" ma il nome ha anche parole wellness, lo lasciamo passare
        if (hasAnyWord(low, ["wellness", "benessere", "term", "sauna", "hammam", "thermal", "terme"])) return false;
      }
      return true;
    }
  }
  return false;
}

function looksLikeStreetOrGeneric(name) {
  const n = (name || "").trim();
  if (!n) return true;
  for (const r of NAME_NEGATIVE_PLACES) if (r.test(n)) return true;

  // nomi troppo “tecnici”
  const low = n.toLowerCase();
  if (low.includes("case sparse")) return true;

  return false;
}

function hasAnyWord(text, words) {
  for (const w of words) if (text.includes(w)) return true;
  return false;
}

function isRelaxTagSolid(tags) {
  // vero relax se c'è almeno uno di questi segnali
  if (tags.natural === "hot_spring") return true;
  if (tags.amenity === "public_bath") return true;
  if (tags["bath:type"] === "thermal") return true;

  if (tags.amenity === "spa" || tags.leisure === "spa" || tags.tourism === "spa" || tags.healthcare === "spa") return true;

  if (tags.amenity === "sauna" || tags.leisure === "sauna" || tags.healthcare === "sauna") return true;

  return false;
}

function computeScore(tags, name) {
  // ranking semplice ma utile
  if (tags.natural === "hot_spring") return 140;
  if (tags.amenity === "public_bath" || tags["bath:type"] === "thermal") return 130;
  if (tags.amenity === "spa" || tags.leisure === "spa" || tags.tourism === "spa" || tags.healthcare === "spa") return 120;
  if (tags.amenity === "sauna" || tags.leisure === "sauna" || tags.healthcare === "sauna") return 110;

  // fallback
  const low = (name || "").toLowerCase();
  if (hasAnyWord(low, ["terme", "termale", "thermal"])) return 105;
  if (hasAnyWord(low, ["spa", "wellness", "benessere"])) return 100;
  return 90;
}

function normalizeTags(obj = {}) {
  // Overpass restituisce tags come object
  const tags = obj.tags || {};
  return tags;
}

function tagsToArray(tags) {
  const out = [];
  for (const [k, v] of Object.entries(tags || {})) {
    out.push(`${k}=${String(v)}`);
  }
  return out;
}

function pickName(el) {
  const t = normalizeTags(el);
  const name =
    t.name ||
    t["name:it"] ||
    t["official_name"] ||
    t["brand"] ||
    "";
  return String(name || "").trim();
}

function pickLatLon(el) {
  // node => lat/lon diretti
  if (typeof el.lat === "number" && typeof el.lon === "number") return { lat: el.lat, lon: el.lon };

  // way/relation => center se presente
  if (el.center && typeof el.center.lat === "number" && typeof el.center.lon === "number") {
    return { lat: el.center.lat, lon: el.center.lon };
  }

  return { lat: NaN, lon: NaN };
}

function inVenetoBBox(lat, lon) {
  return (
    lat >= VENETO_BBOX.minLat &&
    lat <= VENETO_BBOX.maxLat &&
    lon >= VENETO_BBOX.minLon &&
    lon <= VENETO_BBOX.maxLon
  );
}

function stableId(el) {
  // tipo osm:n:123 / osm:w:123 / osm:r:123
  const t = String(el.type || "");
  const id = String(el.id || "");
  const prefix = t === "node" ? "n" : t === "way" ? "w" : t === "relation" ? "r" : "x";
  return `osm:${prefix}:${id}`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function overpassRequest(query) {
  let lastErr = null;

  for (let attempt = 0; attempt < RETRIES; attempt++) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const res = await fetchWithTimeout(
          endpoint,
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
            body: `data=${encodeURIComponent(query)}`,
          },
          TIMEOUT_MS
        );

        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          const msg = `Overpass HTTP ${res.status} @ ${endpoint} :: ${txt.slice(0, 200)}`;
          throw new Error(msg);
        }

        const json = await res.json();
        if (!json || !Array.isArray(json.elements)) throw new Error("Overpass response invalid (no elements)");
        return json;
      } catch (e) {
        lastErr = e;
        // backoff prima di cambiare endpoint/ritentare
        await sleep(BACKOFF_BASE_MS * (attempt + 1));
      }
    }
  }

  throw lastErr || new Error("Overpass failed");
}

function buildOverpassQueryForBbox(b) {
  // out center per ways/relations
  const parts = RELAX_QUERIES.map((q) => `${q}(${b.minLat},${b.minLon},${b.maxLat},${b.maxLon});`).join("\n");
  return `
[out:json][timeout:45];
(
${parts}
);
out center tags;
`.trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildGridBBoxes(bbox, cols, rows) {
  const out = [];
  const dLat = (bbox.maxLat - bbox.minLat) / rows;
  const dLon = (bbox.maxLon - bbox.minLon) / cols;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const minLat = bbox.minLat + r * dLat;
      const maxLat = bbox.minLat + (r + 1) * dLat;
      const minLon = bbox.minLon + c * dLon;
      const maxLon = bbox.minLon + (c + 1) * dLon;

      out.push({
        minLat: round6(minLat),
        maxLat: round6(maxLat),
        minLon: round6(minLon),
        maxLon: round6(maxLon),
      });
    }
  }
  return out;
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function dedupePlaces(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (!p || !p.id) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

function prettySort(list) {
  // score desc, poi nome
  return [...list].sort((a, b) => (b.score - a.score) || String(a.name).localeCompare(String(b.name), "it"));
}

async function main() {
  console.log("Fetching Veneto RELAX (pulito, anti-504)...");
  console.log(`Slicing bbox: ${BBOXES.length} box`);

  const collected = [];

  for (let i = 0; i < BBOXES.length; i++) {
    const b = BBOXES[i];
    const q = buildOverpassQueryForBbox(b);

    console.log(`→ Box ${i + 1}/${BBOXES.length} (${b.minLat},${b.minLon} .. ${b.maxLat},${b.maxLon})`);
    const data = await overpassRequest(q);

    for (const el of data.elements) {
      const tags = normalizeTags(el);
      const name = pickName(el);
      const { lat, lon } = pickLatLon(el);

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (!inVenetoBBox(lat, lon)) continue;

      // must be real relax by tags
      if (!isRelaxTagSolid(tags)) continue;

      // post-filter durissimo
      if (hasBannedTags(tags)) continue;
      if (looksLikeStreetOrGeneric(name)) continue;

      // se sembra azienda, butta via
      if (looksLikeCompanyName(name)) continue;

      // extra: se non ha nome buono, via
      if (!name || name.length < 3) continue;

      // extra: se name non contiene alcuna keyword relax, ok lo stesso (tag solid)
      // ma se name sembra generico tipo "Spazio multidisciplinare ..." senza parole relax, lo togliamo
      const low = name.toLowerCase();
      const hasRelaxWord = hasAnyWord(low, NAME_POSITIVE.map((s) => s.toLowerCase()));
      if (!hasRelaxWord) {
        // Lasciamo passare SOLO se è hot_spring o public_bath/thermal (terme vere anche senza keyword nel nome)
        const isThermalCore =
          tags.natural === "hot_spring" ||
          tags.amenity === "public_bath" ||
          tags["bath:type"] === "thermal";
        if (!isThermalCore) continue;
      }

      const id = stableId(el);
      const score = computeScore(tags, name);

      collected.push({
        id,
        name,
        lat: round6(lat),
        lon: round6(lon),
        type: "relax",
        visibility: score >= 125 ? "classica" : "chicca", // semplice: vuoi chicche? qui le lasciamo più “rare”
        beauty_score: 0.86,
        country: "IT",
        area: "Veneto",
        tags: tagsToArray(tags),
        score,
      });
    }

    // micro-pausa per gentilezza verso Overpass
    await sleep(800);
  }

  const deduped = dedupePlaces(collected);
  const sorted = prettySort(deduped);

  const out = {
    region_id: "it-veneto-relax",
    country: "IT",
    label_it: "Veneto • Relax",
    bbox_hint: {
      lat: 45.5,
      lng: 11.9,
      radius_km: 240,
    },
    generated_at: new Date().toISOString(),
    places: sorted,
  };

  ensureDir(OUT_FILE);
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), "utf8");

  console.log("DONE ✅");
  console.log(`OUT: ${OUT_FILE}`);
  console.log(`PLACES: ${sorted.length}`);
}

main().catch((e) => {
  console.error("FAILED ❌", e?.message || e);
  process.exit(1);
});
