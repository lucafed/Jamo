// /api/plan.js — HUB→HUB ONLY — v4 (FIX PLANE EMPTY + multi-origin hubs + sane minMainKm)
// - Usa SOLO:
//   public/data/curated_airports_eu_uk.json
//   public/data/curated_stations_eu_uk.json
// - Stima SOLO tratta HUB→HUB (no porta-a-porta)
// - FIX: plane non torna vuoto per filtri troppo aggressivi
// - FIX: considera più origin hub vicini (non solo 1)

import fs from "fs";
import path from "path";

function readJson(filename) {
  const p = path.join(process.cwd(), "public", "data", filename);
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
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

function listNearestHubs(hubs, lat, lon, take = 4) {
  const scored = [];
  for (const h of hubs) {
    const hLat = Number(h.lat);
    const hLon = Number(h.lon);
    if (!Number.isFinite(hLat) || !Number.isFinite(hLon)) continue;
    const km = haversineKm(lat, lon, hLat, hLon);
    scored.push({ h, km });
  }
  scored.sort((a, b) => a.km - b.km);
  return scored.slice(0, clamp(take, 1, 10));
}

// SOLO tratta principale (hub→hub)
function estMainMinutes(mode, km) {
  if (mode === "plane") {
    const cruise = 820;
    const overhead = 35; // taxi/attesa media
    const m = (km / cruise) * 60 + overhead;
    return Math.round(clamp(m, 35, 2400));
  }
  if (mode === "train") {
    const avg = 130;
    const overhead = 10;
    const m = (km / avg) * 60 + overhead;
    return Math.round(clamp(m, 18, 2400));
  }
  if (mode === "bus") {
    const avg = 80;
    const overhead = 10;
    const m = (km / avg) * 60 + overhead;
    return Math.round(clamp(m, 25, 3000));
  }
  return 999999;
}

// score: target time + non troppo lontano
function score({ totalMinutes, mainKm, targetMinutes, preferNear }) {
  const t = Number(totalMinutes);
  const target = Number(targetMinutes);

  const tScore = clamp(
    1 - Math.abs(t - target) / Math.max(20, target * 0.85),
    0,
    1
  );

  // 0 km => 1, 1500 km => 0
  const kScore = clamp(1 - mainKm / 1500, 0, 1);

  const nearWeight = preferNear ? 0.30 : 0.10;
  return 0.70 * tScore + nearWeight * kScore;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const body = req.body || {};
    const origin = body.origin || {};
    const mode = body.mode;
    const maxMinutes = body.maxMinutes;

    const limit = body.limit ?? 10;
    const minMainKmIn = body.minMainKm ?? null;
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

    const hubs = mode === "plane" ? airports : stations;

    // ✅ minMainKm più sensato (prima era 180 per plane = troppo aggressivo)
    const minKmDefault =
      mode === "plane" ? 60 :
      mode === "train" ? 15 :
      10;

    const minKm = Number.isFinite(Number(minMainKmIn))
      ? Number(minMainKmIn)
      : minKmDefault;

    // ✅ non un solo originHub: prendo i più vicini
    const originCandidates =
      mode === "plane"
        ? listNearestHubs(hubs, oLat, oLon, 5)
        : listNearestHubs(hubs, oLat, oLon, 4);

    if (!originCandidates.length) {
      return res.status(200).json({
        ok: true,
        input: { origin: { lat: oLat, lon: oLon, label: origin?.label || "" }, maxMinutes: maxM, mode },
        results: [],
        message: "Nessun hub trovato vicino alla partenza (dataset vuoto o coordinate errate).",
      });
    }

    const whySkipped = { tooShortKm: 0, tooLongMinutes: 0, sameHub: 0, badCoords: 0 };
    const scored = [];

    for (const oc of originCandidates) {
      const oHub = oc.h;
      const originHubKey = hubKey(oHub);

      for (const dh of hubs) {
        const dLat = Number(dh.lat);
        const dLon = Number(dh.lon);
        if (!Number.isFinite(dLat) || !Number.isFinite(dLon)) { whySkipped.badCoords++; continue; }

        const destHubKey = hubKey(dh);
        if (avoidSameHub && originHubKey && destHubKey && originHubKey === destHubKey) {
          whySkipped.sameHub++;
          continue;
        }

        const mainKm = haversineKm(Number(oHub.lat), Number(oHub.lon), dLat, dLon);
        if (Number.isFinite(minKm) && mainKm < minKm) { whySkipped.tooShortKm++; continue; }

        const mainMin = estMainMinutes(mode, mainKm);
        if (mainMin > maxM) { whySkipped.tooLongMinutes++; continue; }

        const s = score({ totalMinutes: mainMin, mainKm, targetMinutes: maxM, preferNear: !!preferNear });

        const destination = {
          id: dh.code ? String(dh.code).toUpperCase() : `hub_${normName(dh.name || "hub")}`,
          name: dh.name || dh.code || "Hub",
          country: dh.country || "",
          lat: dLat,
          lon: dLon,
        };

        const originCode = oHub.code || "?";
        const destCode = dh.code || "?";

        const label =
          mode === "plane"
            ? `Volo ${originCode} → ${destCode}`
            : mode === "train"
            ? `Treno ${oHub.name} → ${dh.name}`
            : `Bus ${oHub.name} → ${dh.name}`;

        scored.push({
          destination,
          originHub: { ...oHub },
          destinationHub: { ...dh },
          segments: [{ kind: "main", label, minutes: mainMin, km: Math.round(mainKm) }],
          totalMinutes: mainMin,
          confidence: "estimated_hub_to_hub",
          distanceKmApprox: Math.round(mainKm),
          score: Number(s.toFixed(4)),
          originHubPickKm: Number(oc.km.toFixed(1)), // quanto è lontano l'origin hub dalla tua posizione
        });
      }
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.totalMinutes - b.totalMinutes;
    });

    const safeLimit = clamp(Number(limit) || 10, 1, 30);
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
      originHubPickKm: r.originHubPickKm,
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
      },
      pickedOriginHubs: originCandidates.map(x => ({
        code: x.h.code || "",
        name: x.h.name || "",
        country: x.h.country || "",
        kmFromYou: Number(x.km.toFixed(1))
      })),
      whySkipped,
      results,
      message: results.length
        ? ""
        : `Nessuna tratta ${mode} entro ${maxM} min con i filtri attuali. (minMainKm=${minKm})`,
    });
  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
      hint:
        "Controlla che esistano public/data/curated_airports_eu_uk.json e public/data/curated_stations_eu_uk.json e che siano JSON validi (array).",
    });
  }
}
