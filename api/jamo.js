// /api/jamo.js — CAR ONLY — v4.3
// ✅ FIX: kids categories -> use POIs if present, otherwise fallback LIVE (/api/destinations)
// ✅ EU+UK macro selection stays
// ✅ category support + radiusKm support
//
// POST body:
// {
//   origin?: { lat:number, lon?:number, lng?:number, label?:string, country_code?:string },
//   originText?: string,
//   maxMinutes: number,
//   flavor?: "classici"|"chicche"|"famiglia",
//   category?: string,
//   radiusKm?: number,
//   forceEuUkAll?: boolean,
//   visitedIds?: string[],
//   weekIds?: string[]
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

// -------------------- TAGS / DETECTORS --------------------
function getTags(p) {
  const tags = [];
  if (Array.isArray(p?.tags)) tags.push(...p.tags);
  if (Array.isArray(p?.categories)) tags.push(...p.categories);
  if (Array.isArray(p?.themes)) tags.push(...p.themes);
  if (p?.type) tags.push(p.type);
  if (p?.category) tags.push(p.category);
  if (p?.kind) tags.push(p.kind);

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

function normType(t) {
  const s = norm(t);
  if (s === "borgo") return "borghi";
  if (s === "citta" || s === "città") return "citta";
  return s;
}

function hasAny(hay, needles) {
  const n = needles.map(norm).filter(Boolean);
  return n.some(w => hay.some(h => h === w || h.includes(w) || w.includes(h)));
}

function isWaterPark(tags, name) {
  return hasAny(tags, ["water_park","leisure=water_park","aquapark","aqua park","parco acquatico"]) ||
    name.includes("aquapark") || name.includes("water park") || name.includes("parco acquatico");
}
function isThemePark(tags, name) {
  return hasAny(tags, ["tourism=theme_park","theme_park","parco divertimenti","lunapark","luna park","giostre"]) ||
    name.includes("parco divertimenti") || name.includes("lunapark") || name.includes("luna park");
}
function isZooOrAquarium(tags, name) {
  return hasAny(tags, ["tourism=zoo","tourism=aquarium","zoo","acquario","aquarium"]) ||
    name.includes("zoo") || name.includes("acquario") || name.includes("aquarium");
}
function isKidsMuseum(tags, name) {
  return hasAny(tags, ["kids_museum","children museum","science center","planetarium","museo dei bambini"]) ||
    name.includes("museo dei bambini") || name.includes("children museum") ||
    name.includes("science center") || name.includes("planetario") || name.includes("planetarium");
}
function isPlayground(tags, name) {
  return hasAny(tags, ["playground","leisure=playground","parco giochi","area giochi","trampoline"]) ||
    name.includes("parco giochi") || name.includes("area giochi");
}
function isSnowPark(tags, name) {
  return hasAny(tags, ["snow","snow park","sledding","ice_rink","ski","piste","pattinaggio","slittini"]) ||
    name.includes("snow") || name.includes("sci") || name.includes("pista") || name.includes("slitt") || name.includes("pattin");
}

function categoryMatchStrict(p, category) {
  const c = norm(category);
  if (!c || c === "ovunque") return true;

  const tags = getTags(p);
  const type = normType(p?.type);
  const name = norm(p?.name);

  // kids categories
  if (c === "theme_park") return isThemePark(tags, name) || isWaterPark(tags, name);
  if (c === "kids_museum") return isKidsMuseum(tags, name);
  if (c === "viewpoints") return hasAny(tags, ["tourism=viewpoint","viewpoint","belvedere","panoram","scenic"]) || name.includes("belvedere") || name.includes("panoram");
  if (c === "hiking") return hasAny(tags, ["hiking","trail","trekking","via ferrata","rifugio","information=guidepost"]) || name.includes("sentiero") || name.includes("trail") || name.includes("trek");
  if (c === "family") {
    return (
      isThemePark(tags, name) ||
      isWaterPark(tags, name) ||
      isZooOrAquarium(tags, name) ||
      isKidsMuseum(tags, name) ||
      isPlayground(tags, name) ||
      isSnowPark(tags, name)
    );
  }

  // destinations
  if (c === "borghi") return type === "borghi" || hasAny(tags, ["place=village","place=hamlet","village","hamlet","borgo"]) || name.includes("borgo");
  if (c === "citta") return type === "citta" || hasAny(tags, ["place=city","place=town","city","town"]);
  if (c === "mare") return type === "mare" || hasAny(tags, ["natural=beach","beach","spiaggia","coast","sea"]) || name.includes("spiaggia") || name.includes("beach");
  if (c === "natura") return type === "natura" || hasAny(tags, ["nature_reserve","national_park","boundary=national_park","park","forest","lago","lake","cascata","waterfall"]);
  if (c === "storia") return type === "storia" || hasAny(tags, ["tourism=museum","museum","historic","castle","ruins","monument"]) || name.includes("castello") || name.includes("museo");
  if (c === "relax") return type === "relax" || hasAny(tags, ["spa","terme","thermal","hot_spring","public_bath"]) || name.includes("terme") || name.includes("spa");
  if (c === "montagna") return type === "montagna" || hasAny(tags, ["natural=peak","peak","mountain","rifugio","passo"]) || name.includes("monte") || name.includes("cima");

  return true;
}

// -------------------- FLAVOR (loose when category chosen) --------------------
function flavorMatchLoose(p, flavor, category) {
  const c = norm(category);
  if (c && c !== "ovunque") return true; // category is the hard filter

  const tags = getTags(p);
  const vis = norm(p?.visibility);
  const type = normType(p?.type);

  if (flavor === "famiglia") {
    return tags.includes("famiglia") || tags.includes("famiglie") || tags.includes("bambini") || tags.includes("family") || type === "bambini";
  }
  if (flavor === "chicche") {
    return (vis === "chicca" || tags.includes("chicca") || type === "chicca");
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
  const c = norm(category);
  if (c !== "family") return 0;

  const season = getSeason();
  const tags = getTags(p);
  const name = norm(p?.name);

  const water = isWaterPark(tags, name);
  const snow = isSnowPark(tags, name);
  const theme = isThemePark(tags, name);
  const zoo = isZooOrAquarium(tags, name);
  const kmuseum = isKidsMuseum(tags, name);
  const play = isPlayground(tags, name);

  let boost = 0;
  if (theme) boost += 0.20;
  if (zoo) boost += 0.16;
  if (kmuseum) boost += 0.18;
  if (play) boost += 0.10;

  if (season === "summer") {
    if (water) boost += 0.38;
    if (snow) boost -= 0.18;
  } else if (season === "winter") {
    if (snow) boost += 0.32;
    if (water) boost -= 0.35;
    if (kmuseum) boost += 0.10;
  } else {
    if (water) boost += 0.12;
    if (snow) boost += 0.10;
  }
  return boost;
}

function scoreCandidate(p, eta, km, targetMin, flavor, isPrimary, category) {
  const beauty = beautyScore(p);
  const timeFit = clamp(1 - Math.abs(eta - targetMin) / Math.max(25, targetMin * 0.85), 0, 1);
  const nearFit = clamp(1 - (eta / (targetMin * 2.2)), 0, 1);
  const regionBoost = isPrimary ? 0.08 : 0;

  let flavorBoost = 0;
  const vis = norm(p?.visibility);
  if (flavor === "chicche") flavorBoost += (vis === "chicca" ? 0.12 : -0.02);
  if (flavor === "famiglia") flavorBoost += 0.06;

  const seasonBoost = seasonalFamilyBoost(p, category);

  const ratio = eta / Math.max(1, targetMin);
  const outPenalty = ratio > 1.95 ? 0.20 : ratio > 1.65 ? 0.12 : 0;

  return (
    0.44 * timeFit +
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

// -------------------- DATA SOURCE SELECT --------------------
const POI_CATEGORIES = new Set(["family","theme_park","kids_museum","viewpoints","hiking"]);
function shouldUsePois(category) {
  return POI_CATEGORIES.has(norm(category));
}

// MACRO select
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

  const itAbruzzo = path.join(process.cwd(), "public", "data", "macros", "it_macro_01_abruzzo.json");
  return itAbruzzo;
}

// POI load
function loadPoisEuUk() {
  const p = path.join(process.cwd(), "public", "data", "pois", "pois_eu_uk.json");
  const j = readJsonSafe(p, null);
  if (!j) return [];

  // support various shapes
  if (Array.isArray(j)) return j;
  if (Array.isArray(j.pois)) return j.pois;
  if (Array.isArray(j.items)) return j.items;

  // your current seed shape:
  if (Array.isArray(j.pois) && j.pois.length) return j.pois;
  if (Array.isArray(j.pois) && !j.pois.length) return [];

  // sometimes "elements"
  if (Array.isArray(j.elements)) return j.elements;

  return [];
}

// LIVE fallback (same host): /api/destinations
async function fetchDestinationsOnSameHost(req, { lat, lon, radiusKm, cat }) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host).toString();
  const url = `${proto}://${host}/api/destinations?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&radiusKm=${encodeURIComponent(radiusKm)}&cat=${encodeURIComponent(cat)}`;

  const r = await fetch(url, { method: "GET", headers: { "Accept": "application/json" } });
  const txt = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`DESTINATIONS ${r.status}: ${txt.slice(0, 200)}`);

  let j = null;
  try { j = JSON.parse(txt); } catch {}
  const els = j?.data?.elements;
  if (!Array.isArray(els)) return [];
  return els;
}

// Map Overpass element -> generic place for scoring
function overpassElToPlace(el) {
  const tags = el?.tags || {};
  const name = String(tags.name || tags["name:it"] || tags["name:en"] || "").trim();
  if (!name) return null;

  // center for ways/relations, lat/lon for nodes
  const lat = Number(el?.lat ?? el?.center?.lat);
  const lon = Number(el?.lon ?? el?.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  // build a type-ish string
  let type = "";
  if (tags.tourism) type = String(tags.tourism);
  else if (tags.leisure) type = String(tags.leisure);
  else if (tags.amenity) type = String(tags.amenity);
  else if (tags.natural) type = String(tags.natural);
  else if (tags.historic) type = String(tags.historic);
  else if (tags.place) type = String(tags.place);

  const outTags = [];
  for (const [k, v] of Object.entries(tags)) {
    if (!k) continue;
    if (v == null || v === "") outTags.push(String(k));
    else outTags.push(`${k}=${v}`);
  }

  return {
    id: `${el.type}:${el.id}`,
    name,
    lat,
    lon,
    type,
    tags: outTags,
    visibility: "", // unknown from OSM
    area: "",
    country: ""
  };
}

// output mapper
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
    gmaps: gmapsLink(originObj, { lat: Number(p.lat), lon: Number(p.lon) })
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    const body = req.body || {};
    const maxMinutes = Number(body.maxMinutes ?? body.minutes);
    const radiusKm = body.radiusKm != null ? Number(body.radiusKm) : null;
    const category = String(body.category || body.theme || "").trim();

    const flavorRaw = norm(body.flavor || body.style || "classici");
    const flavor =
      (flavorRaw === "chicche" || flavorRaw === "gems") ? "chicche" :
      (flavorRaw === "famiglia" || flavorRaw === "family") ? "famiglia" :
      "classici";

    const forceEuUkAll = !!body.forceEuUkAll;

    const visitedIds = new Set(Array.isArray(body.visitedIds) ? body.visitedIds.map(String) : []);
    const weekIds = new Set(Array.isArray(body.weekIds) ? body.weekIds.map(String) : []);

    if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) {
      return res.status(400).json({ error: "maxMinutes must be positive" });
    }

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

    const usePois = shouldUsePois(category);

    // -------------------- LOAD DATA --------------------
    let places = [];
    let primaryRegion = "";
    let chosenFile = "";
    let source = "";

    if (usePois) {
      places = loadPoisEuUk();
      source = "pois";
      chosenFile = "pois/pois_eu_uk.json";

      // ✅ se POI vuoti -> fallback LIVE
      if (!places.length) {
        const rk = Number.isFinite(radiusKm) && radiusKm > 0 ? radiusKm : clamp(Math.round((maxMinutes / 60) * 70), 5, 250);
        const elements = await fetchDestinationsOnSameHost(req, { lat: originObj.lat, lon: originObj.lon, radiusKm: rk, cat: norm(category) || "family" });
        const mapped = elements.map(overpassElToPlace).filter(Boolean);
        places = mapped;
        source = "live";
        chosenFile = `api/destinations (${norm(category) || "family"})`;
      }
    } else {
      const chosenMacroPath = macroPathForCountry(originObj.country_code, forceEuUkAll);
      const macro = readJsonSafe(chosenMacroPath, null);
      if (!macro) {
        return res.status(500).json({ error: "Macro file not found or invalid JSON", hint: `Expected macro at: ${chosenMacroPath}` });
      }
      places = Array.isArray(macro.places) ? macro.places : [];
      primaryRegion = macro?.coverage?.primary_region || "";
      source = "macro";
      chosenFile = `macros/${path.basename(chosenMacroPath)}`;
    }

    if (!places.length) {
      return res.status(200).json({
        ok: true,
        input: { origin: originObj, maxMinutes, flavor, category, radiusKm: Number.isFinite(radiusKm) ? radiusKm : undefined },
        top: null,
        alternatives: [],
        message: "Dataset vuoto per la fonte selezionata.",
        debug: { source, file: chosenFile }
      });
    }

    const primaryCountry = String(originObj.country_code || "").toUpperCase();

    // -------------------- NORMALIZE + FILTER visited/week --------------------
    const normalized = places
      .map((p) => {
        const lat = Number(p?.lat ?? p?.latitude ?? p?.geo?.lat);
        const lon = Number(p?.lon ?? p?.lng ?? p?.longitude ?? p?.geo?.lon);
        const id = String(p?.id ?? p?.osm_id ?? p?._id ?? "");
        const name = String(p?.name ?? p?.title ?? "").trim();
        if (!name || name.length < 2) return null;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

        const pid = id || `${name}-${lat}-${lon}`;
        if (visitedIds.has(String(pid))) return null;
        if (weekIds.has(String(pid))) return null;

        return { ...p, id: pid, name, lat, lon };
      })
      .filter(Boolean);

    // -------------------- FILTER: flavor (loose) + category (strict) --------------------
    let pool = normalized
      .filter(p => flavorMatchLoose(p, flavor, category))
      .filter(p => categoryMatchStrict(p, category));

    // if strict leaves nothing (rare), relax category only for "ovunque"
    if (!pool.length && (!category || norm(category) === "ovunque")) {
      pool = normalized.filter(p => flavorMatchLoose(p, flavor, category));
    }

    // -------------------- ENRICH distance/time + hard filters --------------------
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
      .filter(p => p._km >= 0.2);

    if (Number.isFinite(radiusKm) && radiusKm > 0) {
      enriched = enriched.filter(p => p._km <= radiusKm);
    }

    // keep it sane: within ~1.85x
    enriched = enriched.filter(p => p._eta <= maxMinutes * 1.85);

    if (!enriched.length) {
      return res.status(200).json({
        ok: true,
        input: { origin: originObj, maxMinutes, flavor, category, radiusKm: Number.isFinite(radiusKm) ? radiusKm : undefined },
        top: null,
        alternatives: [],
        message: "Nessuna meta trovata nel raggio/tempo per la categoria scelta.",
        debug: { source, file: chosenFile, season: getSeason(), normalized: normalized.length }
      });
    }

    // -------------------- SCORE & PICK --------------------
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
        radiusKm: Number.isFinite(radiusKm) ? radiusKm : undefined,
        source,
        file: chosenFile
      },
      top,
      alternatives,
      debug: {
        season: getSeason(),
        source,
        file: chosenFile,
        total_places: places.length,
        normalized: normalized.length,
        pool_after_filters: enriched.length,
        origin_country_code: originObj.country_code || ""
      }
    });

  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
      hint: "If POIs are empty, make sure /api/destinations works and returns elements with center/lat/lon."
    });
  }
      }
