// /api/plan.js — Vercel-safe (solo public/data) — v2 SMART
// - Legge i JSON da public/data/*
// - POST /api/plan con:
//   { origin:{lat,lon,label?}, maxMinutes:number, mode:"plane"|"train"|"bus", limit?:number,
//     minKm?:number, avoidSameCity?:boolean, avoidSameHub?:boolean, preferNear?:boolean }
// - Restituisce mete raggiungibili entro maxMinutes con hub + stima tempi
// - Filtri anti "Verona→Verona" + ranking sensato

import fs from "fs";
import path from "path";

function readJsonFromPublicData(filename) {
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

// normalize: lower + no accents + keep alnum spaces
function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hubKey(h) {
  const code = String(h?.code || "").trim();
  const name = String(h?.name || "").trim();
  return code ? code.toUpperCase() : normName(name);
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

// tempo per raggiungere hub (access/egress)
function estAccessMinutes(km, speedKmh, minM = 10, maxM = 240) {
  const m = (km / speedKmh) * 60 + 10;
  return Math.round(clamp(m, minM, maxM));
}

// tempo tratta principale
function estMainMinutes(mode, km) {
  if (mode === "plane") {
    const cruise = 820;
    const m = (km / cruise) * 60 + 55;
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
        { kind: "main", label: `Volo ${(oA.hub.code || "?")} → ${(dA.hub.code || "?")}`, minutes: flightMin, km: flightKm },
        { kind: "egress", label: `Dall’aeroporto a ${dest.name}`, minutes: egressMin }
      ],
      totalMinutes,
      confidence: "estimated",
      debug: { accessKm: oA.km, egressKm: dA.km, mainKm: flightKm }
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
      { kind: "main", label: `${mode === "train" ? "Treno" : "Bus"} ${oS.hub.name} → ${dS.hub.name}`, minutes: mainMin, km: mainKm },
      { kind: "egress", label: `Dalla stazione a ${dest.name}`, minutes: egressMin }
    ],
    totalMinutes,
    confidence: "estimated",
    debug: { accessKm: oS.km, egressKm: dS.km, mainKm }
  };
}

/**
 * Score "sensato":
 * - preferisce tempo vicino al target (maxMinutes)
 * - preferisce destinazioni non troppo lontane (se preferNear=true)
 * - penalizza combo assurde (access+egress enormi rispetto al main)
 */
function scoreRoute({ totalMinutes, kmToDest, mode, route, targetMinutes, preferNear }) {
  const t = Number(totalMinutes);
  const target = Number(targetMinutes);

  // 1) vicinanza al target (0..1)
  const tScore = clamp(1 - (Math.abs(t - target) / Math.max(20, target * 0.9)), 0, 1);

  // 2) vicinanza geografica (0..1) — utile soprattutto per train/bus
  // scala: 0 km => 1, 1500 km => ~0
  const kScore = Number.isFinite(kmToDest) ? clamp(1 - (kmToDest / 1500), 0, 1) : 0.4;

  // 3) penalità se access/egress dominano
  const segs = Array.isArray(route?.segments) ? route.segments : [];
  const access = segs.find(s => s.kind === "access")?.minutes ?? 0;
  const egress = segs.find(s => s.kind === "egress")?.minutes ?? 0;
  const main = segs.find(s => s.kind === "main")?.minutes ?? 0;
  const overhead = access + egress;

  let penalty = 0;
  if (overhead > main * 1.4) penalty += 0.15;
  if (overhead > main * 2.2) penalty += 0.15;

  // 4) aereo: penalizza voli “ridicoli” (tratta troppo corta)
  if (mode === "plane") {
    const mainKm = route?.debug?.mainKm;
    if (Number.isFinite(mainKm) && mainKm < 180) penalty += 0.35;
    if (t < Math.max(55, target * 0.35)) penalty += 0.20; // “troppo corto” sospetto
  }

  // mix
  const nearWeight = preferNear ? 0.35 : 0.10;
  const base = (0.65 * tScore) + (nearWeight * kScore);
  return base - penalty;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const {
      origin,
      maxMinutes,
      mode,
      limit = 8,
      minKm = 35,              // ✅ default: evita “stessa città”
      avoidSameCity = true,     // ✅ default on
      avoidSameHub = true,      // ✅ default on
      preferNear = true         // ✅ default on (meno mete “random lontane”)
    } = req.body || {};

    if (!origin || maxMinutes == null || !mode) {
      return res.status(400).json({ error: "Missing fields", needed: ["origin", "maxMinutes", "mode"] });
    }

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
          }
        }
      });
    }

    const originObj = { lat: oLat, lon: oLon, label: origin.label || "Partenza" };
    const originLabelNorm = normName(originObj.label);

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

      // distanza “diretta” origin -> dest
      const kmToDest = haversineKm(originObj.lat, originObj.lon, dest.lat, dest.lon);

      // ✅ filtro vicinanza minima
      if (Number.isFinite(minKm) && kmToDest < Number(minKm)) continue;

      // ✅ filtro stessa città (basato su label o nome destinazione)
      if (avoidSameCity) {
        const destNameNorm = normName(dest.name);
        if (originLabelNorm && destNameNorm && originLabelNorm === destNameNorm) continue;
      }

      const route = buildRoute({ mode, origin: originObj, dest, airports, stations });
      if (!route) continue;

      // ✅ filtro stesso hub (Verona-Villafranca -> Verona-Villafranca)
      if (avoidSameHub) {
        const oh = hubKey(route.originHub);
        const dh = hubKey(route.destinationHub);
        if (oh && dh && oh === dh) continue;
      }

      if (route.totalMinutes > maxM) continue;

      const s = scoreRoute({
        totalMinutes: route.totalMinutes,
        kmToDest,
        mode,
        route,
        targetMinutes: maxM,
        preferNear: !!preferNear
      });

      scored.push({ destination: dest, route, kmToDest, score: s });
    }

    // ✅ Ordina per score desc, e a parità per totalMinutes asc
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.route.totalMinutes - b.route.totalMinutes;
    });

    const safeLimit = clamp(Number(limit) || 8, 1, 20);

    const results = scored.slice(0, safeLimit).map((r) => ({
      destination: r.destination,
      originHub: r.route.originHub,
      destinationHub: r.route.destinationHub,
      segments: r.route.segments,
      totalMinutes: r.route.totalMinutes,
      confidence: r.route.confidence,
      // utile al client se vuoi mostrarlo
      distanceKmApprox: Math.round(r.kmToDest),
      score: Number(r.score.toFixed(4)),
      summary: `${mode.toUpperCase()}: ${r.route.originHub.name}${r.route.originHub.code ? ` (${r.route.originHub.code})` : ""} → ${r.route.destinationHub.name}${r.route.destinationHub.code ? ` (${r.route.destinationHub.code})` : ""} • ${r.route.totalMinutes} min`
    }));

    return res.status(200).json({
      ok: true,
      input: { origin: originObj, maxMinutes: maxM, mode, limit: safeLimit, minKm, avoidSameCity, avoidSameHub, preferNear },
      debug: {
        usedPaths: {
          airports: airportsPack.usedPath,
          stations: stationsPack.usedPath,
          destinations: destinationsPack.usedPath
        },
        counts: {
          destinationsTotal: destinations.length,
          resultsReturned: results.length
        }
      },
      results
    });
  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
      hint: "Controlla che i file esistano in public/data e che i nomi combacino",
      debug: { cwd: process.cwd() }
    });
  }
}
