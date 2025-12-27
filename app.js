/**
 * JAMO v0.6 – SOLO LUOGHI (NO attrazioni)
 * - Cerca place=city|town|village|hamlet da OpenStreetMap (Overpass)
 * - Filtri: raggio km + tempo max + budget max + mezzo
 * - Aereo: impone distanza minima (non ti propone “casa tua”)
 * - 1 luogo + 3 alternative
 */

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const resultsEl = $("results");
const btnGo = $("btnGo");

const radiusEl = $("radiusKm");
const modeEl = $("mode");
const timeEl = $("timeBudgetMin");
const budgetEl = $("budget");
const placeTypeEl = $("placeType");
const vibeEl = $("vibe");

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

btnGo.addEventListener("click", async () => {
  resultsEl.innerHTML = "";

  try {
    btnGo.disabled = true;
    setStatus("📍 Richiedo il GPS…");

    const pos = await getCurrentPosition({ enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
    const user = { lat: pos.coords.latitude, lon: pos.coords.longitude };

    let radiusKm = Number(radiusEl.value);
    let radiusMeters = radiusKm * 1000;

    const mode = modeEl.value;
    const timeBudgetMin = parseOptionalNumber(timeEl.value);
    const budgetMax = parseOptionalNumber(budgetEl.value);

    const placeType = placeTypeEl.value; // any/city/town/village/mix
    const vibe = vibeEl.value;

    // Aereo: ha senso cercare più largo
    if (mode === "plane" && radiusKm < 500) {
      radiusKm = 500;
      radiusMeters = 500 * 1000;
    }

    // distanza minima: per aereo non vogliamo roba sotto casa
    const minDistanceKm = (mode === "plane") ? 120 : 3;

    setStatus(`🔎 Cerco luoghi entro ${radiusKm} km…`);

    let places = await fetchPlaces(user.lat, user.lon, radiusMeters, placeType);

    // fallback 1: se niente, prova mix
    if (!places.length && placeType !== "mix") {
      setStatus("Nessun risultato con questo tipo. Provo MIX…");
      places = await fetchPlaces(user.lat, user.lon, radiusMeters, "mix");
    }

    // fallback 2: se ancora niente, aumenta raggio a 150km minimo
    if (!places.length) {
      const emergencyKm = Math.max(radiusKm, 150);
      setStatus(`Ancora nulla. Aumento il raggio a ${emergencyKm} km…`);
      places = await fetchPlaces(user.lat, user.lon, emergencyKm * 1000, "mix");
      radiusKm = emergencyKm;
    }

    if (!places.length) {
      setStatus("Non trovo luoghi (Overpass può essere lento). Riprova tra poco o aumenta il raggio.", true);
      return;
    }

    // calcola distanze + stime
    let scored = places
      .map((p) => ({
        ...p,
        distanceKm: haversineKm(user.lat, user.lon, p.lat, p.lon),
      }))
      .filter((p) => p.distanceKm >= minDistanceKm) // scarta troppo vicini
      .map((p) => {
        const est = estimateTrip(p.distanceKm, mode);
        const score = scorePlace(p, vibe, mode);
        return { ...p, est, score };
      })
      .sort((a, b) => b.score - a.score);

    if (!scored.length) {
      setStatus("Tutto troppo vicino per i filtri scelti. Aumenta il raggio.", true);
      return;
    }

    // filtri tempo/budget
    const filtered = scored.filter((p) => {
      if (timeBudgetMin != null && p.est.minutes > timeBudgetMin) return false;
      if (budgetMax != null && p.est.cost > budgetMax) return false;
      return true;
    });

    const finalList = filtered.length ? filtered : scored;

    if (!filtered.length) {
      setStatus("⚠️ Con tempo/budget scelti non esce nulla: ti mostro comunque i migliori luoghi (aumenta tempo/budget).", true);
    } else {
      setStatus("✅ Fatto.");
    }

    const main = finalList[0];
    const alternatives = finalList.slice(1, 4);

    render(main, alternatives, {
      mode, radiusKm, placeType, vibe,
      timeBudgetMin, budgetMax, minDistanceKm
    });

  } catch (err) {
    console.error(err);
    if (String(err).includes("denied")) setStatus("GPS negato. Attiva la posizione e consenti l’accesso.", true);
    else setStatus("Errore: " + (err?.message || String(err)), true);
  } finally {
    btnGo.disabled = false;
  }
});

/* ===================== PLACES (Overpass) ===================== */

async function fetchPlaces(lat, lon, radiusMeters, placeType) {
  const placeRegex = toPlaceRegex(placeType);

  // Importante: prendiamo solo "place" (luoghi), niente tourism/amenity
  const query = `
[out:json][timeout:25];
(
  nwr(around:${radiusMeters},${lat},${lon})["place"~"${placeRegex}"];
);
out center tags;
`;

  const json = await fetchOverpass(query);
  const els = Array.isArray(json.elements) ? json.elements : [];

  const parsed = els.map((e) => {
    const tags = e.tags || {};
    const name = tags.name || tags["name:it"] || null;
    const cLat = e.lat ?? e.center?.lat;
    const cLon = e.lon ?? e.center?.lon;
    if (!cLat || !cLon) return null;

    const place = tags.place || "place";
    const typeLabel = placeLabel(place);

    return {
      id: `${e.type}/${e.id}`,
      name: name || typeLabel,
      place,
      typeLabel,
      lat: cLat,
      lon: cLon,
      tags
    };
  }).filter(Boolean);

  // dedup
  const seen = new Set();
  const out = [];
  for (const p of parsed) {
    const key = `${p.name}|${p.lat.toFixed(4)}|${p.lon.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }

  // riduci se troppi
  return out.slice(0, 400);
}

function toPlaceRegex(placeType) {
  // city/town/village/hamlet
  if (placeType === "city") return "city";
  if (placeType === "town") return "town";
  if (placeType === "village") return "village|hamlet";
  if (placeType === "mix") return "city|town|village|hamlet";
  return "city|town|village|hamlet";
}

function placeLabel(place) {
  if (place === "city") return "Città";
  if (place === "town") return "Paese";
  if (place === "village") return "Borgo";
  if (place === "hamlet") return "Località";
  return "Luogo";
}

/* ===================== Overpass fetch with fallback ===================== */

async function fetchOverpass(query) {
  let lastErr = null;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: "data=" + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`Overpass ${url} status ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Overpass non disponibile");
}

/* ===================== Estimates + scoring ===================== */

function estimateTrip(distanceKm, mode) {
  const speeds = { car:55, train:75, bus:40, walk:4.5, bike:14, plane:650 };

  if (mode === "plane") {
    const flightMinutes = Math.round((distanceKm / speeds.plane) * 60);
    const overhead = 120; // aeroporto (indicativo)
    const minutes = overhead + flightMinutes;
    const cost = round2(35 + distanceKm * 0.12);
    return { minutes, cost, flightMinutes };
  }

  const speed = speeds[mode] || 50;
  const minutes = Math.round((distanceKm / speed) * 60);

  let cost = 0;
  if (mode === "car") cost = distanceKm * 0.20;
  else if (mode === "train") cost = 3 + distanceKm * 0.10;
  else if (mode === "bus") cost = 2.2 + distanceKm * 0.06;
  else cost = 0;

  return { minutes, cost: round2(cost) };
}

function scorePlace(p, vibe, mode) {
  let s = 0;
  const km = p.distanceKm ?? 0;

  // per aereo: premia medio-lontano
  if (mode === "plane") {
    if (km < 150) s -= 20;
    else if (km <= 400) s += 10;
    else if (km <= 900) s += 7;
    else s += 3;
  } else {
    // altri: vicino è meglio
    if (km <= 20) s += 9;
    else if (km <= 60) s += 7;
    else if (km <= 150) s += 5;
    else s += 2;
  }

  // tipo luogo (città un po' più “sicura” come meta)
  if (p.place === "city") s += 3;
  if (p.place === "town") s += 2;

  // vibe
  if (vibe === "quick") { if (km <= 40) s += 4; else s -= 2; }
  if (vibe === "chill") { if (km <= 120) s += 2; }
  if (vibe === "adventure") { if (km >= 30 && km <= 200) s += 3; }
  if (vibe === "romantic") { if (p.place === "village" || p.place === "town") s += 2; }

  s += Math.random() * 1.1;
  return s;
}

function round2(x){ return Math.round(x * 100) / 100; }

/* ===================== UI render ===================== */

function render(main, alternatives, ctx) {
  resultsEl.innerHTML = "";

  const summary = document.createElement("div");
  summary.className = "pill";
  const timeTxt = ctx.timeBudgetMin ? `⏱ ${ctx.timeBudgetMin} min` : "⏱ no limite";
  const budTxt = ctx.budgetMax ? `💶 €${ctx.budgetMax}` : "💶 no limite";
  summary.textContent = `${labelMode(ctx.mode)} • ${timeTxt} • ${budTxt} • raggio ${ctx.radiusKm}km • min dist ${ctx.minDistanceKm}km • ${labelPlaceType(ctx.placeType)} • ${labelVibe(ctx.vibe)}`;
  resultsEl.appendChild(summary);

  resultsEl.appendChild(card("Luogo consigliato", main, true));

  if (alternatives.length) {
    const div = document.createElement("div");
    div.className = "divider";
    resultsEl.appendChild(div);

    const pill = document.createElement("div");
    pill.className = "pill";
    pill.textContent = "Alternative";
    resultsEl.appendChild(pill);

    alternatives.forEach((a) => resultsEl.appendChild(card("", a, false)));
  }
}

function card(title, p, isMain) {
  const wrap = document.createElement("div");
  wrap.className = "dest";

  if (title) {
    const pill = document.createElement("div");
    pill.className = "pill";
    pill.textContent = title;
    wrap.appendChild(pill);
  }

  const name = document.createElement("p");
  name.className = "name";
  name.textContent = p.name;
  wrap.appendChild(name);

  const meta = document.createElement("p");
  meta.className = "meta";
  const extraPlane = p.est.flightMinutes != null ? ` (volo ~${p.est.flightMinutes} min)` : "";
  meta.textContent = `${p.typeLabel} • ${p.distanceKm.toFixed(1)} km • ~${p.est.minutes} min${extraPlane} • ~€${p.est.cost}`;
  wrap.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "actions";

  const btnMaps = document.createElement("button");
  btnMaps.className = "smallbtn";
  btnMaps.textContent = "Apri in Maps";
  btnMaps.onclick = () => openInMaps(p.lat, p.lon);
  actions.appendChild(btnMaps);

  wrap.appendChild(actions);

  if (isMain) {
    const hint = document.createElement("div");
    hint.className = "pill";
    hint.textContent = "Se non ti convince, scegli una alternativa 👇";
    wrap.appendChild(hint);
  }

  return wrap;
}

function openInMaps(lat, lon) {
  const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lon)}`;
  window.open(url, "_blank");
}

function labelMode(m){
  return ({car:"🚗 Auto",train:"🚆 Treno",bus:"🚌 Bus",bike:"🚲 Bici",walk:"🚶 A piedi",plane:"✈️ Aereo"})[m] || m;
}
function labelPlaceType(t){
  return ({any:"🎯 Qualsiasi",city:"🏙️ Città",town:"🏘️ Paese",village:"🌿 Borgo",mix:"✨ Mix"})[t] || t;
}
function labelVibe(v){
  return ({any:"✨ Qualsiasi",quick:"⚡ Vicino e veloce",chill:"🧘 Tranquillo",adventure:"🧗 Fuori porta",romantic:"💘 Romantico"})[v] || v;
}

/* ===================== Utils ===================== */

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? "error" : "muted";
}

function parseOptionalNumber(v) {
  const n = Number(String(v || "").trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function getCurrentPosition(options) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}
function deg2rad(deg) { return deg * (Math.PI / 180); }
