// api/jamo.js — JAMO CORE ENGINE v1.0
// Seleziona mete BELLE, realistiche e coerenti con tempo + stile

import fs from "fs";
import path from "path";

/* ======================
   UTIL
====================== */
const DATA = (f) =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), "public", "data", f), "utf8"));

const toRad = (x) => (x * Math.PI) / 180;
const haversine = (a, b, c, d) => {
  const R = 6371;
  const dLat = toRad(c - a);
  const dLon = toRad(d - b);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a)) *
      Math.cos(toRad(c)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

/* ======================
   LIMITI REALISTICI
====================== */
function maxDistanceKm(minutes, mode) {
  if (mode === "walk") return minutes * 0.08;
  if (mode === "bike") return minutes * 0.25;
  return (
    minutes <= 45 ? 60 :
    minutes <= 90 ? 120 :
    minutes <= 180 ? 250 :
    400
  );
}

/* ======================
   SCORE BELLEZZA
====================== */
function beautyScore(p) {
  let s = 0;
  if (p.why?.length) s += 0.4;
  if (p.what_to_do?.length) s += 0.3;
  if (p.what_to_eat?.length) s += 0.2;
  if (p.visibility === "chicca") s += 0.3;
  return s;
}

/* ======================
   HANDLER
====================== */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ error: "POST only" });

    const {
      origin,
      minutes = 60,
      mode = "car",
      style = "known",
      category = "citta_borghi",
      visitedIds = [],
      weekIds = []
    } = req.body || {};

    if (!origin?.lat || !origin?.lon)
      return res.status(400).json({ error: "Invalid origin" });

    const oLat = Number(origin.lat);
    const oLon = Number(origin.lon);

    const maxKm = maxDistanceKm(minutes, mode);
    const visited = new Set(visitedIds);
    const week = new Set(weekIds);

    /* ======================
       DATI
    ====================== */
    const curated = DATA("curated.json").places || [];
    const index = DATA("places_index_eu_uk.json").places || [];

    /* ======================
       COSTRUZIONE CANDIDATI
    ====================== */
    function build(list, source) {
      return list
        .map((p) => {
          const km = haversine(oLat, oLon, p.lat, p.lng);
          const eta = (km / 70) * 60;
          return {
            ...p,
            distance_km: km,
            eta_min: eta,
            _source: source
          };
        })
        .filter((p) => p.distance_km >= 3)
        .filter((p) => p.distance_km <= maxKm)
        .filter((p) => !visited.has(p.id))
        .filter((p) => !week.has(p.id));
    }

    let pool = [];

    // 1️⃣ PRIORITÀ: curated (posti belli)
    pool = build(curated, "curated");

    // 2️⃣ BACKUP: index (solo città/borghi)
    if (pool.length < 3) {
      pool = pool.concat(
        build(index, "index").filter((p) =>
          ["citta", "borgo"].includes(p.type)
        )
      );
    }

    if (!pool.length)
      return res.json({ ok: true, top: null, alternatives: [] });

    /* ======================
       SCORING
    ====================== */
    pool.forEach((p) => {
      let score = 0;

      // distanza coerente col tempo
      score += 1 - Math.abs(p.eta_min - minutes) / minutes;

      // bellezza
      score += beautyScore(p);

      // stile
      if (style === "gems" && p.visibility === "chicca") score += 0.4;
      if (style === "gems" && p.visibility === "conosciuta") score -= 0.3;

      // penalizza metropoli per gite brevi
      if (minutes <= 90 && p.visibility === "conosciuta") score -= 0.3;

      p._score = score;
    });

    pool.sort((a, b) => b._score - a._score);

    const top = pool[0];
    const alternatives = pool.slice(1, 3);

    /* ======================
       WHY AUTO
    ====================== */
    function enrich(p) {
      const why = p.why?.length
        ? p.why
        : [
            `Si raggiunge in circa ${Math.round(p.eta_min)} minuti.`,
            p.visibility === "chicca"
              ? "È una chicca autentica, poco scontata."
              : "È una meta solida e interessante.",
            "Ottima scelta per il tempo che hai."
          ];

      return {
        ...p,
        why: why.slice(0, 4)
      };
    }

    return res.json({
      ok: true,
      top: enrich(top),
      alternatives: alternatives.map(enrich),
      debug: {
        pool: pool.length,
        maxKm,
        minutes,
        mode
      }
    });
  } catch (e) {
    return res.status(500).json({
      error: e.message || String(e)
    });
  }
}
