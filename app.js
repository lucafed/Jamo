/* =========================
   JAMO — app.js (v3 STABILE + PLAN per train/bus/plane)
   - Car/Walk/Bike: curated.json + stima
   - Train/Bus/Plane: /api/plan (hub + segments + totalMinutes)
   - Filtri: timeSelect, modeSelect, styleSelect, categorySelect (NO mix)
   - Meteo: Open-Meteo (gratis)
   - Visited + daily anti-ripetizione
   - POI: curated what_to_do, fallback /api/places (opzionale)
   ========================= */

const API = {
  geocode: "/api/geocode",
  suggest: "/api/suggest",
  places: "/api/places",
  plan: "/api/plan"
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

let lastPicks = { top: null, alternatives: [] };
let lastWeatherLabel = "";

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

    // NORMALIZZO: restituisco sia lng che lon per compatibilità backend
    return { lat, lng, lon: lng, label: data.label || input };
  }

  setStatus("Uso il GPS…");
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("GPS non supportato"));
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const lat = p.coords.latitude;
        const lng = p.coords.longitude;
        resolve({ lat, lng, lon: lng, label: "La tua posizione" });
      },
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
   Curated load
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
        type: x.type,               // es: "città" "mare" "montagna" "bambini"
        visibility: x.visibility,   // "conosciuta" | "chicca"
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
   Distance & estimate for car/walk/bike only
------------------------- */
function toRad(x) { return (x * Math.PI) / 180; }

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
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

function estimate(origin, lat, lng, mode) {
  const d = haversineKm(origin.lat, origin.lon, lat, lng);
  const v = avgSpeedKmh(mode);
  const eta = (d / v) * 60;
  return { distance_km: d, eta_min: eta };
}

/* -------------------------
   Scoring (KNOWN vs GEMS)
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
  if (style === "known") return visibility === "conosciuta" ? 1.0 : 0.55;
  return visibility === "chicca" ? 1.0 : 0.55;
}

function finalScore(p, targetMin, style, dailySet, visitedSet) {
  if (visitedSet.has(p.id)) return -999;
  if (dailySet.has(p.id)) return -999;

  const a = timeFit(p.eta_min, targetMin);
  const b = styleFit(p.visibility, style);

  // Pesi: tempo 0.65, stile 0.35 (qui niente meteo per non complicare)
  return (0.65 * a) + (0.35 * b);
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
   POI rendering
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

  // fallback opzionale
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
    div.innerHTML = `<div class="name">Consigli in arrivo…</div><div class="small">Aggiungeremo cosa fare/mangiare.</div>`;
    poiListEl.appendChild(div);
  }
}

/* -------------------------
   Render
------------------------- */
function renderResult(top, alternatives) {
  showResultBox(true);

  placeNameEl.textContent = top.name;

  const eta = Number.isFinite(top.eta_min) ? `${Math.round(top.eta_min)} min` : "";
  const km  = Number.isFinite(top.distance_km) ? `${top.distance_km.toFixed(0)} km` : "";
  const w   = lastWeatherLabel ? ` · meteo: ${lastWeatherLabel}` : "";

  placeMetaEl.textContent = [eta, km].filter(Boolean).join(" · ") + w;
  mapsLinkEl.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(top.name)}`;

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
      div.innerHTML = `
        <div class="name">${escapeHtml(a.name)}</div>
        <div class="small">${Math.round(a.eta_min || 0)} min · ${(a.distance_km || 0).toFixed(0)} km</div>
      `;
      div.onclick = () => {
        const newTop = a;
        const newAlts = [top, ...alternatives.filter(x => x.id !== a.id)].slice(0, 2);
        lastPicks = { top: newTop, alternatives: newAlts };
        renderResult(newTop, newAlts);
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
      renderResult(lastPicks.top, lastPicks.alternatives);
      renderPOI(lastPicks.top);
      setStatus("Ok, nuova proposta 🎲", "ok");
    };
  }

  renderPOI(top);
}

/* -------------------------
   PLAN call for plane/train/bus
------------------------- */
async function fetchPlan(origin, maxMinutes, mode) {
  const body = {
    origin: { lat: origin.lat, lon: origin.lon, label: origin.label },
    maxMinutes: Number(maxMinutes),
    mode,
    limit: 8
  };

  const r = await fetch(API.plan, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(data?.error || "Errore plan");
  }
  return data;
}

/* -------------------------
   MAIN
------------------------- */
async function run() {
  showResultBox(false);

  const minutes  = Number($("timeSelect")?.value || 60);
  const mode     = ($("modeSelect")?.value || "car").toLowerCase();
  const style    = ($("styleSelect")?.value || "known").toLowerCase(); // known|gems
  const category = ($("categorySelect")?.value || "città").toLowerCase();

  const visitedSet = getVisitedSet();
  const dailySet   = getDailyRecoSet();

  setStatus("Calcolo la meta migliore…");

  const origin = await getOrigin();

  // Meteo (solo label)
  const w = await getWeather(origin.lat, origin.lon);
  lastWeatherLabel = w?.label || "";

  // ✅ Se plane/train/bus: usa PLAN
  if (mode === "plane" || mode === "train" || mode === "bus") {
    setStatus(`Cerco tratte ${mode.toUpperCase()}…`);

    const plan = await fetchPlan(origin, minutes, mode);
    const results = Array.isArray(plan?.results) ? plan.results : [];

    if (!results.length) {
      setStatus("Non trovo tratte con questo tempo. Prova ad aumentare il tempo.", "err");
      return;
    }

    // Trasformo i results in “places” compatibili UI
    const places = results.map((r) => {
      const dest = r.destination || {};
      const id = dest.id || `${dest.name}_${dest.lat}_${dest.lon}`;
      return {
        id,
        name: dest.name,
        country: dest.country,
        type: category,
        visibility: "conosciuta",     // per ora (poi la curiamo meglio)
        lat: Number(dest.lat),
        lng: Number(dest.lon),
        eta_min: Number(r.totalMinutes),
        distance_km: Number(haversineKm(origin.lat, origin.lon, Number(dest.lat), Number(dest.lon))),
        what_to_do: [],
        tags: [],
        source: "plan",
        // extra utile per futuro (stazione/aeroporto)
        _route: {
          originHub: r.originHub,
          destinationHub: r.destinationHub,
          segments: r.segments,
          summary: r.summary,
          confidence: r.confidence
        }
      };
    });

    // filtro visited/daily
    const filtered = places.filter(p => !visitedSet.has(p.id) && !dailySet.has(p.id));

    const list = filtered.length ? filtered : places;
    const top = list[0];
    const alternatives = list.slice(1, 3);

    addDailyReco(top.id);
    lastPicks = { top, alternatives };

    // Mostro anche in meta una riga con hub (super utile)
    const hubLine = top._route?.summary ? ` · ${top._route.summary}` : "";
    placeNameEl.textContent = top.name;
    placeMetaEl.textContent = `${Math.round(top.eta_min)} min${hubLine}`;
    mapsLinkEl.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(top.name)}`;

    // alternative + POI
    altListEl.innerHTML = "";
    alternatives.forEach((a) => {
      const div = document.createElement("div");
      div.className = "alt-item clickable";
      div.innerHTML = `
        <div class="name">${escapeHtml(a.name)}</div>
        <div class="small">${Math.round(a.eta_min || 0)} min</div>
      `;
      div.onclick = () => {
        lastPicks = { top: a, alternatives: [top, ...alternatives.filter(x => x.id !== a.id)].slice(0, 2) };
        placeNameEl.textContent = a.name;
        placeMetaEl.textContent = `${Math.round(a.eta_min)} min · ${a._route?.summary || ""}`.trim();
        mapsLinkEl.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a.name)}`;
        renderPOI(a);
        setStatus("Ok, cambio meta 🎲", "ok");
      };
      altListEl.appendChild(div);
    });

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
        placeNameEl.textContent = next.name;
        placeMetaEl.textContent = `${Math.round(next.eta_min)} min · ${next._route?.summary || ""}`.trim();
        mapsLinkEl.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(next.name)}`;
        renderPOI(next);
        setStatus("Ok, nuova proposta 🎲", "ok");
      };
    }

    showResultBox(true);
    renderPOI(top);
    setStatus("Meta trovata ✔", "ok");
    return;
  }

  // ✅ Altrimenti: car/walk/bike con curated.json
  setStatus("Cerco tra le mete curate…");
  const curated = await loadCurated();

  let candidates = curated
    .filter(p => (p.type || "").toLowerCase() === category)
    .map(p => ({ ...p, ...estimate(origin, p.lat, p.lng, mode) }));

  const maxMin = minutes * 1.10;
  const minMin = Math.max(12, minutes * 0.35);
  candidates = candidates.filter(p => p.eta_min <= maxMin && p.eta_min >= minMin);

  candidates.forEach(p => p._score = finalScore(p, minutes, style, dailySet, visitedSet));
  candidates = candidates.filter(p => p._score > -100).sort((a,b)=>b._score - a._score);

  if (!candidates.length) {
    setStatus("Non trovo mete con questi filtri. Aumenta il tempo o cambia categoria.", "err");
    return;
  }

  const top = candidates[0];
  const alternatives = candidates.slice(1, 3);

  addDailyReco(top.id);

  lastPicks = { top, alternatives };
  renderResult(top, alternatives);

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
