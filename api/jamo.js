// pages/api/jamo.js — JAMO CORE v5 (MACRO OFFLINE + REAL TRAIN/BUS EDGES + PLANE FIX + OVUNQUE + WALK/BIKE FIX)
// - Local modes (car/walk/bike): usano SOLO mete offline dal macro (stabili)
// - Hub modes:
//   * plane: hub→hub via /api/plan (minMainKm abbassato per tratte corte)
//   * train/bus: se il macro ha edges => usa grafo reale (no tratte inventate)
// - Categoria "ovunque": ignora tipo (sceglie solo per tempo/mezzo/qualità)
// - Fix walk/bike (anti-2000km): hard limits
// - Fix 401: /api/plan chiamata sullo stesso host + Cookie forward

import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "public", "data");

function readJsonSafe(relPath, fallback) {
  try {
    const p = path.join(DATA_DIR, relPath);
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
  if (c === "ovunque" || c === "any" || c === "random") return ["any"];
  if (c.includes("borgh") && c.includes("citt")) return ["citta", "borgo"];
  if (c === "citta_borghi" || (c.includes("citta") && c.includes("borg"))) return ["citta", "borgo"];
  if (c === "citta" || c === "città" || c === "city") return ["citta"];
  if (c === "borgo" || c === "borghi") return ["borgo"];
  if (["mare", "montagna", "natura", "relax", "bambini"].includes(c)) return [c];
  return ["citta", "borgo"];
}

function avgSpeedKmh(mode) {
  if (mode === "walk") return 4.6;
  if (mode === "bike") return 15.0;
  return 70;
}
function estimateLocal(origin, lat, lon, mode) {
  const km = haversineKm(origin.lat, origin.lon, lat, lon);
  const eta = (km / avgSpeedKmh(mode)) * 60;
  return { km, eta };
}

function beautyScore(p) {
  const b = Number(p.beauty_score);
  if (Number.isFinite(b)) return clamp(b, 0.2, 1.0);
  const vis = norm(p.visibility || "");
  let s = vis === "chicca" ? 0.86 : 0.78;
  return clamp(s, 0.45, 0.92);
}

function scoreLocal(p, eta, targetMin, style) {
  const timeFit = clamp(1 - (Math.abs(eta - targetMin) / Math.max(22, targetMin * 0.75)), 0, 1);
  const nearFit = clamp(1 - (eta / (targetMin * 1.9)), 0, 1);

  const ratio = eta / Math.max(1, targetMin);
  const outOfBandPenalty =
    (ratio < 0.55) ? 0.22 :
    (ratio > 1.65) ? 0.18 :
    0;

  const beauty = beautyScore(p);
  const bigCityPenalty = (style === "gems" && norm(p.type) === "citta" && norm(p.visibility) === "conosciuta") ? 0.10 : 0;
  const randomPenalty = (style === "known" && beauty < 0.68) ? 0.12 : 0;

  return (0.50 * timeFit) + (0.18 * nearFit) + (0.32 * beauty) - outOfBandPenalty - bigCityPenalty - randomPenalty;
}

function hardLimitsForMode(mode, minutes) {
  if (mode === "walk") {
    const km = clamp((minutes / 60) * 5.5, 1.5, 18);
    return { maxKm: km, maxEta: minutes * 1.35 };
  }
  if (mode === "bike") {
    const km = clamp((minutes / 60) * 18, 3, 65);
    return { maxKm: km, maxEta: minutes * 1.40 };
  }
  return { maxKm: Infinity, maxEta: minutes * 2.60 };
}

function outLocal(p) {
  return {
    id: p.id,
    name: p.name,
    country: p.country || "",
    type: p.type || "place",
    visibility: p.visibility || "",
    eta_min: Math.round(p.eta_min),
    distance_km: Math.round(p.distance_km),
    why: Array.isArray(p.why) ? p.why.slice(0, 4) : [],
    what_to_do: Array.isArray(p.what_to_do) ? p.what_to_do.slice(0, 6) : [],
    what_to_eat: Array.isArray(p.what_to_eat) ? p.what_to_eat.slice(0, 5) : [],
    segments: Array.isArray(p.segments) ? p.segments : []
  };
}

function outPlanHub(candidate) {
  return {
    id: candidate.id,
    name: candidate.name,
    country: candidate.country || "",
    type: candidate.type || "hub",
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

async function callPlan(req, origin, maxMinutes, mode, extra = {}) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host).toString();
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
      limit: extra.limit ?? 40,
      // 🔥 FIX AEREO: prima 180km ti tagliava PSR→vicino (entro 60 min).
      minMainKm: extra.minMainKm ?? (mode === "plane" ? 80 : (mode === "train" ? 10 : 10)),
      avoidSameHub: true,
      preferNear: true,
      // macro (se vuoi usarlo anche in plan in futuro)
      macroId: extra.macroId || null
    })
  });

  const text = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`PLAN ${r.status}: ${text.slice(0, 220)}`);
  return JSON.parse(text);
}

/** Dijkstra semplice per edges (train/bus realistici) */
function shortestPathsFrom(originCode, nodes, edges) {
  const adj = new Map();
  for (const n of nodes) adj.set(n.code, []);
  for (const e of edges) {
    const from = e.from, to = e.to;
    const w = Number(e.minutes);
    if (!adj.has(from) || !adj.has(to) || !Number.isFinite(w) || w <= 0) continue;
    adj.get(from).push({ to, w });
    adj.get(to).push({ to: from, w }); // bidirezionale
  }

  const dist = new Map();
  const prev = new Map();
  const visited = new Set();

  for (const n of nodes) dist.set(n.code, Infinity);
  dist.set(originCode, 0);

  while (visited.size < nodes.length) {
    let u = null;
    let best = Infinity;
    for (const [k, v] of dist.entries()) {
      if (!visited.has(k) && v < best) { best = v; u = k; }
    }
    if (!u) break;
    visited.add(u);

    const neighbors = adj.get(u) || [];
    for (const { to, w } of neighbors) {
      const nd = best + w;
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd);
        prev.set(to, u);
      }
    }
  }

  return { dist, prev };
}

function buildPath(prev, from, to) {
  const out = [];
  let cur = to;
  while (cur && cur !== from) {
    out.push(cur);
    cur = prev.get(cur);
  }
  if (cur === from) out.push(from);
  out.reverse();
  return out.length >= 2 ? out : [];
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    const body = req.body || {};
    const origin = body.origin || {};
    const minutes = Number(body.minutes);
    const mode = canonicalMode(body.mode || "car");
    const style = norm(body.style || "known");
    const allowedTypes = allowedTypesFromCategory(body.category || "citta_borghi");

    const visitedIds = new Set(Array.isArray(body.visitedIds) ? body.visitedIds : []);
    const weekIds = new Set(Array.isArray(body.weekIds) ? body.weekIds : []);

    const macroId = String(body.macroId || "it_macro_01_abruzzo");
    const macro = readJsonSafe(`macros/${macroId}.json`, null);

    const oLat = Number(origin.lat);
    const oLon = Number(origin.lon ?? origin.lng);
    if (!Number.isFinite(oLat) || !Number.isFinite(oLon)) return res.status(400).json({ error: "origin must be {lat, lon}" });
    if (!Number.isFinite(minutes) || minutes <= 0) return res.status(400).json({ error: "minutes must be positive" });

    const originObj = { lat: oLat, lon: oLon, label: origin.label || "" };

    const isAny = allowedTypes[0] === "any";
    const specialCat = (!isAny && ["mare", "montagna", "natura", "relax", "bambini"].includes(allowedTypes[0]));

    // =========================
    // A) HUB MODES
    // =========================
    if (mode === "plane") {
      const plan = await callPlan(req, originObj, minutes, mode, { macroId, minMainKm: 80, limit: 40 });
      const results = Array.isArray(plan?.results) ? plan.results : [];
      if (!results.length) {
        return res.status(200).json({ ok: true, top: null, alternatives: [], message: "Nessun volo hub→hub entro il tempo scelto (prova ad aumentare i minuti)." });
      }

      const candidates = results.map((r) => {
        const oh = r.originHub || {};
        const dh = r.destinationHub || {};
        const segs = Array.isArray(r.segments) ? r.segments : [];
        const main = segs.find(s => s.kind === "main") || segs[0] || null;

        const mainMin = Number(main?.minutes ?? r.totalMinutes);
        if (!Number.isFinite(mainMin) || mainMin <= 0 || mainMin > minutes) return null;

        const destName = dh.city || dh.name || dh.code || "Hub";
        const id = (dh.code ? String(dh.code).toUpperCase() : `hub_${normName(destName)}`) + `_${mode}`;
        if (visitedIds.has(id) || weekIds.has(id)) return null;

        const dist = Number.isFinite(Number(r.distanceKmApprox)) ? Number(r.distanceKmApprox) : 0;

        const timeFit = clamp(1 - (Math.abs(mainMin - minutes) / Math.max(18, minutes * 0.60)), 0, 1);
        const score = (0.82 * timeFit) + (0.18 * clamp(1 - (dist / 1600), 0, 1));

        const hubSummary = `${(oh.code || "?")} → ${(dh.code || "?")}`;

        const why = [
          `Tratta PLANE stimata: ~${Math.round(mainMin)} min (hub→hub).`,
          `Hub: ${hubSummary}.`,
          isAny ? "Categoria: OVUNQUE (scelgo solo per tempo/mezzo/qualità)." :
            (specialCat ? `Categoria richiesta: ${allowedTypes[0]} (per aereo ti propongo l’hub migliore entro il tuo tempo).` :
              (style === "gems" ? "Preferisco mete più particolari." : "Preferisco mete solide e facili.")
            )
        ].slice(0, 4);

        return {
          id,
          name: destName + (dh.country ? `, ${dh.country}` : ""),
          country: dh.country || "",
          type: "hub",
          visibility: style === "gems" ? "chicca" : "conosciuta",
          eta_min: mainMin,
          distance_km: dist,
          hubSummary,
          segments: main ? [{ kind: "main", label: String(main.label || "Volo"), minutes: mainMin, km: main.km }] : [],
          what_to_do: [],
          what_to_eat: [],
          why,
          _score: score
        };
      }).filter(Boolean);

      if (!candidates.length) {
        return res.status(200).json({ ok: true, top: null, alternatives: [], message: `Trovati voli, ma nessuno rientra entro ${minutes} min.` });
      }

      candidates.sort((a, b) => b._score - a._score);
      return res.status(200).json({
        ok: true,
        top: outPlanHub(candidates[0]),
        alternatives: candidates.slice(1, 3).map(outPlanHub),
        debug: { source: "plane_plan", macroId, minutes }
      });
    }

    if (mode === "train" || mode === "bus") {
      const edges = (macro && macro.hubs && Array.isArray(macro.hubs[mode === "train" ? "train_edges" : "bus_edges"]))
        ? macro.hubs[mode === "train" ? "train_edges" : "bus_edges"]
        : [];

      const hubs = (macro && macro.hubs && Array.isArray(macro.hubs[mode === "train" ? "stations" : "bus_hubs"]))
        ? macro.hubs[mode === "train" ? "stations" : "bus_hubs"]
        : [];

      if (!hubs.length || !edges.length) {
        return res.status(200).json({
          ok: true,
          top: null,
          alternatives: [],
          message: `Dataset ${mode.toUpperCase()} non pronto: mancano hubs/edges nel macro. (Così evitiamo tratte inventate.)`
        });
      }

      // trova originHub più vicino tra hubs del macro
      let best = null, bestKm = Infinity;
      for (const h of hubs) {
        const km = haversineKm(oLat, oLon, Number(h.lat), Number(h.lon));
        if (km < bestKm) { bestKm = km; best = h; }
      }
      if (!best) {
        return res.status(200).json({ ok: true, top: null, alternatives: [], message: "Nessun hub trovato vicino alla partenza." });
      }

      const { dist, prev } = shortestPathsFrom(best.code, hubs, edges);

      const candidates = [];
      for (const dh of hubs) {
        if (!dh || dh.code === best.code) continue;
        const mainMin = Number(dist.get(dh.code));
        if (!Number.isFinite(mainMin) || mainMin <= 0 || mainMin > minutes) continue;

        const id = `${dh.code}_${mode}`;
        if (visitedIds.has(id) || weekIds.has(id)) continue;

        const path = buildPath(prev, best.code, dh.code);
        const segLabel = mode === "train" ? "Treno (macro edges)" : "Bus (macro edges)";

        candidates.push({
          id,
          name: dh.name + (dh.country ? `, ${dh.country}` : ""),
          country: dh.country || "",
          type: "hub",
          visibility: "conosciuta",
          eta_min: mainMin,
          distance_km: 0,
          hubSummary: `${best.name} → ${dh.name}`,
          segments: [
            { kind: "main", label: `${segLabel}: ${path.join(" → ")}`, minutes: Math.round(mainMin) }
          ],
          why: [
            `Tratta ${mode.toUpperCase()} realistica (grafo): ~${Math.round(mainMin)} min (hub→hub).`,
            `Hub: ${best.name} → ${dh.name}.`,
            "Niente tratte inventate: uso solo collegamenti presenti nel file macro."
          ],
          what_to_do: [],
          what_to_eat: [],
          _score: clamp(1 - Math.abs(mainMin - minutes) / Math.max(20, minutes * 0.9), 0, 1)
        });
      }

      if (!candidates.length) {
        return res.status(200).json({
          ok: true,
          top: null,
          alternatives: [],
          message: `Nessuna tratta ${mode.toUpperCase()} entro ${minutes} min usando solo collegamenti reali del macro.`
        });
      }

      candidates.sort((a, b) => b._score - a._score);
      return res.status(200).json({
        ok: true,
        top: outPlanHub(candidates[0]),
        alternatives: candidates.slice(1, 3).map(outPlanHub),
        debug: { source: "macro_edges", mode, macroId, originHub: best.code }
      });
    }

    // =========================
    // B) LOCAL MODES (car/walk/bike) — SOLO METE OFFLINE DAL MACRO
    // =========================
    if (!macro || !Array.isArray(macro.places) || !macro.places.length) {
      return res.status(500).json({
        error: "Macro non trovato o senza places",
        hint: "Crea public/data/macros/it_macro_01_abruzzo.json (JSON valido)."
      });
    }

    const hard = hardLimitsForMode(mode, minutes);

    const base = macro.places
      .filter(p => p && p.id && p.name && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)))
      .filter(p => !visitedIds.has(p.id) && !weekIds.has(p.id))
      .map(p => {
        const { km, eta } = estimateLocal(originObj, Number(p.lat), Number(p.lon), mode);
        return { ...p, distance_km: km, eta_min: eta };
      })
      .filter(p => p.distance_km >= 1.2)
      .filter(p => p.distance_km <= hard.maxKm && p.eta_min <= hard.maxEta);

    let pool = base.filter(p => {
      if (isAny) return true;
      const t = norm(p.type);
      const tags = Array.isArray(p.tags) ? p.tags.map(norm) : [];
      const want = allowedTypes;

      if (want.length === 1 && ["mare", "montagna", "natura", "relax", "bambini"].includes(want[0])) {
        return t === want[0] || tags.includes(want[0]);
      }
      if (want.includes("citta") || want.includes("borgo")) {
        return want.includes(t) || want.some(x => tags.includes(x));
      }
      return true;
    });

    // qualità minima
    pool = pool.filter(p => {
      const b = beautyScore(p);
      if ((mode === "walk" || mode === "bike") && b < 0.68) return false;
      return b >= 0.60;
    });

    // caps progressivi
    const capMult =
      mode === "walk" ? [1.10, 1.22, 1.35] :
      mode === "bike" ? [1.10, 1.28, 1.45] :
      [1.20, 1.45, 1.85, 2.60];

    const caps = capMult.map(x => minutes * x);
    let within = [];
    let usedCap = caps[caps.length - 1];

    for (const cap of caps) {
      const tmp = pool.filter(p => p.eta_min <= cap);
      if (tmp.length >= 6) { within = tmp; usedCap = cap; break; }
    }
    if (!within.length) within = pool.slice().sort((a, b) => a.eta_min - b.eta_min).slice(0, 60);

    if (!within.length) {
      return res.status(200).json({ ok: true, top: null, alternatives: [], message: "Nessuna meta trovata (prova ad aumentare minuti o cambia categoria)." });
    }

    within.forEach(p => { p._score = scoreLocal(p, p.eta_min, minutes, style); });
    within.sort((a, b) => b._score - a._score);

    const top = within[0];
    const alts = within.slice(1, 3);

    const fallbackNote = (usedCap > minutes * 1.35 && mode === "car")
      ? `Per trovare abbastanza mete ho allargato: fino a ~${Math.round(usedCap)} min (stima).`
      : "";

    function buildWhy(p) {
      const arr = Array.isArray(p.why) ? p.why.slice(0, 3) : [];
      const out = [];
      if (fallbackNote) out.push(fallbackNote);
      if (arr.length) out.push(...arr);
      else {
        out.push(`Ci arrivi in ~${Math.round(p.eta_min)} min: coerente col tempo selezionato.`);
        out.push(isAny ? "Categoria: OVUNQUE (scelgo solo per tempo/mezzo/qualità)." :
          (style === "gems" ? "È più particolare / fuori dai soliti giri." : "È una meta solida e facile da godere.")
        );
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
      debug: { source: "macro_places_only", macroId, mode, minutes, category: allowedTypes[0], pool: within.length }
    });

  } catch (e) {
    return res.status(500).json({
      error: String(e?.message || e),
      hint: "Controlla macro JSON e che sia valido (senza commenti)."
    });
  }
                                }
