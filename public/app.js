/* =========================
   JAMO — app.js (v9 ONE-API + WOW UI + CTA hooks)
   - Tutti i mode passano da /api/jamo (stabile)
   - Rotazione settimanale + visited
   - Se categoria non ha mete vicine: fallback dichiarato (mai "mare->Milano")
   - UI consigli differenziata + spazi per monetizzazione
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
const ctaBoxEl    = $("ctaBox");

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
function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();
}
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }

/* -------------------------
   Weekly rotation + visited
------------------------- */
function isoWeekKey() {
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
    obj[key] = arr.slice(0, 300);
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
   API call
------------------------- */
async function fetchJamo(payload) {
  const r = await fetch(API.jamo, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });
  const text = await r.text().catch(()=> "");
  if (!r.ok) throw new Error(`JAMO ${r.status}: ${text.slice(0,180)}`);
  return JSON.parse(text);
}

/* -------------------------
   Render (WOW + CTA hooks)
------------------------- */
function chip(label) {
  return `<span class="chip">${escapeHtml(label)}</span>`;
}

function renderWhy(place) {
  if (!whyListEl) return;
  whyListEl.innerHTML = "";

  const arr = Array.isArray(place.why) ? place.why : [];
  if (!arr.length) {
    whyListEl.innerHTML = `<div class="cardline"><b>Ok.</b> Ti propongo questa perché è coerente col tempo e col filtro.</div>`;
    return;
  }

  // differenzia visivamente: 1 “hero reason” + 2/3 bullet
  const hero = arr[0];
  const rest = arr.slice(1, 4);

  whyListEl.innerHTML = `
    <div class="heroReason">
      <div class="heroTitle">🎯 Perché è perfetta oggi</div>
      <div class="heroText">${escapeHtml(hero)}</div>
    </div>
  `;

  rest.forEach(t=>{
    const div = document.createElement("div");
    div.className = "cardline";
    div.innerHTML = `✅ ${escapeHtml(t)}`;
    whyListEl.appendChild(div);
  });
}

function renderRoute(place) {
  if (!routeListEl) return;
  routeListEl.innerHTML = "";

  const segs = Array.isArray(place.segments) ? place.segments : [];
  if (!segs.length) {
    routeListEl.innerHTML = `<div class="muteline">Percorso stimato (dettagli in arrivo).</div>`;
    return;
  }

  segs.slice(0, 6).forEach((s) => {
    const div = document.createElement("div");
    div.className = "step";
    div.innerHTML = `
      <div class="stepTop">
        <div class="stepLabel">${escapeHtml(s.label || s.kind || "Step")}</div>
        <div class="stepTime">${Number.isFinite(s.minutes) ? `${s.minutes} min` : ""}</div>
      </div>
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
    const block = document.createElement("div");
    block.className = "grid2";
    block.innerHTML = `
      <div class="blockTitle">✨ Cosa fare</div>
      ${todo.slice(0,6).map(t=>`<div class="tile">📍 ${escapeHtml(t)}</div>`).join("")}
    `;
    poiListEl.appendChild(block);
  }

  if (eat.length) {
    const block2 = document.createElement("div");
    block2.className = "grid2";
    block2.innerHTML = `
      <div class="blockTitle">🍴 Cosa mangiare</div>
      ${eat.slice(0,5).map(t=>`<div class="tile">🍽️ ${escapeHtml(t)}</div>`).join("")}
    `;
    poiListEl.appendChild(block2);
  }

  if (!todo.length && !eat.length) {
    poiListEl.innerHTML = `<div class="muteline">Consigli più ricchi in arrivo (e qui inseriremo link/esperienze monetizzabili).</div>`;
  }
}

function renderCTA(place, mode) {
  if (!ctaBoxEl) return;

  const q = encodeURIComponent(place.name);
  const gmaps = `https://www.google.com/maps/search/?api=1&query=${q}`;

  // CTA placeholder: oggi link “neutri”, domani metti affiliate
  const buyLabel = (mode==="plane"||mode==="train"||mode==="bus")
    ? "🎟️ Compra biglietti"
    : "⭐ Trova cose da fare";

  ctaBoxEl.innerHTML = `
    <a class="ctaPrimary" href="${gmaps}" target="_blank" rel="noopener">🗺️ Apri su Maps</a>
    <a class="ctaGhost" href="#" onclick="alert('Qui inserirai i link monetizzabili (affiliate)'); return false;">${buyLabel}</a>
  `;
}

function renderAlternatives(top, alternatives) {
  if (!altListEl) return;
  altListEl.innerHTML = "";

  if (!alternatives.length) {
    altListEl.innerHTML = `<div class="muteline">Nessuna alternativa trovata (prova “Cambia meta”).</div>`;
    return;
  }

  alternatives.slice(0, 2).forEach((a) => {
    const div = document.createElement("div");
    div.className = "altCard";
    const eta = Number.isFinite(a.eta_min) ? `${Math.round(a.eta_min)} min` : "";
    const km  = Number.isFinite(a.distance_km) ? `${Math.round(a.distance_km)} km` : "";
    div.innerHTML = `
      <div class="altName">${escapeHtml(a.name)}</div>
      <div class="altMeta">${escapeHtml([a.type, eta, km].filter(Boolean).join(" · "))}</div>
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

function renderResult(top, alternatives, mode) {
  showResultBox(true);

  placeNameEl.textContent = top.name;

  const eta = Number.isFinite(top.eta_min) ? `${Math.round(top.eta_min)} min` : "";
  const km  = Number.isFinite(top.distance_km) ? `${Math.round(top.distance_km)} km` : "";
  const w   = lastWeatherLabel ? ` · meteo: ${lastWeatherLabel}` : "";

  placeMetaEl.textContent = [top.type, eta, km].filter(Boolean).join(" · ") + w;

  // link su maps
  mapsLinkEl.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(top.name)}`;

  renderCTA(top, mode);
  renderWhy(top);
  renderAlternatives(top, alternatives);
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
      renderResult(lastPicks.top, lastPicks.alternatives, mode);
      setStatus("Ok, nuova proposta 🎲", "ok");
    };
  }
}

/* -------------------------
   MAIN
------------------------- */
async function run() {
  showResultBox(false);

  const minutes = Number($("timeSelect")?.value || 60);
  const mode    = norm($("modeSelect")?.value || "car");
  const style   = norm($("styleSelect")?.value || "known");
  const category = $("categorySelect")?.value || "citta_borghi";

  const visitedSet = getVisitedSet();
  const weekSet = getWeekPickSet();

  setStatus("Calcolo la meta migliore…");
  const origin = await getOrigin();

  const weather = await getWeather(origin.lat, origin.lon);
  lastWeatherLabel = weather.label || "";

  // chiedi all'API la meta migliore (sempre)
  const payload = {
    origin: { lat: origin.lat, lon: origin.lon, label: origin.label },
    minutes,
    mode,
    style,
    category,
    visitedIds: [...visitedSet],
    weekIds: [...weekSet]
  };

  const resp = await fetchJamo(payload);

  if (!resp?.ok || !resp?.top) {
    setStatus("Nessuna meta trovata: prova ad aumentare i minuti o cambia categoria.", "err");
    return;
  }

  addWeekPick(resp.top.id);
  lastPicks = { top: resp.top, alternatives: resp.alternatives || [] };
  renderResult(resp.top, resp.alternatives || [], norm(mode));
  setStatus("Meta trovata ✔", "ok");
}

/* -------------------------
   Events
------------------------- */
goBtn.onclick = async () => {
  goBtn.disabled = true;
  try { await run(); }
  catch (e) { setStatus("Errore: " + (e?.message || String(e)), "err"); }
  finally { goBtn.disabled = false; }
};

gpsBtn.onclick = () => {
  if ($("startInput")) $("startInput").value = "";
  setStatus("Ok: userò il GPS quando premi “DOVE ANDIAMO?”");
};
