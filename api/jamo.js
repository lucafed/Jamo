// /api/jamo.js — CAR ONLY (offline, stable macro) — v3.1
// Uses: public/data/macros/it_macro_01_abruzzo.json
//
// POST body:
// {
//   origin?: { lat:number, lon?:number, lng?:number, label?:string },
//   originText?: string,            // optional: server will call /api/geocode?q=
//   maxMinutes: number,
//   flavor?: "classici"|"chicche"|"famiglia",
//   visitedIds?: string[],
//   weekIds?: string[]
// }
//
// Response:
// {
//   ok:true,
//   input:{...},
//   top: { id,name,area,type,visibility,eta_min,distance_km,why,gmaps,tags },
//   alternatives:[ ...2 ],
//   message?: string,
//   debug?: {...}
// }

import fs from "fs";
import path from "path";

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
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

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function tryParseLatLon(text) {
  const s = String(text || "").trim();
  const m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon, label: "Coordinate inserite" };
}

function gmapsLink(origin, dest) {
  const o = `${origin.lat},${origin.lon}`;
  const d = `${dest.lat},${dest.lon}`;
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}&travelmode=driving`;
}

function beautyScore(p) {
  const b = Number(p?.beauty_score);
  if (Number.isFinite(b)) return clamp(b, 0.2, 1.0);

  const vis = norm(p?.visibility);
  let s = 0.72;
  if (vis === "chicca") s += 0.08;
  if (vis === "conosciuta") s += 0.03;
  return clamp(s, 0.55, 0.88);
}

function getTags(p) {
  const t = Array.isArray(p?.tags) ? p.tags : [];
  return t.map(norm).filter(Boolean);
}

function flavorMatch(p, flavor) {
  const tags = getTags(p);
  const vis = norm(p?.visibility);
  const type = norm(p?.type);

  if (flavor === "famiglia") {
    return (
      tags.includes("famiglie") ||
      tags.includes("famiglia") ||
      tags.includes("bambini") ||
      type === "bambini" ||
      tags.includes("parco_nazionale") ||
      tags.includes("animali") ||
      tags.includes("spiagge") ||
      tags.includes("relax")
    );
  }

  if (flavor === "chicche") {
    return (vis === "chicca" || tags.includes("chicca") || type === "chicca");
  }

  // classici: nessun filtro hard (lo gestiamo nello score)
  return true;
}

function estimateCarMinutes(km) {
  const k = Math.max(0, Number(km) || 0);
  const urban = Math.min(k, 15);
  const extra = Math.max(0, k - 15);
  const min = (urban / 35) * 60 + (extra / 75) * 60 + 6;
  return Math.round(clamp(min, 5, 24 * 60));
}

function scoreCandidate(p, eta, km, targetMin, flavor, isPrimaryRegion) {
  const beauty = beautyScore(p);
  const timeFit = clamp(1 - Math.abs(eta - targetMin) / Math.max(25, targetMin * 0.85), 0, 1);
  const nearFit = clamp(1 - (eta / (targetMin * 2.2)), 0, 1);
  const regionBoost = isPrimaryRegion ? 0.08 : 0;

  const tags = getTags(p);
  const vis = norm(p?.visibility);
  const type = norm(p?.type);

  let flavorBoost = 0;
  if (flavor === "famiglia") {
    if (tags.includes("bambini") || type === "bambini") flavorBoost += 0.12;
    if (tags.includes("famiglie") || tags.includes("famiglia")) flavorBoost += 0.10;
    if (tags.includes("animali") || tags.includes("parco_nazionale")) flavorBoost += 0.06;
  } else if (flavor === "chicche") {
    if (vis === "chicca" || tags.includes("chicca") || type === "chicca") flavorBoost += 0.14;
    if (vis === "conosciuta" && (type === "citta" || type === "città")) flavorBoost -= 0.05;
  } else {
    if (vis === "conosciuta") flavorBoost += 0.06;
    if (type === "citta" || type === "borgo" || type === "mare" || type === "montagna") flavorBoost += 0.03;
  }

  const ratio = eta / Math.max(1, targetMin);
  const outPenalty = ratio > 1.95 ? 0.20 : ratio > 1.65 ? 0.12 : 0;

  return (
    0.46 * timeFit +
    0.18 * nearFit +
    0.32 * beauty +
    regionBoost +
    flavorBoost -
    outPenalty
  );
}

/**
 * server-side call to /api/geocode?q=... on SAME host
 * expects geocode API:
 * { ok:true, result:{ label, lat, lon }, ... }
 */
async function geocodeOnSameHost(req, text) {
  const q = String(text || "").trim();
  if (!q) throw new Error("GEOCODE: empty query");

  // ✅ se sono coordinate, niente chiamata API
  const parsed = tryParseLatLon(q);
  if (parsed) return parsed;

  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host).toString();
  const url = `${proto}://${host}/api/geocode?q=${encodeURIComponent(q)}`;

  const r = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "User-Agent": "Jamo/1.0 (server-side geocode)",
      "Cookie": req.headers.cookie || ""
    }
  });

  const bodyText = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`GEOCODE ${r.status}: ${bodyText.slice(0, 200)}`);

  let j = null;
  try { j = JSON.parse(bodyText); } catch {}
  if (!j || !j.ok || !j.result) throw new Error(`GEOCODE failed: ${bodyText.slice(0, 200)}`);

  const lat = Number(j.result.lat);
  const lon = Number(j.result.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("GEOCODE failed: invalid coords");

  return { lat, lon, label: j.result.label || q };
}

function outPlace(p, originObj, eta, km) {
  const why = Array.isArray(p?.why) ? p.why.slice(0, 4) : [];
  const baseWhy = why.length
    ? why
    : [
        `Ci arrivi in ~${Math.round(eta)} min (stima auto).`,
        `Distanza ~${Math.round(km)} km.`,
        `Posto molto valido per una gita nel tempo scelto.`
      ];

  return {
    id: String(p.id),
    name: String(p.name),
    area: p.area || "",
    type: p.type || "place",
    visibility: p.visibility || "",
    beauty_score: Number.isFinite(Number(p.beauty_score)) ? Number(p.beauty_score) : undefined,
    eta_min: Math.round(eta),
    distance_km: Math.round(km),
    tags: Array.isArray(p.tags) ? p.tags.slice(0, 18) : [],
    why: baseWhy.slice(0, 4),
    gmaps: gmapsLink(originObj, { lat: Number(p.lat), lon: Number(p.lon) })
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    const body = req.body || {};
    const maxMinutes = Number(body.maxMinutes ?? body.minutes);
    const flavorRaw = norm(body.flavor || body.style || "classici");
    const flavor =
      (flavorRaw === "chicche" || flavorRaw === "gems") ? "chicche" :
      (flavorRaw === "famiglia" || flavorRaw === "family") ? "famiglia" :
      "classici";

    const visitedIds = new Set(Array.isArray(body.visitedIds) ? body.visitedIds.map(String) : []);
    const weekIds = new Set(Array.isArray(body.weekIds) ? body.weekIds.map(String) : []);

    if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) {
      return res.status(400).json({ error: "maxMinutes must be positive" });
    }

    // Origin: coords oppure originText
    let originObj = null;

    const o = body.origin || null;
    const oLat = Number(o?.lat);
    const oLon = Number(o?.lon ?? o?.lng);

    if (Number.isFinite(oLat) && Number.isFinite(oLon)) {
      originObj = { lat: oLat, lon: oLon, label: o?.label || "" };
    } else if (body.originText && String(body.originText).trim().length >= 2) {
      const g = await geocodeOnSameHost(req, String(body.originText));
      originObj = { lat: g.lat, lon: g.lon, label: g.label || String(body.originText) };
    } else {
      return res.status(400).json({ error: "origin must be {lat, lon} or originText" });
    }

    // Load macro
    const macroPath = path.join(process.cwd(), "public", "data", "macros", "it_macro_01_abruzzo.json");
    const macro = readJsonSafe(macroPath, null);
    if (!macro) {
      return res.status(500).json({
        error: "Macro file not found or invalid JSON",
        hint: "Expected: public/data/macros/it_macro_01_abruzzo.json"
      });
    }

    const primaryRegion = macro?.coverage?.primary_region || "Abruzzo";
    const places = Array.isArray(macro.places) ? macro.places : [];
    if (!places.length) {
      return res.status(500).json({ error: "Macro has no places[]" });
    }

    // Normalize & filter validity + visited/week
    const normalized = places
      .map((p) => {
        const lat = Number(p?.lat);
        const lon = Number(p?.lon ?? p?.lng);
        if (!p || !p.id || !p.name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return { ...p, lat, lon };
      })
      .filter(Boolean)
      .filter(p => !visitedIds.has(String(p.id)))
      .filter(p => !weekIds.has(String(p.id)));

    // Flavor filter (hard)
    let pool = normalized.filter(p => flavorMatch(p, flavor));

    // Se famiglia e pool troppo piccolo, allarga un po'
    if (flavor === "famiglia" && pool.length < 12) {
      const extra = normalized.filter(p => {
        const tags = getTags(p);
        const type = norm(p.type);
        return (
          tags.includes("famiglie") || tags.includes("bambini") ||
          type === "mare" || type === "natura" || type === "relax" ||
          tags.includes("spiagge") || tags.includes("lago") || tags.includes("parco_nazionale")
        );
      });
      const ids = new Set(pool.map(x => String(x.id)));
      for (const e of extra) if (!ids.has(String(e.id))) pool.push(e);
    }

    // Compute distance/time + region flag
    const enriched = pool
      .map((p) => {
        const km = haversineKm(originObj.lat, originObj.lon, p.lat, p.lon);
        const eta = estimateCarMinutes(km);
        const isPrimary = (norm(p.area) === norm(primaryRegion));
        return { ...p, _km: km, _eta: eta, _isPrimary: isPrimary };
      })
      .filter(p => p._km >= 1.2); // scarta “sei già lì”

    const primary = enriched.filter(p => p._isPrimary);
    const others = enriched.filter(p => !p._isPrimary);

    // cap progressivo: entro tempo, poi allarga un po'
    const caps = [1.0, 1.25, 1.55, 1.85].map(m => maxMinutes * m);

    function pickWithin(list) {
      for (const cap of caps) {
        const within = list.filter(p => p._eta <= cap);
        if (within.length >= 8) return within;
      }
      return list.slice().sort((a, b) => a._eta - b._eta).slice(0, 90);
    }

    let candidateList = pickWithin(primary);

    if (candidateList.length < 8) {
      const add = pickWithin(others);
      candidateList = candidateList.concat(add);
      const seen = new Set();
      candidateList = candidateList.filter(p => {
        const id = String(p.id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
    }

    if (!candidateList.length) {
      return res.status(200).json({
        ok: true,
        input: { origin: originObj, maxMinutes, flavor },
        top: null,
        alternatives: [],
        message: "Nessuna meta trovata nel dataset per i filtri scelti."
      });
    }

    // Score & sort
    for (const p of candidateList) {
      p._score = scoreCandidate(p, p._eta, p._km, maxMinutes, flavor, p._isPrimary);
    }
    candidateList.sort((a, b) => (b._score - a._score) || (a._eta - b._eta));

    const topRaw = candidateList[0];
    const altRaw = candidateList.slice(1, 3);

    const top = outPlace(topRaw, originObj, topRaw._eta, topRaw._km);
    const alternatives = altRaw.map(p => outPlace(p, originObj, p._eta, p._km));

    return res.status(200).json({
      ok: true,
      input: {
        origin: originObj,
        maxMinutes,
        flavor,
        primary_region: primaryRegion
      },
      top,
      alternatives,
      debug: {
        macro: macro.id || "macro",
        total_places: places.length,
        pool_after_flavor: pool.length,
        used_primary_first: true
      }
    });

  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
      hint: "Check macro JSON validity and /api/geocode availability if using originText."
    });
  }
}
