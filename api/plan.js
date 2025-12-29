// /api/plan.js  — Vercel-safe (solo public/data)
// - Legge i JSON da public/data/*
// - POST /api/plan con { origin:{lat,lon,label?}, maxMinutes:number, mode:"plane"|"train"|"bus", limit?:number }
// - Restituisce mete raggiungibili entro maxMinutes con hub + stima tempi

import fs from "fs";
import path from "path";

function readJsonFromPublicData(filename) {
  // In Vercel, i file statici stanno in /public
  // e in build diventano disponibili nel filesystem del deployment.
  const p = path.join(process.cwd(), "public", "data", filename);
  const raw = fs.readFileSync(p, "utf8");
  return { data: JSON.parse(raw), usedPath: p };
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

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

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

// tempo per raggiungere hub (access/egress)
function estAccessMinutes(km, speedKmh, minM = 10, maxM = 240) {
  // +10 min “attrito” (parcheggio/attese)
  const m = (km / speedKmh) * 60 + 10;
  return Math.round(clamp(m, minM, maxM));
}

// tempo tratta principale
function estMainMinutes(mode, km) {
  if (mode === "plane") {
    const cruise = 820;
    const m = (km / cruise) * 60 + 55; // check-in + security + boarding
    return Math.round(clamp(m, 60, 2400));
  }
  if (mode === "train") {
    const avg = 140;
    const m = (km / avg) * 60 + 12;
    return Math.round(clamp(m, 30, 2400));
  }
  if (mode === "bus") {
    const avg = 85;
    const m = (km / avg) * 60 + 12;
    return Math.round(clamp(m, 35, 3000));
  }
  const avg = 70;
  return Math.round((km / avg) * 60);
}

function buildRoute({ mode, origin, dest, airports, stations }) {
  const oLat = origin.lat, oLon = origin.lon;
  const dLat = dest.lat, dLon = dest.lon;

  if (mode === "plane") {
    const oA = nearestHub(airports, oLat, oLon);
    const dA = nearestHub(airports, dLat, dLon);
    if (!oA.hub || !dA.hub) return null;

    const accessMin = estAccessMinutes(oA.km, 70, 20, 320);
    const flightKm = haversineKm(oA.hub.lat, oA.hub.lon, dA.hub.lat, dA.hub.lon);
    const flightMin = estMainMinutes("plane", flightKm);
    const egressMin = estAccessMinutes(dA.km, 55, 10, 220);
    const totalMinutes = accessMin + flightMin + egressMin;

    return {
      originHub: { ...oA.hub },
      destinationHub: { ...dA.hub },
      segments: [
        { kind: "access", label: `Verso ${oA.hub.name} (${oA.hub.code || "?"})`, minutes: accessMin },
        { kind: "main", label: `Volo ${(oA.hub.code || "?")} → ${(dA.hub.code || "?")}`, minutes: flightMin },
        { kind: "egress", label: `Dall’aeroporto a ${dest.name}`, minutes: egressMin }
      ],
      totalMinutes,
      confidence: "estimated"
    };
  }

  // train/bus: stazioni
  const oS = nearestHub(stations, oLat, oLon);
  const dS = nearestHub(stations, dLat, dLon);
  if (!oS.hub || !dS.hub) return null;

  const accessMin = estAccessMinutes(oS.km, 35, 8, 160);
  const mainKm = haversineKm(oS.hub.lat, oS.hub.lon, dS.hub.lat, dS.hub.lon);
  const mainMin = estMainMinutes(mode, mainKm);
  const egressMin = estAccessMinutes(dS.km, 30, 6, 160);
  const totalMinutes = accessMin + mainMin + egressMin;

  return {
    originHub: { ...oS.hub },
    destinationHub: { ...dS.hub },
    segments: [
      { kind: "access", label: `Verso ${oS.hub.name}`, minutes: accessMin },
      { kind: "main", label: `${mode === "train" ? "Treno" : "Bus"} ${oS.hub.name} → ${dS.hub.name}`, minutes: mainMin },
      { kind: "egress", label: `Dalla stazione a ${dest.name}`, minutes: egressMin }
    ],
    totalMinutes,
    confidence: "estimated"
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const { origin, maxMinutes, mode, limit = 8 } = req.body || {};
    if (!origin || maxMinutes == null || !mode) {
      return res.status(400).json({ error: "Missing fields", needed: ["origin", "maxMinutes", "mode"] });
    }

    // accetta stringhe numeriche
    const oLat = Number(origin.lat);
    const oLon = Number(origin.lon);
    const maxM = Number(maxMinutes);

    if (!Number.isFinite(oLat) || !Number.isFinite(oLon)) {
      return res.status(400).json({ error: "origin must be {lat, lon}", got: origin });
    }
    if (!Number.isFinite(maxM) || maxM <= 0) {
      return res.status(400).json({ error: "maxMinutes must be a positive number", got: maxMinutes });
    }

    const allowedModes = ["plane", "train", "bus"];
    if (!allowedModes.includes(mode)) {
      return res.status(400).json({ error: "mode must be one of: plane, train, bus" });
    }

    // ✅ Legge SOLO da public/data
    const airportsPack = readJsonFromPublicData("curated_airports_eu_uk.json");
    const stationsPack = readJsonFromPublicData("curated_stations_eu_uk.json");
    const destinationsPack = readJsonFromPublicData("curated_destinations_eu_uk.json");

    const airports = airportsPack.data;
    const stations = stationsPack.data;
    const destinations = destinationsPack.data;

    if (!Array.isArray(airports) || !Array.isArray(stations) || !Array.isArray(destinations)) {
      return res.status(500).json({
        error: "JSON format error: expected arrays",
        debug: {
          used: {
            airports: airportsPack.usedPath,
            stations: stationsPack.usedPath,
            destinations: destinationsPack.usedPath
          },
          types: {
            airports: typeof airports,
            stations: typeof stations,
            destinations: typeof destinations
          }
        }
      });
    }

    const originObj = { lat: oLat, lon: oLon, label: origin.label || "Partenza" };

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

      const kmToDest = haversineKm(originObj.lat, originObj.lon, dest.lat, dest.lon);
      if (kmToDest < 5) continue;

      const route = buildRoute({ mode, origin: originObj, dest, airports, stations });
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
      confidence: r.route.confidence,
      summary: `${mode.toUpperCase()}: ${r.route.originHub.name}${r.route.originHub.code ? ` (${r.route.originHub.code})` : ""} → ${r.route.destinationHub.name}${r.route.destinationHub.code ? ` (${r.route.destinationHub.code})` : ""} • ${r.route.totalMinutes} min`
    }));

    return res.status(200).json({
      ok: true,
      input: { origin: originObj, maxMinutes: maxM, mode },
      debug: {
        usedPaths: {
          airports: airportsPack.usedPath,
          stations: stationsPack.usedPath,
          destinations: destinationsPack.usedPath
        }
      },
      results
    });
  } catch (e) {
    // errore chiaro (tipo file non trovato)
    return res.status(500).json({
      error: String(e?.message || e),
      hint: "Controlla che i file esistano in public/data e che i nomi combacino",
      debug: {
        cwd: process.cwd()
      }
    });
  }
}
