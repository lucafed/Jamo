/* =========================
   JAMO — app.js (v9 ONE-API + WEEKLY + ALWAYS-NEARBY)
   - Usa SOLO /api/jamo (Hobby friendly)
   - Auto/Walk/Bike: curated + fallback OSM => trova anche a 30/45 min ovunque
   - Plane/Train/Bus: route con HUB + segments (dal backend)
   - Visited + rotazione settimanale: excludeIds inviati all'API
   ========================= */

const API = {
  geocode: "/api/geocode",
  jamo: "/api/jamo"
};

const $ = (id) => document.getElementById(id);

// UI refs
const statusEl    = $("status");
const resultEl    = $("result");
const placeNameEl = $("placeName");
const placeMetaEl = $("placeMeta");
const mapsLinkEl  = $("mapsLink");
const altListEl   = $("altList");
const whyListEl   = $("whyList");
const routeListEl = $("routeList");
const poiListEl   = $("poiList");

const goBtn       = $("goBtn");
const gpsBtn      = $("gpsBtn");
const rerollBtn   = $("rerollBtn");
const visitedBtn  = $("visitedBtn");

const LS_VISITED_KEY = "jamo_visited_v1";
const LS_WEEK_KEY    = "jamo_week_picks_v1";

let lastPicks = { top: null, alternatives: [] };
let lastWeatherLabel = "";

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
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

/* -------------------------
   Normalize
------------------------- */
function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/* -------------------------
   Mode mapping (IT/EN -> canonical)
------------------------- */
function canonicalMode(raw) {
  const m = norm(raw);
  if (["car","auto","macchina"].includes(m)) return "car";
  if (["walk","piedi","a piedi"].includes(m)) return "walk";
  if (["bike","bici","bicicletta"].includes(m)) return "bike";
  if (["plane","aereo","volo"].includes(m)) return "plane";
  if (["train","treno"].includes(m)) return "train";
  if (["bus","pullman"].includes(m)) return "bus";
  return "car";
}

/* -------------------------
   Weekly rotation + visited
------------------------- */
function isoWeekKey() {
  // YYYY-Www
  const d = new Date();
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1)/7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2,"0")}`;
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

function getWeekPickSet() {
  try {
    const raw = localStorage.getItem(LS_WEEK_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const key = isoWeekKey();
    const arr = Array.isArray(obj?.[key]) ? obj[key] : [];
    return new Set(arr);
  } catch { return new Set(); }
}
function addWeekPick(id) {
  try {
    const raw = localStorage.getItem(LS_WEEK_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const key = isoWeekKey();
    const arr = Array.isArray(obj?.[key]) ? obj[key] : [];
    if (!arr.includes(id)) arr.push(id);
    obj[key] = arr.slice(0, 400);
    localStorage.setItem(LS_WEEK_KEY, JSON.stringify(obj));
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
      localStorage.removeItem(LS_WEEK_KEY);
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
   /api/jamo call
------------------------- */
async function fetchJamo(payload) {
  const r = await fetch(API.jamo, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const text = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`JAMO error ${r.status}: ${text.slice(0, 200)}`);

  try { return JSON.parse(text); }
  catch { throw new Error(`JAMO risposta non JSON: ${text.slice(0, 140)}`); }
}

/* -------------------------
   Render helpers
------------------------- */
function renderWhy(place) {
  if (!whyListEl) return;
  whyListEl.innerHTML = "";

  const arr = Array.isArray(place.why) ? place.why : [];
  const list = arr.length ? arr : [];

  if (!list.length) {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">—</div><div class="small">Motivazioni non disponibili.</div>`;
    whyListEl.appendChild(div);
    return;
  }

  list.slice(0, 4).forEach((t) => {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">${escapeHtml(t)}</div>`;
    whyListEl.appendChild(div);
  });
}

function renderRoute(place) {
  if (!routeListEl) return;
  routeListEl.innerHTML = "";

  const segments = Array.isArray(place.segments) ? place.segments : [];
  if (!segments.length) {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">—</div><div class="small">Nessun dettaglio percorso disponibile.</div>`;
    routeListEl.appendChild(div);
    return;
  }

  segments.slice(0, 6).forEach((s) => {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `
      <div class="name">${escapeHtml(s.label || s.kind || "Step")}</div>
      <div class="small">${Number.isFinite(s.minutes) ? `${s.minutes} min` : ""}</div>
    `;
    routeListEl.appendChild(div);
  });
}

function renderPOI(place) {
  if (!poiListEl) return;
  poiListEl.innerHTML = "";

  const todo = Array.isArray(place.what_to_do) ? place.what_to_do : [];
  const eat  = Array.isArray(place.what_to_eat) ? place.what_to_eat : [];

  if (todo.length) {
    todo.slice(0, 6).forEach((t) => {
      const div = document.createElement("div");
      div.className = "alt-item";
      div.innerHTML = `<div class="name">${escapeHtml(t)}</div>`;
      poiListEl.appendChild(div);
    });
  }

  if (eat.length) {
    eat.slice(0, 5).forEach((t) => {
      const div = document.createElement("div");
      div.className = "alt-item";
      div.innerHTML = `<div class="name">🍽️ ${escapeHtml(t)}</div>`;
      poiListEl.appendChild(div);
    });
  }

  if (!todo.length && !eat.length) {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">Consigli in arrivo…</div><div class="small">Aggiungeremo cosa fare/mangiare anche alle mete “ovunque”.</div>`;
    poiListEl.appendChild(div);
  }
}

function renderAlternatives(top, alternatives) {
  if (!altListEl) return;
  altListEl.innerHTML = "";

  if (!alternatives.length) {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">Nessuna alternativa</div><div class="small">Prova “Cambia meta” o aumenta il tempo.</div>`;
    altListEl.appendChild(div);
    return;
  }

  alternatives.slice(0, 2).forEach((a) => {
    const div = document.createElement("div");
    div.className = "alt-item clickable";

    const eta = Number.isFinite(a.eta_min) ? `${Math.round(a.eta_min)} min` : "";
    const km  = Number.isFinite(a.distance_km) ? `${Math.round(a.distance_km)} km` : "";
    const typeLabel = a.type ? `${a.type}` : "";
    const hub = a.summary ? ` · ${escapeHtml(a.summary)}` : "";

    div.innerHTML = `
      <div class="name">${escapeHtml(a.name)}</div>
      <div class="small">${[typeLabel, eta, km].filter(Boolean).join(" · ")}${hub}</div>
    `;

    div.onclick = () => {
      const newTop = a;
      const newAlts = [top, ...alternatives.filter(x => x.id !== a.id)].slice(0, 2);
      lastPicks = { top: newTop, alternatives: newAlts };
      renderResult(newTop, newAlts);
      setStatus("Ok, cambio meta 🎲", "ok");
    };

    altListEl.appendChild(div);
  });
}

function renderResult(top, alternatives) {
  showResultBox(true);

  placeNameEl.textContent = top.name || "Meta";
  const eta = Number.isFinite(top.eta_min) ? `${Math.round(top.eta_min)} min` : "";
  const km  = Number.isFinite(top.distance_km) ? `${Math.round(top.distance_km)} km` : "";
  const w   = lastWeatherLabel ? ` · meteo: ${lastWeatherLabel}` : "";

  const typeLabel = top.type ? `${top.type}` : "";
  const extra = top.summary ? ` · ${top.summary}` : ""; // hub summary (plane/train/bus)

  placeMetaEl.textContent = [typeLabel, eta, km].filter(Boolean).join(" · ") + w + extra;

  // maps: se ho coordinate uso quelle, altrimenti name
  if (Number.isFinite(top.lat) && Number.isFinite(top.lng)) {
    mapsLinkEl.href = `https://www.google.com/maps/search/?api=1&query=${top.lat},${top.lng}`;
  } else {
    mapsLinkEl.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(top.name || "")}`;
  }

  renderAlternatives(top, alternatives);
  renderWhy(top);
  renderRoute(top);
  renderPOI(top);

  if (visitedBtn) {
    visitedBtn.onclick = () => {
      if (top.id) markVisited(top.id);
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
      setStatus("Ok, nuova proposta 🎲", "ok");
    };
  }
}

/* -------------------------
   MAIN
------------------------- */
async function run() {
  showResultBox(false);

  const minutes   = Number($("timeSelect")?.value || 60);
  const mode      = canonicalMode($("modeSelect")?.value || "car");
  const style     = norm($("styleSelect")?.value || "known"); // known | gems
  const category  = $("categorySelect")?.value || "citta_borghi";

  const visitedSet = getVisitedSet();
  const weekSet    = getWeekPickSet();

  setStatus("Calcolo la meta migliore…");
  const origin = await getOrigin();

  const weather = await getWeather(origin.lat, origin.lon);
  lastWeatherLabel = weather.label || "";

  // excludeIds = visited + picked this week (rotazione)
  const excludeIds = [...new Set([...visitedSet, ...weekSet])];

  setStatus("Sto scegliendo la meta migliore…");

  const data = await fetchJamo({
    origin: { lat: origin.lat, lon: origin.lon, label: origin.label },
    minutes,
    mode,
    style,
    category,
    excludeIds
  });

  if (!data?.ok || !data?.top) {
    setStatus(data?.message || "Non trovo mete con questi filtri. Aumenta il tempo.", "err");
    return;
  }

  const top = data.top;
  const alternatives = Array.isArray(data.alternatives) ? data.alternatives : [];

  // salva rotazione settimanale
  if (top.id) addWeekPick(top.id);

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
