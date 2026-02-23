// scripts/build_pois_it_region_all.mjs
// Build POIs for ALL categories for ONE IT region via Overpass (safe + retry + CLEAN)
// Usage:
//   REGION_SLUG=piemonte REGION_ISO=IT-21 node scripts/build_pois_it_region_all.mjs
//
// Output files:
//   public/data/pois/it/<region_slug>/<category>.json
//   public/data/pois/it/<region_slug>/index.json

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const OUT_BASE = path.join(ROOT, "public", "data", "pois", "it");

// Overpass endpoints (fallback)
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function nowIso() {
  return new Date().toISOString();
}

async function fetchWithTimeout(url, body, timeoutMs = 55000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body,
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json().catch(() => null);
    if (!j) throw new Error("Bad JSON");
    return j;
  } finally {
    clearTimeout(t);
  }
}

function opBody(q) {
  return `data=${encodeURIComponent(q)}`;
}

async function runOverpass(query) {
  const body = opBody(query);
  let lastErr = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const j = await fetchWithTimeout(endpoint, body, 55000);
        return { ok: true, endpoint, json: j };
      } catch (e) {
        lastErr = e;
        await sleep(1000 * attempt);
      }
    }
  }
  return {
    ok: false,
    endpoint: "",
    json: null,
    error: String(lastErr?.message || lastErr),
  };
}

// ---------------------- NORMALIZE + FILTERS ----------------------
function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hasAny(str, arr) {
  return arr.some((k) => str.includes(k));
}

function tagEq(tags, k, v) {
  return String(tags?.[k] ?? "").toLowerCase() === String(v).toLowerCase();
}

// ANTI-SPAZZATURA globale
function isClearlyIrrelevant(p) {
  const t = p.tags || {};
  const ts = Object.entries(t)
    .map(([k, v]) => `${String(k).toLowerCase()}=${String(v).toLowerCase()}`)
    .join(" ");
  const n = normName(p.name || "");

  // trasporti/strade
  if (hasAny(ts, ["highway=", "railway=", "public_transport=", "route=", "junction="])) return true;
  if (hasAny(ts, ["amenity=bus_station", "highway=bus_stop", "highway=platform"])) return true;

  // parking/fuel/charging
  if (
    hasAny(ts, [
      "amenity=parking",
      "amenity=parking_entrance",
      "amenity=parking_space",
      "highway=rest_area",
      "amenity=fuel",
      "amenity=charging_station",
    ])
  )
    return true;

  // industrial/commercial/office
  if (
    hasAny(ts, [
      "landuse=industrial",
      "landuse=commercial",
      "building=industrial",
      "building=warehouse",
      "building=office",
      "man_made=works",
    ])
  )
    return true;

  // rumore tecnico
  if (hasAny(ts, ["man_made=survey_point", "power=", "telecom=", "pipeline="])) return true;

  // nomi spazzatura
  if (hasAny(n, ["parcheggio", "stazione", "fermata", "svincolo", "uscita", "cabina", "impianto", "linea", "tratto", "km "]))
    return true;

  // “SpA azienda” (ma non spa terme)
  const looksCompany = n.endsWith(" spa") || n.includes(" s p a") || n.includes(" s.p.a") || n.includes(" azienda ");
  const looksWellness = hasAny(n, ["terme", "spa", "wellness", "termale", "thermal", "sauna", "hammam"]);
  if (looksCompany && !looksWellness) return true;

  return false;
}

// Relax: NO musei / NO "spazio" / NO roba culturale spacciata per spa
function isRelaxNoise(p) {
  const t = p.tags || {};
  const n = normName(p.name || "");
  const ts = Object.entries(t)
    .map(([k, v]) => `${String(k).toLowerCase()}=${String(v).toLowerCase()}`)
    .join(" ");

  // se è un museo o simili, fuori
  if (ts.includes("tourism=museum")) return true;
  if (hasAny(ts, ["amenity=arts_centre", "amenity=theatre", "amenity=cinema", "amenity=library"])) return true;
  if (hasAny(n, ["museo", "mostra", "galleria", "spazio multimediale", "multimediale", "centro culturale", "auditorium"]))
    return true;

  // evita il bug "spa" dentro "spazio"
  if (n.includes("spazio") && !hasAny(n, ["spa ", " spa", "terme", "wellness", "benessere"])) return true;

  // evita posti che non hanno alcun tag wellness vero
  const hasWellnessTag =
    tagEq(t, "tourism", "spa") ||
    tagEq(t, "leisure", "spa") ||
    tagEq(t, "amenity", "spa") ||
    tagEq(t, "amenity", "sauna") ||
    tagEq(t, "amenity", "public_bath") ||
    tagEq(t, "natural", "hot_spring") ||
    tagEq(t, "thermal", "yes") ||
    hasAny(ts, ["bath:type=thermal", "healthcare=spa"]);
  if (!hasWellnessTag && !hasAny(n, ["terme", "termale", "thermal", "wellness", "benessere", "hammam"])) return true;

  return false;
}

// Borghi: solo settlement (NO monumenti/castelli singoli)
function isBorgoNoise(p) {
  const t = p.tags || {};
  const ts = Object.entries(t)
    .map(([k, v]) => `${String(k).toLowerCase()}=${String(v).toLowerCase()}`)
    .join(" ");
  const n = normName(p.name || "");
  const place = String(t.place || "").toLowerCase();
  const hist = String(t.historic || "").toLowerCase();

  const isSettlement =
    ["hamlet", "village", "town", "city", "suburb"].includes(place) ||
    ["old_town", "city", "town", "village", "hamlet"].includes(hist) ||
    (String(t.boundary || "") === "administrative" && /^(8|9)$/.test(String(t.admin_level || "")));

  if (!isSettlement) return true;

  // escludi chiaramente cose tipo "monumento a", "memoriale", ecc.
  if (hasAny(n, ["monumento", "memorial", "statua", "lapide"])) return true;

  // escludi anche “case sparse” come borgo
  if (n.includes("case sparse")) return true;

  // castelli/abbazie come “borgo” no (sono storia)
  if (
    !hasAny(n, ["borgo", "centro storico", "paese", "frazione"]) &&
    hasAny(ts, ["historic=castle", "historic=ruins", "historic=monument", "amenity=place_of_worship"])
  ) {
    return true;
  }

  return false;
}

// City: evita locality + roba "zona industriale"
function isCittaNoise(p) {
  const t = p.tags || {};
  const pt = String(t.place || "").toLowerCase();
  const n = normName(p.name || "");
  if (pt === "locality") return true;
  if (hasAny(n, ["zona industriale", "area industriale", "interporto"])) return true;
  return false;
}

function overpassAreaSelectorByISO(iso3166_2) {
  return `area["ISO3166-2"="${iso3166_2}"]["boundary"="administrative"]->.a;`;
}

// ---------------------- QUERIES ----------------------
// Fix principale: "spa" con confini (NO spazio). Overpass regex: (^|\\W)spa(\\W|$)
function buildQuery(category, iso3166_2) {
  const header = `[out:json][timeout:240];`;
  const area = overpassAreaSelectorByISO(iso3166_2);

  // IMPORTANT: categories must match app.js canonical
  if (category === "relax") {
    return `
${header}
${area}
(
  // tags veri
  nwr(area.a)["tourism"="spa"];
  nwr(area.a)["leisure"="spa"];
  nwr(area.a)["amenity"="spa"];
  nwr(area.a)["amenity"="sauna"];
  nwr(area.a)["amenity"="public_bath"];
  nwr(area.a)["natural"="hot_spring"];
  nwr(area.a)["thermal"="yes"];
  nwr(area.a)["healthcare"="spa"];

  // nomi (con confini di parola): NO "spazio"
  nwr(area.a)["name"~"terme|termal|thermal|wellness|benessere|hammam",i];
  nwr(area.a)["name"~"(^|\\\\W)spa(\\\\W|$)",i];
);
out tags center;
`;
  }

  if (category === "family") {
    return `
${header}
${area}
(
  // TOP family
  nwr(area.a)["tourism"="theme_park"];
  nwr(area.a)["leisure"="water_park"];
  nwr(area.a)["tourism"="zoo"];
  nwr(area.a)["tourism"="aquarium"];

  // parchi avventura / fattorie / safari / attrazioni family
  nwr(area.a)["tourism"="attraction"]["name"~"parco\\\\s?avventura|zip\\\\s?line|safari|fattoria\\\\s?didattica|parco\\\\s?faunistico|lunapark|luna\\\\s?park|giostre|parco\\\\s?divertimenti|acquapark|aqua\\\\s?park|water\\\\s?park|minigolf|go\\\\s?kart|kart",i];

  // musei kids/scienza/planetari
  nwr(area.a)["tourism"="museum"]["name"~"bambin|bambini|kids|children|museo\\\\s?dei\\\\s?bambini|science\\\\s?center|planetari|planetarium",i];

  // parchi e giardini (family soft)
  nwr(area.a)["leisure"="park"]["name"];
  nwr(area.a)["leisure"="garden"]["name"];

  // playground (anche senza nome)
  nwr(area.a)["leisure"="playground"];

  // piscine e attività family comuni
  nwr(area.a)["leisure"="swimming_pool"];
  nwr(area.a)["amenity"="swimming_pool"];
);
out tags center;
`;
  }

  if (category === "cantine") {
    return `
${header}
${area}
(
  nwr(area.a)["craft"="winery"];
  nwr(area.a)["shop"="wine"];
  nwr(area.a)["amenity"="wine_bar"];
);
out tags center;
`;
  }

  if (category === "borghi") {
    return `
${header}
${area}
(
  nwr(area.a)["place"~"^(hamlet|village|town|city|suburb)$"]["name"];
  nwr(area.a)["historic"~"^(old_town|village|town|city|hamlet)$"]["name"];
  nwr(area.a)["boundary"="administrative"]["admin_level"~"^(8|9)$"]["name"];
);
out tags center;
`;
  }

  if (category === "mare") {
    return `
${header}
${area}
(
  nwr(area.a)["natural"="beach"];
  nwr(area.a)["tourism"="beach_resort"];
  nwr(area.a)["leisure"="marina"];
  nwr(area.a)["man_made"="lighthouse"];
);
out tags center;
`;
  }

  if (category === "natura") {
    return `
${header}
${area}
(
  nwr(area.a)["waterway"="waterfall"];
  nwr(area.a)["natural"="cave_entrance"];
  nwr(area.a)["natural"="spring"];
  nwr(area.a)["natural"="hot_spring"];
  nwr(area.a)["boundary"~"^(protected_area|national_park)$"];
  nwr(area.a)["leisure"="nature_reserve"];
);
out tags center;
`;
  }

  // LAKE (manca nel tuo file vecchio): aggiungo qui
  if (category === "lago") {
    return `
${header}
${area}
(
  nwr(area.a)["water"="lake"];
  nwr(area.a)["natural"="water"]["water"="lake"];
  nwr(area.a)["water"="reservoir"];
  nwr(area.a)["landuse"="reservoir"];
  nwr(area.a)["name"~"lago|laghetto|lake|lac|laguna",i];
  nwr(area.a)["leisure"="marina"];
  nwr(area.a)["amenity"="boat_rental"];
  nwr(area.a)["tourism"="picnic_site"];
  nwr(area.a)["tourism"="camp_site"];
);
out tags center;
`;
  }

  if (category === "trekking") {
    return `
${header}
${area}
(
  nwr(area.a)["tourism"="information"]["information"="guidepost"];
  nwr(area.a)["tourism"="alpine_hut"];
  nwr(area.a)["amenity"="shelter"];
  nwr(area.a)["route"="hiking"];
  nwr(area.a)["highway"="path"];
  nwr(area.a)["highway"="footway"];
  nwr(area.a)["name"~"sentiero|trail|trek|trekking|via\\\\s?ferrata|rifugio|anello",i];
);
out tags center;
`;
  }

  if (category === "storia") {
    return `
${header}
${area}
(
  nwr(area.a)["historic"="castle"];
  nwr(area.a)["historic"="ruins"];
  nwr(area.a)["historic"="archaeological_site"];
  nwr(area.a)["historic"="fort"];
  nwr(area.a)["historic"="monument"];
  nwr(area.a)["historic"="memorial"];
  nwr(area.a)["tourism"="museum"];
  nwr(area.a)["historic"="citywalls"];
);
out tags center;
`;
  }

  if (category === "montagna") {
    return `
${header}
${area}
(
  nwr(area.a)["natural"="peak"];
  nwr(area.a)["natural"="saddle"];
  nwr(area.a)["tourism"="alpine_hut"];
  nwr(area.a)["amenity"="shelter"];
  nwr(area.a)["tourism"="viewpoint"];
  nwr(area.a)["aerialway"];
  nwr(area.a)["piste:type"];
);
out tags center;
`;
  }

  // fallback: "citta" (non usata da app.js, ma lasciata per completezza se ti serve)
  return `
${header}
${area}
(
  nwr(area.a)["place"="city"];
  nwr(area.a)["place"="town"];
  nwr(area.a)["place"="suburb"];
);
out tags center;
`;
}

// ---------------------- MAP + DEDUP ----------------------
function mapElToPlace(el, catKey, regionSlug, regionIso) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    id: `poi_${catKey}_${regionSlug}_${el.type}_${el.id}`,
    name: String(name).trim(),
    lat,
    lon,
    type: catKey,
    primary_category: catKey,
    visibility: "classica",
    score: 0,
    tags: Object.entries(tags).slice(0, 50).map(([k, v]) => `${k}=${v}`),
    country: "IT",
    area: regionSlug,
    region_iso: regionIso,
    source: "overpass_region_build",
    live: false,
  };
}

function dedup(places) {
  const seen = new Set();
  const out = [];
  for (const p of places) {
    const k = `${normName(p.name)}_${String(p.lat).slice(0, 6)}_${String(p.lon).slice(0, 6)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

// ---------------------- SCORING (semplice ma utile) ----------------------
function scoreFor(category, p) {
  const t = Object.fromEntries(
    (p.tags || []).map((x) =>
      x.includes("=") ? [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)] : ["", ""]
    )
  );
  const n = normName(p.name || "");
  let s = 0;

  if (category === "relax") {
    if (t.natural === "hot_spring") s += 90;
    if (t.amenity === "public_bath") s += 80;
    if (t.amenity === "sauna") s += 65;
    if (t.tourism === "spa" || t.leisure === "spa" || t.amenity === "spa") s += 70;
    if (t.thermal === "yes") s += 45;
    if (hasAny(n, ["terme", "termale", "thermal"])) s += 40;
    if (hasAny(n, ["wellness", "benessere", "hammam"])) s += 25;
  }

  if (category === "family") {
    if (t.tourism === "theme_park") s += 90;
    if (t.leisure === "water_park") s += 85;
    if (t.tourism === "zoo" || t.tourism === "aquarium") s += 80;
    if (t.leisure === "park" || t.leisure === "garden") s += 45;
    if (t.leisure === "playground") s += 55;
    if (t.leisure === "swimming_pool" || t.amenity === "swimming_pool") s += 60;
    if (hasAny(n, ["parco avventura", "zip line", "safari", "fattoria didattica", "lunapark", "acquapark", "minigolf", "kart"]))
      s += 35;
  }

  if (category === "cantine") {
    if (t.craft === "winery") s += 85;
    if (t.amenity === "wine_bar") s += 70;
    if (t.shop === "wine") s += 60;
    if (hasAny(n, ["cantina", "winery", "enoteca", "degustaz", "wine tasting"])) s += 25;
  }

  if (category === "borghi") {
    if (hasAny(n, ["borgo", "centro storico", "frazione", "paese"])) s += 35;
    if (hasAny(n, ["case sparse"])) s -= 40;
    if (hasAny(n, ["monumento", "statua", "lapide"])) s -= 50;
  }

  if (category === "mare") {
    if (t.natural === "beach") s += 85;
    if (t.tourism === "beach_resort") s += 80;
    if (t.man_made === "lighthouse") s += 55;
    if (t.leisure === "marina") s += 40;
    if (hasAny(n, ["spiaggia", "lido", "cala", "baia", "scogliera"])) s += 35;
  }

  if (category === "lago") {
    if (t.water === "lake") s += 85;
    if (t.water === "reservoir") s += 55;
    if (t.landuse === "reservoir") s += 45;
    if (hasAny(n, ["lago", "laghetto", "laguna"])) s += 25;
    if (t.amenity === "boat_rental") s += 25;
    if (t.tourism === "picnic_site" || t.tourism === "camp_site") s += 18;
  }

  if (category === "natura") {
    if (t.waterway === "waterfall") s += 85;
    if (t.natural === "cave_entrance") s += 75;
    if (t.leisure === "nature_reserve") s += 70;
    if (t.boundary === "national_park") s += 80;
    if (t.boundary === "protected_area") s += 65;
    if (hasAny(n, ["cascata", "gole", "grotta", "riserva", "oasi", "parco"])) s += 25;
  }

  if (category === "trekking") {
    if (t.route === "hiking") s += 70;
    if (t.tourism === "alpine_hut") s += 75;
    if (t.amenity === "shelter") s += 55;
    if (t.highway === "path" || t.highway === "footway") s += 35;
    if (hasAny(n, ["sentiero", "trail", "anello", "via ferrata", "rifugio"])) s += 25;
  }

  if (category === "storia") {
    if (t.historic === "castle") s += 90;
    if (t.historic === "archaeological_site") s += 85;
    if (t.historic === "fort") s += 80;
    if (t.historic === "ruins") s += 70;
    if (t.tourism === "museum") s += 65;
    if (t.historic === "monument" || t.historic === "memorial") s += 40;
  }

  if (category === "montagna") {
    if (t.natural === "peak") s += 85;
    if (t.tourism === "alpine_hut") s += 80;
    if (t.amenity === "shelter") s += 55;
    if (t.aerialway) s += 40;
    if (t["piste:type"]) s += 40;
    if (hasAny(n, ["monte", "cima", "passo", "rifugio", "malga"])) s += 25;
  }

  // qualità info = bonus (POCHI MA FORTI)
  if (t.wikipedia) s += 18;
  if (t.wikidata) s += 12;
  if (t.website || t["contact:website"]) s += 12;
  if (t.opening_hours) s += 8;

  // penalità rumore (extra)
  if (hasAny(n, ["parcheggio", "stazione", "svincolo"])) s -= 40;

  return s;
}

function visibilityFromScore(score, category) {
  const cut =
    {
      relax: 80,
      family: 75,
      borghi: 30,
      cantine: 70,
      mare: 75,
      lago: 70,
      natura: 75,
      trekking: 70,
      storia: 75,
      montagna: 70,
    }[category] ?? 70;

  return score >= cut ? "chicca" : "classica";
}

// ---------------------- MAIN ----------------------
// SOLO le categorie reali della tua app:
const CATEGORIES = ["montagna", "mare", "lago", "relax", "cantine", "family", "borghi", "storia", "natura", "trekking"];

async function main() {
  const regionSlug = String(process.env.REGION_SLUG || "").trim().toLowerCase();
  const regionIso = String(process.env.REGION_ISO || "").trim().toUpperCase();

  if (!regionSlug || !regionIso) {
    console.error("Missing REGION_SLUG or REGION_ISO. Example: REGION_SLUG=piemonte REGION_ISO=IT-21");
    process.exit(1);
  }

  const outDir = path.join(OUT_BASE, regionSlug);
  ensureDir(outDir);

  const index = {
    meta: {
      built_at: nowIso(),
      region_slug: regionSlug,
      region_iso: regionIso,
      categories: CATEGORIES,
    },
    counts: {},
    files: [],
  };

  for (const catKey of CATEGORIES) {
    console.log(`🛰️ ${regionSlug} (${regionIso}) -> ${catKey}`);

    const q = buildQuery(catKey, regionIso);
    const r = await runOverpass(q);

    if (!r.ok || !r.json) {
      console.log(`❌ ${catKey} failed: ${r.error || "unknown"}`);
      index.counts[catKey] = 0;
      index.files.push({
        category: catKey,
        path: `/data/pois/it/${regionSlug}/${catKey}.json`,
        count: 0,
        ok: false,
      });

      fs.writeFileSync(
        path.join(outDir, `${catKey}.json`),
        JSON.stringify(
          {
            meta: {
              built_at: nowIso(),
              region_slug: regionSlug,
              region_iso: regionIso,
              category: catKey,
              ok: false,
              error: r.error || "overpass_failed",
            },
            places: [],
          },
          null,
          0
        ),
        "utf8"
      );
      continue;
    }

    const els = Array.isArray(r.json.elements) ? r.json.elements : [];
    let mapped = dedup(els.map((el) => mapElToPlace(el, catKey, regionSlug, regionIso)).filter(Boolean));

    // filtri globali
    mapped = mapped.filter((p) => !isClearlyIrrelevant(p));

    // filtri specifici
    if (catKey === "relax") mapped = mapped.filter((p) => !isRelaxNoise(p));
    if (catKey === "borghi") mapped = mapped.filter((p) => !isBorgoNoise(p));

    // scoring + visibility
    mapped = mapped
      .map((p) => {
        const sc = scoreFor(catKey, p);
        return { ...p, score: sc, visibility: visibilityFromScore(sc, catKey) };
      })
      .sort((a, b) => b.score - a.score);

    // POCHI MA FORTI: tieni solo il top N, così la tua app non pesca spazzatura
    const MAX_PER_CATEGORY = 1600;
    mapped = mapped.slice(0, MAX_PER_CATEGORY);

    const meta = {
      built_at: nowIso(),
      region_slug: regionSlug,
      region_iso: regionIso,
      category: catKey,
      endpoint: r.endpoint,
      count: mapped.length,
      ok: true,
    };

    fs.writeFileSync(path.join(outDir, `${catKey}.json`), JSON.stringify({ meta, places: mapped }, null, 0), "utf8");

    index.counts[catKey] = mapped.length;
    index.files.push({
      category: catKey,
      path: `/data/pois/it/${regionSlug}/${catKey}.json`,
      count: mapped.length,
      ok: true,
    });

    console.log(`✅ ${catKey}: ${mapped.length}`);
    await sleep(650);
  }

  fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify(index, null, 0), "utf8");
  console.log(`🎉 DONE index -> public/data/pois/it/${regionSlug}/index.json`);
}

main().catch((e) => {
  console.error("❌ build failed:", e);
  process.exit(1);
});
