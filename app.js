/* =========================
   JAMO — app.js (v3 COMPLETO / STABILE)
   - /api/geocode (partenza manuale)
   - /api/suggest (mete: conosciuti/chicche + categoria)
   - /api/places (opzionale: cosa vedere/fare)
   ========================= */

const API = {
  geocode: "/api/geocode",
  suggest: "/api/suggest",
  places: "/api/places" // opzionale
};

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const resultEl = $("result");
const placeNameEl = $("placeName");
const placeMetaEl = $("placeMeta");
const mapsLinkEl = $("mapsLink");
const altListEl = $("altList");
const poiListEl = $("poiList");

const goBtn = $("goBtn");
const gpsBtn = $("gpsBtn");
const visitedBtn = $("visitedBtn");
const rerollBtn = $("rerollBtn");

const LS_VISITED_KEY = "jamo_visited_v2";

let lastResponse = null;     // risposta server { top, alternatives, ... }
let currentOrigin = null;    // { lat, lng, label }
let lastParams = null;       // per reroll/debug

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* =========================
   Visited
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
  if (!id) return;
  const set = getVisitedSet();
  set.add(id);
  saveVisitedSet(set);
}

/* =========================
   Origin: input OR GPS
   ========================= */

async function getOrigin() {
  const input = $("startInput")?.value?.trim() || "";

  // 1) Partenza manuale
  if (input) {
    setStatus("Cerco la partenza…");
    const r = await fetch(`${API.geocode}?q=${encodeURIComponent(input)}`);
    if (!r.ok) throw new Error("Geocoding fallito");
    const data = await r.json();

    const lat = safeNum(data.lat);
    const lng = safeNum(data.lng ?? data.lon);
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
   Suggest API
   ========================= */

async function fetchSuggest({ lat, lng, minutes, mode, style, category, visitedCsv }) {
  const url =
    `${API.suggest}?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}` +
    `&minutes=${encodeURIComponent(minutes)}&mode=${encodeURIComponent(mode)}` +
    `&style=${encodeURIComponent(style || "known")}` +
    `&category=${encodeURIComponent(category || "any")}` +
    (visitedCsv ? `&visited=${encodeURIComponent(visitedCsv)}` : "");

  const r = await fetch(url);
  const text = await r.text().catch(() => "");
  let data = null;
  try { data = JSON.parse(text); } catch { data = { message: text }; }

  // L’API a volte ritorna 200 con top=null (fallback). Va bene.
  if (!r.ok) {
    throw new Error(`Errore API suggest (${r.status}) ${text}`.slice(0, 220));
  }
  return data;
}

/* =========================
   POI (cosa vedere/fare)
   ========================= */

async function loadPOI(lat, lng) {
  if (!poiListEl) return;

  poiListEl.innerHTML = `<div class="alt-item"><div class="name">POI in arrivo…</div><div class="small">Carico cosa vedere / fare vicino alla meta</div></div>`;

  try {
    const r = await fetch(`${API.places}?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`);
    if (!r.ok) {
      poiListEl.innerHTML = `<div class="alt-item"><div class="name">POI non disponibili</div><div class="small">Riprova tra poco</div></div>`;
      return;
    }

    const data = await r.json();
    const els = Array.isArray(data?.elements) ? data.elements : [];

    // Filtra solo POI con nome, dedup
    const seen = new Set();
    const named = [];
    for (const e of els) {
      const name = e.tags?.name || e.tags?.["name:it"];
      if (!name) continue;
      const k = String(name).trim().toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      named.push(name);
      if (named.length >= 7) break;
    }

    if (!named.length) {
      poiListEl.innerHTML = `<div class="alt-item"><div class="name">Nessun POI trovato</div><div class="small">Prova a cambiare categoria o aumentare tempo</div></div>`;
      return;
    }

    poiListEl.innerHTML = "";
    for (const n of named) {
      const div = document.createElement("div");
      div.className = "alt-item";
      div.innerHTML = `<div class="name">${escapeHtml(n)}</div>`;
      poiListEl.appendChild(div);
    }
  } catch {
    poiListEl.innerHTML = `<div class="alt-item"><div class="name">POI non disponibili</div><div class="small">Connessione/servizio momentaneamente lento</div></div>`;
  }
}

/* =========================
   Rendering
   ========================= */

function renderAlternatives(alts) {
  altListEl.innerHTML = "";

  // Dedup UI (backup)
  const seen = new Set();
  const clean = [];
  for (const a of (alts || [])) {
    const key = (a.name || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    clean.push(a);
    if (clean.length >= 3) break;
  }

  if (!clean.length) {
    altListEl.innerHTML = `<div class="alt-item"><div class="name">Nessuna alternativa trovata</div></div>`;
    return;
  }

  clean.forEach((a) => {
    const eta = Number.isFinite(a.eta_min) ? `${Math.round(a.eta_min)} min` : "";
    const km = Number.isFinite(a.distance_km) ? `${a.distance_km.toFixed(0)} km` : "";
    const small = [eta, km].filter(Boolean).join(" · ");

    const div = document.createElement("div");
    div.className = "alt-item clickable";
    div.innerHTML = `
      <div class="name">${escapeHtml(a.name || "Alternativa")}</div>
      <div class="small">${escapeHtml(small)}</div>
    `;

    div.onclick = () => {
      // porta questa alternativa a "top"
      const oldTop = lastResponse?.top;
      const rest = clean.filter(x => x.id !== a.id);
      lastResponse = {
        ...lastResponse,
        top: a,
        alternatives: [oldTop, ...rest].filter(Boolean).slice(0, 3)
      };
      renderPlace(lastResponse.top);
      loadPOI(lastResponse.top.lat, lastResponse.top.lng);
      setStatus("Ok: alternativa selezionata ✔", "ok");
    };

    altListEl.appendChild(div);
  });
}

function renderPlace(place) {
  if (!place) return;

  const name = place.name || "Luogo consigliato";
  placeNameEl.textContent = name;

  const eta = Number.isFinite(place.eta_min) ? `${Math.round(place.eta_min)} min` : "";
  const km = Number.isFinite(place.distance_km) ? `${place.distance_km.toFixed(0)} km` : "";
  placeMetaEl.textContent = [eta, km].filter(Boolean).join(" · ") || "Meta trovata";

  mapsLinkEl.href =
    place.maps_url ||
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.lat + "," + place.lng)}`;

  // visited
  if (visitedBtn) {
    visitedBtn.onclick = () => {
      if (place.id) {
        markVisited(place.id);
        setStatus("Segnato come già visitato ✅", "ok");
      }
    };
  }

  // alternatives
  renderAlternatives(lastResponse?.alternatives || []);

  // POI
  loadPOI(place.lat, place.lng);
}

/* =========================
   Main
   ========================= */

async function run() {
  showResultBox(false);

  const minutes = Number($("timeSelect")?.value || 60);
  const mode = String($("modeSelect")?.value || "car").toLowerCase();

  // SOLO due stili: conosciuti / chicche
  const style = String($("styleSelect")?.value || "known").toLowerCase(); // known | gems

  // NO MIX: categoria vera
  const category = String($("categorySelect")?.value || "any").toLowerCase(); // any|city|sea|mountain|kids

  // visited list
  const visitedSet = getVisitedSet();
  const visitedCsv = [...visitedSet].slice(0, 150).join(",");

  lastParams = { minutes, mode, style, category };

  setStatus("Calcolo la meta migliore…");

  currentOrigin = await getOrigin();

  setStatus("Cerco mete reali…");

  const data = await fetchSuggest({
    lat: currentOrigin.lat,
    lng: currentOrigin.lng,
    minutes,
    mode,
    style,
    category,
    visitedCsv
  });

  // Overpass down / top null
  if (!data?.top) {
    setStatus(
      data?.message || "Non trovo mete con questi filtri. Aumenta il tempo o cambia categoria.",
      "err"
    );
    return;
  }

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

    // prende la prima alternativa come nuova top
    const next = lastResponse.alternatives[0];
    const rest = lastResponse.alternatives.slice(1);

    lastResponse = {
      ...lastResponse,
      top: next,
      alternatives: [lastResponse.top, ...rest].filter(Boolean).slice(0, 3)
    };

    renderPlace(lastResponse.top);
    loadPOI(lastResponse.top.lat, lastResponse.top.lng);
    setStatus("Ok, cambio meta 🎲", "ok");
  };
}
