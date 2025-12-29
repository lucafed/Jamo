// api/jamo.js — ONE API (NO Overpass live) — v1 stable
// POST {
//   origin:{lat,lon,label?},
//   minutes:number,
//   mode:"car"|"walk"|"bike"|"train"|"bus"|"plane" (anche IT ok),
//   style:"known"|"gems",
//   category:string,
//   visitedIds?:string[],
//   weekIds?:string[],
//   excludeIds?:string[]
// }
// Returns { ok:true, top, alternatives, debug }

import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "public", "data");

function readJson(filename) {
  const p = path.join(DATA_DIR, filename);
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
  if (c === "citta" || c === "citta " || c === "città" || c === "city") return ["citta"];
  if (c === "borgo" || c === "borghi") return ["borgo"];
  if (["mare", "montagna", "natura", "relax", "bambini"].includes(c)) return [c];
  return ["citta", "borgo"];
}

function avgSpeedKmh(mode) {
  if (mode === "walk") return 4.5;
  if (mode === "bike") return 15;
  return 70; // car baseline
}

function estimateAutoLike(origin, lat, lng, mode) {
  const km = haversineKm(origin.lat, origin.lon, lat, lng);
  const eta = (km / avgSpeedKmh(mode)) * 60;
  return { distance_km: km, eta_min: eta };
}

function styleBoost(visibility, style) {
  const v = norm(visibility);
  if (style === "known") return v === "conosciuta" ? 1 : 0.85;
  return v === "chicca" ? 1 : 0.85;
}

// score: vicino davvero + fit tempo + preferenza known/gems
function scorePlace(p, minutes, style) {
  const eta = p.eta_min;
  const near = clamp(1 - (eta / (minutes * 1.25)), 0, 1);
  const timeFit = clamp(1 - (Math.abs(eta - minutes) / Math.max(18, minutes * 0.9)), 0, 1);
  const s = styleBoost(p.visibility, style);
  return (0.55 * near) + (0.30 * timeFit) + (0.15 * s);
}

function compactOut(p) {
  return {
    id: p.id,
    name: p.country ? `${p.name}, ${p.country}` : p.name,
    type: p.type,
    visibility: p.visibility,
    lat: p.lat,
    lng: p.lng,
    eta_min: Math.round(p.eta_min),
    distance_km: Math.round(p.distance_km),
    why: (p.why || []).slice(0, 4),
    what_to_do: (p.what_to_do || []).slice(0, 6),
    what_to_eat: (p.what_to_eat || []).slice(0, 5),
    hubSummary: p.hubSummary,
    segments: p.segments
  };
}

// ✅ chiama /api/plan (se esiste) — usato SOLO per train/bus/plane
async function callPlan(origin, minutes, mode) {
  const base =
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` :
    process.env.NEXT_PUBLIC_SITE_URL ? process.env.NEXT_PUBLIC_SITE_URL :
    "http://localhost:3000";

  const r = await fetch(`${base}/api/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ origin, maxMinutes: minutes, mode, limit: 25 })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`PLAN ${r.status}: ${text.slice(0, 140)}`);
  return JSON.parse(text);
}

function ensureWhy(p, { minutes, style, noteFallback, mode }) {
  const out = Array.isArray(p.why) ? [...p.why] : [];
  if (noteFallback) out.unshift(noteFallback);

  if (!out.length) {
    out.push(`Ci arrivi in ~${Math.round(p.eta_min)} min: perfetta col tempo che hai scelto.`);
    out.push(style === "gems" ? "Mood “chicca”: meno caos, più atmosfera." : "Scelta solida: facile e senza sbatti.");
    out.push(mode === "car" ? "Tip: parcheggia comodo e fai il giro a piedi." : "Tip: scarpe comode e vai.");
  }

  // hook monetizzazione (non invasivo)
  out.push("🎁 Qui sotto compariranno link utili (esperienze / biglietti / posti top).");
  return out.slice(0, 4);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const body = req.body || {};
    const origin = body.origin || {};
    const minutes = Number(body.minutes);
    const mode = canonicalMode(body.mode || "car");
    const style = norm(body.style || "known"); // known | gems
    const allowedTypes = allowedTypesFromCategory(body.category || "citta_borghi");

    const excludeIds = new Set(Array.isArray(body.excludeIds) ? body.excludeIds : []);
    const visitedIds = new Set(Array.isArray(body.visitedIds) ? body.visitedIds : []);
    const weekIds = new Set(Array.isArray(body.weekIds) ? body.weekIds : []);

    const oLat = Number(origin.lat);
    const oLon = Number(origin.lon ?? origin.lng);
    if (!Number.isFinite(oLat) || !Number.isFinite(oLon)) {
      return res.status(400).json({ error: "origin must be {lat, lon}", got: origin });
    }
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return res.status(400).json({ error: "minutes must be positive" });
    }

    const originObj = { lat: oLat, lon: oLon, label: origin.label || "" };
    const originLabelNorm = normName(originObj.label || "");

    // ========= PUBLIC TRANSPORT =========
    if (mode === "plane" || mode === "train" || mode === "bus") {
      // se /api/plan non c’è ancora, non crashare: rispondi vuoto con messaggio chiaro
      let plan;
      try {
        plan = await callPlan(originObj, minutes, mode);
      } catch (e) {
        return res.status(200).json({
          ok: true,
          top: null,
          alternatives: [],
          message: `Modalità ${mode.toUpperCase()} non disponibile (manca /api/plan).`
        });
      }

      const results = Array.isArray(plan?.results) ? plan.results : [];
      let candidates = results.map((r) => {
        const dest = r.destination || {};
        const nameFull = `${dest.name || "Meta"}${dest.country ? `, ${dest.country}` : ""}`;
        const id = dest.id || `pt_${normName(nameFull).replace(/\s+/g, "_")}`;
        const km = (Number.isFinite(dest.lat) && Number.isFinite(dest.lon))
          ? haversineKm(oLat, oLon, Number(dest.lat), Number(dest.lon))
          : 0;

        const oh = r.originHub?.code || r.originHub?.name || "";
        const dh = r.destinationHub?.code || r.destinationHub?.name || "";

        return {
          id,
          name: dest.name || "Meta",
          country: dest.country || "",
          type: "trasporto",
          visibility: style === "gems" ? "chicca" : "conosciuta",
          lat: Number(dest.lat),
          lng: Number(dest.lon),
          eta_min: Number(r.totalMinutes),
          distance_km: km,
          hubSummary: `${oh || "?"} → ${dh || "?"}`,
          segments: Array.isArray(r.segments) ? r.segments : [],
          why: [
            `Raggiungibile entro ${minutes} min (stima).`,
            `Hub: ${oh || "?"} → ${dh || "?"}.`,
            "CTA pronta: qui metterai “Acquista biglietti” e monetizzi."
          ],
          what_to_do: [],
          what_to_eat: []
        };
      })
        .filter(p => Number.isFinite(p.eta_min) && p.eta_min > 0)
        .filter(p => !excludeIds.has(p.id) && !visitedIds.has(p.id) && !weekIds.has(p.id))
        // evita “stesso nome della partenza” se l’utente ha scritto un posto specifico
        .filter(p => !(originLabelNorm && normName(p.name) === originLabelNorm));

      if (!candidates.length) {
        return res.status(200).json({ ok: true, top: null, alternatives: [], message: "Nessuna meta trovata per questo mezzo/tempo." });
      }

      candidates.forEach(p => { p._score = scorePlace(p, minutes, style); });
      candidates.sort((a, b) => b._score - a._score);

      const top = candidates[0];
      const alts = candidates.slice(1, 3);

      return res.status(200).json({
        ok: true,
        top: compactOut(top),
        alternatives: alts.map(compactOut),
        debug: { source: "plan", mode, minutes, style }
      });
    }

    // ========= AUTO / WALK / BIKE =========
    const curated = readJson("curated.json");
    const curatedPlaces = Array.isArray(curated?.places) ? curated.places : [];

    // ⚠️ nome file corretto (quello che hai generato)
    const idx = readJson("places_index_eu_uk.json");
    const idxPlaces = Array.isArray(idx?.places) ? idx.places : [];

    // caps progressivi: così NON resta mai vuoto
    const caps = [1.05, 1.20, 1.40, 1.80, 2.60, 3.50].map(x => Math.round(minutes * x));

    function buildCandidatesFrom(list, sourceLabel) {
      return list
        .map(p => ({
          id: String(p.id || ""),
          name: String(p.name || ""),
          country: String(p.country || ""),
          type: norm(p.type || ""),
          visibility: norm(p.visibility || (sourceLabel === "index" ? "chicca" : "conosciuta")),
          lat: Number(p.lat),
          lng: Number(p.lng),
          tags: Array.isArray(p.tags) ? p.tags : [],
          vibes: Array.isArray(p.vibes) ? p.vibes : [],
          best_when: Array.isArray(p.best_when) ? p.best_when : [],
          why: Array.isArray(p.why) ? p.why : [],
          what_to_do: Array.isArray(p.what_to_do) ? p.what_to_do : [],
          what_to_eat: Array.isArray(p.what_to_eat) ? p.what_to_eat : [],
          _source: sourceLabel
        }))
        .filter(p => p.id && p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng))
        .filter(p => !excludeIds.has(p.id) && !visitedIds.has(p.id) && !weekIds.has(p.id))
        .map(p => ({ ...p, ...estimateAutoLike(originObj, p.lat, p.lng, mode) }))
        // ✅ “sei già lì” SOLO se praticamente sullo stesso punto (300 metri)
        .filter(p => p.distance_km >= 0.3)
        // ✅ se l’utente ha scritto esattamente quel posto, non riproporlo uguale
        .filter(p => !(originLabelNorm && normName(p.name) === originLabelNorm));
    }

    const curatedAll = buildCandidatesFrom(curatedPlaces, "curated");
    const indexAll = buildCandidatesFrom(idxPlaces, "index");

    // curated match stretto categoria
    const curatedMatch = curatedAll.filter(p => allowedTypes.includes(p.type));

    // index: usalo bene solo per città/borghi
    const indexCityLike = indexAll.filter(p => p.type === "citta" || p.type === "borgo");

    const isCityLike = allowedTypes.includes("citta") || allowedTypes.includes("borgo");

    let pool = [];
    let noteFallback = "";

    if (isCityLike) {
      // città/borghi: curated + index (copertura enorme)
      pool = [...curatedMatch, ...indexCityLike];
    } else {
      // categorie speciali: PRIMA solo curated (per evitare mare->Milano)
      pool = curatedMatch;
      if (!pool.length) {
        // fallback “onesto”: se non hai mare/montagna/natura nel dataset, ti do città/borghi vicini
        noteFallback = `Vicino a te non ho abbastanza mete “${allowedTypes[0]}” nel dataset. Ti propongo una meta carina vicina (città/borgo).`;
        pool = indexCityLike;
      }
    }

    if (!pool.length) {
      return res.status(200).json({ ok: true, top: null, alternatives: [], message: "Nessuna meta trovata." });
    }

    // prendi entro cap progressivi finché hai abbastanza scelte
    let chosen = null;
    let usedCap = caps[caps.length - 1];

    // ordina per eta prima, poi faremo score
    const baseSorted = pool.slice().sort((a, b) => a.eta_min - b.eta_min);

    for (const capMin of caps) {
      const within = baseSorted.filter(p => p.eta_min <= capMin);
      if (within.length >= 6) { chosen = within; usedCap = capMin; break; }
    }
    if (!chosen) chosen = baseSorted.slice(0, 60);

    if (!noteFallback && usedCap > minutes) {
      noteFallback = `Per trovare una meta coerente ho allargato il raggio: ~${usedCap} min (stima).`;
    }

    chosen.forEach(p => {
      p._score = scorePlace(p, minutes, style);

      // chicche: penalizza metropoli super note
      if (style === "gems" && p.type === "citta" && p.visibility === "conosciuta") p._score -= 0.22;

      // se siamo in fallback, leggermente meno “aggressivo”
      if (noteFallback) p._score -= 0.05;
    });

    chosen.sort((a, b) => b._score - a._score);

    const top = chosen[0];
    const alternatives = [];

    // 2 alternative diverse (nome diverso)
    const usedNames = new Set([normName(top.name)]);
    for (const c of chosen.slice(1)) {
      if (alternatives.length >= 2) break;
      const n = normName(c.name);
      if (usedNames.has(n)) continue;
      usedNames.add(n);
      alternatives.push(c);
    }
    while (alternatives.length < 2 && chosen.length > 1) {
      const next = chosen[alternatives.length + 1];
      if (next && !alternatives.find(x => x.id === next.id)) alternatives.push(next);
      else break;
    }

    top.why = ensureWhy(top, { minutes, style, noteFallback, mode });
    alternatives.forEach(a => { a.why = ensureWhy(a, { minutes, style, noteFallback, mode }); });

    return res.status(200).json({
      ok: true,
      top: compactOut(top),
      alternatives: alternatives.map(compactOut),
      debug: {
        source: "curated+index",
        mode, minutes, style, allowedTypes,
        usedCap,
        curatedTotal: curatedAll.length,
        curatedMatch: curatedMatch.length,
        indexTotal: indexAll.length,
        pool: pool.length,
        chosen: chosen.length,
        fallbackNote: noteFallback || ""
      }
    });

  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
      hint: "Controlla che esistano public/data/curated.json e public/data/places_index_eu_uk.json"
    });
  }
}
