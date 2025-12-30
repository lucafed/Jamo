// /api/jamo.js — JAMO CORE v5 — MACRO-ONLY (STABLE DATA) + OVUNQUE + WALK/BIKE FIX + HUB→HUB BUILTIN
// ✅ car/walk/bike: SOLO da public/data/macros/<macro>.json -> places
// ✅ plane/train/bus: SOLO da public/data/macros/<macro>.json -> hubs (hub→hub stimato, hard cap <= minutes)
// ✅ categoria OVUNQUE: ignora tipo e sceglie solo per tempo/mezzo/qualità
// ✅ FIX WALK/BIKE: limiti duri km/min + caps progressivi piccoli
// ✅ Fix “treno/bus mi manda a Roma”: se hubs contiene stazioni locali, userà quelle; altrimenti warning chiaro

import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "public", "data");
const DEFAULT_MACRO_FILE = "macros/it_macro_01_abruzzo.json";

/* -------------------------
   Utils
------------------------- */
function readJsonSafe(relPath, fallback) {
  try {
    const p = path.join(DATA_DIR, relPath);
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, "utf8");
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
function normName(s) {
  return norm(s).replace(/[^a-z0-9]+/g, " ").trim();
}

function canonicalMode(raw) {
  const m = norm(raw);
  if (["car", "auto", "macchina"].includes(m)) return "car";
  if (["walk", "piedi", "a piedi"].includes(m)) return "walk";
  if (["bike", "bici", "bicicletta"].includes(m)) return "bike";
  if (["plane", "aereo", "volo"].includes(m)) return "plane";
  if (["train", "treno"].includes(m)) return "train";
  if (["bus", "pullman"].includes(m)) return "bus";
  return "car";
}

/**
 * Categoria:
 * - "ovunque" => ["any"]
 * - "citta_borghi" => ["citta","borgo"]
 * - "mare|montagna|natura|relax|bambini" => [type]
 */
function allowedTypesFromCategory(categoryRaw) {
  const c = norm(categoryRaw);
  if (c === "ovunque" || c === "any" || c === "random") return ["any"];

  if (c.includes("borgh") && c.includes("citt")) return ["citta", "borgo"];
  if (c === "citta_borghi" || (c.includes("citta") && c.includes("borg"))) return ["citta", "borgo"];
  if (c === "citta" || c === "città" || c === "city") return ["citta"];
  if (c === "borgo" || c === "borghi") return ["borgo"];
  if (["mare", "montagna", "natura", "relax", "bambini"].includes(c)) return [c];
  return ["citta", "borgo"];
}

/* -------------------------
   Local ETA estimates
------------------------- */
function avgSpeedKmh(mode) {
  if (mode === "walk") return 4.6;
  if (mode === "bike") return 15.0;
  return 70; // car
}
function estimateLocal(origin, lat, lon, mode) {
  const km = haversineKm(origin.lat, origin.lon, lat, lon);
  const eta = (km / avgSpeedKmh(mode)) * 60;
  return { km, eta };
}

/* -------------------------
   Beauty + scoring
------------------------- */
function beautyScore(p) {
  const b = Number(p?.beauty_score);
  if (Number.isFinite(b)) return clamp(b, 0.2, 1.0);

  // se non c'è beauty_score, fallback “safe”:
  const vis = norm(p?.visibility || "");
  let s = 0.65;
  if (vis === "conosciuta") s += 0.10;
  if (vis === "chicca") s += 0.06;

  const whyN = Array.isArray(p?.why) ? p.why.length : 0;
  const tagsN = Array.isArray(p?.tags) ? p.tags.length : 0;
  if (whyN >= 2) s += 0.06;
  if (tagsN >= 2) s += 0.04;

  return clamp(s, 0.55, 0.85);
}

function scoreLocal(p, eta, targetMin, style, isAny) {
  const timeFit = clamp(1 - (Math.abs(eta - targetMin) / Math.max(22, targetMin * 0.75)), 0, 1);
  const nearFit = clamp(1 - (eta / (targetMin * 1.9)), 0, 1);

  const ratio = eta / Math.max(1, targetMin);
  const outOfBandPenalty =
    (ratio < 0.55) ? 0.22 :
    (ratio > 1.65) ? 0.18 :
    0;

  const beauty = beautyScore(p);

  const vis = norm(p.visibility || "");
  const types = Array.isArray(p.types) ? p.types.map(norm) : [];

  const bigCityPenalty = (style === "gems" && types.includes("citta") && vis === "conosciuta") ? 0.12 : 0;
  const randomPenalty = (!isAny && style === "known" && beauty < 0.60) ? 0.14 : 0;

  return (0.50 * timeFit) + (0.18 * nearFit) + (0.32 * beauty) - outOfBandPenalty - bigCityPenalty - randomPenalty;
}

/* -------------------------
   Hard limits for walk/bike (anti-2000km)
------------------------- */
function hardLimitsForMode(mode, minutes) {
  if (mode === "walk") {
    const km = clamp((minutes / 60) * 5.5, 1.5, 18);
    return { maxKm: km, maxEta: minutes * 1.35 };
  }
  if (mode === "bike") {
    const km = clamp((minutes / 60) * 18, 3, 65);
    return { maxKm: km, maxEta: minutes * 1.40 };
  }
  return { maxKm: Infinity, maxEta: minutes * 2.60 };
}

/* -------------------------
   Macro parsing (tollerante)
------------------------- */
function normalizeTypes(x) {
  const t =
    Array.isArray(x?.types) ? x.types :
    (Array.isArray(x?.type) ? x.type :
      (x?.type ? [x.type] : []));
  return t.map(norm).filter(Boolean);
}

function normalizePlace(p) {
  const lat = Number(p?.lat);
  const lng = Number(p?.lng ?? p?.lon);
  if (!p || !p.id || !p.name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    id: String(p.id),
    name: String(p.name),
    country: p.country || "IT",
    region: p.region || "",
    lat, lng,
    types: normalizeTypes(p),
    visibility: p.visibility || "",
    beauty_score: Number(p.beauty_score),
    why: Array.isArray(p.why) ? p.why : [],
    what_to_do: Array.isArray(p.what_to_do) ? p.what_to_do : [],
    what_to_eat: Array.isArray(p.what_to_eat) ? p.what_to_eat : [],
    tags: Array.isArray(p.tags) ? p.tags : []
  };
}

function normalizeHub(h) {
  const lat = Number(h?.lat);
  const lon = Number(h?.lon ?? h?.lng);
  if (!h || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const type = norm(h?.type || h?.hubType || "");
  const code = String(h?.code || "").trim();
  const name = String(h?.name || h?.city || h?.label || "Hub").trim();

  return {
    type: type || "hub",
    code,
    name,
    city: h?.city || "",
    country: h?.country || "IT",
    lat,
    lon
  };
}

function parseMacro(macroObj) {
  const placesRaw =
    Array.isArray(macroObj?.places) ? macroObj.places :
    Array.isArray(macroObj?.data?.places) ? macroObj.data.places :
    [];

  const places = placesRaw.map(normalizePlace).filter(Boolean);

  // hubs tollerante: hubs.airports / hubs.stations / hubs.bus oppure flat arrays
  const hubsObj = macroObj?.hubs || macroObj?.data?.hubs || {};
  const airportsRaw = Array.isArray(hubsObj?.airports) ? hubsObj.airports : (Array.isArray(macroObj?.airports) ? macroObj.airports : []);
  const stationsRaw = Array.isArray(hubsObj?.stations) ? hubsObj.stations : (Array.isArray(macroObj?.stations) ? macroObj.stations : []);
  const busRaw      = Array.isArray(hubsObj?.bus)      ? hubsObj.bus      : (Array.isArray(macroObj?.bus) ? macroObj.bus : []);

  const airports = airportsRaw.map(normalizeHub).filter(Boolean);
  const stations = stationsRaw.map(normalizeHub).filter(Boolean);
  const bus      = busRaw.map(normalizeHub).filter(Boolean);

  return { places, hubs: { airports, stations, bus } };
}

/* -------------------------
   HUB→HUB estimate (built-in, stable)
------------------------- */
function estMainMinutes(mode, km) {
  if (mode === "plane") {
    const cruise = 820;
    const m = (km / cruise) * 60 + 35; // overhead hub→hub
    return Math.round(clamp(m, 35, 2400));
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
  return Math.round((km / 70) * 60);
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
    const km = haversineKm(lat, lon, Number(h.lat), Number(h.lon));
    if (km < bestKm) { bestKm = km; best = h; }
  }
  return { hub: best, km: bestKm };
}

function scoreHubCandidate({ mainMin, mainKm, targetMin, preferNear = true }) {
  const tScore = clamp(1 - (Math.abs(mainMin - targetMin) / Math.max(18, targetMin * 0.60)), 0, 1);
  const kScore = clamp(1 - (mainKm / 1600), 0, 1);
  const nearWeight = preferNear ? 0.18 : 0.08;
  return (0.82 * tScore) + (nearWeight * kScore);
}

function nearbyPlacesByType(places, lat, lon, wantedType, maxKm = 90, limit = 6) {
  const out = [];
  for (const p of places) {
    const types = Array.isArray(p.types) ? p.types : [];
    if (!types.includes(wantedType)) continue;
    const km = haversineKm(lat, lon, p.lat, p.lng);
    if (km > maxKm) continue;
    out.push({ p, km, b: beautyScore(p) });
  }
  out.sort((a, b) => (b.b - a.b) || (a.km - b.km));
  return out.slice(0, limit).map(x => `${x.p.name} (~${Math.round(x.km)} km)`);
}

/* -------------------------
   Output shape
------------------------- */
function outLocal(p) {
  const types = Array.isArray(p.types) ? p.types : [];
  return {
    id: p.id,
    name: p.country ? `${p.name}, ${p.country}` : p.name,
    country: p.country || "",
    type: types[0] || "place",
    visibility: p.visibility || "",
    eta_min: Math.round(p.eta_min),
    distance_km: Math.round(p.distance_km),
    why: Array.isArray(p.why) ? p.why.slice(0, 4) : [],
    what_to_do: Array.isArray(p.what_to_do) ? p.what_to_do.slice(0, 6) : [],
    what_to_eat: Array.isArray(p.what_to_eat) ? p.what_to_eat.slice(0, 5) : [],
    segments: Array.isArray(p.segments) ? p.segments : []
  };
}

function outHub(c) {
  return {
    id: c.id,
    name: c.name,
    country: c.country || "",
    type: c.type || "hub",
    visibility: c.visibility || "",
    eta_min: Math.round(c.eta_min),
    distance_km: Math.round(c.distance_km),
    hubSummary: c.hubSummary,
    segments: Array.isArray(c.segments) ? c.segments : [],
    why: Array.isArray(c.why) ? c.why.slice(0, 4) : [],
    what_to_do: Array.isArray(c.what_to_do) ? c.what_to_do.slice(0, 6) : [],
    what_to_eat: Array.isArray(c.what_to_eat) ? c.what_to_eat.slice(0, 5) : []
  };
}

/* -------------------------
   Handler
------------------------- */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    const body = req.body || {};
    const origin = body.origin || {};
    const minutes = Number(body.minutes);
    const mode = canonicalMode(body.mode || "car");
    const style = norm(body.style || "known");
    const allowedTypes = allowedTypesFromCategory(body.category || "citta_borghi");

    const visitedIds = new Set(Array.isArray(body.visitedIds) ? body.visitedIds : []);
    const weekIds = new Set(Array.isArray(body.weekIds) ? body.weekIds : []);

    const oLat = Number(origin.lat);
    const oLon = Number(origin.lon ?? origin.lng);
    if (!Number.isFinite(oLat) || !Number.isFinite(oLon)) {
      return res.status(400).json({ error: "origin must be {lat, lon}" });
    }
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return res.status(400).json({ error: "minutes must be positive" });
    }

    // macro selection (future-ready): body.macroFile oppure default
    const macroFile = String(body.macroFile || DEFAULT_MACRO_FILE).replace(/^\/+/, "");
    const macroObj = readJsonSafe(macroFile, null);
    if (!macroObj) {
      return res.status(500).json({
        error: `Macro file not found: ${macroFile}`,
        hint: `Crea ${DEFAULT_MACRO_FILE} oppure passa { macroFile:"macros/..." }`
      });
    }

    const { places, hubs } = parseMacro(macroObj);
    if (!Array.isArray(places) || !places.length) {
      return res.status(500).json({
        error: "Macro places missing/empty",
        hint: `Nel macro deve esserci "places":[...] con id,name,lat,lon/lng,types`
      });
    }

    const originObj = { lat: oLat, lon: oLon, label: origin.label || "" };

    const isAny = allowedTypes[0] === "any";
    const specialCat = (!isAny && ["mare", "montagna", "natura", "relax", "bambini"].includes(allowedTypes[0]));

    /* =========================================================
       A) PLANE / TRAIN / BUS  => HUB→HUB (from macro hubs)
    ========================================================= */
    if (mode === "plane" || mode === "train" || mode === "bus") {
      const hubList =
        mode === "plane" ? hubs.airports :
        mode === "train" ? hubs.stations :
        hubs.bus;

      if (!Array.isArray(hubList) || hubList.length < 2) {
        return res.status(200).json({
          ok: true,
          top: null,
          alternatives: [],
          message: `Dataset hub (${mode}) vuoto o troppo piccolo nel macro. Aggiungi hubs.${mode === "plane" ? "airports" : mode === "train" ? "stations" : "bus"} nel file.`,
        });
      }

      // origin hub
      const oH = nearestHub(hubList, oLat, oLon);
      if (!oH.hub) {
        return res.status(200).json({ ok: true, top: null, alternatives: [], message: "Nessun hub trovato." });
      }

      const originHubKey = hubKey(oH.hub);
      const warnKm = (mode === "train" || mode === "bus") ? 60 : 120;
      const originHubWarning =
        Number.isFinite(oH.km) && oH.km > warnKm
          ? `Nota: l’hub più vicino è a ~${Math.round(oH.km)} km (aggiungi hub più vicini nel macro).`
          : "";

      // min distance sensata (evita suggerire “stessa zona” con aereo/treno/bus)
      const minKmDefault =
        mode === "plane" ? 180 :
        mode === "train" ? 40 :
        35;

      const candidates = [];

      for (const dh of hubList) {
        const destHubKey = hubKey(dh);
        if (destHubKey && originHubKey && destHubKey === originHubKey) continue;

        const mainKm = haversineKm(Number(oH.hub.lat), Number(oH.hub.lon), Number(dh.lat), Number(dh.lon));
        if (mainKm < minKmDefault) continue;

        const mainMin = estMainMinutes(mode, mainKm);

        // ✅ HARD CAP: mai sopra i minuti scelti
        if (mainMin > minutes) continue;

        const destName = dh.city || dh.name || dh.code || "Hub";
        const id = (dh.code ? String(dh.code).toUpperCase() : `hub_${normName(destName)}`) + `_${mode}`;
        if (visitedIds.has(id) || weekIds.has(id)) continue;

        let whatToDo = [];
        let extraWhy = [];

        // Se categoria speciale: suggerisco *places* vicine al DEST hub (sempre dal macro, stabile)
        if (specialCat) {
          const near = nearbyPlacesByType(places, Number(dh.lat), Number(dh.lon), allowedTypes[0], 90, 6);
          if (near.length) {
            whatToDo = near;
            extraWhy.push(`Vicino a questo hub trovi ${allowedTypes[0]} veri (dal dataset stabile).`);
          } else {
            extraWhy.push(`Non ho abbastanza ${allowedTypes[0]} vicino a questo hub nel dataset: scelgo comunque la tratta migliore col tuo tempo.`);
          }
        }

        const hubSummary =
          mode === "plane"
            ? `${(oH.hub.code || "?")} → ${(dh.code || "?")}`
            : `${(oH.hub.name || oH.hub.code || "?")} → ${(dh.name || dh.code || "?")}`;

        const score = scoreHubCandidate({ mainMin, mainKm, targetMin: minutes, preferNear: true });

        const whyBase = [
          `Tratta ${mode.toUpperCase()} stimata: ~${Math.round(mainMin)} min (hub→hub).`,
          `Hub: ${hubSummary}.`,
          isAny
            ? "Categoria: OVUNQUE (scelgo solo per tempo/mezzo/qualità)."
            : (specialCat
                ? `Categoria richiesta: ${allowedTypes[0]} (ti segnalo opzioni vicine all’hub).`
                : (style === "gems" ? "Preferisco mete più particolari." : "Preferisco mete solide e facili.")
              )
        ];

        const why = [...whyBase, originHubWarning, ...extraWhy].filter(Boolean).slice(0, 4);

        candidates.push({
          id,
          name: destName + (dh.country ? `, ${dh.country}` : ""),
          country: dh.country || "",
          type: "hub",
          visibility: style === "gems" ? "chicca" : "conosciuta",
          eta_min: mainMin,
          distance_km: Math.round(mainKm),
          hubSummary,
          segments: [{
            kind: "main",
            label:
              mode === "plane"
                ? `Volo ${(oH.hub.code || "?")} → ${(dh.code || "?")}`
                : (mode === "train"
                    ? `Treno ${oH.hub.name} → ${dh.name}`
                    : `Bus ${oH.hub.name} → ${dh.name}`),
            minutes: mainMin,
            km: Math.round(mainKm)
          }],
          what_to_do: whatToDo,
          what_to_eat: [],
          why,
          _score: Number(score.toFixed(6))
        });
      }

      if (!candidates.length) {
        return res.status(200).json({
          ok: true,
          top: null,
          alternatives: [],
          message: `Nessuna tratta ${mode} entro ${minutes} min con gli hub attuali. (Oppure manca qualche hub vicino).`
        });
      }

      candidates.sort((a, b) => (b._score - a._score) || (a.eta_min - b.eta_min));
      const top = candidates[0];
      const alts = candidates.slice(1, 3);

      return res.status(200).json({
        ok: true,
        top: outHub(top),
        alternatives: alts.map(outHub),
        debug: { source: "macro_hub_only", macroFile, mode, minutes, category: allowedTypes[0], originHubKm: Math.round(oH.km) }
      });
    }

    /* =========================================================
       B) CAR / WALK / BIKE  => PLACES (from macro places)
    ========================================================= */
    const hard = hardLimitsForMode(mode, minutes);

    // estimate distance/eta + exclude “sei già lì”
    const base = places
      .filter(p => !visitedIds.has(p.id))
      .filter(p => !weekIds.has(p.id))
      .map(p => {
        const { km, eta } = estimateLocal(originObj, p.lat, p.lng, mode);
        return { ...p, distance_km: km, eta_min: eta };
      })
      .filter(p => p.distance_km >= 1.2);

    let pool = base.filter(p => {
      if (p.distance_km > hard.maxKm) return false;
      if (p.eta_min > hard.maxEta) return false;

      if (isAny) return true;

      const want = allowedTypes;
      const t = Array.isArray(p.types) ? p.types : [];

      if (want.length === 1 && ["mare", "montagna", "natura", "relax", "bambini"].includes(want[0])) {
        return t.includes(want[0]);
      }
      if (want.includes("citta") || want.includes("borgo")) {
        return want.some(x => t.includes(x));
      }
      return true;
    });

    // qualità minima (più severa su walk/bike)
    pool = pool.filter(p => {
      const b = beautyScore(p);
      if ((mode === "walk" || mode === "bike") && b < 0.68) return false;
      return true;
    });

    // caps progressivi per mezzo
    const capMult =
      mode === "walk" ? [1.10, 1.22, 1.35] :
      mode === "bike" ? [1.10, 1.28, 1.45] :
      [1.20, 1.45, 1.85, 2.60];

    const caps = capMult.map(x => minutes * x);

    let within = [];
    let usedCap = caps[caps.length - 1];

    for (const cap of caps) {
      const tmp = pool.filter(p => p.eta_min <= cap);
      if (tmp.length >= 6) { within = tmp; usedCap = cap; break; }
    }

    if (!within.length) {
      within = pool.slice().sort((a, b) => a.eta_min - b.eta_min).slice(0, 60);
    }

    if (!within.length) {
      return res.status(200).json({ ok: true, top: null, alternatives: [], message: "Nessuna meta trovata nel dataset macro." });
    }

    within.forEach(p => {
      p._score = scoreLocal(p, p.eta_min, minutes, style, isAny);
    });
    within.sort((a, b) => b._score - a._score);

    const top = within[0];
    const alts = within.slice(1, 3);

    const fallbackNote = (usedCap > minutes * 1.35 && mode === "car")
      ? `Per trovare abbastanza mete ho allargato: fino a ~${Math.round(usedCap)} min (stima).`
      : "";

    function buildWhy(p) {
      const arr = Array.isArray(p.why) ? p.why.slice(0, 3) : [];
      const out = [];

      if (fallbackNote) out.push(fallbackNote);

      if (arr.length) {
        out.push(...arr);
      } else {
        out.push(`Ci arrivi in ~${Math.round(p.eta_min)} min: coerente col tempo selezionato.`);
        out.push(isAny
          ? "Categoria: OVUNQUE (scelgo solo per tempo/mezzo/qualità)."
          : (style === "gems" ? "È più particolare / fuori dai soliti giri." : "È una meta solida e facile da godere.")
        );
      }

      out.push("Tip: qui puoi inserire CTA (esperienze, tour, ristoranti, hotel).");
      return out.slice(0, 4);
    }

    top.why = buildWhy(top);
    alts.forEach(a => { a.why = buildWhy(a); });

    return res.status(200).json({
      ok: true,
      top: outLocal(top),
      alternatives: alts.map(outLocal),
      debug: { source: "macro_places_only", macroFile, mode, minutes, category: allowedTypes[0], pool: within.length }
    });

  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
      hint: `Controlla il macro: public/data/${DEFAULT_MACRO_FILE} deve contenere places[] e hubs{}`
    });
  }
}
