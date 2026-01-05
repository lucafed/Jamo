// /api/destinations.js — Jamo LIVE destinations (Overpass) — v3.2.0
// ✅ FIX v3.2:
// - Supporta nuove categorie UI: theme_park, kids_museum, viewpoints, hiking
// - FAMILY stagionale: estate -> acqua; inverno -> neve/ghiaccio + indoor kids
// - FAMILY: niente terme/spa/piscine (restano RELAX)
// - Ritorna Overpass "elements" grezzi (elements con tags + center)
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

function getSeason() {
  const m = new Date().getMonth() + 1;
  if (m === 11 || m === 12 || m === 1 || m === 2 || m === 3) return "winter";
  if (m === 6 || m === 7 || m === 8 || m === 9) return "summer";
  return "mid";
}

function normCat(c) {
  const s = String(c || "ovunque").toLowerCase().trim();
  // ✅ include nuove categorie UI
  const allowed = new Set([
    "ovunque",
    "family",
    "theme_park",
    "kids_museum",
    "viewpoints",
    "hiking",
    "relax",
    "natura",
    "storia",
    "mare",
    "borghi",
    "citta",
    "montagna",
  ]);
  return allowed.has(s) ? s : "ovunque";
}

function cacheKey({ lat, lon, radiusKm, cat, season }) {
  const la = Math.round(lat * 100) / 100; // ~1km
  const lo = Math.round(lon * 100) / 100;
  const rk = Math.round(radiusKm);
  return `${cat}:${season}:${rk}:${la}:${lo}`;
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
function buildTieredQueries(cat, radiusM, lat, lon, season) {
  const A = around(radiusM, lat, lon);

  // Nota: node/way/relation + out center -> way/relation hanno center
  // Manteniamo query "pulite": solo POI pertinenti.

  // ---- FAMILY (stagionale) ----
  if (cat === "family") {
    // CORE: sempre buoni per kids
    const CORE_ALWAYS = `
[out:json][timeout:12];
(
  node[tourism=theme_park](${A});
  way[tourism=theme_park](${A});
  relation[tourism=theme_park](${A});

  node[tourism=zoo](${A});
  way[tourism=zoo](${A});
  relation[tourism=zoo](${A});

  node[tourism=aquarium](${A});
  way[tourism=aquarium](${A});
  relation[tourism=aquarium](${A});

  node[leisure=playground](${A});
  way[leisure=playground](${A});
  relation[leisure=playground](${A});

  node[leisure=trampoline_park](${A});
  way[leisure=trampoline_park](${A});
  relation[leisure=trampoline_park](${A});

  node[tourism=museum]["museum"="children"](${A});
  way[tourism=museum]["museum"="children"](${A});
  relation[tourism=museum]["museum"="children"](${A});

  node["name"~"parco\\s?divertimenti|lunapark|luna\\s?park|zoo|acquario|giostre|kids|bambin|family|museo\\s+dei\\s+bambini|children\\s+museum",i](${A});
);
out tags center 650;
`.trim();

    // ESTATE: acqua + outdoor
    const CORE_SUMMER = `
[out:json][timeout:12];
(
  node[leisure=water_park](${A});
  way[leisure=water_park](${A});
  relation[leisure=water_park](${A});

  node["name"~"acquapark|aqua\\s?park|water\\s?park|parco\\s?acquatico",i](${A});
);
out tags center 650;
`.trim();

    // INVERNO: neve/ghiaccio + indoor kids
    const CORE_WINTER = `
[out:json][timeout:12];
(
  node[leisure=ice_rink](${A});
  way[leisure=ice_rink](${A});
  relation[leisure=ice_rink](${A});

  node[piste:type=downhill](${A});
  way[piste:type=downhill](${A});
  relation[piste:type=downhill](${A});

  node["sport"="skiing"](${A});
  way["sport"="skiing"](${A});

  node["name"~"snow\\s?park|pista\\s+slitt|slittin|bob\\s?track|pattin|ice\\s?rink|sci|ski",i](${A});

  node[tourism=museum](${A});
  way[tourism=museum](${A});
  relation[tourism=museum](${A});
);
out tags center 650;
`.trim();

    // SECONDARY: cinema/bowling/arcade (sempre kids-friendly)
    const SECONDARY = `
[out:json][timeout:12];
(
  node[leisure=amusement_arcade](${A});
  way[leisure=amusement_arcade](${A});
  relation[leisure=amusement_arcade](${A});

  node[amenity=cinema](${A});
  node[amenity=bowling_alley](${A});

  node["name"~"bowling|cinema|arcade|laser\\s?game|kart|mini\\s?golf",i](${A});
);
out tags center 450;
`.trim();

    const q = [CORE_ALWAYS];
    if (season === "summer") q.unshift(CORE_SUMMER);
    if (season === "winter") q.unshift(CORE_WINTER);
    q.push(SECONDARY);
    return q;
  }

  // ---- THEME PARK (solo parchi/giostre) ----
  if (cat === "theme_park") {
    const CORE = `
[out:json][timeout:12];
(
  node[tourism=theme_park](${A});
  way[tourism=theme_park](${A});
  relation[tourism=theme_park](${A});

  node[leisure=water_park](${A});
  way[leisure=water_park](${A});
  relation[leisure=water_park](${A});

  node["name"~"parco\\s?divertimenti|lunapark|luna\\s?park|giostre|acquapark|aqua\\s?park|water\\s?park|parco\\s?acquatico",i](${A});
);
out tags center 650;
`.trim();
    return [CORE];
  }

  // ---- KIDS MUSEUM (musei/science center kids) ----
  if (cat === "kids_museum") {
    const CORE = `
[out:json][timeout:12];
(
  node[tourism=museum]["museum"="children"](${A});
  way[tourism=museum]["museum"="children"](${A});
  relation[tourism=museum]["museum"="children"](${A});

  node["name"~"museo\\s+dei\\s+bambini|children\\s+museum|science\\s+center|planetari|planetarium",i](${A});
  node[amenity=planetarium](${A});
  way[amenity=planetarium](${A});
);
out tags center 650;
`.trim();
    return [CORE];
  }

  // ---- VIEWPOINTS ----
  if (cat === "viewpoints") {
    const CORE = `
[out:json][timeout:12];
(
  node[tourism=viewpoint](${A});
  way[tourism=viewpoint](${A});
  relation[tourism=viewpoint](${A});

  node["name"~"belvedere|panoram|viewpoint|scenic|terrazza",i](${A});
);
out tags center 650;
`.trim();
    return [CORE];
  }

  // ---- HIKING ----
  if (cat === "hiking") {
    const CORE = `
[out:json][timeout:12];
(
  node[information=guidepost](${A});
  node[amenity=shelter](${A});
  node[route=hiking](${A});
  way[route=hiking](${A});
  relation[route=hiking](${A});

  node["name"~"sentiero|trail|trek|trekking|via\\s+ferrata|rifugio",i](${A});
);
out tags center 650;
`.trim();
    return [CORE];
  }

  // ---- RELAX ----
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

  // ---- MARE ----
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

  // ---- NATURA ----
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

  // ---- STORIA ----
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

  // ---- BORGHI ----
  if (cat === "borghi") {
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

  // ---- CITTA ----
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

  // ---- MONTAGNA ----
  if (cat === "montagna") {
    const CORE = `
[out:json][timeout:12];
(
  node[natural=peak](${A});
  node[tourism=viewpoint](${A});
  node[aerialway](${A});
  node[amenity=shelter](${A});
  node[piste:type=downhill](${A});
  way[piste:type=downhill](${A});
  relation[piste:type=downhill](${A});
  node["name"~"rifugio|cima|vetta|passo\\s|funivia|seggiovia|ski|pista|slitt",i](${A});
);
out tags center 750;
`.trim();
    return [CORE];
  }

  // ---- OVUNQUE: POI sensati ----
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
    const season = getSeason(); // ✅ auto

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ ok: false, error: "Missing lat/lon" });
    }

    const key = cacheKey({ lat, lon, radiusKm, cat: requestedCat, season });
    const hit = cache.get(key);
    if (hit && now() - hit.ts < TTL_MS) {
      return res.status(200).json({
        ok: true,
        data: hit.data,
        meta: {
          requestedCat,
          usedCat: requestedCat,
          season,
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
      requestedCat === "theme_park" ? 90 :
      requestedCat === "kids_museum" ? 70 :
      requestedCat === "viewpoints" ? 80 :
      requestedCat === "hiking" ? 90 :
      requestedCat === "ovunque" ? 120 :
      requestedCat === "storia" ? 90 :
      requestedCat === "natura" ? 90 :
      requestedCat === "montagna" ? 80 :
      requestedCat === "mare" ? 60 :
      requestedCat === "borghi" ? 80 :
      requestedCat === "citta" ? 90 :
      requestedCat === "relax" ? 90 :
      90;

    const queries = buildTieredQueries(requestedCat, radiusM, lat, lon, season);
    const r = await runTiered(queries, { softEnough });

    // ✅ NO fallback to ovunque: rispettiamo la categoria
    const data = { elements: Array.isArray(r.elements) ? r.elements : [] };

    cache.set(key, { ts: now(), data, endpoint: r.endpoint || "" });

    return res.status(200).json({
      ok: true,
      data,
      meta: {
        requestedCat,
        usedCat: requestedCat,
        season,
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
