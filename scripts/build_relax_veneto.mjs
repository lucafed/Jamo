// scripts/build_relax_veneto.mjs
// Genera: public/data/pois/regions/it-veneto-relax.json
// Fonte: Overpass API (OSM) -> terme/spa/wellness/sauna/hot_spring/public_bath + hotel/resort SPA-like
// Output "pulito" per categoria Relax (monetizzabile Booking se serve)

import fs from "node:fs";
import path from "node:path";

const OUT = path.join(process.cwd(), "public/data/pois/regions/it-veneto-relax.json");

// BBOX Veneto (approx): south,west,north,east
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

function makeId(el) {
  return `osm:${el.type[0]}:${el.id}`; // n/w/r
}

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

function hasAny(str, arr) {
  for (const x of arr) if (str.includes(x)) return true;
  return false;
}

// blacklist dura: niente negozi / artigianato / industria
function isBlacklisted(tags = {}) {
  if (tags.shop) return true;
  if (tags.craft) return true;
  if (tags.industrial) return true;
  if (tags.office) return true;

  // servizi non turistici
  const amen = tags.amenity;
  if (
    amen === "parking" ||
    amen === "fuel" ||
    amen === "bank" ||
    amen === "pharmacy" ||
    amen === "clinic" ||
    amen === "school" ||
    amen === "post_office" ||
    amen === "police" ||
    amen === "townhall"
  ) return true;

  const tour = tags.tourism;
  if (tour === "information" || tour === "map") return true;

  return false;
}

// Relax “vero”: spa/terme e simili
function isRelaxCore(tags = {}, name = "") {
  const t = tags;
  const n = normName(name);

  const tagStrong =
    t["amenity"] === "spa" ||
    t["leisure"] === "spa" ||
    t["tourism"] === "spa" ||
    t["natural"] === "hot_spring" ||
    t["amenity"] === "public_bath" ||
    t["amenity"] === "sauna" ||
    t["leisure"] === "sauna" ||
    t["healthcare"] === "spa" ||
    t["healthcare"] === "sauna" ||
    t["bath:type"] === "thermal" ||
    t["spa"] === "yes";

  const nameStrong = hasAny(n, [
    "terme","termale","thermal","spa","wellness","benessere","hammam","hamam",
    "bagno turco","sauna","idroterapia","acqua termale","piscine termali"
  ]);

  // piscine: SOLO se spa-like
  const poolSpaLike =
    (t["leisure"] === "swimming_pool" || t["leisure"] === "swimming_area") &&
    hasAny(n, ["terme","spa","thermal","wellness","benessere","termali"]);

  return tagStrong || nameStrong || poolSpaLike;
}

// Hotel/strutture: includi SOLO se hanno segnali relax (nome o tag spa-like)
function isSpaLodging(tags = {}, name = "") {
  const t = tags;
  const n = normName(name);

  const lodging =
    t.tourism === "hotel" ||
    t.tourism === "resort" ||
    t.tourism === "guest_house" ||
    t.tourism === "apartment" ||
    t.tourism === "chalet" ||
    t.tourism === "motel";

  if (!lodging) return false;

  // segnali spa veri
  const spaSignals =
    t.spa === "yes" ||
    t.amenity === "spa" ||
    t.leisure === "spa" ||
    t.amenity === "sauna" ||
    t.leisure === "sauna" ||
    t.natural === "hot_spring" ||
    t["bath:type"] === "thermal" ||
    hasAny(n, ["spa","wellness","benessere","terme","termale","thermal","hammam","bagno turco","sauna"]);

  return !!spaSignals;
}

function scorePlace(tags = {}, name = "") {
  const n = normName(name);

  let s = 0;
  // spingi “terme/hot_spring/spa” sopra gli hotel generici
  if (tags.natural === "hot_spring") s += 50;
  if (tags.amenity === "public_bath") s += 40;
  if (tags.amenity === "spa" || tags.leisure === "spa" || tags.tourism === "spa") s += 40;
  if (tags.amenity === "sauna" || tags.leisure === "sauna" || tags.healthcare === "sauna") s += 30;
  if (tags["bath:type"] === "thermal") s += 25;
  if (tags.spa === "yes") s += 20;

  if (hasAny(n, ["terme","termale","thermal"])) s += 18;
  if (hasAny(n, ["spa","wellness","benessere"])) s += 12;

  // segnali “azienda seria”
  if (tags.website) s += 6;
  if (tags.phone) s += 2;
  if (tags.opening_hours) s += 2;
  if (tags.wikidata || tags.wikipedia) s += 8;

  // penalità: manca nome
  if (!name || String(name).trim().length < 2) s -= 100;

  return s;
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

  // Query mirata + keyword + hotel spa-like
  // Nota: includiamo hotel/resort ecc. SOLO se nel nome c’è wellness/terme/spa
  return `
[out:json][timeout:180];
(
  node["amenity"="spa"](${bbox});
  way["amenity"="spa"](${bbox});
  relation["amenity"="spa"](${bbox});

  node["leisure"="spa"](${bbox});
  way["leisure"="spa"](${bbox});
  relation["leisure"="spa"](${bbox});

  node["tourism"="spa"](${bbox});
  way["tourism"="spa"](${bbox});
  relation["tourism"="spa"](${bbox});

  node["natural"="hot_spring"](${bbox});
  way["natural"="hot_spring"](${bbox});
  relation["natural"="hot_spring"](${bbox});

  node["amenity"="public_bath"](${bbox});
  way["amenity"="public_bath"](${bbox});
  relation["amenity"="public_bath"](${bbox});

  node["amenity"="sauna"](${bbox});
  way["amenity"="sauna"](${bbox});
  relation["amenity"="sauna"](${bbox});

  node["healthcare"="spa"](${bbox});
  way["healthcare"="spa"](${bbox});
  relation["healthcare"="spa"](${bbox});

  node["healthcare"="sauna"](${bbox});
  way["healthcare"="sauna"](${bbox});
  relation["healthcare"="sauna"](${bbox});

  // Keyword nel nome (terme/spa ecc.)
  node["name"~"terme|termale|thermal|spa|wellness|benessere|hammam|hamam|bagno turco|sauna",i](${bbox});
  way["name"~"terme|termale|thermal|spa|wellness|benessere|hammam|hamam|bagno turco|sauna",i](${bbox});
  relation["name"~"terme|termale|thermal|spa|wellness|benessere|hammam|hamam|bagno turco|sauna",i](${bbox});

  // Hotel/resort/guest_house con keyword spa-like nel nome
  node["tourism"~"hotel|resort|guest_house|apartment|chalet|motel"]["name"~"terme|termale|thermal|spa|wellness|benessere|hammam|hamam|bagno turco|sauna",i](${bbox});
  way["tourism"~"hotel|resort|guest_house|apartment|chalet|motel"]["name"~"terme|termale|thermal|spa|wellness|benessere|hammam|hamam|bagno turco|sauna",i](${bbox});
  relation["tourism"~"hotel|resort|guest_house|apartment|chalet|motel"]["name"~"terme|termale|thermal|spa|wellness|benessere|hammam|hamam|bagno turco|sauna",i](${bbox});
);
out center tags;
`;
}

function getLatLon(el) {
  if (el.type === "node") return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  return null;
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
  console.log("CWD:", process.cwd());
  console.log("OUT:", OUT);
  console.log("Fetching Overpass Veneto Relax…");

  const data = await overpass(buildQuery(BBOX));
  const els = Array.isArray(data.elements) ? data.elements : [];

  const places = [];

  for (const el of els) {
    const tags = el.tags || {};
    if (isBlacklisted(tags)) continue;

    const name = tags.name || tags["name:it"] || "";
    const ll = getLatLon(el);
    if (!ll || !Number.isFinite(ll.lat) || !Number.isFinite(ll.lon)) continue;

    // includi SOLO se relax core o lodging spa-like
    const ok = isRelaxCore(tags, name) || isSpaLodging(tags, name);
    if (!ok) continue;

    const s = scorePlace(tags, name);

    places.push({
      id: makeId(el),
      name: String(name || "").trim(),
      lat: Number(ll.lat),
      lon: Number(ll.lon),
      type: "relax",
      visibility: "classica",
      beauty_score: 0.86,
      country: "IT",
      area: pickArea(tags),
      tags: tagsToList(tags),
      // utile per debug/ordinamento (puoi toglierlo se non vuoi)
      score: s,
    });
  }

  // ordina: prima le “terme vere”
  places.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const out = {
    region_id: "it-veneto-relax",
    country: "IT",
    label_it: "Veneto • Relax",
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
