// scripts/build_borghi_veneto.mjs
// Genera: public/data/pois/regions/it-veneto-borghi.json
// Fonte: Overpass API (OSM) — borghi "turistici" (no paesini anonimi / frazioni)

import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "public/data/pois/regions/it-veneto-borghi.json");

// BBOX Veneto (approx): south,west,north,east
const BBOX = { s: 44.70, w: 10.20, n: 46.70, e: 13.20 };

// Overpass endpoints (fallback)
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
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
  return `osm:${el.type[0]}:${el.id}`;
}

function getLatLon(el) {
  if (el.type === "node") return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  return null;
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

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function hasAny(n, arr) {
  for (const k of arr) if (n.includes(k)) return true;
  return false;
}

/**
 * Segnali "turismo vero" per borghi:
 * - wikipedia/wikidata
 * - heritage / historic / tourism
 * - castelli, mura, rocche, centro storico
 * - viewpoint / attraction nelle immediate caratteristiche del luogo
 */
function borgoScore(tags = {}, name = "") {
  const t = tags;
  const n = normName(name);

  let s = 0.0;

  // fortissimo: wikipedia / wikidata
  if (t.wikipedia || t["wikipedia:it"] || t.wikidata) s += 0.45;

  // heritage / historic
  if (t.heritage) s += 0.18;
  if (t.historic && t.historic !== "yes") s += 0.18;

  // tourism signals
  if (t.tourism === "attraction") s += 0.18;
  if (t.tourism === "viewpoint") s += 0.12;
  if (t.tourism === "museum") s += 0.08;

  // name keywords (centri storici, castelli ecc.)
  if (hasAny(n, ["borgo", "centro storico", "citta murata", "città murata", "mura", "rocca", "castello", "forte", "torre"])) s += 0.12;

  // place importance (non prendiamo hamlet/locality)
  const plc = String(t.place || "").toLowerCase();
  if (plc === "town") s += 0.10;
  if (plc === "village") s += 0.06;

  // admin boundary (spesso comuni): non basta da solo, ma aiuta un po’
  if (t.boundary === "administrative") s += 0.04;

  // penalità: roba anonima / frazioni
  if (plc === "hamlet" || plc === "locality" || plc === "isolated_dwelling") s -= 0.70;

  // penalità: se name sembra frazione/loc
  if (hasAny(n, ["localita", "località", "frazione", "contrada", "case", "casa", "corte"])) s -= 0.18;

  return clamp(s, 0, 1);
}

/**
 * Regole di inclusione:
 * - accettiamo SOLO place=town|village
 * - e SOLO se score >= soglia (turistico)
 * - e NO se è frazione/hamlet/locality
 */
function isTouristicBorgo(tags = {}, name = "") {
  const plc = String(tags.place || "").toLowerCase();
  if (plc !== "town" && plc !== "village") return false;

  // esclusioni dure
  if (plc === "hamlet" || plc === "locality" || plc === "isolated_dwelling") return false;

  const s = borgoScore(tags, name);

  // soglia: qui fai la magia contro “paesini anonimi”
  // 0.18 = troppo permissivo; 0.32 = molto pulito; 0.28 = bilanciato.
  return s >= 0.30;
}

function visibilityFrom(tags = {}, name = "") {
  const t = tags;
  const n = normName(name);
  const strong =
    !!t.wikipedia || !!t["wikipedia:it"] || !!t.wikidata ||
    !!t.heritage ||
    (t.historic && t.historic !== "yes") ||
    t.tourism === "attraction" ||
    hasAny(n, ["borgo", "citta murata", "città murata", "castello", "rocca"]);
  return strong ? "chicca" : "classica";
}

function buildQuery(b) {
  const bbox = `${b.s},${b.w},${b.n},${b.e}`;

  // Strategia:
  // 1) place=town|village (nodi/relazioni) MA SOLO se hanno segnali storici/turistici/wikipedia
  // 2) out center tags così abbiamo coordinate anche per relation/way
  return `
[out:json][timeout:180];
(
  // place=town|village con segnali turistici/heritage/historic/wikipedia/wikidata
  node["place"~"^(town|village)$"]["name"](${bbox})
    (if:t["wikipedia"] || t["wikipedia:it"] || t["wikidata"] || t["heritage"] || t["historic"] || t["tourism"]);
  way["place"~"^(town|village)$"]["name"](${bbox})
    (if:t["wikipedia"] || t["wikipedia:it"] || t["wikidata"] || t["heritage"] || t["historic"] || t["tourism"]);
  relation["place"~"^(town|village)$"]["name"](${bbox})
    (if:t["wikipedia"] || t["wikipedia:it"] || t["wikidata"] || t["heritage"] || t["historic"] || t["tourism"]);

  // keyword nel nome (a volte taggati male ma name dice tutto)
  node["place"~"^(town|village)$"]["name"~"borgo|centro storico|città murata|citta murata|castello|rocca|mura|torre",i](${bbox});
  way["place"~"^(town|village)$"]["name"~"borgo|centro storico|città murata|citta murata|castello|rocca|mura|torre",i](${bbox});
  relation["place"~"^(town|village)$"]["name"~"borgo|centro storico|città murata|citta murata|castello|rocca|mura|torre",i](${bbox});
);
out center tags;
`;
}

async function postOverpass(url, query) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return await res.json();
}

async function overpass(query) {
  let lastErr = null;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      return await postOverpass(url, query);
    } catch (e) {
      lastErr = e;
      // piccola pausa tra tentativi
      await new Promise(r => setTimeout(r, 900));
    }
  }
  throw lastErr || new Error("Overpass failed");
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

async function main() {
  console.log("OUT:", OUT);
  console.log("Fetching Overpass Veneto BORghi (touristic)…");

  const data = await overpass(buildQuery(BBOX));
  const els = Array.isArray(data.elements) ? data.elements : [];

  const places = [];

  for (const el of els) {
    const tags = el.tags || {};
    const name = tags.name || tags["name:it"] || "";
    if (!name) continue;

    const ll = getLatLon(el);
    if (!ll || !Number.isFinite(ll.lat) || !Number.isFinite(ll.lon)) continue;

    if (!isTouristicBorgo(tags, name)) continue;

    const score = borgoScore(tags, name);
    const vis = visibilityFrom(tags, name);

    // beauty_score: diamo una base alta (sono già filtrati), poi raffiniamo col punteggio
    const beauty = clamp(0.72 + score * 0.26, 0.70, 0.98);

    places.push({
      id: makeId(el),
      name: String(name).trim(),
      lat: Number(ll.lat),
      lon: Number(ll.lon),
      type: "borghi",
      visibility: vis,
      beauty_score: Number(beauty.toFixed(3)),
      country: "IT",
      area: pickArea(tags),
      tags: tagsToList(tags),
    });
  }

  // Ordiniamo: prima chicche più “forti”
  const clean = dedupe(places).sort((a, b) => {
    const av = a.visibility === "chicca" ? 1 : 0;
    const bv = b.visibility === "chicca" ? 1 : 0;
    if (bv !== av) return bv - av;
    return (b.beauty_score - a.beauty_score) || a.name.localeCompare(b.name);
  });

  const out = {
    region_id: "it-veneto-borghi",
    country: "IT",
    label_it: "Veneto • Borghi (turistici)",
    bbox_hint: { lat: 45.5, lng: 11.9, radius_km: 240 },
    generated_at: new Date().toISOString(),
    places: clean,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`OK: ${OUT} (${out.places.length} places)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
