// /api/jamo.js — CAR ONLY — v4.1
// ✅ Adds: category + radiusKm (hard filters), optional forceEuUkAll
// POST body:
// {
//   origin?: { lat:number, lon?:number, lng?:number, label?:string, country_code?:string },
//   originText?: string,
//   maxMinutes: number,
//   flavor?: "classici"|"chicche"|"famiglia",
//   category?: string,             // ✅ new: UI category/theme
//   radiusKm?: number,             // ✅ new: hard radius in km (real distance)
//   forceEuUkAll?: boolean,        // ✅ new: always use euuk_macro_all.json
//   visitedIds?: string[],
//   weekIds?: string[]
// }
//
// Response (compatible):
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
  return { lat, lon, label: "Coordinate inserite", country_code: "" };
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
      tags.includes("relax") ||
      type === "family"
    );
  }

  if (flavor === "chicche") {
    return (vis === "chicca" || tags.includes("chicca") || type === "chicca");
  }

  // classici: nessun filtro hard (lo gestiamo nello score)
  return true;
}

// ✅ Category mapping: UI category/theme -> keywords expected in tags/type/category
const CATEGORY_MAP = {
  natura: ["natura", "nature", "park", "parco", "forest", "bosco", "lake", "lago", "viewpoint", "panorama", "parco_nazionale", "national_park", "reserve", "riserva"],
  mare: ["mare", "sea", "beach", "spiaggia", "coast", "costa", "bay", "baia"],
  storia: ["storia", "history", "historic", "museum", "museo", "castle", "castello", "ruins", "archeology", "archeologia", "monument", "monumento", "heritage"],
  borghi: ["borgo", "borghi", "village", "hamlet", "old_town", "centro_storico", "medieval", "medioevale"],
  citta: ["citta", "città", "city", "town"],
  relax: ["relax", "spa", "wellness", "thermal", "terme"],
  montagna: ["montagna", "mountain", "hiking", "trail", "trekking", "summit", "peak", "alps", "dolomiti"],
  family: ["family", "famiglia", "famiglie", "bambini", "kids", "zoo", "aquarium", "theme_park", "parco_divertimenti", "playground"],
};

// ✅ hard category matcher (contains-friendly)
function categoryMatch(p, category) {
  const c = norm(category);
  if (!c) return true;

  const wanted = CATEGORY_MAP[c] || [c];

  const hay = [
    p.category,
    p.type,
    ...(Array.isArray(p.categories) ? p.categories : []),
    ...(Array.isArray(p.tags) ? p.tags : []),
    ...(Array.isArray(p.themes) ? p.themes : []),
  ]
    .filter(Boolean)
    .map(norm)
    .filter(Boolean);

  const wantedNorm = wanted.map(norm).filter(Boolean);

  // Match strategy:
  // - exact match OR substring match, to handle tags like "kids_museum" or "parco_nazionale"
  return wantedNorm.some(w => hay.some(h => h === w || h.includes(w) || w.includes(h)));
}

function estimateCarMinutes(km) {
  // più realistico sulle brevi distanze (no +8 fisso)
  const k = Math.max(0, Number(km) || 0);
  const urban = Math.min(k, 12);
  const extra = Math.max(0, k - 12);
  const min = (urban / 32) * 60 + (extra / 78) * 60;

  // overhead scalare
  const overhead =
    k < 3  ? 2 :
    k < 10 ? 4 :
    k < 30 ? 6 : 8;

  return Math.round(clamp(min + overhead, 3, 24 * 60));
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
    if (tags.includes("bambini") || type === "bambini" || type === "family") flavorBoost += 0.12;
    if (tags.includes("famiglie") || tags.includes("famiglia") || tags.includes("family")) flavorBoost += 0.10;
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
 * expects:
 * { ok:true, result:{ label, lat, lon, country_code? }, ... }
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

  const cc = String(j.result.country_code || "").toUpperCase();
  return { lat, lon, label: j.result.label || q, country_code: cc };
}

// --------- MACRO SELECT (country first, fallback all) ----------
function macroPathForCountry(countryCode, forceAll = false) {
  const cc = String(countryCode || "").trim().toLowerCase();

  // ✅ Force: all EU+UK
  if (forceAll) {
    const all = path.join(process.cwd(), "public", "data", "macros", "euuk_macro_all.json");
    if (fs.existsSync(all)) return all;
  }

  // Prefer country macro if exists
  if (cc) {
    const countryMacro = path.join(process.cwd(), "public", "data", "macros", `euuk_country_${cc}.json`);
    if (fs.existsSync(countryMacro)) return countryMacro;
  }

  // fallback: all EU+UK
  const all = path.join(process.cwd(), "public", "data", "macros", "euuk_macro_all.json");
  if (fs.existsSync(all)) return all;

  // last resort: any known IT macro (if repository has it)
  const itAbruzzo = path.join(process.cwd(), "public", "data", "macros", "it_macro_01_abruzzo.json");
  return itAbruzzo;
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

    // ✅ NEW inputs
    const category = String(body.category || body.theme || "").trim();
    const radiusKm = body.radiusKm != null ? Number(body.radiusKm) : null;
    const forceEuUkAll = !!body.forceEuUkAll;

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
    const oCC = String(o?.country_code || "").toUpperCase();

    if (Number.isFinite(oLat) && Number.isFinite(oLon)) {
      originObj = { lat: oLat, lon: oLon, label: o?.label || "", country_code: oCC };
    } else if (body.originText && String(body.originText).trim().length >= 2) {
      const g = await geocodeOnSameHost(req, String(body.originText));
      originObj = {
        lat: g.lat,
        lon: g.lon,
        label: g.label || String(body.originText),
        country_code: String(g.country_code || "").toUpperCase()
      };
    } else {
      return res.status(400).json({ error: "origin must be {lat, lon} or originText" });
    }

    // Load macro dynamically (EU+UK)
    const chosenMacroPath = macroPathForCountry(originObj.country_code, forceEuUkAll);
    const macro = readJsonSafe(chosenMacroPath, null);
    if (!macro) {
      return res.status(500).json({
        error: "Macro file not found or invalid JSON",
        hint: `Expected macro at: ${chosenMacroPath}`
      });
    }

    const places = Array.isArray(macro.places) ? macro.places : [];
    if (!places.length) {
      return res.status(500).json({ error: "Macro has no places[]" });
    }

    // primary region logic (soft boost only)
    const primaryRegion = macro?.coverage?.primary_region || "";
    const primaryCountry = String(originObj.country_code || "").toUpperCase();

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

    // ✅ Category filter (HARD)
    if (category) {
      pool = pool.filter(p => categoryMatch(p, category));
    }

    // Se famiglia e pool troppo piccolo, allarga un po' (ma resta dentro categoria se category è settata)
    if (flavor === "famiglia" && pool.length < 12) {
      const extra = normalized.filter(p => {
        const tags = getTags(p);
        const type = norm(p.type);
        const familyish =
          tags.includes("famiglie") || tags.includes("bambini") || tags.includes("family") ||
          type === "mare" || type === "natura" || type === "relax" ||
          tags.includes("spiagge") || tags.includes("lago") || tags.includes("parco_nazionale");

        if (!familyish) return false;
        if (category && !categoryMatch(p, category)) return false; // ✅ keep category constraint
        return true;
      });

      const ids = new Set(pool.map(x => String(x.id)));
      for (const e of extra) if (!ids.has(String(e.id))) pool.push(e);
    }

    // Compute distance/time + primary flag
    let enriched = pool
      .map((p) => {
        const km = haversineKm(originObj.lat, originObj.lon, p.lat, p.lon);
        const eta = estimateCarMinutes(km);

        const pArea = norm(p.area);
        const pCountry = String(p.country || "").toUpperCase();

        const isPrimary =
          (!!primaryRegion && pArea && pArea === norm(primaryRegion)) ||
          (!!primaryCountry && pCountry && pCountry === primaryCountry);

        return { ...p, _km: km, _eta: eta, _isPrimary: isPrimary };
      })
      // ✅ FIX: non scartare "vicino", basta 200m
      .filter(p => p._km >= 0.2);

    // ✅ Hard radius filter if provided
    if (Number.isFinite(radiusKm) && radiusKm > 0) {
      enriched = enriched.filter(p => p._km <= radiusKm);
    }

    const primary = enriched.filter(p => p._isPrimary);
    const others = enriched.filter(p => !p._isPrimary);

    // cap progressivo: entro tempo, poi allarga un po'
    const caps = [1.0, 1.25, 1.55, 1.85].map(m => maxMinutes * m);

    function pickWithin(list) {
      // Se radiusKm è attivo, il vincolo “tempo” diventa secondario: scegliamo comunque i migliori
      if (Number.isFinite(radiusKm) && radiusKm > 0) {
        return list.slice().sort((a, b) => a._eta - b._eta).slice(0, 180);
      }

      for (const cap of caps) {
        const within = list.filter(p => p._eta <= cap);
        if (within.length >= 8) return within;
      }
      return list.slice().sort((a, b) => a._eta - b._eta).slice(0, 120);
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
        input: {
          origin: originObj,
          maxMinutes,
          flavor,
          category,
          radiusKm: Number.isFinite(radiusKm) ? radiusKm : undefined
        },
        top: null,
        alternatives: [],
        message: "Nessuna meta trovata nel dataset per i filtri scelti.",
        debug: {
          macro_file: path.basename(chosenMacroPath),
          country_code: originObj.country_code || "",
          pool_after_flavor: pool.length,
          pool_after_category: category ? pool.length : undefined,
          radiusKm: Number.isFinite(radiusKm) ? radiusKm : undefined,
          forceEuUkAll
        }
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
        category,
        radiusKm: Number.isFinite(radiusKm) ? radiusKm : undefined,
        primary_region: primaryRegion || "",
        macro_file: path.basename(chosenMacroPath),
        forceEuUkAll
      },
      top,
      alternatives,
      debug: {
        macro: macro.id || "macro",
        macro_file: path.basename(chosenMacroPath),
        total_places: places.length,
        pool_after_flavor: normalized.filter(p => flavorMatch(p, flavor)).length,
        pool_after_category: category ? pool.length : undefined,
        origin_country_code: originObj.country_code || "",
        used_primary_first: true,
        radiusKm: Number.isFinite(radiusKm) ? radiusKm : undefined,
        forceEuUkAll
      }
    });

  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
      hint: "Check macro JSON validity and /api/geocode availability if using originText."
    });
  }
}
