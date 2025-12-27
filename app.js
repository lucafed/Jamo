const goBtn = document.getElementById("goBtn");
const timeSelect = document.getElementById("timeSelect");
const statusEl = document.getElementById("status");

const resultEl = document.getElementById("result");
const placeNameEl = document.getElementById("placeName");
const placeWhyEl = document.getElementById("placeWhy");
const badgeTimeEl = document.getElementById("badgeTime");
const badgeKmEl = document.getElementById("badgeKm");
const mapsLinkEl = document.getElementById("mapsLink");
const visitedBtn = document.getElementById("visitedBtn");
const altListEl = document.getElementById("altList");

const VISITED_KEY = "jamo_visited_places_v1";

function getVisitedSet() {
  try {
    const raw = localStorage.getItem(VISITED_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(arr);
  } catch {
    return new Set();
  }
}
function saveVisitedSet(set) {
  localStorage.setItem(VISITED_KEY, JSON.stringify([...set]));
}

function setStatus(msg = "", isError = true) {
  statusEl.style.color = isError ? "#ff8080" : "#A0B2BA";
  statusEl.textContent = msg;
}

function getGPS() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("GPS non supportato dal browser."));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    );
  });
}

function kmFromMeters(m) {
  return Math.round((m / 1000) * 10) / 10;
}

function googleMapsLink(lat, lng, label) {
  const q = encodeURIComponent(label ? `${label}` : `${lat},${lng}`);
  return `https://www.google.com/maps/search/?api=1&query=${q}&query_place_id=`;
}

function renderResult(payload) {
  resultEl.classList.remove("hidden");

  const top = payload.top;
  placeNameEl.textContent = top.name;
  badgeTimeEl.textContent = `⏱️ ${top.eta_minutes} min`;
  badgeKmEl.textContent = `📍 ${top.distance_km} km`;

  placeWhyEl.textContent = top.reason;

  mapsLinkEl.href = googleMapsLink(top.lat, top.lng, top.name);

  // visited handling
  const visited = getVisitedSet();
  const key = top.id;
  const isVisited = visited.has(key);
  visitedBtn.textContent = isVisited ? "✅ Già segnato come visitato" : "✅ Segna come “già visitato”";
  visitedBtn.disabled = isVisited;

  visitedBtn.onclick = () => {
    const v = getVisitedSet();
    v.add(key);
    saveVisitedSet(v);
    visitedBtn.textContent = "✅ Già segnato come visitato";
    visitedBtn.disabled = true;
  };

  // alternatives
  altListEl.innerHTML = "";
  for (const alt of payload.alternatives || []) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = googleMapsLink(alt.lat, alt.lng, alt.name);
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = `${alt.name} — ${alt.eta_minutes} min • ${alt.distance_km} km`;
    li.appendChild(a);
    altListEl.appendChild(li);
  }
}

goBtn.addEventListener("click", async () => {
  try {
    setStatus("");
    resultEl.classList.add("hidden");
    goBtn.disabled = true;

    setStatus("📍 Prendo la tua posizione…", false);
    const { lat, lng } = await getGPS();

    const minutes = Number(timeSelect.value);

    setStatus("🔎 Cerco un luogo reale coerente col tempo…", false);

    const res = await fetch(`/api/suggest?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&minutes=${encodeURIComponent(minutes)}`, {
      method: "GET",
      headers: { "Accept": "application/json" }
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data?.error || `Errore API (${res.status})`);
    }

    renderResult(data);
    setStatus("", false);
  } catch (e) {
    setStatus(`❌ ${e.message || e}`, true);
  } finally {
    goBtn.disabled = false;
  }
});
