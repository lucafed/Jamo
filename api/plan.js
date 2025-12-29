// /api/plan.js
export const config = { runtime: "nodejs" };

import fs from "fs";
import path from "path";

let CACHE = null;

function readJsonTrying(relPaths) {
  const tried = [];
  for (const rel of relPaths) {
    const p = path.resolve(process.cwd(), rel);
    tried.push(p);
    try {
      const raw = fs.readFileSync(p, "utf8");
      return { data: JSON.parse(raw), usedPath: p, tried };
    } catch (e) {
      // continue
    }
  }
  const err = new Error("JSON file not found in any known path");
  err.tried = tried;
  throw err;
}

function loadAll() {
  if (CACHE) return CACHE;

  const airportsPack = readJsonTrying([
    "public/data/curated_airports_eu_uk.json",
    "data/curated_airports_eu_uk.json"
  ]);
  const stationsPack = readJsonTrying([
    "public/data/curated_stations_eu_uk.json",
    "data/curated_stations_eu_uk.json"
  ]);
  const destinationsPack = readJsonTrying([
    "public/data/curated_destinations_eu_uk.json",
    "data/curated_destinations_eu_uk.json"
  ]);

  const airports = airportsPack.data;
  const stations = stationsPack.data;
  const destinations = destinationsPack.data;

  if (!Array.isArray(airports) || !Array.isArray(stations) || !Array.isArray(destinations)) {
    const e = new Error("JSON format error: expected arrays");
    e.debug = {
      airportsIsArray: Array.isArray(airports),
      stationsIsArray: Array.isArray(stations),
      destinationsIsArray: Array.isArray(destinations),
      usedPaths: {
        airports: airportsPack.usedPath,
        stations: stationsPack.usedPath,
        destinations: destinationsPack.usedPath
      }
    };
    throw e;
  }

  CACHE = {
    airports,
    stations,
    destinations,
    usedPaths: {
      airports: airportsPack.usedPath,
      stations: stationsPack.usedPath,
      destinations: destinationsPack.usedPath
    }
  };

  return CACHE;
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

function nearestHub(hubs, lat, lon) {
  let best = null;
  let bestKm = Infinity;
  for (const h of hubs) {
    const hLat = Number(h.lat);
    const hLon = Number(h.lon);
    if (!Number.isFinite(hLat) || !Number.isFinite(hLon)) continue;
    const km = haversineKm(lat, lon, hLat, hLon);
    if (km < bestKm) { bestKm = km; best = h; }
  }
  return { hub: best, km: bestKm };
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function estAccessMinutes(km, speedKmh, minM = 10, maxM = 240) {
  const m = (km / speedKmh) * 60 + 10;
  return Math.round(clamp(m, minM, maxM));
}

function estMainMinutes(mode, km) {
  if (mode === "plane") {
    const m = (km / 820) * 60 + 50;
    return Math.round(clamp(m, 45, 2400));
  }
  if (mode === "train") {
    const m = (km / 145) * 60 + 10;
    return Math.round(clamp(m, 25, 2400));
  }
  if (mode === "bus") {
    const m = (km / 90) * 60 + 10;
    return Math.round(clamp(m, 30, 3000));
  }
  const m = (km / 70) * 60;
  return Math.round(clamp(m, 10, 5000));
}

function buildRoute({ mode, origin, dest, airports, stations }) {
  const oLat = origin.lat, oLon = origin.lon;
  const dLat = dest.lat, dLon = dest.lon;

  if (mode === "plane") {
    const oA = nearestHub(airports, oLat, oLon);
    const dA = nearestHub(airports, dLat, dLon);
    if (!oA.hub || !dA.hub) return null;

    const accessMin = estAccessMinutes(oA.km, 70, 15, 300);
    const flightKm = haversineKm(oA.hub.lat, oA.hub.lon, dA.hub.lat, dA.hub.lon);
    const flightMin = estMainMinutes("plane", flightKm);
    const egressMin = estAccessMinutes(dA.km, 55, 10, 180);

    return {
      originHub: { ...oA.hub },
      destinationHub: { ...dA.hub },
      segments: [
        { kind: "access", label: `Verso ${oA.hub.name} (${oA.hub.code || "?"})`, minutes: accessMin },
        { kind: "main", label: `Volo ${(oA.hub.code || "?")} → ${(dA.hub.code || "?")}`, minutes: flightMin },
        { kind: "egress", label: `Dall’aeroporto a ${dest.name}`, minutes: egressMin }
      ],
      totalMinutes: accessMin + flightMin + egressMin,
      confidence: "estimated"
    };
  }

  // train/bus usano stations
  const oS = nearestHub(stations, oLat, oLon);
  const dS = nearestHub(stations, dLat, dLon);
  if (!oS.hub || !dS.hub) return null;

  const accessMin = estAccessMinutes(oS.km, 35, 8, 120);
  const mainKm = haversineKm(oS.hub.lat, oS.hub.lon, dS.hub.lat, dS.hub.lon);
  const mainMin = estMainMinutes(mode, mainKm);
  const egressMin = estAccessMinutes(dS.km, 30, 6, 120);

  return {
    originHub: { ...oS.hub },
    destinationHub: { ...dS.hub },
    segments: [
      { kind: "access", label: `Verso ${oS.hub.name}`, minutes: accessMin },
      { kind: "main", label: `${mode === "train" ? "Treno" : "Bus"} ${oS.hub.name} → ${dS.hub.name}`, minutes: mainMin },
      { kind: "egress", label: `Dalla stazione a ${dest.name}`, minutes: egressMin }
    ],
    totalMinutes: accessMin + mainMin + egressMin,
    confidence: "estimated"
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Use POST" });
    }

    const { origin, maxMinutes, mode, limit = 8 } = req.body || {};
    if (!origin || typeof origin.lat !== "number" || typeof origin.lon !== "number") {
      return res.status(400).json({
        ok: false,
        error: "origin must be {lat:number, lon:number}",
        got: origin
      });
    }

    const allowed = ["plane", "train", "bus"];
    if (!allowed.includes(mode)) {
      return res.status(400).json({
        ok: false,
        error: "mode must be one of plane/train/bus",
        got: mode
      });
    }

    const maxM = Number(maxMinutes);
    if (!Number.isFinite(maxM) || maxM <= 0) {
      return res.status(400).json({ ok: false, error: "maxMinutes must be a positive number" });
    }

    const { airports, stations, destinations, usedPaths } = loadAll();

    const scored = [];
    for (const d of destinations) {
      const dest = {
        id: d.id,
        name: d.name,
        country: d.country,
        lat: Number(d.lat),
        lon: Number(d.lon),
        tags: d.tags
      };
      if (!dest.id || !dest.name || !Number.isFinite(dest.lat) || !Number.isFinite(dest.lon)) continue;

      const kmToDest = haversineKm(origin.lat, origin.lon, dest.lat, dest.lon);
      if (kmToDest < 5) continue;

      const route = buildRoute({ mode, origin, dest, airports, stations });
      if (!route) continue;

      if (route.totalMinutes <= maxM) {
        scored.push({ destination: dest, route });
      }
    }

    scored.sort((a, b) => a.route.totalMinutes - b.route.totalMinutes);
    const safeLimit = clamp(Number(limit) || 8, 1, 20);

    const results = scored.slice(0, safeLimit).map((r) => ({
      destination: r.destination,
      originHub: r.route.originHub,
      destinationHub: r.route.destinationHub,
      segments: r.route.segments,
      totalMinutes: r.route.totalMinutes,
      confidence: r.route.confidence
    }));

    return res.status(200).json({
      ok: true,
      input: { origin, maxMinutes: maxM, mode },
      debug: { usedPaths, found: results.length },
      results
    });
  } catch (e) {
    // ✅ SEMPRE JSON (così app.js non crasha mai su json())
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
      tried: e?.tried,
      debug: e?.debug
    });
  }
}
