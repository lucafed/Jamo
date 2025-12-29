// api/jamo.js — ONE API to rule them all (NO Overpass live)
// POST { origin:{lat,lon,label?}, minutes:number, mode:"car"|"walk"|"bike"|"train"|"bus"|"plane", style:"known"|"gems", category:string, excludeIds?:string[] }

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
  if (c === "citta_borghi" || c.includes("citta") && c.includes("borg")) return ["citta","borgo"];
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
  if (style==="known") return v==="conosciuta" ? 1 : 0.85;
  return v==="chicca" ? 1 : 0.85;
}

// scoring “vicino davvero”
function scorePlace(p, minutes, style, originLabel){
  const eta = p.eta_min;
  const near = clamp(1 - (eta / (minutes*1.25)), 0, 1);
  const timeFit = clamp(1 - (Math.abs(eta-minutes)/Math.max(18, minutes*0.9)), 0, 1);
  const s = styleBoost(p.visibility, style);
  // evita suggerire esattamente il luogo di partenza (se lo user scrive “L’Aquila”)
  const samePenalty = originLabel && normName(p.name) === normName(originLabel) ? 0.15 : 0;
  return (0.55*near) + (0.30*timeFit) + (0.15*s) - samePenalty;
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
  // chiama API interna /api/plan (stesso dominio) usando fetch server-side
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
    const visitedIds = new Set(Array.isArray(body.visitedIds) ? body.visitedIds : []); // opzionale dal client
    const weekIds    = new Set(Array.isArray(body.weekIds) ? body.weekIds : []);       // opzionale dal client
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

    // ========= PUBLIC TRANSPORT =========
    if (mode==="plane" || mode==="train" || mode==="bus"){
      const plan = await callPlan(originObj, minutes, mode);
      const results = Array.isArray(plan?.results) ? plan.results : [];

      const candidates = results.map(r=>{
        const dest = r.destination || {};
        const name = `${dest.name || "Meta"}${dest.country ? `, ${dest.country}` : ""}`;
        const km = (Number.isFinite(dest.lat) && Number.isFinite(dest.lon))
          ? haversineKm(oLat,oLon, Number(dest.lat), Number(dest.lon))
          : null;

        const oh = r.originHub?.code || r.originHub?.name || "";
        const dh = r.destinationHub?.code || r.destinationHub?.name || "";

        return {
          id: dest.id || normName(name).replace(/\s+/g,"_"),
          name,
          country: dest.country || "",
          type: "trasporto",
          visibility: style==="gems" ? "chicca" : "conosciuta",
          lat: Number(dest.lat),
          lng: Number(dest.lon),
          eta_min: Number(r.totalMinutes),
          distance_km: Number.isFinite(km) ? km : 0,
          hubSummary: `${oh} → ${dh}`,
          segments: Array.isArray(r.segments) ? r.segments : [],
          why: [
            `Ci arrivi entro ${minutes} min (stima).`,
            `Hub: ${oh || "?"} → ${dh || "?"}.`,
            `Se vuoi monetizzare: qui sotto potrai mettere “Acquista biglietti” (CTA).`
          ],
          what_to_do: [],
          what_to_eat: []
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
    const curated = readJson("curated.json");
    const curatedPlaces = Array.isArray(curated?.places) ? curated.places : [];

    const idx = readJson("places_index_eu_uk.json");
    const idxPlaces = Array.isArray(idx?.places) ? idx.places : [];

    // HARD CAP: entro tempo (ma con fallback progressivo per non restare mai vuoto)
    const caps = [1.15, 1.35, 1.80, 2.50, 3.50].map(x => Math.round(minutes*x));

    function buildCandidatesFrom(list, sourceLabel){
      return list
        .map(p => ({
          id: p.id,
          name: p.name,
          country: p.country || "",
          type: norm(p.type),
          visibility: norm(p.visibility) || (sourceLabel==="index" ? "chicca" : "conosciuta"),
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
        .filter(p => p.distance_km >= 1.8); // evita “sei già lì”
    }

    // 1) Curated candidates (match categoria stretto)
    const curatedCandidates = buildCandidatesFrom(curatedPlaces, "curated")
      .filter(p => allowedTypes.includes(p.type))
      .filter(p => {
        // se “mare” non deve mai proporre città inland
        if (allowedTypes.length===1 && allowedTypes[0]==="mare") return p.type==="mare";
        return true;
      });

    // 2) Index candidates (copertura totale) — ma SOLO per città/borghi
    // (Per mare/montagna/natura ecc, l’indice GeoNames non basta: quindi lo usiamo come fallback “onesto” solo se serve)
    const indexCandidatesBase = buildCandidatesFrom(idxPlaces, "index");

    // funzione: prova entro cap e trova almeno 3
    function pickWithinCaps(list){
      for (const capMin of caps){
        const within = list
          .filter(p => p.eta_min <= capMin)
          .filter(p => !visitedIds.has(p.id))
          .filter(p => !weekIds.has(p.id));
        if (within.length >= 3) return { capMin, within };
      }
      // se proprio niente: prendi i più vicini in assoluto (sempre non visitati se possibile)
      const notVisited = list.filter(p => !visitedIds.has(p.id));
      const base = (notVisited.length ? notVisited : list).slice().sort((a,b)=>a.eta_min-b.eta_min);
      return { capMin: caps[caps.length-1], within: base.slice(0, 25) };
    }

    // LOGICA CATEGORIE:
    // - Se categoria è città/borghi: usa curated + index (sempre)
    // - Se categoria è mare/montagna/natura/relax/bambini:
    //    - prova curated vicino
    //    - se zero: allarga cap (fino a 3.5x) sempre curated
    //    - se ancora zero: fallback “onesto” su città/borghi vicini, ma lo dichiara nel WHY
    const isCityLike = allowedTypes.includes("citta") || allowedTypes.includes("borgo");

    let pool = [];
    let noteFallback = "";

    if (isCityLike){
      pool = [...curatedCandidates, ...indexCandidatesBase.filter(p => ["citta","borgo"].includes(p.type))];
    } else {
      // categorie speciali: solo curated (per evitare "mare -> Milano")
      const onlyCurated = curatedCandidates;
      const pick1 = pickWithinCaps(onlyCurated);
      if (pick1.within.length >= 1){
        pool = pick1.within;
        if (pick1.capMin > minutes) {
          noteFallback = `Per trovare “${allowedTypes[0]}” vicino ho allargato il raggio: ~${pick1.capMin} min (stima).`;
        }
      } else {
        // fallback “onesto” su citta/borghi (sempre qualcosa)
        noteFallback = `Vicino a te non ho abbastanza mete “${allowedTypes[0]}” nel dataset. Ti propongo una meta carina vicina (città/borgo).`;
        pool = indexCandidatesBase.filter(p => ["citta","borgo"].includes(p.type));
      }
    }

    if (!pool.length){
      return res.status(200).json({ ok:true, top:null, alternatives:[], message:"Nessuna meta trovata." });
    }

    pool.forEach(p => {
      p._score = scorePlace(p, minutes, style, originLabel);

      // “chicche”: penalizza metropoli/mega-città quando l’utente vuole gems
      if (style==="gems" && p.type==="citta" && p.visibility==="conosciuta") p._score -= 0.22;

      // se abbiamo noteFallback, aiutiamo la scelta
      if (noteFallback) p._score -= 0.05;
    });

    pool.sort((a,b)=>b._score-a._score);

    const top = pool[0];
    const alts = pool.slice(1,3);

    // arricchisci WHY se vuoto o se c'è fallback
    function ensureWhy(p){
      const out = Array.isArray(p.why) ? [...p.why] : [];
      if (noteFallback) out.unshift(noteFallback);
      if (!out.length) {
        out.push(`Ci arrivi in ~${Math.round(p.eta_min)} min: perfetta con il tempo che hai.`);
        out.push(style==="gems" ? "È più da chicca: meno caos, più atmosfera." : "È una scelta solida: facile e senza sbatti.");
      } else {
        // aggiungi un “hook” monetizzabile
        out.push("Tip: tra poco qui compariranno link utili (biglietti, esperienze, posti dove mangiare).");
      }
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
      hint: "Controlla che esistano public/data/curated.json e public/data/places_index_eu_uk.json"
    });
  }
        }
