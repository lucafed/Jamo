// /api/geocode.js — Robust geocoding (OFFLINE index first, Nominatim fallback) — v2.2
// Supports:
//   GET  /api/geocode?q=...
//   POST /api/geocode { q: "..." }
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
  `Jamo/2.2 (Vercel; ${NOMINATIM_EMAIL || "no-email"})`;

// ---- helpers ----
function now() { return Date.now(); }

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
    .map(s => s.trim())
    .filter(Boolean);
  return parts.slice(0, 3).join(", ") || displayName || "";
}

// Normalizza country code per coerenza con dataset
// - Nominatim usa spesso GB, non UK
// - alcuni indici custom possono avere UK
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
    country_code: normalizeCountryCode(country_code)
  };
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

function offlineSearch(q) {
  loadIndexOnce();
  if (!INDEX || !NAME_MAP) return null;

  const nq = norm(q);
  if (!nq) return null;

  // 1) Exact match
  if (NAME_MAP.has(nq)) {
    const hits = NAME_MAP.get(nq) || [];
    const best = pickBestOffline(hits, q);
    if (best) return buildOfflineResponse(best, hits);
  }

  // 2) StartsWith / Contains match (limit)
  const places = INDEX.places;
  const maxScan = Math.min(places.length, 200000); // safety
  const starts = [];
  const contains = [];

  for (let i = 0; i < maxScan; i++) {
    const p = places[i];
    const pn = norm(p?.name);
    if (!pn) continue;

    if (pn.startsWith(nq)) starts.push(p);
    else if (pn.includes(nq)) contains.push(p);

    if (starts.length >= 8) break;
  }

  const hits = (starts.length ? starts : contains).slice(0, 8);
  if (!hits.length) return null;

  const best = pickBestOffline(hits, q);
  if (!best) return null;
  return buildOfflineResponse(best, hits);
}

function pickBestOffline(hits, qRaw) {
  // Heuristics:
  // - population helps to avoid random tiny places
  // - slight preference for exact name match
  let best = null;
  let bestScore = -1;

  const qn = norm(qRaw);

  for (const p of hits) {
    const lat = Number(p.lat);
    const lon = Number(p.lng ?? p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const pop = Number(p.population || 0);

    let s = Math.log10(Math.max(1000, pop));
    if (norm(p.name) === qn) s += 2;

    if (s > bestScore) {
      bestScore = s;
      best = p;
    }
  }
  return best;
}

function buildOfflineResponse(best, hits) {
  const cc = normalizeCountryCode(best.country || "");
  const result = okResult(
    `${best.name}${cc ? ", " + cc : ""}`,
    best.lat,
    best.lng ?? best.lon,
    cc
  );

  const candidates = hits
    .map(p => {
      const lat = Number(p.lat);
      const lon = Number(p.lng ?? p.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const pcc = normalizeCountryCode(p.country || "");
      return {
        label: `${p.name}${pcc ? ", " + pcc : ""}`,
        lat,
        lon,
        country_code: pcc
      };
    })
    .filter(Boolean)
    .slice(0, 5);

  return { ok: true, result, candidates, source: "offline_index" };
}

// ---- NOMINATIM fallback ----
async function nominatimSearch(q, req) {
  const base =
    "https://nominatim.openstreetmap.org/search" +
    `?format=jsonv2&limit=5&addressdetails=1&accept-language=it,en` +
    `&q=${encodeURIComponent(q)}` +
    (NOMINATIM_EMAIL ? `&email=${encodeURIComponent(NOMINATIM_EMAIL)}` : "");

  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";

  const r = await fetch(base, {
    headers: {
      "User-Agent": NOMINATIM_UA,
      "Accept": "application/json",
      "Referer": `${proto}://${host}/`
    }
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
    .map(x => ({
      label: shortLabel(x.display_name),
      lat: Number(x.lat),
      lon: Number(x.lon),
      country_code: normalizeCountryCode(x.address?.country_code || "")
    }))
    .filter(x => Number.isFinite(x.lat) && Number.isFinite(x.lon));

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
        ? (Array.isArray(req.query?.q) ? req.query.q[0] : req.query?.q)
        : (req.body?.q ?? req.body?.query);

    const q = cleanQ(qRaw);
    if (!q) return res.status(400).json({ ok: false, error: "Missing q" });

    const cacheKey = `v2.2:${q.toLowerCase()}`;
    const hit = cache.get(cacheKey);
    if (hit && now() - hit.ts < TTL_MS) {
      return res.status(200).json(hit.data);
    }

    // 1) Offline index
    const offline = offlineSearch(q);
    if (offline?.ok) {
      const data = {
        ok: true,
        result: offline.result,
        candidates: offline.candidates || [],
        source: offline.source || "offline_index"
      };
      cache.set(cacheKey, { ts: now(), data });
      return res.status(200).json(data);
    }

    // 2) Nominatim fallback
    const nom = await nominatimSearch(q, req);
    const data = nom.ok
      ? { ok: true, result: nom.result, candidates: nom.candidates || [], source: nom.source || "nominatim" }
      : { ok: false, error: nom.error || "Geocoding fallito", source: nom.source || "nominatim" };

    cache.set(cacheKey, { ts: now(), data });
    return res.status(200).json(data);

  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
