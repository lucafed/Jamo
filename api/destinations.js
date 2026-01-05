// /api/destinations.js — Jamo LIVE destinations (Overpass) — v3.1.1 FIXED
// - Tiered queries per category (CORE -> SECONDARY -> FALLBACK)
// - Avoid "parks everywhere" (parks only as fallback and filtered)
// - Partial-results mode: if one query fails, still return what we got
// - Endpoint fallback + per-query timeout
// - Extended categories: theme_park, kids_museum, viewpoints, hiking
// - Server-side fallback to "ovunque" if category returns empty
//
// Returns: { ok:true, data:{elements:[...]}, meta:{requestedCat,usedCat,radiusKm,count,fromCache,endpoint,elapsedMs,notes:[] } }

const TTL_MS = 1000 * 60 * 15; // 15 min cache
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
  const allowed = new Set([
    "ovunque","family","relax","natura","storia","mare","borghi","citta","montagna",
    "theme_park","kids_museum","viewpoints","hiking"
  ]);
  return allowed.has(s) ? s : "ovunque";
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

function buildTieredQueries(cat, radiusM, lat, lon) {
  const A = around(radiusM, lat, lon);

  const FALLBACK_PARKS = `
[out:json][timeout:12];
(
  node[leisure=park]["tourism"="attraction"](${A});
  node[leisure=park]["name"~"avventura|faunistico|safari|botanico|giardino|parco naturale|riserva|lag(o|hi)|cascat(a|e)",i](${A});
  way[leisure=park]["name"~"avventura|faunistico|safari|botanico|giardino|parco naturale|riserva|lag(o|hi)|cascat(a|e)",i](${A});
);
out tags center 350;
  `.trim();

  // ---------------- THEME PARK ----------------
  if (cat === "theme_park") {
    const CORE = `
[out:json][timeout:12];
(
  node[tourism=theme_park](${A});
  way[tourism=theme_park](${A});
  node[leisure=water_park](${A});
  way[leisure=water_park](${A});
  node[leisure=amusement_arcade](${A});
  node["name"~"parco divertimenti|lunapark|luna\\s?park|parco acquatico|acquapark|aqua\\s?park|water\\s?park|giostre",i](${A});
);
out tags center 650;
    `.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  node[tourism=attraction]["name"~"parco divertimenti|lunapark|giostre|water\\s?park|acquapark|aqua\\s?park",i](${A});
  node[tourism=attraction][leisure=water_park](${A});
);
out tags center 350;
    `.trim();

    return [CORE, SECONDARY];
  }

  // ---------------- KIDS MUSEUM ----------------
  if (cat === "kids_museum") {
    const CORE = `
[out:json][timeout:12];
(
  node[tourism=museum]["name"~"bambin|kids|children|ragazz|interattiv|science|planetari|museo dei bambini|children\\s?museum|science\\s?center",i](${A});
  node["name"~"museo dei bambini|children\\s?museum|science\\s?center|planetari|planetarium",i](${A});
);
out tags center 650;
    `.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  node[tourism=museum](${A});
);
out tags center 350;
    `.trim();

    return [CORE, SECONDARY];
  }

  // ---------------- VIEWPOINTS ----------------
  if (cat === "viewpoints") {
    const CORE = `
[out:json][timeout:12];
(
  node[tourism=viewpoint](${A});
  node["name"~"belvedere|panoram|viewpoint|scenic|terrazza|vista",i](${A});
);
out tags center 700;
    `.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  node["tourism"="attraction"]["name"~"panoram|belvedere|vista",i](${A});
  node[natural=peak](${A});
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
  node[information=guidepost](${A});
  node[amenity=shelter](${A});
  node["name"~"sentiero|trail|trek|trekking|hike|hiking|via\\s?ferrata|rifugio|anello",i](${A});
);
out tags center 700;
    `.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  node[natural=peak](${A});
  node[tourism=viewpoint](${A});
);
out tags center 350;
    `.trim();

    return [CORE, SECONDARY];
  }

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
out tags center 450;
    `.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  node[leisure=swimming_pool](${A});
  node[amenity=swimming_pool](${A});
  node["sport"="swimming"](${A});
  node["tourism"="resort"](${A});
  node["tourism"="hotel"]["spa"="yes"](${A});
  node[tourism=viewpoint](${A});
  node[leisure=picnic_table](${A});
);
out tags center 350;
    `.trim();

    const FALLBACK = `
[out:json][timeout:12];
(
  node[tourism=viewpoint](${A});
  node[natural=waterfall](${A});
  node[natural=spring](${A});
);
out tags center 250;
    `.trim();

    return [CORE, SECONDARY, FALLBACK];
  }

  // ---------------- FAMILY ----------------
  if (cat === "family") {
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
  node[tourism=attraction](${A});
  node[leisure=amusement_arcade](${A});
  node["name"~"parco divertimenti|parco acquatico|acquapark|aqua\\s?park|water\\s?park|luna\\s?park|zoo|acquario|giostre|funivia|museo dei bambini|children\\s?museum|science\\s?center|planetari",i](${A});
);
out tags center 650;
    `.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  node[leisure=playground](${A});
  way[leisure=playground](${A});
  node[leisure=trampoline_park](${A});
  node["name"~"parco\\s?giochi|area\\s?giochi|gonfiabil|trampolin|kids|bambin|family",i](${A});
  node["tourism"="information"]["information"="visitor_centre"](${A});
  node["name"~"parco\\s?avventura|avventura|fattoria|didattica|safari|faunistico",i](${A});
  node[amenity=cinema](${A});
  node[amenity=bowling_alley](${A});
);
out tags center 450;
    `.trim();

    const FALLBACK = `
[out:json][timeout:12];
(
  node[amenity=spa](${A});
  node[natural=hot_spring](${A});
  node[leisure=swimming_pool](${A});
  node[amenity=swimming_pool](${A});
);
out tags center 300;
    `.trim();

    return [CORE, SECONDARY, FALLBACK, FALLBACK_PARKS];
  }

  // ---------------- MARE ----------------
  if (cat === "mare") {
    const CORE = `
[out:json][timeout:12];
(
  node[natural=beach](${A});
  way[natural=beach](${A});
  node["name"~"spiaggia|lido|baia|mare",i](${A});
  node[leisure=marina](${A});
);
out tags center 650;
    `.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  node[tourism=viewpoint](${A});
  node[amenity=restaurant]["name"~"lido|spiaggia|mare",i](${A});
);
out tags center 300;
    `.trim();

    return [CORE, SECONDARY];
  }

  // ---------------- NATURA ----------------
  if (cat === "natura") {
    const CORE = `
[out:json][timeout:12];
(
  node[natural=waterfall](${A});
  node[natural=peak](${A});
  node[natural=spring](${A});
  node[natural=wood](${A});
  node[leisure=nature_reserve](${A});
  way[leisure=nature_reserve](${A});
  node[boundary=national_park](${A});
  way[boundary=national_park](${A});
  node["name"~"cascata|lago|gola|riserva|parco naturale|sentiero|eremo",i](${A});
);
out tags center 750;
    `.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  node[tourism=viewpoint](${A});
  node["tourism"="attraction"]["name"~"cascata|lago|gola|panoram|belvedere",i](${A});
);
out tags center 350;
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
  node[historic=monument](${A});
  node[historic=memorial](${A});
  node["name"~"castello|rocca|forte|abbazia|museo|anfiteatro|tempio|scavi|necropol|eremo|centro\\s?storico",i](${A});
);
out tags center 800;
    `.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  node["tourism"="attraction"]["historic"](${A});
  node["name"~"centro\\s?storico|citta\\s?vecchia|borgo\\s?antico",i](${A});
);
out tags center 350;
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
);
out tags center 600;
    `.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  node["name"~"centro\\s?storico|borgo\\s?antico",i](${A});
);
out tags center 250;
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
out tags center 600;
    `.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  node[tourism=museum](${A});
  node[historic=monument](${A});
);
out tags center 300;
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
);
out tags center 650;
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
  node[historic=castle](${A});
  node[natural=waterfall](${A});
  node[natural=beach](${A});
  node[amenity=spa](${A});
  node["name"~"castello|rocca|museo|cascata|lago|terme|spa|spiaggia|belvedere|panorama|zoo|acquario|parco\\s?divertimenti|acquapark",i](${A});
);
out tags center 900;
  `.trim();

  return [CORE, FALLBACK_PARKS];
}

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
        }

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
  // Helpful headers (avoid edge/proxy caching)
  res.setHeader("Cache-Control", "no-store, max-age=0");

  try {
    const lat = asNum(req.query?.lat);
    const lon = asNum(req.query?.lon);
    const radiusKm = clamp(asNum(req.query?.radiusKm) ?? 60, 5, 300);
    const requestedCat = normCat(req.query?.cat);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ ok: false, error: "Missing lat/lon" });
    }

    const radiusM = Math.round(radiusKm * 1000);

    // cache (keyed by requestedCat, not usedCat — ok)
    const key = cacheKey({ lat, lon, radiusKm, cat: requestedCat });
    const hit = cache.get(key);
    if (hit && now() - hit.ts < TTL_MS) {
      return res.status(200).json({
        ok: true,
        data: hit.data,
        meta: {
          requestedCat,
          usedCat: requestedCat,
          radiusKm,
          count: hit.data?.elements?.length || 0,
          fromCache: true,
          endpoint: hit.endpoint || "",
          elapsedMs: 0,
          notes: ["cache_hit"],
        }
      });
    }

    const softEnough =
      requestedCat === "family" ? 120 :
      requestedCat === "theme_park" ? 90 :
      requestedCat === "ovunque" ? 120 :
      requestedCat === "relax" ? 90 :
      requestedCat === "mare" ? 60 :
      requestedCat === "storia" ? 80 :
      requestedCat === "kids_museum" ? 70 :
      requestedCat === "viewpoints" ? 90 :
      requestedCat === "hiking" ? 90 :
      80;

    // run requested category
    const queries = buildTieredQueries(requestedCat, radiusM, lat, lon);
    let r = await runTiered(queries, { softEnough });

    let notes = Array.isArray(r.notes) ? r.notes.slice() : [];
    let usedCat = requestedCat;

    // server-side fallback: if empty, retry "ovunque"
    if ((r.elements?.length || 0) === 0 && requestedCat !== "ovunque") {
      const q2 = buildTieredQueries("ovunque", radiusM, lat, lon);
      const r2 = await runTiered(q2, { softEnough: 120 });
      if ((r2.elements?.length || 0) > 0) {
        r = r2;
        usedCat = "ovunque";
        notes = notes.concat(["fallback_to_ovunque"]);
      } else {
        notes = notes.concat(["fallback_to_ovunque_empty"]);
      }
    }

    const data = { elements: r.elements || [] };

    cache.set(key, { ts: now(), data, endpoint: r.endpoint || "" });

    return res.status(200).json({
      ok: true,
      data,
      meta: {
        requestedCat,
        usedCat,
        radiusKm,
        count: data.elements.length,
        fromCache: false,
        endpoint: r.endpoint || "",
        elapsedMs: r.elapsedMs || 0,
        notes,
      }
    });

  } catch (e) {
    return res.status(200).json({
      ok: false,
      error: String(e?.message || e),
      meta: { count: 0, notes: ["handler_crash"] }
    });
  }
                }
