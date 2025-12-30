// /api/jamo.js — JAMO CORE v3 (EU+UK) — FINAL FIX (PLAN 401 FIX INCLUDED)
// ✅ car/walk/bike: luoghi "belli" usando curated + POI + index (EU+UK)
// ✅ plane/train/bus: SOLO HUB→HUB via /api/plan (NIENTE borghi, NIENTE ricuciture)
// ✅ categoria mare/montagna/natura/relax/bambini: per aereo/treno/bus suggerisce POI vicini alla città-hub (fallback onesto)
// ✅ tempo: spinge mete diverse in base al target (1h ≠ 2h)
// ✅ FIX 401 "Authentication Required": /api/plan chiamata sullo stesso host reale + Cookie forward

import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "public", "data");

function readJsonSafe(filename, fallback) {
  try {
    const p = path.join(DATA_DIR, filename);
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

function allowedTypesFromCategory(categoryRaw) {
  const c = norm(categoryRaw);
  if (c.includes("borgh") && c.includes("citt")) return ["citta", "borgo"];
  if (c === "citta_borghi" || (c.includes("citta") && c.includes("borg"))) return ["citta", "borgo"];
  if (c === "citta" || c === "città" || c === "city") return ["citta"];
  if (c === "borgo" || c === "borghi") return ["borgo"];
  if (["mare", "montagna", "natura", "relax", "bambini"].includes(c)) return [c];
  return ["citta", "borgo"];
}

function avgSpeedKmh(mode) {
  if (mode === "walk") return 4.5;
  if (mode === "bike") return 15;
  return 70;
}
function estimateLocal(origin, lat, lon, mode) {
  const km = haversineKm(origin.lat, origin.lon, lat, lon);
  const eta = (km / avgSpeedKmh(mode)) * 60;
  return { km, eta };
}

// “quanto è bello” (proxy): curated>pois>index. Se c'è beauty_score lo usa.
function beautyScore(p) {
  const b = Number(p.beauty_score);
  if (Number.isFinite(b)) return clamp(b, 0.2, 1.0);

  const src = p._source || "";
  if (src === "curated") return 0.92;
  if (src === "pois") return 0.82;

  // index: spesso rumoroso → basso di default
  const vis = norm(p.visibility || "");
  const whyN = Array.isArray(p.why) ? p.why.length : 0;
  const tagsN = Array.isArray(p.tags) ? p.tags.length : 0;
  let s = 0.58;
  if (vis === "conosciuta") s += 0.10;
  if (vis === "chicca") s += 0.06;
  if (whyN >= 2) s += 0.06;
  if (tagsN >= 2) s += 0.04;
  return clamp(s, 0.45, 0.82);
}

// score locale: forza “diverso col tempo” (timeFit forte) + evita posti troppo piccoli/brutti
function scoreLocal(p, eta, targetMin, style) {
  const timeFit = clamp(1 - (Math.abs(eta - targetMin) / Math.max(22, targetMin * 0.75)), 0, 1);
  const nearFit = clamp(1 - (eta / (targetMin * 1.9)), 0, 1);

  const ratio = eta / Math.max(1, targetMin);
  const outOfBandPenalty =
    (ratio < 0.55) ? 0.22 :
    (ratio > 1.65) ? 0.18 :
    0;

  const beauty = beautyScore(p);

  const vis = norm(p.visibility || "");
  const types = Array.isArray(p.types) ? p.types : (p.type ? [p.type] : []);

  const bigCityPenalty = (style === "gems" && types.includes("citta") && vis === "conosciuta") ? 0.12 : 0;
  const randomPenalty = (style === "known" && beauty < 0.60) ? 0.14 : 0;

  return (0.50 * timeFit) + (0.18 * nearFit) + (0.32 * beauty) - outOfBandPenalty - bigCityPenalty - randomPenalty;
}

/**
 * ✅ Call /api/plan server-side sullo STESSO HOST della request (evita "seven" o domini sbagliati)
 * ✅ Inoltra Cookie per bypassare eventuale protection che genera 401 "Authentication Required"
 */
async function callPlan(req, origin, maxMinutes, mode) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host  = (req.headers["x-forwarded-host"] || req.headers.host).toString();
  const url = `${proto}://${host}/api/plan`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": req.headers.cookie || ""
    },
    body: JSON.stringify({
      origin,
      maxMinutes,
      mode,
      limit: 30,
      minMainKm: mode === "plane" ? 180 : (mode === "train" ? 40 : 35),
      avoidSameHub: true,
      preferNear: true
    })
  });

  const text = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`PLAN ${r.status}: ${text.slice(0, 220)}`);
  return JSON.parse(text);
}

// trova POI vicini alla destinazione hub (per mare/montagna/natura/relax/bambini)
function nearbyPois(poisPack, lat, lon, wantedType, maxKm = 85, limit = 6) {
  const list = Array.isArray(poisPack?.pois) ? poisPack.pois : [];
  const out = [];
  for (const p of list) {
    const types = Array.isArray(p.types) ? p.types : [];
    if (!types.includes(wantedType)) continue;
    const plat = Number(p.lat), plon = Number(p.lng);
    if (!Number.isFinite(plat) || !Number.isFinite(plon)) continue;
    const km = haversineKm(lat, lon, plat, plon);
    if (km > maxKm) continue;
    out.push({ ...p, _km: km });
  }
  out.sort((a, b) => (b.beauty_score || 0) - (a.beauty_score || 0) || a._km - b._km);
  return out.slice(0, limit).map(x => `${x.name} (~${Math.round(x._km)} km)`);
}

function outLocal(p) {
  const types = Array.isArray(p.types) ? p.types : (p.type ? [p.type] : []);
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
    what_to_eat: Array.isArray(p.what_to_eat) ? p.what_to_eat.slice(0, 5) : []
  };
}

function outPlanHub(candidate) {
  return {
    id: candidate.id,
    name: candidate.name,
    country: candidate.country || "",
    type: candidate.type || "citta",
    visibility: candidate.visibility || "",
    eta_min: Math.round(candidate.eta_min),
    distance_km: Math.round(candidate.distance_km),
    hubSummary: candidate.hubSummary,
    segments: Array.isArray(candidate.segments) ? candidate.segments : [],
    why: Array.isArray(candidate.why) ? candidate.why.slice(0, 4) : [],
    what_to_do: Array.isArray(candidate.what_to_do) ? candidate.what_to_do.slice(0, 6) : [],
    what_to_eat: Array.isArray(candidate.what_to_eat) ? candidate.what_to_eat.slice(0, 5) : []
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    const body = req.body || {};
    const origin = body.origin || {};
    const minutes = Number(body.minutes);
    const mode = canonicalMode(body.mode || "car");
    const style = norm(body.style || "known"); // known|gems
    const allowedTypes = allowedTypesFromCategory(body.category || "citta_borghi");

    const visitedIds = new Set(Array.isArray(body.visitedIds) ? body.visitedIds : []);
    const weekIds = new Set(Array.isArray(body.weekIds) ? body.weekIds : []);

    const oLat = Number(origin.lat);
    const oLon = Number(origin.lon ?? origin.lng); // accetta lon o lng
    if (!Number.isFinite(oLat) || !Number.isFinite(oLon)) {
      return res.status(400).json({ error: "origin must be {lat, lon}" });
    }
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return res.status(400).json({ error: "minutes must be positive" });
    }

    const originObj = { lat: oLat, lon: oLon, label: origin.label || "" };
    const specialCat = ["mare", "montagna", "natura", "relax", "bambini"].includes(allowedTypes[0]);

    /* =========================================================
       A) PLANE / TRAIN / BUS  => SOLO HUB→HUB via /api/plan
       (NO luoghi, NO borghi, NO ricuciture)
    ========================================================= */
    if (mode === "plane" || mode === "train" || mode === "bus") {
      const plan = await callPlan(req, originObj, minutes, mode);
      const results = Array.isArray(plan?.results) ? plan.results : [];
      if (!results.length) {
        return res.status(200).json({ ok: true, top: null, alternatives: [], message: "Nessuna tratta hub→hub trovata." });
      }

      // POI per suggerimenti vicino all’hub (solo se categoria speciale)
      const poisPack = readJsonSafe("pois_eu_uk.json", { pois: [] });

      const candidates = results
        .map((r) => {
          const oh = r.originHub || {};
          const dh = r.destinationHub || {};
          const segs = Array.isArray(r.segments) ? r.segments : [];
          const main = segs.find(s => s.kind === "main") || segs[0] || null;

          const destName = dh.city || dh.name || dh.code || "Hub";
          const id = (dh.code ? String(dh.code).toUpperCase() : `hub_${normName(destName)}`) + `_${mode}`;

          if (visitedIds.has(id) || weekIds.has(id)) return null;

          const total = Number(r.totalMinutes);
          const mainMin = Number(main?.minutes ?? total);
          const kmApprox = Number(r.distanceKmApprox);
          const dist = Number.isFinite(kmApprox) ? kmApprox : 0;

          let whatToDo = [];
          let extraWhy = [];

          if (specialCat) {
            const lat = Number(dh.lat);
            const lon = Number(dh.lon);
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
              const near = nearbyPois(poisPack, lat, lon, allowedTypes[0], 90, 6);
              if (near.length) {
                whatToDo = near;
                extraWhy.push(`Vicino a questo hub trovi ${allowedTypes[0]} veri.`);
              } else {
                extraWhy.push(`Non ho abbastanza ${allowedTypes[0]} classificati vicino a questo hub: scelgo comunque la tratta migliore col tuo tempo.`);
              }
            }
          }

          const timeFit = clamp(1 - (Math.abs(mainMin - minutes) / Math.max(25, minutes * 0.75)), 0, 1);
          const ratio = mainMin / Math.max(1, minutes);
          const outBand = (ratio < 0.55) ? 0.20 : (ratio > 1.70) ? 0.14 : 0;

          const score = (0.78 * timeFit) + (0.22 * clamp(1 - (dist / 1600), 0, 1)) - outBand;

          const hubSummary =
            mode === "plane"
              ? `${(oh.code || "?")} → ${(dh.code || "?")}`
              : `${(oh.name || oh.code || "?")} → ${(dh.name || dh.code || "?")}`;

          const whyBase = [
            `Tratta ${mode.toUpperCase()} stimata: ~${Math.round(mainMin)} min (hub→hub).`,
            `Hub: ${hubSummary}.`,
            specialCat
              ? `Categoria richiesta: ${allowedTypes[0]} (ti segnalo opzioni vicine all’hub).`
              : (style === "gems" ? "Preferisco mete più particolari." : "Preferisco mete solide e facili.")
          ];

          return {
            id,
            name: destName + (dh.country ? `, ${dh.country}` : ""),
            country: dh.country || "",
            type: "citta",
            visibility: style === "gems" ? "chicca" : "conosciuta",
            eta_min: mainMin,
            distance_km: dist,
            hubSummary,
            segments: main
              ? [{ kind: "main", label: String(main.label || "Tratta principale"), minutes: mainMin, km: main.km }]
              : [{ kind: "main", label: "Tratta principale", minutes: mainMin }],
            what_to_do: whatToDo,
            what_to_eat: [],
            why: [...whyBase, ...extraWhy].slice(0, 4),
            _score: score
          };
        })
        .filter(Boolean);

      if (!candidates.length) {
        return res.status(200).json({ ok: true, top: null, alternatives: [], message: "Nessuna tratta valida dopo filtri (visited/week)." });
      }

      candidates.sort((a, b) => b._score - a._score);

      const top = candidates[0];
      const alts = candidates.slice(1, 3);

      return res.status(200).json({
        ok: true,
        top: outPlanHub(top),
        alternatives: alts.map(outPlanHub),
        debug: { source: "plan_hub_only", mode, minutes, category: allowedTypes[0] }
      });
    }

    /* =========================================================
       B) CAR / WALK / BIKE  => LUOGHI "BELLI"
       dataset: curated.json + pois_eu_uk.json + places_index_eu_uk.json
    ========================================================= */

    const curatedPack = readJsonSafe("curated.json", { places: [] });
    const curatedPlaces = Array.isArray(curatedPack?.places) ? curatedPack.places : [];

    const poisPack = readJsonSafe("pois_eu_uk.json", { pois: [] });
    const pois = Array.isArray(poisPack?.pois) ? poisPack.pois : [];

    const idxPack = readJsonSafe("places_index_eu_uk.json", { places: [] });
    const idxPlaces = Array.isArray(idxPack?.places) ? idxPack.places : [];

    function normalizePlace(p, source) {
      const lat = Number(p?.lat);
      const lng = Number(p?.lng ?? p?.lon);
      if (!p || !p.id || !p.name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

      const types =
        Array.isArray(p.types) ? p.types :
        (Array.isArray(p.type) ? p.type : (p.type ? [p.type] : []));

      return {
        id: String(p.id),
        name: String(p.name),
        country: p.country || "",
        lat, lng,
        types: types.map(norm).filter(Boolean),
        visibility: p.visibility || "",
        beauty_score: Number(p.beauty_score),
        why: Array.isArray(p.why) ? p.why : [],
        what_to_do: Array.isArray(p.what_to_do) ? p.what_to_do : [],
        what_to_eat: Array.isArray(p.what_to_eat) ? p.what_to_eat : [],
        tags: Array.isArray(p.tags) ? p.tags : [],
        _source: source
      };
    }

    const all = [
      ...curatedPlaces.map(p => normalizePlace(p, "curated")).filter(Boolean),
      ...pois.map(p => normalizePlace(p, "pois")).filter(Boolean),
      ...idxPlaces.map(p => normalizePlace(p, "index")).filter(Boolean)
    ];

    const base = all
      .filter(p => !visitedIds.has(p.id))
      .filter(p => !weekIds.has(p.id))
      .map(p => {
        const { km, eta } = estimateLocal(originObj, p.lat, p.lng, mode);
        return { ...p, distance_km: km, eta_min: eta };
      })
      .filter(p => p.distance_km >= 2.0);

    let pool = base.filter(p => {
      const t = p.types || [];
      const want = allowedTypes;

      if (want.length === 1 && ["mare", "montagna", "natura", "relax", "bambini"].includes(want[0])) {
        return t.includes(want[0]);
      }
      if (want.includes("citta") || want.includes("borgo")) {
        return want.some(x => t.includes(x));
      }
      return true;
    });

    pool = pool.filter(p => {
      const b = beautyScore(p);
      if (p._source === "index" && b < 0.60) return false;
      return true;
    });

    const caps = [1.20, 1.45, 1.85, 2.60].map(x => minutes * x);

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
      return res.status(200).json({ ok: true, top: null, alternatives: [], message: "Nessuna meta trovata." });
    }

    within.forEach(p => {
      p._score = scoreLocal(p, p.eta_min, minutes, style);
    });
    within.sort((a, b) => b._score - a._score);

    const top = within[0];
    const alts = within.slice(1, 3);

    const fallbackNote = (usedCap > minutes * 1.35)
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
        out.push(style === "gems" ? "È più particolare / fuori dai soliti giri." : "È una meta solida e facile da godere.");
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
      debug: { source: "local_mix", mode, minutes, category: allowedTypes[0], pool: within.length }
    });

  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
      hint: "Controlla i JSON in public/data: curated.json, places_index_eu_uk.json, pois_eu_uk.json, curated_airports_eu_uk.json, curated_stations_eu_uk.json"
    });
  }
}
