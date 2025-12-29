// /api/jamo.js — JAMO CORE v2 (EU+UK) — FIX PLANE + CATEGORY
// - car/walk/bike: usa index (curated_places_types_eu_uk.json)
// - plane/train/bus: usa SEMPRE /api/plan per avere HUB + SEGMENTS
// - plane: default NO borghi (solo città) per evitare "borghi random"
// - category mare/montagna: se non disponibile nel dataset -> fallback dichiarato

import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "public", "data");
const INDEX_FILE = path.join(DATA_DIR, "curated_places_types_eu_uk.json");

function readIndex() {
  const raw = fs.readFileSync(INDEX_FILE, "utf8");
  const json = JSON.parse(raw);
  return Array.isArray(json?.places) ? json.places : [];
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
function norm(s){
  return String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();
}
function normName(s){
  return norm(s).replace(/[^a-z0-9]+/g," ").trim();
}

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
  // categorie speciali (funzionano SOLO se esistono nel dataset!)
  if (["mare","montagna","natura","relax","bambini"].includes(c)) return [c];
  return ["citta","borgo"];
}

function speed(mode){
  if (mode==="walk") return 4;
  if (mode==="bike") return 15;
  return 70; // car default per stime “auto-like”
}

// Stima ETA “auto-like” (solo per ranking e coerenza locale)
function estimate(origin, lat, lng, mode){
  const km = haversineKm(origin.lat, origin.lon, lat, lng);
  const eta = (km / speed(mode)) * 60;
  return { km, eta };
}

// Beauty score: se non presente, deduco da "quanto è importante"
// (citta grandi un filo meglio per known; chicche meglio per gems)
function beautyScore(p, style){
  const b = Number(p.beauty_score);
  if (Number.isFinite(b)) return clamp(b, 0.1, 1.0);

  const types = Array.isArray(p.types) ? p.types : [];
  const isCity = types.includes("citta");
  const isChicca = types.includes("chicca") || norm(p.visibility)==="chicca";

  if (style==="gems") {
    if (isChicca) return 0.88;
    if (isCity) return 0.70;
    return 0.74;
  } else {
    if (isCity) return 0.84;
    if (isChicca) return 0.78;
    return 0.76;
  }
}

// Score: deve cambiare col tempo (target) e penalizzare roba troppo fuori target
function scoreLocal(p, eta, targetMin, style){
  const timeFit = clamp(1 - Math.abs(eta - targetMin) / Math.max(20, targetMin), 0, 1);
  const nearFit = clamp(1 - (eta / (targetMin * 1.35)), 0, 1);
  const beauty  = beautyScore(p, style);

  // Chicche: penalizza metropoli quando user vuole gems
  const types = Array.isArray(p.types) ? p.types : [];
  const isBigCity = types.includes("citta") && norm(p.visibility)==="conosciuta";
  const bigCityPenalty = (style==="gems" && isBigCity) ? 0.18 : 0;

  return (0.42 * nearFit) + (0.33 * timeFit) + (0.25 * beauty) - bigCityPenalty;
}

// Call /api/plan server-side (stesso dominio)
async function callPlan(origin, maxMinutes, mode) {
  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  const r = await fetch(`${base}/api/plan`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({
      origin,
      maxMinutes,
      mode,
      limit: 25,
      // filtri “sensati”:
      minKm: mode==="plane" ? 180 : 35,
      avoidSameCity: true,
      avoidSameHub: true,
      preferNear: true
    })
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`PLAN ${r.status}: ${text.slice(0,120)}`);
  return JSON.parse(text);
}

function outLocal(p, km, eta){
  return {
    id: p.id,
    name: p.country ? `${p.name}, ${p.country}` : p.name,
    country: p.country || "",
    type: Array.isArray(p.types) ? p.types : [],
    visibility: p.visibility || "",
    eta_min: Math.round(eta),
    distance_km: Math.round(km),
    why: (p.why && p.why.length) ? p.why.slice(0,4) : [],
    what_to_do: (p.what_to_do || []).slice(0,6),
    what_to_eat: (p.what_to_eat || []).slice(0,5)
  };
}

function outPlan(p){
  return {
    id: p.id,
    name: p.name,
    country: p.country || "",
    type: p.type || "trasporto",
    visibility: p.visibility || "",
    eta_min: Math.round(p.eta_min),
    distance_km: Math.round(p.distance_km),
    hubSummary: p.hubSummary,
    segments: Array.isArray(p.segments) ? p.segments : [],
    why: (p.why || []).slice(0,4),
    what_to_do: (p.what_to_do || []).slice(0,6),
    what_to_eat: (p.what_to_eat || []).slice(0,5)
  };
}

export default async function handler(req,res){
  try{
    if (req.method !== "POST") return res.status(405).json({ error:"POST only" });

    const body = req.body || {};
    const origin = body.origin || {};
    const minutes = Number(body.minutes);
    const mode = canonicalMode(body.mode || "car");
    const style = norm(body.style || "known"); // known|gems
    const allowedTypes = allowedTypesFromCategory(body.category || "citta_borghi");
    const visitedIds = new Set(Array.isArray(body.visitedIds) ? body.visitedIds : []);
    const weekIds = new Set(Array.isArray(body.weekIds) ? body.weekIds : []);

    const oLat = Number(origin.lat);
    const oLon = Number(origin.lon);
    if (!Number.isFinite(oLat) || !Number.isFinite(oLon)) {
      return res.status(400).json({ error:"origin must be {lat, lon}" });
    }
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return res.status(400).json({ error:"minutes must be positive" });
    }

    const originObj = { lat:oLat, lon:oLon, label: origin.label || "" };
    const categoryIsSpecial = ["mare","montagna","natura","relax","bambini"].includes(allowedTypes[0]);
    const categoryIsCityLike = allowedTypes.includes("citta") || allowedTypes.includes("borgo");

    /* =========================
       A) PUBLIC TRANSPORT: /api/plan
    ========================= */
    if (mode==="plane" || mode==="train" || mode==="bus") {
      const plan = await callPlan(originObj, minutes, mode);
      const results = Array.isArray(plan?.results) ? plan.results : [];

      if (!results.length) {
        return res.status(200).json({ ok:true, top:null, alternatives:[], message:"Nessuna rotta trovata." });
      }

      // Carico index per “taggare” la destinazione (citta/borgo/beauty)
      // Match “soft”: nome+countr, oppure nearest
      const index = readIndex();

      function attachIndex(dest){
        const dn = normName(dest.name || "");
        const dc = norm(dest.country || "");
        let best = null;
        let bestScore = 0;

        for (const p of index) {
          const pn = normName(p.name || "");
          const pc = norm(p.country || "");
          if (dc && pc && dc !== pc) continue;

          // match by name
          if (dn && pn && dn === pn) {
            best = p; bestScore = 1;
            break;
          }
        }

        // fallback nearest by lat/lon
        if (!best && Number.isFinite(dest.lat) && Number.isFinite(dest.lon)) {
          let bestKm = Infinity;
          for (const p of index) {
            const plat = Number(p.lat), plon = Number(p.lng);
            if (!Number.isFinite(plat) || !Number.isFinite(plon)) continue;
            if (dc && p.country && norm(p.country) !== dc) continue;
            const km = haversineKm(dest.lat, dest.lon, plat, plon);
            if (km < bestKm) { bestKm = km; best = p; }
          }
          if (best && bestKm < 30) bestScore = 0.6;
        }

        return { best, bestScore };
      }

      // Costruisci candidates + filtri forti
      let candidates = results.map(r=>{
        const dest = r.destination || {};
        const { best } = attachIndex(dest);

        const types = best?.types || (best?.type ? [best.type] : []);
        const visibility = best?.visibility || (style==="gems" ? "chicca" : "conosciuta");

        const kmDirect = (Number.isFinite(dest.lat) && Number.isFinite(dest.lon))
          ? haversineKm(oLat,oLon, Number(dest.lat), Number(dest.lon))
          : null;

        const oh = r.originHub?.code || r.originHub?.name || "";
        const dh = r.destinationHub?.code || r.destinationHub?.name || "";

        return {
          id: dest.id || `${normName(dest.name || "dest")}_${dest.country || ""}`.replace(/\s+/g,"_"),
          name: `${dest.name || "Meta"}${dest.country ? `, ${dest.country}` : ""}`,
          country: dest.country || "",
          lat: Number(dest.lat),
          lng: Number(dest.lon),
          eta_min: Number(r.totalMinutes),
          distance_km: Number.isFinite(kmDirect) ? kmDirect : 0,
          type: "trasporto",
          visibility,
          hubSummary: `${oh} → ${dh}`,
          segments: Array.isArray(r.segments) ? r.segments : [],
          // info di “bellezza” dalla città matching
          _types: Array.isArray(types) ? types : [],
          _beauty: best ? beautyScore(best, style) : 0.78
        };
      })
      .filter(c => Number.isFinite(c.eta_min) && c.eta_min > 0)
      .filter(c => !visitedIds.has(c.id))
      .filter(c => !weekIds.has(c.id));

      // ✅ AEREO: NO BORGI RANDOM
      if (mode==="plane") {
        // Se l’utente non ha scelto "borgo" esplicitamente, proponi solo città
        if (!allowedTypes.includes("borgo")) {
          candidates = candidates.filter(c => c._types.includes("citta"));
        }
        // extra: niente destinazioni troppo vicine in aereo
        candidates = candidates.filter(c => c.distance_km >= 180);
      }

      // ✅ Filtra per categoria se possibile
      // Nota: per mare/montagna NON possiamo “garantire” senza dataset dedicato,
      // però se nel match index ci fosse il tag, lo usiamo.
      let filteredByCategory = candidates;
      if (categoryIsSpecial) {
        filteredByCategory = candidates.filter(c => c._types.includes(allowedTypes[0]));
      } else if (categoryIsCityLike) {
        // per città/borghi: ok
      }

      let noteFallback = "";
      if (categoryIsSpecial && filteredByCategory.length < 3) {
        noteFallback = `Nota: per “${allowedTypes[0]}” con ${mode} non ho abbastanza mete classificate. Ti propongo l’hub migliore vicino al tuo tempo e poi lì puoi scegliere ${allowedTypes[0]}.`;
        filteredByCategory = candidates;
      }

      // Score: vicino al target + beauty
      filteredByCategory.forEach(c=>{
        const timeFit = clamp(1 - Math.abs(c.eta_min - minutes) / Math.max(30, minutes), 0, 1);
        c._score = (0.65 * timeFit) + (0.35 * c._beauty);
        if (noteFallback) c._score -= 0.03;
      });

      filteredByCategory.sort((a,b)=>b._score - a._score);

      const top = filteredByCategory[0];
      const alts = filteredByCategory.slice(1,3);

      if (!top) return res.status(200).json({ ok:true, top:null, alternatives:[], message:"Nessuna meta valida." });

      // why + CTA hooks
      top.why = [
        `Tempo stimato: ~${Math.round(top.eta_min)} min (coerente col tuo target).`,
        `Hub: ${top.hubSummary || "—"}.`,
        style==="gems" ? "Sto privilegiando mete più “da chicca” e meno inflazionate." : "Sto privilegiando mete solide e facili.",
        noteFallback || "Qui potrai inserire CTA: biglietti / esperienze / hotel."
      ].filter(Boolean).slice(0,4);

      alts.forEach(a=>{
        a.why = [
          `Alternativa valida entro ~${Math.round(a.eta_min)} min.`,
          `Hub: ${a.hubSummary || "—"}.`,
          "CTA pronta: link biglietti/esperienze (monetizzazione)."
        ].slice(0,4);
      });

      return res.status(200).json({
        ok:true,
        top: outPlan(top),
        alternatives: alts.map(outPlan),
        debug: { source:"plan", mode, minutes, allowedTypes, noteFallback }
      });
    }

    /* =========================
       B) LOCAL: car/walk/bike da index
    ========================= */
    const index = readIndex();

    // cap “realistico” + fallback progressivo
    const caps = [1.15, 1.35, 1.8, 2.6].map(x=>minutes*x);

    const base = index
      .map(p=>{
        const lat = Number(p.lat);
        const lng = Number(p.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

        const types = Array.isArray(p.types) ? p.types : (p.type ? [p.type] : []);
        const { km, eta } = estimate(originObj, lat, lng, mode);

        return {
          ...p,
          lat, lng,
          types,
          visibility: p.visibility || "",
          km, eta
        };
      })
      .filter(Boolean)
      .filter(p=>p.km > 1.8)
      .filter(p=>!visitedIds.has(p.id))
      .filter(p=>!weekIds.has(p.id));

    // filtro categoria “vero”
    let pool = base.filter(p=>{
      if (allowedTypes[0]==="mare") return p.types.includes("mare");
      if (allowedTypes[0]==="montagna") return p.types.includes("montagna");
      if (allowedTypes[0]==="natura") return p.types.includes("natura");
      if (allowedTypes[0]==="relax") return p.types.includes("relax");
      if (allowedTypes[0]==="bambini") return p.types.includes("bambini");
      // città/borghi:
      if (allowedTypes.includes("citta") || allowedTypes.includes("borgo")) {
        return allowedTypes.some(t => p.types.includes(t));
      }
      return true;
    });

    // per style gems: evita “cose random” → tieni solo citta/borgo (o tipo richiesto)
    // (se il tuo index in futuro include anche POI “strani”, qui li tagliamo)
    pool = pool.filter(p=>{
      const okCore = p.types.includes("citta") || p.types.includes("borgo") || categoryIsSpecial;
      return okCore;
    });

    // scegli cap che produce risultati coerenti col target
    let within = [];
    let usedCap = null;
    for (const cap of caps) {
      const tmp = pool.filter(p=>p.eta <= cap);
      if (tmp.length >= 3) { within = tmp; usedCap = cap; break; }
    }
    if (!within.length) {
      within = pool.slice().sort((a,b)=>a.eta-b.eta).slice(0,40);
      usedCap = caps[caps.length-1];
    }

    if (!within.length) {
      return res.status(200).json({ ok:true, top:null, alternatives:[], message:"Nessuna meta trovata." });
    }

    within.forEach(p=>{
      p._score = scoreLocal(p, p.eta, minutes, style);

      // se cap usato è molto oltre target, penalizza
      if (usedCap && usedCap > minutes*1.5) p._score -= 0.06;
    });

    within.sort((a,b)=>b._score - a._score);

    const top = within[0];
    const alts = within.slice(1,3);

    // why coerente + dichiarazione fallback tempo
    const fallbackNote = (usedCap && usedCap > minutes*1.25)
      ? `Per trovare abbastanza mete ho allargato un po’: fino a ~${Math.round(usedCap)} min (stima).`
      : "";

    function ensureWhy(p){
      const arr = Array.isArray(p.why) ? p.why.slice(0,3) : [];
      const out = [];
      if (fallbackNote) out.push(fallbackNote);
      if (arr.length) out.push(...arr);
      if (!arr.length) {
        out.push(`Ci arrivi in ~${Math.round(p.eta)} min: perfetta col tempo che hai.`);
        out.push(style==="gems" ? "È una chicca più tranquilla e particolare." : "È una meta solida e “easy”.");
        out.push("Qui potrai inserire CTA: esperienze / ristoranti / tour (monetizzazione).");
      }
      return out.slice(0,4);
    }

    top.why = ensureWhy(top);
    alts.forEach(a=> a.why = ensureWhy(a));

    return res.status(200).json({
      ok:true,
      top: outLocal(top, top.km, top.eta),
      alternatives: alts.map(p=>outLocal(p, p.km, p.eta)),
      debug: { source:"index", mode, minutes, allowedTypes, usedCap: Math.round(usedCap || minutes) }
    });

  } catch(e){
    return res.status(500).json({
      error: String(e?.message || e),
      hint: "Controlla che public/data/curated_places_types_eu_uk.json esista"
    });
  }
                   }
