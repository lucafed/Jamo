// api/jamo.js — v10 QUALITY + TIME-TARGET + curated-first + index-fallback
// POST { origin:{lat,lon,label?}, minutes:number, mode:"car"|"walk"|"bike"|"train"|"bus"|"plane",
//        style:"known"|"gems", category:string, excludeIds?:string[], visitedIds?:string[], weekIds?:string[] }

import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "public", "data");

function readJson(filename) {
  const p = path.join(DATA_DIR, filename);
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

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
  if (c === "borgo" || c === "borghi") return ["borgo"];
  if (["mare","montagna","natura","relax","bambini"].includes(c)) return [c];
  return ["citta","borgo"];
}

function avgSpeedKmh(mode){
  if (mode==="walk") return 4.5;
  if (mode==="bike") return 15;
  return 70;
}
function estimateAutoLike(origin, lat, lng, mode){
  const km = haversineKm(origin.lat, origin.lon, lat, lng);
  const eta = (km / avgSpeedKmh(mode)) * 60;
  return { distance_km: km, eta_min: eta };
}

function isoWeekKey(){
  const d=new Date();
  const date=new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum=date.getUTCDay()||7;
  date.setUTCDate(date.getUTCDate()+4-dayNum);
  const yearStart=new Date(Date.UTC(date.getUTCFullYear(),0,1));
  const weekNo=Math.ceil((((date-yearStart)/86400000)+1)/7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2,"0")}`;
}

function styleBoost(visibility, style){
  const v = norm(visibility);
  if (style==="known") return v==="conosciuta" ? 1 : 0.88;
  return v==="chicca" ? 1 : 0.88;
}

/**
 * TIME TARGET:
 * - se minutes=60, vogliamo suggerire ~50–75 min
 * - se minutes=120, vogliamo ~100–140 min
 * Quindi penalizziamo fortemente mete "troppo vicine" quando l'utente mette un tempo alto.
 */
function timeTargetScore(eta, minutes){
  const m = Math.max(15, Number(minutes));
  const t = Number(eta);

  // fascia ideale: 0.75x .. 1.12x
  const low = 0.75 * m;
  const high = 1.12 * m;

  // troppo vicina? (es. 2h ma eta=30min) => forte penalità
  if (t < 0.55 * m) return 0.05;

  // dentro fascia ideale: punteggio alto
  if (t >= low && t <= high) return 1.0;

  // fuori fascia: degrada gradualmente
  const dist = Math.abs(t - m);
  return clamp(1 - (dist / Math.max(20, m*0.65)), 0, 1);
}

/**
 * QUALITY SCORE:
 * - Curated destinations hanno "score" (0-100) e contenuti (what_to_do/why)
 * - Index (GeoNames) non ha qualità: quindi lo trattiamo come fallback e penalizziamo le micro-località.
 */
function beautyScore(p){
  // score esplicito (curated_destinations): top
  const s = Number(p.score);
  if (Number.isFinite(s)) return clamp(s/100, 0, 1);

  // euristica: se ha contenuti veri => più qualità
  const todo = Array.isArray(p.what_to_do) ? p.what_to_do.length : 0;
  const why  = Array.isArray(p.why) ? p.why.length : 0;
  const vibes = Array.isArray(p.vibes) ? p.vibes.length : 0;

  const content = clamp((todo*0.10) + (why*0.10) + (vibes*0.05), 0, 0.7);

  // se è index e non ha contenuti: resta basso
  const base = 0.20 + content;

  // penalizza “index” piccoli centri: di solito sono “riempitivi”
  const src = norm(p._source);
  if (src==="index") return clamp(base - 0.12, 0, 1);

  return clamp(base, 0, 1);
}

// scoring finale (vicino davvero + target tempo + qualità)
function scorePlace(p, minutes, style, originLabel){
  const eta = Number(p.eta_min);
  const m = Number(minutes);

  const near = clamp(1 - (eta / (m*1.35)), 0, 1);                 // non troppo lontano
  const target = timeTargetScore(eta, m);                         // vicino al “tempo scelto”
  const s = styleBoost(p.visibility, style);                      // chicche vs conosciuti
  const q = beautyScore(p);                                       // bellezza / cose da fare

  // evita suggerire esattamente la partenza (se scrivi “L’Aquila”)
  const samePenalty = originLabel && normName(p.name) === normName(originLabel) ? 0.25 : 0;

  // mix:
  // target + qualità pesano tanto (è quello che vuoi)
  return (0.30*near) + (0.35*target) + (0.25*q) + (0.10*s) - samePenalty;
}

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

async function callPlan(origin, minutes, mode){
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  const r = await fetch(`${base}/api/plan`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ origin, maxMinutes: minutes, mode, limit: 25 })
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`PLAN ${r.status}: ${text.slice(0,120)}`);
  return JSON.parse(text);
}

export default async function handler(req,res){
  try{
    if (req.method !== "POST") return res.status(405).json({ error:"Use POST" });

    const body = req.body || {};
    const origin = body.origin || {};
    const minutes = Number(body.minutes);
    const mode = canonicalMode(body.mode || "car");
    const style = norm(body.style || "known"); // known|gems
    const allowedTypes = allowedTypesFromCategory(body.category || "citta_borghi");

    const excludeIds = new Set(Array.isArray(body.excludeIds) ? body.excludeIds : []);
    const visitedIds = new Set(Array.isArray(body.visitedIds) ? body.visitedIds : []);
    const weekIds    = new Set(Array.isArray(body.weekIds) ? body.weekIds : []);
    const weekKey = isoWeekKey();

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

    // ========= PLANE / TRAIN / BUS =========
    if (mode==="plane" || mode==="train" || mode==="bus"){
      // Se /api/plan non c'è, verrà 500 e lo mostriamo chiaramente
      const plan = await callPlan(originObj, minutes, mode);
      const results = Array.isArray(plan?.results) ? plan.results : [];

      const candidates = results.map(r=>{
        const dest = r.destination || {};
        const name = `${dest.name || "Meta"}${dest.country ? `, ${dest.country}` : ""}`;
        const km = (Number.isFinite(dest.lat) && Number.isFinite(dest.lon))
          ? haversineKm(oLat,oLon, Number(dest.lat), Number(dest.lon))
          : 0;

        const oh = r.originHub?.code || r.originHub?.name || "";
        const dh = r.destinationHub?.code || r.destinationHub?.name || "";

        return {
          id: dest.id || normName(name).replace(/\s+/g,"_"),
          name: dest.name || "Meta",
          country: dest.country || "",
          type: "trasporto",
          visibility: style==="gems" ? "chicca" : "conosciuta",
          lat: Number(dest.lat),
          lng: Number(dest.lon),
          eta_min: Number(r.totalMinutes),
          distance_km: km,
          hubSummary: `${oh} → ${dh}`,
          segments: Array.isArray(r.segments) ? r.segments : [],
          // qualità: per ora usa tags/score se presenti nel dataset destinazioni
          score: Number(dest.score),
          why: [
            `Ci arrivi in ~${Math.round(r.totalMinutes)} min (stima).`,
            `Hub: ${oh || "?"} → ${dh || "?"}.`
          ],
          what_to_do: Array.isArray(dest.what_to_do) ? dest.what_to_do : [],
          what_to_eat: Array.isArray(dest.what_to_eat) ? dest.what_to_eat : [],
          _source: "plan"
        };
      })
      .filter(p => Number.isFinite(p.eta_min) && p.eta_min > 0)
      .filter(p => !excludeIds.has(p.id))
      .filter(p => !visitedIds.has(p.id))
      .filter(p => !weekIds.has(p.id));

      if (!candidates.length){
        return res.status(200).json({ ok:true, top:null, alternatives:[], message:"Nessuna meta trovata per questo mezzo/tempo." });
      }

      candidates.forEach(p => { p._score = scorePlace(p, minutes, style, originLabel); });
      candidates.sort((a,b)=>b._score-a._score);

      const top = candidates[0];
      const alts = candidates.slice(1,3);

      return res.status(200).json({
        ok:true,
        weekKey,
        top: compactOut(top),
        alternatives: alts.map(compactOut),
        debug: { mode, minutes, style, allowedTypes, source:"plan" }
      });
    }

    // ========= AUTO / WALK / BIKE =========
    // 1) curated “vecchio”
    const curated = readJson("curated.json");
    const curatedPlaces = Array.isArray(curated?.places) ? curated.places : [];

    // 2) curated_destinations EU+UK (qualità alta)
    let curatedDest = null;
    try { curatedDest = readJson("curated_destinations_eu_uk.json"); } catch {}
    const curatedDestPlaces =
      Array.isArray(curatedDest?.places) ? curatedDest.places :
      Array.isArray(curatedDest?.destinations) ? curatedDest.destinations :
      [];

    // merge curated (dedup by id)
    const curatedMap = new Map();
    [...curatedPlaces, ...curatedDestPlaces].forEach(p=>{
      if (p?.id) curatedMap.set(p.id, p);
    });
    const curatedAll = [...curatedMap.values()];

    // index (copertura)
    const idx = readJson("places_index_eu_uk.json");
    const idxPlaces = Array.isArray(idx?.places) ? idx.places : [];

    const caps = [1.10, 1.25, 1.45, 1.80, 2.40, 3.20].map(x => Math.round(minutes*x));

    function buildCandidatesFrom(list, sourceLabel){
      return list
        .map(p => ({
          id: p.id,
          name: p.name,
          country: p.country || "",
          type: norm(p.type),
          visibility: norm(p.visibility) || (sourceLabel==="index" ? "chicca" : "conosciuta"),
          score: p.score, // <- se c'è, pesa tanto
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
        .filter(p => !excludeIds.has(p.id))
        .map(p => ({ ...p, ...estimateAutoLike(originObj, p.lat, p.lng, mode) }))
        .filter(p => p.distance_km >= 2.0); // evita “sei già lì”
    }

    const curatedCandidates = buildCandidatesFrom(curatedAll, "curated")
      .filter(p => allowedTypes.includes(p.type));

    // index: solo città/borghi
    const indexCandidates = buildCandidatesFrom(idxPlaces, "index")
      .filter(p => ["citta","borgo"].includes(p.type));

    function pickWithinCaps(list){
      for (const capMin of caps){
        const within = list
          .filter(p => p.eta_min <= capMin)
          .filter(p => !visitedIds.has(p.id))
          .filter(p => !weekIds.has(p.id));
        if (within.length >= 6) return { capMin, within };
      }
      const notVisited = list.filter(p => !visitedIds.has(p.id));
      const base = (notVisited.length ? notVisited : list).slice().sort((a,b)=>a.eta_min-b.eta_min);
      return { capMin: caps[caps.length-1], within: base.slice(0, 40) };
    }

    const isCityLike = allowedTypes.includes("citta") || allowedTypes.includes("borgo");

    let pool = [];
    let noteFallback = "";

    if (isCityLike){
      // CURATED FIRST, poi index come rete di sicurezza
      const pickC = pickWithinCaps(curatedCandidates);
      const pickI = pickWithinCaps(indexCandidates);

      // regola: se curated ha almeno 3 scelte buone, usa SOLO curated (qualità)
      if (pickC.within.length >= 3) {
        pool = pickC.within;
        if (pickC.capMin > minutes) noteFallback = `Ho allargato un po’ il raggio per trovare mete davvero belle: ~${pickC.capMin} min (stima).`;
      } else {
        // mix: curated + index
        pool = [...pickC.within, ...pickI.within];
        noteFallback = `Vicino a te ho poche mete “curate”: aggiungo anche città/borghi dall’indice (fallback).`;
      }
    } else {
      // categorie speciali (mare/montagna/natura ecc):
      const pick1 = pickWithinCaps(curatedCandidates);
      if (pick1.within.length >= 1){
        pool = pick1.within;
        if (pick1.capMin > minutes) {
          noteFallback = `Per trovare “${allowedTypes[0]}” ho allargato il raggio: ~${pick1.capMin} min (stima).`;
        }
      } else {
        noteFallback = `Vicino a te non ho abbastanza mete “${allowedTypes[0]}” nel dataset. Ti propongo una meta carina vicina (città/borgo).`;
        pool = pickWithinCaps(indexCandidates).within;
      }
    }

    if (!pool.length){
      return res.status(200).json({ ok:true, top:null, alternatives:[], message:"Nessuna meta trovata." });
    }

    pool.forEach(p => {
      p._score = scorePlace(p, minutes, style, originLabel);

      // chicche: penalizza metropoli note quando vuoi gems
      if (style==="gems" && p.type==="citta" && p.visibility==="conosciuta") p._score -= 0.18;

      // se index e troppo “micro”, penalizza ancora
      if (norm(p._source)==="index" && p.eta_min < minutes*0.70) p._score -= 0.10;
    });

    pool.sort((a,b)=>b._score-a._score);

    const top = pool[0];
    const alts = pool.slice(1,3);

    function ensureWhy(p){
      const out = Array.isArray(p.why) ? [...p.why] : [];
      if (noteFallback) out.unshift(noteFallback);

      // se è index e non ha contenuti, rendilo “onesto”
      if (!out.length) {
        out.push(`Ci arrivi in ~${Math.round(p.eta_min)} min: perfetta col tempo che hai.`);
        out.push(style==="gems" ? "Vibe più da chicca: meno caos, più atmosfera." : "Scelta solida: facile e senza sbatti.");
      }

      // hook monetizzazione
      out.push("Tip: qui compariranno link utili (biglietti/esperienze/prenotazioni).");
      return out.slice(0,4);
    }

    top.why = ensureWhy(top);
    alts.forEach(a => a.why = ensureWhy(a));

    return res.status(200).json({
      ok:true,
      weekKey,
      top: compactOut(top),
      alternatives: alts.map(compactOut),
      debug: {
        mode, minutes, style, allowedTypes,
        curatedCount: curatedCandidates.length,
        indexCount: idxPlaces.length,
        poolCount: pool.length,
        fallbackNote: noteFallback || ""
      }
    });

  } catch(e){
    return res.status(500).json({
      error: String(e?.message || e),
      hint: "Controlla che esistano public/data/curated.json, public/data/curated_destinations_eu_uk.json e public/data/places_index_eu_uk.json"
    });
  }
        }
