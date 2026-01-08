// scripts/build_veneto_relax.js
// Genera: public/data/pois/regions/it-veneto-relax.json
// Fonte:  public/data/pois/regions/it-veneto.json

const fs = require("fs");
const path = require("path");

const IN_FILE = path.join(process.cwd(), "public/data/pois/regions/it-veneto.json");
const OUT_FILE = path.join(process.cwd(), "public/data/pois/regions/it-veneto-relax.json");

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tagsStr(p) {
  const tags = Array.isArray(p?.tags) ? p.tags : [];
  return tags.map(x => String(x).toLowerCase()).join(" ");
}

function hasAny(hay, arr) {
  for (const k of arr) if (hay.includes(k)) return true;
  return false;
}

// --- regole "Relax vero" (molto più aggressive) ---
function looksWellnessByName(p) {
  const n = norm(p?.name);
  return hasAny(n, [
    "terme","termale","thermal","spa","wellness","benessere",
    "hammam","hamam","bagno turco","sauna",
    "hot spring","acqua termale","parco termale","piscine termali"
  ]);
}

function isSpaPlace(p) {
  const t = tagsStr(p);
  const n = norm(p?.name);

  // tag forti
  const strongTags =
    t.includes("amenity=spa") || t.includes("leisure=spa") || t.includes("tourism=spa") ||
    t.includes("healthcare=spa") ||
    t.includes("amenity=sauna") || t.includes("leisure=sauna") || t.includes("healthcare=sauna") ||
    t.includes("natural=hot_spring") ||
    t.includes("amenity=public_bath") ||
    t.includes("bath:type=thermal") ||
    t.includes("spa=yes");

  // anche hotel SOLO se spa-like dal nome (es: “Hotel Terme”, “Spa Resort”)
  const spaHotel =
    (t.includes("tourism=hotel") || t.includes("tourism=guest_house") || t.includes("tourism=hostel")) &&
    looksWellnessByName(p);

  // piscina ok SOLO se spa-like dal nome
  const poolSpaLike =
    t.includes("leisure=swimming_pool") &&
    (n.includes("terme") || n.includes("spa") || n.includes("thermal") || n.includes("wellness") || n.includes("benessere"));

  return strongTags || looksWellnessByName(p) || spaHotel || poolSpaLike;
}

// dedupe semplice: id se c'è, altrimenti name+lat+lon
function makeId(p) {
  if (p?.id) return String(p.id);
  const nm = norm(p?.name);
  const lat = String(p?.lat ?? "").slice(0, 8);
  const lon = String(p?.lon ?? p?.lng ?? "").slice(0, 8);
  return `p_${nm}_${lat}_${lon}`;
}

function main() {
  if (!fs.existsSync(IN_FILE)) {
    console.error("❌ File sorgente non trovato:", IN_FILE);
    process.exit(1);
  }

  const raw = fs.readFileSync(IN_FILE, "utf8");
  const json = JSON.parse(raw);

  const placesRaw = Array.isArray(json?.places) ? json.places : [];
  console.log("Fonte places:", placesRaw.length);

  const out = [];
  const seen = new Set();

  for (const p of placesRaw) {
    if (!p) continue;

    // coordinate minime
    const lat = Number(p.lat);
    const lon = Number(p.lon ?? p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    // match relax
    if (!isSpaPlace(p)) continue;

    const pid = makeId(p);
    if (seen.has(pid)) continue;
    seen.add(pid);

    // normalizza lon/lat su chiavi lat/lon (come usa app.js)
    const pp = { ...p, lat, lon };
    delete pp.lng;

    out.push(pp);
  }

  // ordina "bella sensazione": prima le terme/thermal dal nome
  out.sort((a, b) => {
    const aHot = looksWellnessByName(a) ? 1 : 0;
    const bHot = looksWellnessByName(b) ? 1 : 0;
    return (bHot - aHot) || String(a.name || "").localeCompare(String(b.name || ""), "it");
  });

  const outJson = {
    region_id: "it-veneto-relax",
    country: "IT",
    label_it: "Veneto — Relax",
    source: "derived_from_it-veneto.json",
    generated_at: new Date().toISOString(),
    places: out
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(outJson, null, 2), "utf8");

  console.log("✅ Creato:", OUT_FILE);
  console.log("✅ Relax places:", out.length);
}

main();
