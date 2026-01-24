/**
 * build-mai-fatto-it-abruzzo-balanced.mjs
 * Genera idee "Mai fatto" per Abruzzo con categorie mancanti:
 * - famiglia, bici, moto, pioggia
 *
 * Output:
 *  public/data/mai_fatto/mai_fatto_it_abruzzo_balanced.json
 *
 * Run:
 *  node scripts/build-mai-fatto-it-abruzzo-balanced.mjs
 */

import fs from "fs";
import path from "path";

const OUT_FILE = "public/data/mai_fatto/mai_fatto_it_abruzzo_balanced.json";

const REGION = {
  name: "Abruzzo",
  bbox: { w: 13.0, s: 41.65, e: 14.85, n: 42.95 },
  grid: { cols: 5, rows: 5 },
};

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

// Quante idee massime per categoria (tieni alto per Abruzzo)
const TARGETS = {
  famiglia: 320,
  bici: 280,
  moto: 260,
  pioggia: 320,
};

// Limita rumore (puoi allargare dopo)
const EXCLUDE_NAME_WORDS = [
  "parcheggio",
  "parking",
  "distributore",
  "stazione",
  "fermata",
  "autogrill",
  "cimitero",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tileBBoxes(bbox, cols, rows) {
  const res = [];
  const dx = (bbox.e - bbox.w) / cols;
  const dy = (bbox.n - bbox.s) / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const w = bbox.w + c * dx;
      const e = bbox.w + (c + 1) * dx;
      const s = bbox.s + r * dy;
      const n = bbox.s + (r + 1) * dy;
      res.push({ w, s, e, n });
    }
  }
  return res;
}

function osmid(el) {
  // id stabile per dedupe
  if (!el) return "";
  const t = el.type || "x";
  const id = el.id ?? "";
  return `it_${t}_${id}`;
}

function pickCenter(el) {
  // nodes: lat/lon, ways/relations: center
  if (typeof el.lat === "number" && typeof el.lon === "number") {
    return { lat: el.lat, lon: el.lon };
  }
  const c = el.center;
  if (c && typeof c.lat === "number" && typeof c.lon === "number") {
    return { lat: c.lat, lon: c.lon };
  }
  return null;
}

function bestTitle(el) {
  const t = el.tags || {};
  return (
    t.name ||
    t["name:it"] ||
    t["name:en"] ||
    t.brand ||
    t.operator ||
    t.tourism ||
    t.amenity ||
    t.leisure ||
    "Idea WOW"
  );
}

function hasBadName(title) {
  const n = norm(title);
  if (!n) return true;
  return EXCLUDE_NAME_WORDS.some((w) => n.includes(w));
}

function bucketFromMin(min) {
  if (!Number.isFinite(min)) return "2h";
  return min <= 85 ? "1h" : "2h";
}

function durationForCategory(cat) {
  // solo per display: la distanza vera la calcola events.js dal punto di partenza
  if (cat === "pioggia") return 85;
  if (cat === "famiglia") return 120;
  if (cat === "bici") return 125;
  if (cat === "moto") return 150;
  return 110;
}

function whyFor(cat, title) {
  const t = String(title || "questo posto");
  const base = {
    pioggia:
      "È perfetto quando fuori non collabora: fai WOW senza meteo e senza sbatti. (Controlla orari).",
    famiglia:
      "È un posto che accende i bambini senza essere la solita cosa: facile, memorabile, zero stress.",
    bici:
      "È un giro che sembra una mini-vacanza: verde, ritmo lento e quel senso di ‘spazio’ che resetta.",
    moto:
      "È il tipo di strada/spot che ti fa tornare col sorriso: panorami larghi e vibe da gita vera.",
  };
  // micro-variazione
  return `${base[cat] || "Idea WOW vicina e non ovvia."} • ${t}`;
}

async function postOverpass(endpoint, query) {
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

async function overpassTry(query) {
  let lastErr = null;
  for (const ep of OVERPASS) {
    try {
      const j = await postOverpass(ep, query);
      if (j && Array.isArray(j.elements)) return { ok: true, ep, j };
    } catch (e) {
      lastErr = e;
      await sleep(250);
    }
  }
  return { ok: false, error: String(lastErr?.message || lastErr || "Overpass fail") };
}

// ---------- QUERIES PER CATEGORIA ----------
// Nota: uso "out center" così prendiamo lat/lon anche per ways/relations.
function qFamiglia(bb) {
  return `
[out:json][timeout:30];
(
  node["leisure"="playground"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["leisure"="playground"](${bb.s},${bb.w},${bb.n},${bb.e});
  relation["leisure"="playground"](${bb.s},${bb.w},${bb.n},${bb.e});

  node["tourism"="theme_park"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["tourism"="theme_park"](${bb.s},${bb.w},${bb.n},${bb.e});
  relation["tourism"="theme_park"](${bb.s},${bb.w},${bb.n},${bb.e});

  node["tourism"="zoo"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["tourism"="zoo"](${bb.s},${bb.w},${bb.n},${bb.e});
  relation["tourism"="zoo"](${bb.s},${bb.w},${bb.n},${bb.e});

  node["amenity"="aquarium"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["amenity"="aquarium"](${bb.s},${bb.w},${bb.n},${bb.e});
  relation["amenity"="aquarium"](${bb.s},${bb.w},${bb.n},${bb.e});

  node["leisure"="park"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["leisure"="park"](${bb.s},${bb.w},${bb.n},${bb.e});
  relation["leisure"="park"](${bb.s},${bb.w},${bb.n},${bb.e});

  node["tourism"="attraction"]["name"~"parco|avventura|dinos|museo dei bambini|kids|bambin",i](${bb.s},${bb.w},${bb.n},${bb.e});
);
out center tags;
`;
}

function qBici(bb) {
  return `
[out:json][timeout:30];
(
  way["highway"="cycleway"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["bicycle"="designated"](${bb.s},${bb.w},${bb.n},${bb.e});
  relation["route"="bicycle"](${bb.s},${bb.w},${bb.n},${bb.e});
  relation["route"="mtb"](${bb.s},${bb.w},${bb.n},${bb.e});
  // punti utili per “giro bici” (nodi)
  node["tourism"="viewpoint"](${bb.s},${bb.w},${bb.n},${bb.e});
);
out center tags;
`;
}

function qMoto(bb) {
  return `
[out:json][timeout:30];
(
  // passi/valichi
  node["mountain_pass"](${bb.s},${bb.w},${bb.n},${bb.e});
  // viewpoint panoramici (buoni come “sosta moto”)
  node["tourism"="viewpoint"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["tourism"="viewpoint"](${bb.s},${bb.w},${bb.n},${bb.e});
  // strade di montagna: prendiamo solo tertiary/secondary con "name" o "ref" (riduce rumore)
  way["highway"~"secondary|tertiary"]["name"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["highway"~"secondary|tertiary"]["ref"](${bb.s},${bb.w},${bb.n},${bb.e});
);
out center tags;
`;
}

function qPioggia(bb) {
  return `
[out:json][timeout:30];
(
  node["tourism"="museum"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["tourism"="museum"](${bb.s},${bb.w},${bb.n},${bb.e});
  relation["tourism"="museum"](${bb.s},${bb.w},${bb.n},${bb.e});

  node["tourism"="gallery"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["tourism"="gallery"](${bb.s},${bb.w},${bb.n},${bb.e});

  node["amenity"="theatre"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["amenity"="theatre"](${bb.s},${bb.w},${bb.n},${bb.e});

  node["historic"="castle"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["historic"="castle"](${bb.s},${bb.w},${bb.n},${bb.e});
  relation["historic"="castle"](${bb.s},${bb.w},${bb.n},${bb.e});

  node["natural"="cave_entrance"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["natural"="cave_entrance"](${bb.s},${bb.w},${bb.n},${bb.e});

  node["amenity"="spa"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["amenity"="spa"](${bb.s},${bb.w},${bb.n},${bb.e});
  node["tourism"="spa"](${bb.s},${bb.w},${bb.n},${bb.e});
  way["tourism"="spa"](${bb.s},${bb.w},${bb.n},${bb.e});
);
out center tags;
`;
}

const QUERIES = {
  famiglia: qFamiglia,
  bici: qBici,
  moto: qMoto,
  pioggia: qPioggia,
};

function toIdea(el, category) {
  const center = pickCenter(el);
  if (!center) return null;

  const title = bestTitle(el);
  if (hasBadName(title)) return null;

  const min = durationForCategory(category);

  return {
    id: osmid(el),
    title: title,
    place: title,
    city: "",
    region: "Abruzzo",
    country_code: "IT",
    lat: center.lat,
    lon: center.lon,
    category,
    duration_bucket: bucketFromMin(min),
    duration_min: min,
    why: whyFor(category, title),
    repeatable: true,
    url: "",
    source: "osm_overpass",
  };
}

async function collectForCategory(category, tiles) {
  const pick = new Map(); // id -> idea
  let tiles_ok = 0;
  let tiles_failed = 0;

  for (let i = 0; i < tiles.length; i++) {
    const bb = tiles[i];
    const q = QUERIES[category](bb);

    const res = await overpassTry(q);
    if (!res.ok) {
      tiles_failed++;
      continue;
    }
    tiles_ok++;

    const els = res.j.elements || [];
    for (const el of els) {
      const idea = toIdea(el, category);
      if (!idea) continue;
      if (!pick.has(idea.id)) pick.set(idea.id, idea);
    }

    // stop se abbiamo già abbastanza (veloce)
    if (pick.size >= (TARGETS[category] || 200)) break;

    // micro-pausa per non stressare endpoint
    if (i % 4 === 3) await sleep(120);
  }

  return { ideas: [...pick.values()], tiles_ok, tiles_failed };
}

function dedupeGlobal(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    if (!x?.id) continue;
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    out.push(x);
  }
  return out;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function main() {
  console.log("▶ build Abruzzo balanced…");

  const tiles = tileBBoxes(REGION.bbox, REGION.grid.cols, REGION.grid.rows);

  const allOut = [];
  const statsByCat = {};
  let tiles_ok_sum = 0;
  let tiles_failed_sum = 0;

  for (const cat of Object.keys(QUERIES)) {
    console.log(`  • collecting ${cat}…`);
    const r = await collectForCategory(cat, tiles);
    tiles_ok_sum += r.tiles_ok;
    tiles_failed_sum += r.tiles_failed;

    // limita a target, ma con shuffle per non “sempre gli stessi”
    const target = TARGETS[cat] || 200;
    const picked = shuffle(r.ideas).slice(0, target);

    statsByCat[cat] = { found: r.ideas.length, used: picked.length };
    allOut.push(...picked);
  }

  const ideas = dedupeGlobal(allOut);

  // Se vuoi tenere anche le categorie che già avevi (food/natura/tramonto),
  // qui puoi concatenare il vecchio file e poi dedupe.
  // (per ora generiamo SOLO le mancanti, così le controlli bene)

  const out = {
    _build_id: `abruzzo_balanced_${Date.now()}`,
    updated_at: nowIso(),
    count: ideas.length,
    area: "Abruzzo — Mai fatto (Balanced: Family + Bici + Moto + Pioggia) — rebuild",
    stats: {
      region: REGION.name,
      bbox: REGION.bbox,
      grid: REGION.grid,
      tiles_total: REGION.grid.cols * REGION.grid.rows,
      tiles_ok: tiles_ok_sum,
      tiles_failed: tiles_failed_sum,
      by_category: statsByCat,
      endpoints: OVERPASS,
    },
    ideas,
  };

  ensureDir(OUT_FILE);
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), "utf8");
  console.log(`✅ wrote ${OUT_FILE} (count=${ideas.length})`);
}

main().catch((e) => {
  console.error("❌ build failed:", e);
  process.exit(1);
});
