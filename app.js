/* Jamo app.js v3.2
   - Partenza: GPS oppure indirizzo/città (Nominatim dal browser) -> NO api/geocode
   - Mete: OSM via /api/overpass (tu ce l’hai)
   - Mezzi:
     * car / walk / bike: stima tempo coerente
     * train / bus / plane: porta-a-porta plausibile:
         auto -> hub (stazione/bus/aeroporto) + buffer + tratta stimata + auto -> meta
   - Tipo meta: mix / places / nature
   - Alternative + visited + POI (/api/places se esiste, altrimenti fallback)
*/

const $ = (id) => document.getElementById(id);

const els = {
  time: $("timeSelect"),
  mode: $("modeSelect"),
  style: $("styleSelect"),
  type: $("typeSelect"),
  start: $("startInput"),
  go: $("goBtn"),
  useGps: $("useGpsBtn"),
  status: $("status"),
  result: $("result"),
  placeName: $("placeName"),
  placeMeta: $("placeMeta"),
  mapsLink: $("mapsLink"),
  altList: $("altList"),
  poiList: $("poiList"),
  visitedBtn: $("visitedBtn"),
  rerollBtn: $("rerollBtn"),
  footer: $("footerInfo"),
};

const VISITED_KEY = "jamo_visited_v1";

// endpoints (nel tuo repo ci sono)
const API_OVERPASS = "/api/overpass";   // ✅ presente
const API_DIRECTIONS = "/api/directions"; // ✅ presente (ORS)
const API_PLACES = "/api/places";       // ✅ presente (se non risponde, fallback)

// overpass public fallback (solo per hub e POI se serve)
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];

// intermodal settings
const BUFFERS_MIN = { train: 18, bus: 12, plane: 95 };
const SPEED_KMH = { car: 70, walk: 4.5, bike: 14, train: 95, bus: 60, plane: 750 };
const MIN_FLIGHT_KM = 120;

function setStatus(msg, kind = "") {
  els.status.className = "status" + (kind ? " " + kind : "");
  els.status.textContent = msg;
}

function loadVisited() {
  try { return new Set(JSON.parse(localStorage.getItem(VISITED_KEY) || "[]")); }
  catch { return new Set(); }
}
function saveVisited(set) {
  localStorage.setItem(VISITED_KEY, JSON.stringify([...set]));
}

function googleMapsLink(lat, lon, name) {
  const q = encodeURIComponent(name ? `${name} (${lat},${lon})` : `${lat},${lon}`);
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const s1 = Math.sin(dLat / 2) ** 2;
  const s2 = Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * (Math.sin(dLon / 2) ** 2);
  return 2 * R * Math.asin(Math.sqrt(s1 + s2));
}

function formatTime(min) {
  if (!isFinite(min)) return "—";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}
function formatKm(km) {
  if (!isFinite(km)) return "—";
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

function modeLabel(mode) {
  return ({
    car: "Auto", walk: "A piedi", bike: "Bici",
    train: "Treno", bus: "Bus", plane: "Aereo"
  })[mode] || mode;
}

function typeLabel(t) {
  return ({ mix:"Mix", places:"Luoghi", nature:"Natura" })[t] || t;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

// ----------------- START: GPS or manual (Nominatim browser) -----------------
async function getGpsCoords() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("GPS non disponibile"));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: "GPS" }),
      () => reject(new Error("GPS rifiutato o non disponibile")),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    );
  });
}

async function geocodeBrowser(q) {
  // Nominatim dal browser: può essere rate-limited, ma funziona.
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=it&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error("Geocoding non disponibile (Nominatim).");
  const data = await r.json();
  if (!data?.length) throw new Error("Non trovo questa partenza. Scrivila più completa.");
  return {
    lat: Number(data[0].lat),
    lon: Number(data[0].lon),
    label: data[0].display_name || q
  };
}

async function resolveStart() {
  const typed = (els.start.value || "").trim();
  if (typed) {
    setStatus("Cerco l’indirizzo…");
    const g = await geocodeBrowser(typed);
    setStatus(`Partenza: ${g.label}`, "ok");
    return g;
  }
  setStatus("Prendo la posizione GPS…");
  const gps = await getGpsCoords();
  setStatus("GPS OK. Cerco mete…", "ok");
  return gps;
}

// ----------------- Overpass via your API -----------------
function computeRadiusKm(timeMin, mode) {
  // raggio di “scouting” (poi filtriamo per tempo stimato)
  const v = SPEED_KMH[mode] || 60;
  let km = (timeMin / 60) * v;

  // più conservativo: non vogliamo mete fuori tempo
  km *= (mode === "car" ? 0.90 : mode === "bike" ? 0.80 : mode === "walk" ? 0.70 : 1.10);
  km = Math.max(8, Math.min(350, km));
  return km;
}

function normalizeOverpass(el) {
  const t = el.tags || {};
  const name = t.name || t["name:it"] || t["int_name"] || null;

  let kind = "Luogo";
  if (t.place === "city") kind = "Città";
  else if (t.place === "town") kind = "Cittadina";
  else if (t.place === "village") kind = "Borgo";
  else if (t.waterway === "waterfall") kind = "Cascata";
  else if (t.natural === "peak") kind = "Vetta";
  else if (t.boundary === "national_park") kind = "Parco nazionale";
  else if (t.leisure === "nature_reserve") kind = "Riserva naturale";

  return {
    id: `${el.type || "node"}:${el.id}`,
    lat: el.lat,
    lon: el.lon,
    name: name || kind,
    kind,
    tags: t,
    knownScore: scoreKnown(t),
    gemScore: scoreGem(t),
  };
}

function scoreKnown(t) {
  let s = 0;
  if (t.place === "city") s += 10;
  if (t.place === "town") s += 7;
  if (t.place === "village") s += 2;
  if (t.wikipedia || t.wikidata) s += 6;
  const pop = Number(t.population || 0);
  if (pop > 200000) s += 7;
  else if (pop > 50000) s += 5;
  else if (pop > 10000) s += 3;
  return s;
}

function scoreGem(t) {
  let s = 0;
  if (t.place === "village") s += 6;
  if (t.waterway === "waterfall") s += 10;
  if (t.natural === "peak") s += 8;
  if (t.leisure === "nature_reserve") s += 7;
  if (t.boundary === "national_park") s += 7;
  if (t.historic) s += 3;
  return s;
}

function filterByType(items, type) {
  if (type === "mix") return items;

  if (type === "places") {
    return items.filter(x => {
      const p = x.tags.place;
      return p === "city" || p === "town" || p === "village";
    });
  }

  // nature
  return items.filter(x => {
    const t = x.tags;
    return t.waterway === "waterfall" ||
           t.natural === "peak" ||
           t.boundary === "national_park" ||
           t.leisure === "nature_reserve";
  });
}

async function fetchJson(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const txt = await res.text();
    let data;
    try { data = JSON.parse(txt); } catch { data = txt; }
    if (!res.ok) {
      const err = new Error(typeof data === "string" ? data : (data?.error || "Errore API"));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

async function fetchCandidates(start, radiusKm) {
  const url = `${API_OVERPASS}?lat=${encodeURIComponent(start.lat)}&lon=${encodeURIComponent(start.lon)}&radiusKm=${encodeURIComponent(radiusKm)}`;
  const data = await fetchJson(url, {}, 30000);
  const elements = data.elements || [];
  return elements
    .map(normalizeOverpass)
    .filter(x => isFinite(x.lat) && isFinite(x.lon));
}

// ----------------- Travel time estimation -----------------
function estimateDirect(start, dest, mode) {
  const km = haversineKm(start, dest);
  const v = SPEED_KMH[mode] || 60;
  const factor = mode === "car" ? 1.25 : mode === "bike" ? 1.15 : mode === "walk" ? 1.08 : 1.25;
  const kmRoad = km * factor;
  const min = (kmRoad / v) * 60;
  return { km: kmRoad, min };
}

// ORS directions (car) used for first/last mile
async function directionsCarMinutes(from, to) {
  try {
    const payload = {
      profile: "driving-car",
      coordinates: [[from.lon, from.lat],[to.lon, to.lat]]
    };
    const data = await fetchJson(API_DIRECTIONS, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(payload)
    }, 30000);
    const sec = data?.features?.[0]?.properties?.summary?.duration;
    if (typeof sec === "number" && isFinite(sec)) return sec / 60;
    return null;
  } catch {
    return null;
  }
}

// ----------------- HUBS: train/bus/plane -----------------
async function overpassQuery(query) {
  let lastErr = null;
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      const data = await fetchJson(ep, {
        method:"POST",
        headers: { "Content-Type":"application/x-www-form-urlencoded;charset=UTF-8" },
        body: "data=" + encodeURIComponent(query)
      }, 25000);
      return data;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Overpass hubs failed");
}

function hubQuery(type, lat, lon, radiusM) {
  if (type === "train") return `
    [out:json][timeout:18];
    ( node(around:${radiusM},${lat},${lon})["railway"="station"];
      node(around:${radiusM},${lat},${lon})["public_transport"="station"];
      way(around:${radiusM},${lat},${lon})["railway"="station"];
      relation(around:${radiusM},${lat},${lon})["railway"="station"]; );
    out tags center 60;
  `;
  if (type === "bus") return `
    [out:json][timeout:18];
    ( node(around:${radiusM},${lat},${lon})["amenity"="bus_station"];
      node(around:${radiusM},${lat},${lon})["highway"="bus_stop"];
      way(around:${radiusM},${lat},${lon})["amenity"="bus_station"]; );
    out tags center 60;
  `;
  return `
    [out:json][timeout:18];
    ( node(around:${radiusM},${lat},${lon})["aeroway"~"aerodrome|airport"];
      way(around:${radiusM},${lat},${lon})["aeroway"~"aerodrome|airport"];
      relation(around:${radiusM},${lat},${lon})["aeroway"~"aerodrome|airport"]; );
    out tags center 60;
  `;
}

function elToHub(el) {
  const t = el.tags || {};
  const name = t.name || t["name:it"] || t["int_name"] || "Hub";
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (!isFinite(lat) || !isFinite(lon)) return null;
  return { name, lat, lon };
}

async function nearestHub(type, origin) {
  const radii = type === "plane" ? [80000,150000,250000] : [30000,60000,120000];
  for (const r of radii) {
    const data = await overpassQuery(hubQuery(type, origin.lat, origin.lon, r));
    const hubs = (data.elements || []).map(elToHub).filter(Boolean);
    if (hubs.length) {
      hubs.sort((a,b)=>haversineKm(origin,a)-haversineKm(origin,b));
      return hubs[0];
    }
  }
  return null;
}

async function hubNearDestination(type, dest) {
  const r = type === "plane" ? 60000 : 12000;
  const data = await overpassQuery(hubQuery(type, dest.lat, dest.lon, r));
  const hubs = (data.elements || []).map(elToHub).filter(Boolean);
  if (!hubs.length) return null;
  hubs.sort((a,b)=>haversineKm(dest,a)-haversineKm(dest,b));
  return hubs[0];
}

function estimateMainLegMin(type, hubA, hubB) {
  const dKm = haversineKm(hubA, hubB);
  if (type === "plane") return (dKm / SPEED_KMH.plane) * 60 + 25; // taxi/landing
  if (type === "train") return (dKm / SPEED_KMH.train) * 60 * 1.2;
  return (dKm / SPEED_KMH.bus) * 60 * 1.25;
}

// ----------------- picking / alternatives -----------------
function pickWeighted(items, style, visited) {
  const pool = items.filter(x => !visited.has(x.id));
  if (!pool.length) return null;

  const weights = pool.map(x => {
    const base = (style === "gems" ? (x.gemScore + 1) : (x.knownScore + 1));
    return Math.max(1, base) * (0.75 + Math.random()*0.6);
  });

  const sum = weights.reduce((a,b)=>a+b,0);
  let r = Math.random() * sum;
  for (let i=0;i<pool.length;i++){
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length-1];
}

function topAlternatives(items, chosenId, style, visited, start, mode, timeMin, n=3) {
  return items
    .filter(x => x.id !== chosenId && !visited.has(x.id))
    .map(x => {
      const s = (style === "gems" ? x.gemScore : x.knownScore) + Math.random()*0.8;
      const est = estimateDirect(start, x, mode);
      const ok = est.min <= timeMin * 1.15;
      return { x, s: s + (ok ? 1.5 : -2.0), est, ok };
    })
    .sort((a,b)=>b.s-a.s)
    .slice(0, n)
    .map(o => ({...o.x, _est:o.est, _ok:o.ok}));
}

// ----------------- POI -----------------
async function fetchPois(dest) {
  try {
    const r = await fetch(`${API_PLACES}?lat=${encodeURIComponent(dest.lat)}&lon=${encodeURIComponent(dest.lon)}&radiusKm=10`);
    if (!r.ok) return [];
    const data = await r.json();
    const els2 = data.elements || [];
    return els2
      .map(el => {
        const t = el.tags || {};
        const name = t.name || t["name:it"] || null;
        if (!name) return null;
        return { name };
      })
      .filter(Boolean)
      .slice(0, 6);
  } catch {
    return [];
  }
}

function renderPois(pois) {
  els.poiList.innerHTML = "";
  if (!pois.length) {
    els.poiList.innerHTML = `<div class="poiItem"><b>In arrivo:</b> qui mostriamo i punti top del luogo scelto.</div>`;
    return;
  }
  for (const p of pois) {
    const div = document.createElement("div");
    div.className = "poiItem";
    div.textContent = p.name;
    els.poiList.appendChild(div);
  }
}

// ----------------- SHOW RESULT -----------------
const state = {
  start:null, mode:"car", style:"known", type:"mix", timeMin:60,
  items:[], pick:null,
};

async function computeEtaForPick(start, pick, mode, timeMin) {
  // direct modes
  if (mode === "car" || mode === "walk" || mode === "bike") {
    const est = estimateDirect(start, pick, mode);
    return { totalMin: est.min, detail: `Distanza ~ ${formatKm(est.km)} • Tempo ~ ${formatTime(est.min)}` };
  }

  // intermodal
  const hubType = mode; // train/bus/plane
  const depHub = await nearestHub(hubType, start);
  if (!depHub) return { totalMin: Infinity, detail: "Nessun hub vicino alla partenza." };

  const arrHub = await hubNearDestination(hubType, pick);
  if (!arrHub) return { totalMin: Infinity, detail: "Nessun hub vicino alla meta." };

  if (hubType === "plane") {
    const dKm = haversineKm(depHub, arrHub);
    if (dKm < MIN_FLIGHT_KM) return { totalMin: Infinity, detail: "Volo troppo vicino: scegli più tempo o altro mezzo." };
  }

  // first mile car
  const access = (await directionsCarMinutes(start, depHub)) ?? estimateDirect(start, depHub, "car").min;
  // main
  const main = estimateMainLegMin(hubType, depHub, arrHub);
  // last mile car
  const egress = (await directionsCarMinutes(arrHub, pick)) ?? estimateDirect(arrHub, pick, "car").min;
  const buffer = BUFFERS_MIN[hubType] || 15;
  const total = access + buffer + main + egress;

  const detail =
    `Porta-a-porta stimato: ${formatTime(total)}\n` +
    `• Auto → hub: ${formatTime(access)} (${depHub.name})\n` +
    `• Attese/controlli: ${formatTime(buffer)}\n` +
    `• ${modeLabel(mode)}: ${formatTime(main)} (${arrHub.name})\n` +
    `• Auto → meta: ${formatTime(egress)}`;

  return { totalMin: total, detail };
}

async function showPick(pick) {
  els.result.hidden = false;

  const eta = await computeEtaForPick(state.start, pick, state.mode, state.timeMin);
  const ok = eta.totalMin <= state.timeMin * 1.15;

  els.placeName.textContent = pick.name;
  els.placeMeta.textContent =
    `${pick.kind} • Mezzo: ${modeLabel(state.mode)} • Tipo: ${typeLabel(state.type)}\n` +
    (ok ? "✅ Coerente col tempo scelto\n" : "⚠️ Potrebbe sforare un po’\n") +
    eta.detail;

  els.mapsLink.href = googleMapsLink(pick.lat, pick.lon, pick.name);

  // alternatives
  const visited = loadVisited();
  const alts = topAlternatives(state.items, pick.id, state.style, visited, state.start, state.mode, state.timeMin, 3);
  els.altList.innerHTML = "";
  if (!alts.length) {
    els.altList.innerHTML = `<div class="altItem"><div class="n">Nessuna alternativa</div><div class="m">Prova ad aumentare il tempo.</div></div>`;
  } else {
    for (const a of alts) {
      const div = document.createElement("div");
      div.className = "altItem";
      div.innerHTML = `
        <div class="n">${escapeHtml(a.name)}</div>
        <div class="m">${escapeHtml(a.kind)} • ${a._ok ? "✅" : "⚠️"} ~ ${formatTime(a._est.min)}</div>
      `;
      div.addEventListener("click", async () => {
        state.pick = a;
        await showPick(a);
      });
      els.altList.appendChild(div);
    }
  }

  // POI
  setStatus("Cerco cosa vedere…");
  const pois = await fetchPois(pick);
  renderPois(pois);

  setStatus("Fatto ✅", "ok");
  els.footer.textContent = `Jamo • ${modeLabel(state.mode)} • ${typeLabel(state.type)} • ${state.style === "gems" ? "Chicche" : "Più conosciuti"}`;
}

async function run() {
  els.go.disabled = true;
  try {
    els.result.hidden = true;

    state.timeMin = Number(els.time.value || 60);
    state.mode = els.mode.value || "car";
    state.style = els.style.value || "known";
    state.type = els.type.value || "mix";

    state.start = await resolveStart();

    setStatus("Scarico mete reali (OSM)…");
    const radiusKm = computeRadiusKm(state.timeMin, state.mode === "train" || state.mode === "bus" || state.mode === "plane" ? "car" : state.mode);

    let items = await fetchCandidates(state.start, radiusKm);
    items = filterByType(items, state.type);

    // filtro tempo: per intermodal non posso filtrare tutti (lento), quindi filtro solo direct; intermodal filtra dopo sul pick
    if (state.mode === "car" || state.mode === "walk" || state.mode === "bike") {
      items = items.filter(x => estimateDirect(state.start, x, state.mode).min <= state.timeMin * 1.25);
    }

    if (!items.length) throw new Error("Non trovo mete con questi filtri. Prova Mix o aumenta tempo.");

    state.items = items;

    const visited = loadVisited();
    const pick = pickWeighted(items, state.style, visited);
    if (!pick) throw new Error("Hai segnato tutto come visitato 😅 Prova ad aumentare il tempo.");

    state.pick = pick;
    await showPick(pick);
  } catch (e) {
    setStatus(`Errore: ${String(e.message || e)}`, "err");
  } finally {
    els.go.disabled = false;
  }
}

// events
els.go.addEventListener("click", run);

els.useGps.addEventListener("click", async () => {
  els.start.value = "";
  try {
    setStatus("Richiesta GPS…");
    await getGpsCoords();
    setStatus("GPS pronto ✅ Ora premi DOVE ANDIAMO?", "ok");
  } catch {
    setStatus("GPS non disponibile o rifiutato. Scrivi un indirizzo.", "err");
  }
});

els.rerollBtn.addEventListener("click", async () => {
  if (!state.start || !state.items?.length) return run();
  const visited = loadVisited();
  const pick = pickWeighted(state.items, state.style, visited);
  if (!pick) return setStatus("Non ho altre mete nel pool. Aumenta il tempo.", "err");
  state.pick = pick;
  await showPick(pick);
});

els.visitedBtn.addEventListener("click", () => {
  if (!state.pick) return;
  const visited = loadVisited();
  visited.add(state.pick.id);
  saveVisited(visited);
  setStatus(`Segnato come già visitato: ${state.pick.name}`, "ok");
});

// init
setStatus("Pronto. Premi il bottone.");
