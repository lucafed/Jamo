/* =========================
   JAMO — app.js (v8 WHY+EAT+MERGE)
   - Categoria: accenti + "Città / Borghi"
   - Auto/Walk/Bike: vicino davvero + fallback controllato
   - Plane/Train/Bus: anti-same-city + score + MERGE con curated (type/why/what_to_do/what_to_eat)
   - Alternative: punta ad averne sempre 2
   - Motivazioni: genera "Perché te la consiglio" (whyComputed)
   ========================= */

const API = {
  geocode: "/api/geocode",
  plan: "/api/plan",
  places: "/api/places" // opzionale
};

const CURATED_URL = "/data/curated.json";
const $ = (id) => document.getElementById(id);

// UI refs
const statusEl    = $("status");
const resultEl    = $("result");
const placeNameEl = $("placeName");
const placeMetaEl = $("placeMeta");
const mapsLinkEl  = $("mapsLink");
const altListEl   = $("altList");
const poiListEl   = $("poiList");

// (Step C: in index aggiungeremo anche questi due)
const whyListEl   = $("whyList");     // opzionale
const eatListEl   = $("eatList");     // opzionale

const goBtn       = $("goBtn");
const gpsBtn      = $("gpsBtn");
const rerollBtn   = $("rerollBtn");
const visitedBtn  = $("visitedBtn");

const LS_VISITED_KEY = "jamo_visited_v1";
const LS_DAILY_KEY   = "jamo_daily_reco_v1";

let lastPicks = { top: null, alternatives: [] };
let lastWeatherLabel = "";

/* -------------------------
   UI helpers
------------------------- */
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

/* -------------------------
   String normalize (lower + no accents)
------------------------- */
function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();
}
function normName(s) {
  return norm(s).replace(/[^a-z0-9]+/g, " ").trim();
}

/* -------------------------
   Storage
------------------------- */
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
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
function getDailyRecoSet() {
  try {
    const raw = localStorage.getItem(LS_DAILY_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const key = todayKey();
    const arr = Array.isArray(obj?.[key]) ? obj[key] : [];
    return new Set(arr);
  } catch { return new Set(); }
}
function addDailyReco(id) {
  try {
    const raw = localStorage.getItem(LS_DAILY_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const key = todayKey();
    const arr = Array.isArray(obj?.[key]) ? obj[key] : [];
    if (!arr.includes(id)) arr.push(id);
    obj[key] = arr.slice(0, 200);
    localStorage.setItem(LS_DAILY_KEY, JSON.stringify(obj));
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
      localStorage.removeItem(LS_DAILY_KEY);
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
   Meteo (non blocca)
------------------------- */
async function getWeather(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}` +
    `&longitude=${encodeURIComponent(lon)}` +
    `&daily=weathercode,precipitation_probability_max&forecast_days=1&timezone=auto`;
  try {
    const r = await fetch(url);
    if (!r.ok) return { label: "" };
    const d = await r.json();
    const code = d?.daily?.weathercode?.[0];
    const pop = d?.daily?.precipitation_probability_max?.[0];
    if (Number.isFinite(pop) && pop >= 55) return { label: "pioggia" };
    if (Number.isFinite(code) && code >= 51) return { label: "pioggia" };
    if (Number.isFinite(code) && code <= 2) return { label: "sole" };
    return { label: "nuvoloso" };
  } catch {
    return { label: "" };
  }
}

/* -------------------------
   Curated load + index per merge
------------------------- */
async function loadCurated() {
  const r = await fetch(CURATED_URL, { cache: "no-store" });
  if (!r.ok) return { places: [], byKey: new Map() };
  const d = await r.json();
  const items = Array.isArray(d?.places) ? d.places : [];

  const places = items
    .map(x => ({
      id: x.id,
      name: x.name,
      country: x.country,
      type: norm(x.type),
      visibility: norm(x.visibility),
      lat: Number(x.lat),
      lng: Number(x.lng),
      tags: Array.isArray(x.tags) ? x.tags : [],
      vibes: Array.isArray(x.vibes) ? x.vibes : [],
      best_when: Array.isArray(x.best_when) ? x.best_when : [],
      why: Array.isArray(x.why) ? x.why : [],
      what_to_do: Array.isArray(x.what_to_do) ? x.what_to_do : [],
      what_to_eat: Array.isArray(x.what_to_eat) ? x.what_to_eat : []
    }))
    .filter(p => p.id && p.name && Number.isFinite(p.lat) && Number.isFinite(p.lng));

  // key: "name|country" normalizzato
  const byKey = new Map();
  for (const p of places) {
    const key = `${normName(p.name)}|${norm(p.country)}`;
    if (!byKey.has(key)) byKey.set(key, p);
  }

  return { places, byKey };
}

/* -------------------------
   Geo helpers
------------------------- */
function toRad(x){ return x * Math.PI / 180; }
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat/2)**2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }

function avgSpeedKmh(mode) {
  if (mode === "walk") return 4.5;
  if (mode === "bike") return 15;
  return 80; // car
}
function estimateAutoLike(origin, lat, lng, mode) {
  const d = haversineKm(origin.lat, origin.lon, lat, lng);
  const eta = (d / avgSpeedKmh(mode)) * 60;
  return { distance_km: d, eta_min: eta };
}

/* -------------------------
   Categoria mapping robusto
------------------------- */
function allowedTypesFromCategory(categoryRaw) {
  const c = norm(categoryRaw);
  if (c.includes("borgh") && c.includes("citt")) return ["citta","borgo"];
  if (c === "citta_borghi" || c === "citta/borghi" || c === "citta / borghi") return ["citta","borgo"];
  if (c === "citta" || c === "city" || c === "città") return ["citta"];
  if (c === "borgo" || c === "borghi") return ["borgo"];
  return [c];
}
function typeMatches(placeType, allowedTypes) {
  const t = norm(placeType);
  if (t === "montagna/natura") return allowedTypes.includes("montagna") || allowedTypes.includes("natura");
  return allowedTypes.includes(t);
}

/* -------------------------
   Scoring AUTO (vicino davvero)
------------------------- */
function styleFit(visibility, style) {
  const v = norm(visibility);
  if (style === "known") return v === "conosciuta" ? 1.0 : 0.70;
  return v === "chicca" ? 1.0 : 0.70;
}
function timeFit(etaMin, targetMin) {
  const diff = Math.abs(etaMin - targetMin);
  const denom = Math.max(15, targetMin * 0.8);
  return clamp(1 - (diff / denom), 0, 1);
}
function autoScore(p, targetMin, style, dailySet, visitedSet) {
  if (visitedSet.has(p.id)) return -999;
  if (dailySet.has(p.id)) return -999;

  const sStyle = styleFit(p.visibility, style);
  const sTime  = timeFit(p.eta_min, targetMin);
  const sNear  = clamp(1 - (p.eta_min / (targetMin * 1.2)), 0, 1);

  return (0.50 * sNear) + (0.30 * sTime) + (0.20 * sStyle);
}

/* -------------------------
   /api/plan call (robusto)
------------------------- */
async function fetchPlan({ origin, maxMinutes, mode }) {
  const r = await fetch(API.plan, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ origin, maxMinutes, mode, limit: 30 })
  });

  const text = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`PLAN error ${r.status}: ${text.slice(0, 160)}`);

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`PLAN risposta non JSON: ${text.slice(0, 120)}`);
  }
}

/* -------------------------
   Motivazioni (whyComputed)
------------------------- */
function buildWhy(place, { mode, minutes, weatherLabel, style }) {
  const out = [];

  // 1) tempo coerente
  if (Number.isFinite(place.eta_min) && Number.isFinite(minutes)) {
    const d = Math.abs(place.eta_min - minutes);
    if (d <= Math.max(12, minutes * 0.18)) out.push("Ci stai perfettamente nel tempo che hai.");
    else if (place.eta_min < minutes) out.push("È comoda: ti avanza tempo per godertela senza stress.");
    else out.push("È un po’ tirata ma fattibile: perfetta se vuoi una mini-avventura.");
  }

  // 2) meteo
  if (weatherLabel) {
    if (weatherLabel === "pioggia") {
      if (place.best_when?.includes("pioggia_ok")) out.push("Con la pioggia regge bene: non è una scelta “buttata”.");
      else out.push("Oggi piove: ti conviene puntare su centro/musei/terme o indoor.");
    } else if (weatherLabel === "sole") {
      if (place.type === "mare" || place.type === "natura" || place.type === "montagna") out.push("Con il sole rende tantissimo (panorami/aria aperta).");
      else out.push("Con il sole è perfetta per camminare e fare foto.");
    }
  }

  // 3) stile
  if (style === "known") out.push(place.visibility === "conosciuta" ? "È una meta super affidabile (classicone)." : "È una chicca, ma comunque tranquilla e gestibile.");
  if (style === "gems")  out.push(place.visibility === "chicca" ? "È una chicca vera: meno ovvia, più soddisfazione." : "È conosciuta, ma ci sta se vuoi andare sul sicuro.");

  // 4) se il JSON ha già why, usali prima
  const preset = Array.isArray(place.why) ? place.why : [];
  const merged = [...preset, ...out].filter(Boolean);

  // max 3, senza duplicati semplici
  const seen = new Set();
  const final = [];
  for (const s of merged) {
    const k = normName(s);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    final.push(s);
    if (final.length >= 3) break;
  }
  return final;
}

/* -------------------------
   POI render (+ eat + why se presenti in index)
------------------------- */
function renderWhy(place) {
  if (!whyListEl) return;
  whyListEl.innerHTML = "";
  const arr = Array.isArray(place.whyComputed) && place.whyComputed.length ? place.whyComputed : [];
  if (!arr.length) {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">Perché?</div><div class="small">Sto imparando a motivare meglio le scelte 🙂</div>`;
    whyListEl.appendChild(div);
    return;
  }
  arr.slice(0,3).forEach((t) => {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">${escapeHtml(t)}</div>`;
    whyListEl.appendChild(div);
  });
}

function renderEat(place) {
  if (!eatListEl) return;
  eatListEl.innerHTML = "";
  const arr = Array.isArray(place.what_to_eat) ? place.what_to_eat : [];
  if (!arr.length) {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">Consigli food in arrivo…</div><div class="small">Aggiungeremo cosa mangiare lì.</div>`;
    eatListEl.appendChild(div);
    return;
  }
  arr.slice(0,6).forEach((t) => {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">${escapeHtml(t)}</div>`;
    eatListEl.appendChild(div);
  });
}

async function renderPOI(place) {
  if (!poiListEl) return;
  poiListEl.innerHTML = "";

  if (Array.isArray(place.what_to_do) && place.what_to_do.length) {
    place.what_to_do.slice(0, 6).forEach((t) => {
      const div = document.createElement("div");
      div.className = "alt-item";
      div.innerHTML = `<div class="name">${escapeHtml(t)}</div>`;
      poiListEl.appendChild(div);
    });
    return;
  }

  const div = document.createElement("div");
  div.className = "alt-item";
  div.innerHTML = `<div class="name">Consigli in arrivo…</div><div class="small">Aggiungeremo cosa fare/mangiare.</div>`;
  poiListEl.appendChild(div);
}

/* -------------------------
   Render result
------------------------- */
function renderResult(top, alternatives) {
  showResultBox(true);

  placeNameEl.textContent = top.name;

  const eta = Number.isFinite(top.eta_min) ? `${Math.round(top.eta_min)} min` : "";
  const km  = Number.isFinite(top.distance_km) ? `${top.distance_km.toFixed(0)} km` : "";
  const w   = lastWeatherLabel ? ` · meteo: ${lastWeatherLabel}` : "";
  const extra = top.hubSummary ? ` · ${top.hubSummary}` : "";

  placeMetaEl.textContent = [eta, km].filter(Boolean).join(" · ") + w + extra;
  mapsLinkEl.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(top.name)}`;

  // alternative
  altListEl.innerHTML = "";
  if (!alternatives.length) {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">Nessuna alternativa (per ora)</div>`;
    altListEl.appendChild(div);
  } else {
    alternatives.slice(0, 2).forEach((a) => {
      const div = document.createElement("div");
      div.className = "alt-item clickable";
      div.innerHTML = `
        <div class="name">${escapeHtml(a.name)}</div>
        <div class="small">${Math.round(a.eta_min || 0)} min${a.hubSummary ? ` · ${escapeHtml(a.hubSummary)}` : ""}</div>
      `;
      div.onclick = () => {
        const newTop = a;
        const newAlts = [top, ...alternatives.filter(x => x.id !== a.id)].slice(0, 2);
        lastPicks = { top: newTop, alternatives: newAlts };
        renderResult(newTop, newAlts);
        renderWhy(newTop);
        renderPOI(newTop);
        renderEat(newTop);
        setStatus("Ok, cambio meta 🎲", "ok");
      };
      altListEl.appendChild(div);
    });
  }

  if (visitedBtn) {
    visitedBtn.onclick = () => {
      if (top.id) markVisited(top.id);
      setStatus("Segnato come già visitato ✅", "ok");
    };
  }

  if (rerollBtn) {
    rerollBtn.onclick = () => {
      if (!lastPicks?.alternatives?.length) return;
      const next = lastPicks.alternatives[0];
      const rest = lastPicks.alternatives.slice(1);
      lastPicks = { top: next, alternatives: [top, ...rest].slice(0, 2) };
      renderResult(lastPicks.top, lastPicks.alternatives);
      renderWhy(lastPicks.top);
      renderPOI(lastPicks.top);
      renderEat(lastPicks.top);
      setStatus("Ok, nuova proposta 🎲", "ok");
    };
  }

  // extra sections
  renderWhy(top);
  renderPOI(top);
  renderEat(top);
}

/* -------------------------
   Helpers
------------------------- */
function pickTopAndAlts(list, wantedAlts = 2) {
  const top = list[0];
  const alts = list.slice(1, 1 + wantedAlts);
  return { top, alternatives: alts };
}

function mergeFromCurated(candidate, curatedByKey) {
  const key = `${normName(candidate.name.split(",")[0])}|${norm(candidate.country || "")}`;
  const c = curatedByKey.get(key);
  if (!c) return candidate;

  return {
    ...candidate,
    // eredita
    type: c.type,
    visibility: c.visibility,
    tags: c.tags,
    vibes: c.vibes,
    best_when: c.best_when,
    why: c.why,
    what_to_do: (candidate.what_to_do?.length ? candidate.what_to_do : c.what_to_do),
    what_to_eat: c.what_to_eat
  };
}

/* -------------------------
   MAIN
------------------------- */
async function run() {
  showResultBox(false);

  const minutes   = Number($("timeSelect")?.value || 60);
  const mode      = norm($("modeSelect")?.value || "car");
  const style     = norm($("styleSelect")?.value || "known");
  const categoryRaw  = $("categorySelect")?.value || "citta_borghi";
  const allowedTypes = allowedTypesFromCategory(categoryRaw);

  const visitedSet = getVisitedSet();
  const dailySet   = getDailyRecoSet();

  setStatus("Calcolo la meta migliore…");
  const origin = await getOrigin();

  const weather = await getWeather(origin.lat, origin.lon);
  lastWeatherLabel = weather.label || "";

  // carica curated una volta (serve anche per merge plan→curated)
  const curatedPack = await loadCurated();
  const curated = curatedPack.places;
  const curatedByKey = curatedPack.byKey;

  /* =========================
     PLANE / TRAIN / BUS
  ========================= */
  if (mode === "plane" || mode === "train" || mode === "bus") {
    setStatus(`Cerco mete con ${mode.toUpperCase()}…`);

    const plan = await fetchPlan({
      origin: { lat: origin.lat, lon: origin.lon, label: origin.label },
      maxMinutes: minutes,
      mode
    });

    const results = Array.isArray(plan?.results) ? plan.results : [];
    if (!results.length) {
      setStatus("Non trovo mete con questi filtri. Aumenta il tempo.", "err");
      return;
    }

    const originLabelNorm = normName(origin.label || "");

    let candidates = results.map((r) => {
      const dest = r.destination || {};
      const id = dest.id || `${dest.name || "dest"}_${dest.country || ""}`.toLowerCase().replace(/[^a-z0-9]+/g,"_");
      const km = (Number.isFinite(dest.lat) && Number.isFinite(dest.lon))
        ? haversineKm(origin.lat, origin.lon, Number(dest.lat), Number(dest.lon))
        : null;

      const nameFull = `${dest.name || "Meta"}${dest.country ? `, ${dest.country}` : ""}`;
      const nameNorm = normName(dest.name || "");

      return {
        id,
        name: nameFull,
        country: dest.country || "",
        lat: dest.lat,
        lng: dest.lon,
        eta_min: Number(r.totalMinutes),
        distance_km: km,
        originHub: r.originHub,
        destinationHub: r.destinationHub,
        hubSummary: `${r.originHub?.code || r.originHub?.name} → ${r.destinationHub?.code || r.destinationHub?.name}`,
        // questi arrivano poi dal merge se presenti
        type: "",
        visibility: "",
        tags: [],
        vibes: [],
        best_when: [],
        why: [],
        what_to_do: [],
        what_to_eat: [],
        _nameNorm: nameNorm,
        _originLabelNorm: originLabelNorm
      };
    });

    // filtri anti-cavolate
    candidates = candidates.filter(c => {
      if (!Number.isFinite(c.eta_min)) return false;

      // niente stessa città
      if (c._nameNorm && originLabelNorm && c._nameNorm === originLabelNorm) return false;

      // niente troppo vicino (es. "Verona → Verona" o comuni vicini)
      if (Number.isFinite(c.distance_km) && c.distance_km < 35) return false;

      // niente stesso hub
      const oh = c.originHub?.code || c.originHub?.name || "";
      const dh = c.destinationHub?.code || c.destinationHub?.name || "";
      if (norm(oh) && norm(dh) && norm(oh) === norm(dh)) return false;

      return true;
    });

    // merge con curated se esiste (così abbiamo type/why/food)
    candidates = candidates.map(c => mergeFromCurated(c, curatedByKey));

    // se l’utente ha scelto categoria specifica e il candidate ha type (da merge), filtriamo
    const wantsFilter = allowedTypes.length && !(allowedTypes.length === 2 && allowedTypes.includes("citta") && allowedTypes.includes("borgo"));
    if (wantsFilter) {
      const filteredByType = candidates.filter(c => c.type && typeMatches(c.type, allowedTypes));
      if (filteredByType.length >= 3) candidates = filteredByType;
    }

    // score: tempo coerente + distanza ragionevole
    const target = minutes;
    candidates.forEach(c => {
      const tScore = clamp(1 - (Math.abs(c.eta_min - target) / Math.max(20, target * 0.9)), 0, 1);
      const kScore = Number.isFinite(c.distance_km) ? clamp(1 - (c.distance_km / 1600), 0, 1) : 0.4;
      const tooShortPenalty = c.eta_min < Math.max(45, target * 0.35) ? 0.25 : 0;
      c._score = (0.62 * tScore) + (0.38 * kScore) - tooShortPenalty;
    });

    // filtri visited/daily con fallback
    let list = candidates.filter(c => !visitedSet.has(c.id) && !dailySet.has(c.id));
    if (list.length < 3) list = candidates.filter(c => !visitedSet.has(c.id));
    if (list.length < 3) list = candidates;

    list.sort((a,b)=>b._score - a._score);

    // ensure 2 alts: se mancano, prendiamo anche mete un po’ più “lontane” come ultima chance
    if (list.length < 3) {
      const extra = candidates.slice().sort((a,b)=>a.eta_min - b.eta_min);
      for (const e of extra) {
        if (list.find(x => x.id === e.id)) continue;
        list.push(e);
        if (list.length >= 3) break;
      }
    }

    const { top, alternatives } = pickTopAndAlts(list, 2);
    if (!top) {
      setStatus("Non trovo mete valide (dataset troppo piccolo o filtri troppo stretti).", "err");
      return;
    }

    // motivazioni
    top.whyComputed = buildWhy(top, { mode, minutes, weatherLabel: lastWeatherLabel, style });

    addDailyReco(top.id);
    lastPicks = { top, alternatives };
    renderResult(top, alternatives);
    setStatus("Meta trovata ✔", "ok");
    return;
  }

  /* =========================
     AUTO / WALK / BIKE
  ========================= */
  setStatus("Cerco tra le mete…");

  let base = curated
    .filter(p => typeMatches(p.type, allowedTypes))
    .map(p => ({ ...p, ...estimateAutoLike(origin, p.lat, p.lng, mode) }));

  // max distanza coerente col tempo (evita lontanissimo)
  const speed = avgSpeedKmh(mode);
  const maxKmCoerenti = (speed * (minutes / 60)) * 1.35;

  // (1) filtro vicinanza
  let candidates = base.filter(p => p.distance_km <= Math.max(8, maxKmCoerenti));

  // (2) finestra tempo
  const minMin = Math.max(8, minutes * 0.22);
  const maxMin = minutes * 1.30;
  let windowed = candidates.filter(p => p.eta_min >= minMin && p.eta_min <= maxMin);

  // (3) fallback controllato per avere almeno 3 (top + 2 alt)
  if (windowed.length < 3) {
    const maxMin2 = minutes * 1.55;
    windowed = candidates.filter(p => p.eta_min >= 5 && p.eta_min <= maxMin2);
  }
  if (windowed.length < 3) {
    windowed = [...candidates].sort((a,b)=>a.eta_min - b.eta_min).slice(0, 60);
  }

  // score + filtri daily/visited
  windowed.forEach(p => p._score = autoScore(p, minutes, style, dailySet, visitedSet));
  let scored = windowed.filter(p => p._score > -100).sort((a,b)=>b._score - a._score);

  // fallback: rilassa daily se servono alternative
  if (scored.length < 3) {
    scored = windowed
      .filter(p => !visitedSet.has(p.id))
      .sort((a,b)=>a.eta_min - b.eta_min);
  }
  if (scored.length < 3) {
    scored = windowed.sort((a,b)=>a.eta_min - b.eta_min);
  }

  if (!scored.length) {
    const typesAvail = [...new Set(curated.map(p => p.type))].sort().join(", ");
    setStatus(
      "Non trovo mete con questi filtri.\n" +
      `• Categoria: ${allowedTypes.join("+")}\n` +
      `• Tipi disponibili nel JSON: ${typesAvail}\n` +
      "Prova ad aumentare il tempo o cambia categoria.\n" +
      "Tip: apri /?reset=1 se hai segnato troppe mete come visitate.",
      "err"
    );
    return;
  }

  const { top, alternatives } = pickTopAndAlts(scored, 2);

  // motivazioni (usa anche preset JSON)
  top.whyComputed = buildWhy(top, { mode, minutes, weatherLabel: lastWeatherLabel, style });

  addDailyReco(top.id);
  lastPicks = { top, alternatives };
  renderResult(top, alternatives);
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
