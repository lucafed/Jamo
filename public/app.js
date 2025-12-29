/* =========================
   JAMO — app.js (v8 ONE-API)
   - Tutto passa da /api/jamo
   - Sempre qualcosa (anche 30/45 min) grazie a Overpass server-side
   - Mare != Milano (solo beach/coast)
   - Chicche => posti piccoli / panorami / borghi
   - Rotazione settimanale + visited
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
const poiListEl   = $("poiList");

const goBtn       = $("goBtn");
const gpsBtn      = $("gpsBtn");
const rerollBtn   = $("rerollBtn");
const visitedBtn  = $("visitedBtn");

const LS_VISITED_KEY = "jamo_visited_v1";
const LS_WEEK_KEY    = "jamo_weekly_picks_v1";

let last = { top: null, alternatives: [] };

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

// ISO-ish week key (good enough)
function weekKey() {
  const d = new Date();
  // Thursday-based week
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(),0,1));
  const weekNo = Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(weekNo).padStart(2,"0")}`;
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

function getWeekPicksSet() {
  try {
    const raw = localStorage.getItem(LS_WEEK_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const key = weekKey();
    const arr = Array.isArray(obj?.[key]) ? obj[key] : [];
    return new Set(arr);
  } catch { return new Set(); }
}

function addWeekPick(id) {
  try {
    const raw = localStorage.getItem(LS_WEEK_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const key = weekKey();
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
   Call /api/jamo
------------------------- */
async function fetchJamo(payload) {
  const r = await fetch(API.jamo, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`JAMO ${r.status}: ${text.slice(0, 140)}`);
  return JSON.parse(text);
}

/* -------------------------
   Render
------------------------- */
function renderBlockList(el, title, items) {
  if (!el) return;
  el.innerHTML = "";
  if (!items || !items.length) {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">${escapeHtml(title)}</div><div class="small">Nessun dato (per ora).</div>`;
    el.appendChild(div);
    return;
  }
  items.slice(0, 6).forEach((t) => {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">${escapeHtml(t)}</div>`;
    el.appendChild(div);
  });
}

function renderResult(top, alternatives) {
  showResultBox(true);

  placeNameEl.textContent = top.name;

  const eta = Number.isFinite(top.eta_min) ? `${Math.round(top.eta_min)} min` : "";
  const km  = Number.isFinite(top.distance_km) ? `${Math.round(top.distance_km)} km` : "";
  const type = top.type ? top.type : "";
  placeMetaEl.textContent = [type, eta, km].filter(Boolean).join(" · ");

  mapsLinkEl.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(top.name)}`;

  // Alternative
  altListEl.innerHTML = "";
  if (!alternatives || !alternatives.length) {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">Nessuna alternativa (strano 😅)</div>`;
    altListEl.appendChild(div);
  } else {
    alternatives.slice(0, 2).forEach((a) => {
      const div = document.createElement("div");
      div.className = "alt-item clickable";
      div.innerHTML = `
        <div class="name">${escapeHtml(a.name)}</div>
        <div class="small">${escapeHtml(a.type || "")} · ${Math.round(a.eta_min || 0)} min · ${Math.round(a.distance_km || 0)} km</div>
      `;
      div.onclick = () => {
        const newTop = a;
        const newAlts = [top, ...alternatives.filter(x => x.id !== a.id)].slice(0, 2);
        last = { top: newTop, alternatives: newAlts };
        renderResult(newTop, newAlts);
        renderDetails(newTop);
        setStatus("Ok, cambio meta 🎲", "ok");
      };
      altListEl.appendChild(div);
    });
  }

  // Buttons
  visitedBtn.onclick = () => {
    if (top.id) markVisited(top.id);
    setStatus("Segnato come già visitato ✅", "ok");
  };

  rerollBtn.onclick = () => {
    if (!last?.alternatives?.length) return;
    const next = last.alternatives[0];
    const rest = last.alternatives.slice(1);
    last = { top: next, alternatives: [top, ...rest].slice(0, 2) };
    renderResult(last.top, last.alternatives);
    renderDetails(last.top);
    setStatus("Ok, nuova proposta 🎲", "ok");
  };

  renderDetails(top);
}

function renderDetails(place) {
  // Sotto "Cosa vedere/fare" mettiamo:
  // - Perché (why)
  // - Cosa fare (what_to_do)
  // - Cosa mangiare (what_to_eat)
  poiListEl.innerHTML = "";

  const pushSection = (label, arr) => {
    const title = document.createElement("div");
    title.className = "sectionTitle";
    title.textContent = label;
    poiListEl.appendChild(title);

    if (!arr || !arr.length) {
      const div = document.createElement("div");
      div.className = "alt-item";
      div.innerHTML = `<div class="name">—</div>`;
      poiListEl.appendChild(div);
      return;
    }

    arr.slice(0, 6).forEach((t) => {
      const div = document.createElement("div");
      div.className = "alt-item";
      div.innerHTML = `<div class="name">${escapeHtml(t)}</div>`;
      poiListEl.appendChild(div);
    });
  };

  pushSection("Perché te la consiglio", place.why);
  pushSection("Cosa vedere / fare", place.what_to_do);
  pushSection("Cosa mangiare", place.what_to_eat);
}

/* -------------------------
   MAIN
------------------------- */
async function run() {
  showResultBox(false);

  const minutes = Number($("timeSelect")?.value || 60);
  const mode = norm($("modeSelect")?.value || "car");
  const style = norm($("styleSelect")?.value || "known"); // known | gems
  const category = $("categorySelect")?.value || "citta_borghi";

  setStatus("Calcolo una meta sensata vicino a te…");
  const origin = await getOrigin();

  const visited = getVisitedSet();
  const weekPicks = getWeekPicksSet();
  const excludeIds = [...visited, ...weekPicks];

  const data = await fetchJamo({
    origin: { lat: origin.lat, lon: origin.lon, label: origin.label },
    minutes,
    mode,
    style,
    category,
    excludeIds
  });

  if (!data?.ok || !data?.top) {
    setStatus(data?.message || "Non trovo mete (per ora). Prova ad aumentare il tempo.", "err");
    return;
  }

  // salva pick settimanale
  addWeekPick(data.top.id);

  last = { top: data.top, alternatives: data.alternatives || [] };
  renderResult(last.top, last.alternatives);
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
