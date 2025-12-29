// /api/plan.js
import fs from "fs";
import path from "path";

function readJsonTrying(relPaths) {
  const tried = [];
  for (const rel of relPaths) {
    const p = path.join(process.cwd(), rel);
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
    const cruise = 820;
    const m = (km / cruise) * 60 + 50;
    return Math.round(clamp(m, 45, 2400));
  }
  if (mode === "train") {
    const avg = 145;
    const m = (km / avg) * 60 + 10;
    return Math.round(clamp(m, 25, 2400));
  }
  if (mode === "bus") {
    const avg = 90;
    const m = (km / avg) * 60 + 10;
    return Math.round(clamp(m, 30, 3000));
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

    const accessMin = estAccessMinutes(oA.km, 70, 15, 300);
    const flightKm = haversineKm(oA.hub.lat, oA.hub.lon, dA.hub.lat, dA.hub.lon);
    const flightMin = estMainMinutes("plane", flightKm);
    const egressMin = estAccessMinutes(dA.km, 55, 10, 180);
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

  const oS = nearestHub(stations, oLat, oLon);
  const dS = nearestHub(stations, dLat, dLon);
  if (!oS.hub || !dS.hub) return null;

  const accessMin = estAccessMinutes(oS.km, 35, 8, 120);
  const mainKm = haversineKm(oS.hub.lat, oS.hub.lon, dS.hub.lat, dS.hub.lon);
  const mainMin = estMainMinutes(mode, mainKm);
  const egressMin = estAccessMinutes(dS.km, 30, 6, 120);
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
    if (!origin || !maxMinutes || !mode) {
      return res.status(400).json({ error: "Missing fields", needed: ["origin", "maxMinutes", "mode"] });
    }
    if (typeof origin !== "object" || typeof origin.lat !== "number" || typeof origin.lon !== "number") {
      return res.status(400).json({ error: "origin must be {lat:number, lon:number, label?:string}", got: origin });
    }

    const allowedModes = ["plane", "train", "bus"];
    if (!allowedModes.includes(mode)) {
      return res.status(400).json({ error: "mode must be one of: plane, train, bus" });
    }

    // ✅ prova più path possibili (Vercel-proof)
    const airportsPack = readJsonTrying([
      "data/curated_airports_eu_uk.json",
      "public/data/curated_airports_eu_uk.json"
    ]);
    const stationsPack = readJsonTrying([
      "data/curated_stations_eu_uk.json",
      "public/data/curated_stations_eu_uk.json"
    ]);
    const destinationsPack = readJsonTrying([
      "data/curated_destinations_eu_uk.json",
      "public/data/curated_destinations_eu_uk.json"
    ]);

    const airports = airportsPack.data;
    const stations = stationsPack.data;
    const destinations = destinationsPack.data;

    if (!Array.isArray(airports) || !Array.isArray(stations) || !Array.isArray(destinations)) {
      return res.status(500).json({
        error: "JSON format error: expected arrays",
        debug: {
          airportsType: typeof airports,
          stationsType: typeof stations,
          destinationsType: typeof destinations,
          used: { airports: airportsPack.usedPath, stations: stationsPack.usedPath, destinations: destinationsPack.usedPath }
        }
      });
    }

    const maxM = Number(maxMinutes);
    const originLabel = origin.label || "Partenza";

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
      confidence: r.route.confidence,
      summary: `${mode.toUpperCase()}: ${r.route.originHub.name}${r.route.originHub.code ? ` (${r.route.originHub.code})` : ""} → ${r.route.destinationHub.name}${r.route.destinationHub.code ? ` (${r.route.destinationHub.code})` : ""} • ${r.route.totalMinutes} min`
    }));

    return res.status(200).json({
      ok: true,
      input: { origin: { ...origin, label: originLabel }, maxMinutes: maxM, mode },
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
    return res.status(500).json({
      error: String(e?.message || e),
      tried: e?.tried || undefined
    });
  }
}
