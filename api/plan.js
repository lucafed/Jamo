// /api/plan.js — HUB → HUB ONLY — FINAL STABLE
// EU + UK | plane | train | bus
// NO porta-a-porta | NO auth | NO fetch esterni

import fs from "fs";
import path from "path";

/* =======================
   Utils
======================= */

function readJson(file) {
  const p = path.join(process.cwd(), "public", "data", file);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function toRad(x) {
  return (x * Math.PI) / 180;
}

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

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/* =======================
   HUB helpers
======================= */

function hubKey(h) {
  return h.code
    ? String(h.code).toUpperCase()
    : normName(h.name);
}

function nearestHub(hubs, lat, lon) {
  let best = null;
  let bestKm = Infinity;

  for (const h of hubs) {
    const hLat = Number(h.lat);
    const hLon = Number(h.lon);
    if (!Number.isFinite(hLat) || !Number.isFinite(hLon)) continue;

    const km = haversineKm(lat, lon, hLat, hLon);
    if (km < bestKm) {
      bestKm = km;
      best = h;
    }
  }

  return { hub: best, km: bestKm };
}

/* =======================
   Time estimation (HUB ONLY)
======================= */

function estimateMainMinutes(mode, km) {
  if (mode === "plane") {
    const cruise = 820;
    return Math.round(clamp((km / cruise) * 60 + 35, 35, 2400));
  }
  if (mode === "train") {
    const avg = 135;
    return Math.round(clamp((km / avg) * 60 + 8, 20, 2400));
  }
  if (mode === "bus") {
    const avg = 85;
    return Math.round(clamp((km / avg) * 60 + 8, 25, 3000));
  }
  return 9999;
}

function score({ totalMinutes, mainKm, targetMinutes }) {
  const tScore = clamp(
    1 - Math.abs(totalMinutes - targetMinutes) / Math.max(30, targetMinutes),
    0,
    1
  );
  const dScore = clamp(1 - mainKm / 1500, 0, 1);
  return 0.7 * tScore + 0.3 * dScore;
}

/* =======================
   API handler
======================= */

export default function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    const {
      origin,
      maxMinutes,
      mode,
      limit = 10,
      minMainKm,
      avoidSameHub = true
    } = req.body || {};

    const oLat = Number(origin?.lat);
    const oLon = Number(origin?.lon);
    const maxM = Number(maxMinutes);

    if (!Number.isFinite(oLat) || !Number.isFinite(oLon)) {
      return res.status(400).json({ error: "origin must be {lat, lon}" });
    }
    if (!Number.isFinite(maxM) || maxM <= 0) {
      return res.status(400).json({ error: "maxMinutes must be > 0" });
    }
    if (!["plane", "train", "bus"].includes(mode)) {
      return res.status(400).json({ error: "mode must be plane | train | bus" });
    }

    const airports = readJson("curated_airports_eu_uk.json");
    const stations = readJson("curated_stations_eu_uk.json");

    const hubs = mode === "plane" ? airports : stations;

    const { hub: originHub } = nearestHub(hubs, oLat, oLon);
    if (!originHub) {
      return res.json({ ok: true, results: [] });
    }

    const originKey = hubKey(originHub);

    const minKm =
      Number.isFinite(minMainKm)
        ? Number(minMainKm)
        : mode === "plane"
        ? 180
        : 40;

    const results = [];

    for (const dh of hubs) {
      if (!dh.lat || !dh.lon) continue;

      const destKey = hubKey(dh);
      if (avoidSameHub && destKey === originKey) continue;

      const km = haversineKm(
        Number(originHub.lat),
        Number(originHub.lon),
        Number(dh.lat),
        Number(dh.lon)
      );

      if (km < minKm) continue;

      const minutes = estimateMainMinutes(mode, km);
      if (minutes > maxM) continue;

      const s = score({
        totalMinutes: minutes,
        mainKm: km,
        targetMinutes: maxM
      });

      results.push({
        destination: {
          id: dh.code || `hub_${normName(dh.name)}`,
          name: dh.name,
          country: dh.country || "",
          lat: Number(dh.lat),
          lon: Number(dh.lon)
        },
        originHub,
        destinationHub: dh,
        segments: [
          {
            kind: "main",
            label:
              mode === "plane"
                ? `Volo ${originHub.code || "?"} → ${dh.code || "?"}`
                : mode === "train"
                ? `Treno ${originHub.name} → ${dh.name}`
                : `Bus ${originHub.name} → ${dh.name}`,
            minutes,
            km: Math.round(km)
          }
        ],
        totalMinutes: minutes,
        distanceKmApprox: Math.round(km),
        score: Number(s.toFixed(4))
      });
    }

    results.sort((a, b) => b.score - a.score);

    return res.json({
      ok: true,
      results: results.slice(0, clamp(limit, 1, 20))
    });

  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
      hint:
        "Controlla che esistano public/data/curated_airports_eu_uk.json e curated_stations_eu_uk.json"
    });
  }
}
