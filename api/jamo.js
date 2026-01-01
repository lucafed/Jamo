// api/jamo.js — AUTO-ONLY (OFFLINE MACRO) — v1.0
// - Usa SOLO macro file: public/data/macros/it_macro_01_abruzzo.json
// - Ignora completamente plane/train/bus
// - Input POST:
//   {
//     origin:{lat,lon,label?},
//     minutes:number,
//     mode:"car" (o "auto"),
//     category:"ovunque"|"chicca"|"borgo"|"mare"|"montagna"|"natura"|"storia"|"relax"|"bambini"|"citta"|"citta_borghi",
//     style:"gems"|"known",
//     macroId?:"it_macro_01_abruzzo" (opzionale)
//   }

import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "public", "data");
const DEFAULT_MACRO = "it_macro_01_abruzzo.json";

function readJsonSafe(file, fallback) {
  try {
    const p = path.join(DATA_DIR, "macros", file);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
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

function canonicalMode(raw) {
  const m = norm(raw);
  if (["car", "auto", "macchina"].includes(m)) return "car";
  return "car";
}

function allowedTypesFromCategory(categoryRaw) {
  const c = norm(categoryRaw);

  if (c === "ovunque" || c === "any" || c === "random") return ["any"];
  if (c === "citta_borghi" || (c.includes("citta") && c.includes("borg"))) return ["citta", "borgo"];
  if (c === "citta" || c === "città" || c === "city") return ["citta"];
  if (c === "borgo" || c === "borghi") return ["borgo"];

  // categorie “tematiche”
  if (["mare", "montagna", "natura", "relax", "bambini", "storia", "chicca"].includes(c)) return [c];

  return ["any"];
}

// stima tempo auto: semplice e stabile (nessun “2000km”)
function estimateCarMinutes(origin, lat, lon) {
  const km = haversineKm(origin.lat, origin.lon, lat, lon);
  // velocità media realistica “mista”
  const avg = 68;
  const minutes = (km / avg) * 60;
  return { km, minutes };
}

function beautyScore(p) {
  const b = Number(p.beauty_score);
  if (Number.isFinite(b)) return clamp(b, 0.2, 1.0);
  // fallback se manca
  const vis = norm(p.visibility || "");
  let s = 0.72;
  if (vis === "conosciuta") s += 0.05;
  if (vis === "chicca") s += 0.10;
  return clamp(s, 0.55, 0.90);
}

function scorePlace(p, eta, targetMin, style) {
  const timeFit = clamp(1 - (Math.abs(eta - targetMin) / Math.max(20, targetMin * 0.75)), 0, 1);
  const nearFit = clamp(1 - (eta / (targetMin * 1.9)), 0, 1);
  const beauty = beautyScore(p);

  const vis = norm(p.visibility || "");
  const type = norm(p.type || "");

  // se l’utente vuole “gems”, penalizzo città troppo note
  const bigPenalty = (style === "gems" && type === "citta" && vis === "conosciuta") ? 0.10 : 0;

  // se vuole “known”, penalizzo roba con beauty bassa
  const mehPenalty = (style === "known" && beauty < 0.70) ? 0.10 : 0;

  return (0.54 * timeFit) + (0.18 * nearFit) + (0.28 * beauty) - bigPenalty - mehPenalty;
}

function normalizePlace(p) {
  if (!p || !p.id || !p.name) return null;
  const lat = Number(p.lat);
  const lon = Number(p.lon ?? p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    id: String(p.id),
    name: String(p.name),
    type: norm(p.type || "place"),
    area: p.area || "",
    lat, lon,
    tags: Array.isArray(p.tags) ? p.tags.map(norm) : [],
    visibility: p.visibility || "",
    beauty_score: Number(p.beauty_score),
    why: Array.isArray(p.why) ? p.why : [],
  };
}

function outPlace(p) {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    visibility: p.visibility || "",
    eta_min: Math.round(p.eta_min),
    distance_km: Math.round(p.distance_km),
    why: Array.isArray(p.why) ? p.why.slice(0, 4) : [],
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    const body = req.body || {};
    const origin = body.origin || {};
    const minutes = Number(body.minutes);
    const mode = canonicalMode(body.mode);
    const style = norm(body.style || "gems"); // gems|known
    const category = body.category || "ovunque";
    const allowed = allowedTypesFromCategory(category);

    const oLat = Number(origin.lat);
    const oLon = Number(origin.lon ?? origin.lng);

    if (!Number.isFinite(oLat) || !Number.isFinite(oLon)) {
      return res.status(400).json({ error: "origin must be {lat, lon}" });
    }
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return res.status(400).json({ error: "minutes must be positive" });
    }

    // ✅ car-only
    if (mode !== "car") {
      return res.status(200).json({
        ok: true,
        top: null,
        alternatives: [],
        message: "Modalità non supportata: questa build è SOLO AUTO.",
      });
    }

    const macroFile = DEFAULT_MACRO;
    const macro = readJsonSafe(macroFile, null);
    if (!macro || !Array.isArray(macro.places)) {
      return res.status(500).json({
        error: "Macro file mancante o invalido",
        hint: `Controlla: public/data/macros/${DEFAULT_MACRO}`,
      });
    }

    const originObj = { lat: oLat, lon: oLon, label: origin.label || "" };

    // pool
    const all = macro.places.map(normalizePlace).filter(Boolean);

    let pool = all.map((p) => {
      const est = estimateCarMinutes(originObj, p.lat, p.lon);
      return { ...p, distance_km: est.km, eta_min: est.minutes };
    });

    // elimina “sei già lì”
    pool = pool.filter(p => p.distance_km >= 1.2);

    // filtra per categoria
    pool = pool.filter((p) => {
      if (allowed[0] === "any") return true;

      // categoria tematica
      const t = p.type;
      const tags = p.tags || [];

      // se chiedi “chicca” accetta type chicca O visibility chicca O tag chicca
      if (allowed[0] === "chicca") {
        return t === "chicca" || norm(p.visibility) === "chicca" || tags.includes("chicca");
      }

      // altrimenti match su type o tag
      return (t === allowed[0]) || tags.includes(allowed[0]);
    });

    if (!pool.length) {
      return res.status(200).json({ ok: true, top: null, alternatives: [], message: "Nessuna meta trovata per questa categoria." });
    }

    // cap tempo: prendiamo “vicino al target”, con espansione dolce
    const caps = [1.05, 1.18, 1.35, 1.60].map(x => minutes * x);
    let within = [];
    let usedCap = caps[caps.length - 1];

    for (const cap of caps) {
      const tmp = pool.filter(p => p.eta_min <= cap);
      if (tmp.length >= 6) { within = tmp; usedCap = cap; break; }
    }
    if (!within.length) within = pool.slice().sort((a, b) => a.eta_min - b.eta_min).slice(0, 80);

    within.forEach(p => {
      p._score = scorePlace(p, p.eta_min, minutes, style);
    });
    within.sort((a, b) => b._score - a._score);

    const top = within[0];
    const alternatives = within.slice(1, 3);

    // why fallback
    const fallbackNote = usedCap > minutes * 1.12 ? `Ho allargato fino a ~${Math.round(usedCap)} min per trovare mete top.` : "";
    function buildWhy(p) {
      const base = Array.isArray(p.why) && p.why.length ? p.why.slice(0, 3) : [
        `Ci arrivi in ~${Math.round(p.eta_min)} min.`,
        style === "gems" ? "È una meta più particolare / fuori dai soliti giri." : "È una meta solida e super godibile.",
      ];
      const out = [];
      if (fallbackNote) out.push(fallbackNote);
      out.push(...base);
      return out.slice(0, 4);
    }

    top.why = buildWhy(top);
    alternatives.forEach(a => { a.why = buildWhy(a); });

    return res.status(200).json({
      ok: true,
      top: outPlace(top),
      alternatives: alternatives.map(outPlace),
      debug: { source: "macro_offline_car_only", macro: macro.id, minutes, category: allowed[0], style },
    });

  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
