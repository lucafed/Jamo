/* =========================
   JAMO — app.js (v6 FIX)
   - FIX: città vs citta (accenti), categoria combo
   - Auto/Walk/Bike: curated + fallback "nearest" se filtri troppo stretti
   - Plane/Train/Bus: /api/plan robust + error handling (HTML/JSON)
   - Alternative: cerca di mostrarne sempre 2
   ========================= */

const API = {
  geocode: "/api/geocode",
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

const LS_VISITED_KEY = "jamo_visited_v1";
const LS_DAILY_KEY   = "jamo_daily_reco_v1";

let lastPicks = { top: null, alternatives: [] };
let lastWeatherLabel = "";

/* -------------------------
   Utils
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

// ✅ normalizza: lower + rimuove accenti + trim
function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // toglie accenti
    .trim();
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function getVisitedSet() {
  try {
    const raw = localStorage.getItem(LS_VISITED_KEY);
    const arr = raw ? JSON.parse(raw) : [];
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
    obj[key] = arr.slice(0, 120);
    localStorage.setItem(LS_DAILY_KEY, JSON.stringify(obj));
  } catch {}
}

/* -------------------------
   Reset via URL ?reset=1
------------------------- */
(function handleReset() {
  try {
    const u = new URL(location.href);
    if (u.searchParams.get("reset") === "1") {
      localStorage.removeItem(LS_VISITED_KEY);
      localStorage.removeItem(LS_DAILY_KEY);
      u.searchParams.delete("reset");
      history.replaceState({}, "", u.pathname + (u.search ? u.search : ""));
    }
  } catch {}
})();

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
    return { lat, lon: lng, label: data.label || input };
  }

  setStatus("Uso il GPS…");
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("GPS non supportato"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, label: "La tua posizione" }),
      () => reject(new Error("GPS non disponibile"))
    );
  });
}

/* -------------------------
   Meteo (non blocca)
------------------------- */
async function getWeather(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}` +
    `&longitude=${encodeURIComponent(lon)}` +
    `&daily=weathercode,precipitation_probability_max&forecast_days=1&timezone=auto`;
  try {
    const r = await fetch(url);
    if (!r.ok) return { label: "" };
    const d = await r.json();
    const code = d?.daily?.weathercode?.[0];
    const pop = d?.daily?.precipitation_probability_max?.[0];
    if (Number.isFinite(pop) && pop >= 55) return { label: "pioggia" };
    if (Number.isFinite(code) && code >= 51) return { label: "pioggia" };
    if (Number.isFinite(code) && code <= 2) return { label: "sole" };
    return { label: "nuvoloso" };
  } catch {
    return { label: "" };
  }
}

/* -------------------------
   Curated load
------------------------- */
async function loadCurated() {
  const r = await fetch(CURATED_URL, { cache: "no-store" });
  if (!r.ok) return [];
  const d = await r.json();
  const items = Array.isArray(d?.places) ? d.places : [];
  return items
    .map(x => ({
      id: x.id,
      name: x.name,
      country: x.country,
      type: norm(x.type),              // ✅ normalizzato
      visibility: norm(x.visibility),  // ✅ normalizzato
      lat: Number(x.lat),
      lng: Number(x.lng),
      tags: Array.isArray(x.tags) ? x.tags : [],
      what_to_do: Array.isArray(x.what_to_do) ? x.what_to_do : []
    }))
    .filter(p => p.id && p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

/* -------------------------
   Distance & time estimate (auto-like)
------------------------- */
function toRad(x){ return x * Math.PI / 180; }
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat/2)**2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function avgSpeedKmh(mode) {
  if (mode === "walk") return 4.5;
  if (mode === "bike") return 15;
  return 80; // car
}

function estimateAutoLike(origin, lat, lng, mode) {
  const d = haversineKm(origin.lat, origin.lon, lat, lng);
  const eta = (d / avgSpeedKmh(mode)) * 60;
  return { distance_km: d, eta_min: eta };
}

/* -------------------------
   Category matching (FIX)
------------------------- */
function allowedTypesFromCategory(categoryRaw) {
  const c = norm(categoryRaw);
  if (c === "citta_borghi") return ["citta", "borgo"]; // ✅ combo
  if (c === "citta" || c === "citta ") return ["citta"];
  return [c]; // mare, montagna, natura, relax, bambini, borgo, ...
}

function typeMatches(placeType, allowedTypes) {
  const t = norm(placeType);
  return allowedTypes.includes(t);
}

/* -------------------------
   Style scoring
------------------------- */
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }
function timeFit(etaMin, targetMin) {
  // finestra “buona”
  const minOk = Math.max(10, targetMin * 0.30);
  const maxOk = targetMin * 1.15;
  if (etaMin < minOk || etaMin > maxOk) return 0;
  const diff = Math.abs(etaMin - targetMin);
  const normV = clamp(1 - (diff / (targetMin * 0.70)), 0, 1);
  return 0.55 + normV * 0.45;
}

function styleFit(visibility, style) {
  const v = norm(visibility);
  if (style === "known") return v === "conosciuta" ? 1.0 : 0.70;
  return v === "chicca" ? 1.0 : 0.70;
}

function finalScore(p, targetMin, style, dailySet, visitedSet) {
  if (visitedSet.has(p.id)) return -999;
  if (dailySet.has(p.id)) return -999;
  const a = timeFit(p.eta_min, targetMin);
  const b = styleFit(p.visibility, style);
  // un filo di bias verso “più vicino” quando a parità
  const nearBonus = clamp(1 - (p.eta_min / (targetMin * 1.3)), 0, 1) * 0.10;
  return (0.58 * a) + (0.42 * b) + nearBonus;
}

/* -------------------------
   /api/plan call (robusto)
------------------------- */
async function fetchPlan({ origin, maxMinutes, mode }) {
  const r = await fetch(API.plan, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ origin, maxMinutes, mode, limit: 10 })
  });

  const text = await r.text().catch(() => "");
  if (!r.ok) {
    // può essere HTML di Vercel
    throw new Error(`PLAN error ${r.status}: ${text.slice(0, 160)}`);
  }

  // prova a parse JSON, altrimenti errore leggibile
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`PLAN risposta non JSON: ${text.slice(0, 120)}`);
  }
}

/* -------------------------
   POI render
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
  const div = document.createElement("div");
  div.className = "alt-item";
  div.innerHTML = `<div class="name">Consigli in arrivo…</div><div class="small">Aggiungeremo cosa fare/mangiare.</div>`;
  poiListEl.appendChild(div);
}

/* -------------------------
   Render result
------------------------- */
function renderResult(top, alternatives) {
  showResultBox(true);

  placeNameEl.textContent = top.name;

  const eta = Number.isFinite(top.eta_min) ? `${Math.round(top.eta_min)} min` : "";
  const km  = Number.isFinite(top.distance_km) ? `${top.distance_km.toFixed(0)} km` : "";
  const w   = lastWeatherLabel ? ` · meteo: ${lastWeatherLabel}` : "";
  const extra = top.hubSummary ? ` · ${top.hubSummary}` : "";

  placeMetaEl.textContent = [eta, km].filter(Boolean).join(" · ") + w + extra;
  mapsLinkEl.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(top.name)}`;

  altListEl.innerHTML = "";
  if (!alternatives.length) {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">Nessuna alternativa (per ora)</div>`;
    altListEl.appendChild(div);
  } else {
    alternatives.slice(0, 2).forEach((a) => {
      const div = document.createElement("div");
      div.className = "alt-item clickable";
      div.innerHTML = `
        <div class="name">${escapeHtml(a.name)}</div>
        <div class="small">${Math.round(a.eta_min || 0)} min${a.hubSummary ? ` · ${escapeHtml(a.hubSummary)}` : ""}</div>
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

  visitedBtn.onclick = () => {
    if (top.id) markVisited(top.id);
    setStatus("Segnato come già visitato ✅", "ok");
  };

  rerollBtn.onclick = () => {
    if (!lastPicks?.alternatives?.length) return;
    const next = lastPicks.alternatives[0];
    const rest = lastPicks.alternatives.slice(1);
    lastPicks = { top: next, alternatives: [top, ...rest].slice(0, 2) };
    renderResult(lastPicks.top, lastPicks.alternatives);
    renderPOI(lastPicks.top);
    setStatus("Ok, nuova proposta 🎲", "ok");
  };

  renderPOI(top);
}

/* -------------------------
   MAIN
------------------------- */
async function run() {
  showResultBox(false);

  const minutes   = Number($("timeSelect")?.value || 60);
  const mode      = norm($("modeSelect")?.value || "car");
  const style     = norm($("styleSelect")?.value || "known");
  const categoryRaw  = $("categorySelect")?.value || "citta_borghi";
  const allowedTypes = allowedTypesFromCategory(categoryRaw);

  const visitedSet = getVisitedSet();
  const dailySet   = getDailyRecoSet();

  setStatus("Calcolo la meta migliore…");
  const origin = await getOrigin();

  const weather = await getWeather(origin.lat, origin.lon);
  lastWeatherLabel = weather.label || "";

  // ✅ MEZZI PUBBLICI: plane/train/bus
  if (mode === "plane" || mode === "train" || mode === "bus") {
    setStatus(`Cerco mete con ${mode.toUpperCase()}…`);

    const plan = await fetchPlan({
      origin: { lat: origin.lat, lon: origin.lon, label: origin.label },
      maxMinutes: minutes,
      mode
    });

    const results = Array.isArray(plan?.results) ? plan.results : [];
    if (!results.length) {
      setStatus("Non trovo mete con questi filtri. Aumenta il tempo.", "err");
      return;
    }

    // per ora NON filtriamo per categoria (non abbiamo tipo mare/citta sui destinations),
    // meglio dare sempre qualcosa.
    const candidates = results.map((r) => {
      const dest = r.destination;
      const id = dest.id || `${dest.name}_${dest.country}`.toLowerCase().replace(/[^a-z0-9]+/g,"_");
      return {
        id,
        name: `${dest.name}${dest.country ? `, ${dest.country}` : ""}`,
        lat: dest.lat,
        lng: dest.lon,
        eta_min: r.totalMinutes,
        distance_km: null,
        hubSummary: `${r.originHub?.code || r.originHub?.name} → ${r.destinationHub?.code || r.destinationHub?.name}`,
        what_to_do: [],
        source: "plan"
      };
    });

    // filtra visited/daily e mantieni alternative
    const filtered = candidates.filter(c => !visitedSet.has(c.id) && !dailySet.has(c.id));
    const list = filtered.length ? filtered : candidates; // se hai bloccato tutto, almeno mostra

    const top = list[0];
    const alternatives = list.slice(1, 3);

    addDailyReco(top.id);
    lastPicks = { top, alternatives };
    renderResult(top, alternatives);
    setStatus("Meta trovata ✔", "ok");
    return;
  }

  // ✅ AUTO/WALK/BIKE
  setStatus("Cerco tra le mete…");
  const curated = await loadCurated();

  // (1) categoria (con fix accenti)
  let candidates = curated
    .filter(p => typeMatches(p.type, allowedTypes))
    .map(p => ({ ...p, ...estimateAutoLike(origin, p.lat, p.lng, mode) }));

  // (2) prima prova: finestra “buona”
  const maxMin = minutes * 1.15;
  const minMin = Math.max(10, minutes * 0.30);
  let windowed = candidates.filter(p => p.eta_min <= maxMin && p.eta_min >= minMin);

  // (3) se vuoto → RELAX: prendi le più vicine entro un max “grande”
  if (!windowed.length) {
    const relaxedMax = Math.max(minutes * 2.0, minutes + 60); // così “vicino” trova quasi sempre qualcosa
    windowed = candidates
      .filter(p => p.eta_min <= relaxedMax)
      .sort((a,b) => a.eta_min - b.eta_min)
      .slice(0, 40);
  }

  // (4) score (filtra daily/visited)
  windowed.forEach(p => p._score = finalScore(p, minutes, style, dailySet, visitedSet));
  let scored = windowed.filter(p => p._score > -100).sort((a,b)=>b._score - a._score);

  // (5) se ancora vuoto → ignora daily (ma rispetta visited)
  if (!scored.length) {
    scored = windowed
      .filter(p => !visitedSet.has(p.id))
      .sort((a,b)=>a.eta_min - b.eta_min);
  }

  if (!scored.length) {
    const typesAvail = [...new Set(curated.map(p => p.type))].sort().join(", ");
    setStatus(
      "Non trovo mete con questi filtri.\n" +
      `• Categoria: ${allowedTypes.join("+")}\n` +
      `• Tipi disponibili nel JSON: ${typesAvail}\n` +
      "Prova ad aumentare il tempo o cambia categoria.\n" +
      "Tip: apri /?reset=1 se hai segnato troppe mete come visitate.",
      "err"
    );
    return;
  }

  const top = scored[0];
  const alternatives = scored.slice(1, 3);

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
