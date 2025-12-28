/* =========================
   JAMO — app.js (Curated-first, EU+UK)
   - 1 meta consigliata + 2 alternative
   - Priorità: curated.json -> se non basta, fallback su /api/suggest (local)
   - Meteo: Open-Meteo (gratis)
   - Varietà: una meta non può essere consigliata più di 1 volta al giorno
   ========================= */

const API = {
  geocode: "/api/geocode",
  suggest: "/api/suggest",
  places: "/api/places" // opzionale (POI). Se non esiste non rompe.
};

const CURATED_URL = "/data/curated.json";

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const resultEl = $("result");
const placeNameEl = $("placeName");
const placeMetaEl = $("placeMeta");
const mapsLinkEl = $("mapsLink");
const altListEl = $("altList");
const poiListEl = $("poiList"); // opzionale

const goBtn = $("goBtn");
const gpsBtn = $("gpsBtn");
const rerollBtn = $("rerollBtn");
const visitedBtn = $("visitedBtn");

const LS_VISITED_KEY = "jamo_visited_v1";
const LS_DAILY_KEY = "jamo_daily_reco_v1"; // { "YYYY-MM-DD": ["id1","id2"] }

let lastPicks = { top: null, alternatives: [] };

/* -------------------------
   UI helpers
------------------------- */
function setStatus(msg, type = "") {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.className = "status" + (type ? " " + type : "");
}
function showResultBox(show) {
  if (!resultEl) return;
  resultEl.classList.toggle("hidden", !show);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

/* -------------------------
   LocalStorage: visited + daily
------------------------- */
function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function getVisitedSet() {
  try {
    const raw = localStorage.getItem(LS_VISITED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
function markVisited(id) {
  try {
    const set = getVisitedSet();
    set.add(id);
    localStorage.setItem(LS_VISITED_KEY, JSON.stringify([...set]));
  } catch {}
}
function getDailyRecoSet() {
  try {
    const raw = localStorage.getItem(LS_DAILY_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const key = todayKey();
    const arr = Array.isArray(obj?.[key]) ? obj[key] : [];
    return new Set(arr);
  } catch { return new Set(); }
}
function addDailyReco(id) {
  try {
    const raw = localStorage.getItem(LS_DAILY_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const key = todayKey();
    const arr = Array.isArray(obj?.[key]) ? obj[key] : [];
    if (!arr.includes(id)) arr.push(id);
    obj[key] = arr.slice(0, 30);
    localStorage.setItem(LS_DAILY_KEY, JSON.stringify(obj));
  } catch {}
}

/* -------------------------
   Origin: input OR GPS
------------------------- */
async function getOrigin() {
  const input = $("startInput")?.value?.trim() || "";

  // Manual origin via geocode
  if (input) {
    setStatus("Cerco la partenza…");
    const r = await fetch(`${API.geocode}?q=${encodeURIComponent(input)}`);
    if (!r.ok) throw new Error("Geocoding fallito");
    const data = await r.json();
    const lat = Number(data.lat);
    const lng = Number(data.lng ?? data.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("Geocode: coordinate non valide");
    return { lat, lng, label: data.label || input };
  }

  // GPS
  setStatus("Uso il GPS…");
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("GPS non supportato"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, label: "La tua posizione" }),
      () => reject(new Error("GPS non disponibile"))
    );
  });
}

/* -------------------------
   Meteo: Open-Meteo (gratis)
   return: "sunny" | "cloudy" | "rain"
------------------------- */
async function getWeatherClass(lat, lng) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&daily=weathercode,precipitation_probability_max&forecast_days=1&timezone=auto`;
  try {
    const r = await fetch(url);
    if (!r.ok) return "cloudy";
    const d = await r.json();
    const code = d?.daily?.weathercode?.[0];
    const pop = d?.daily?.precipitation_probability_max?.[0];
    if (Number.isFinite(pop) && pop >= 55) return "rain";
    if (Number.isFinite(code) && code >= 51) return "rain";
    if (Number.isFinite(code) && code <= 2) return "sunny";
    return "cloudy";
  } catch {
    return "cloudy";
  }
}

/* -------------------------
   Curated load
------------------------- */
async function loadCurated() {
  try {
    const r = await fetch(CURATED_URL, { cache: "no-store" });
    if (!r.ok) return [];
    const d = await r.json();
    const items = Array.isArray(d?.places) ? d.places : [];
    return items.map(x => ({
      id: x.id,
      name: x.name,
      country: x.country,
      type: x.type,
      visibility: x.visibility,
      tags: Array.isArray(x.tags) ? x.tags : [],
      what_to_do: Array.isArray(x.what_to_do) ? x.what_to_do : [],
      // curated currently has no coords -> if you add them later, we’ll use them
      lat: Number(x.lat ?? x.coordinates?.lat),
      lng: Number(x.lng ?? x.coordinates?.lng),
      source: "curated"
    })).filter(p => p.id && p.name);
  } catch {
    return [];
  }
}

/* -------------------------
   Distance & time estimate (approx)
------------------------- */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function avgSpeedKmh(mode) {
  if (mode === "walk") return 4.5;
  if (mode === "bike") return 15;
  if (mode === "train") return 110;
  if (mode === "bus") return 70;
  if (mode === "plane") return 650;
  return 80; // car
}
function estimateEtaMin(origin, lat, lng, mode) {
  const d = haversineKm(origin.lat, origin.lng, lat, lng);
  const v = avgSpeedKmh(mode);
  let min = (d / v) * 60;
  // overheads (approx, not timetable)
  if (mode === "plane") min += 120;
  if (mode === "train") min += 20;
  if (mode === "bus") min += 15;
  return { distance_km: d, eta_min: min };
}

/* -------------------------
   Scoring (equilibrium)
------------------------- */
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function timeFitScore(etaMin, targetMin) {
  const minOk = Math.max(12, targetMin * 0.35);
  const maxOk = targetMin * 1.10;
  if (etaMin < minOk) return 0.35;
  if (etaMin > maxOk) return 0.0;
  const diff = Math.abs(etaMin - targetMin);
  const norm = clamp(1 - (diff / (targetMin * 0.55)), 0, 1);
  return 0.55 + norm * 0.45;
}

function wowScore(p, style) {
  // style: known | gems
  const tags = new Set(p.tags || []);
  let s = 0;

  if (p.visibility === "conosciuta") s += (style === "known") ? 1.0 : 0.35;
  if (p.visibility === "chicca") s += (style === "gems") ? 1.0 : 0.35;

  if (tags.has("iconica")) s += 0.9;
  if (tags.has("panoramica")) s += 0.6;
  if (tags.has("romantica")) s += 0.35;
  if (tags.has("instagrammabile")) s += 0.35;
  if (tags.has("autentica")) s += 0.45;
  if (tags.has("avventura")) s += 0.35;
  if (tags.has("slow")) s += 0.20;

  return clamp(s, 0, 2.2) / 2.2;
}

function weatherScore(p, weather) {
  const tags = new Set(p.tags || []);
  if (!weather) return 0.6;
  if (weather === "rain") {
    if (tags.has("pioggia_ok")) return 1.0;
    if (tags.has("sole_ok")) return 0.2;
    return 0.45;
  }
  if (weather === "sunny") {
    if (tags.has("sole_ok")) return 1.0;
    if (tags.has("pioggia_ok")) return 0.55;
    return 0.7;
  }
  return tags.has("pioggia_ok") ? 0.8 : 0.7; // cloudy
}

function finalScore(p, targetMin, style, weather, dailySet, visitedSet) {
  // Hard gates
  if (visitedSet.has(p.id)) return -999;
  if (dailySet.has(p.id)) return -999;

  const t = timeFitScore(p.eta_min, targetMin);
  const w = wowScore(p, style);
  const met = weatherScore(p, weather);

  // weights (equilibrium)
  return (0.45 * t) + (0.35 * w) + (0.20 * met);
}

/* -------------------------
   Local fallback (server /api/suggest)
------------------------- */
async function fetchLocalFallback(origin, minutes, mode, visitedCsv) {
  const url =
    `${API.suggest}?lat=${encodeURIComponent(origin.lat)}&lng=${encodeURIComponent(origin.lng)}` +
    `&minutes=${encodeURIComponent(minutes)}&mode=${encodeURIComponent(mode)}` +
    (visitedCsv ? `&visited=${encodeURIComponent(visitedCsv)}` : "");

  const r = await fetch(url);
  if (!r.ok) return [];
  const data = await r.json();

  const out = [];
  if (data?.top) out.push({
    id: data.top.id,
    name: data.top.name,
    lat: data.top.lat,
    lng: data.top.lng,
    eta_min: Number(data.top.eta_min),
    distance_km: Number(data.top.distance_km),
    tags: [], // local has no curated tags
    visibility: "chicca",
    type: "borgo", // local default, we treat as "local place"
    source: "local"
  });

  (data?.alternatives || []).forEach(a => out.push({
    id: a.id,
    name: a.name,
    lat: a.lat,
    lng: a.lng,
    eta_min: Number(a.eta_min),
    distance_km: Number(a.distance_km),
    tags: [],
    visibility: "chicca",
    type: "borgo",
    source: "local"
  }));

  // Dedup by id
  const seen = new Set();
  return out.filter(x => x.id && !seen.has(x.id) && seen.add(x.id));
}

/* -------------------------
   Render (1 + 2 alternatives)
------------------------- */
function renderResult(top, alternatives, weatherLabel) {
  showResultBox(true);

  placeNameEl.textContent = top.name;

  const eta = Number.isFinite(top.eta_min) ? `${Math.round(top.eta_min)} min` : "";
  const km = Number.isFinite(top.distance_km) ? `${top.distance_km.toFixed(0)} km` : "";
  const w = weatherLabel ? ` · meteo: ${weatherLabel}` : "";
  placeMetaEl.textContent = [eta, km].filter(Boolean).join(" · ") + w;

  const q = encodeURIComponent(top.name);
  mapsLinkEl.href = `https://www.google.com/maps/search/?api=1&query=${q}`;

  // What to do (from curated if present)
  if (poiListEl) {
    poiListEl.innerHTML = "";
    if (Array.isArray(top.what_to_do) && top.what_to_do.length) {
      top.what_to_do.slice(0, 6).forEach(t => {
        const div = document.createElement("div");
        div.className = "alt-item";
        div.innerHTML = `<div class="name">${escapeHtml(t)}</div>`;
        poiListEl.appendChild(div);
      });
    } else {
      const div = document.createElement("div");
      div.className = "alt-item";
      div.innerHTML = `<div class="name">Consigli in arrivo…</div><div class="small">Per questa meta aggiungeremo cose da fare/mangiare.</div>`;
      poiListEl.appendChild(div);
    }
  }

  // Alternatives
  altListEl.innerHTML = "";
  if (!alternatives.length) {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">Nessuna alternativa trovata</div>`;
    altListEl.appendChild(div);
  } else {
    alternatives.slice(0, 2).forEach((a) => {
      const div = document.createElement("div");
      div.className = "alt-item";
      div.innerHTML = `
        <div class="name">${escapeHtml(a.name)}</div>
        <div class="small">${Math.round(a.eta_min || 0)} min · ${(a.distance_km || 0).toFixed(0)} km</div>
      `;
      div.onclick = () => {
        // swap: clicked alt becomes top
        const newTop = a;
        const newAlts = [top, ...alternatives.filter(x => x.id !== a.id)].slice(0, 2);
        lastPicks = { top: newTop, alternatives: newAlts };
        renderResult(newTop, newAlts, weatherLabel);
        setStatus("Ok, cambio meta 🎲", "ok");
      };
      altListEl.appendChild(div);
    });
  }

  // Buttons
  if (visitedBtn) {
    visitedBtn.onclick = () => {
      markVisited(top.id);
      setStatus("Segnato come già visitato ✅", "ok");
    };
  }
  if (rerollBtn) {
    rerollBtn.onclick = () => {
      if (!lastPicks?.alternatives?.length) return;
      const next = lastPicks.alternatives[0];
      const rest = lastPicks.alternatives.slice(1);
      lastPicks = { top: next, alternatives: [top, ...rest].slice(0, 2) };
      renderResult(lastPicks.top, lastPicks.alternatives, weatherLabel);
      setStatus("Ok, nuova proposta 🎲", "ok");
    };
  }
}

/* -------------------------
   Main: curated-first
------------------------- */
async function run() {
  showResultBox(false);

  const minutes = Number($("timeSelect")?.value || 60);
  const mode = ($("modeSelect")?.value || "car").toLowerCase();

  // no mix: user chooses ONE type
  const type = ($("typeSelect")?.value || "città").toLowerCase();

  // style affects known vs gems
  const style = ($("styleSelect")?.value || "known").toLowerCase(); // known|gems

  const visitedSet = getVisitedSet();
  const dailySet = getDailyRecoSet();

  // visitedCsv for server fallback
  const visitedCsv = [...visitedSet].slice(0, 150).join(",");

  setStatus("Calcolo la meta migliore…");

  const origin = await getOrigin();

  setStatus("Controllo il meteo…");
  const weather = await getWeatherClass(origin.lat, origin.lng);
  const weatherLabel = (weather === "rain") ? "pioggia" : (weather === "sunny" ? "sole" : "nuvoloso");

  // 1) CURATED FIRST
  setStatus("Cerco tra le mete migliori (curate)…");
  const curated = await loadCurated();

  // IMPORTANT: curated.json currently may not have coords.
  // If coords missing, that item cannot be scored by distance/time.
  let curatedScored = curated
    .filter(p => p.type === type) // no mix
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map(p => {
      const est = estimateEtaMin(origin, p.lat, p.lng, mode);
      return { ...p, ...est };
    });

  // Filter by time window
  const maxMin = minutes * 1.10;
  const minMin = Math.max(12, minutes * 0.35);
  curatedScored = curatedScored.filter(p => p.eta_min <= maxMin && p.eta_min >= minMin);

  // Score and sort
  curatedScored.forEach(p => {
    p._score = finalScore(p, minutes, style, weather, dailySet, visitedSet);
  });
  curatedScored = curatedScored.filter(p => p._score > -100).sort((a,b)=>b._score - a._score);

  // Pick from curated if enough
  let pool = curatedScored.slice(0, 20);

  // 2) FALLBACK LOCAL (only if we have < 3 candidates)
  if (pool.length < 3) {
    setStatus("Aggiungo mete locali vicino a te…");
    const local = await fetchLocalFallback(origin, minutes, mode, visitedCsv);

    // Local filtering by chosen type: we map local as:
    // - if user asked "natura" -> keep local only if name hints nature (basic heuristic)
    // - else we allow as "borgo/città" fallback
    const localFiltered = local.filter(p => {
      if (type === "natura") {
        return /lago|monte|parco|cascat|valle|grotte|isola|beach|coast|cliff|forest/i.test(p.name);
      }
      if (type === "mare") {
        return /spiagg|mare|beach|coast|bay|cala/i.test(p.name);
      }
      // for city/borgo/others allow
      return true;
    });

    pool = pool.concat(localFiltered);
  }

  // If still no pool -> message
  if (pool.length < 1) {
    setStatus("Non trovo mete con questi filtri. Aumenta il tempo o cambia tipo/meta.", "err");
    return;
  }

  // Re-score whole pool (curated have tags, local have few tags)
  pool = dedupById(pool).map(p => {
    const score = finalScore(p, minutes, style, weather, dailySet, visitedSet);
    return { ...p, _score: score };
  }).filter(p => p._score > -100).sort((a,b)=>b._score - a._score);

  // Ensure at least 1
  if (!pool.length) {
    setStatus("Non trovo mete valide oggi. Prova un altro tipo o aumenta il tempo.", "err");
    return;
  }

  // Pick top + 2 alts
  const top = pool[0];
  const alternatives = pool.slice(1, 3);

  lastPicks = { top, alternatives };

  // Save daily recommended (top only)
  addDailyReco(top.id);

  renderResult(top, alternatives, weatherLabel);
  setStatus("Meta trovata ✔", "ok");
}

function dedupById(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (!x?.id) continue;
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    out.push(x);
  }
  return out;
}

/* -------------------------
   Events
------------------------- */
goBtn.onclick = async () => {
  goBtn.disabled = true;
  try {
    await run();
  } catch (e) {
    setStatus("Errore: " + (e?.message || String(e)), "err");
  } finally {
    goBtn.disabled = false;
  }
};

gpsBtn.onclick = () => {
  if ($("startInput")) $("startInput").value = "";
  setStatus("Ok: userò il GPS quando premi “DOVE ANDIAMO?”");
};
