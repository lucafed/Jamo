// /api/destinations.js — Jamo LIVE destinations (Overpass) — v3.0
// Goals:
// - category-first POIs (touristic attractions, not random towns)
// - resilient: partial results, multi-endpoint, per-query timeout, never "hard fail"
// - less spam: viewpoints only if named, parks more meaningful
// - cache + safer outputs for the client

const TTL_MS = 1000 * 60 * 20; // 20 min cache
const cache = new Map(); // key -> { ts, data, endpoint }

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
  // round to reduce fragmentation
  const la = Math.round(lat * 100) / 100; // ~1km
  const lo = Math.round(lon * 100) / 100;
  const rk = Math.round(radiusKm);
  return `${cat}:${rk}:${la}:${lo}`;
}

async function fetchWithTimeout(url, { method = "POST", body, headers = {} } = {}, timeoutMs = 13000) {
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
  return `data=${encodeURIComponent(query)}`;
}

function around(radiusM, lat, lon) {
  return `around:${radiusM},${lat},${lon}`;
}

function mkHeader(timeoutSec = 12, maxsize = 1073741824) {
  // maxsize high but safe; still depends on endpoint.
  return `[out:json][timeout:${timeoutSec}][maxsize:${maxsize}];`;
}

/**
 * IMPORTANT:
 * - keep each query SMALL
 * - avoid huge "viewpoint" floods
 * - avoid "place=town/village" in family/natura/etc (those belong to borghi/citta)
 * - ask for named items when noisy
 */
function buildQueries(cat, radiusM, lat, lon) {
  const A = around(radiusM, lat, lon);

  // Common “quality” filters:
  // - Named where helpful (reduces spam)
  const NAMED_VIEWPOINT = `nwr[tourism=viewpoint][name](${A});`;
  const NAMED_ATTR = `nwr[tourism=attraction][name](${A});`;

  // FAMILY: "hard attractions" first, then soft, then optional spa
  if (cat === "family") {
    return [
      // 1) HARD ATTRACTIONS (what you really want)
      `
${mkHeader(12)}
(
  nwr[tourism=theme_park](${A});
  nwr[leisure=water_park](${A});
  nwr[leisure=amusement_arcade](${A});
  nwr[tourism=zoo](${A});
  nwr[tourism=aquarium](${A});
  nwr[amenity=aquarium](${A});
  nwr[leisure=trampoline_park](${A});
  nwr[leisure=playground][name](${A});       /* named playgrounds only */
  nwr[leisure=park][name](${A});             /* named parks only */
  nwr["tourism"="information"]["information"="visitor_centre"](${A});
  nwr["name"~"parco avventura|adventure park|funivia|zip line|luna park|acquapark|aqua ?park|water ?park|parco divertimenti|zoo|acquario",i](${A});
);
out tags center 300;
      `.trim(),

      // 2) POOLS / SPORTS / KID INDOOR (still good for family)
      `
${mkHeader(12)}
(
  nwr[leisure=swimming_pool](${A});
  nwr[amenity=swimming_pool](${A});
  nwr[leisure=sports_centre]["sport"="swimming"](${A});
  nwr["name"~"kids|bambin|gonfiabil|area giochi|parco giochi|indoor play|play center|ludoteca",i](${A});
);
out tags center 260;
      `.trim(),

      // 3) SOFT FAMILY fallback (ONLY named to avoid spam)
      `
${mkHeader(12)}
(
  ${NAMED_ATTR}
  ${NAMED_VIEWPOINT}
  nwr[tourism=museum][name](${A});   /* kid-friendly option */
  nwr["name"~"fattoria|agriturismo|parco|lago|cascata",i](${A});
);
out tags center 220;
      `.trim(),

      // 4) SPA/TERME allowed, but will be ranked lower client-side
      `
${mkHeader(12)}
(
  nwr[amenity=spa](${A});
  nwr[leisure=spa](${A});
  nwr[natural=hot_spring](${A});
  nwr[amenity=public_bath](${A});
  nwr["name"~"terme|spa|thermal|benessere",i](${A});
);
out tags center 160;
      `.trim(),
    ];
  }

  // RELAX: terme/spa + quiet places (named viewpoints / named parks / lakes)
  if (cat === "relax") {
    return [
      `
${mkHeader(12)}
(
  nwr[amenity=spa](${A});
  nwr[leisure=spa](${A});
  nwr[natural=hot_spring](${A});
  nwr[amenity=public_bath](${A});
  nwr["healthcare"="sauna"](${A});
  nwr["sauna"="yes"](${A});
  nwr["thermal"="yes"](${A});
  nwr["name"~"terme|spa|thermal|benessere|wellness",i](${A});
);
out tags center 320;
      `.trim(),
      `
${mkHeader(12)}
(
  nwr[leisure=swimming_pool](${A});
  nwr["tourism"="hotel"]["spa"="yes"](${A});
  nwr["tourism"="resort"](${A});
);
out tags center 220;
      `.trim(),
      `
${mkHeader(12)}
(
  ${NAMED_VIEWPOINT}
  nwr[leisure=park][name](${A});
  nwr[natural=water][name](${A});
  nwr["name"~"lago|belvedere|terrazza|panoram",i](${A});
);
out tags center 180;
      `.trim(),
    ];
  }

  // NATURA: waterfalls/peaks/springs/parks/reserves/trailheads + named viewpoints only
  if (cat === "natura") {
    return [
      `
${mkHeader(12)}
(
  nwr[natural=waterfall](${A});
  nwr[natural=peak](${A});
  nwr[natural=spring](${A});
  nwr[leisure=nature_reserve](${A});
  nwr[boundary=national_park](${A});
  nwr[leisure=park][name](${A});            /* named parks only */
  ${NAMED_VIEWPOINT}
  nwr["highway"="path"]["name"~"sentiero|trail",i](${A});
  nwr["name"~"cascata|lago|gola|riserva|parco|sentiero|forra",i](${A});
);
out tags center 360;
      `.trim(),
    ];
  }

  // STORIA: castles/ruins/archaeology/museums/monuments + named “old town/centro storico”
  if (cat === "storia") {
    return [
      `
${mkHeader(12)}
(
  nwr[historic=castle](${A});
  nwr[historic=ruins](${A});
  nwr[historic=archaeological_site](${A});
  nwr[tourism=museum](${A});
  nwr[historic=monument](${A});
  nwr[historic=memorial](${A});
  nwr["name"~"castello|rocca|forte|abbazia|museo|anfiteatro|tempio|scavi|necropol|duomo|basilica",i](${A});
);
out tags center 420;
      `.trim(),
      `
${mkHeader(12)}
(
  nwr["name"~"centro storico|citt(a|à) vecchia|borgo storico|old town",i](${A});
  nwr[tourism=attraction][historic](${A});
);
out tags center 220;
      `.trim(),
    ];
  }

  // MARE: beaches + marinas + seaside attractions (avoid coastline noise)
  if (cat === "mare") {
    return [
      `
${mkHeader(12)}
(
  nwr[natural=beach](${A});
  nwr["name"~"spiaggia|lido|baia|cala",i](${A});
  nwr[tourism=attraction]["name"~"spiaggia|mare|lido|baia|cala",i](${A});
);
out tags center 320;
      `.trim(),
      `
${mkHeader(12)}
(
  nwr[leisure=marina](${A});
  nwr[harbour=yes](${A});
  ${NAMED_VIEWPOINT}
);
out tags center 220;
      `.trim(),
    ];
  }

  // BORGHI: villages/hamlets (named) + borough keywords
  if (cat === "borghi") {
    return [
      `
${mkHeader(12)}
(
  nwr[place=village][name](${A});
  nwr[place=hamlet][name](${A});
  nwr["name"~"borgo",i](${A});
);
out tags center 380;
      `.trim(),
    ];
  }

  // CITTA: towns/cities + attractions
  if (cat === "citta") {
    return [
      `
${mkHeader(12)}
(
  nwr[place=city][name](${A});
  nwr[place=town][name](${A});
  ${NAMED_ATTR}
  nwr["name"~"centro storico|piazza|duomo|cattedrale",i](${A});
);
out tags center 360;
      `.trim(),
    ];
  }

  // MONTAGNA: peaks + viewpoints(named) + shelters/ropeways
  if (cat === "montagna") {
    return [
      `
${mkHeader(12)}
(
  nwr[natural=peak](${A});
  ${NAMED_VIEWPOINT}
  nwr[tourism=alpine_hut](${A});
  nwr["aerialway"](${A});
  nwr["name"~"monte|cima|rifugio|passo|funivia",i](${A});
);
out tags center 320;
      `.trim(),
    ];
  }

  // OVUNQUE: “best of” without viewpoint flood
  return [
    `
${mkHeader(12)}
(
  ${NAMED_ATTR}
  nwr[tourism=museum](${A});
  nwr[historic=castle](${A});
  nwr[natural=waterfall](${A});
  nwr[natural=beach](${A});
  nwr[amenity=spa](${A});
  ${NAMED_VIEWPOINT}
  nwr["name"~"castello|rocca|museo|cascata|lago|parco|terme|spa|spiaggia|abbazia",i](${A});
);
out tags center 520;
    `.trim(),
  ];
}

function mergeElements(jsonResults) {
  const seen = new Set();
  const out = [];

  for (const j of jsonResults) {
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

/**
 * Run queries with resilience:
 * - Try endpoints in order
 * - For each endpoint, run each query with per-query timeout
 * - If some queries fail, still return partial results (ok:true)
 */
async function runOverpassQueries(queries) {
  const notes = [];
  const started = now();

  for (const endpoint of OVERPASS_ENDPOINTS) {
    const results = [];
    let successCount = 0;

    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      try {
        // slightly smaller timeout per query = less dead time
        const j = await fetchWithTimeout(endpoint, { method: "POST", body: overpassBody(q) }, 12500);
        results.push(j);
        successCount++;
      } catch (e) {
        notes.push(`q${i}_fail:${String(e?.message || e)}`);
        // continue with other queries on SAME endpoint (partial)
      }
    }

    // If we got anything at all from this endpoint -> return partial/complete
    if (successCount > 0) {
      const elements = mergeElements(results);
      return {
        ok: true,
        endpoint,
        elements,
        elapsedMs: now() - started,
        notes: notes.length ? notes : ["ok_partial_or_full"],
      };
    }

    // otherwise try next endpoint
    notes.push(`endpoint_fail:${endpoint}`);
  }

  // Hard failure on all endpoints: still return ok:true with empty elements,
  // so the client can show “LIVE provato ma non disponibile” instead of breaking.
  return {
    ok: true,
    endpoint: "",
    elements: [],
    elapsedMs: now() - started,
    notes: notes.length ? notes : ["all_endpoints_failed"],
  };
}

export default async function handler(req, res) {
  try {
    const lat = asNum(req.query?.lat);
    const lon = asNum(req.query?.lon);
    const cat = normCat(req.query?.cat);

    // radius: clamp and also cap by category to reduce Overpass pain
    let radiusKm = clamp(asNum(req.query?.radiusKm) ?? 60, 5, 300);
    if (cat === "family")   radiusKm = clamp(radiusKm, 5, 220);
    if (cat === "ovunque")  radiusKm = clamp(radiusKm, 5, 220);
    if (cat === "natura")   radiusKm = clamp(radiusKm, 5, 200);
    if (cat === "storia")   radiusKm = clamp(radiusKm, 5, 220);
    if (cat === "mare")     radiusKm = clamp(radiusKm, 10, 260); // sea might be farther
    if (cat === "relax")    radiusKm = clamp(radiusKm, 5, 220);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ ok: false, error: "Missing lat/lon" });
    }

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

    const r = await runOverpassQueries(queries);
    const data = { elements: Array.isArray(r.elements) ? r.elements : [] };

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
    // even on unexpected errors, return structured response (client won't think "LIVE non disponibile" due to ok:false)
    return res.status(200).json({
      ok: true,
      data: { elements: [] },
      meta: {
        cat: normCat(req.query?.cat),
        radiusKm: clamp(asNum(req.query?.radiusKm) ?? 60, 5, 300),
        count: 0,
        fromCache: false,
        endpoint: "",
        elapsedMs: 0,
        notes: [`handler_error:${String(e?.message || e)}`],
      }
    });
  }
}
