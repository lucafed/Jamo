// /api/jamo.js — CAR ONLY — v5.0 (EU+UK: POIs for kids categories, MACRO for destinations)
//
// POST body:
// {
//   origin?: { lat:number, lon?:number, lng?:number, label?:string, country_code?:string },
//   originText?: string,
//   maxMinutes: number,
//   category?: string,           // "family"|"theme_park"|"kids_museum"|"viewpoints"|"hiking"|... (optional)
//   flavor?: "classici"|"chicche"|"famiglia",  // optional (soft when category used)
//   visitedIds?: string[],
//   weekIds?: string[],
//   forceEuUkAll?: boolean       // optional (for macros)
// }
//
// Response:
// { ok:true, input:{...}, top:{...}, alternatives:[...], debug:{...} }

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

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
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

function estimateCarMinutes(km) {
  const k = Math.max(0, Number(km) || 0);
  const urban = Math.min(k, 12);
  const extra = Math.max(0, k - 12);
  const min = (urban / 32) * 60 + (extra / 78) * 60;
  const overhead =
    k < 3  ? 2 :
    k < 10 ? 4 :
    k < 30 ? 6 : 8;
  return Math.round(clamp(min + overhead, 3, 24 * 60));
}

function getSeason() {
  const m = new Date().getMonth() + 1;
  if (m === 11 || m === 12 || m === 1 || m === 2 || m === 3) return "winter";
  if (m === 6 || m === 7 || m === 8 || m === 9) return "summer";
  return "mid";
}

// -------------------- CATEGORY CONTROL --------------------
const POI_PRIMARY_CATEGORIES = new Set(["family", "theme_park", "kids_museum", "viewpoints", "hiking"]);

function normCategory(c) {
  const s = norm(c || "ovunque");
  return s || "ovunque";
}
function shouldUsePoisAsPrimary(category) {
  return POI_PRIMARY_CATEGORIES.has(normCategory(category));
}

// -------------------- TAGS / DETECTORS --------------------
function collectTags(p) {
  const tags = [];
  if (Array.isArray(p?.tags)) tags.push(...p.tags);
  if (p?.type) tags.push(p.type);
  if (p?.primary_category) tags.push(p.primary_category);

  // some POI builds have "osm_tags" objects; keep support
  const obj = p?.osm_tags || p?.osmtags || p?.properties?.tags || p?.properties?.osm_tags || p?.tags_obj;
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (!k) continue;
      if (v == null || v === "") tags.push(String(k));
      else tags.push(`${String(k)}=${String(v)}`);
    }
  }
  return tags.map(norm).filter(Boolean);
}

function hasAny(hay, needles) {
  const n = needles.map(norm).filter(Boolean);
  return n.some(w => hay.some(h => h === w || h.includes(w) || w.includes(h)));
}

function isSpa(tags, name) {
  return hasAny(tags, ["spa", "amenity=spa", "leisure=spa", "hot_spring", "natural=hot_spring", "public_bath", "amenity=public_bath", "terme", "thermal"]) ||
    name.includes("terme") || name.includes("spa") || name.includes("thermal") || name.includes("benessere");
}

function isWaterPark(tags, name) {
  return hasAny(tags, ["leisure=water_park", "water_park", "acquapark", "aqua park", "water park", "parco acquatico"]) ||
    name.includes("acquapark") || name.includes("aqua park") || name.includes("water park") || name.includes("parco acquatico");
}

function isThemePark(tags, name) {
  return hasAny(tags, ["tourism=theme_park", "theme_park", "parco divertimenti", "lunapark", "luna park", "giostre", "amusement_arcade"]) ||
    name.includes("parco divertimenti") || name.includes("lunapark") || name.includes("luna park") || name.includes("giostr");
}

function isZooOrAquarium(tags, name) {
  return hasAny(tags, ["tourism=zoo", "tourism=aquarium", "zoo", "aquarium", "acquario"]) ||
    name.includes("zoo") || name.includes("aquarium") || name.includes("acquario");
}

function isKidsMuseum(tags, name) {
  return hasAny(tags, ["kids_museum", "children", "children museum", "science center", "planetarium", "amenity=planetarium"]) ||
    name.includes("museo dei bambini") || name.includes("children museum") || name.includes("science center") ||
    name.includes("planetario") || name.includes("planetarium");
}

function isPlayground(tags, name) {
  return hasAny(tags, ["leisure=playground", "playground", "parco giochi", "area giochi", "trampoline"]) ||
    name.includes("parco giochi") || name.includes("area giochi") || name.includes("trampolin");
}

// winter family targets
function isSnowOrIce(tags, name) {
  return hasAny(tags, [
    "sport=skiing",
    "piste:type",
    "aerialway",
    "leisure=ice_rink",
    "ice_rink",
    "sledding",
    "snow",
    "ski",
    "pista"
  ]) || name.includes("ski") || name.includes("sci") || name.includes("pista") || name.includes("neve") || name.includes("slitt") || name.includes("pattin");
}

function isViewpoint(tags, name) {
  return hasAny(tags, ["tourism=viewpoint", "viewpoint", "belvedere", "panoram", "scenic"]) ||
    name.includes("belvedere") || name.includes("panoram") || name.includes("viewpoint");
}

function isHiking(tags, name) {
  return hasAny(tags, ["route=hiking", "hiking", "trail", "trekking", "information=guidepost", "amenity=shelter", "via ferrata", "rifugio"]) ||
    name.includes("sentiero") || name.includes("trail") || name.includes("trek") || name.includes("rifugio") || name.includes("via ferrata");
}

// strict category match used for candidate pool
function matchesCategoryStrict(p, category) {
  const c = normCategory(category);
  if (!c || c === "ovunque") return true;

  const tags = collectTags(p);
  const name = norm(p?.name);

  // IMPORTANT: family must not include spa
  if (c === "family") {
    if (isSpa(tags, name)) return false;
    return (
      isWaterPark(tags, name) ||
      isThemePark(tags, name) ||
      isZooOrAquarium(tags, name) ||
      isKidsMuseum(tags, name) ||
      isPlayground(tags, name) ||
      isSnowOrIce(tags, name)
    );
  }

  if (c === "theme_park") return isThemePark(tags, name) || isWaterPark(tags, name);
  if (c === "kids_museum") return isKidsMuseum(tags, name);
  if (c === "viewpoints") return isViewpoint(tags, name);
  if (c === "hiking") return isHiking(tags, name);

  // destination categories (macros) - keep loose for compatibility
  return true;
}

// -------------------- FLAVOR (SOFT) --------------------
function flavorMatchSoft(p, flavor, category) {
  // when category is set (and not ovunque), category is the hard filter;
  // flavor should not block results.
  const c = normCategory(category);
  if (c && c !== "ovunque") return true;

  const tags = collectTags(p);
  const vis = norm(p?.visibility);

  if (flavor === "famiglia") {
    return tags.includes("famiglia") || tags.includes("famiglie") || tags.includes("bambini") || tags.includes("family");
  }
  if (flavor === "chicche") {
    return vis === "chicca" || tags.includes("chicca");
  }
  return true;
}

function beautyScore(p) {
  const b = Number(p?.beauty_score);
  if (Number.isFinite(b)) return clamp(b, 0.2, 1.0);

  const vis = norm(p?.visibility);
  let s = 0.72;
  if (vis === "chicca") s += 0.08;
  if (vis === "conosciuta" || vis === "classica") s += 0.03;
  return clamp(s, 0.55, 0.88);
}

function seasonalFamilyBoost(p, category) {
  const c = normCategory(category);
  if (c !== "family") return 0;

  const season = getSeason();
  const tags = collectTags(p);
  const name = norm(p?.name);

  const water = isWaterPark(tags, name);
  const snow = isSnowOrIce(tags, name);
  const theme = isThemePark(tags, name);
  const zoo = isZooOrAquarium(tags, name);
  const kids = isKidsMuseum(tags, name);
  const play = isPlayground(tags, name);

  let boost = 0;

  // always good
  if (theme) boost += 0.22;
  if (zoo) boost += 0.18;
  if (kids) boost += 0.20;
  if (play) boost += 0.10;

  if (season === "summer") {
    if (water) boost += 0.40;   // 🔥 in estate vogliamo acquapark
    if (snow) boost -= 0.18;
  } else if (season === "winter") {
    if (snow) boost += 0.34;    // 🔥 in inverno vogliamo neve/ghiaccio
    if (water) boost -= 0.40;   // penalizza acquapark (stagionale)
    if (kids) boost += 0.08;    // museo kids è perfetto con freddo/pioggia
  } else {
    if (water) boost += 0.14;
    if (snow) boost += 0.12;
  }

  return boost;
}

function scoreCandidate(p, eta, km, targetMin, flavor, isPrimary, category) {
  const beauty = beautyScore(p);

  const timeFit = clamp(1 - Math.abs(eta - targetMin) / Math.max(22, targetMin * 0.85), 0, 1);
  const nearFit = clamp(1 - (eta / (targetMin * 2.2)), 0, 1);
  const regionBoost = isPrimary ? 0.06 : 0;

  let flavorBoost = 0;
  const vis = norm(p?.visibility);
  if (flavor === "chicche") flavorBoost += (vis === "chicca" ? 0.10 : -0.01);
  if (flavor === "famiglia") flavorBoost += 0.04;

  const seasonBoost = seasonalFamilyBoost(p, category);

  const ratio = eta / Math.max(1, targetMin);
  const outPenalty = ratio > 1.95 ? 0.20 : ratio > 1.65 ? 0.12 : 0;

  return (
    0.46 * timeFit +
    0.18 * nearFit +
    0.30 * beauty +
    regionBoost +
    flavorBoost +
    seasonBoost -
    outPenalty
  );
}

// -------------------- GEOCODE (same host) --------------------
async function geocodeOnSameHost(req, text) {
  const q = String(text || "").trim();
  if (!q) throw new Error("GEOCODE: empty query");

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

// -------------------- MACRO SELECT (EU+UK) --------------------
function macroPathForCountry(countryCode, forceAll = false) {
  const cc = String(countryCode || "").trim().toLowerCase();

  if (forceAll) {
    const all = path.join(process.cwd(), "public", "data", "macros", "euuk_macro_all.json");
    if (fs.existsSync(all)) return all;
  }

  if (cc) {
    const countryMacro = path.join(process.cwd(), "public", "data", "macros", `euuk_country_${cc}.json`);
    if (fs.existsSync(countryMacro)) return countryMacro;
  }

  const all = path.join(process.cwd(), "public", "data", "macros", "euuk_macro_all.json");
  if (fs.existsSync(all)) return all;

  // last resort
  const itAbruzzo = path.join(process.cwd(), "public", "data", "macros", "it_macro_01_abruzzo.json");
  return itAbruzzo;
}

// -------------------- POIS LOAD (robust paths + shapes) --------------------
function loadPoisEuUk() {
  const candidates = [
    path.join(process.cwd(), "public", "data", "pois", "pois_eu_uk.json"), // canonical
    path.join(process.cwd(), "public", "data", "pois_eu_uk.json"),         // legacy
  ];

  for (const p of candidates) {
    const j = readJsonSafe(p, null);
    if (!j) continue;

    // support shapes:
    // { meta, places:[...] }  (your build)
    // { version, pois:[...] } (old seed)
    // { places:[...] }
    // [ ... ]
    let arr = null;
    if (Array.isArray(j)) arr = j;
    else if (Array.isArray(j.places)) arr = j.places;
    else if (Array.isArray(j.pois)) arr = j.pois;

    if (Array.isArray(arr) && arr.length) {
      return { file: p, places: arr };
    }
  }

  return { file: "", places: [] };
}

// -------------------- OUTPUT MAPPER --------------------
function outPlace(p, originObj, eta, km) {
  const why = Array.isArray(p?.why) ? p.why.slice(0, 4) : [];
  const baseWhy = why.length
    ? why
    : [
        `Ci arrivi in ~${Math.round(eta)} min (stima auto).`,
        `Distanza ~${Math.round(km)} km.`,
        `Posto valido per la categoria scelta.`
      ];

  return {
    id: String(p.id),
    name: String(p.name),
    area: p.area || p.country || "",
    type: p.type || "place",
    visibility: p.visibility || "",
    beauty_score: Number.isFinite(Number(p.beauty_score)) ? Number(p.beauty_score) : undefined,
    eta_min: Math.round(eta),
    distance_km: Math.round(km),
    tags: Array.isArray(p.tags) ? p.tags.slice(0, 18) : [],
    why: baseWhy.slice(0, 4),
    gmaps: gmapsLink(originObj, { lat: Number(p.lat), lon: Number(p.lon ?? p.lng) })
  };
}

// -------------------- HANDLER --------------------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    const body = req.body || {};

    const maxMinutes = Number(body.maxMinutes ?? body.minutes);
    if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) {
      return res.status(400).json({ error: "maxMinutes must be positive" });
    }

    const category = normCategory(body.category || body.cat || "ovunque");

    const flavorRaw = norm(body.flavor || body.style || "classici");
    const flavor =
      (flavorRaw === "chicche" || flavorRaw === "gems") ? "chicche" :
      (flavorRaw === "famiglia" || flavorRaw === "family") ? "famiglia" :
      "classici";

    const visitedIds = new Set(Array.isArray(body.visitedIds) ? body.visitedIds.map(String) : []);
    const weekIds = new Set(Array.isArray(body.weekIds) ? body.weekIds.map(String) : []);

    // Origin
    let originObj = null;
    const o = body.origin || null;
    const oLat = Number(o?.lat);
    const oLon = Number(o?.lon ?? o?.lng);
    const oCC = String(o?.country_code || "").toUpperCase();

    if (Number.isFinite(oLat) && Number.isFinite(oLon)) {
      originObj = { lat: oLat, lon: oLon, label: o?.label || "", country_code: oCC };
    } else if (body.originText && String(body.originText).trim().length >= 2) {
      const g = await geocodeOnSameHost(req, String(body.originText));
      originObj = { lat: g.lat, lon: g.lon, label: g.label || String(body.originText), country_code: String(g.country_code || "").toUpperCase() };
    } else {
      return res.status(400).json({ error: "origin must be {lat, lon} or originText" });
    }

    const usePoisPrimary = shouldUsePoisAsPrimary(category);
    let source = "";
    let sourceFile = "";
    let places = [];
    let primaryRegion = "";

    if (usePoisPrimary) {
      const loaded = loadPoisEuUk();
      places = loaded.places;
      sourceFile = loaded.file ? path.relative(process.cwd(), loaded.file) : "(not found)";
      source = "pois";

      if (!places.length) {
        return res.status(500).json({
          error: "POIs dataset is empty or missing",
          hint: "Run build_pois_eu_uk_all.mjs and ensure public/data/pois/pois_eu_uk.json OR public/data/pois_eu_uk.json has {meta, places:[...]} with items."
        });
      }
    } else {
      const forceEuUkAll = !!body.forceEuUkAll;
      const chosenMacroPath = macroPathForCountry(originObj.country_code, forceEuUkAll);
      const macro = readJsonSafe(chosenMacroPath, null);
      if (!macro) {
        return res.status(500).json({
          error: "Macro file not found or invalid JSON",
          hint: `Expected macro at: ${chosenMacroPath}`
        });
      }
      places = Array.isArray(macro.places) ? macro.places : [];
      primaryRegion = macro?.coverage?.primary_region || "";
      sourceFile = `macros/${path.basename(chosenMacroPath)}`;
      source = "macro";

      if (!places.length) {
        return res.status(500).json({ error: "Macro has no places[]" });
      }
    }

    const primaryCountry = String(originObj.country_code || "").toUpperCase();

    // Normalize, drop invalid, drop visited/week
    const normalized = places
      .map((p) => {
        const lat = Number(p?.lat);
        const lon = Number(p?.lon ?? p?.lng);
        const id = String(p?.id ?? "");
        const name = String(p?.name ?? "").trim();
        if (!id || !name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        if (visitedIds.has(id)) return null;
        if (weekIds.has(id)) return null;
        return { ...p, id, name, lat, lon };
      })
      .filter(Boolean);

    // Hard filters
    let pool = normalized
      .filter(p => flavorMatchSoft(p, flavor, category))
      .filter(p => matchesCategoryStrict(p, category));

    // If strict category yields nothing (rare), don't silently switch category:
    if (!pool.length) {
      return res.status(200).json({
        ok: true,
        input: { origin: originObj, maxMinutes, flavor, category, source, sourceFile },
        top: null,
        alternatives: [],
        message: `Nessuna meta trovata per categoria "${category}" nel dataset ${source}.`,
        debug: { season: getSeason(), pool: 0, total: normalized.length, source, sourceFile }
      });
    }

    // Distance/time + primary boost (macros only, for POIs primary boost is minimal)
    const enriched = pool
      .map((p) => {
        const km = haversineKm(originObj.lat, originObj.lon, p.lat, p.lon);
        const eta = estimateCarMinutes(km);

        // avoid "sei già lì"
        if (km < (category === "family" ? 0.8 : 1.2)) return null;

        const pArea = norm(p.area);
        const pCountry = String(p.country || "").toUpperCase();

        const isPrimary =
          (!!primaryRegion && pArea && pArea === norm(primaryRegion)) ||
          (!!primaryCountry && pCountry && pCountry === primaryCountry);

        return { ...p, _km: km, _eta: eta, _isPrimary: isPrimary };
      })
      .filter(Boolean)
      // cap: within ~1.85x of target
      .filter(p => p._eta <= maxMinutes * 1.85);

    if (!enriched.length) {
      return res.status(200).json({
        ok: true,
        input: { origin: originObj, maxMinutes, flavor, category, source, sourceFile },
        top: null,
        alternatives: [],
        message: "Risultati trovati ma fuori dal tempo massimo (cap). Aumenta i minuti.",
        debug: { season: getSeason(), total_pool: pool.length, source, sourceFile }
      });
    }

    // Score
    for (const p of enriched) {
      p._score = scoreCandidate(p, p._eta, p._km, maxMinutes, flavor, p._isPrimary, category);
    }
    enriched.sort((a, b) => (b._score - a._score) || (a._eta - b._eta));

    const topRaw = enriched[0];
    const altRaw = enriched.slice(1, 3);

    const top = outPlace(topRaw, originObj, topRaw._eta, topRaw._km);
    const alternatives = altRaw.map(p => outPlace(p, originObj, p._eta, p._km));

    return res.status(200).json({
      ok: true,
      input: {
        origin: originObj,
        maxMinutes,
        flavor,
        category,
        source,
        sourceFile,
        season: getSeason()
      },
      top,
      alternatives,
      debug: {
        season: getSeason(),
        source,
        sourceFile,
        total_places_in_source: places.length,
        normalized: normalized.length,
        pool_after_filters: enriched.length,
        origin_country_code: originObj.country_code || ""
      }
    });

  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
      hint: "Check POIs file paths/shape and ensure /api/geocode works if using originText."
    });
  }
}
