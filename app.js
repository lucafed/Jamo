const timeSelect = document.getElementById("timeSelect");
const modeSelect = document.getElementById("modeSelect");
const goBtn = document.getElementById("goBtn");

const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const placeNameEl = document.getElementById("placeName");
const placeMetaEl = document.getElementById("placeMeta");
const mapsLinkEl = document.getElementById("mapsLink");
const altListEl = document.getElementById("altList");
const visitedBtn = document.getElementById("visitedBtn");
const footerInfo = document.getElementById("footerInfo");

let lastTop = null;

// --- storage "già visitato"
const VISITED_KEY = "jamo_visited_v1";
function loadVisited() {
  try { return JSON.parse(localStorage.getItem(VISITED_KEY) || "[]"); }
  catch { return []; }
}
function saveVisited(list) {
  localStorage.setItem(VISITED_KEY, JSON.stringify(list.slice(0, 500)));
}
function markVisited(placeId) {
  const v = new Set(loadVisited());
  v.add(placeId);
  saveVisited([...v]);
}
function isVisited(placeId) {
  return new Set(loadVisited()).has(placeId);
}

// --- UI helpers
function setStatus(msg, isErr=false, isOk=false){
  statusEl.textContent = msg;
  statusEl.classList.toggle("err", !!isErr);
  statusEl.classList.toggle("ok", !!isOk);
}
function setLoading(loading){
  goBtn.disabled = loading;
  goBtn.textContent = loading ? "⏳ Cerco un posto..." : "🎲 DOVE ANDIAMO?";
}
function hideResult(){
  resultEl.classList.add("hidden");
  lastTop = null;
}
function showResult(){
  resultEl.classList.remove("hidden");
}

// --- Geo
function getPosition(){
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocalizzazione non supportata."));
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 30000
    });
  });
}

function fmtKm(km){
  if (km == null) return "";
  if (km < 10) return km.toFixed(1) + " km";
  return Math.round(km) + " km";
}
function fmtMin(min){
  if (min == null) return "";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min/60);
  const m = Math.round(min%60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

function renderResult(payload){
  // GUARDIA (evita "— —")
  if (!payload || !payload.top) {
    hideResult();
    return;
  }

  const top = payload.top;
  lastTop = top;

  const visited = isVisited(top.id);
  const visitedTag = visited ? " • (già visitato)" : "";

  placeNameEl.textContent = top.name + visitedTag;
  placeMetaEl.textContent = `${fmtKm(top.distance_km)} • ${fmtMin(top.eta_min)} • mezzo: ${payload.mode}`;

  mapsLinkEl.href = top.maps_url;

  // Alternative
  altListEl.innerHTML = "";
  (payload.alternatives || []).forEach((a) => {
    const div = document.createElement("div");
    div.className = "alt-item";
    const v = isVisited(a.id) ? " • (già visitato)" : "";
    div.innerHTML = `
      <div class="name">${a.name}${v}</div>
      <div class="meta">${fmtKm(a.distance_km)} • ${fmtMin(a.eta_min)}</div>
      <a class="linkbtn" href="${a.maps_url}" target="_blank" rel="noopener">Apri</a>
    `;
    altListEl.appendChild(div);
  });

  visitedBtn.textContent = visited ? "✅ Già segnato" : "✅ Segna come “già visitato”";
  visitedBtn.disabled = visited;

  showResult();
}

visitedBtn.addEventListener("click", () => {
  if (!lastTop) return;
  markVisited(lastTop.id);
  visitedBtn.textContent = "✅ Già segnato";
  visitedBtn.disabled = true;
  placeNameEl.textContent = lastTop.name + " • (già visitato)";
});

goBtn.addEventListener("click", async () => {
  setLoading(true);
  hideResult();
  setStatus("📍 Prendo il GPS...", false);

  try {
    const pos = await getPosition();
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;

    const minutes = parseInt(timeSelect.value, 10);
    const mode = modeSelect.value;

    setStatus("🧠 Calcolo zona raggiungibile e cerco luoghi reali...", false);

    const visited = loadVisited();

    const url = `/api/suggest?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&minutes=${encodeURIComponent(minutes)}&mode=${encodeURIComponent(mode)}&visited=${encodeURIComponent(visited.join(","))}`;

    const res = await fetch(url, { method: "GET" });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = data?.details?.error || data?.error || `Errore API (${res.status}).`;
      setStatus("❌ " + msg, true);
      hideResult();
      return;
    }

    // FIX CHIAVE: se top è null, NON renderizzare “— —”
    if (!data.top) {
      setStatus(
        "⚠️ Nessun luogo trovato con questo tempo.\nProva ad aumentare i minuti o cambia mezzo.",
        true
      );
      hideResult();
      return;
    }

    setStatus("✅ Trovato!", false, true);
    footerInfo.textContent = `Versione 2.0 • ${data.engine} • ${data.source}`;
    renderResult(data);

  } catch (e) {
    setStatus("❌ " + (e?.message || "Errore sconosciuto"), true);
    hideResult();
  } finally {
    setLoading(false);
  }
});
