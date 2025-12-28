/* =========================
   JAMO — app.js (STABILE)
   ========================= */

const API = {
  geocode: "/api/geocode",
  destinations: "/api/destinations",
  places: "/api/places"
};

const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const placeNameEl = document.getElementById("placeName");
const placeMetaEl = document.getElementById("placeMeta");
const mapsLinkEl = document.getElementById("mapsLink");
const altListEl = document.getElementById("altList");
const poiListEl = document.getElementById("poiList");

const goBtn = document.getElementById("goBtn");
const gpsBtn = document.getElementById("gpsBtn");
const rerollBtn = document.getElementById("rerollBtn");

let lastResults = [];
let currentOrigin = null;

/* =========================
   UTIL
   ========================= */

function setStatus(msg, type = "") {
  statusEl.textContent = msg;
  statusEl.className = "status" + (type ? " " + type : "");
}

function kmBetween(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;

  const x = Math.sin(dLat / 2) ** 2 +
            Math.sin(dLon / 2) ** 2 * Math.cos(la1) * Math.cos(la2);
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

/* =========================
   ORIGINE
   ========================= */

async function getOrigin() {
  const input = document.getElementById("startInput").value.trim();

  if (input) {
    setStatus("Cerco la partenza…");
    const r = await fetch(`${API.geocode}?q=${encodeURIComponent(input)}`);
    if (!r.ok) throw new Error("Geocoding fallito");
    return await r.json();
  }

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => reject(new Error("GPS non disponibile"))
    );
  });
}

/* =========================
   TEMPO → DISTANZA (STIMA)
   ========================= */

function maxKm(timeMin, mode) {
  const speeds = {
    walk: 4,
    bike: 15,
    car: 60,
    train: 90,
    bus: 70,
    plane: 500
  };
  return (timeMin / 60) * (speeds[mode] || 50);
}

/* =========================
   CORE
   ========================= */

async function loadDestinations(origin, radiusKm, type) {
  const url =
    `${API.destinations}?lat=${origin.lat}&lon=${origin.lon}` +
    `&radiusKm=${Math.round(radiusKm)}&type=${type}`;

  const r = await fetch(url);
  if (!r.ok) throw new Error("Errore caricamento mete");
  const data = await r.json();
  return data.elements || [];
}

function scorePlace(p, style) {
  const tags = p.tags || {};
  let score = 0;

  if (style === "known") {
    if (tags.place === "city") score += 3;
    if (tags.place === "town") score += 2;
    if (tags.population) score += 1;
    if (tags.tourism) score += 2;
  } else {
    if (tags.place === "village") score += 2;
    if (tags.natural || tags.waterway) score += 3;
  }
  return score;
}

async function findPlaces() {
  setStatus("Sto cercando una meta adatta…");

  const time = Number(document.getElementById("timeSelect").value);
  const mode = document.getElementById("modeSelect").value;
  const style = document.getElementById("styleSelect").value;
  const type = document.getElementById("typeSelect").value;

  currentOrigin = await getOrigin();

  const radius = maxKm(time, mode);

  let results = [];
  const typesToTry =
    type === "mix" ? ["places", "nature"] : [type];

  for (const t of typesToTry) {
    const raw = await loadDestinations(currentOrigin, radius, t);
    results.push(...raw);
  }

  if (!results.length) throw new Error("NESSUNA_META");

  results.forEach(p => {
    p._score = scorePlace(p, style);
    p._dist = kmBetween(currentOrigin, {
      lat: p.lat,
      lon: p.lon
    });
  });

  results = results
    .filter(p => p._dist <= radius * 1.1)
    .sort((a, b) => b._score - a._score);

  if (!results.length) throw new Error("NESSUNA_META");

  lastResults = shuffle(results);
  showResult(lastResults[0]);
}

/* =========================
   UI
   ========================= */

async function showResult(p) {
  resultEl.classList.remove("hidden");

  const name =
    p.tags?.name ||
    p.tags?.["name:it"] ||
    "Luogo interessante";

  placeNameEl.textContent = name;

  placeMetaEl.textContent =
    `${Math.round(p._dist)} km · ${p.tags.place || p.tags.natural || "luogo"}`;

  mapsLinkEl.href =
    `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`;

  altListEl.innerHTML = "";
  poiListEl.innerHTML = "";

  lastResults.slice(1, 4).forEach(a => {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `
      <div class="name">${a.tags?.name || "Alternativa"}</div>
      <div class="small">${Math.round(a._dist)} km</div>
    `;
    altListEl.appendChild(div);
  });

  loadPOI(p.lat, p.lon);
  setStatus("Meta trovata ✔", "ok");
}

async function loadPOI(lat, lon) {
  try {
    const r = await fetch(`${API.places}?lat=${lat}&lon=${lon}`);
    if (!r.ok) return;

    const data = await r.json();
    (data.elements || []).slice(0, 5).forEach(p => {
      const d = document.createElement("div");
      d.className = "alt-item";
      d.textContent = p.tags?.name || "Punto di interesse";
      poiListEl.appendChild(d);
    });
  } catch {}
}

/* =========================
   EVENTI
   ========================= */

goBtn.onclick = async () => {
  resultEl.classList.add("hidden");
  try {
    await findPlaces();
  } catch (e) {
    if (e.message === "NESSUNA_META") {
      setStatus(
        "Non trovo mete con questi filtri.\nProva Mix o aumenta il tempo.",
        "err"
      );
    } else {
      setStatus("Errore: " + e.message, "err");
    }
  }
};

gpsBtn.onclick = () => {
  document.getElementById("startInput").value = "";
  setStatus("Userò il GPS quando premi il bottone.");
};

rerollBtn?.addEventListener("click", () => {
  if (lastResults.length > 1) {
    lastResults.push(lastResults.shift());
    showResult(lastResults[0]);
  }
});
