// /api/destinations.js — Jamo LIVE destinations (Overpass) — v3.1.3 FINAL
// ✅ FIX:
// - Query per categoria (non "tutti i node")
// - FAMILY: niente terme/spa/piscine come fallback (quelle sono RELAX)
// - Ritorna Overpass "elements" grezzi (compatibile con app.js che li mappa)
// - No fallback server-side a "ovunque" (rispetta la categoria scelta)
// - Endpoint fallback + timeout + cache

const TTL_MS = 1000 * 60 * 15; // 15 min
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
  const la = Math.round(lat * 100) / 100; // ~1km
  const lo = Math.round(lon * 100) / 100;
  const rk = Math.round(radiusKm);
  return `${cat}:${rk}:${la}:${lo}`;
}

function overpassBody(query) {
  return `data=${encodeURIComponent(query)}`;
}

async function fetchWithTimeout(url, { body, timeoutMs = 15000 } = {}) {
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

// ---------------- CATEGORY QUERIES (TIERED) ----------------
function buildTieredQueries(cat, radiusM, lat, lon) {
  const A = around(radiusM, lat, lon);

  // Nota: usiamo node/way/relation e out center (così way/relation hanno center)
  // e filtri solo POI rilevanti.

  if (cat === "family") {
    // ✅ NO terme/spa/piscine qui
    const CORE = `
[out:json][timeout:12];
(
  node[tourism=theme_park](${A});
  way[tourism=theme_park](${A});
  relation[tourism=theme_park](${A});

  node[leisure=water_park](${A});
  way[leisure=water_park](${A});
  relation[leisure=water_park](${A});

  node[tourism=zoo](${A});
  way[tourism=zoo](${A});
  relation[tourism=zoo](${A});

  node[tourism=aquarium](${A});
  way[tourism=aquarium](${A});
  relation[tourism=aquarium](${A});

  node[leisure=amusement_arcade](${A});
  node["name"~"parco\\s?divertimenti|lunapark|luna\\s?park|parco\\s?acquatico|acquapark|aqua\\s?park|water\\s?park|zoo|acquario|giostre|parco\\s?avventura|safari",i](${A});
);
out tags center 650;
`.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  node[leisure=playground](${A});
  way[leisure=playground](${A});
  relation[leisure=playground](${A});

  node[leisure=trampoline_park](${A});
  node["name"~"parco\\s?giochi|area\\s?giochi|trampolin|kids|bambin|family",i](${A});

  node[amenity=cinema](${A});
  node[amenity=bowling_alley](${A});
);
out tags center 450;
`.trim();

    return [CORE, SECONDARY];
  }

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
out tags center 550;
`.trim();

    const SECONDARY = `
[out:json][timeout:12];
(
  node[leisure=swimming_pool](${A});
  way[leisure=swimming_pool](${A});
  relation[leisure=swimming_pool](${A});
  node[tourism=hotel]["spa"="yes"](${A});
  node[tourism=resort](${A});
  node[tourism=viewpoint](${A});
);
out tags center 350;
`.trim();

    return [CORE, SECONDARY];
  }

  if (cat === "mare") {
    const CORE = `
[out:json][timeout:12];
(
  node[natural=beach](${A});
  way[natural=beach](${A});
  relation[natural=beach](${A});
  node[leisure=marina](${A});
  way[leisure=marina](${A});
  node["name"~"spiaggia|lido|baia|mare",i](${A});
);
out tags center 700;
`.trim();

    return [CORE];
  }

  if (cat === "natura") {
    const CORE = `
[out:json][timeout:12];
(
  node[natural=waterfall](${A});
  node[natural=peak](${A});
  node[natural=spring](${A});
  node[leisure=nature_reserve](${A});
  way[leisure=nature_reserve](${A});
  relation[leisure=nature_reserve](${A});
  way[boundary=national_park](${A});
  relation[boundary=national_park](${A});
  node[tourism=viewpoint](${A});
  node["name"~"cascata|lago|gola|riserva|parco\\s?naturale|sentiero|eremo",i](${A});
);
out tags center 750;
`.trim();

    return [CORE];
  }

  if (cat === "storia") {
    const CORE = `
[out:json][timeout:12];
(
  node[historic=castle](${A});
  way[historic=castle](${A});
  relation[historic=castle](${A});

  node[historic=ruins](${A});
  node[historic=archaeological_site](${A});
  node[historic=monument](${A});
  node[historic=memorial](${A});

  node[tourism=museum](${A});
  way[tourism=museum](${A});
  relation[tourism=museum](${A});

  node["name"~"castello|rocca|forte|abbazia|museo|anfiteatro|tempio|scavi|necropol|centro\\s?storico",i](${A});
);
out tags center 850;
`.trim();

    return [CORE];
  }

  if (cat === "borghi") {
    // ✅ borghi veri: place=village/hamlet + nomi tipo borgo/castel/rocca ecc.
    // (poi il client farà il ranking e scarterà città)
    const CORE = `
[out:json][timeout:12];
(
  node[place=village](${A});
  node[place=hamlet](${A});
  node["name"~"borgo|castel|rocca|san\\s|santa\\s|monte\\s|civit|poggio|villa\\s",i](${A});
  node[tourism=attraction]["name"~"centro\\s?storico|borgo\\s?antico",i](${A});
);
out tags center 650;
`.trim();

    return [CORE];
  }

  if (cat === "citta") {
    const CORE = `
[out:json][timeout:12];
(
  node[place=city](${A});
  node[place=town](${A});
  node[tourism=attraction](${A});
  node["name"~"centro|piazza|duomo|cathedral|old\\s?town",i](${A});
);
out tags center 650;
`.trim();

    return [CORE];
  }

  if (cat === "montagna") {
    // ✅ montagna vera: peak/viewpoint/rifugio/aerialway/ski/shelter
    const CORE = `
[out:json][timeout:12];
(
  node[natural=peak](${A});
  node[tourism=viewpoint](${A});
  node[aerialway](${A});
  node[amenity=shelter](${A});
  node["name"~"rifugio|cima|vetta|passo\\s|funivia|seggiovia|ski|pista",i](${A});
);
out tags center 750;
`.trim();

    return [CORE];
  }

  // OVUNQUE: solo POI “sensati”, non tutti i node
  const CORE = `
[out:json][timeout:12];
(
  node[tourism=attraction](${A});
  way[tourism=attraction](${A});
  relation[tourism=attraction](${A});

  node[tourism=viewpoint](${A});
  node[tourism=museum](${A});
  node[historic=castle](${A});
  node[natural=waterfall](${A});
  node[natural=beach](${A});
  node[amenity=spa](${A});

  node["name"~"castello|rocca|museo|cascata|lago|terme|spa|spiaggia|belvedere|panoram|zoo|acquario|parco\\s?divertimenti|acquapark",i](${A});
);
out tags center 900;
`.trim();

  return [CORE];
}

async function runTiered(queries, { softEnough = 120 } = {}) {
  const notes = [];
  const started = now();

  for (const endpoint of OVERPASS_ENDPOINTS) {
    const results = [];
    let failed = 0;

    try {
      for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        try {
          const j = await fetchWithTimeout(endpoint, { body: overpassBody(q), timeoutMs: 15000 });
          results.push(j);
        } catch (e) {
          failed++;
          notes.push(`q_fail_${i}:${String(e?.message || e)}`);
        }

        const mergedSoFar = mergeElements(results);
        if (mergedSoFar.length >= softEnough && i === 0) {
          return { ok: true, endpoint, elements: mergedSoFar, elapsedMs: now() - started, notes: notes.concat(["early_stop"]) };
        }
      }

      const elements = mergeElements(results);
      if (elements.length > 0) {
        return { ok: true, endpoint, elements, elapsedMs: now() - started, notes: notes.concat([`partial_ok_failed:${failed}`]) };
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

// ---------------- MAIN HANDLER ----------------
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  try {
    const lat = asNum(req.query?.lat);
    const lon = asNum(req.query?.lon);
    const radiusKm = clamp(asNum(req.query?.radiusKm) ?? 60, 5, 300);
    const requestedCat = normCat(req.query?.cat);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ ok: false, error: "Missing lat/lon" });
    }

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

    const radiusM = Math.round(radiusKm * 1000);

    const softEnough =
      requestedCat === "family" ? 120 :
      requestedCat === "ovunque" ? 120 :
      requestedCat === "storia" ? 90 :
      requestedCat === "natura" ? 90 :
      requestedCat === "montagna" ? 80 :
      requestedCat === "mare" ? 60 :
      requestedCat === "borghi" ? 80 :
      requestedCat === "citta" ? 90 :
      requestedCat === "relax" ? 90 :
      90;

    const queries = buildTieredQueries(requestedCat, radiusM, lat, lon);
    const r = await runTiered(queries, { softEnough });

    // ✅ NO fallback to ovunque here: rispettiamo la categoria
    const data = { elements: Array.isArray(r.elements) ? r.elements : [] };

    cache.set(key, { ts: now(), data, endpoint: r.endpoint || "" });

    return res.status(200).json({
      ok: true,
      data,
      meta: {
        requestedCat,
        usedCat: requestedCat,
        radiusKm,
        count: data.elements.length,
        fromCache: false,
        endpoint: r.endpoint || "",
        elapsedMs: r.elapsedMs || 0,
        notes: Array.isArray(r.notes) ? r.notes : [],
      }
    });

  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
