// /api/plan.js — HUB→HUB (MACRO-AWARE) — v4 OFFLINE-ROUTES + DEBUG
// ✅ Legge hub globali + (se macroId) hub dal file macro
// ✅ Se macro contiene routes[train|bus], usa SOLO quelle (NO tratte inventate)
// ✅ Plane: usa aeroporti globali + macro airports, stima hub→hub (come prima) ma con debug
// ✅ Output: results + debug dettagliato

import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "public", "data");
const MACROS_DIR = path.join(DATA_DIR, "macros");

function readJsonStrict(fullPath) {
  const raw = fs.readFileSync(fullPath, "utf8");
  return JSON.parse(raw);
}

function readJsonSafe(fullPath, fallback) {
  try {
    if (!fs.existsSync(fullPath)) return fallback;
    return readJsonStrict(fullPath);
  } catch {
    return fallback;
  }
}

function toRad(x) { return (x * Math.PI) / 180; }
function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hubKey(h) {
  const code = String(h?.code || "").trim();
  const name = String(h?.name || "").trim();
  return code ? code.toUpperCase() : normName(name);
}

function asHub(h) {
  // normalizza shape: {code,name,country,lat,lon,type}
  if (!h) return null;
  const lat = Number(h.lat);
  const lon = Number(h.lon ?? h.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    type: String(h.type || "").trim() || "hub",
    code: (h.code ? String(h.code).trim().toUpperCase() : ""),
    name: String(h.name || h.code || "Hub").trim(),
    country: String(h.country || "").trim(),
    lat,
    lon,
    // opzionali:
    region_hint: h.region_hint || "",
    rail_class: h.rail_class || "" // es: "hsr" | "regional"
  };
}

function mergeUniqueByKey(listA, listB) {
  const map = new Map();
  [...(listA || []), ...(listB || [])].forEach((x) => {
    const h = asHub(x);
    if (!h) return;
    const k = hubKey(h);
    if (!k) return;
    if (!map.has(k)) map.set(k, h);
  });
  return [...map.values()];
}

function nearestHub(hubs, lat, lon) {
  let best = null;
  let bestKm = Infinity;
  for (const h of hubs) {
    const km = haversineKm(lat, lon, Number(h.lat), Number(h.lon));
    if (km < bestKm) { bestKm = km; best = h; }
  }
  return { hub: best, km: bestKm };
}

// SOLO tratta principale (hub→hub) stimata
function estMainMinutes(mode, km, railClass = "") {
  if (mode === "plane") {
    const cruise = 820;
    // “solo volo” + minimo realistico
    const m = (km / cruise) * 60 + 30;
    return Math.round(clamp(m, 35, 2400));
  }

  if (mode === "train") {
    // se NON è alta velocità, abbassa parecchio la media
    const isHsr = String(railClass || "").toLowerCase() === "hsr";
    const avg = isHsr ? 170 : 85;      // <<<<< qui sta la differenza che evita “Ancona 71 min”
    const overhead = isHsr ? 10 : 18;
    const m = (km / avg) * 60 + overhead;
    return Math.round(clamp(m, 25, 2400));
  }

  if (mode === "bus") {
    const avg = 78;
    const m = (km / avg) * 60 + 10;
    return Math.round(clamp(m, 30, 3000));
  }

  return Math.round((km / 70) * 60);
}

function score({ totalMinutes, mainKm, targetMinutes, preferNear }) {
  const t = Number(totalMinutes);
  const target = Number(targetMinutes);

  const tScore = clamp(1 - Math.abs(t - target) / Math.max(20, target * 0.9), 0, 1);
  const kScore = clamp(1 - mainKm / 1500, 0, 1);

  const nearWeight = preferNear ? 0.35 : 0.1;
  return 0.65 * tScore + nearWeight * kScore;
}

/**
 * OFFLINE ROUTES:
 * macro.routes = {
 *   train: [{ from:"IT-AQ-LAQUILA", to:"IT-AQ-SULMONA", minutes:67, label?:"..." }, ...],
 *   bus:   [{ from:"BUS-AQ-LAQUILA", to:"BUS-ROMA-TIBURTINA", minutes:110 }, ...]
 * }
 */
function planFromOfflineRoutes({ mode, maxM, origin, hubs, routes, limit }) {
  const oLat = Number(origin.lat), oLon = Number(origin.lon);
  const safeLimit = clamp(Number(limit) || 10, 1, 20);

  const { hub: originHub } = nearestHub(hubs, oLat, oLon);
  if (!originHub) return { results: [], debug: { reason: "no_originHub" } };

  const originK = hubKey(originHub);

  const edges = Array.isArray(routes) ? routes : [];
  const out = [];

  // considera solo edges che partono dall’originHub (per key code o per name normalizzato)
  for (const e of edges) {
    const from = String(e.from || "").trim().toUpperCase();
    const to   = String(e.to || "").trim().toUpperCase();
    const mins = Number(e.minutes);

    if (!from || !to || !Number.isFinite(mins)) continue;

    // match originHub: se ha code, match su code, altrimenti su key
    const okFrom = originHub.code ? (from === originHub.code || from === originK) : (from === originK);
    if (!okFrom) continue;

    if (mins > maxM) continue;

    const destHub = hubs.find(h => (h.code && h.code === to) || hubKey(h) === to) || null;
    if (!destHub) continue;

    const mainKm = haversineKm(originHub.lat, originHub.lon, destHub.lat, destHub.lon);

    const label =
      e.label ||
      (mode === "train" ? `Treno ${originHub.name} → ${destHub.name}` :
       mode === "bus"   ? `Bus ${originHub.name} → ${destHub.name}` :
                          `${mode.toUpperCase()} ${originHub.name} → ${destHub.name}`);

    out.push({
      destination: {
        id: destHub.code ? destHub.code : `hub_${normName(destHub.name)}`,
        name: destHub.name,
        country: destHub.country || "",
        lat: destHub.lat,
        lon: destHub.lon,
      },
      originHub,
      destinationHub: destHub,
      segments: [{ kind: "main", label, minutes: mins, km: Math.round(mainKm) }],
      totalMinutes: mins,
      confidence: "offline_routes_exact",
      distanceKmApprox: Math.round(mainKm),
      score: Number(score({ totalMinutes: mins, mainKm, targetMinutes: maxM, preferNear: true }).toFixed(4)),
      summary: `${mode.toUpperCase()}: ${originHub.name} → ${destHub.name} • ${mins} min (offline)`,
    });
  }

  out.sort((a, b) => b.score - a.score || a.totalMinutes - b.totalMinutes);
  return {
    results: out.slice(0, safeLimit),
    debug: {
      source: "offline_routes",
      originHub: { name: originHub.name, code: originHub.code || "", kmFromOrigin: 0 },
      edgesUsed: out.length,
      hubsCount: hubs.length
    }
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const body = req.body || {};
    const origin = body.origin || {};
    const mode = String(body.mode || "").trim(); // "plane"|"train"|"bus"
    const maxMinutes = Number(body.maxMinutes);
    const limit = body.limit ?? 10;

    const minMainKm = body.minMainKm ?? null;
    const avoidSameHub = body.avoidSameHub ?? true;
    const preferNear = body.preferNear ?? true;

    const macroId = String(body.macroId || "").trim(); // ES: "it_macro_01_abruzzo"

    const oLat = Number(origin?.lat);
    const oLon = Number(origin?.lon);
    const maxM = Number(maxMinutes);

    if (!Number.isFinite(oLat) || !Number.isFinite(oLon)) {
      return res.status(400).json({ error: "origin must be {lat, lon}" });
    }
    if (!Number.isFinite(maxM) || maxM <= 0) {
      return res.status(400).json({ error: "maxMinutes must be positive" });
    }
    if (!["plane", "train", "bus"].includes(mode)) {
      return res.status(400).json({ error: "mode must be plane|train|bus" });
    }

    // 1) carica HUB globali
    const airportsGlobal = readJsonSafe(path.join(DATA_DIR, "curated_airports_eu_uk.json"), []);
    const stationsGlobal = readJsonSafe(path.join(DATA_DIR, "curated_stations_eu_uk.json"), []);

    // 2) carica HUB macro (se macroId)
    const macro = macroId
      ? readJsonSafe(path.join(MACROS_DIR, `${macroId}.json`), null)
      : null;

    const macroAirports = macro?.hubs?.airports || [];
    const macroStations = macro?.hubs?.stations || [];
    const macroBusHubs  = macro?.hubs?.bus_hubs || [];

    // 3) costruisci HUB list per mode
    let hubs = [];
    if (mode === "plane") hubs = mergeUniqueByKey(airportsGlobal, macroAirports);
    if (mode === "train") hubs = mergeUniqueByKey(stationsGlobal, macroStations);
    if (mode === "bus")   hubs = mergeUniqueByKey(stationsGlobal, mergeUniqueByKey(macroStations, macroBusHubs));

    if (!hubs.length) {
      return res.status(200).json({
        ok: true,
        input: { origin: { lat: oLat, lon: oLon, label: origin?.label || "" }, maxMinutes: maxM, mode, macroId },
        results: [],
        message: "Nessun hub disponibile: manca dataset (global o macro).",
        debug: { macroLoaded: !!macro, macroId, hubsCount: 0 }
      });
    }

    // 4) OFFLINE ROUTES (solo per train/bus) se presenti nel macro
    const offlineRoutes = macro?.routes?.[mode] || null;
    if ((mode === "train" || mode === "bus") && Array.isArray(offlineRoutes) && offlineRoutes.length) {
      const planned = planFromOfflineRoutes({
        mode, maxM,
        origin: { lat: oLat, lon: oLon },
        hubs,
        routes: offlineRoutes,
        limit
      });

      return res.status(200).json({
        ok: true,
        input: { origin: { lat: oLat, lon: oLon, label: origin?.label || "" }, maxMinutes: maxM, mode, macroId, limit },
        results: planned.results,
        debug: planned.debug
      });
    }

    // 5) fallback: STIMA (come prima, ma con railClass + debug)
    const { hub: originHub, km: kmToOriginHub } = nearestHub(hubs, oLat, oLon);
    if (!originHub) {
      return res.status(200).json({
        ok: true,
        input: { origin: { lat: oLat, lon: oLon, label: origin?.label || "" }, maxMinutes: maxM, mode, macroId },
        results: [],
        message: "Nessun hub trovato vicino alla partenza.",
        debug: { macroLoaded: !!macro, macroId, hubsCount: hubs.length }
      });
    }

    const originHubKey = hubKey(originHub);

    const minKmDefault = mode === "plane" ? 180 : mode === "train" ? 40 : 35;
    const minKm = Number.isFinite(Number(minMainKm)) ? Number(minMainKm) : minKmDefault;

    const scored = [];
    for (const dh of hubs) {
      const destHubKey = hubKey(dh);
      if (avoidSameHub && originHubKey && destHubKey && originHubKey === destHubKey) continue;

      const mainKm = haversineKm(originHub.lat, originHub.lon, dh.lat, dh.lon);
      if (Number.isFinite(minKm) && mainKm < minKm) continue;

      const mainMin = estMainMinutes(mode, mainKm, dh.rail_class || originHub.rail_class || "");
      if (mainMin > maxM) continue;

      const s = score({ totalMinutes: mainMin, mainKm, targetMinutes: maxM, preferNear: !!preferNear });

      const label =
        mode === "plane"
          ? `Volo ${originHub.code || "?"} → ${dh.code || "?"}`
          : mode === "train"
          ? `Treno ${originHub.name} → ${dh.name}`
          : `Bus ${originHub.name} → ${dh.name}`;

      scored.push({
        destination: {
          id: dh.code ? dh.code : `hub_${normName(dh.name || "hub")}`,
          name: dh.name,
          country: dh.country || "",
          lat: dh.lat,
          lon: dh.lon
        },
        originHub,
        destinationHub: dh,
        segments: [{ kind: "main", label, minutes: mainMin, km: Math.round(mainKm) }],
        totalMinutes: mainMin,
        confidence: "estimated_hub_to_hub",
        distanceKmApprox: Math.round(mainKm),
        score: Number(s.toFixed(4)),
        summary:
          `${mode.toUpperCase()}: ${originHub.name}${originHub.code ? ` (${originHub.code})` : ""}` +
          ` → ${dh.name}${dh.code ? ` (${dh.code})` : ""} • ${mainMin} min (stima)`,
      });
    }

    scored.sort((a, b) => b.score - a.score || a.totalMinutes - b.totalMinutes);
    const safeLimit = clamp(Number(limit) || 10, 1, 20);
    const results = scored.slice(0, safeLimit);

    const message =
      results.length
        ? ""
        : `Nessuna tratta ${mode} entro ${maxM} min con gli hub attuali. (Oppure manca qualche hub vicino / rotte offline).`;

    return res.status(200).json({
      ok: true,
      input: {
        origin: { lat: oLat, lon: oLon, label: origin?.label || "" },
        maxMinutes: maxM,
        mode,
        macroId,
        limit: safeLimit,
        minMainKm: minKm,
        avoidSameHub,
        preferNear,
      },
      results,
      message,
      debug: {
        macroLoaded: !!macro,
        macroId: macroId || null,
        hubsCount: hubs.length,
        originHub: { name: originHub.name, code: originHub.code || "", kmFromOrigin: Math.round(kmToOriginHub) },
        usedOfflineRoutes: false
      }
    });

  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
      hint:
        "Controlla che i JSON siano validi e che il macroId punti a public/data/macros/<macroId>.json",
    });
  }
      }
