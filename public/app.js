/* Jamo — app.js v10 (OFFLINE-FIRST + LIVE FALLBACK, COERENTE)
 * Fix principali:
 * - widen minuti: MAI oltre +70% (niente salto a 240)
 * - family: STRICT sempre (no spa/terme se non hai scelto relax)
 * - borghi: accetta "borgo" e "borghi" + tag "borgo"
 * - montagna: richiede segnali veri (peak/viewpoint/rifugio/sci/aerialway), niente nomi ingannevoli
 * - LIVE: rispetta meta.usedCat del server
 */

const $ = (id) => document.getElementById(id);

// -------------------- DATA SOURCES --------------------
const REGIONS = [
  { id: "it-abruzzo", name: "Abruzzo", country: "IT", indexUrl: "/data/pois/it/it-abruzzo/index.json" },
];

const MACROS_INDEX_URL = "/data/macros/macros_index.json";
const FALLBACK_MACRO_URLS = [
  "/data/macros/euuk_macro_all.json",
  "/data/macros/euuk_country_it.json",
];

// -------------------- ROUTING / ESTIMATOR --------------------
const ROAD_FACTOR = 1.25;
const AVG_KMH = 72;
const FIXED_OVERHEAD_MIN = 8;

// -------------------- ROTATION --------------------
const RECENT_TTL_MS = 1000 * 60 * 60 * 20;
const RECENT_MAX = 160;
let SESSION_SEEN = new Set();
let LAST_SHOWN_PID = null;

// -------------------- GLOBAL SEARCH CONTROL (anti-race) --------------------
let SEARCH_TOKEN = 0;
let SEARCH_ABORT = null;

// -------------------- UTIL --------------------
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function toRad(x) { return (x * Math.PI) / 180; }

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function safeIdFromPlace(p) {
  if (p?.id) return String(p.id);
  const nm = normName(p?.name);
  const lat = String(p?.lat ?? "").slice(0, 8);
  const lon = String(p?.lon ?? p?.lng ?? "").slice(0, 8);
  return `p_${nm || "x"}_${lat}_${lon}`;
}

function estCarMinutesFromKm(km) {
  const roadKm = km * ROAD_FACTOR;
  const driveMin = (roadKm / AVG_KMH) * 60;
  return Math.round(clamp(driveMin + FIXED_OVERHEAD_MIN, 6, 900));
}

function fmtKm(km) { return `${Math.round(km)} km`; }
function isWinterNow() {
  const m = new Date().getMonth() + 1;
  return (m === 11 || m === 12 || m === 1 || m === 2 || m === 3);
}

// -------------------- MAP STATIC IMAGES --------------------
function osmStaticImgPrimary(lat, lon, z = 12) {
  const size = "720x360";
  const marker = `${lat},${lon},lightblue1`;
  return `https://staticmap.openstreetmap.de/staticmap.php?center=${encodeURIComponent(lat + "," + lon)}&zoom=${encodeURIComponent(z)}&size=${encodeURIComponent(size)}&maptype=mapnik&markers=${encodeURIComponent(marker)}`;
}
function osmStaticImgFallback(lat, lon, z = 12) {
  const size = "720x360";
  const marker = `color:blue|${lat},${lon}`;
  return `https://staticmap.openstreetmap.fr/osmfr/staticmap.php?center=${encodeURIComponent(lat + "," + lon)}&zoom=${encodeURIComponent(z)}&size=${encodeURIComponent(size)}&markers=${encodeURIComponent(marker)}`;
}

// -------------------- LINKS --------------------
function mapsPlaceUrl(lat, lon) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lon)}`;
}
function mapsDirUrl(oLat, oLon, dLat, dLon) {
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(oLat + "," + oLon)}&destination=${encodeURIComponent(dLat + "," + dLon)}&travelmode=driving`;
}
function gmapsQueryUrl(q) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}
function googleImagesUrl(q) {
  return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`;
}
function googleThingsToDoUrl(q) {
  return `https://www.google.com/search?q=${encodeURIComponent("cosa vedere " + q)}`;
}
function googleDoUrl(q) {
  return `https://www.google.com/search?q=${encodeURIComponent("cosa fare " + q)}`;
}
function wikiUrl(title) {
  return `https://it.wikipedia.org/w/index.php?search=${encodeURIComponent(title)}`;
}
function restaurantsUrl(q) {
  return gmapsQueryUrl(`${q} ristoranti`);
}
function eventsUrl(q) {
  return `https://www.google.com/search?q=${encodeURIComponent("eventi " + q)}`;
}

// -------------------- STORAGE --------------------
function setOrigin({ label, lat, lon }) {
  if ($("originLabel")) $("originLabel").value = label ?? "";
  if ($("originLat")) $("originLat").value = String(lat);
  if ($("originLon")) $("originLon").value = String(lon);
  localStorage.setItem("jamo_origin", JSON.stringify({ label, lat, lon }));
  if ($("originStatus")) {
    $("originStatus").textContent =
      `✅ Partenza: ${label || "posizione"} (${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)})`;
  }
}

function getOrigin() {
  const lat = Number($("originLat")?.value);
  const lon = Number($("originLon")?.value);
  const label = ($("originLabel")?.value || "").trim();
  if (Number.isFinite(lat) && Number.isFinite(lon)) return { label, lat, lon };

  const raw = localStorage.getItem("jamo_origin");
  if (raw) { try { return JSON.parse(raw); } catch {} }
  return null;
}

function getVisitedSet() {
  const raw = localStorage.getItem("jamo_visited");
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
function saveVisitedSet(set) {
  localStorage.setItem("jamo_visited", JSON.stringify([...set]));
}
function markVisited(placeId) {
  const s = getVisitedSet();
  s.add(placeId);
  saveVisitedSet(s);
}
function resetVisited() {
  localStorage.removeItem("jamo_visited");
}

function loadRecent() {
  const raw = localStorage.getItem("jamo_recent");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function saveRecent(list) {
  localStorage.setItem("jamo_recent", JSON.stringify(list.slice(0, RECENT_MAX)));
}
function cleanupRecent(list) {
  const t = Date.now();
  return list.filter(x => x && x.pid && (t - (x.ts || 0) <= RECENT_TTL_MS));
}
function addRecent(pid) {
  const t = Date.now();
  let list = cleanupRecent(loadRecent());
  list.unshift({ pid, ts: t });
  const seen = new Set();
  list = list.filter(x => (seen.has(x.pid) ? false : (seen.add(x.pid), true)));
  saveRecent(list);
}
function getRecentSet() {
  const list = cleanupRecent(loadRecent());
  saveRecent(list);
  return new Set(list.map(x => x.pid));
}
function resetRotation() {
  localStorage.removeItem("jamo_recent");
  SESSION_SEEN = new Set();
  LAST_SHOWN_PID = null;
}

// -------------------- UI --------------------
function initChips(containerId, { multi = false } = {}) {
  const el = $(containerId);
  if (!el) return;

  el.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;

    if (!multi) {
      [...el.querySelectorAll(".chip")].forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
    } else {
      chip.classList.toggle("active");
    }

    if (containerId === "timeChips") {
      const v = Number(chip.dataset.min);
      if (Number.isFinite(v) && $("maxMinutes")) $("maxMinutes").value = String(v);
    }
  });
}

function getActiveCategory() {
  const el = $("categoryChips");
  const active = el?.querySelector(".chip.active");
  return active?.dataset.cat || "ovunque";
}

function getActiveStyles() {
  const el = $("styleChips");
  const actives = [...(el?.querySelectorAll(".chip.active") || [])].map(c => c.dataset.style);
  const wantChicche = actives.includes("chicche");
  const wantClassici = actives.includes("classici");
  // Se entrambi attivi o nessuno attivo -> consideriamo "tutte"
  if ((!wantChicche && !wantClassici) || (wantChicche && wantClassici)) {
    return { wantChicche: true, wantClassici: true };
  }
  return { wantChicche, wantClassici };
}

function showStatus(type, text) {
  const box = $("statusBox");
  const t = $("statusText");
  if (!box || !t) return;

  box.classList.remove("okbox", "warnbox", "errbox");
  if (type === "ok") box.classList.add("okbox");
  else if (type === "err") box.classList.add("errbox");
  else box.classList.add("warnbox");

  t.textContent = text;
  box.style.display = "block";
}

function hideStatus() {
  const box = $("statusBox");
  const t = $("statusText");
  if (!box || !t) return;
  box.style.display = "none";
  t.textContent = "";
}

function showResultProgress(msg = "Cerco nel dataset offline, rispettando categoria e tempo.") {
  const area = $("resultArea");
  if (!area) return;
  area.innerHTML = `
    <div class="card warnbox">
      <div style="font-weight:900; font-size:18px;">🔎 Sto cercando…</div>
      <div class="small muted" style="margin-top:8px; line-height:1.4;">${msg}</div>
    </div>
  `;
}

// -------------------- FETCH JSON --------------------
async function fetchJson(url, { signal } = {}) {
  const r = await fetch(url, { cache: "no-store", signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

// -------------------- DATASET LOADING --------------------
let DATASET = { kind: null, source: null, places: [], meta: {} };

function originInRegionBBox(origin, regionJson) {
  const lat = Number(origin?.lat);
  const lon = Number(origin?.lon);
  const b = regionJson?.bbox;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (!Array.isArray(b) || b.length !== 4) return false;
  const [minLon, minLat, maxLon, maxLat] = b;
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

async function tryLoadPoisRegion(regionId, { signal } = {}) {
  const region = REGIONS.find(r => r.id === regionId);
  if (!region) return null;

  const idx = await fetchJson(region.indexUrl, { signal });
  const basePath = String(idx?.basePath || "").trim() || `/data/pois/it/${regionId}`;
  const files = idx?.files && typeof idx.files === "object" ? idx.files : null;
  const cats = Array.isArray(idx?.categories) ? idx.categories : (files ? Object.keys(files) : []);

  if (!cats.length || !files) return null;

  const all = [];
  for (const cat of cats) {
    const file = files[cat];
    if (!file) continue;
    const url = file.startsWith("http") || file.startsWith("/") ? file : `${basePath}/${file}`;
    const j = await fetchJson(url, { signal });
    const places = Array.isArray(j?.places) ? j.places : Array.isArray(j) ? j : [];
    for (const p of places) {
      if (!p) continue;
      if (!p.type && cat) p.type = cat;
      all.push(p);
    }
  }

  if (!all.length) return null;

  return {
    kind: "pois",
    source: region.indexUrl,
    places: all,
    meta: { regionId, index: idx, count: all.length },
  };
}

// ---- MACRO fallback ----
let MACROS_INDEX = null;
let MACRO = null;
let MACRO_SOURCE_URL = null;

async function loadMacrosIndexSafe(signal) {
  try {
    MACROS_INDEX = await fetchJson(MACROS_INDEX_URL, { signal });
    return MACROS_INDEX;
  } catch {
    MACROS_INDEX = null;
    return null;
  }
}
async function tryLoadMacro(url, signal) {
  const r = await fetch(url, { cache: "no-store", signal });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j?.places || !Array.isArray(j.places) || j.places.length === 0) return null;
  return j;
}
function inferScopeFromCountryCode(cc) {
  const s = String(cc || "").toUpperCase();
  if (s === "IT") return "IT";
  if (!s) return "EUUK";
  return "EUUK";
}

async function loadBestMacroForOrigin(origin, signal) {
  const saved = localStorage.getItem("jamo_macro_url");
  if (saved) {
    const m = await tryLoadMacro(saved, signal);
    if (m) { MACRO = m; MACRO_SOURCE_URL = saved; return m; }
  }

  await loadMacrosIndexSafe(signal);

  const cc = String(origin?.country_code || "").toUpperCase();
  const pref = inferScopeFromCountryCode(cc);

  const candidates = [];
  if (MACROS_INDEX?.items?.length) {
    // 1) country dataset if exists
    if (cc) {
      const byCc = MACROS_INDEX.items.find(x => String(x.country || "").toUpperCase() === cc && String(x.scope) === "country");
      if (byCc?.path) candidates.push(byCc.path);
    }
    // 2) EUUK all
    const euukAll = MACROS_INDEX.items.find(x => x.id === "euuk_macro_all" || String(x.path || "").includes("euuk_macro_all.json"));
    if (euukAll?.path) candidates.push(euukAll.path);

    // 3) IT country fallback
    if (pref === "IT") {
      const itCountry = MACROS_INDEX.items.find(x =>
        x.id === "euuk_country_it" || (String(x.scope) === "country" && String(x.country).toUpperCase() === "IT")
      );
      if (itCountry?.path) candidates.unshift(itCountry.path);
    }
  }

  for (const u of FALLBACK_MACRO_URLS) candidates.push(u);

  for (const url of candidates) {
    const m = await tryLoadMacro(url, signal);
    if (m) {
      MACRO = m;
      MACRO_SOURCE_URL = url;
      localStorage.setItem("jamo_macro_url", url);
      return m;
    }
  }
  throw new Error("Macro non trovato: nessun dataset valido disponibile.");
}

async function ensureDatasetLoaded(origin, { signal } = {}) {
  if (DATASET?.places?.length) return DATASET;

  // 1) POIs regionali se GPS dentro bbox
  try {
    for (const r of REGIONS) {
      let regionJson = null;
      try { regionJson = await fetchJson(`/data/regions/${r.id}.json`, { signal }); } catch {}
      const labelHit = normName(origin?.label || "").includes(normName(r.name));
      if ((regionJson && originInRegionBBox(origin, regionJson)) || labelHit) {
        const d = await tryLoadPoisRegion(r.id, { signal });
        if (d) { DATASET = d; return d; }
      }
    }
  } catch {}

  // 2) macro
  const m = await loadBestMacroForOrigin(origin, signal);
  DATASET = {
    kind: "macro",
    source: MACRO_SOURCE_URL || "macro",
    places: Array.isArray(m?.places) ? m.places : [],
    meta: {},
  };
  return DATASET;
}

// -------------------- GEOCODING --------------------
async function geocodeLabel(label) {
  const q = String(label || "").trim();
  if (!q) throw new Error("Scrivi un luogo (es: L'Aquila, Roma, Londra...)");
  const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { method: "GET", cache: "no-store" });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error("Geocoding fallito (risposta vuota)");
  if (!j.ok) throw new Error(j.error || "Geocoding fallito");
  if (!j.result || !Number.isFinite(Number(j.result.lat)) || !Number.isFinite(Number(j.result.lon))) {
    throw new Error("Geocoding fallito (coordinate non valide)");
  }
  return j.result;
}

// -------------------- TAGS / CATEGORY --------------------
function placeTags(place) {
  return (place.tags || []).map(t => String(t).toLowerCase());
}
function hasTag(place, x) {
  const tags = placeTags(place);
  return tags.includes(String(x).toLowerCase());
}

function looksIndoor(place) {
  const tags = placeTags(place).join(" ");
  const n = normName(place?.name);
  return tags.includes("indoor") || tags.includes("coperto") || n.includes("indoor") || n.includes("coperto");
}
function isWaterPark(place) {
  const tags = placeTags(place).join(" ");
  const n = normName(place?.name);
  return tags.includes("water_park") || n.includes("acquapark") || n.includes("water park") || n.includes("aqua park");
}
function isSpaPlace(place) {
  const n = normName(place?.name);
  const tags = placeTags(place).join(" ");
  const t = String(place?.type || "").toLowerCase();
  return t === "relax" || tags.includes("spa") || tags.includes("terme") || tags.includes("hot_spring") || n.includes("terme") || n.includes("spa");
}

function isFamilyAttraction(place) {
  const tags = placeTags(place).join(" ");
  const n = normName(place?.name);
  const t = String(place?.type || "").toLowerCase();

  if (tags.includes("theme_park") || tags.includes("zoo") || tags.includes("aquarium") || tags.includes("water_park")) return true;
  if (t === "family" || t.includes("theme") || t.includes("amusement") || t.includes("zoo") || t.includes("aquarium") || t.includes("water")) return true;

  return (
    n.includes("parco divertimenti") ||
    n.includes("luna park") ||
    n.includes("lunapark") ||
    n.includes("zoo") ||
    n.includes("acquario") ||
    n.includes("parco avventura") ||
    n.includes("safari") ||
    n.includes("funivia")
  );
}

function isFamilySecondary(place) {
  const tags = placeTags(place).join(" ");
  const n = normName(place?.name);
  return tags.includes("playground") || tags.includes("kids") || n.includes("parco giochi") || n.includes("area giochi");
}

// ✅ montagna: segnali veri, NON nome
function isMountainPlace(place) {
  const tags = placeTags(place).join(" ");
  const n = normName(place?.name);
  return (
    tags.includes("natural=peak") ||
    tags.includes("tourism=viewpoint") ||
    tags.includes("aerialway") ||
    tags.includes("ski") ||
    n.includes("rifugio") ||
    n.includes("cima") ||
    n.includes("passo ") || // attenzione: passo montano vero (non “passetto” città)
    n.includes("funivia")
  );
}

function matchesCategory(place, cat) {
  if (!cat || cat === "ovunque") return true;

  const type = String(place?.type || "").toLowerCase();
  const n = normName(place?.name);
  const tags = placeTags(place);

  // macro tags spesso sono "citta" / "borgo" (non place=town)
  const isCityLike = type === "citta" || tags.includes("citta") || tags.includes("city") || tags.includes("conosciuta") && tags.includes("citta") || tags.includes("place=city") || tags.includes("place=town");
  const isBorgoLike = type === "borgo" || type === "borghi" || tags.includes("borgo") || n.includes("borgo") || tags.includes("place=village") || tags.includes("place=hamlet");

  if (cat === "citta") return isCityLike;
  if (cat === "borghi") return isBorgoLike && !isCityLike;

  if (cat === "mare") return type === "mare" || tags.includes("mare") || tags.includes("natural=beach") || n.includes("spiaggia") || n.includes("lido");
  if (cat === "natura") return type === "natura" || tags.includes("natura") || tags.includes("nature_reserve") || tags.includes("boundary=national_park") || n.includes("cascata") || n.includes("lago") || n.includes("riserva");
  if (cat === "storia") return type === "storia" || tags.some(x => x.startsWith("historic=")) || tags.includes("tourism=museum") || n.includes("castello") || n.includes("museo") || n.includes("rocca");
  if (cat === "relax") return isSpaPlace(place);

  if (cat === "montagna") return type === "montagna" || isMountainPlace(place);

  if (cat === "family") {
    // ✅ family STRICT: NO spa se non stai in relax
    if (isFamilyAttraction(place) || isFamilySecondary(place)) return true;
    return false;
  }

  return true;
}

function matchesStyle(place, { wantChicche, wantClassici }) {
  const vis = String(place?.visibility || "").toLowerCase();
  if (wantChicche && vis === "chicca") return true;
  if (wantClassici && vis !== "chicca") return true; // conosciuta/classica
  return false;
}

// -------------------- SCORING --------------------
function baseScorePlace({ driveMin, targetMin, beautyScore, isChicca }) {
  const t = clamp(1 - Math.abs(driveMin - targetMin) / Math.max(25, targetMin * 0.9), 0, 1);
  const b = clamp(Number(beautyScore) || 0.70, 0.35, 1);
  const c = isChicca ? 0.07 : 0;
  return 0.62 * t + 0.33 * b + c;
}

function rotationPenalty(pid, recentSet) {
  let pen = 0;
  if (pid && pid === LAST_SHOWN_PID) pen += 0.22;
  if (SESSION_SEEN.has(pid)) pen += 0.18;
  if (recentSet.has(pid)) pen += 0.10;
  return pen;
}

// -------------------- ✅ TIME WIDEN (FIXED) --------------------
function widenMinutesSteps(m, category) {
  const base = clamp(Number(m) || 120, 10, 600);

  // IMPORTANT: per 30/60 non vogliamo mai finire a 240.
  // massimo: +70% (30 -> 51), +60% (60 -> 96), ecc.
  const max = clamp(Math.round(base * (category === "family" ? 1.7 : 1.6)), base, 180);

  const steps = [base];
  const muls =
    category === "family" ? [1.25, 1.45, 1.70] :
    category === "mare" ?   [1.20, 1.40, 1.60] :
    category === "storia" ? [1.20, 1.40, 1.60] :
                            [1.20, 1.40, 1.60];

  for (const k of muls) steps.push(clamp(Math.round(base * k), base, max));
  steps.push(max);

  return Array.from(new Set(steps)).sort((a,b)=>a-b);
}

// -------------------- CANDIDATES / PICK --------------------
function buildCandidatesFromPool(pool, origin, maxMinutes, category, styles, { ignoreVisited=false, ignoreRotation=false } = {}) {
  const visited = getVisitedSet();
  const recentSet = getRecentSet();
  const target = Number(maxMinutes);

  const oLat = Number(origin.lat);
  const oLon = Number(origin.lon);

  const candidates = [];

  for (const p of pool) {
    if (!p) continue;

    const nm = String(p.name || "").trim();
    if (!nm || nm.length < 2 || normName(nm) === "meta") continue;

    const lat = Number(p.lat);
    const lon = Number(p.lon ?? p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    if (!matchesCategory(p, category)) continue;
    if (!matchesStyle(p, styles)) continue;

    const pid = safeIdFromPlace(p);
    if (!ignoreVisited && visited.has(pid)) continue;

    const km = haversineKm(oLat, oLon, lat, lon);
    const driveMin = estCarMinutesFromKm(km);

    if (driveMin > target) continue;
    if (km < (category === "family" ? 0.8 : 1.2)) continue;

    const isChicca = String(p.visibility || "").toLowerCase() === "chicca";

    let s = baseScorePlace({
      driveMin,
      targetMin: target,
      beautyScore: p.beauty_score,
      isChicca
    });

    // family: bonus vero
    if (category === "family") {
      if (isFamilyAttraction(p)) s += 0.22;
      else if (isFamilySecondary(p)) s += 0.10;
    }

    if (!ignoreRotation) s -= rotationPenalty(pid, recentSet);

    candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
  }

  candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
  return candidates;
}

function pickBest(pool, origin, minutes, category, styles) {
  let c = buildCandidatesFromPool(pool, origin, minutes, category, styles, { ignoreVisited:false, ignoreRotation:false });
  if (!c.length) c = buildCandidatesFromPool(pool, origin, minutes, category, styles, { ignoreVisited:false, ignoreRotation:true });
  if (!c.length) c = buildCandidatesFromPool(pool, origin, minutes, category, styles, { ignoreVisited:true, ignoreRotation:true });
  return { chosen: c[0] || null, alternatives: c.slice(1, 3) };
}

// -------------------- LIVE fallback (/api/destinations) --------------------
function minutesToRadiusKm(minutes) {
  const m = clamp(Number(minutes) || 120, 10, 180);
  const drive = Math.max(6, m - FIXED_OVERHEAD_MIN);
  const km = (drive / 60) * AVG_KMH / ROAD_FACTOR;
  return clamp(Math.round(km), 5, 220);
}

function overpassElToPlace(el, usedCat) {
  const tagsObj = el?.tags || {};
  const name = tagsObj?.name || tagsObj?.["name:it"] || "";
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const tagsArr = [];
  const allow = ["tourism","leisure","historic","natural","amenity","place","sport","boundary","information","aerialway"];
  for (const k of allow) if (tagsObj[k] != null) tagsArr.push(`${k}=${tagsObj[k]}`);

  // ✅ aggiungiamo tag semantici utili anche ai macro
  if (usedCat) tagsArr.push(String(usedCat));
  if (tagsObj.leisure === "water_park") tagsArr.push("water_park");
  if (tagsObj.tourism === "zoo") tagsArr.push("zoo");
  if (tagsObj.tourism === "aquarium") tagsArr.push("aquarium");
  if (tagsObj.historic) tagsArr.push("storia");
  if (tagsObj.natural) tagsArr.push("natura");
  if (tagsObj.place === "village" || tagsObj.place === "hamlet") tagsArr.push("borgo");
  if (tagsObj.place === "town" || tagsObj.place === "city") tagsArr.push("citta");

  return {
    id: `live_${usedCat}_${el.type}_${el.id}`,
    name: String(name).trim(),
    lat,
    lon,
    type: usedCat || "ovunque",
    visibility: "conosciuta",
    tags: Array.from(new Set(tagsArr)).slice(0, 18),
    beauty_score: 0.72,
    country: tagsObj["addr:country"] || "",
    area: ""
  };
}

async function fetchLiveFallback(origin, minutes, category, signal) {
  const radiusKm = minutesToRadiusKm(minutes);
  const url = `/api/destinations?lat=${encodeURIComponent(origin.lat)}&lon=${encodeURIComponent(origin.lon)}&radiusKm=${encodeURIComponent(radiusKm)}&cat=${encodeURIComponent(category)}`;
  const j = await fetchJson(url, { signal });

  if (!j?.ok) return { places: [], usedCat: category };
  const usedCat = j?.meta?.usedCat || category;

  const els = Array.isArray(j?.data?.elements) ? j.data.elements : [];
  const out = els.map(el => overpassElToPlace(el, usedCat)).filter(Boolean);
  return { places: out, usedCat };
}

// -------------------- RENDER (uguale al tuo: ridotta qui per brevità) --------------------
// NOTA: qui sotto mantieni renderResult/renderNoResultFinal ecc come nel v9.
// Per non allungare troppo, riusa i tuoi render identici.
// L'unica cosa: aggiungo datasetInfo che mostra anche usedMinutes.

function typeBadge(category) {
  const map = {
    family: { emoji: "👨‍👩‍👧‍👦", label: "Family" },
    storia: { emoji: "🏛️", label: "Storia" },
    borghi: { emoji: "🏘️", label: "Borghi" },
    citta:  { emoji: "🏙️", label: "Città" },
    mare:   { emoji: "🌊", label: "Mare" },
    natura: { emoji: "🌿", label: "Natura" },
    montagna:{emoji:"🏔️",label:"Montagna"},
    relax:  { emoji: "🧖", label: "Relax" },
    ovunque:{ emoji: "🎲", label: "Meta" },
  };
  return map[category] || { emoji: "📍", label: "Meta" };
}

// --- qui incolla i tuoi renderResult/renderNoResultFinal ESATTAMENTE come v9 ---

// -------------------- MAIN SEARCH --------------------
async function runSearch({ silent = false } = {}) {
  try { SEARCH_ABORT?.abort?.(); } catch {}
  SEARCH_ABORT = new AbortController();
  const signal = SEARCH_ABORT.signal;
  const token = ++SEARCH_TOKEN;

  try {
    if (!silent) hideStatus();
    showResultProgress();

    const origin = getOrigin();
    if (!origin || !Number.isFinite(Number(origin.lat)) || !Number.isFinite(Number(origin.lon))) {
      showStatus("err", "Imposta una partenza: GPS oppure scrivi un luogo e premi “Usa questo luogo”.");
      return;
    }

    await ensureDatasetLoaded(origin, { signal });

    const basePool = Array.isArray(DATASET?.places) ? DATASET.places : [];
    const datasetInfo =
      DATASET.kind === "pois" ? `POIs:${DATASET.meta?.regionId || "region"} (${basePool.length})` :
      DATASET.kind === "macro" ? `MACRO:${(DATASET.source || "").split("/").pop()} (${basePool.length})` :
      `—`;

    const maxMinutesInput = clamp(Number($("maxMinutes")?.value) || 120, 10, 600);
    const category = getActiveCategory();
    const styles = getActiveStyles();
    const steps = widenMinutesSteps(maxMinutesInput, category);

    let chosen = null;
    let alternatives = [];
    let usedMinutes = steps[0];
    let liveUsed = false;

    // OFFLINE
    for (const mins of steps) {
      usedMinutes = mins;
      const picked = pickBest(basePool, origin, mins, category, styles);
      chosen = picked.chosen;
      alternatives = picked.alternatives;
      if (chosen) break;
      if (token !== SEARCH_TOKEN) return;
    }

    // LIVE (solo se offline vuoto)
    if (!chosen) {
      showResultProgress("Offline vuoto. Provo LIVE (Overpass) senza cambiare categoria…");
      for (const mins of steps) {
        usedMinutes = mins;

        const live = await fetchLiveFallback(origin, mins, category, signal).catch(() => ({ places: [], usedCat: category }));
        if (token !== SEARCH_TOKEN) return;

        if (live.places.length) {
          const merged = basePool.concat(live.places);
          const picked = pickBest(merged, origin, mins, category, styles);
          chosen = picked.chosen;
          alternatives = picked.alternatives;
          liveUsed = !!chosen;
        }
        if (chosen) break;
      }
    }

    if (token !== SEARCH_TOKEN) return;

    // ✅ se ancora null, no result
    // qui richiami il tuo renderResult completo
    renderResult(origin, maxMinutesInput, chosen, alternatives, {
      category,
      datasetInfo,
      usedMinutes,
      liveUsed,
    });

    if (!chosen) {
      showStatus("warn", `Nessuna meta entro ${maxMinutesInput} min per "${category}".`);
    } else if (!silent) {
      const extra = usedMinutes !== maxMinutesInput ? ` (ho allargato a ${usedMinutes} min)` : "";
      const live = liveUsed ? " • LIVE ok" : "";
      showStatus("ok", `Meta trovata ✅ (~${chosen.driveMin} min) • categoria: ${category}${extra}${live}`);
    }

  } catch (e) {
    if (String(e?.name || "").includes("Abort")) return;
    console.error(e);
    showStatus("err", `Errore: ${String(e.message || e)}`);
  }
}

// -------------------- INIT --------------------
function initTimeChipsSync() {
  $("maxMinutes")?.addEventListener("input", () => {
    const v = Number($("maxMinutes").value);
    const chipsEl = $("timeChips");
    if (!chipsEl) return;
    const chips = [...chipsEl.querySelectorAll(".chip")];
    chips.forEach(c => c.classList.remove("active"));
    const match = chips.find(c => Number(c.dataset.min) === v);
    if (match) match.classList.add("active");
  });
}

function restoreOrigin() {
  const raw = localStorage.getItem("jamo_origin");
  if (raw) {
    try {
      const o = JSON.parse(raw);
      if (Number.isFinite(Number(o?.lat)) && Number.isFinite(Number(o?.lon))) setOrigin(o);
    } catch {}
  }
}

function bindOriginButtons() {
  $("btnUseGPS")?.addEventListener("click", () => {
    if ($("originStatus")) $("originStatus").textContent = "📍 Sto leggendo il GPS…";
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        setOrigin({ label: "La mia posizione", lat, lon });
        showStatus("ok", "Partenza GPS impostata ✅");
        DATASET = { kind:null, source:null, places:[], meta:{} };
        await ensureDatasetLoaded(getOrigin(), { signal: undefined }).catch(() => {});
      },
      () => {
        if ($("originStatus")) $("originStatus").textContent = "❌ GPS non disponibile";
        showStatus("err", "GPS non disponibile. Scrivi un luogo e usa “Usa questo luogo”.");
      },
      { enableHighAccuracy: true, timeout: 12000 }
    );
  });

  $("btnFindPlace")?.addEventListener("click", async () => {
    try {
      const label = $("originLabel")?.value || "";
      if ($("originStatus")) $("originStatus").textContent = "🔎 Cerco il luogo…";
      const result = await geocodeLabel(label);
      // ✅ passiamo anche country_code all’origine
      setOrigin({ label: result.label || label, lat: result.lat, lon: result.lon, country_code: result.country_code });
      showStatus("ok", "Partenza impostata ✅");
      DATASET = { kind:null, source:null, places:[], meta:{} };
      await ensureDatasetLoaded(getOrigin(), { signal: undefined }).catch(() => {});
    } catch (e) {
      if ($("originStatus")) $("originStatus").textContent = `❌ ${String(e.message || e)}`;
      showStatus("err", `Geocoding fallito: ${String(e.message || e)}`);
    }
  });
}

function bindMainButtons() {
  $("btnFind")?.addEventListener("click", () => runSearch());
  $("btnResetVisited")?.addEventListener("click", () => {
    resetVisited();
    showStatus("ok", "Visitati resettati ✅");
  });
}

initChips("timeChips", { multi: false });
initChips("categoryChips", { multi: false });
initChips("styleChips", { multi: true });

initTimeChipsSync();
restoreOrigin();
bindOriginButtons();
bindMainButtons();

hideStatus();
(async () => {
  try {
    const origin = getOrigin();
    if (origin) await ensureDatasetLoaded(origin, { signal: undefined });
  } catch {}
})();
