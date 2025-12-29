/* =========================
   JAMO — app.js (v3 STABILE + PLAN HUBS)
   - Car/Walk/Bike: curated.json + fallback /api/suggest
   - Plane/Train/Bus: /api/plan (hub partenza/arrivo + segmenti + tempo)
   - Meteo: Open-Meteo (gratis)
   - Daily no-repeat + visited localStorage
   - POI: curated what_to_do; fallback /api/places (opzionale)
   ========================= */

const API = {
  geocode: "/api/geocode",
  suggest: "/api/suggest",
  plan: "/api/plan",
  places: "/api/places" // opzionale
};

const CURATED_URL = "/data/curated.json";
const $ = (id) => document.getElementById(id);

// UI refs
const statusEl    = $("status");
const resultEl    = $("result");
const placeNameEl = $("placeName");
const placeMetaEl = $("placeMeta");
const mapsLinkEl  = $("mapsLink");
const altListEl   = $("altList");
const poiListEl   = $("poiList");

const goBtn       = $("goBtn");
const gpsBtn      = $("gpsBtn");
const rerollBtn   = $("rerollBtn");
const visitedBtn  = $("visitedBtn");

// Storage keys
const LS_VISITED_KEY = "jamo_visited_v1";
const LS_DAILY_KEY   = "jamo_daily_reco_v1"; // { "YYYY-MM-DD": ["id1","id2"] }

// State
let lastPicks = { top: null, alternatives: [] };

/* -------------------------
   Helpers: UI
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
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

/* -------------------------
   Storage: visited + daily
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
  } catch {
    return new Set();
  }
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
  } catch {
    return new Set();
  }
}

function addDailyReco(id) {
  try {
    const raw = localStorage.getItem(LS_DAILY_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const key = todayKey();
    const arr = Array.isArray(obj?.[key]) ? obj[key] : [];
    if (!arr.includes(id)) arr.push(id);
    obj[key] = arr.slice(0, 50);
    localStorage.setItem(LS_DAILY_KEY, JSON.stringify(obj));
  } catch {}
}

/* -------------------------
   Origin: input OR GPS
------------------------- */
async function getOrigin() {
  const input = $("startInput")?.value?.trim() || "";

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
------------------------- */
async function getWeather(originLat, originLng) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(originLat)}` +
    `&longitude=${encodeURIComponent(originLng)}` +
    `&daily=weathercode,precipitation_probability_max&forecast_days=1&timezone=auto`;

  try {
    const r = await fetch(url);
    if (!r.ok) return { cls: "cloudy", label: "nuvoloso" };
    const d = await r.json();
    const code = d?.daily?.weathercode?.[0];
    const pop = d?.daily?.precipitation_probability_max?.[0];

    if (Number.isFinite(pop) && pop >= 55) return { cls: "rain", label: "pioggia" };
    if (Number.isFinite(code) && code >= 51) return { cls: "rain", label: "pioggia" };
    if (Number.isFinite(code) && code <= 2) return { cls: "sunny", label: "sole" };
    return { cls: "cloudy", label: "nuvoloso" };
  } catch {
    return { cls: "cloudy", label: "nuvoloso" };
  }
}

/* -------------------------
   Curated load (local)
------------------------- */
async function loadCurated() {
  try {
    const r = await fetch(CURATED_URL, { cache: "no-store" });
    if (!r.ok) return [];
    const d = await r.json();
    const items = Array.isArray(d?.places) ? d.places : [];

    return items
      .map((x) => ({
        id: x.id,
        name: x.name,
        country: x.country,
        type: x.type,                 // es: "città" | "mare" | "montagna" | "bambini"
        visibility: x.visibility,     // "conosciuta" | "chicca"
        lat: Number(x.lat),
        lng: Number(x.lng),
        tags: Array.isArray(x.tags) ? x.tags : [],
        what_to_do: Array.isArray(x.what_to_do) ? x.what_to_do : [],
        source: "curated"
      }))
      .filter((p) => p.id && p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng));
  } catch {
    return [];
  }
}

/* -------------------------
   Distance (for car/walk/bike paths)
------------------------- */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function avgSpeedKmh(mode) {
  if (mode === "walk") return 4.5;
  if (mode === "bike") return 15;
  return 80; // car
}

function estimateCarWalkBike(origin, lat, lng, mode) {
  const d = haversineKm(origin.lat, origin.lng, lat, lng);
  const v = avgSpeedKmh(mode);
  const eta = (d / v) * 60;
  return { distance_km: d, eta_min: eta };
}

/* -------------------------
   Scoring (KNOWN vs GEMS real)
------------------------- */
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function timeFit(etaMin, targetMin) {
  const minOk = Math.max(12, targetMin * 0.35);
  const maxOk = targetMin * 1.10;
  if (etaMin < minOk) return 0;
  if (etaMin > maxOk) return 0;
  const diff = Math.abs(etaMin - targetMin);
  const norm = clamp(1 - (diff / (targetMin * 0.60)), 0, 1);
  return 0.55 + norm * 0.45;
}

function styleFit(visibility, style) {
  // style: known | gems
  if (style === "known") return visibility === "conosciuta" ? 1.0 : 0.55;
  return visibility === "chicca" ? 1.0 : 0.55;
}

function weatherFit(tags, weatherCls) {
  const t = new Set(tags || []);
  if (weatherCls === "rain") {
    if (t.has("pioggia_ok")) return 1.0;
    if (t.has("sole_ok")) return 0.25;
    return 0.55;
  }
  if (weatherCls === "sunny") {
    if (t.has("sole_ok")) return 1.0;
    if (t.has("pioggia_ok")) return 0.70;
    return 0.80;
  }
  return t.has("pioggia_ok") ? 0.85 : 0.75; // cloudy
}

function finalScore(p, targetMin, style, weatherCls, dailySet, visitedSet) {
  if (visitedSet.has(p.id)) return -999;
  if (dailySet.has(p.id)) return -999;

  const a = timeFit(p.eta_min, targetMin);
  const b = styleFit(p.visibility, style);
  const c = weatherFit(p.tags, weatherCls);

  // Pesi: tempo (0.5), stile (0.3), meteo (0.2)
  return (0.50 * a) + (0.30 * b) + (0.20 * c);
}

/* -------------------------
   Nearby types (no mix)
------------------------- */
function nearbyTypes(type) {
  const map = {
    "città": ["borgo", "relax"],
    "borgo": ["città", "natura"],
    "mare": ["natura", "relax"],
    "montagna": ["natura", "borgo"],
    "natura": ["montagna", "borgo"],
    "relax": ["città", "natura"],
    "bambini": ["città", "relax"]
  };
  return map[type] || ["città", "borgo"];
}

/* -------------------------
   Fallback locale: /api/suggest (solo car/walk/bike)
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

  const push = (x) => {
    if (!x?.id || !x?.name) return;
    out.push({
      id: x.id,
      name: x.name,
      lat: Number(x.lat),
      lng: Number(x.lng),
      eta_min: Number(x.eta_min),
      distance_km: Number(x.distance_km),
      tags: [],
      visibility: "chicca",
      type: "borgo",
      what_to_do: [],
      source: "local"
    });
  };

  if (data?.top) push(data.top);
  (data?.alternatives || []).forEach(push);

  const seen = new Set();
  return out.filter(x => x.id && !seen.has(x.id) && seen.add(x.id));
}

/* -------------------------
   PLAN: plane/train/bus (hub + segments + totalMinutes)
------------------------- */
async function fetchPlan(origin, minutes, mode) {
  const body = {
    origin: { lat: origin.lat, lon: origin.lng, label: origin.label || "Partenza" },
    maxMinutes: minutes,
    mode: mode
  };

  const r = await fetch(API.plan, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`PLAN error ${r.status}: ${t}`.slice(0, 180));
  }

  const data = await r.json();
  const results = Array.isArray(data?.results) ? data.results : [];

  // Normalizza in “candidates” compatibili con il resto della app
  return results.map((x) => {
    const dest = x.destination || {};
    const oh = x.originHub || {};
    const dh = x.destinationHub || {};
    return {
      id: dest.id || `${(dest.name||"dest").toLowerCase().replace(/\s+/g,"_")}_${mode}`,
      name: dest.name || "Meta",
      country: dest.country || "",
      lat: Number(dest.lat),
      lng: Number(dest.lon),
      tags: Array.isArray(dest.tags) ? dest.tags : [],

      // qui facciamo “eta = totalMinutes” così il filtro è coerente
      eta_min: Number(x.totalMinutes),
      distance_km: NaN,

      // info hub
      hub_from: oh.name ? `${oh.name}${oh.code ? ` (${oh.code})` : ""}` : "",
      hub_to: dh.name ? `${dh.name}${dh.code ? ` (${dh.code})` : ""}` : "",
      segments: Array.isArray(x.segments) ? x.segments : [],
      plan_summary: x.summary || "",

      // styling / scoring: se non hai visibility nel plan, la stimiamo
      visibility: "conosciuta",
      type: "città",
      what_to_do: [],
      source: "plan"
    };
  }).filter(p => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.eta_min));
}

/* -------------------------
   POI: curated what_to_do; fallback /api/places
------------------------- */
async function renderPOI(place) {
  if (!poiListEl) return;
  poiListEl.innerHTML = "";

  if (Array.isArray(place.what_to_do) && place.what_to_do.length) {
    place.what_to_do.slice(0, 6).forEach((t) => {
      const div = document.createElement("div");
      div.className = "alt-item";
      div.innerHTML = `<div class="name">${escapeHtml(t)}</div>`;
      poiListEl.appendChild(div);
    });
    return;
  }

  try {
    const r = await fetch(`${API.places}?lat=${encodeURIComponent(place.lat)}&lon=${encodeURIComponent(place.lng)}`);
    if (!r.ok) throw new Error("no places");
    const data = await r.json();
    const els = Array.isArray(data?.elements) ? data.elements : [];
    if (!els.length) throw new Error("empty");

    els.slice(0, 6).forEach((p) => {
      const name = p.tags?.name || p.tags?.["name:it"] || "Punto di interesse";
      const div = document.createElement("div");
      div.className = "alt-item";
      div.innerHTML = `<div class="name">${escapeHtml(name)}</div>`;
      poiListEl.appendChild(div);
    });
  } catch {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">Consigli in arrivo…</div><div class="small">Per questa meta aggiungeremo cosa fare/mangiare.</div>`;
    poiListEl.appendChild(div);
  }
}

/* -------------------------
   Render result (top + 2 alts)
------------------------- */
function renderResult(top, alternatives, weatherLabel) {
  showResultBox(true);

  placeNameEl.textContent = top.name;

  const eta = Number.isFinite(top.eta_min) ? `${Math.round(top.eta_min)} min` : "";
  const hub = (top.hub_from && top.hub_to) ? ` · ${top.hub_from} → ${top.hub_to}` : "";
  const w   = weatherLabel ? ` · meteo: ${weatherLabel}` : "";

  // Meta: tempo + hub (se plan) + meteo
  placeMetaEl.textContent = [eta].filter(Boolean).join("") + hub + w;

  // Maps: search by name
  mapsLinkEl.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(top.name)}`;

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
      div.className = "alt-item clickable";
      const hub2 = (a.hub_from && a.hub_to) ? `${a.hub_from} → ${a.hub_to}` : "";
      div.innerHTML = `
        <div class="name">${escapeHtml(a.name)}</div>
        <div class="small">${Math.round(a.eta_min || 0)} min${hub2 ? ` · ${escapeHtml(hub2)}` : ""}</div>
      `;
      div.onclick = () => {
        const newTop = a;
        const newAlts = [top, ...alternatives.filter(x => x.id !== a.id)].slice(0, 2);
        lastPicks = { top: newTop, alternatives: newAlts };
        renderResult(newTop, newAlts, weatherLabel);
        renderPOI(newTop);
        setStatus("Ok, cambio meta 🎲", "ok");
      };
      altListEl.appendChild(div);
    });
  }

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
      renderPOI(lastPicks.top);
      setStatus("Ok, nuova proposta 🎲", "ok");
    };
  }

  renderPOI(top);
}

/* -------------------------
   Dedup
------------------------- */
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
   MAIN
------------------------- */
async function run() {
  showResultBox(false);

  const minutes  = Number($("timeSelect")?.value || 60);
  const mode     = ($("modeSelect")?.value || "car").toLowerCase();
  const style    = ($("styleSelect")?.value || "known").toLowerCase(); // known|gems

  // il tuo index usa typeSelect (se invece hai categorySelect, cambia qui)
  const typeSel = $("typeSelect") ? "typeSelect" : ($("categorySelect") ? "categorySelect" : null);
  const type    = (typeSel ? ($(typeSel)?.value || "città") : "città").toLowerCase();

  const visitedSet = getVisitedSet();
  const dailySet   = getDailyRecoSet();
  const visitedCsv = [...visitedSet].slice(0, 150).join(",");

  setStatus("Calcolo la meta migliore…");

  const origin = await getOrigin();

  setStatus("Controllo il meteo…");
  const weather = await getWeather(origin.lat, origin.lng);

  // Car/Walk/Bike: usa il tuo flusso attuale
  const isPlanMode = (mode === "plane" || mode === "train" || mode === "bus");

  // car/walk/bike
  if (!isPlanMode) {
    setStatus("Cerco tra le mete curate…");
    const curated = await loadCurated();

    let candidates = curated
      .filter(p => (p.type || "").toLowerCase() === type)
      .map(p => ({ ...p, ...estimateCarWalkBike(origin, p.lat, p.lng, mode) }));

    const maxMin = minutes * 1.10;
    const minMin = Math.max(12, minutes * 0.35);
    candidates = candidates.filter(p => p.eta_min <= maxMin && p.eta_min >= minMin);

    candidates.forEach(p => p._score = finalScore(p, minutes, style, weather.cls, dailySet, visitedSet));
    candidates = candidates.filter(p => p._score > -100).sort((a,b)=>b._score - a._score);

    if (candidates.length < 3) {
      const altsTypes = nearbyTypes(type);
      let extra = curated
        .filter(p => altsTypes.includes((p.type || "").toLowerCase()))
        .map(p => ({ ...p, ...estimateCarWalkBike(origin, p.lat, p.lng, mode) }))
        .filter(p => p.eta_min <= maxMin && p.eta_min >= minMin);

      extra.forEach(p => p._score = finalScore(p, minutes, style, weather.cls, dailySet, visitedSet));
      extra = extra.filter(p => p._score > -100).sort((a,b)=>b._score - a._score);

      candidates = dedupById([...candidates, ...extra]).sort((a,b)=>b._score - a._score);
    }

    if (candidates.length < 3) {
      setStatus("Aggiungo mete locali vicino a te…");
      const local = await fetchLocalFallback(origin, minutes, mode, visitedCsv);

      const localEnriched = local
        .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng))
        .map(p => {
          const est = (Number.isFinite(p.eta_min) && Number.isFinite(p.distance_km))
            ? { eta_min: p.eta_min, distance_km: p.distance_km }
            : estimateCarWalkBike(origin, p.lat, p.lng, mode);
          return { ...p, ...est };
        });

      localEnriched.forEach(p => p._score = finalScore(p, minutes, style, weather.cls, dailySet, visitedSet));

      candidates = dedupById([...candidates, ...localEnriched])
        .filter(p => p._score > -100)
        .sort((a,b)=>b._score - a._score);
    }

    if (!candidates.length) {
      setStatus("Non trovo mete con questi filtri. Aumenta il tempo o cambia categoria.", "err");
      return;
    }

    const top = candidates[0];
    const alternatives = candidates.slice(1, 3);

    addDailyReco(top.id);
    lastPicks = { top, alternatives };
    renderResult(top, alternatives, weather.label);
    setStatus("Meta trovata ✔", "ok");
    return;
  }

  // plane/train/bus: usa PLAN
  setStatus(`Cerco tratte ${mode.toUpperCase()} (hub + tempo)…`);
  const planCandidates = await fetchPlan(origin, minutes, mode);

  if (!planCandidates.length) {
    setStatus("Non trovo tratte compatibili col tempo scelto. Prova ad aumentare il tempo.", "err");
    return;
  }

  // qui “type” filtra sui tags del plan (es: city/sea/mountain/kids se li aggiungi nel dataset plan)
  let candidates = planCandidates.slice();

  // se il plan non ha tags coerenti col tuo type, non blocchiamo tutto: filtro soft
  if (type && type !== "any") {
    const filtered = candidates.filter(p => (p.tags || []).map(x=>String(x).toLowerCase()).includes(type));
    if (filtered.length >= 2) candidates = filtered;
  }

  // mergia con curated.json (per visibility/type/what_to_do) quando il nome coincide
  const curated = await loadCurated();
  const byName = new Map(curated.map(p => [String(p.name).toLowerCase(), p]));
  candidates = candidates.map(p => {
    const c = byName.get(String(p.name).toLowerCase());
    if (!c) return p;
    return {
      ...p,
      id: c.id || p.id,
      visibility: c.visibility || p.visibility,
      type: c.type || p.type,
      what_to_do: c.what_to_do || []
    };
  });

  candidates.forEach(p => p._score = finalScore(p, minutes, style, weather.cls, dailySet, visitedSet));
  candidates = candidates.filter(p => p._score > -100).sort((a,b)=>b._score - a._score);

  if (!candidates.length) {
    setStatus("Ho trovato tratte, ma sono tutte già viste/visitata oggi. Prova domani o rimuovi “già visitato”.", "err");
    return;
  }

  const top = candidates[0];
  const alternatives = candidates.slice(1, 3);

  addDailyReco(top.id);
  lastPicks = { top, alternatives };
  renderResult(top, alternatives, weather.label);
  setStatus("Meta trovata ✔", "ok");
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
