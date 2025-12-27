const btn = document.getElementById("goBtn");
const resultBox = document.getElementById("results");

function ui(msg) {
  resultBox.innerHTML = `<div class="muted">${msg}</div>`;
}

function pickRandom(arr, n = 3) {
  const copy = [...arr];
  const out = [];
  while (copy.length && out.length < n) {
    const i = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(s));
}

async function getPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
        }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    );
  });
}

async function fetchIsochrone({ lat, lon, profile, minutes }) {
  const res = await fetch("/api/isochrone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat, lon, profile, minutes }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(text);

  return JSON.parse(text);
}

async function fetchPlaces(geojson) {
  const res = await fetch("/api/places", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ geojson }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));

  return data.places || [];
}

function renderPlaces(origin, places, minutes) {
  if (!places.length) {
    ui("Nessun luogo trovato nell’area. Prova ad aumentare il tempo.");
    return;
  }

  // scegli 1 principale + 3 alternative
  const picks = pickRandom(places, 4);
  const main = picks[0];
  const alts = picks.slice(1);

  const mainKm = haversineKm(origin, main).toFixed(1);

  const mapsLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${main.name}`
  )}`;

  let html = `
    <div class="card">
      <div class="title">Meta consigliata</div>
      <div class="big">${main.name}</div>
      <div class="meta">≈ ${mainKm} km in linea d’aria • entro ~${minutes} min (stima rete stradale)</div>
      <a class="btnLink" href="${mapsLink}" target="_blank" rel="noopener">Apri su Maps</a>
    </div>
  `;

  if (alts.length) {
    html += `<div class="subtitle">Alternative</div>`;
    html += `<div class="list">`;
    for (const p of alts) {
      const km = haversineKm(origin, p).toFixed(1);
      const link = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `${p.name}`
      )}`;
      html += `
        <div class="item">
          <div class="itemName">${p.name}</div>
          <div class="itemMeta">≈ ${km} km</div>
          <a class="miniLink" href="${link}" target="_blank" rel="noopener">Maps</a>
        </div>
      `;
    }
    html += `</div>`;
  }

  resultBox.innerHTML = html;
}

btn.addEventListener("click", async () => {
  try {
    // per ora SOLO AUTO (driving-car), così è solido
    const profile = "driving-car";
    const minutes = parseInt(document.getElementById("timeSelect").value, 10);

    ui("📍 Prendo il GPS...");
    const origin = await getPosition();

    ui("🧠 Calcolo l’area raggiungibile...");
    const geojson = await fetchIsochrone({
      lat: origin.lat,
      lon: origin.lon,
      profile,
      minutes,
    });

    ui("🔎 Cerco città e borghi nell’area...");
    const places = await fetchPlaces(geojson);

    renderPlaces(origin, places, minutes);
  } catch (e) {
    ui("❌ Errore: " + String(e).slice(0, 300));
  }
});
