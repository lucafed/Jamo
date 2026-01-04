// /api/destinations.js — Jamo LIVE destinations (Overpass) — v3.1 (FIXED)
// - Tiered queries per category (CORE -> SECONDARY -> FALLBACK)
// - FAMILY fixed: no more generic tourism=attraction in CORE (was causing random results)
// - Added missing categories support + alias mapping (theme_park, kids_museum, viewpoints, hiking, spa/history/nature/sea/city/mountain)
// - Safer "parks fallback" (kept filtered) + better family fallback keywords
// - Partial-results mode: if one query fails, still return what we got
// - Endpoint fallback + per-query timeout
// Returns: { ok:true, data:{elements:[...]}, meta:{cat,radiusKm,count,fromCache,endpoint,elapsedMs,notes:[] } }

const TTL_MS = 1000 * 60 * 15; // 15 min cache
const cache = new Map(); // key -> { ts, data, endpoint }

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

function now() {
  return Date.now();
}
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function asNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * Category normalization with aliases.
 * Keep internal keys stable because cacheKey depends on cat string.
 */
function normCat(c) {
  const s = String(c || "ovunque").toLowerCase().trim();

  // Aliases (UI / future-proof)
  const alias = new Map([
    // defaults
    ["*", "ovunque"],
    ["any", "ovunque"],
    ["anywhere", "ovunque"],
    ["all", "ovunque"],
    ["ovunque", "ovunque"],

    // family
    ["family", "family"],
    ["famiglia", "family"],
    ["famiglie", "family"],
    ["kids", "family"],

    // theme parks
    ["theme_park", "theme_park"],
    ["themepark", "theme_park"],
    ["parcodivertimenti", "theme_park"],
    ["divertimento", "theme_park"],

    // kids museums
    ["kids_museum", "kids_museum"],
    ["children_museum", "kids_museum"],
    ["museibambini", "kids_museum"],
    ["museobambini", "kids_museum"],

    // relax/spa
    ["relax", "relax"],
    ["spa", "relax"],
    ["wellness", "relax"],

    // nature
    ["natura", "natura"],
    ["nature", "natura"],
    ["outdoor", "natura"],

    // sea
    ["mare", "mare"],
    ["sea", "mare"],
    ["beach", "mare"],

    // history
    ["storia", "storia"],
    ["history", "storia"],
    ["cultura", "storia"],

    // borghi
    ["borghi", "borghi"],
    ["borgo", "borghi"],
    ["villages", "borghi"],

    // city
    ["citta", "citta"],
    ["città", "citta"],
    ["city", "citta"],
    ["town", "citta"],

    // mountain/hiking/viewpoints
    ["montagna", "montagna"],
    ["mountain", "montagna"],
    ["hiking", "hiking"],
    ["trekking", "hiking"],
    ["viewpoints", "viewpoints"],
    ["viewpoint", "viewpoints"],
    ["panorama", "viewpoints"],
  ]);

  const internal = alias.get(s) || (alias.has("*") ? alias.get("*") : "ovunque");
  const allowed = new Set([
    "ovunque",
    "family",
    "theme_park",
    "kids_museum",
    "relax",
    "natura",
    "mare",
    "storia",
    "borghi",
    "citta",
    "montagna",
    "hiking",
    "viewpoints",
  ]);

  return allowed.has(internal) ? internal : "ovunque";
}

function cacheKey({ lat, lon, radiusKm, cat }) {
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
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        ...headers,
      },
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

/**
 * Build tiered queries:
 * - CORE: what the category promises (true attractions)
 * - SECONDARY: still relevant but wider
 * - FALLBACK: only if needed, filtered (avoid generic parks)
 */
function buildTieredQueries(cat, radiusM, lat, lon) {
  const A = around(radiusM, lat, lon);

  // Filtered parks only (avoid tiny city parks)
  const FALLBACK_PARKS = `
[out:json][timeout:12];
(
  node[leisure=park]["tourism"="attraction"](${A});
  node[leisure=park]["name"~"avventura|faunistico|safari|botanico|giardino botanico|parco naturale|riserva|cascat(a|e)|gola|canyon",i](${A});
  way[leisure=park]["name"~"avventura|faunistico|safari|botanico|giardino botanico|parco naturale|riserva|cascat(a|e)|gola|canyon",i](${A});
);
out tags center 350;
  `.trim();

  // Common: viewpoints / scenic
  const VIEWPOINTS = `
[out:json][timeout:12];
(
  node[tourism=viewpoint](${A});
  node["name"~"belvedere|panoram(a|ico)|viewpoint|scenic",i](${A});
);
out tags center 450;
  `.trim();

  // ---------------- RELAX ----------------
  if (cat === "relax") {
    const CORE = `
[out:json][timeout:12];
(
  node[amenity=spa](${A});
  node[leisure=spa](${A});
  node[natural=hot_spring](${A});
  node[amenity=public_bath](${A});
  node["sauna"="yes"](${A});
  node["thermal"="yes"](${A});
  node["name"~"terme|spa|thermal|benessere",i](${A});
);
out tags center 650;
    `.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  node[leisure=swimming_pool](${A});
  node[amenity=swimming_pool](${A});
  node["sport"="swimming"](${A});
  node["tourism"="resort"](${A});
  node["tourism"="hotel"]["spa"="yes"](${A});
  ${VIEWPOINTS.replace("[out:json][timeout:12];", "")}
);
out tags center 450;
    `.trim();

    const FALLBACK = `
[out:json][timeout:12];
(
  ${VIEWPOINTS.replace("[out:json][timeout:12];", "")}
  node[natural=waterfall](${A});
  node[natural=spring](${A});
);
out tags center 350;
    `.trim();

    return [CORE, SECONDARY, FALLBACK];
  }

  // ---------------- THEME PARK ----------------
  // (specific: amusement/water/zoo/aquarium/adventure parks)
  if (cat === "theme_park") {
    const CORE = `
[out:json][timeout:12];
(
  node[tourism=theme_park](${A});
  way[tourism=theme_park](${A});
  node[leisure=water_park](${A});
  way[leisure=water_park](${A});
  node[tourism=zoo](${A});
  way[tourism=zoo](${A});
  node[tourism=aquarium](${A});
  node[amenity=aquarium](${A});
  node["name"~"parco divertimenti|theme\\s?park|amusement\\s?park|parco acquatico|acquapark|aqua\\s?park|water\\s?park|luna\\s?park|lunapark|zoo|acquario|aquarium|giostre|safari|faunistico",i](${A});
);
out tags center 800;
    `.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  node[leisure=playground](${A});
  way[leisure=playground](${A});
  node[leisure=trampoline_park](${A});
  node["name"~"parco\\s?avventura|adventure\\s?park|zip\\s?line|zipline|fattoria|didattica|petting\\s?zoo",i](${A});
);
out tags center 450;
    `.trim();

    return [CORE, SECONDARY, FALLBACK_PARKS];
  }

  // ---------------- KIDS MUSEUM ----------------
  if (cat === "kids_museum") {
    const CORE = `
[out:json][timeout:12];
(
  node[tourism=museum]["name"~"bambin|kids|children|science\\s?center|planetari|interactive|interattiv",i](${A});
  way[tourism=museum]["name"~"bambin|kids|children|science\\s?center|planetari|interactive|interattiv",i](${A});
  node["name"~"museo\\s?dei\\s?bambini|children\\s?museum|science\\s?center|planetario|planetarium",i](${A});
);
out tags center 800;
    `.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  node[tourism=museum](${A});
  way[tourism=museum](${A});
);
out tags center 450;
    `.trim();

    return [CORE, SECONDARY];
  }

  // ---------------- FAMILY ----------------
  if (cat === "family") {
    // CORE: real family attractions ONLY (no generic tourism=attraction here)
    const CORE = `
[out:json][timeout:12];
(
  node[tourism=theme_park](${A});
  way[tourism=theme_park](${A});
  node[leisure=water_park](${A});
  way[leisure=water_park](${A});
  node[tourism=zoo](${A});
  way[tourism=zoo](${A});
  node[tourism=aquarium](${A});
  node[amenity=aquarium](${A});

  node[leisure=playground](${A});
  way[leisure=playground](${A});
  node[leisure=trampoline_park](${A});

  node[tourism=museum]["name"~"bambin|kids|children|science\\s?center|planetari|interactive|interattiv",i](${A});
  node["name"~"museo\\s?dei\\s?bambini|children\\s?museum|science\\s?center|planetario|planetarium",i](${A});

  node["name"~"parco divertimenti|theme\\s?park|amusement\\s?park|parco acquatico|acquapark|aqua\\s?park|water\\s?park|luna\\s?park|lunapark|zoo|acquario|aquarium|giostre|parco\\s?giochi|area\\s?giochi|gonfiabil|trampolin",i](${A});
);
out tags center 900;
    `.trim();

    // SECONDARY: good-but-wider, still filtered by name/intent
    const SECONDARY = `
[out:json][timeout:12];
(
  node["tourism"="information"]["information"="visitor_centre"](${A});
  node["name"~"parco\\s?avventura|adventure\\s?park|zip\\s?line|zipline|fattoria|didattica|petting\\s?zoo|safari|faunistico",i](${A});
  node[amenity=cinema](${A});
  node[amenity=bowling_alley](${A});

  // tourism=attraction ONLY if name suggests family/kids
  node[tourism=attraction]["name"~"family|famigl|bambin|kids|children|parco\\s?giochi|playground|zoo|acquario|aquarium|lunapark|luna\\s?park|giostre|acquapark|water\\s?park|science\\s?center|planetari",i](${A});
);
out tags center 550;
    `.trim();

    // FALLBACK: pools/spa (still family-friendly)
    const FALLBACK = `
[out:json][timeout:12];
(
  node[leisure=swimming_pool](${A});
  node[amenity=swimming_pool](${A});
  node[amenity=spa](${A});
  node[natural=hot_spring](${A});
);
out tags center 450;
    `.trim();

    // LAST RESORT: filtered parks (no generic "park" spam)
    return [CORE, SECONDARY, FALLBACK, FALLBACK_PARKS];
  }

  // ---------------- MARE ----------------
  if (cat === "mare") {
    const CORE = `
[out:json][timeout:12];
(
  node[natural=beach](${A});
  way[natural=beach](${A});
  node[leisure=marina](${A});
  node["name"~"spiaggia|lido|baia|mare",i](${A});
);
out tags center 900;
    `.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  ${VIEWPOINTS.replace("[out:json][timeout:12];", "")}
  node[amenity=restaurant]["name"~"lido|spiaggia|mare",i](${A});
);
out tags center 350;
    `.trim();

    return [CORE, SECONDARY];
  }

  // ---------------- NATURA ----------------
  if (cat === "natura") {
    const CORE = `
[out:json][timeout:12];
(
  node[natural=waterfall](${A});
  node[natural=spring](${A});
  node[natural=wood](${A});
  node[leisure=nature_reserve](${A});
  way[leisure=nature_reserve](${A});
  node[boundary=national_park](${A});
  way[boundary=national_park](${A});
  node["name"~"cascata|lago|gola|riserva|parco naturale|sentiero|eremo",i](${A});
);
out tags center 900;
    `.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  ${VIEWPOINTS.replace("[out:json][timeout:12];", "")}
  node["tourism"="attraction"]["name"~"cascata|lago|gola|panoram|belvedere",i](${A});
);
out tags center 450;
    `.trim();

    return [CORE, SECONDARY, FALLBACK_PARKS];
  }

  // ---------------- STORIA ----------------
  if (cat === "storia") {
    const CORE = `
[out:json][timeout:12];
(
  node[historic=castle](${A});
  way[historic=castle](${A});
  node[historic=ruins](${A});
  node[historic=archaeological_site](${A});
  node[tourism=museum](${A});
  way[tourism=museum](${A});
  node[historic=monument](${A});
  node[historic=memorial](${A});
  node["name"~"castello|rocca|forte|abbazia|museo|anfiteatro|tempio|scavi|necropol|eremo",i](${A});
);
out tags center 950;
    `.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  node["tourism"="attraction"]["historic"](${A});
  node["name"~"centro\\s?storico|citta\\s?vecchia|borgo\\s?antico",i](${A});
);
out tags center 450;
    `.trim();

    return [CORE, SECONDARY];
  }

  // ---------------- BORGHI ----------------
  if (cat === "borghi") {
    const CORE = `
[out:json][timeout:12];
(
  node[place=village](${A});
  node[place=hamlet](${A});
  node["name"~"borgo|castel|rocca|monte|san\\s",i](${A});
  node["name"~"centro\\s?storico|borgo\\s?antico",i](${A});
);
out tags center 800;
    `.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  node[historic=castle](${A});
  node[tourism=viewpoint](${A});
);
out tags center 300;
    `.trim();

    return [CORE, SECONDARY];
  }

  // ---------------- CITTA ----------------
  if (cat === "citta") {
    const CORE = `
[out:json][timeout:12];
(
  node[place=city](${A});
  node[place=town](${A});
  node["name"~"centro|piazza|duomo",i](${A});
  node[tourism=attraction](${A});
);
out tags center 800;
    `.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  node[tourism=museum](${A});
  way[tourism=museum](${A});
  node[historic=monument](${A});
);
out tags center 350;
    `.trim();

    return [CORE, SECONDARY];
  }

  // ---------------- HIKING ----------------
  if (cat === "hiking") {
    const CORE = `
[out:json][timeout:12];
(
  node[natural=peak](${A});
  node["name"~"trek|trekking|hike|hiking|sentiero|trail|via\\s?ferrata|ferrata|rifugio|cima|vetta",i](${A});
  node[amenity=shelter](${A});
  node[tourism=alpine_hut](${A});
);
out tags center 900;
    `.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  node[tourism=viewpoint](${A});
);
out tags center 300;
    `.trim();

    return [CORE, SECONDARY];
  }

  // ---------------- VIEWPOINTS ----------------
  if (cat === "viewpoints") {
    const CORE = VIEWPOINTS;
    const SECONDARY = `
[out:json][timeout:12];
(
  node[natural=peak](${A});
  node["name"~"panoram|belvedere|viewpoint|scenic",i](${A});
);
out tags center 450;
    `.trim();
    return [CORE, SECONDARY];
  }

  // ---------------- MONTAGNA ----------------
  if (cat === "montagna") {
    const CORE = `
[out:json][timeout:12];
(
  node[natural=peak](${A});
  node["name"~"monte|cima|passo|rifugio",i](${A});
  node[tourism=viewpoint](${A});
  node[amenity=shelter](${A});
  node[tourism=alpine_hut](${A});
);
out tags center 900;
    `.trim();

    return [CORE];
  }

  // ---------------- OVUNQUE ----------------
  const CORE = `
[out:json][timeout:12];
(
  node[tourism=attraction](${A});
  node[tourism=viewpoint](${A});
  node[tourism=museum](${A});
  way[tourism=museum](${A});
  node[historic=castle](${A});
  node[natural=waterfall](${A});
  node[natural=beach](${A});
  node[amenity=spa](${A});
  node["name"~"castello|rocca|museo|cascata|lago|terme|spa|spiaggia|belvedere|panorama",i](${A});
);
out tags center 1100;
  `.trim();

  return [CORE, FALLBACK_PARKS];
}

/**
 * Run tiered queries with endpoint fallback + partial-results mode.
 */
async function runTiered(queries, { softEnough = 80 } = {}) {
  const notes = [];
  const started = now();

  for (const endpoint of OVERPASS_ENDPOINTS) {
    const results = [];
    let failed = 0;

    try {
      for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        try {
          const j = await fetchWithTimeout(endpoint, { method: "POST", body: overpassBody(q) }, 15000);
          results.push(j);
        } catch (e) {
          failed++;
          notes.push(`q_fail_${i}:${String(e?.message || e)}`);
          // continue: keep partial results
        }

        // early stop if enough elements (only within CORE/SECONDARY to keep relevance high)
        const mergedSoFar = mergeElements(results);
        if (mergedSoFar.length >= softEnough && i <= 1) {
          return {
            ok: true,
            endpoint,
            elements: mergedSoFar,
            elapsedMs: now() - started,
            notes: notes.concat([`early_stop_at_${i}`]),
          };
        }
      }

      const elements = mergeElements(results);

      if (elements.length > 0) {
        return {
          ok: true,
          endpoint,
          elements,
          elapsedMs: now() - started,
          notes: notes.concat([`partial_ok_failed:${failed}`]),
        };
      }

      notes.push(`endpoint_empty_failed:${failed}`);
      continue;
    } catch (e) {
      notes.push(`endpoint_crash:${String(e?.message || e)}`);
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
        },
      });
    }

    const queries = buildTieredQueries(cat, radiusM, lat, lon);

    // tuning per category
    const softEnough =
      cat === "family" ? 120 :
      cat === "theme_park" ? 90 :
      cat === "kids_museum" ? 60 :
      cat === "ovunque" ? 120 :
      cat === "relax" ? 80 :
      cat === "mare" ? 70 :
      cat === "storia" ? 90 :
      cat === "natura" ? 90 :
      cat === "viewpoints" ? 70 :
      cat === "hiking" ? 80 :
      80;

    const r = await runTiered(queries, { softEnough });

    const data = { elements: r.elements || [] };

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
      },
    });
  } catch (e) {
    // Keep 200 to avoid breaking clients, but signal ok:false
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
      }
