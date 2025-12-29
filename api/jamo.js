// /api/jamo.js — JAMO CORE v1
// Selezione intelligente per BELLEZZA + TEMPO + MEZZO
// EU + UK — NO mete casuali

import fs from "fs";
import path from "path";

const DATA = path.join(process.cwd(), "public", "data", "curated_places_types_eu_uk.json");

/* =========================
   Utils
========================= */
function readData() {
  return JSON.parse(fs.readFileSync(DATA, "utf8")).places;
}

function toRad(x){ return x*Math.PI/180; }
function haversineKm(aLat,aLon,bLat,bLon){
  const R=6371;
  const dLat=toRad(bLat-aLat), dLon=toRad(bLon-aLon);
  const lat1=toRad(aLat), lat2=toRad(bLat);
  const s=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}

function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }
function norm(s){ return String(s||"").toLowerCase(); }

/* =========================
   Velocità realistiche
========================= */
function speed(mode){
  if (mode==="walk") return 4;
  if (mode==="bike") return 15;
  if (mode==="car") return 70;
  if (mode==="train") return 120;
  if (mode==="bus") return 80;
  if (mode==="plane") return 750;
  return 70;
}

/* =========================
   Filtro categoria
========================= */
function matchCategory(place, category){
  if (!category || category==="citta_borghi") {
    return place.types.includes("citta") || place.types.includes("borgo");
  }
  return place.types.includes(category);
}

/* =========================
   Filtro mezzo
========================= */
function matchMode(place, mode){
  if (["walk","bike","car"].includes(mode)) return true;
  if (mode==="plane") return place.has_airport_near;
  if (mode==="train" || mode==="bus") return place.has_station;
  return true;
}

/* =========================
   Score intelligente
========================= */
function scorePlace(p, eta, targetMin, style){
  const timeFit = clamp(1 - Math.abs(eta - targetMin) / targetMin, 0, 1);
  const beauty  = p.beauty_score || 0.7;
  const chiccaBoost = style==="gems" && p.types.includes("chicca") ? 0.15 : 0;
  const cityPenalty = style==="gems" && p.types.includes("citta") && p.beauty_score < 0.9 ? -0.2 : 0;

  return (0.55 * timeFit) + (0.45 * beauty) + chiccaBoost + cityPenalty;
}

/* =========================
   API
========================= */
export default function handler(req,res){
  try{
    if (req.method !== "POST") {
      return res.status(405).json({ error:"POST only" });
    }

    const {
      origin,
      minutes,
      mode="car",
      style="known",
      category="citta_borghi",
      visitedIds=[]
    } = req.body || {};

    if (!origin?.lat || !origin?.lon || !minutes) {
      return res.status(400).json({ error:"origin & minutes required" });
    }

    const places = readData();
    const targetMin = Number(minutes);
    const maxKm = speed(mode) * (targetMin/60) * 1.6;

    /* =========================
       1️⃣ Base filter
    ========================= */
    let candidates = places
      .map(p=>{
        const km = haversineKm(origin.lat, origin.lon, p.lat, p.lng);
        const eta = (km / speed(mode)) * 60;
        return { ...p, km, eta };
      })
      .filter(p=>p.km > 2)
      .filter(p=>p.km <= maxKm)
      .filter(p=>matchCategory(p, category))
      .filter(p=>matchMode(p, mode))
      .filter(p=>!visitedIds.includes(p.id));

    /* =========================
       2️⃣ Se troppo pochi → allarga
    ========================= */
    if (candidates.length < 3) {
      candidates = places
        .map(p=>{
          const km = haversineKm(origin.lat, origin.lon, p.lat, p.lng);
          const eta = (km / speed(mode)) * 60;
          return { ...p, km, eta };
        })
        .filter(p=>p.km > 2)
        .filter(p=>matchCategory(p, category))
        .filter(p=>matchMode(p, mode))
        .filter(p=>!visitedIds.includes(p.id));
    }

    if (!candidates.length) {
      return res.status(200).json({
        ok:true,
        top:null,
        alternatives:[],
        message:`Nessuna meta ${category} trovata con ${mode} nel tempo indicato`
      });
    }

    /* =========================
       3️⃣ Ranking
    ========================= */
    candidates.forEach(p=>{
      p._score = scorePlace(p, p.eta, targetMin, style);
    });

    candidates.sort((a,b)=>b._score - a._score);

    const top = candidates[0];
    const alternatives = candidates.slice(1,3);

    /* =========================
       4️⃣ Output
    ========================= */
    function out(p){
      return {
        id: p.id,
        name: p.name,
        country: p.country,
        type: p.types,
        eta_min: Math.round(p.eta),
        distance_km: Math.round(p.km),
        beauty_score: p.beauty_score,
        why: [
          `È una meta bella (score ${p.beauty_score})`,
          `Tempo stimato: ~${Math.round(p.eta)} min`,
          style==="gems" ? "È una chicca selezionata" : "È una meta molto apprezzata"
        ]
      };
    }

    return res.status(200).json({
      ok:true,
      top: out(top),
      alternatives: alternatives.map(out)
    });

  } catch(e){
    return res.status(500).json({ error:String(e.message||e) });
  }
}
