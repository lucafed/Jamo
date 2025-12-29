/* =========================
   JAMO — app.js (v8 FINAL)
   Obiettivi:
   - Categoria = SOLO type (mai tag)  ✅ niente "mare -> Milano"
   - 30/45 min: fallback vicino garantito (se esistono mete) ✅
   - "Chicche": preferisce borghi/natura/mare e penalizza grandi città ✅
   - Alternative: prova sempre a mostrarne 2 ✅
   - Plane/Train/Bus: filtri anti-stessa città, anti-troppo vicino, score sensato ✅
   - Mostra "Perché te lo consiglio" + "Cosa mangiare" se presenti ✅
   ========================= */

const API = {
  geocode: "/api/geocode",
  plan: "/api/plan",
  places: "/api/places" // opzionale (non usato ora)
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
const whyListEl   = $("whyList");     // ✅ nuovo
const eatListEl   = $("eatList");     // ✅ nuovo

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
    obj[key] = arr.slice(0, 300);
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
   Curated load
------------------------- */
async function loadCurated() {
  const r = await fetch(CURATED_URL, { cache: "no-store" });
  if (!r.ok) return [];
  const d = await r.json();
  const items = Array.isArray(d?.places) ? d.places : [];
  return items
    .map(x => ({
      id: x.id,
      name: x.name,
      country: x.country,
      type: norm(x.type),                 // ✅ type canonico
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
  if (mode === "walk") return 4.2;   // realistico
  if (mode === "bike") return 14;
  return 75; // car
}
function estimateAutoLike(origin, lat, lng, mode) {
  const d = haversineKm(origin.lat, origin.lon, lat, lng);
  // haversine sottostima strada: fattore 1.18
  const roadKm = d * 1.18;
  const eta = (roadKm / avgSpeedKmh(mode)) * 60;
  return { distance_km: roadKm, eta_min: eta };
}

/* -------------------------
   Categoria: mapping robusto
------------------------- */
function allowedTypesFromCategory(categoryRaw) {
  const c = norm(categoryRaw);

  // combo città/borghi
  if (c.includes("borgh") && c.includes("citt")) return ["citta","borgo"];
  if (c === "citta_borghi") return ["citta","borgo"];

  // singoli
  if (c === "citta" || c === "città" || c === "city") return ["citta"];
  if (c === "borgo" || c === "borghi") return ["borgo"];

  // altro
  return [c]; // mare, montagna, natura, relax, bambini...
}

/* ✅ MATCH STRICT: SOLO type (mai tags) */
function typeMatches(placeType, allowedTypes) {
  const t = norm(placeType);
  const parts = t.split("/").map(x => norm(x)).filter(Boolean);
  for (const p of parts) {
    if (allowedTypes.includes(p)) return true;
  }
  return false;
}

/* -------------------------
   "Chicche": penalizza metropoli
   (non abbiamo popolazione: usiamo euristiche su vibes/tags + nome molto noto)
------------------------- */
function isLikelyBigCity(p) {
  const name = normName(p.name);
  const big = ["roma","milano","napoli","torino","bologna","firenze","venezia","parigi","londra","barcellona","amsterdam"];
  if (big.includes(name)) return true;
  // se è type=citta e visibility=conosciuta e vibe "energia/city_break" -> più grande
  if (p.type === "citta" && p.visibility === "conosciuta") return true;
  return false;
}

/* -------------------------
   Scoring AUTO
------------------------- */
function styleFit(p, style) {
  if (style === "known") return (p.visibility === "conosciuta") ? 1.0 : 0.75;
  // gems
  const base = (p.visibility === "chicca") ? 1.0 : 0.78;
  const bigPenalty = isLikelyBigCity(p) ? 0.55 : 1.0; // ✅ no metropoli
  return base * bigPenalty;
}

// più vicino al target = meglio
function timeFit(etaMin, targetMin) {
  const diff = Math.abs(etaMin - targetMin);
  const denom = Math.max(18, targetMin * 0.85);
  return clamp(1 - (diff / denom), 0, 1);
}

// preferisce davvero vicino
function nearFit(etaMin, targetMin) {
  const r = etaMin / Math.max(10, targetMin);
  // se è molto più lontano del target, crolla
  return clamp(1.15 - r, 0, 1);
}

function autoScore(p, targetMin, style, dailySet, visitedSet) {
  if (visitedSet.has(p.id)) return -999;
  if (dailySet.has(p.id)) return -999;

  const sNear  = nearFit(p.eta_min, targetMin);
  const sTime  = timeFit(p.eta_min, targetMin);
  const sStyle = styleFit(p, style);

  // piccolo bonus a borgo/natura/mare se gems
  const gemsBonus = (style === "gems" && ["borgo","natura","mare","montagna","relax"].includes(p.type)) ? 0.08 : 0;

  return (0.52 * sNear) + (0.28 * sTime) + (0.20 * sStyle) + gemsBonus;
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
  try { return JSON.parse(text); }
  catch { throw new Error(`PLAN risposta non JSON: ${text.slice(0, 120)}`); }
}

/* -------------------------
   Render helpers
------------------------- */
function renderList(el, arr, emptyLabel) {
  if (!el) return;
  el.innerHTML = "";
  const list = Array.isArray(arr) ? arr.filter(Boolean) : [];
  if (!list.length) {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">${escapeHtml(emptyLabel)}</div>`;
    el.appendChild(div);
    return;
  }
  list.slice(0, 6).forEach((t) => {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">${escapeHtml(t)}</div>`;
    el.appendChild(div);
  });
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

  // Alternative
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
        setStatus("Ok, cambio meta 🎲", "ok");
      };
      altListEl.appendChild(div);
    });
  }

  // Perché / Cosa fare / Cosa mangiare
  renderList(whyListEl, top.why, "Ti va una gita facile e senza sbatti.");
  renderList(poiListEl, top.what_to_do, "Idee in arrivo…");
  renderList(eatListEl, top.what_to_eat, "Idee food in arrivo…");

  visitedBtn.onclick = () => {
    if (top.id) markVisited(top.id);
    setStatus("Segnato come già visitato ✅", "ok");
  };

  rerollBtn.onclick = () => {
    if (!lastPicks?.alternatives?.length) return;
    const next = lastPicks.alternatives[0];
    const rest = lastPicks.alternatives.slice(1);
    lastPicks = { top: next, alternatives: [top, ...rest].slice(0, 2) };
    renderResult(lastPicks.top, lastPicks.alternatives);
    setStatus("Ok, nuova proposta 🎲", "ok");
  };
}

/* -------------------------
   Helpers: pick top + ensure 2 alts
------------------------- */
function pickTopAndAlts(list, wantedAlts = 2) {
  const top = list[0];
  const alts = list.slice(1, 1 + wantedAlts);
  return { top, alternatives: alts };
}

function uniqueById(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    if (!x?.id) continue;
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    out.push(x);
  }
  return out;
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
        lat: dest.lat,
        lng: dest.lon,
        eta_min: Number(r.totalMinutes),
        distance_km: km,
        originHub: r.originHub,
        destinationHub: r.destinationHub,
        hubSummary: `${r.originHub?.code || r.originHub?.name} → ${r.destinationHub?.code || r.destinationHub?.name}`,
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

      // niente Verona->Verona / stesso posto
      if (Number.isFinite(c.distance_km) && c.distance_km < 35) return false;
      if (c._nameNorm && originLabelNorm && c._nameNorm === originLabelNorm) return false;

      // niente stesso hub
      const oh = c.originHub?.code || c.originHub?.name || "";
      const dh = c.destinationHub?.code || c.destinationHub?.name || "";
      if (norm(oh) && norm(dh) && norm(oh) === norm(dh)) return false;

      return true;
    });

    // score: coerenza tempo + non troppo lontano inutile
    const target = minutes;
    candidates.forEach(c => {
      const tScore = clamp(1 - (Math.abs(c.eta_min - target) / Math.max(25, target * 0.9)), 0, 1);
      const kScore = Number.isFinite(c.distance_km) ? clamp(1 - (c.distance_km / 1600), 0, 1) : 0.35;
      const tooShortPenalty = c.eta_min < Math.max(45, target * 0.35) ? 0.25 : 0;
      c._score = (0.62 * tScore) + (0.38 * kScore) - tooShortPenalty;
    });

    // filtra visited/daily con fallback
    let filtered = candidates.filter(c => !visitedSet.has(c.id) && !dailySet.has(c.id));
    if (filtered.length < 3) filtered = candidates.filter(c => !visitedSet.has(c.id));
    if (filtered.length < 3) filtered = candidates;

    filtered = uniqueById(filtered).sort((a,b)=>b._score - a._score);

    const { top, alternatives } = pickTopAndAlts(filtered, 2);
    if (!top) {
      setStatus("Non trovo mete valide (dataset troppo piccolo).", "err");
      return;
    }

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
  const curated = await loadCurated();

  // 1) categoria STRICT su type
  const base = curated
    .filter(p => typeMatches(p.type, allowedTypes))
    .map(p => ({ ...p, ...estimateAutoLike(origin, p.lat, p.lng, mode) }))
    .filter(p => Number.isFinite(p.eta_min) && Number.isFinite(p.distance_km));

  if (!base.length) {
    setStatus("Non ho mete in questa categoria nel tuo curated.json.", "err");
    return;
  }

  // 2) range massimo “coerente” col tempo (evita Roma sempre)
  const speed = avgSpeedKmh(mode);
  const maxKmCoerenti = (speed * (minutes / 60)) * 1.55; // più generoso ma coerente

  let candidates = base.filter(p => p.distance_km <= Math.max(6, maxKmCoerenti));

  // 3) finestra tempo “buona”
  const minMin = Math.max(6, minutes * 0.18);
  const maxMin = minutes * 1.25;
  let windowed = candidates.filter(p => p.eta_min >= minMin && p.eta_min <= maxMin);

  // 4) fallback progressivo per 30/45 min:
  //    se non c'è niente nella finestra, prendi i più vicini disponibili (ma coerenti col maxKmCoerenti)
  if (windowed.length < 3) {
    const maxMin2 = Math.max(minutes * 1.75, minutes + 40);
    windowed = candidates.filter(p => p.eta_min <= maxMin2).sort((a,b)=>a.eta_min - b.eta_min).slice(0, 60);
  }
  if (windowed.length < 3) {
    // ultima spiaggia: ignora maxKmCoerenti e prendi i più vicini in categoria
    windowed = [...base].sort((a,b)=>a.eta_min - b.eta_min).slice(0, 60);
  }

  // 5) scoring
  windowed.forEach(p => p._score = autoScore(p, minutes, style, dailySet, visitedSet));
  let scored = windowed.filter(p => p._score > -100).sort((a,b)=>b._score - a._score);

  // fallback se troppo “bloccato” da daily/visited
  if (scored.length < 3) {
    scored = windowed.filter(p => !visitedSet.has(p.id)).sort((a,b)=>a.eta_min - b.eta_min);
  }
  if (scored.length < 3) {
    scored = windowed.sort((a,b)=>a.eta_min - b.eta_min);
  }

  scored = uniqueById(scored);

  const { top, alternatives } = pickTopAndAlts(scored, 2);
  if (!top) {
    setStatus("Non trovo mete valide con questi filtri.", "err");
    return;
  }

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
