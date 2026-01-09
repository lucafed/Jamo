// scripts/build_borghi_veneto.mjs
// Genera: public/data/pois/regions/it-veneto-borghi.json
// Scopo: borghi "turistici veri" (NO hamlet/contrade anonime)
// Strategia:
// - prendiamo solo place=town|village (NO hamlet)
// - richiediamo segnali turistici forti (wikipedia/wikidata, historic centre/castle, tourism=attraction, ecc.)
// - scoring + visibilità (classica/chicca) con euristiche
// - Overpass robusto con failover + retry per errori 429/504

import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "public/data/pois/regions/it-veneto-borghi.json");

// BBOX Veneto (approx): south,west,north,east
const BBOX = { s: 44.70, w: 10.20, n: 46.70, e: 13.20 };

// Overpass endpoints (failover)
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];

// Hard excludes (rumore)
const BAD_NAME_HINTS = [
  "localita", "località", "contrada", "case", "corte", "cason", "casoni",
  "borgata", "frazione", "zona industriale", "z i", "area produttiva",
  "lottizzazione", "capannoni"
];

function normName(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function makeId(el) {
  return `osm:${el.type[0]}:${el.id}`; // n/w/r
}

function tagsToList(tags = {}) {
  return Object.entries(tags).map(([k, v]) => `${k}=${v}`);
}

function pickArea(tags = {}) {
  return (
    tags["addr:city"] ||
    tags["addr:town"] ||
    tags["addr:village"] ||
    tags["is_in:city"] ||
    tags["is_in"] ||
    "Veneto"
  );
}

function getLatLon(el) {
  if (el.type === "node") return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

function hasAnyNorm(n, arr) {
  for (const x of arr) if (n.includes(x)) return true;
  return false;
}

function isBadName(name) {
  const n = normName(name);
  if (!n) return true;
  if (n.length < 4) return true;
  if (hasAnyNorm(n, BAD_NAME_HINTS)) return true;

  // spesso i posti anonimi sono una parola secca tipo "Spina", "Dere" ecc.
  // NON li escludiamo a priori, ma se non hanno segnali forti verranno filtrati dopo.
  return false;
}

// segnali turistici "forti" dai tag OSM
function signals(tags = {}) {
  const t = tags;

  const hasWiki = !!(t.wikipedia || t["wikipedia:it"] || t.wikidata);
  const hasWebsite = !!(t.website || t["contact:website"]);

  const isTown = t.place === "town";
  const isVillage = t.place === "village";

  const historicStrong =
    t.historic === "castle" ||
    t.historic === "fort" ||
    t.historic === "citywalls" ||
    t.historic === "archaeological_site" ||
    t.historic === "monument" ||
    t.historic === "ruins" ||
    t.historic === "centre";

  const hasAttraction =
    t.tourism === "attraction" ||
    t.tourism === "museum" ||
    t.tourism === "information" ||
    t.tourism === "viewpoint";

  const hasOldTown =
    t["old_town"] === "yes" ||
    t["historic:district"] === "yes" ||
    t["heritage"] ||
    t["heritage:operator"];

  const hasNameSignals = (() => {
    const n = normName(t.name || "");
    return (
      n.includes("borgo") ||
      n.includes("castello") ||
      n.includes("rocca") ||
      n.includes("citta murata") ||
      n.includes("città murata") ||
      n.includes("centro storico") ||
      n.includes("medieval") ||
      n.includes("medioeval")
    );
  })();

  // popolazione spesso assente, ma se c'è la usiamo
  const pop = Number(t.population || NaN);
  const hasPop = Number.isFinite(pop) && pop > 0;

  return {
    hasWiki,
    hasWebsite,
    isTown,
    isVillage,
    historicStrong,
    hasAttraction,
    hasOldTown,
    hasNameSignals,
    hasPop,
    pop,
  };
}

// filtro: niente hamlet e serve "valore turistico"
function isTouristicBorgoCandidate(tags = {}, name = "") {
  if (!name) return false;
  if (tags.place !== "town" && tags.place !== "village") return false;

  const s = signals(tags);

  // richiediamo almeno 2 segnali forti
  let strong = 0;
  if (s.hasWiki) strong++;
  if (s.historicStrong) strong++;
  if (s.hasOldTown) strong++;
  if (s.hasAttraction) strong++;
  if (s.hasWebsite) strong++;
  if (s.hasNameSignals) strong++;

  // town: può passare con 1 segnale forte (es: città storiche note)
  if (s.isTown) return strong >= 1;

  // village: più duro
  return strong >= 2;
}

// scoring + visibilità (classica/chicca) euristico
function scoreAndVisibility(tags = {}) {
  const s = signals(tags);

  let beauty = 0.72;

  if (s.hasWiki) beauty += 0.10;
  if (s.historicStrong) beauty += 0.10;
  if (s.hasOldTown) beauty += 0.07;
  if (s.hasAttraction) beauty += 0.06;
  if (s.hasWebsite) beauty += 0.03;

  // clamp
  beauty = Math.max(0.60, Math.min(0.98, beauty));

  // visibilità:
  // - "classica" se town oppure popolazione alta o wiki + segnali storici
  // - "chicca" se village con segnali forti ma non "grande"
  let visibility = "chicca";
  if (s.isTown) visibility = "classica";
  if (s.hasPop && s.pop >= 12000) visibility = "classica";
  if (s.hasWiki && (s.historicStrong || s.hasOldTown)) visibility = "classica";

  return { beauty_score: Number(beauty.toFixed(3)), visibility };
}

function dedupe(items) {
  const byId = new Set();
  const byNameCell = new Set();

  const out = [];
  for (const p of items) {
    if (byId.has(p.id)) continue;
    byId.add(p.id);

    const cellLat = Math.round(p.lat * 1000) / 1000;
    const cellLon = Math.round(p.lon * 1000) / 1000;
    const key = `${normName(p.name)}|${cellLat}|${cellLon}`;
    if (byNameCell.has(key)) continue;
    byNameCell.add(key);

    out.push(p);
  }
  return out;
}

function buildQuery(b) {
  const bbox = `${b.s},${b.w},${b.n},${b.e}`;

  // PRE-FILTER via Overpass: prendiamo place town/village con segnali turistici
  // (così evitiamo di scaricare tonnellate di hamlet anonimi)
  return `
[out:json][timeout:180];
(
  node["place"="town"](${bbox});
  way["place"="town"](${bbox});
  relation["place"="town"](${bbox});

  node["place"="village"]["wikipedia"](${bbox});
  way["place"="village"]["wikipedia"](${bbox});
  relation["place"="village"]["wikipedia"](${bbox});

  node["place"="village"]["wikidata"](${bbox});
  way["place"="village"]["wikidata"](${bbox});
  relation["place"="village"]["wikidata"](${bbox});

  node["place"="village"]["historic"](${bbox});
  way["place"="village"]["historic"](${bbox});
  relation["place"="village"]["historic"](${bbox});

  node["place"="village"]["tourism"](${bbox});
  way["place"="village"]["tourism"](${bbox});
  relation["place"="village"]["tourism"](${bbox});

  // alcune località storiche sono taggate male: prendiamo anche "centre"
  node["place"="village"]["historic"="centre"](${bbox});
  way["place"="village"]["historic"="centre"](${bbox});
  relation["place"="village"]["historic"="centre"](${bbox});

  // fallback name-signals (pochi, ma utili)
  node["place"="village"]["name"~"borgo|castello|rocca|centro storico|città murata|citta murata|medieval|medioeval",i](${bbox});
  way["place"="village"]["name"~"borgo|castello|rocca|centro storico|città murata|citta murata|medieval|medioeval",i](${bbox});
  relation["place"="village"]["name"~"borgo|castello|rocca|centro storico|città murata|citta murata|medieval|medioeval",i](${bbox});
);
out center tags;
`;
}

async function postOverpass(endpoint, query, signal) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "data=" + encodeURIComponent(query),
    signal,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const err = new Error(`Overpass HTTP ${res.status} @ ${endpoint}${txt ? " :: " + txt.slice(0, 140) : ""}`);
    err.status = res.status;
    throw err;
  }
  return await res.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function overpassRobust(query) {
  const ac = new AbortController();
  const signal = ac.signal;

  const maxRounds = 6;
  let lastErr = null;

  for (let round = 0; round < maxRounds; round++) {
    for (const ep of OVERPASS_ENDPOINTS) {
      try {
        // backoff leggero tra tentativi
        if (round > 0) await sleep(500 * round);

        const data = await postOverpass(ep, query, signal);
        return data;
      } catch (e) {
        lastErr = e;

        // 429/504/502/503: tipici di Overpass -> retry/failover
        const st = Number(e?.status || 0);
        if ([429, 502, 503, 504].includes(st)) {
          continue;
        }
        // altri errori -> esci
        break;
      }
    }

    // backoff tra round
    await sleep(1200 + round * 900);
  }

  throw lastErr || new Error("Overpass failed after retries.");
}

async function main() {
  console.log("OUT:", OUT);
  console.log("Fetching Overpass Veneto BORghi (tourist-grade)…");

  const query = buildQuery(BBOX);
  const data = await overpassRobust(query);
  const els = Array.isArray(data.elements) ? data.elements : [];

  const places = [];

  for (const el of els) {
    const tags = el.tags || {};
    const name = tags.name || tags["name:it"] || "";
    if (!name) continue;

    // scarta subito nomi sospetti
    if (isBadName(name)) {
      // non escludiamo qui: alcuni borghi veri potrebbero contenere "case" nel nome
      // ma li filtreremo con i segnali.
    }

    const ll = getLatLon(el);
    if (!ll || !Number.isFinite(ll.lat) || !Number.isFinite(ll.lon)) continue;

    if (!isTouristicBorgoCandidate(tags, name)) continue;

    const { beauty_score, visibility } = scoreAndVisibility(tags);

    places.push({
      id: makeId(el),
      name: String(name).trim(),
      lat: Number(ll.lat),
      lon: Number(ll.lon),
      type: "borghi",
      visibility,              // "classica" | "chicca"
      beauty_score,            // 0..1
      country: "IT",
      area: pickArea(tags),
      tags: tagsToList(tags),
    });
  }

  const out = {
    region_id: "it-veneto-borghi",
    country: "IT",
    label_it: "Veneto • Borghi (curated)",
    bbox_hint: { lat: 45.5, lng: 11.9, radius_km: 240 },
    generated_at: new Date().toISOString(),
    places: dedupe(places),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`OK: ${OUT} (${out.places.length} places)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
