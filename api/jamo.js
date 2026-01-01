// pages/api/jamo.js — JAMO CORE v5 — AUTO ONLY (offline macro)
// ✅ Solo auto: mete stabili offline (macro JSON)
// ✅ Tempo = stima guida (no orari inventati)
// ✅ Preferisce Abruzzo, fallback fuori solo se dataset macro in futuro include neighbors
// ✅ Categoria: citta_borghi | mare | montagna | natura | relax | bambini | ovunque
// ✅ Stile: known | gems
// ✅ visitedIds / weekIds per evitare ripetizioni

import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "public", "data");
const MACRO_PATH = path.join(DATA_DIR, "macros", "it_macro_01_abruzzo.json");

function readJsonStrict(p) {
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

function canonicalCategory(raw) {
  const c = norm(raw);
  if (!c) return "citta_borghi";
  if (["ovunque","any","random"].includes(c)) return "ovunque";
  if (["mare","montagna","natura","relax","bambini"].includes(c)) return c;
  if (c.includes("citta") && c.includes("borg")) return "citta_borghi";
  if (c === "citta" || c === "città" || c === "city") return "citta";
  if (c === "borgo" || c === "borghi") return "borgo";
  return "citta_borghi";
}

function canonicalStyle(raw) {
  const s = norm(raw);
  return (s === "gems" || s === "chicche") ? "gems" : "known";
}

// Stima velocità: Abruzzo ha molte strade di montagna.
// Se tags include montagna/gole/trekking => più lento.
// Se mare/citta => più veloce.
function speedKmhForPlace(tags) {
  const t = new Set((tags || []).map(norm));
  const mountainish = t.has("montagna") || t.has("gole") || t.has("trekking") || t.has("parco_nazionale");
  const coastal = t.has("mare") || t.has("spiagge");
  const cityish = t.has("citta");

  if (mountainish) return 52;     // prudente
  if (coastal || cityish) return 68;
  return 62;                      // default misto
}

// “bellezza” clamp
function beautyScore(p) {
  const b = Number(p.beauty_score);
  if (Number.isFinite(b)) return clamp(b, 0.2, 1.0);
  // fallback raro: se non c'è, diamo medio-alto solo se chicca
  return (norm(p.visibility) === "chicca") ? 0.88 : 0.75;
}

// Score finale: tempo + bellezza + stile
function scorePlace(p, etaMin, targetMin, style) {
  const beauty = beautyScore(p);

  // quanto è vicino al tempo scelto (spinge mete diverse a 1h vs 2h)
  const timeFit = clamp(1 - (Math.abs(etaMin - targetMin) / Math.max(25, targetMin * 0.75)), 0, 1);

  // penalizza se troppo fuori banda (troppo vicino o troppo lontano)
  const ratio = etaMin / Math.max(1, targetMin);
  const outBand =
    (ratio < 0.55) ? 0.20 :
    (ratio > 1.55) ? 0.16 :
    0;

  const vis = norm(p.visibility || "");
  const isBigKnownCity = (style === "gems" && (p.type === "citta") && vis === "conosciuta");
  const cityPenalty = isBigKnownCity ? 0.10 : 0;

  return (0.50 * timeFit) + (0.50 * beauty) - outBand - cityPenalty;
}

function matchesCategory(p, category) {
  if (category === "ovunque") return true;

  const type = norm(p.type);
  const tags = new Set((p.tags || []).map(norm));

  if (category === "citta_borghi") return (type === "citta" || type === "borgo" || tags.has("citta") || tags.has("borgo"));
  if (category === "citta") return (type === "citta" || tags.has("citta"));
  if (category === "borgo") return (type === "borgo" || tags.has("borgo") || tags.has("chicca"));
  if (["mare","montagna","natura","relax","bambini"].includes(category)) {
    return type === category || tags.has(category);
  }
  return true;
}

function outPlace(p) {
  return {
    id: p.id,
    name: p.name,
    area: p.area || "",
    type: p.type || "place",
    visibility: p.visibility || "",
    beauty_score: Number(p.beauty_score) || null,
    eta_min: Math.round(p.eta_min),
    distance_km: Math.round(p.distance_km),
    tags: Array.isArray(p.tags) ? p.tags.slice(0, 10) : [],
    why: Array.isArray(p.why) ? p.why.slice(0, 4) : []
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    const body = req.body || {};
    const origin = body.origin || {};
    const minutes = Number(body.minutes);

    const oLat = Number(origin.lat);
    const oLon = Number(origin.lon ?? origin.lng);

    if (!Number.isFinite(oLat) || !Number.isFinite(oLon)) {
      return res.status(400).json({ error: "origin must be {lat, lon}" });
    }
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return res.status(400).json({ error: "minutes must be positive" });
    }

    const category = canonicalCategory(body.category);
    const style = canonicalStyle(body.style);

    const visitedIds = new Set(Array.isArray(body.visitedIds) ? body.visitedIds : []);
    const weekIds = new Set(Array.isArray(body.weekIds) ? body.weekIds : []);

    if (!fs.existsSync(MACRO_PATH)) {
      return res.status(500).json({
        error: "Macro file missing",
        hint: "Create: public/data/macros/it_macro_01_abruzzo.json"
      });
    }

    const macro = readJsonStrict(MACRO_PATH);
    const places = Array.isArray(macro?.places) ? macro.places : [];

    // normalizza + calcola tempo
    const computed = places
      .filter(p => p && p.id && p.name)
      .filter(p => !visitedIds.has(p.id))
      .filter(p => !weekIds.has(p.id))
      .map(p => {
        const lat = Number(p.lat);
        const lon = Number(p.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

        const km = haversineKm(oLat, oLon, lat, lon);
        // evita “sei già lì”
        if (km < 1.2) return null;

        const speed = speedKmhForPlace(p.tags || []);
        const eta = (km / speed) * 60;

        return {
          ...p,
          distance_km: km,
          eta_min: eta
        };
      })
      .filter(Boolean);

    // filtra per categoria
    let pool = computed.filter(p => matchesCategory(p, category));

    // filtra per qualità minima (taglia cose “meh”)
    pool = pool.filter(p => {
      const b = beautyScore(p);
      if (b < 0.70 && style !== "known") return false; // gems = più severo
      return true;
    });

    // caps progressivi (car): preferiamo stare vicino al tempo scelto
    const caps = [1.05, 1.18, 1.35, 1.60].map(x => minutes * x);

    let within = [];
    let usedCap = caps[caps.length - 1];

    for (const cap of caps) {
      const tmp = pool.filter(p => p.eta_min <= cap);
      if (tmp.length >= 10) { within = tmp; usedCap = cap; break; }
    }
    if (!within.length) {
      within = pool.slice().sort((a, b) => a.eta_min - b.eta_min).slice(0, 80);
    }

    if (!within.length) {
      return res.status(200).json({ ok: true, top: null, alternatives: [], message: "Nessuna meta trovata con questi filtri." });
    }

    // score
    within.forEach(p => { p._score = scorePlace(p, p.eta_min, minutes, style); });
    within.sort((a, b) => b._score - a._score);

    const top = within[0];
    const alts = within.slice(1, 3);

    // messaggio “onesto” se abbiamo dovuto allargare troppo
    const note = (usedCap > minutes * 1.25)
      ? `Per trovare abbastanza mete ho allargato il raggio: fino a ~${Math.round(usedCap)} min di guida stimata.`
      : "";

    // why fallback se mancano
    function buildWhy(p) {
      const out = [];
      if (note) out.push(note);
      if (Array.isArray(p.why) && p.why.length) out.push(...p.why.slice(0, 3));
      if (out.length < 2) out.push(`Guida stimata ~${Math.round(p.eta_min)} min (auto).`);
      if (out.length < 3) out.push(style === "gems" ? "Scelta più 'chicca' possibile col tuo tempo." : "Scelta solida e bella col tuo tempo.");
      return out.slice(0, 4);
    }

    top.why = buildWhy(top);
    alts.forEach(a => { a.why = buildWhy(a); });

    return res.status(200).json({
      ok: true,
      top: outPlace(top),
      alternatives: alts.map(outPlace),
      debug: {
        mode: "car",
        minutes,
        category,
        style,
        pool_size: within.length,
        macro: macro?.id || "unknown"
      }
    });
  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
      hint: "Controlla che il macro JSON sia valido e nel percorso corretto: public/data/macros/it_macro_01_abruzzo.json"
    });
  }
}
