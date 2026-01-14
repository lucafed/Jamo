// /api/geocode.js — Robust geocoding (OFFLINE index first, Nominatim fallback) — v2.3
// Supports:
//   GET  /api/geocode?q=...&cc=IT        (cc opzionale = paese preferito)
//   POST /api/geocode { q: "...", cc:"IT" }
//
// Returns:
//   { ok:true, result:{ label, lat, lon, country_code }, candidates:[...], source:"offline_index|nominatim" }
//   { ok:false, error:"..." }

import fs from "fs";
import path from "path";

const TTL_MS = 1000 * 60 * 60 * 24; // 24h
const cache = new Map(); // key -> { ts, data }

// ---- CONFIG ----
const INDEX_PATH = path.join(process.cwd(), "public", "data", "places_index_eu_uk.json");

// Metti questa in ENV su Vercel: NOMINATIM_EMAIL="tuaemail@..."
const NOMINATIM_EMAIL = process.env.NOMINATIM_EMAIL || "";
const NOMINATIM_UA =
  process.env.NOMINATIM_UA ||
  `Jamo/2.3 (Vercel; ${NOMINATIM_EMAIL || "no-email"})`;

// ---- helpers ----
function now() {
  return Date.now();
}

function cleanQ(q) {
  return String(q || "").trim().replace(/\s+/g, " ");
}

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function shortLabel(displayName) {
  const parts = String(displayName || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.slice(0, 3).join(", ") || displayName || "";
}

// Normalizza country code per coerenza con dataset
// - Nominatim usa spesso GB, non UK
function normalizeCountryCode(cc) {
  const up = String(cc || "").toUpperCase().trim();
  if (!up) return "";
  if (up === "UK") return "GB";
  return up;
}

function okResult(label, lat, lon, country_code = "") {
  return {
    label: String(label || "").trim(),
    lat: Number(lat),
    lon: Number(lon),
    country_code: normalizeCountryCode(country_code),
  };
}

// ---- CITY-QUERY HEURISTIC (per evitare quartieri/POI come partenza) ----
function looksLikeCityQuery(q) {
  const n = norm(q);
  if (!n) return false;

  // parole che indicano POI / zone / indirizzi
  const bad = [
    "via",
    "viale",
    "piazza",
    "quartiere",
    "zona",
    "barriera",
    "frazione",
    "borgo",
    "localita",
    "stazione",
    "aeroporto",
    "uscita",
    "svincolo",
    "casello",
  ];

  if (bad.some((b) => n.includes(b))) return false;
  if (/\d/.test(n)) return false; // numeri = indirizzo
  if (n.split(" ").length > 2) return false;

  return true;
}

// ---- OFFLINE INDEX (cold-start cached in memory) ----
let INDEX = null; // { places: [...] }
let NAME_MAP = null; // Map(normName -> [place,...])

function loadIndexOnce() {
  if (INDEX && NAME_MAP) return;

  if (!fs.existsSync(INDEX_PATH)) {
    INDEX = null;
    NAME_MAP = null;
    return;
  }

  try {
    const raw = fs.readFileSync(INDEX_PATH, "utf8");
    const json = JSON.parse(raw);
    const places = Array.isArray(json?.places) ? json.places : [];
    INDEX = { places };

    const m = new Map();
    for (const p of places) {
      if (!p?.name) continue;
      const key = norm(p.name);
      if (!key) continue;
      const arr = m.get(key) || [];
      arr.push(p);
      m.set(key, arr);
    }
    NAME_MAP = m;
  } catch {
    INDEX = null;
    NAME_MAP = null;
  }
}

function offlineSearch(q, preferredCC = "", opts = {}) {
  loadIndexOnce();
  if (!INDEX || !NAME_MAP) return null;

  const nq = norm(q);
  if (!nq) return null;

  const forcePlaceType = Array.isArray(opts.forcePlaceType) ? opts.forcePlaceType : null;

  // 1) Exact match
  if (NAME_MAP.has(nq)) {
    const hits = NAME_MAP.get(nq) || [];
    const best = pickBestOffline(hits, q, preferredCC, forcePlaceType);
    if (best) return buildOfflineResponse(best, hits);
  }

  // 2) StartsWith / Contains match (limit)
  const places = INDEX.places;
  const maxScan = Math.min(places.length, 220000); // safety
  const starts = [];
  const contains = [];

  for (let i = 0; i < maxScan; i++) {
    const p = places[i];
    const pn = norm(p?.name);
    if (!pn) continue;

    if (pn.startsWith(nq)) starts.push(p);
    else if (pn.includes(nq)) contains.push(p);

    if (starts.length >= 14) break;
  }

  const hits = (starts.length ? starts : contains).slice(0, 14);
  if (!hits.length) return null;

  const best = pickBestOffline(hits, q, preferredCC, forcePlaceType);
  if (!best) return null;
  return buildOfflineResponse(best, hits);
}

function offlineScore(p, qRaw, preferredCC = "", forcePlaceType = null) {
  const lat = Number(p.lat);
  const lon = Number(p.lng ?? p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return -1e9;

  const qn = norm(qRaw);
  const pn = norm(p.name);

  const cc = normalizeCountryCode(p.country || "");
  const pref = normalizeCountryCode(preferredCC || "");

  // base: population (log)
  const pop = Number(p.population || 0);
  let s = Math.log10(Math.max(1000, pop)); // 3..7 tipico

  // exact match = grosso boost
  if (pn === qn) s += 3.2;

  // place type preference (se la query sembra città)
  if (forcePlaceType) {
    const pt = String(p.place || "").toLowerCase().trim(); // city|town|village|suburb|...
    if (forcePlaceType.includes(pt)) s += 2.2;
    else s -= 4.2; // quartieri/poi penalizzati forte
  }

  // preferisci country se fornito (cc=IT)
  if (pref && cc) {
    if (cc === pref) s += 1.4;
    else s -= 0.6;
  }

  // penalizza fortemente “suburb” quando stiamo cercando città
  const pt = String(p.place || "").toLowerCase().trim();
  if (forcePlaceType && pt === "suburb") s -= 2.0;

  return s;
}

function pickBestOffline(hits, qRaw, preferredCC = "", forcePlaceType = null) {
  let best = null;
  let bestScore = -1e9;

  for (const p of hits) {
    const s = offlineScore(p, qRaw, preferredCC, forcePlaceType);
    if (s > bestScore) {
      bestScore = s;
      best = p;
    }
  }

  // Attach score for later decisions (non esportato)
  if (best) best.__score = bestScore;
  return best;
}

function buildOfflineResponse(best, hits) {
  const cc = normalizeCountryCode(best.country || "");
  const result = okResult(`${best.name}${cc ? ", " + cc : ""}`, best.lat, best.lng ?? best.lon, cc);

  const candidates = hits
    .map((p) => {
      const lat = Number(p.lat);
      const lon = Number(p.lng ?? p.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const pcc = normalizeCountryCode(p.country || "");
      return {
        label: `${p.name}${pcc ? ", " + pcc : ""}`,
        lat,
        lon,
        country_code: pcc,
      };
    })
    .filter(Boolean)
    .slice(0, 5);

  return { ok: true, result, candidates, source: "offline_index", _bestScore: best.__score ?? null };
}

// ---- NOMINATIM fallback ----
async function nominatimSearch(q, req, preferredCC = "") {
  const pref = normalizeCountryCode(preferredCC || "");
  const countrycodes = pref ? `&countrycodes=${encodeURIComponent(pref.toLowerCase())}` : "";

  const base =
    "https://nominatim.openstreetmap.org/search" +
    `?format=jsonv2&limit=5&addressdetails=1&accept-language=it,en` +
    `${countrycodes}` +
    `&q=${encodeURIComponent(q)}` +
    (NOMINATIM_EMAIL ? `&email=${encodeURIComponent(NOMINATIM_EMAIL)}` : "");

  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";

  const r = await fetch(base, {
    headers: {
      "User-Agent": NOMINATIM_UA,
      Accept: "application/json",
      Referer: `${proto}://${host}/`,
    },
  });

  if (!r.ok) {
    return { ok: false, error: `Geocode upstream error (${r.status})`, source: "nominatim" };
  }

  const arr = await r.json().catch(() => null);
  if (!Array.isArray(arr) || arr.length === 0) {
    return { ok: false, error: "Nessun risultato trovato", source: "nominatim" };
  }

  const best = arr[0];

  const lat = Number(best.lat);
  const lon = Number(best.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ok: false, error: "Risultato senza coordinate valide", source: "nominatim" };
  }

  const cc = normalizeCountryCode(best.address?.country_code || "");
  const result = okResult(shortLabel(best.display_name), lat, lon, cc);

  const candidates = arr
    .slice(0, 5)
    .map((x) => ({
      label: shortLabel(x.display_name),
      lat: Number(x.lat),
      lon: Number(x.lon),
      country_code: normalizeCountryCode(x.address?.country_code || ""),
    }))
    .filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon));

  return { ok: true, result, candidates, source: "nominatim" };
}

// ---- handler ----
export default async function handler(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Use GET or POST" });
    }

    const qRaw =
      req.method === "GET"
        ? Array.isArray(req.query?.q)
          ? req.query.q[0]
          : req.query?.q
        : req.body?.q ?? req.body?.query;

    const ccRaw =
      req.method === "GET"
        ? Array.isArray(req.query?.cc)
          ? req.query.cc[0]
          : req.query?.cc
        : req.body?.cc;

    const q = cleanQ(qRaw);
    const preferredCC = normalizeCountryCode(ccRaw || "");

    if (!q) return res.status(400).json({ ok: false, error: "Missing q" });

    const cacheKey = `v2.3:${q.toLowerCase()}|cc:${preferredCC || "-"}`;
    const hit = cache.get(cacheKey);
    if (hit && now() - hit.ts < TTL_MS) {
      return res.status(200).json(hit.data);
    }

    // If the query looks like a city, force offline to prefer city/town (avoid suburbs/POIs)
    const forceCity = looksLikeCityQuery(q);
    const forcePlaceType = forceCity ? ["city", "town"] : null;

    // 1) Offline index
    const offline = offlineSearch(q, preferredCC, { forcePlaceType });

    // Safety: if "city query" but offline best is clearly not good enough, use Nominatim.
    // (evita casi tipo: prende un posto strano perché "Milano" non era presente come city)
    if (offline?.ok) {
      const bestScore = typeof offline._bestScore === "number" ? offline._bestScore : null;

      // soglia: se sembra città ma score troppo basso, meglio Nominatim
      const shouldNominatim =
        forceCity && (bestScore == null || bestScore < 4.2); // ~pop bassa / niente match / non city-town

      if (!shouldNominatim) {
        const data = {
          ok: true,
          result: offline.result,
          candidates: offline.candidates || [],
          source: offline.source || "offline_index",
        };
        cache.set(cacheKey, { ts: now(), data });
        return res.status(200).json(data);
      }
    }

    // 2) Nominatim fallback
    const nom = await nominatimSearch(q, req, preferredCC);
    const data = nom.ok
      ? { ok: true, result: nom.result, candidates: nom.candidates || [], source: nom.source || "nominatim" }
      : { ok: false, error: nom.error || "Geocoding fallito", source: nom.source || "nominatim" };

    cache.set(cacheKey, { ts: now(), data });
    return res.status(200).json(data);
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
