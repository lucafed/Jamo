// scripts/build_borghi_veneto.mjs
// Genera: public/data/pois/regions/it-veneto-borghi.json
// Fonte: Overpass API (OSM)
// Obiettivo: BORghi davvero turistici (no frazioni anonime)

import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "public/data/pois/regions/it-veneto-borghi.json");
const BBOX = { s: 44.70, w: 10.20, n: 46.70, e: 13.20 };
const OVERPASS = "https://overpass-api.de/api/interpreter";

function normName(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function makeId(el) { return `osm:${el.type[0]}:${el.id}`; }
function tagsToList(tags = {}) {
  return Object.entries(tags).map(([k, v]) => `${String(k).toLowerCase()}=${String(v).toLowerCase()}`);
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
function hasAny(str, arr) { for (const x of arr) if (str.includes(x)) return true; return false; }

function getLatLon(el) {
  if (el.type === "node") return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

// segnali turistici forti
function touristSignals(tags = {}, name = "") {
  const t = tags;
  const n = normName(name);

  const wiki = !!(t.wikidata || t.wikipedia);
  const historic =
    !!t.historic ||
    t.tourism === "attraction" ||
    t.tourism === "museum" ||
    t.tourism === "viewpoint" ||
    t.man_made === "tower" ||
    t.heritage ||
    t.castle_type ||
    t.ruins;

  const nameSignal = hasAny(n, [
    "borgo","centro storico","citta murata","castello","rocca","fortezza",
    "antico","medieval","medioeval","panoram","belvedere","villa","palazzo"
  ]);

  // tag che spesso indicano “solo amministrativo”
  const adminOnly =
    t.boundary === "administrative" &&
    !wiki &&
    !historic &&
    !nameSignal;

  if (adminOnly) return { ok:false, score:0 };

  let score = 0;
  if (wiki) score += 35;
  if (t.tourism === "attraction") score += 18;
  if (t.historic) score += 16;
  if (t.heritage) score += 14;
  if (t.tourism === "viewpoint") score += 10;
  if (nameSignal) score += 8;

  // extra “qualità”
  if (t.website) score += 5;
  if (t.image) score += 4;
  if (t.opening_hours) score += 2;

  return { ok: (wiki || historic || nameSignal), score };
}

// filtro: via gli hamlet anonimi (hamlet solo se score alto)
function acceptPlace(tags = {}, name = "") {
  const place = String(tags.place || "");
  const { ok, score } = touristSignals(tags, name);

  if (!name || String(name).trim().length < 2) return { ok:false, score:0 };

  // town e village: ok se hanno almeno un segnale
  if (place === "town" || place === "village") {
    return { ok, score };
  }

  // hamlet: solo se davvero “forte”
  if (place === "hamlet") {
    return { ok: ok && score >= 28, score };
  }

  // altrimenti no
  return { ok:false, score:0 };
}

function visibilityFromScore(score) {
  // qui scegliamo “chicche” tra il top, ma SEMPRE roba bella
  // score alto = chicca
  return score >= 48 ? "chicca" : "classica";
}

function beautyFromScore(score) {
  // mappa score -> beauty_score (0.75 - 0.98)
  const b = 0.75 + Math.min(1, score / 70) * 0.23;
  return Math.max(0.75, Math.min(0.98, Number(b.toFixed(3))));
}

async function overpass(query) {
  const res = await fetch(OVERPASS, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return await res.json();
}

function buildQuery(b) {
  const bbox = `${b.s},${b.w},${b.n},${b.e}`;
  return `
[out:json][timeout:180];
(
  node["place"~"town|village|hamlet"](${bbox});
  way["place"~"town|village|hamlet"](${bbox});
  relation["place"~"town|village|hamlet"](${bbox});

  // anche centri storici “taggati bene” (non sempre hanno place)
  node["historic"="city_gate"](${bbox});
  node["historic"="castle"](${bbox});
  node["tourism"="attraction"](${bbox});
  node["tourism"="viewpoint"](${bbox});

  way["historic"="castle"](${bbox});
  way["tourism"="attraction"](${bbox});
  way["tourism"="viewpoint"](${bbox});

  relation["historic"="castle"](${bbox});
  relation["tourism"="attraction"](${bbox});
  relation["tourism"="viewpoint"](${bbox});
);
out center tags;
`;
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
  console.log("Fetching Overpass Veneto BORghi…");

  const data = await overpass(buildQuery(BBOX));
  const els = Array.isArray(data.elements) ? data.elements : [];

  const places = [];

  for (const el of els) {
    const tags = el.tags || {};
    const name = tags.name || tags["name:it"] || "";
    const ll = getLatLon(el);
    if (!ll || !Number.isFinite(ll.lat) || !Number.isFinite(ll.lon)) continue;

    const { ok, score } = acceptPlace(tags, name);
    if (!ok) continue;

    const vis = visibilityFromScore(score);
    const beauty = beautyFromScore(score);

    places.push({
      id: makeId(el),
      name: String(name).trim(),
      lat: Number(ll.lat),
      lon: Number(ll.lon),
      type: "borghi",
      visibility: vis,
      beauty_score: beauty,
      country: "IT",
      area: pickArea(tags),
      tags: tagsToList(tags),
      score,
    });
  }

  // ordina dal più turistico al meno turistico
  places.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const out = {
    region_id: "it-veneto-borghi",
    country: "IT",
    label_it: "Veneto • Borghi",
    bbox_hint: { lat: 45.5, lng: 11.9, radius_km: 240 },
    generated_at: new Date().toISOString(),
    places: dedupe(places),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`OK: wrote ${out.places.length} places -> ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
