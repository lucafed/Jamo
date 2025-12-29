/* =========================
   JAMO — app.js (v5 STABILE DEFINITIVA)
   ========================= */

const API = {
  geocode: "/api/geocode",
  plan: "/api/plan"
};

const CURATED_URL = "/data/curated.json";

const $ = (id) => document.getElementById(id);

// UI
const statusEl = $("status");
const resultEl = $("result");
const placeNameEl = $("placeName");
const placeMetaEl = $("placeMeta");
const mapsLinkEl = $("mapsLink");
const altListEl = $("altList");
const poiListEl = $("poiList");
const goBtn = $("goBtn");
const gpsBtn = $("gpsBtn");
const rerollBtn = $("rerollBtn");
const visitedBtn = $("visitedBtn");

// storage
const LS_VISITED_KEY = "jamo_visited_v1";
const LS_DAILY_KEY = "jamo_daily_v1";

// state
let lastPicks = null;
let lastWeatherLabel = "";

/* -------------------------
   Utils
------------------------- */
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function setStatus(msg, type = "") {
  statusEl.textContent = msg;
  statusEl.className = "status" + (type ? " " + type : "");
}

function showResult(show) {
  resultEl.classList.toggle("hidden", !show);
}

/* -------------------------
   Storage
------------------------- */
function getSet(key) {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || "[]"));
  } catch {
    return new Set();
  }
}

function saveSet(key, set) {
  localStorage.setItem(key, JSON.stringify([...set]));
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
}

/* -------------------------
   Origin
------------------------- */
async function getOrigin() {
  const input = $("startInput").value.trim();
  if (input) {
    const r = await fetch(`${API.geocode}?q=${encodeURIComponent(input)}`);
    const d = await r.json();
    return { lat: d.lat, lon: d.lon, label: d.label || input };
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({
        lat: p.coords.latitude,
        lon: p.coords.longitude,
        label: "La tua posizione"
      }),
      () => reject(new Error("GPS non disponibile"))
    );
  });
}

/* -------------------------
   Curated
------------------------- */
async function loadCurated() {
  const r = await fetch(CURATED_URL, { cache: "no-store" });
  const d = await r.json();
  return d.places.map(p => ({
    ...p,
    typeN: norm(p.type)
  }));
}

/* -------------------------
   Distance
------------------------- */
function toRad(x){ return x * Math.PI / 180; }
function haversineKm(a,b,c,d){
  const R=6371;
  const dLat=toRad(c-a), dLon=toRad(d-b);
  return 2*R*Math.asin(Math.sqrt(
    Math.sin(dLat/2)**2 +
    Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(dLon/2)**2
  ));
}

function estimate(origin, p, mode){
  const km = haversineKm(origin.lat, origin.lon, p.lat, p.lng);
  const speed = mode==="walk"?4.5:mode==="bike"?15:80;
  return { km, min: (km/speed)*60 };
}

/* -------------------------
   MAIN
------------------------- */
async function run() {
  showResult(false);

  const minutes = Number($("timeSelect").value);
  const mode = $("modeSelect").value.toLowerCase();
  const style = $("styleSelect").value.toLowerCase();
  const category = norm($("categorySelect").value);

  const visited = getSet(LS_VISITED_KEY);
  const dailyAll = JSON.parse(localStorage.getItem(LS_DAILY_KEY) || "{}");
  const daily = new Set(dailyAll[todayKey()] || []);

  setStatus("Calcolo la meta migliore…");
  const origin = await getOrigin();

  // 🚄 mezzi pubblici
  if (["plane","train","bus"].includes(mode)) {
    const r = await fetch(API.plan, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ origin, maxMinutes: minutes, mode })
    });
    const d = await r.json();
    if (!d.results?.length) {
      setStatus("Nessuna meta trovata con questi filtri.", "err");
      return;
    }
    const top = d.results[0];
    renderResult({
      id: top.destination.id,
      name: `${top.destination.name}, ${top.destination.country}`,
      eta: top.totalMinutes,
      hub: `${top.originHub.code || ""} → ${top.destinationHub.code || ""}`,
      lat: top.destination.lat,
      lng: top.destination.lon,
      what_to_do: []
    }, []);
    return;
  }

  // 🚗 auto / walk / bike
  const curated = await loadCurated();

  let filtered = curated.filter(p => p.typeN === category);

  let scored = filtered.map(p => {
    const e = estimate(origin, p, mode);
    return { ...p, km: e.km, min: e.min };
  }).filter(p => p.min <= minutes * 1.15);

  // 🔥 fallback: se rimane 1 sola meta, NON la scartiamo mai
  let usable = scored.filter(p => !visited.has(p.id) && !daily.has(p.id));
  if (!usable.length && scored.length === 1) {
    usable = scored;
  }

  if (!usable.length) {
    setStatus(
      `Non trovo mete con questi filtri.\n` +
      `Categoria: ${category}\n` +
      `Mete caricate: ${curated.length}\n` +
      `Dopo categoria: ${filtered.length}\n` +
      `Dopo tempo: ${scored.length}`,
      "err"
    );
    return;
  }

  usable.sort((a,b)=>a.min-b.min);
  const top = usable[0];
  const alts = usable.slice(1,3);

  // salva daily
  daily.add(top.id);
  dailyAll[todayKey()] = [...daily];
  localStorage.setItem(LS_DAILY_KEY, JSON.stringify(dailyAll));

  renderResult(top, alts);
}

/* -------------------------
   Render
------------------------- */
function renderResult(top, alts){
  showResult(true);
  placeNameEl.textContent = top.name;
  placeMetaEl.textContent =
    `${Math.round(top.min)} min · ${Math.round(top.km)} km`;
  mapsLinkEl.href =
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(top.name)}`;

  altListEl.innerHTML = "";
  alts.forEach(a=>{
    const d=document.createElement("div");
    d.className="alt-item";
    d.innerHTML=`<div class="name">${a.name}</div><div class="small">${Math.round(a.min)} min</div>`;
    altListEl.appendChild(d);
  });

  poiListEl.innerHTML="";
  (top.what_to_do||[]).slice(0,5).forEach(t=>{
    const d=document.createElement("div");
    d.className="alt-item";
    d.textContent=t;
    poiListEl.appendChild(d);
  });

  visitedBtn.onclick=()=>{
    const v=getSet(LS_VISITED_KEY);
    v.add(top.id);
    saveSet(LS_VISITED_KEY,v);
    setStatus("Segnata come visitata ✅","ok");
  };

  setStatus("Meta trovata ✔","ok");
}

/* -------------------------
   Events
------------------------- */
goBtn.onclick = async () => {
  goBtn.disabled = true;
  try { await run(); }
  catch(e){ setStatus("Errore: "+e.message,"err"); }
  finally{ goBtn.disabled=false; }
};

gpsBtn.onclick = () => {
  $("startInput").value="";
  setStatus("Userò il GPS alla ricerca");
};
