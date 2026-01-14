// /api/geocode.js — Robust geocoding (OFFLINE index first, Nominatim fallback) — v2.3
// Fixes: "Milano" -> Milanówek (PL) by:
//  - offline search uses Top-K scoring (no early stop after 8 startsWith)
//  - country preference IT-first when user didn't specify a country
//  - Nominatim: first try countrycodes=it, then global fallback
//
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
  `Jamo/2.3 (Vercel; ${NOMINATIM_EMAIL || "no-email"})`;

// Default preference (quando l'utente NON specifica paese)
const DEFAULT_PREFERRED_CC = "IT";

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

// Nominatim: usa spesso GB (non UK)
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

// ---- country parsing (simple but effective) ----
function detectExplicitCountry(q) {
  // Examples: "Milano, IT" / "London UK" / "Paris FR"
  const raw = String(q || "").trim();
  if (!raw) return "";

  const m = raw.match(/(?:,|\s)\s*([A-Za-z]{2})\s*$/);
  if (m && m[1]) {
    const cc = normalizeCountryCode(m[1]);
    if (cc.length === 2) return cc;
  }

  // Optional: country names (very small set, add if you want)
  const nq = norm(raw);
  if (nq.endsWith(" italia")) return "IT";
  if (nq.endsWith(" italy")) return "IT";
  if (nq.endsWith(" uk")) return "GB";
  if (nq.endsWith(" united kingdom")) return "GB";
  if (nq.endsWith(" inghilterra")) return "GB";

  return "";
}

function preferredCCFromReq(req, explicitCC) {
  if (explicitCC) return explicitCC;

  // Optional custom header (if someday you want to drive it from app.js)
  const h = String(req.headers["x-jamo-prefer-cc"] || "").toUpperCase().trim();
  if (h && h.length === 2) return normalizeCountryCode(h);

  return DEFAULT_PREFERRED_CC;
}

// ---- OFFLINE INDEX (cold-start cached in memory) ----
let INDEX = null;   // { places: [...] }
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

// scoring offline: population + exact match + preferred country bonus
function offlineScore(p, qn, preferredCC) {
  const pop = Number(p.population || 0);
  const cc = normalizeCountryCode(p.country || "");
  let s = Math.log10(Math.max(1000, pop)); // 3..7
  if (norm(p.name) === qn) s += 2.5;       // exact name strong
  if (preferredCC && cc === preferredCC) s += 2.0; // country preference
  return s;
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

function pickTopKOffline(places, qn, preferredCC, { maxScan = 250000, K = 18 } = {}) {
  const top = []; // array of {p, s}
  const limit = Math.min(places.length, maxScan);

  for (let i = 0; i < limit; i++) {
    const p = places[i];
    const name = p?.name;
    if (!name) continue;

    const pn = norm(name);
    if (!pn) continue;

    // match: startsWith OR includes
    const isStart = pn.startsWith(qn);
    const isContain = !isStart && pn.includes(qn);
    if (!isStart && !isContain) continue;

    const lat = Number(p.lat);
    const lon = Number(p.lng ?? p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    // small boost for startsWith
    let s = offlineScore(p, qn, preferredCC) + (isStart ? 0.7 : 0);

    // keep top K
    if (top.length < K) {
      top.push({ p, s });
      top.sort((a, b) => b.s - a.s);
    } else if (s > top[top.length - 1].s) {
      top[top.length - 1] = { p, s };
      top.sort((a, b) => b.s - a.s);
    }
  }

  return top.map(x => x.p);
}

function offlineSearch(q, preferredCC) {
  loadIndexOnce();
  if (!INDEX || !NAME_MAP) return null;

  const nq = norm(q);
  if (!nq) return null;

  // 1) Exact name match bucket (best possible)
  if (NAME_MAP.has(nq)) {
    const hits = NAME_MAP.get(nq) || [];
    // pick best among exacts using preferred country + population
    let best = null;
    let bestS = -1;
    for (const p of hits) {
      const lat = Number(p.lat);
      const lon = Number(p.lng ?? p.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const s = offlineScore(p, nq, preferredCC) + 1.2; // extra because exact bucket
      if (s > bestS) { bestS = s; best = p; }
    }
    if (best) return buildOfflineResponse(best, hits);
  }

  // 2) Top-K scan with scoring (NO early stop)
  const hits = pickTopKOffline(INDEX.places, nq, preferredCC, { maxScan: 250000, K: 18 });
  if (!hits.length) return null;

  // pick best again (already sorted high, but keep safe)
  let best = null;
  let bestS = -1;
  for (const p of hits) {
    const s = offlineScore(p, nq, preferredCC);
    if (s > bestS) { bestS = s; best = p; }
  }
  if (!best) return null;

  return buildOfflineResponse(best, hits);
}

// ---- NOMINATIM fallback (IT-first then global) ----
async function nominatimRequest(q, req, { countrycodes = "" } = {}) {
  const base =
    "https://nominatim.openstreetmap.org/search" +
    `?format=jsonv2&limit=5&addressdetails=1&accept-language=it,en` +
    `&q=${encodeURIComponent(q)}` +
    (countrycodes ? `&countrycodes=${encodeURIComponent(countrycodes)}` : "") +
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

async function nominatimSearch(q, req, preferredCC, explicitCC) {
  // If user explicitly set a country code, honor it first
  if (explicitCC) {
    const r1 = await nominatimRequest(q, req, { countrycodes: explicitCC.toLowerCase() });
    if (r1.ok) return r1;
    // fallback global
    return await nominatimRequest(q, req, { countrycodes: "" });
  }

  // Otherwise: try preferred country first (IT)
  if (preferredCC) {
    const r1 = await nominatimRequest(q, req, { countrycodes: preferredCC.toLowerCase() });
    if (r1.ok) return r1;
  }

  // Then global
  return await nominatimRequest(q, req, { countrycodes: "" });
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

    const explicitCC = detectExplicitCountry(q);
    const preferredCC = preferredCCFromReq(req, explicitCC);

    const cacheKey = `v2.3:${q.toLowerCase()}:pref=${preferredCC || ""}:exp=${explicitCC || ""}`;
    const hit = cache.get(cacheKey);
    if (hit && now() - hit.ts < TTL_MS) {
      return res.status(200).json(hit.data);
    }

    // 1) Offline index (preferred country)
    const offline = offlineSearch(q, preferredCC);
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

    // 2) Nominatim fallback (preferred country first, then global)
    const nom = await nominatimSearch(q, req, preferredCC, explicitCC);
    const data = nom.ok
      ? { ok: true, result: nom.result, candidates: nom.candidates || [], source: nom.source || "nominatim" }
      : { ok: false, error: nom.error || "Geocoding fallito", source: nom.source || "nominatim" };

    cache.set(cacheKey, { ts: now(), data });
    return res.status(200).json(data);

  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
