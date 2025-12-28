/* =========================
   JAMO — app.js (v2.2 NO-MIX + CATEGORIE)
   Usa /api/suggest + /api/geocode + /api/places (opzionale)
   ========================= */

const API = {
  geocode: "/api/geocode",
  suggest: "/api/suggest",
  places: "/api/places" // opzionale (POI). Se non esiste, non rompe.
};

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const resultEl = $("result");
const placeNameEl = $("placeName");
const placeMetaEl = $("placeMeta");
const mapsLinkEl = $("mapsLink");
const altListEl = $("altList");

const poiListEl = $("poiList");      // opzionale
const visitedBtn = $("visitedBtn");  // opzionale
const rerollBtn = $("rerollBtn");    // opzionale

const goBtn = $("goBtn");
const gpsBtn = $("gpsBtn");

const LS_VISITED_KEY = "jamo_visited_v1";

let lastResponse = null;     // { top, alternatives, ... }
let currentOrigin = null;    // { lat, lng }
let lastMode = "car";
let lastMinutes = 60;

/* =========================
   UI helpers
   ========================= */

function setStatus(msg, type = "") {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.className = "status" + (type ? " " + type : "");
}

function showResultBox(show) {
  if (!resultEl) return;
  resultEl.classList.toggle("hidden", !show);
}

function safeNumber(n, fallback = null) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

/* =========================
   Visited (localStorage)
   ========================= */

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

function saveVisitedSet(set) {
  try {
    localStorage.setItem(LS_VISITED_KEY, JSON.stringify([...set]));
  } catch {}
}

function markVisited(id) {
  const set = getVisitedSet();
  set.add(id);
  saveVisitedSet(set);
}

/* =========================
   Origin: input OR GPS
   ========================= */

async function getOrigin() {
  const input = $("startInput")?.value?.trim() || "";

  // 1) Partenza manuale -> geocode
  if (input) {
    setStatus("Cerco la partenza…");
    const r = await fetch(`${API.geocode}?q=${encodeURIComponent(input)}`);
    if (!r.ok) throw new Error("Geocoding fallito");
    const data = await r.json();

    // Normalizzo {lat,lon} o {lat,lng}
    const lat = safeNumber(data.lat);
    const lng = safeNumber(data.lng ?? data.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error("Geocode: coordinate non valide");
    }
    return { lat, lng, label: data.label || input };
  }

  // 2) GPS
  setStatus("Uso il GPS…");
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("GPS non supportato"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, label: "La tua posizione" }),
      () => reject(new Error("GPS non disponibile"))
    );
  });
}

/* =========================
   Normalizzazione filtri
   ========================= */

// NO MIX: se per errore l’UI manda "mix", lo forziamo su "places"
function normalizeType(rawType) {
  const t = String(rawType || "places").toLowerCase();
  if (t === "mix") return "places";
  if (t === "places" || t === "nature") return t;
  return "places";
}

// Se il backend non supporta ancora bene train/bus/plane,
// facciamo fallback su "car" (ma lasciamo la selezione UI)
function normalizeMode(rawMode) {
  const m = String(rawMode || "car").toLowerCase();
  if (["car","walk","bike","train","bus","plane"].includes(m)) return m;
  return "car";
}

// Categoria extra (mare/montagna/città/bambini ecc.) se presente nel DOM
function getCategory() {
  // se hai un select tipo <select id="categorySelect">...</select>
  const el = $("categorySelect");
  if (!el) return ""; // non rompe se non esiste
  const v = String(el.value || "").toLowerCase().trim();
  return v; // es: sea, mountain, city, villages, kids...
}

/* =========================
   Suggest (server)
   ========================= */

async function fetchSuggest({ lat, lng, minutes, mode, type, category, visitedCsv }) {
  const url =
    `${API.suggest}?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}` +
    `&minutes=${encodeURIComponent(minutes)}&mode=${encodeURIComponent(mode)}` +
    `&type=${encodeURIComponent(type)}` +
    (category ? `&category=${encodeURIComponent(category)}` : "") +
    (visitedCsv ? `&visited=${encodeURIComponent(visitedCsv)}` : "");

  const r = await fetch(url);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Errore API suggest (${r.status}) ${txt}`.slice(0, 200));
  }
  return await r.json();
}

/* =========================
   POI (opzionale)
   ========================= */

async function loadPOI(lat, lng) {
  if (!poiListEl) return;
  poiListEl.innerHTML = "";

  try {
    const r = await fetch(`${API.places}?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`);
    if (!r.ok) {
      poiListEl.innerHTML = `<div class="alt-item"><div class="name">POI in arrivo…</div><div class="small">Attiveremo i punti d’interesse presto.</div></div>`;
      return;
    }

    const data = await r.json();
    const els = data?.elements || [];
    if (!els.length) {
      const d = document.createElement("div");
      d.className = "alt-item";
      d.textContent = "Nessun punto di interesse trovato.";
      poiListEl.appendChild(d);
      return;
    }

    els.slice(0, 6).forEach((p) => {
      const name = p.tags?.name || p.tags?.["name:it"] || null;
      if (!name) return;
      const d = document.createElement("div");
      d.className = "alt-item";
      d.innerHTML = `<div class="name">${escapeHtml(name)}</div>`;
      poiListEl.appendChild(d);
    });

    if (!poiListEl.children.length) {
      poiListEl.innerHTML = `<div class="alt-item"><div class="name">Nessun POI nominato</div></div>`;
    }
  } catch {
    // silenzioso
  }
}

/* =========================
   Rendering
   ========================= */

function renderPlace(place) {
  if (!place) return;

  const name = place.name || "Luogo consigliato";
  placeNameEl.textContent = name;

  const km = Number.isFinite(place.distance_km) ? `${place.distance_km.toFixed(0)} km` : "";
  const eta = Number.isFinite(place.eta_min) ? `${Math.round(place.eta_min)} min` : "";
  const line = [eta, km].filter(Boolean).join(" · ");

  placeMetaEl.textContent = line || "Meta trovata";
  mapsLinkEl.href = place.maps_url || `https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lng}`;

  // Visited button
  if (visitedBtn) {
    visitedBtn.onclick = () => {
      if (place.id) {
        markVisited(place.id);
        setStatus("Segnato come già visitato ✅", "ok");
      }
    };
  }

  // Alternative
  altListEl.innerHTML = "";
  const alts = (lastResponse?.alternatives || []).slice(0, 3);

  if (!alts.length) {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">Nessuna alternativa trovata</div>`;
    altListEl.appendChild(div);
  } else {
    alts.forEach((a) => {
      const div = document.createElement("div");
      div.className = "alt-item";
      div.innerHTML = `
        <div class="name">${escapeHtml(a.name || "Alternativa")}</div>
        <div class="small">${Math.round(a.eta_min || 0)} min · ${(a.distance_km || 0).toFixed(0)} km</div>
      `;
      div.onclick = () => {
        lastResponse = {
          ...lastResponse,
          top: a,
          alternatives: [lastResponse.top, ...alts.filter(x => x.id !== a.id)]
            .filter(Boolean)
            .slice(0, 3)
        };
        renderPlace(lastResponse.top);
        loadPOI(lastResponse.top.lat, lastResponse.top.lng);
      };
      altListEl.appendChild(div);
    });
  }

  loadPOI(place.lat, place.lng);
}

/* =========================
   Style pref (known/gems)
   ========================= */

function applyStylePreference(data, style) {
  if (!data || !data.top) return data;
  if (!style) return data;

  const all = [data.top, ...(data.alternatives || [])].filter(Boolean);

  const score = (p) => {
    const n = (p.name || "").trim();
    const len = n.length;
    const words = n.split(/\s+/).filter(Boolean).length;
    const eta = Number.isFinite(p.eta_min) ? p.eta_min : 999;

    if (style === "known") return (words * 2) + (len * 0.05) + (eta * 0.02);
    return (words * -1) + (len * -0.03) + (eta * -0.01);
  };

  const sorted = all.slice().sort((a, b) => score(b) - score(a));
  return { ...data, top: sorted[0], alternatives: sorted.slice(1, 4) };
}

/* =========================
   Main action
   ========================= */

async function run() {
  showResultBox(false);

  const time = Number($("timeSelect")?.value || 60);
  const modeUI = normalizeMode($("modeSelect")?.value || "car");
  const style = ($("styleSelect")?.value || "known").toLowerCase();

  // NO MIX
  const type = normalizeType($("typeSelect")?.value || "places");

  // categoria extra (se esiste nel DOM)
  const category = getCategory(); // es: sea, mountain, city, kids...

  lastMode = modeUI;
  lastMinutes = time;

  // visited list
  const visitedSet = getVisitedSet();
  const visitedCsv = [...visitedSet].slice(0, 150).join(",");

  setStatus("Calcolo la meta migliore…");
  currentOrigin = await getOrigin();

  // fallback mode: se train/bus/plane e backend non li supporta, li “degradiamo” su car
  // (se hai già aggiornato suggest.js a supportarli, questa parte non dà fastidio)
  const modeToServer = ["train","bus","plane"].includes(modeUI) ? modeUI : modeUI;

  setStatus("Cerco mete reali vicino a te…");

  const raw = await fetchSuggest({
    lat: currentOrigin.lat,
    lng: currentOrigin.lng,
    minutes: time,
    mode: modeToServer,
    type,
    category,
    visitedCsv
  });

  if (!raw?.top) {
    setStatus(raw?.message || "Non trovo mete con questi filtri. Aumenta il tempo.", "err");
    return;
  }

  const data = applyStylePreference(raw, style);
  lastResponse = data;

  showResultBox(true);
  renderPlace(data.top);
  setStatus("Meta trovata ✔", "ok");
}

/* =========================
   Events
   ========================= */

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

if (rerollBtn) {
  rerollBtn.onclick = () => {
    if (!lastResponse?.alternatives?.length) return;
    const next = lastResponse.alternatives[0];
    const rest = lastResponse.alternatives.slice(1);
    lastResponse = {
      ...lastResponse,
      alternatives: [lastResponse.top, ...rest].filter(Boolean).slice(0, 3),
      top: next
    };
    renderPlace(lastResponse.top);
    loadPOI(lastResponse.top.lat, lastResponse.top.lng);
    setStatus("Ok, cambio meta 🎲", "ok");
  };
}
