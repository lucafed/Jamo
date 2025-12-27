/* Jamo - app.js (v0.2) - Solo LUOGHI + alternative + visitati
   - Usa GPS
   - Chiama /api/overpass (serverless Vercel) per prendere candidati da OpenStreetMap
   - Filtra e stima tempi in client
*/

const $ = (id) => document.getElementById(id);

const els = {
  mode: $("mode"),
  time: $("time"),
  dist: $("dist"),
  budget: $("budget"),
  goBtn: $("goBtn"),
  status: $("status"),
  results: $("results"),
  distPill: $("distPill"),
  timePill: $("timePill"),
  showVisited: $("showVisited"),
  preferFamous: $("preferFamous"),
  modeHint: $("modeHint"),
};

const VISITED_KEY = "jamo.visited.v1"; // localStorage: array di osmIds string
const lastState = {
  lastResult: null,
};

function loadVisitedSet() {
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

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// velocità semplici (km/h) per stime iniziali
const SPEEDS = {
  walk: 4.5,
  bike: 16,
  car: 70,
  bus: 55,
  train: 95,
  plane: 700,
};

function minutesFor(mode, distanceKm) {
  if (mode === "plane") {
    // overhead minimo: raggiungere aeroporto + check-in + boarding (semplificato)
    const overhead = 90; // min
    const flight = (distanceKm / SPEEDS.plane) * 60;
    return overhead + flight;
  }
  const speed = SPEEDS[mode] ?? 60;
  return (distanceKm / speed) * 60;
}

function formatMinutes(min) {
  if (!isFinite(min)) return "—";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

function getTimeAvailableMin() {
  return Number(els.time.value);
}
function getDistanceMaxKm() {
  return Number(els.dist.value);
}

function updatePills() {
  els.distPill.textContent = `${getDistanceMaxKm()} km`;
  els.timePill.textContent = `${formatMinutes(getTimeAvailableMin())}`;
  const m = els.mode.value;
  els.modeHint.textContent =
    m === "plane" ? "include overhead" :
    m === "train" ? "stima media" :
    "stima tempi";
}
els.dist.addEventListener("input", updatePills);
els.time.addEventListener("change", updatePills);
els.mode.addEventListener("change", updatePills);
updatePills();

function geoGetPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocalizzazione non supportata"));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    );
  });
}

async function fetchCandidates({ lat, lon, radiusKm }) {
  const url = `/api/overpass?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&radiusKm=${encodeURIComponent(radiusKm)}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Errore API (${res.status}): ${text || "request failed"}`);
  }
  return res.json();
}

function scoreCandidate(c, preferFamous) {
  // Heuristica semplice:
  // - wikipedia = bonus
  // - population alta = bonus
  // - place city/town = bonus
  // - natura (waterfall/peak/park) = bonus medio
  let s = 0;

  const tags = c.tags || {};
  const place = tags.place || "";
  const natural = tags.natural || "";
  const waterway = tags.waterway || "";
  const boundary = tags.boundary || "";
  const leisure = tags.leisure || "";

  const hasWiki = Boolean(tags.wikipedia || tags.wikidata);
  const pop = Number(tags.population || 0);

  if (place === "city") s += 40;
  else if (place === "town") s += 28;
  else if (place === "village") s += 18;

  if (natural === "peak") s += 22;
  if (waterway === "waterfall") s += 24;
  if (boundary === "national_park" || leisure === "nature_reserve") s += 20;

  if (hasWiki) s += 26;
  if (pop) s += Math.min(22, Math.log10(pop + 1) * 6);

  // se non preferFamous, riduci peso wikipedia/pop e premia un po' varietà
  if (!preferFamous) {
    s = s * 0.75;
    s += (natural || waterway || boundary || leisure) ? 6 : 0;
  }
  // leggera randomizzazione per non essere sempre identico
  s += Math.random() * 6;

  return s;
}

function normalizeCandidates(raw, userLat, userLon) {
  // raw.elements -> uniformiamo in oggetti
  const elems = raw?.elements || [];
  const out = [];
  for (const el of elems) {
    if (!el || !el.lat || !el.lon) continue;
    const tags = el.tags || {};
    const name = tags.name || tags["name:it"] || tags["name:en"];
    if (!name) continue;

    const id = `${el.type}/${el.id}`;
    const distanceKm = haversineKm(userLat, userLon, el.lat, el.lon);

    out.push({
      id,
      lat: el.lat,
      lon: el.lon,
      tags,
      name,
      kind: tags.place ? `place:${tags.place}` :
            tags.waterway === "waterfall" ? "waterfall" :
            tags.natural === "peak" ? "peak" :
            (tags.boundary === "national_park" || tags.leisure === "nature_reserve") ? "park" :
            "place",
      distanceKm,
    });
  }
  // dedup per nome+approx posizione
  const seen = new Set();
  return out.filter((c) => {
    const k = `${c.name.toLowerCase()}|${Math.round(c.lat*100)}|${Math.round(c.lon*100)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function applyModeConstraints(cands, mode) {
  // NOTE: in questa v0.2 NON facciamo routing reale.
  // Per treno/aereo facciamo un filtro plausibile:
  // - train: solo city/town/village (già) + bonus se "railway station" vicino lo farà l'API (v0.3)
  // - plane: solo city/town (non cascate/peak) e distanza minima > 80km per evitare "stai a L'Aquila -> L'Aquila"
  if (mode === "plane") {
    return cands.filter(c => (c.tags.place === "city" || c.tags.place === "town") && c.distanceKm >= 80);
  }
  if (mode === "train") {
    return cands.filter(c => c.tags.place === "city" || c.tags.place === "town" || c.tags.place === "village");
  }
  return cands;
}

function applyBudgetSoft(cands, budget, mode) {
  // Per ora “soft”: limita distanze molto alte se budget basso, ecc.
  if (budget === "any") return cands;

  return cands.filter(c => {
    const d = c.distanceKm;
    if (budget === "low") {
      if (mode === "plane") return d <= 450; // "vicino"
      return d <= 180;
    }
    if (budget === "mid") {
      if (mode === "plane") return d <= 900;
      return d <= 350;
    }
    if (budget === "high") return true;
    return true;
  });
}

function pickMainAndAlternatives(cands, visitedSet, showVisited, preferFamous) {
  const scored = cands
    .map(c => ({
      ...c,
      score: scoreCandidate(c, preferFamous),
      visited: visitedSet.has(c.id),
    }))
    .filter(c => showVisited ? true : !c.visited)
    .sort((a,b) => b.score - a.score);

  if (!scored.length) return { main: null, alts: [] };

  const main = scored[0];
  const alts = scored.slice(1, 4);
  return { main, alts };
}

function googleMapsLink(lat, lon) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lon)}`;
}

function renderResult({ main, alts }, mode, timeAvailMin) {
  els.results.innerHTML = "";

  if (!main) {
    els.results.innerHTML = `
      <div class="result">
        <h2>Nessun luogo trovato <span class="pill bad">0 risultati</span></h2>
        <div class="meta">
          Prova così:
          <ul>
            <li>aumenta la distanza (es. 250–500 km)</li>
            <li>cambia mezzo (Auto è il più affidabile)</li>
            <li>attiva “Mostra anche visitati”</li>
          </ul>
        </div>
      </div>
    `;
    return;
  }

  const mainTime = minutesFor(mode, main.distanceKm);
  const okTime = mainTime <= timeAvailMin;

  els.results.insertAdjacentHTML("beforeend", `
    <div class="result" id="mainResult">
      <h2>
        <span>🎯 ${escapeHtml(main.name)}</span>
        <span class="pill ${okTime ? "ok" : "bad"}">${okTime ? "ok col tempo" : "troppo lontano"}</span>
      </h2>
      <div class="meta">
        <div>Tipo: <b>${describeKind(main)}</b></div>
        <div>Distanza: <b>${main.distanceKm.toFixed(1)} km</b> • Tempo stimato: <b>${formatMinutes(mainTime)}</b> • Mezzo: <b>${modeLabel(mode)}</b></div>
        <div class="muted">${main.tags.wikipedia ? "📚 Ha wikipedia: " + escapeHtml(main.tags.wikipedia) : ""}</div>
      </div>
      <div class="actions">
        <button class="smallbtn primary" data-open="${googleMapsLink(main.lat, main.lon)}">📍 Apri su Maps</button>
        <button class="smallbtn" data-toggle-visited="${main.id}">
          ${main.visited ? "✅ Già visitato" : "☑️ Segna come visitato"}
        </button>
        <button class="smallbtn" id="rerollBtn">🎲 Cambia meta</button>
      </div>

      <div class="alts" id="alts">
        <div class="muted" style="margin:6px 2px;">Alternative</div>
        ${alts.map(a => altHtml(a, mode, timeAvailMin)).join("")}
      </div>
    </div>
  `);

  // bind buttons
  els.results.querySelectorAll("[data-open]").forEach(btn => {
    btn.addEventListener("click", () => window.open(btn.getAttribute("data-open"), "_blank"));
  });
  els.results.querySelectorAll("[data-toggle-visited]").forEach(btn => {
    btn.addEventListener("click", () => toggleVisited(btn.getAttribute("data-toggle-visited")));
  });
  const rerollBtn = $("rerollBtn");
  if (rerollBtn) rerollBtn.addEventListener("click", () => reroll(mode, timeAvailMin));
}

function reroll(mode, timeAvailMin) {
  // “Reroll” = scegli un altro main dalle alternative + nuovi
  // Semplice: rimescola e riprendi dall’ultimo dataset, ricominciando dalla selezione
  if (!lastState.lastResult) return;
  // aggiungi randomizzazione: ricalcoliamo score e repick
  const visitedSet = loadVisitedSet();
  const showVisited = els.showVisited.checked;
  const preferFamous = els.preferFamous.checked;

  const repicked = pickMainAndAlternatives(lastState.lastResult, visitedSet, showVisited, preferFamous);
  renderResult(repicked, mode, timeAvailMin);
}

function toggleVisited(osmId) {
  const set = loadVisitedSet();
  if (set.has(osmId)) set.delete(osmId);
  else set.add(osmId);
  saveVisitedSet(set);

  // ricarica UI mantenendo lo stesso dataset
  const mode = els.mode.value;
  const timeAvailMin = getTimeAvailableMin();
  reroll(mode, timeAvailMin);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;"
  }[m]));
}

function modeLabel(mode){
  return ({
    walk:"A piedi", bike:"Bici", car:"Auto", bus:"Bus", train:"Treno", plane:"Aereo"
  })[mode] || mode;
}
function describeKind(c){
  const k = c.kind || "";
  if (k.startsWith("place:")) {
    const p = k.split(":")[1];
    return p === "city" ? "Città" : p === "town" ? "Paese" : p === "village" ? "Borgo" : "Luogo";
  }
  if (k === "waterfall") return "Cascata";
  if (k === "peak") return "Montagna / cima";
  if (k === "park") return "Parco / riserva";
  return "Luogo";
}

function altHtml(a, mode, timeAvailMin){
  const t = minutesFor(mode, a.distanceKm);
  const ok = t <= timeAvailMin;
  return `
    <div class="alt">
      <div class="altTitle">
        <span>➡️ ${escapeHtml(a.name)}</span>
        <span class="pill ${ok ? "ok" : "bad"}">${ok ? "ok" : "lontano"}</span>
      </div>
      <div class="meta">
        ${describeKind(a)} • <b>${a.distanceKm.toFixed(1)} km</b> • <b>${formatMinutes(t)}</b>
      </div>
      <div class="actions">
        <button class="smallbtn primary" data-open="${googleMapsLink(a.lat, a.lon)}">📍 Maps</button>
        <button class="smallbtn" data-toggle-visited="${a.id}">
          ${a.visited ? "✅ Già visitato" : "☑️ Visitato"}
        </button>
      </div>
    </div>
  `;
}

function filterByTimeAndDistance(cands, mode, timeAvailMin, distMaxKm) {
  // Prima filtro distanza, poi tempo stimato
  return cands.filter(c => {
    if (c.distanceKm > distMaxKm) return false;
    const t = minutesFor(mode, c.distanceKm);
    // per “plane/train” non tagliamo troppo stretto: lasciamo un 10% di tolleranza
    const tol = (mode === "plane" || mode === "train") ? 1.1 : 1.0;
    return t <= timeAvailMin * tol;
  });
}

async function onGo() {
  els.goBtn.disabled = true;
  els.status.textContent = "📍 Sto leggendo il GPS…";

  try {
    const pos = await geoGetPosition();
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;

    const mode = els.mode.value;
    const timeAvailMin = getTimeAvailableMin();
    const distMaxKm = getDistanceMaxKm();
    const budget = els.budget.value;

    // raggio query API: un po’ più grande della distanza max per avere candidati sufficienti
    // (poi filtriamo in client)
    const radiusKm = Math.min(1200, Math.max(distMaxKm * 1.3, 50));

    els.status.textContent = `🔎 Cerco luoghi entro ~${Math.round(radiusKm)} km…`;

    const raw = await fetchCandidates({ lat, lon, radiusKm });

    let cands = normalizeCandidates(raw, lat, lon);
    cands = applyModeConstraints(cands, mode);
    cands = applyBudgetSoft(cands, budget, mode);
    cands = filterByTimeAndDistance(cands, mode, timeAvailMin, distMaxKm);

    // se troppo pochi, prova un rilassamento automatico (ma senza impazzire)
    if (cands.length < 6 && distMaxKm < 800) {
      const relaxed = normalizeCandidates(raw, lat, lon);
      cands = applyModeConstraints(relaxed, mode);
      cands = applyBudgetSoft(cands, budget, mode);
      // rilassa solo tempo, non distanza
      cands = cands.filter(c => c.distanceKm <= distMaxKm);
    }

    lastState.lastResult = cands;

    const visitedSet = loadVisitedSet();
    const showVisited = els.showVisited.checked;
    const preferFamous = els.preferFamous.checked;

    const pick = pickMainAndAlternatives(cands, visitedSet, showVisited, preferFamous);

    // aggiorna visited flag negli oggetti (per UI)
    if (pick.main) pick.main.visited = visitedSet.has(pick.main.id);
    pick.alts.forEach(a => a.visited = visitedSet.has(a.id));

    renderResult(pick, mode, timeAvailMin);

    els.status.textContent =
      pick.main
        ? `✅ Trovati ${cands.length} luoghi candidati.`
        : `⚠️ Nessun risultato con questi filtri. Prova ad aumentare km o cambiare mezzo.`;

  } catch (err) {
    els.status.textContent = `❌ ${err.message || "Errore sconosciuto"}`;
    els.results.innerHTML = `
      <div class="result">
        <h2>Errore</h2>
        <div class="meta">${escapeHtml(err.message || String(err))}</div>
      </div>
    `;
  } finally {
    els.goBtn.disabled = false;
  }
}

els.goBtn.addEventListener("click", onGo);
