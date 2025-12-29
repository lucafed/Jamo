// /api/plan.js — Vercel-safe (solo public/data) — v3 HUB→HUB ONLY
// ✅ Obiettivo: proporre mete che SONO hub (aeroporti / stazioni)
// ✅ Tempo stimato = SOLO tratta principale hub→hub (NO porta-a-porta)
// POST /api/plan
// {
//   origin:{lat,lon,label?},
//   maxMinutes:number,
//   mode:"plane"|"train"|"bus",
//   limit?:number,
//   minKm?:number,          // default 80 per plane, 35 per train/bus
//   avoidSameHub?:boolean,  // default true
//   preferNear?:boolean     // default true (più vicino meglio)
// }
//
// Richiede in public/data:
// - curated_airports_eu_uk.json  (array di {name, code?, lat, lon, country?})
// - curated_stations_eu_uk.json  (array di {name, code?, lat, lon, country?})
//
// Response: { ok:true, results:[ { originHub, destinationHub, segments:[...], totalMinutes, ... } ] }

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

// SOLO tempo tratta principale hub→hub
function estMainMinutes(mode, km) {
  if (mode === "plane") {
    const cruise = 820;
    const m = (km / cruise) * 60 + 55; // check-in/boarding “medio” ma SEMPRE hub-related
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

// Score "sensato" su hub→hub:
// - vicinanza al target tempo
// - (opzionale) vicinanza geografica: evita proposte random lontane
function scoreHubTrip({ totalMinutes, kmHubToHub, targetMinutes, preferNear }) {
  const t = Number(totalMinutes);
  const target = Number(targetMinutes);

  const tScore = clamp(1 - (Math.abs(t - target) / Math.max(20, target * 0.9)), 0, 1);
  const kScore = Number.isFinite(kmHubToHub) ? clamp(1 - (kmHubToHub / 1800), 0, 1) : 0.4;

  const nearWeight = preferNear ? 0.30 : 0.10;
  return (0.70 * tScore) + (nearWeight * kScore);
}

function cleanHub(h, fallbackCountry = "") {
  return {
    id: h.id || (h.code ? String(h.code).toUpperCase() : normName(h.name).replace(/\s+/g, "_")),
    name: h.name,
    code: h.code || "",
    country: h.country || fallbackCountry || "",
    lat: Number(h.lat),
    lon: Number(h.lon)
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const body = req.body || {};
    const origin = body.origin || {};
    const maxMinutes = Number(body.maxMinutes);
    const mode = String(body.mode || "").toLowerCase();
    const limit = clamp(Number(body.limit || 8), 1, 20);

    const oLat = Number(origin.lat);
    const oLon = Number(origin.lon);

    if (!Number.isFinite(oLat) || !Number.isFinite(oLon)) {
      return res.status(400).json({ error: "origin must be {lat, lon}", got: origin });
    }
    if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) {
      return res.status(400).json({ error: "maxMinutes must be a positive number", got: body.maxMinutes });
    }
    if (!["plane", "train", "bus"].includes(mode)) {
      return res.status(400).json({ error: "mode must be one of: plane, train, bus" });
    }

    const avoidSameHub = body.avoidSameHub !== false; // default true
    const preferNear = body.preferNear !== false;     // default true

    // minKm default: per aereo alza, per train/bus ok più basso
    const minKmDefault = mode === "plane" ? 80 : 35;
    const minKm = Number.isFinite(Number(body.minKm)) ? Number(body.minKm) : minKmDefault;

    // ✅ Legge SOLO da public/data
    const airportsPack = readJsonFromPublicData("curated_airports_eu_uk.json");
    const stationsPack = readJsonFromPublicData("curated_stations_eu_uk.json");

    const airports = airportsPack.data;
    const stations = stationsPack.data;

    if (!Array.isArray(airports) || !Array.isArray(stations)) {
      return res.status(500).json({
        error: "JSON format error: expected arrays",
        debug: { usedPaths: { airports: airportsPack.usedPath, stations: stationsPack.usedPath } }
      });
    }

    // ✅ Origine: hub più vicino in base al mode
    const hubList = (mode === "plane") ? airports : stations;
    const oNearest = nearestHub(hubList, oLat, oLon);

    if (!oNearest.hub) {
      return res.status(200).json({
        ok: true,
        input: { origin: { lat: oLat, lon: oLon, label: origin.label || "" }, maxMinutes, mode, limit },
        results: [],
        message: "Nessun hub di partenza trovato nel dataset."
      });
    }

    const originHub = cleanHub(oNearest.hub);

    // ✅ Destinazioni: SONO hub (aeroporti o stazioni), non “borghi”
    const scored = [];

    for (const rawDest of hubList) {
      const destHub = cleanHub(rawDest);

      if (!destHub.name || !Number.isFinite(destHub.lat) || !Number.isFinite(destHub.lon)) continue;

      // evita stesso hub
      if (avoidSameHub) {
        const oh = hubKey(originHub);
        const dh = hubKey(destHub);
        if (oh && dh && oh === dh) continue;
      }

      const kmHubToHub = haversineKm(originHub.lat, originHub.lon, destHub.lat, destHub.lon);

      // evita “troppo vicino” (es. stessa area)
      if (Number.isFinite(minKm) && kmHubToHub < minKm) continue;

      const mainMin = estMainMinutes(mode, kmHubToHub);

      // ✅ filtro sul tempo: SOLO hub→hub
      if (mainMin > maxMinutes) continue;

      const score = scoreHubTrip({
        totalMinutes: mainMin,
        kmHubToHub,
        targetMinutes: maxMinutes,
        preferNear
      });

      scored.push({
        destination: {
          id: destHub.id,
          name: destHub.name,
          country: destHub.country || "",
          lat: destHub.lat,
          lon: destHub.lon,
          // per UI puoi usare questi per mostrare “qui è l’aeroporto/stazione”
          hubType: mode === "plane" ? "airport" : "station",
          code: destHub.code || ""
        },
        originHub: {
          id: originHub.id,
          name: originHub.name,
          country: originHub.country || "",
          lat: originHub.lat,
          lon: originHub.lon,
          hubType: mode === "plane" ? "airport" : "station",
          code: originHub.code || ""
        },
        destinationHub: {
          id: destHub.id,
          name: destHub.name,
          country: destHub.country || "",
          lat: destHub.lat,
          lon: destHub.lon,
          hubType: mode === "plane" ? "airport" : "station",
          code: destHub.code || ""
        },
        segments: [
          {
            kind: "main",
            label:
              mode === "plane"
                ? `Volo ${originHub.code || originHub.name} → ${destHub.code || destHub.name}`
                : `${mode === "train" ? "Treno" : "Bus"} ${originHub.name} → ${destHub.name}`,
            minutes: mainMin,
            km: Math.round(kmHubToHub)
          }
        ],
        totalMinutes: mainMin,
        confidence: "estimated",
        distanceKmApprox: Math.round(kmHubToHub),
        score
      });
    }

    // ordina per score desc, poi tempo asc
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.totalMinutes - b.totalMinutes;
    });

    const results = scored.slice(0, limit).map((r) => ({
      destination: r.destination,
      originHub: r.originHub,
      destinationHub: r.destinationHub,
      segments: r.segments,
      totalMinutes: r.totalMinutes,
      confidence: r.confidence,
      distanceKmApprox: r.distanceKmApprox,
      score: Number(r.score.toFixed(4)),
      summary:
        mode === "plane"
          ? `AEREO: ${(r.originHub.code || r.originHub.name)} → ${(r.destinationHub.code || r.destinationHub.name)} • ${r.totalMinutes} min`
          : `${mode.toUpperCase()}: ${r.originHub.name} → ${r.destinationHub.name} • ${r.totalMinutes} min`
    }));

    return res.status(200).json({
      ok: true,
      input: {
        origin: { lat: oLat, lon: oLon, label: origin.label || "" },
        maxMinutes,
        mode,
        limit,
        minKm,
        avoidSameHub,
        preferNear
      },
      debug: {
        usedPaths: {
          airports: airportsPack.usedPath,
          stations: stationsPack.usedPath
        },
        originHubPicked: originHub,
        counts: {
          hubsTotal: hubList.length,
          resultsReturned: results.length
        }
      },
      results
    });
  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
      hint: "Controlla che public/data/curated_airports_eu_uk.json e curated_stations_eu_uk.json esistano e siano array.",
      debug: { cwd: process.cwd() }
    });
  }
}
```0
