// /api/plan.js — HUB→HUB ONLY (NO porta-a-porta) — v3.2 (PLANE FIX + DYNAMIC minMainKm)
// - Usa SOLO:
//   public/data/curated_airports_eu_uk.json
//   public/data/curated_stations_eu_uk.json
// - POST:
//   {
//     origin:{lat,lon,label?},
//     maxMinutes:number,
//     mode:"plane"|"train"|"bus",
//     limit?:number,
//     minMainKm?:number,
//     avoidSameHub?:boolean,
//     preferNear?:boolean
//   }
// - Output: results con originHub, destinationHub, segments=[{kind:"main",...}], totalMinutes = SOLO TRATTA HUB→HUB

import fs from "fs";
import path from "path";

function readJson(filename) {
  const p = path.join(process.cwd(), "public", "data", filename);
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw); // deve essere JSON puro (array), senza commenti
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
    if (km < bestKm) {
      bestKm = km;
      best = h;
    }
  }

  return { hub: best, km: bestKm };
}

// SOLO tratta principale (hub→hub)
function estMainMinutes(mode, km) {
  if (mode === "plane") {
    const cruise = 820;
    // ✅ più “realistico” per short-hop: overhead più basso sotto i 450km
    const overhead = km < 450 ? 25 : 35;
    const m = (km / cruise) * 60 + overhead;
    return Math.round(clamp(m, 30, 2400));
  }
  if (mode === "train") {
    const avg = 135;
    const m = (km / avg) * 60 + 8;
    return Math.round(clamp(m, 20, 2400));
  }
  if (mode === "bus") {
    const avg = 85;
    const m = (km / avg) * 60 + 8;
    return Math.round(clamp(m, 25, 3000));
  }
  const avg = 70;
  return Math.round((km / avg) * 60);
}

function dynamicMinKmPlane(maxMinutes) {
  // ✅ evita “0 risultati” quando l’utente mette 60–90 min
  if (maxMinutes <= 75) return 60;
  if (maxMinutes <= 110) return 110;
  if (maxMinutes <= 160) return 150;
  return 180;
}

function score({ totalMinutes, mainKm, targetMinutes, preferNear }) {
  const t = Number(totalMinutes);
  const target = Number(targetMinutes);

  // vicinanza al target (0..1)
  const tScore = clamp(
    1 - Math.abs(t - target) / Math.max(20, target * 0.9),
    0,
    1
  );

  // preferenza “non troppo lontano”
  const kScore = clamp(1 - mainKm / 1500, 0, 1);

  const nearWeight = preferNear ? 0.35 : 0.1;
  return 0.65 * tScore + nearWeight * kScore;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    const body = req.body || {};
    const origin = body.origin || {};
    const mode = body.mode;
    const maxMinutes = body.maxMinutes;

    const limit = body.limit ?? 10;
    const minMainKm = body.minMainKm ?? null;
    const avoidSameHub = body.avoidSameHub ?? true;
    const preferNear = body.preferNear ?? true;

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

    const airports = readJson("curated_airports_eu_uk.json");
    const stations = readJson("curated_stations_eu_uk.json");

    if (!Array.isArray(airports) || !Array.isArray(stations)) {
      return res.status(500).json({
        error: "Bad hubs JSON (expected arrays)",
        hint: "I file hubs devono essere array JSON puri (senza commenti).",
      });
    }

    // HUB list per mode
    const hubs = mode === "plane" ? airports : stations;

    // origin hub = più vicino alla posizione
    const oH = nearestHub(hubs, oLat, oLon);
    if (!oH.hub) {
      return res.status(200).json({
        ok: true,
        input: { origin: { lat: oLat, lon: oLon, label: origin?.label || "" }, maxMinutes: maxM, mode },
        results: [],
        message: "Nessun hub trovato vicino alla partenza.",
      });
    }

    const originHubKey = hubKey(oH.hub);

    // default minMainKm sensati (✅ plane dinamico)
    const minKmDefault =
      mode === "plane"
        ? dynamicMinKmPlane(maxM)
        : (mode === "train" ? 40 : 35);

    const minKm = Number.isFinite(Number(minMainKm))
      ? Number(minMainKm)
      : minKmDefault;

    const scored = [];

    for (const dh of hubs) {
      const dLat = Number(dh.lat);
      const dLon = Number(dh.lon);
      if (!Number.isFinite(dLat) || !Number.isFinite(dLon)) continue;

      const destHubKey = hubKey(dh);
      if (avoidSameHub && originHubKey && destHubKey && originHubKey === destHubKey) {
        continue;
      }

      const mainKm = haversineKm(
        Number(oH.hub.lat),
        Number(oH.hub.lon),
        dLat,
        dLon
      );

      if (Number.isFinite(minKm) && mainKm < minKm) continue;

      const mainMin = estMainMinutes(mode, mainKm);
      if (mainMin > maxM) continue; // hard cap sul tempo selezionato

      const s = score({
        totalMinutes: mainMin,
        mainKm,
        targetMinutes: maxM,
        preferNear: !!preferNear,
      });

      // destination = HUB
      const destination = {
        id: dh.code
          ? String(dh.code).toUpperCase()
          : `hub_${normName(dh.name || "hub")}`,
        name: dh.name || dh.code || "Hub",
        country: dh.country || "",
        lat: dLat,
        lon: dLon,
      };

      const originCode = oH.hub.code || "?";
      const destCode = dh.code || "?";

      const label =
        mode === "plane"
          ? `Volo ${originCode} → ${destCode}`
          : mode === "train"
          ? `Treno ${oH.hub.name} → ${dh.name}`
          : `Bus ${oH.hub.name} → ${dh.name}`;

      scored.push({
        destination,
        originHub: { ...oH.hub, nearestKmFromOrigin: Math.round(oH.km) },
        destinationHub: { ...dh },
        segments: [
          {
            kind: "main",
            label,
            minutes: mainMin,
            km: Math.round(mainKm),
          },
        ],
        totalMinutes: mainMin,
        confidence: "estimated_hub_to_hub",
        distanceKmApprox: Math.round(mainKm),
        score: Number(s.toFixed(4)),
      });
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.totalMinutes - b.totalMinutes;
    });

    const safeLimit = clamp(Number(limit) || 10, 1, 20);

    const results = scored.slice(0, safeLimit).map((r) => ({
      destination: r.destination,
      originHub: r.originHub,
      destinationHub: r.destinationHub,
      segments: r.segments,
      totalMinutes: r.totalMinutes,
      confidence: r.confidence,
      distanceKmApprox: r.distanceKmApprox,
      score: r.score,
      summary:
        `${mode.toUpperCase()}: ` +
        `${r.originHub.name}${r.originHub.code ? ` (${r.originHub.code})` : ""}` +
        ` → ` +
        `${r.destinationHub.name}${r.destinationHub.code ? ` (${r.destinationHub.code})` : ""}` +
        ` • ${r.totalMinutes} min`,
    }));

    return res.status(200).json({
      ok: true,
      input: {
        origin: { lat: oLat, lon: oLon, label: origin?.label || "" },
        maxMinutes: maxM,
        mode,
        limit: safeLimit,
        minMainKm: minKm,
        avoidSameHub,
        preferNear,
        originHubNearestKm: Math.round(oH.km),
      },
      originHubPicked: {
        code: oH.hub.code || "",
        name: oH.hub.name || "",
        country: oH.hub.country || "",
        lat: oH.hub.lat,
        lon: oH.hub.lon,
        kmFromOrigin: Math.round(oH.km),
      },
      results,
    });
  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
      hint:
        "Controlla che esistano public/data/curated_airports_eu_uk.json e public/data/curated_stations_eu_uk.json e che siano JSON validi (array).",
    });
  }
}
```0
