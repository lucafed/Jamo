// /api/destinations.js — Jamo LIVE destinations (Overpass) — v2.0
// Goal: tons of category-specific POIs, fast, resilient, cache.
// Query strategy: multiple small Overpass queries (avoid timeouts) + endpoint fallback.
// Returns: { ok:true, data:{elements:[...]}, meta:{cat,radiusKm,count,fromCache,endpoint,elapsedMs,notes:[] } }

const TTL_MS = 1000 * 60 * 20; // 20 min cache
const cache = new Map(); // key -> { ts, data }

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

function now() { return Date.now(); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function asNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function normCat(c) {
  const s = String(c || "ovunque").toLowerCase().trim();
  const allowed = new Set(["ovunque","family","relax","natura","storia","mare","borghi","citta","montagna"]);
  return allowed.has(s) ? s : "ovunque";
}

function cacheKey({ lat, lon, radiusKm, cat }) {
  // round to reduce cache fragmentation
  const la = Math.round(lat * 100) / 100; // ~1km
  const lo = Math.round(lon * 100) / 100;
  const rk = Math.round(radiusKm);
  return `${cat}:${rk}:${la}:${lo}`;
}

async function fetchWithTimeout(url, { method = "POST", body, headers = {} } = {}, timeoutMs = 14000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", ...headers },
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

function overpassBody(query) {
  // Overpass expects "data=<query>"
  return `data=${encodeURIComponent(query)}`;
}

function buildAround(radiusM, lat, lon) {
  return `around:${radiusM},${lat},${lon}`;
}

/**
 * Build small queries per category.
 * We prioritize "touristic/attraction" stuff and keep results high-volume.
 */
function buildQueries(cat, radiusM, lat, lon) {
  const A = buildAround(radiusM, lat, lon);

  // NOTE: we intentionally query mostly NODES first (fast),
  // plus some ways/relations where it matters (parks, beaches, historic sites).
  // Keep each query small to avoid timeouts.

  if (cat === "relax") {
    return [
      // Terme / hot springs / thermal / spa
      `
[out:json][timeout:12];
(
  node[amenity=spa](${A});
  node[leisure=spa](${A});
  node[natural=hot_spring](${A});
  node[amenity=public_bath](${A});
  node["healthcare"="sauna"](${A});
  node["sauna"="yes"](${A});
  node["thermal"="yes"](${A});
  node["name"~"terme|spa|thermal|benessere",i](${A});
);
out tags center 350;
      `.trim(),
      // Piscine / wellness centers / resort style relax
      `
[out:json][timeout:12];
(
  node[leisure=swimming_pool](${A});
  node[amenity=swimming_pool](${A});
  node[leisure=fitness_centre](${A});
  node["sport"="swimming"](${A});
  node["tourism"="resort"](${A});
  node["tourism"="hotel"]["spa"="yes"](${A});
);
out tags center 350;
      `.trim(),
      // Scenic “relax” chicche: viewpoints / picnic areas / quiet parks
      `
[out:json][timeout:12];
(
  node[tourism=viewpoint](${A});
  node[leisure=picnic_table](${A});
  node[leisure=park](${A});
);
out tags center 350;
      `.trim(),
    ];
  }

  if (cat === "family") {
    return [
      // Big attractions: theme park / amusement / water park / zoo / aquarium
      `
[out:json][timeout:12];
(
  node[tourism=theme_park](${A});
  way[tourism=theme_park](${A});
  node[leisure=amusement_arcade](${A});
  node[leisure=water_park](${A});
  way[leisure=water_park](${A});
  node[tourism=zoo](${A});
  way[tourism=zoo](${A});
  node[tourism=aquarium](${A});
  node[amenity=aquarium](${A});
  node[tourism=attraction](${A});
  node["name"~"parco divertimenti|parco acquatico|acquapark|aqua park|water park|luna park|zoo|acquario",i](${A});
);
out tags center 450;
      `.trim(),
      // Kids places: playground / trampoline / indoor play / pools
      `
[out:json][timeout:12];
(
  node[leisure=playground](${A});
  way[leisure=playground](${A});
  node["playground"="yes"](${A});
  node[leisure=trampoline_park](${A});
  node["leisure"="sports_centre"]["sport"="swimming"](${A});
  node[leisure=swimming_pool](${A});
  node[amenity=swimming_pool](${A});
  node["name"~"parco giochi|area giochi|gonfiabili|trampolin|kids|bambin",i](${A});
);
out tags center 450;
      `.trim(),
      // Family “always something”: parks, viewpoints, beaches, museums (kid-friendly option), animal farms
      `
[out:json][timeout:12];
(
  node[leisure=park](${A});
  way[leisure=park](${A});
  node[tourism=viewpoint](${A});
  node[tourism=museum](${A});
  node["tourism"="information"]["information"="visitor_centre"](${A});
  node["animal"="yes"](${A});
  node["name"~"fattoria|parco avventura|avventura|funivia|lago|cascata",i](${A});
);
out tags center 450;
      `.trim(),
      // (Optional) terme/spa also allowed in family (per tua richiesta)
      `
[out:json][timeout:12];
(
  node[amenity=spa](${A});
  node[natural=hot_spring](${A});
  node["name"~"terme|spa|thermal",i](${A});
);
out tags center 250;
      `.trim(),
    ];
  }

  if (cat === "mare") {
    return [
      `
[out:json][timeout:12];
(
  node[natural=beach](${A});
  way[natural=beach](${A});
  node["tourism"="attraction"]["name"~"spiaggia|lido|mare",i](${A});
  node["natural"="coastline"](${A});
);
out tags center 450;
      `.trim(),
      `
[out:json][timeout:12];
(
  node[leisure=marina](${A});
  node[harbour=yes](${A});
  node["tourism"="viewpoint"](${A});
);
out tags center 350;
      `.trim(),
    ];
  }

  if (cat === "natura") {
    return [
      `
[out:json][timeout:12];
(
  node[tourism=viewpoint](${A});
  node[natural=waterfall](${A});
  node[natural=peak](${A});
  node[natural=spring](${A});
  node[natural=wood](${A});
  node[leisure=park](${A});
  way[leisure=park](${A});
  node[boundary=national_park](${A});
  way[boundary=national_park](${A});
  node[leisure=nature_reserve](${A});
  way[leisure=nature_reserve](${A});
  node["name"~"cascata|lago|gola|riserva|parco|sentiero",i](${A});
);
out tags center 550;
      `.trim(),
    ];
  }

  if (cat === "storia") {
    return [
      `
[out:json][timeout:12];
(
  node[historic=castle](${A});
  way[historic=castle](${A});
  node[historic=ruins](${A});
  node[historic=archaeological_site](${A});
  node[tourism=museum](${A});
  node[historic=monument](${A});
  node[historic=memorial](${A});
  node["name"~"castello|rocca|forte|abbazia|museo|anfiteatro|tempio|scavi|necropolis|necropoli",i](${A});
);
out tags center 650;
      `.trim(),
      // Town centers / old towns (useful if you're 20 minutes from L'Aquila etc.)
      `
[out:json][timeout:12];
(
  node[place=town](${A});
  node[place=village](${A});
  node["tourism"="attraction"]["historic"](${A});
  node["name"~"centro storico|borgo|citta vecchia",i](${A});
);
out tags center 350;
      `.trim(),
    ];
  }

  if (cat === "borghi") {
    return [
      `
[out:json][timeout:12];
(
  node[place=village](${A});
  node[place=hamlet](${A});
  node["name"~"borgo",i](${A});
);
out tags center 450;
      `.trim(),
    ];
  }

  if (cat === "citta") {
    return [
      `
[out:json][timeout:12];
(
  node[place=city](${A});
  node[place=town](${A});
  node["tourism"="attraction"](${A});
);
out tags center 450;
      `.trim(),
    ];
  }

  if (cat === "montagna") {
    return [
      `
[out:json][timeout:12];
(
  node[natural=peak](${A});
  node[natural=mountain_range](${A});
  node["name"~"monte|cima|rifugio|passo",i](${A});
  node[tourism=viewpoint](${A});
);
out tags center 450;
      `.trim(),
    ];
  }

  // ovunque: general attractions + viewpoints + parks + museums + castles
  return [
    `
[out:json][timeout:12];
(
  node[tourism=attraction](${A});
  node[tourism=viewpoint](${A});
  node[tourism=museum](${A});
  node[historic=castle](${A});
  node[leisure=park](${A});
  node[natural=waterfall](${A});
  node[natural=beach](${A});
  node[amenity=spa](${A});
  node["name"~"castello|rocca|museo|cascata|lago|parco|terme|spa|spiaggia",i](${A});
);
out tags center 650;
    `.trim(),
  ];
}

function mergeElements(results) {
  const seen = new Set();
  const out = [];

  for (const j of results) {
    const els = Array.isArray(j?.elements) ? j.elements : [];
    for (const el of els) {
      const key = `${el.type}:${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(el);
    }
  }
  return out;
}

async function runOverpassQueries(queries) {
  const notes = [];
  const started = now();

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const results = [];
      for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        // small per-query timeout; if one fails, try next endpoint
        const j = await fetchWithTimeout(endpoint, { method: "POST", body: overpassBody(q) }, 15000);
        results.push(j);
      }
      const elements = mergeElements(results);
      return {
        ok: true,
        endpoint,
        elements,
        elapsedMs: now() - started,
        notes,
      };
    } catch (e) {
      notes.push(`endpoint_fail: ${String(e?.message || e)}`);
      continue;
    }
  }

  return { ok: false, endpoint: "", elements: [], elapsedMs: now() - started, notes };
}

export default async function handler(req, res) {
  try {
    const lat = asNum(req.query?.lat);
    const lon = asNum(req.query?.lon);
    const radiusKm = clamp(asNum(req.query?.radiusKm) ?? 60, 5, 300);
    const cat = normCat(req.query?.cat);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ ok: false, error: "Missing lat/lon" });
    }

    // radius meters
    const radiusM = Math.round(radiusKm * 1000);

    // cache
    const key = cacheKey({ lat, lon, radiusKm, cat });
    const hit = cache.get(key);
    if (hit && now() - hit.ts < TTL_MS) {
      return res.status(200).json({
        ok: true,
        data: hit.data,
        meta: {
          cat,
          radiusKm,
          count: hit.data?.elements?.length || 0,
          fromCache: true,
          endpoint: hit.endpoint || "",
          elapsedMs: 0,
          notes: ["cache_hit"],
        }
      });
    }

    const queries = buildQueries(cat, radiusM, lat, lon);

    // run
    const r = await runOverpassQueries(queries);

    const data = { elements: r.elements || [] };

    // store cache even if empty, but shorter TTL by just storing; (client can widen radius)
    cache.set(key, { ts: now(), data, endpoint: r.endpoint || "" });

    return res.status(200).json({
      ok: true,
      data,
      meta: {
        cat,
        radiusKm,
        count: data.elements.length,
        fromCache: false,
        endpoint: r.endpoint || "",
        elapsedMs: r.elapsedMs || 0,
        notes: r.notes || [],
      }
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
