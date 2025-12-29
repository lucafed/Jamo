// api/jamo.js — v10 BEAUTY-FIRST + TIME-BANDS + EU/UK index + plan bridge
// POST {
//   origin:{lat,lon,label?},
//   minutes:number,
//   mode:"car"|"walk"|"bike"|"train"|"bus"|"plane" (IT/EN ok),
//   style:"known"|"gems",
//   category:string,
//   visitedIds?:string[],
//   weekIds?:string[],
//   excludeIds?:string[]
// }
//
// Returns: { ok:true, top, alternatives[], debug }

import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "public", "data");

function readJson(filename) {
  const p = path.join(DATA_DIR, filename);
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

/* -------------------------
   Utils
------------------------- */
function toRad(x){ return (x*Math.PI)/180; }
function haversineKm(aLat,aLon,bLat,bLon){
  const R=6371;
  const dLat=toRad(bLat-aLat), dLon=toRad(bLon-aLon);
  const lat1=toRad(aLat), lat2=toRad(bLat);
  const s=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }
function norm(s){
  return String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();
}
function normName(s){ return norm(s).replace(/[^a-z0-9]+/g," ").trim(); }

function canonicalMode(raw){
  const m = norm(raw);
  if (["car","auto","macchina"].includes(m)) return "car";
  if (["walk","piedi","a piedi"].includes(m)) return "walk";
  if (["bike","bici","bicicletta"].includes(m)) return "bike";
  if (["plane","aereo","volo"].includes(m)) return "plane";
  if (["train","treno"].includes(m)) return "train";
  if (["bus","pullman"].includes(m)) return "bus";
  return "car";
}

function allowedTypesFromCategory(categoryRaw){
  const c = norm(categoryRaw);
  if (c.includes("borgh") && c.includes("citt")) return ["citta","borgo"];
  if (c === "citta_borghi" || (c.includes("citta") && c.includes("borg"))) return ["citta","borgo"];
  if (c === "citta" || c === "città" || c === "city") return ["citta"];
  if (c === "borgo" || c === "borghi" || c === "village") return ["borgo"];
  if (["mare","montagna","natura","relax","bambini"].includes(c)) return [c];
  return ["citta","borgo"];
}

/* -------------------------
   Speeds (rough, ok for ranking)
------------------------- */
function avgSpeedKmh(mode){
  if (mode==="walk") return 4.5;
  if (mode==="bike") return 15;
  return 75; // car baseline
}
function estimateAutoLike(origin, lat, lng, mode){
  const km = haversineKm(origin.lat, origin.lon, lat, lng);
  const eta = (km / avgSpeedKmh(mode)) * 60;
  return { distance_km: km, eta_min: eta };
}

/* -------------------------
   Beauty-first filters (NO more "random places")
   Heuristics only (no reviews yet).
------------------------- */
const BAD_NAME_PATTERNS = [
  "project", "progetto", "cantiere", "lotto", "zona industriale",
  "case", "casa", "residence", "villaggio", "quartiere",
  "stabilimento", "deposito", "magazzino", "fabbrica",
  "stazione", "aeroporto", "ospedale", "clinica", "carcere",
  "autostrada", "uscita", "svincolo", "tangenziale",
  "area di servizio", "parcheggio"
].map(norm);

function looksBadByName(name){
  const n = norm(name);
  return BAD_NAME_PATTERNS.some(p => n.includes(p));
}

/**
 * For INDEX (GeoNames cities500):
 * - "citta": keep only fairly relevant places
 * - "borgo": keep villages/towns but avoid too tiny places
 *
 * NOTE: your current places_index_eu_uk.json probably does NOT include population.
 * So we use type+visibility+distance/time heuristics, plus name blacklist.
 */
function passIndexQualityGate(p, wantedType){
  // hard stop on bad names
  if (looksBadByName(p.name)) return false;

  const t = norm(p.type);
  if (wantedType === "citta"){
    // keep "citta" and prefer known/chicca ok, but block ultra-small entries
    // since index marks low pop as borgo, we just enforce type=citta
    return t === "citta";
  }
  if (wantedType === "borgo"){
    // allow borgo but avoid micro-settlements: require visibility present and name length > 2
    return t === "borgo" && normName(p.name).length >= 4;
  }
  return true;
}

/* -------------------------
   Time bands: make 1h != 2h (NO same suggestions)
------------------------- */
function timeBand(minutes){
  // desired ETA window (min..max) and "too close" threshold
  // so 2h won't return the 45min stuff again.
  if (minutes <= 45) return { min: minutes*0.60, max: minutes*1.15, tooClose: minutes*0.45 };
  if (minutes <= 90) return { min: minutes*0.65, max: minutes*1.20, tooClose: minutes*0.50 };
  if (minutes <= 180) return { min: minutes*0.70, max: minutes*1.28, tooClose: minutes*0.55 };
  return { min: minutes*0.75, max: minutes*1.35, tooClose: minutes*0.60 };
}

/* -------------------------
   Scoring (beauty + fit time + style)
------------------------- */
function styleBoost(visibility, style){
  const v = norm(visibility);
  if (style==="known") return v==="conosciuta" ? 1.0 : 0.86;
  return v==="chicca" ? 1.0 : 0.86;
}

function scorePlace(p, minutes, style, originLabel){
  const band = timeBand(minutes);
  const eta = Number(p.eta_min);

  // 1) time fit (target and band)
  const tScore = clamp(1 - (Math.abs(eta - minutes) / Math.max(18, minutes*0.9)), 0, 1);

  // 2) band bonus/penalty
  let bandAdj = 0;
  if (eta < band.tooClose) bandAdj -= 0.35;         // too near -> prevents 2h returning 1h stuff
  else if (eta >= band.min && eta <= band.max) bandAdj += 0.20;

  // 3) style
  const s = styleBoost(p.visibility, style);

  // 4) avoid "same as origin" if user typed city name
  const samePenalty = originLabel && normName(p.name) === normName(originLabel) ? 0.25 : 0;

  // 5) curated richness bonus (if has what_to_do/why)
  const richness =
    (Array.isArray(p.what_to_do) ? p.what_to_do.length : 0) +
    (Array.isArray(p.why) ? p.why.length : 0) +
    (Array.isArray(p.tags) ? p.tags.length : 0);

  const richBonus = clamp(richness / 10, 0, 1) * 0.18;

  // 6) mild distance sanity: don't pick absurdly far for car-like
  const km = Number(p.distance_km);
  const kScore = Number.isFinite(km) ? clamp(1 - (km / 900), 0, 1) : 0.4;

  // final
  return (0.55*tScore) + (0.18*s) + (0.12*kScore) + richBonus + bandAdj - samePenalty;
}

/* -------------------------
   Output shaping
------------------------- */
function compactOut(p){
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

function ensureWhy(p, minutes, style, noteFallback){
  const out = Array.isArray(p.why) ? [...p.why] : [];
  const eta = Math.round(p.eta_min);

  if (noteFallback) out.unshift(noteFallback);

  // make it “marketing ready”
  if (!out.length){
    out.push(`Ci arrivi in ~${eta} min: è in linea col tempo che hai scelto.`);
    out.push(style==="gems" ? "È una meta più “da chicca”: atmosfera, meno caos." : "È una scelta solida: bella e semplice da organizzare.");
    out.push("Tra poco qui compariranno link utili (cose da fare, biglietti, esperienze) 💸");
  } else {
    if (!out.some(x => norm(x).includes("min"))) out.push(`Tempo stimato: ~${eta} min.`);
    out.push("Tip: qui inseriremo link monetizzabili (esperienze / biglietti / tour).");
  }
  return out.slice(0, 4);
}

/* -------------------------
   Call /api/plan (server-side, Vercel-safe)
   Uses request host when possible.
------------------------- */
async function callPlan(req, origin, minutes, mode){
  const host = req?.headers?.host;
  const proto = req?.headers?.["x-forwarded-proto"] || "https";
  const base =
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` :
    host ? `${proto}://${host}` :
    "http://localhost:3000";

  const r = await fetch(`${base}/api/plan`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ origin, maxMinutes: minutes, mode, limit: 25 })
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`PLAN ${r.status}: ${text.slice(0,160)}`);
  return JSON.parse(text);
}

/* -------------------------
   Build candidates from datasets
------------------------- */
function normalizeDatasetPlace(x, source){
  return {
    id: x.id,
    name: x.name,
    country: x.country || "",
    type: norm(x.type),
    visibility: norm(x.visibility) || (source==="index" ? "chicca" : "conosciuta"),
    lat: Number(x.lat),
    lng: Number(x.lng),
    tags: Array.isArray(x.tags) ? x.tags : [],
    vibes: Array.isArray(x.vibes) ? x.vibes : [],
    best_when: Array.isArray(x.best_when) ? x.best_when : [],
    why: Array.isArray(x.why) ? x.why : [],
    what_to_do: Array.isArray(x.what_to_do) ? x.what_to_do : [],
    what_to_eat: Array.isArray(x.what_to_eat) ? x.what_to_eat : [],
    _source: source
  };
}

/* -------------------------
   MAIN HANDLER
------------------------- */
export default async function handler(req,res){
  try{
    if (req.method !== "POST") return res.status(405).json({ error:"Use POST" });

    const body = req.body || {};
    const origin = body.origin || {};
    const minutes = Number(body.minutes);
    const mode = canonicalMode(body.mode || "car");
    const style = norm(body.style || "known");
    const category = body.category || "citta_borghi";
    const allowedTypes = allowedTypesFromCategory(category);

    const excludeIds = new Set([...(body.excludeIds || []), ...(body.visitedIds || []), ...(body.weekIds || [])].filter(Boolean));

    const oLat = Number(origin.lat);
    const oLon = Number(origin.lon ?? origin.lng);
    if (!Number.isFinite(oLat) || !Number.isFinite(oLon)) {
      return res.status(400).json({ error:"origin must be {lat, lon}", got: origin });
    }
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return res.status(400).json({ error:"minutes must be positive" });
    }

    const originObj = { lat:oLat, lon:oLon, label: origin.label || "" };
    const originLabel = originObj.label || "";

    /* ========= PUBLIC TRANSPORT ========= */
    if (mode==="plane" || mode==="train" || mode==="bus"){
      // if /api/plan missing, return a clean message (your UI shows it)
      let plan;
      try{
        plan = await callPlan(req, originObj, minutes, mode);
      } catch(e){
        return res.status(200).json({
          ok:false,
          top:null,
          alternatives:[],
          message:`Modalità ${mode.toUpperCase()} non disponibile (manca /api/plan).`,
          debug:{ error:String(e?.message || e), mode }
        });
      }

      const results = Array.isArray(plan?.results) ? plan.results : [];
      if (!results.length){
        return res.status(200).json({ ok:true, top:null, alternatives:[], message:"Nessuna meta trovata per questo mezzo/tempo." });
      }

      // Make output consistent with “beauty-first”: filter out too-short weird combos
      const band = timeBand(minutes);

      let candidates = results.map(r=>{
        const dest = r.destination || {};
        const name = `${dest.name || "Meta"}${dest.country ? `, ${dest.country}` : ""}`;
        const km = (Number.isFinite(dest.lat) && Number.isFinite(dest.lon))
          ? haversineKm(oLat,oLon, Number(dest.lat), Number(dest.lon))
          : 0;

        const oh = r.originHub?.code || r.originHub?.name || "";
        const dh = r.destinationHub?.code || r.destinationHub?.name || "";

        const eta = Number(r.totalMinutes);

        return {
          id: dest.id || normName(name).replace(/\s+/g,"_"),
          name: dest.name || "Meta",
          country: dest.country || "",
          type: "trasporto",
          visibility: style==="gems" ? "chicca" : "conosciuta",
          lat: Number(dest.lat),
          lng: Number(dest.lon),
          eta_min: eta,
          distance_km: km,
          hubSummary: `${oh} → ${dh}`,
          segments: Array.isArray(r.segments) ? r.segments : [],
          why: [
            `Tempo totale stimato: ${Math.round(eta)} min (target: ${minutes} min).`,
            `Hub: ${oh || "?"} → ${dh || "?"}.`,
            "CTA pronta: qui metterai “Acquista biglietti” per monetizzare 💸"
          ],
          what_to_do: [],
          what_to_eat: [],
          tags:[]
        };
      });

      candidates = candidates
        .filter(p => Number.isFinite(p.eta_min) && p.eta_min > 0)
        .filter(p => !excludeIds.has(p.id))
        .filter(p => p.distance_km >= 40)            // avoid “same area”
        .filter(p => p.eta_min >= band.tooClose)     // avoid too short results
        .filter(p => !looksBadByName(p.name));

      if (!candidates.length){
        return res.status(200).json({ ok:true, top:null, alternatives:[], message:"Trovate mete, ma filtrate perché troppo vicine o poco sensate. Aumenta tempo." });
      }

      candidates.forEach(p => { p._score = scorePlace(p, minutes, style, originLabel); });
      candidates.sort((a,b)=>b._score-a._score);

      const top = candidates[0];
      const alts = candidates.slice(1,3);

      top.why = ensureWhy(top, minutes, style, "");
      alts.forEach(a => a.why = ensureWhy(a, minutes, style, ""));

      return res.status(200).json({
        ok:true,
        top: compactOut(top),
        alternatives: alts.map(compactOut),
        debug: { mode, minutes, style, allowedTypes, source:"plan", poolCount:candidates.length }
      });
    }

    /* ========= CAR / WALK / BIKE ========= */
    const curated = readJson("curated.json");
    const curatedPlaces = Array.isArray(curated?.places) ? curated.places : [];

    // EU+UK index (you already generated it)
    const idx = readJson("places_index_eu_uk.json");
    const idxPlaces = Array.isArray(idx?.places) ? idx.places : [];

    // normalize + add eta
    const curatedNorm = curatedPlaces
      .map(x => normalizeDatasetPlace(x, "curated"))
      .filter(p => p.id && p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng))
      .filter(p => !excludeIds.has(p.id))
      .map(p => ({ ...p, ...estimateAutoLike(originObj, p.lat, p.lng, mode) }))
      .filter(p => p.distance_km >= 2.0)
      .filter(p => !looksBadByName(p.name));

    const indexNorm = idxPlaces
      .map(x => normalizeDatasetPlace(x, "index"))
      .filter(p => p.id && p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng))
      .filter(p => !excludeIds.has(p.id))
      .map(p => ({ ...p, ...estimateAutoLike(originObj, p.lat, p.lng, mode) }))
      .filter(p => p.distance_km >= 2.0)
      .filter(p => !looksBadByName(p.name));

    const isCityLike = allowedTypes.includes("citta") || allowedTypes.includes("borgo");

    // Candidates pool rules:
    // - City/Borghi: curated + index (but quality gated)
    // - Special categories (mare/montagna/...): curated only; if none, fallback honestly to citylike index.
    let pool = [];
    let noteFallback = "";

    if (isCityLike){
      const wanted = allowedTypes; // ["citta","borgo"] etc

      const curatedPool = curatedNorm.filter(p => wanted.includes(p.type));

      // index: enforce quality gate by requested type(s)
      const idxPool = indexNorm.filter(p => wanted.includes(p.type)).filter(p => {
        if (p.type === "citta") return passIndexQualityGate(p, "citta");
        if (p.type === "borgo") return passIndexQualityGate(p, "borgo");
        return true;
      });

      // Prefer curated strongly (better "beauty" fields), but keep index for coverage
      pool = [...curatedPool, ...idxPool];
    } else {
      // special category: ONLY curated (to avoid "mare -> inland city")
      const curatedOnly = curatedNorm.filter(p => allowedTypes.includes(p.type));
      pool = curatedOnly;

      if (!pool.length){
        // honest fallback
        noteFallback = `Vicino a te non ho abbastanza mete “${allowedTypes[0]}” nel dataset. Ti propongo una città/borgo davvero carino vicino.`;
        pool = indexNorm.filter(p => ["citta","borgo"].includes(p.type)).filter(p => passIndexQualityGate(p, p.type));
      }
    }

    if (!pool.length){
      return res.status(200).json({ ok:true, top:null, alternatives:[], message:"Nessuna meta trovata (dataset vuoto o filtri troppo stretti)." });
    }

    // HARD “time coherence”:
    // instead of hard-capping immediately, we score but also enforce progressive caps
    const caps = [1.10, 1.28, 1.55, 2.10, 3.00].map(x => minutes*x);
    const band = timeBand(minutes);

    function pickProgressive(list){
      // 1) prefer inside band AND not too close
      const goodBand = list.filter(p => p.eta_min >= band.tooClose && p.eta_min <= band.max);
      if (goodBand.length >= 8) return { picked: goodBand, capUsed: band.max, bandUsed: true };

      // 2) progressive cap expand
      for (const cap of caps){
        const within = list.filter(p => p.eta_min >= band.tooClose && p.eta_min <= cap);
        if (within.length >= 8) return { picked: within, capUsed: cap, bandUsed: false };
      }

      // 3) if still low, take nearest but keep not-too-close rule if possible
      const notTooClose = list.filter(p => p.eta_min >= band.tooClose);
      const base = (notTooClose.length ? notTooClose : list).slice().sort((a,b)=>a.eta_min-b.eta_min);
      return { picked: base.slice(0, 60), capUsed: caps[caps.length-1], bandUsed: false };
    }

    const { picked, capUsed, bandUsed } = pickProgressive(pool);

    // Score
    picked.forEach(p => {
      p._score = scorePlace(p, minutes, style, originLabel);

      // extra: gems -> penalize big known cities a bit
      if (style==="gems" && p.type==="citta" && p.visibility==="conosciuta") p._score -= 0.18;

      // special category fallback note: tiny penalty so it doesn’t dominate everything
      if (noteFallback) p._score -= 0.06;
    });

    picked.sort((a,b)=>b._score-a._score);

    const top = picked[0];
    const alts = picked.slice(1,3);

    // WHY enrichment
    const capNote =
      capUsed > minutes*1.05
        ? `Per trovare mete davvero “belle” ho allargato un po’ il raggio: fino a ~${Math.round(capUsed)} min (stima).`
        : "";

    top.why = ensureWhy(top, minutes, style, noteFallback || capNote);
    alts.forEach(a => a.why = ensureWhy(a, minutes, style, noteFallback || capNote));

    // If top is from index and has empty what_to_do, add lightweight “hooks”
    function addIndexHooks(p){
      if (p._source === "index" && (!p.what_to_do || !p.what_to_do.length)){
        p.what_to_do = [
          "Centro storico / passeggiata principale",
          "Piazza centrale e scorci panoramici",
          "Caffè tipico (qui metteremo link/consigli)"
        ];
      }
      return p;
    }
    addIndexHooks(top);
    alts.forEach(addIndexHooks);

    return res.status(200).json({
      ok:true,
      top: compactOut(top),
      alternatives: alts.map(compactOut),
      debug: {
        mode, minutes, style, allowedTypes,
        curatedCount: curatedNorm.length,
        indexCount: idxPlaces.length,
        poolCount: pool.length,
        pickedCount: picked.length,
        capUsed: Math.round(capUsed),
        bandUsed,
        fallbackNote: noteFallback || ""
      }
    });

  } catch(e){
    return res.status(500).json({
      error: String(e?.message || e),
      hint: "Controlla che esistano public/data/curated.json e public/data/places_index_eu_uk.json",
    });
  }
}
