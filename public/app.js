/* =========================
   JAMO — app.js (v8 HARD-CAPS + HUBS + ROUTE)
   - Mode mapping: accetta values IT/EN (aereo/treno/bus/plane/train/bus)
   - Public transport: usa sempre /api/plan + mostra hub e segmenti
   - Auto/Walk/Bike: HARD CAP sul tempo (niente Parigi se 1h)
   - Categoria: niente fallback “mare -> città”
   - Alternative: prova sempre 2
   ========================= */

const API = {
  geocode: "/api/geocode",
  plan: "/api/plan"
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
const whyListEl   = $("whyList");
const routeListEl = $("routeList");
const poiListEl   = $("poiList");

const goBtn       = $("goBtn");
const gpsBtn      = $("gpsBtn");
const rerollBtn   = $("rerollBtn");
const visitedBtn  = $("visitedBtn");

const LS_VISITED_KEY = "jamo_visited_v1";
const LS_WEEK_KEY    = "jamo_week_picks_v1";

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
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }

/* -------------------------
   Normalize
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
   Mode mapping (IT/EN -> canonical)
------------------------- */
function canonicalMode(raw) {
  const m = norm(raw);
  if (["car","auto","macchina"].includes(m)) return "car";
  if (["walk","piedi","a piedi"].includes(m)) return "walk";
  if (["bike","bici","bicicletta"].includes(m)) return "bike";
  if (["plane","aereo","volo"].includes(m)) return "plane";
  if (["train","treno"].includes(m)) return "train";
  if (["bus","pullman"].includes(m)) return "bus";
  return "car";
}

/* -------------------------
   Weekly rotation + visited
------------------------- */
function isoWeekKey() {
  // YYYY-Www
  const d = new Date();
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1)/7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2,"0")}`;
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

function getWeekPickSet() {
  try {
    const raw = localStorage.getItem(LS_WEEK_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const key = isoWeekKey();
    const arr = Array.isArray(obj?.[key]) ? obj[key] : [];
    return new Set(arr);
  } catch { return new Set(); }
}
function addWeekPick(id) {
  try {
    const raw = localStorage.getItem(LS_WEEK_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const key = isoWeekKey();
    const arr = Array.isArray(obj?.[key]) ? obj[key] : [];
    if (!arr.includes(id)) arr.push(id);
    obj[key] = arr.slice(0, 300);
    localStorage.setItem(LS_WEEK_KEY, JSON.stringify(obj));
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
      localStorage.removeItem(LS_WEEK_KEY);
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
   Categoria robusta
------------------------- */
function allowedTypesFromCategory(categoryRaw) {
  const c = norm(categoryRaw);
  if (c.includes("borgh") && c.includes("citt")) return ["citta","borgo"];
  if (c === "citta_borghi") return ["citta","borgo"];
  if (c === "citta" || c === "citta " || c === "città") return ["citta"];
  if (c === "borgo" || c === "borghi") return ["borgo"];
  return [c]; // mare, montagna, natura, relax, bambini
}
function typeMatches(placeType, allowedTypes) {
  const t = norm(placeType);
  return allowedTypes.includes(t);
}

/* -------------------------
   /api/plan call (robusto)
------------------------- */
async function fetchPlan({ origin, maxMinutes, mode }) {
  const r = await fetch(API.plan, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ origin, maxMinutes, mode, limit: 25 })
  });

  const text = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`PLAN error ${r.status}: ${text.slice(0, 160)}`);

  try { return JSON.parse(text); }
  catch { throw new Error(`PLAN risposta non JSON: ${text.slice(0, 120)}`); }
}

/* -------------------------
   Render helpers
------------------------- */
function renderWhy(place) {
  if (!whyListEl) return;
  whyListEl.innerHTML = "";

  const arr = Array.isArray(place.why) ? place.why : [];
  const fallback = [];

  // fallback “smart” se non c’è why (es. plan results)
  if (!arr.length) {
    if (Number.isFinite(place.eta_min)) {
      fallback.push(`Ci arrivi in ~${Math.round(place.eta_min)} min, quindi è coerente col tempo che hai scelto.`);
    }
    if (place.type) fallback.push(`È una meta tipo “${place.type}”, perfetta se volevi proprio quella categoria.`);
    if (place.visibility) fallback.push(`Stile: ${place.visibility === "chicca" ? "chicca" : "più conosciuta"} (come da filtro).`);
  }

  const list = arr.length ? arr : fallback;
  list.slice(0, 4).forEach((t) => {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">${escapeHtml(t)}</div>`;
    whyListEl.appendChild(div);
  });
}

function renderRoute(place) {
  if (!routeListEl) return;
  routeListEl.innerHTML = "";

  if (!Array.isArray(place.segments) || !place.segments.length) {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">—</div><div class="small">Nessun dettaglio percorso disponibile.</div>`;
    routeListEl.appendChild(div);
    return;
  }

  place.segments.slice(0, 6).forEach((s) => {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `
      <div class="name">${escapeHtml(s.label || s.kind || "Step")}</div>
      <div class="small">${Number.isFinite(s.minutes) ? `${s.minutes} min` : ""}</div>
    `;
    routeListEl.appendChild(div);
  });
}

function renderPOI(place) {
  if (!poiListEl) return;
  poiListEl.innerHTML = "";

  const todo = Array.isArray(place.what_to_do) ? place.what_to_do : [];
  const eat  = Array.isArray(place.what_to_eat) ? place.what_to_eat : [];

  if (todo.length) {
    const title = document.createElement("div");
    title.className = "sectionTitle";
    title.textContent = "Cosa vedere / fare";
    poiListEl.appendChild(title);

    todo.slice(0, 6).forEach((t) => {
      const div = document.createElement("div");
      div.className = "alt-item";
      div.innerHTML = `<div class="name">${escapeHtml(t)}</div>`;
      poiListEl.appendChild(div);
    });
  }

  if (eat.length) {
    const title2 = document.createElement("div");
    title2.className = "sectionTitle";
    title2.textContent = "Cosa mangiare";
    poiListEl.appendChild(title2);

    eat.slice(0, 6).forEach((t) => {
      const div = document.createElement("div");
      div.className = "alt-item";
      div.innerHTML = `<div class="name">${escapeHtml(t)}</div>`;
      poiListEl.appendChild(div);
    });
  }

  if (!todo.length && !eat.length) {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">Consigli in arrivo…</div><div class="small">Aggiungeremo cosa fare/mangiare anche alle mete “ovunque”.</div>`;
    poiListEl.appendChild(div);
  }
}

function renderAlternatives(top, alternatives) {
  if (!altListEl) return;
  altListEl.innerHTML = "";

  if (!alternatives.length) {
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `<div class="name">Nessuna alternativa</div><div class="small">Prova “Cambia meta” o aumenta il tempo.</div>`;
    altListEl.appendChild(div);
    return;
  }

  alternatives.slice(0, 2).forEach((a) => {
    const div = document.createElement("div");
    div.className = "alt-item clickable";
    const eta = Number.isFinite(a.eta_min) ? `${Math.round(a.eta_min)} min` : "";
    const km  = Number.isFinite(a.distance_km) ? `${Math.round(a.distance_km)} km` : "";
    const extra = a.hubSummary ? ` · ${escapeHtml(a.hubSummary)}` : "";
    div.innerHTML = `
      <div class="name">${escapeHtml(a.name)}</div>
      <div class="small">${[eta, km].filter(Boolean).join(" · ")}${extra}</div>
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

function renderResult(top, alternatives) {
  showResultBox(true);

  placeNameEl.textContent = top.name;

  const eta = Number.isFinite(top.eta_min) ? `${Math.round(top.eta_min)} min` : "";
  const km  = Number.isFinite(top.distance_km) ? `${Math.round(top.distance_km)} km` : "";
  const w   = lastWeatherLabel ? ` · meteo: ${lastWeatherLabel}` : "";
  const extra = top.hubSummary ? ` · ${top.hubSummary}` : "";

  // mostra anche il tipo se presente
  const typeLabel = top.type ? `${top.type}` : "";
  const left = [typeLabel, eta, km].filter(Boolean).join(" · ");

  placeMetaEl.textContent = left + w + extra;
  mapsLinkEl.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(top.name)}`;

  renderAlternatives(top, alternatives);
  renderWhy(top);
  renderRoute(top);
  renderPOI(top);

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
      setStatus("Ok, nuova proposta 🎲", "ok");
    };
  }
}

function pickTopAndAlts(list) {
  const top = list[0] || null;
  const alternatives = list.slice(1, 3);
  return { top, alternatives };
}

/* -------------------------
   MAIN
------------------------- */
async function run() {
  showResultBox(false);

  const minutes   = Number($("timeSelect")?.value || 60);
  const mode      = canonicalMode($("modeSelect")?.value || "car");
  const style     = norm($("styleSelect")?.value || "known"); // known | gems
  const allowedTypes = allowedTypesFromCategory($("categorySelect")?.value || "citta_borghi");

  const visitedSet = getVisitedSet();
  const weekSet    = getWeekPickSet();

  setStatus("Calcolo la meta migliore…");
  const origin = await getOrigin();

  const weather = await getWeather(origin.lat, origin.lon);
  lastWeatherLabel = weather.label || "";

  /* ========= PUBLIC TRANSPORT ========= */
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

    // candidates con filtri anti “stessa città / stesso hub / troppo vicino”
    let candidates = results.map((r) => {
      const dest = r.destination || {};
      const id = dest.id || `${dest.name || "dest"}_${dest.country || ""}`.toLowerCase().replace(/[^a-z0-9]+/g,"_");

      const km = (Number.isFinite(dest.lat) && Number.isFinite(dest.lon))
        ? haversineKm(origin.lat, origin.lon, Number(dest.lat), Number(dest.lon))
        : null;

      const nameFull = `${dest.name || "Meta"}${dest.country ? `, ${dest.country}` : ""}`;
      const nameNorm = normName(dest.name || "");

      const oh = r.originHub?.code || r.originHub?.name || "";
      const dh = r.destinationHub?.code || r.destinationHub?.name || "";

      return {
        id,
        name: nameFull,
        type: "trasporto",
        visibility: style === "gems" ? "chicca" : "conosciuta",
        lat: dest.lat,
        lng: dest.lon,
        eta_min: Number(r.totalMinutes),
        distance_km: km,
        hubSummary: `${oh} → ${dh}`,
        segments: Array.isArray(r.segments) ? r.segments : [],
        why: [
          `È una meta raggiungibile entro il tempo scelto (${minutes} min).`,
          `Hai alternative pronte se non ti convince.`,
          style === "gems" ? "Sto privilegiando mete più “da chicca” (meno mainstream)." : "Sto privilegiando mete più conosciute e “sicure”."
        ]
      };
    });

    candidates = candidates.filter(c => {
      if (!Number.isFinite(c.eta_min)) return false;
      // anti “sei già lì”
      if (Number.isFinite(c.distance_km) && c.distance_km < 35) return false;
      if (c._nameNorm && originLabelNorm && c._nameNorm === originLabelNorm) return false;

      // anti “stesso hub”
      const [oh, dh] = (c.hubSummary || "").split("→").map(s => norm(s));
      if (oh && dh && oh === dh) return false;

      // visited / week
      if (visitedSet.has(c.id)) return false;
      if (weekSet.has(c.id)) return false;

      return true;
    });

    // se hai filtrato troppo, rilassa week (ma non visited)
    if (candidates.length < 3) {
      candidates = results.map((r) => {
        const dest = r.destination || {};
        const id = dest.id || `${dest.name || "dest"}_${dest.country || ""}`.toLowerCase().replace(/[^a-z0-9]+/g,"_");
        const oh = r.originHub?.code || r.originHub?.name || "";
        const dh = r.destinationHub?.code || r.destinationHub?.name || "";
        const km = (Number.isFinite(dest.lat) && Number.isFinite(dest.lon))
          ? haversineKm(origin.lat, origin.lon, Number(dest.lat), Number(dest.lon))
          : null;

        return {
          id,
          name: `${dest.name || "Meta"}${dest.country ? `, ${dest.country}` : ""}`,
          type: "trasporto",
          visibility: style === "gems" ? "chicca" : "conosciuta",
          lat: dest.lat,
          lng: dest.lon,
          eta_min: Number(r.totalMinutes),
          distance_km: km,
          hubSummary: `${oh} → ${dh}`,
          segments: Array.isArray(r.segments) ? r.segments : [],
          why: [
            `È una meta raggiungibile entro il tempo scelto (${minutes} min).`
          ]
        };
      }).filter(c => !visitedSet.has(c.id));
    }

    // scoring: vicino al target + non troppo lontano
    candidates.forEach(c => {
      const tScore = clamp(1 - (Math.abs(c.eta_min - minutes) / Math.max(20, minutes * 0.9)), 0, 1);
      const kScore = Number.isFinite(c.distance_km) ? clamp(1 - (c.distance_km / 1800), 0, 1) : 0.4;
      c._score = (0.65 * tScore) + (0.35 * kScore);
    });
    candidates.sort((a,b)=>b._score - a._score);

    const { top, alternatives } = pickTopAndAlts(candidates);
    if (!top) {
      setStatus("Non trovo mete valide (dataset troppo corto o filtri troppo stretti).", "err");
      return;
    }

    addWeekPick(top.id);
    lastPicks = { top, alternatives };
    renderResult(top, alternatives);
    setStatus("Meta trovata ✔", "ok");
    return;
  }

  /* ========= AUTO / WALK / BIKE ========= */
  setStatus("Cerco tra le mete curate…");
  const curated = await loadCurated();

  const base = curated
    .filter(p => typeMatches(p.type, allowedTypes))
    .map(p => ({ ...p, ...estimateAutoLike(origin, p.lat, p.lng, mode) }));

  // HARD CAPS (mai mostrare oltre tempo scelto in modo assurdo)
  const hardCapMin = minutes * 1.35; // auto: max 35% oltre
  const speed = avgSpeedKmh(mode);
  const hardCapKm = (speed * (minutes/60)) * 1.6; // la linea d’aria sottostima, quindi 1.6

  let candidates = base.filter(p => p.eta_min <= hardCapMin && p.distance_km <= hardCapKm);

  // filtra visited + week
  candidates = candidates.filter(p => !visitedSet.has(p.id) && !weekSet.has(p.id));

  // se chicche: penalizza le metropoli (citta conosciute)
  candidates.forEach(p => {
    const bigCityPenalty = (style === "gems" && p.type === "citta" && p.visibility === "conosciuta") ? 0.25 : 0;
    const timeScore = clamp(1 - (Math.abs(p.eta_min - minutes) / Math.max(20, minutes * 0.9)), 0, 1);
    const nearScore = clamp(1 - (p.eta_min / hardCapMin), 0, 1);
    const visScore = (style === "gems")
      ? (p.visibility === "chicca" ? 1 : 0.75)
      : (p.visibility === "conosciuta" ? 1 : 0.80);

    p._score = (0.50 * nearScore) + (0.30 * timeScore) + (0.20 * visScore) - bigCityPenalty;
  });

  candidates.sort((a,b)=>b._score - a._score);

  if (!candidates.length) {
    setStatus(
      "Non ho mete curate abbastanza VICINE per questi filtri.\n" +
      `• Tempo: ${minutes} min\n` +
      `• Categoria: ${allowedTypes.join("+")}\n\n` +
      "Soluzioni:\n" +
      "1) Aumenta il tempo (es. 2–3 ore)\n" +
      "2) Oppure attiviamo il fallback “ovunque” (Overpass/OSM) così trova mete anche a 30–45 min in qualunque città EU/UK.",
      "err"
    );
    return;
  }

  const { top, alternatives } = pickTopAndAlts(candidates);

  addWeekPick(top.id);
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
