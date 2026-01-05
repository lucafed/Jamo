// /api/destinations.js — Jamo LIVE destinations (Overpass) — v3.2 FAST
// Obiettivo: stessa qualità ma MOLTO più veloce
// Fix:
// - ✅ 1 sola query per categoria (niente "SECONDARY" che rallenta)
// - ✅ timeout 10s
// - ✅ early stop: appena trovi abbastanza elementi
// - ✅ cache 30 min

const TTL_MS = 1000 * 60 * 30; // 30 min
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

async function fetchWithTimeout(url, { body, timeoutMs = 10000 } = {}) {
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

function mergeElements(j) {
  const els = Array.isArray(j?.elements) ? j.elements : [];
  const seen = new Set();
  const out = [];
  for (const el of els) {
    const key = `${el.type}:${el.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(el);
  }
  return out;
}

// ---------------- CATEGORY QUERIES (FAST: SINGLE) ----------------
function buildQuery(cat, radiusM, lat, lon) {
  const A = around(radiusM, lat, lon);

  // Nota: nwr + out center per way/relation
  // Family: includiamo anche neve/ski in modo leggero (winter)
  if (cat === "family") {
    return `
[out:json][timeout:10];
(
  nwr[tourism=theme_park](${A});
  nwr[leisure=water_park](${A});
  nwr[tourism=zoo](${A});
  nwr[tourism=aquarium](${A});
  nwr[leisure=playground]["name"](${A});

  // winter-ish / kids on snow/ice (solo nodi con name o tag chiave)
  node[leisure=ice_rink](${A});
  node[aerialway](${A});
  node["name"~"ski|sci|neve|slitt|pattin",i](${A});

  // keyword catch (pochi, ma utili)
  node["name"~"parco\\s?divertimenti|lunapark|luna\\s?park|parco\\s?acquatico|acquapark|aqua\\s?park|water\\s?park|zoo|acquario|giostre|parco\\s?avventura|safari|kids|bambin",i](${A});
);
out tags center 550;
`.trim();
  }

  if (cat === "relax") {
    return `
[out:json][timeout:10];
(
  node[amenity=spa](${A});
  node[leisure=spa](${A});
  node[natural=hot_spring](${A});
  node[amenity=public_bath](${A});
  node["name"~"terme|spa|thermal|benessere",i](${A});
);
out tags center 550;
`.trim();
  }

  if (cat === "mare") {
    return `
[out:json][timeout:10];
(
  nwr[natural=beach](${A});
  nwr[leisure=marina](${A});
  node["name"~"spiaggia|lido|baia|mare",i](${A});
);
out tags center 650;
`.trim();
  }

  if (cat === "natura") {
    return `
[out:json][timeout:10];
(
  node[natural=waterfall](${A});
  node[natural=peak](${A});
  nwr[leisure=nature_reserve](${A});
  nwr[boundary=national_park](${A});
  node[tourism=viewpoint](${A});
  node["name"~"cascata|lago|gola|riserva|parco\\s?naturale|sentiero|eremo",i](${A});
);
out tags center 750;
`.trim();
  }

  if (cat === "storia") {
    return `
[out:json][timeout:10];
(
  nwr[historic=castle](${A});
  node[historic=ruins](${A});
  node[historic=archaeological_site](${A});
  nwr[tourism=museum](${A});
  node[historic=monument](${A});
  node["name"~"castello|rocca|forte|abbazia|museo|anfiteatro|tempio|scavi|necropol|centro\\s?storico",i](${A});
);
out tags center 850;
`.trim();
  }

  if (cat === "borghi") {
    return `
[out:json][timeout:10];
(
  node[place=village](${A});
  node[place=hamlet](${A});
  node["name"~"borgo|castel|rocca|civit|poggio|villa\\s",i](${A});
);
out tags center 650;
`.trim();
  }

  if (cat === "citta") {
    return `
[out:json][timeout:10];
(
  node[place=city](${A});
  node[place=town](${A});
  node[tourism=attraction](${A});
  node["name"~"centro|piazza|duomo|cathedral|old\\s?town",i](${A});
);
out tags center 650;
`.trim();
  }

  if (cat === "montagna") {
    return `
[out:json][timeout:10];
(
  node[natural=peak](${A});
  node[tourism=viewpoint](${A});
  node[aerialway](${A});
  node[amenity=shelter](${A});
  node["name"~"rifugio|cima|vetta|passo\\s|funivia|seggiovia|ski|pista",i](${A});
);
out tags center 750;
`.trim();
  }

  // ovunque "sensato"
  return `
[out:json][timeout:10];
(
  nwr[tourism=attraction](${A});
  node[tourism=viewpoint](${A});
  node[tourism=museum](${A});
  node[historic=castle](${A});
  node[natural=waterfall](${A});
  node[natural=beach](${A});
  node["name"~"castello|rocca|museo|cascata|lago|spiaggia|belvedere|panoram|zoo|acquario|parco\\s?divertimenti|acquapark",i](${A});
);
out tags center 900;
`.trim();
}

async function runFastOverpass(query, { softEnough = 80 } = {}) {
  const started = now();
  const notes = [];

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const j = await fetchWithTimeout(endpoint, { body: overpassBody(query), timeoutMs: 10000 });
      const elements = mergeElements(j);

      if (elements.length >= softEnough) {
        return { ok: true, endpoint, elements, elapsedMs: now() - started, notes: notes.concat(["early_ok"]) };
      }
      if (elements.length > 0) {
        return { ok: true, endpoint, elements, elapsedMs: now() - started, notes: notes.concat(["partial_ok"]) };
      }

      notes.push(`empty:${endpoint}`);
    } catch (e) {
      notes.push(`fail:${endpoint}:${String(e?.message || e)}`);
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
      requestedCat === "family" ? 70 :
      requestedCat === "ovunque" ? 80 :
      requestedCat === "storia" ? 60 :
      requestedCat === "natura" ? 60 :
      requestedCat === "montagna" ? 55 :
      requestedCat === "mare" ? 50 :
      requestedCat === "borghi" ? 55 :
      requestedCat === "citta" ? 60 :
      requestedCat === "relax" ? 60 :
      60;

    const query = buildQuery(requestedCat, radiusM, lat, lon);
    const r = await runFastOverpass(query, { softEnough });

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
