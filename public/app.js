/* Jamo — app.js v10 (OFFLINE-FIRST + LIVE FALLBACK, PRECISO)
 * Fix principali:
 * - Normalizzazione unica place (macro/pois/live): lat/lon robusti (anche virgola), type coerente
 * - Tags robusti: supporta tags come array ["k=v", ...] o come oggetto {k:v}
 * - Matching categoria basato su key/value (tourism/leisure/natural/historic/place/amenity…)
 * - LIVE fallback coerente (family/theme_park ecc matchano davvero)
 * - borghi: accetta borghi/borgo
 * - Widen solo minuti, mai categoria
 */

const $ = (id) => document.getElementById(id);

// -------------------- DATA SOURCES --------------------
const REGIONS = [
  { id: "it-abruzzo", name: "Abruzzo", country: "IT", indexUrl: "/data/pois/it/it-abruzzo/index.json" },
];

const MACROS_INDEX_URL = "/data/macros/macros_index.json";
const FALLBACK_MACRO_URLS = [
  "/data/macros/euuk_macro_all.json",
  "/data/macros/it_macro_01_abruzzo.json",
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

function num(x) {
  if (x == null) return null;
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  const s = String(x).trim().replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

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

// -------------------- TAGS NORMALIZATION --------------------
function buildTagsKV(place) {
  // Accetta:
  // - tags array: ["tourism=theme_park","kids",...]
  // - tags object: {tourism:"theme_park", leisure:"water_park"}
  const kv = Object.create(null);
  const arr = [];

  const raw = place?.tags;

  if (Array.isArray(raw)) {
    for (const t of raw) {
      const s = String(t ?? "").trim();
      if (!s) continue;
      arr.push(s.toLowerCase());
      const m = s.split("=");
      if (m.length === 2) kv[m[0].trim().toLowerCase()] = m[1].trim().toLowerCase();
      else kv[s.toLowerCase()] = "yes";
    }
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      if (v == null) continue;
      const kk = String(k).trim().toLowerCase();
      const vv = String(v).trim().toLowerCase();
      kv[kk] = vv;
      arr.push(`${kk}=${vv}`);
    }
  }

  return { kv, arr };
}

function getKV(place) {
  if (!place) return { kv: Object.create(null), arr: [] };
  if (place.__kv && place.__arr) return { kv: place.__kv, arr: place.__arr };
  const { kv, arr } = buildTagsKV(place);
  place.__kv = kv;
  place.__arr = arr;
  return { kv, arr };
}

// -------------------- PLACE NORMALIZATION --------------------
function normalizePlace(p, fallbackType = null) {
  if (!p) return null;

  const name = String(p.name || p.title || "").trim();
  if (!name) return null;

  const lat = num(p.lat ?? p.latitude ?? p.center?.lat);
  const lon = num(p.lon ?? p.lng ?? p.longitude ?? p.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  // type coerente
  let type = String(p.type || fallbackType || "").trim().toLowerCase();
  if (type === "borgo") type = "borghi"; // normalize

  // tags: lascia come sono, ma assicurati ci sia sempre
  let tags = p.tags;
  if (!tags) tags = [];

  const out = {
    ...p,
    name,
    lat,
    lon,
    type,
    tags,
    visibility: p.visibility || "classica",
    beauty_score: Number.isFinite(num(p.beauty_score)) ? num(p.beauty_score) : 0.70,
    country: p.country || p.area || "",
    area: p.area || "",
  };

  // inizializza cache kv/arr
  const { kv, arr } = buildTagsKV(out);
  out.__kv = kv;
  out.__arr = arr;

  return out;
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
  const lat = num($("originLat")?.value);
  const lon = num($("originLon")?.value);
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

// -------------------- UI (chips + status) --------------------
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
  return {
    wantChicche: actives.includes("chicche"),
    wantClassici: actives.includes("classici"),
  };
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
      <div class="small muted" style="margin-top:8px; line-height:1.4;">
        ${msg}
      </div>
    </div>
  `;
}

// -------------------- FETCH JSON --------------------
async function fetchJson(url, { signal } = {}) {
  const r = await fetch(url, { cache: "no-store", signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

// -------------------- DATASET LOADING (POIs -> MACRO) --------------------
let DATASET = { kind: null, source: null, places: [], meta: {} };

// bbox region detection (works with GPS)
function originInRegionBBox(origin, regionJson) {
  const lat = num(origin?.lat);
  const lon = num(origin?.lon);
  const b = regionJson?.bbox;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (!Array.isArray(b) || b.length !== 4) return false;
  const [minLon, minLat, maxLon, maxLat] = b;
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

// compatibilità index.json POIs:
// {
//   basePath:"/data/pois/it/it-abruzzo",
//   files:{ family:"family.json", ... },
//   categories:["family","natura"...], // opzionale
//   counts:{...}
// }
async function tryLoadPoisRegion(regionId, { signal } = {}) {
  const region = REGIONS.find(r => r.id === regionId);
  if (!region) return null;

  const idx = await fetchJson(region.indexUrl, { signal });

  const basePath = String(idx?.basePath || "").trim() || `/data/pois/it/${regionId}`;
  const files = idx?.files && typeof idx.files === "object" ? idx.files : null;
  const cats = Array.isArray(idx?.categories) ? idx.categories : (files ? Object.keys(files) : []);

  if (!files || !cats.length) return null;

  const all = [];
  for (const cat of cats) {
    const file = files[cat];
    if (!file) continue;

    const url = file.startsWith("http") || file.startsWith("/")
      ? file
      : `${basePath}/${file}`;

    const j = await fetchJson(url, { signal });
    const rawPlaces = Array.isArray(j?.places) ? j.places : Array.isArray(j) ? j : [];
    for (const rp of rawPlaces) {
      const np = normalizePlace(rp, cat);
      if (np) all.push(np);
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
function inferScopeFromOriginLabel(label) {
  const s = normName(label || "");
  if (s.includes("italia") || s.includes("italy")) return "IT";
  return "EUUK";
}
async function loadBestMacroForOrigin(origin, signal) {
  const saved = localStorage.getItem("jamo_macro_url");
  if (saved) {
    const m = await tryLoadMacro(saved, signal);
    if (m) { MACRO = m; MACRO_SOURCE_URL = saved; return m; }
  }

  await loadMacrosIndexSafe(signal);
  const preferredScope = inferScopeFromOriginLabel(origin?.label || "");
  const candidates = [];

  if (MACROS_INDEX?.items?.length) {
    const euukAll = MACROS_INDEX.items.find(x => x.id === "euuk_macro_all" || x.path?.includes("euuk_macro_all.json"));
    if (euukAll?.path) candidates.push(euukAll.path);

    if (preferredScope === "IT") {
      const itCountry = MACROS_INDEX.items.find(x =>
        x.id === "euuk_country_it" ||
        (x.scope === "country" && x.country === "IT" && String(x.path || "").includes("euuk_country_it.json"))
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

  // 1) prova regioni POI tramite bbox o label
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

  // 2) fallback macro
  const m = await loadBestMacroForOrigin(origin, signal);
  const normalized = [];
  for (const rp of (Array.isArray(m?.places) ? m.places : [])) {
    const np = normalizePlace(rp, rp?.type || null);
    if (np) normalized.push(np);
  }
  DATASET = {
    kind: "macro",
    source: MACRO_SOURCE_URL || "macro",
    places: normalized,
    meta: {},
  };
  return DATASET;
}

// -------------------- GEOCODING --------------------
async function geocodeLabel(label) {
  const q = String(label || "").trim();
  if (!q) throw new Error("Scrivi un luogo (es: Bussolengo, L'Aquila, Roma...)");
  const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { method: "GET", cache: "no-store" });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error("Geocoding fallito (risposta vuota)");
  if (!j.ok) throw new Error(j.error || "Geocoding fallito");
  if (!j.result || !Number.isFinite(num(j.result.lat)) || !Number.isFinite(num(j.result.lon))) {
    throw new Error("Geocoding fallito (coordinate non valide)");
  }
  return { ...j.result, lat: num(j.result.lat), lon: num(j.result.lon) };
}

// -------------------- CATEGORY PREDICATES (KV based) --------------------
function kvHasAny(kv, key, values) {
  const v = String(kv[key] || "").toLowerCase();
  return values.includes(v);
}
function kvHasKey(kv, key) {
  return kv[key] != null;
}
function nameHas(place, re) {
  return re.test(normName(place?.name || ""));
}

function looksIndoor(place) {
  const { kv, arr } = getKV(place);
  const blob = arr.join(" ");
  return blob.includes("indoor") || blob.includes("coperto") || nameHas(place, /\bindoor\b|\bcopert/);
}

function isWaterPark(place) {
  const { kv } = getKV(place);
  if (kv.leisure === "water_park") return true;
  if (kv.tourism === "theme_park" && nameHas(place, /acqua|aqua|water/)) return true;
  return nameHas(place, /acquapark|aqua park|water park|parco acquatico/);
}

function isSpaPlace(place) {
  const { kv } = getKV(place);
  if (String(place.type || "").toLowerCase() === "relax") return true;
  if (kv.amenity === "spa" || kv.leisure === "spa") return true;
  if (kv.natural === "hot_spring") return true;
  if (kv.amenity === "public_bath") return true;
  return nameHas(place, /terme|spa|thermal|benessere/);
}

function isFamilyAttraction(place) {
  const { kv } = getKV(place);
  if (kv.tourism === "theme_park") return true;
  if (kv.leisure === "water_park") return true;
  if (kv.tourism === "zoo" || kv.tourism === "aquarium" || kv.amenity === "aquarium") return true;
  if (kv.leisure === "amusement_arcade" || kv.leisure === "trampoline_park") return true;
  if (kv.tourism === "attraction") {
    if (nameHas(place, /parco divertimenti|lunapark|luna park|giostre|acqua|aqua|water|zoo|acquario|parco avventura|safari|faunistic/)) return true;
  }
  return nameHas(place, /parco divertimenti|lunapark|luna park|giostre|zoo|acquario|parco avventura|safari|faunistico|acquapark|aqua park|water park/);
}

function isFamilySecondary(place) {
  const { kv } = getKV(place);
  if (kv.leisure === "playground") return true;
  if (kv.leisure === "trampoline_park") return true;
  if (kv.leisure === "swimming_pool" || kv.amenity === "swimming_pool" || kv.sport === "swimming") return true;
  return nameHas(place, /parco giochi|area giochi|kids|bambin|trampolin|fattoria|didattic|avventura/);
}

function isGenericTownLike(place) {
  const t = String(place.type || "").toLowerCase();
  const { kv } = getKV(place);
  if (t === "citta" || t === "borghi" || t === "borgo") return true;
  if (kv.place === "town" || kv.place === "city" || kv.place === "village" || kv.place === "hamlet") return true;
  return false;
}

function matchesCategory(place, cat, { familyStrict = false } = {}) {
  if (!cat || cat === "ovunque") return true;

  const t = String(place.type || "").toLowerCase();
  const { kv } = getKV(place);

  if (cat === "citta") {
    return t === "citta" || kv.place === "city" || kv.place === "town";
  }

  if (cat === "borghi") {
    // accetta borghi/borgo + place village/hamlet + nome
    if (t === "borghi" || t === "borgo") return true;
    if (kv.place === "village" || kv.place === "hamlet") return true;
    return nameHas(place, /borgo|castel|rocca/);
  }

  if (cat === "mare") {
    if (t === "mare") return true;
    if (kv.natural === "beach") return true;
    if (kv.leisure === "marina") return true;
    return nameHas(place, /spiaggia|lido|baia|mare|beach/);
  }

  if (cat === "montagna") {
    if (t === "montagna") return true;
    if (kv.natural === "peak") return true;
    return nameHas(place, /monte|cima|passo|rifugio/);
  }

  if (cat === "natura") {
    if (t === "natura") return true;
    if (kv.natural === "waterfall" || kv.natural === "peak" || kv.natural === "spring" || kv.natural === "wood") return true;
    if (kv.leisure === "nature_reserve") return true;
    if (kv.boundary === "national_park") return true;
    return nameHas(place, /cascata|lago|riserva|parco naturale|gola|sentiero|eremo/);
  }

  if (cat === "storia") {
    if (t === "storia") return true;
    if (kvHasKey(kv, "historic")) return true;
    if (kv.tourism === "museum") return true;
    return nameHas(place, /castello|rocca|forte|abbazia|museo|anfiteatro|tempio|scavi|necropol|eremo|centro storico/);
  }

  if (cat === "relax") return isSpaPlace(place);

  if (cat === "family") {
    const ok = isFamilyAttraction(place) || isFamilySecondary(place) || isSpaPlace(place);
    if (familyStrict) return ok;
    // mai città/borghi “random” in family
    if (isGenericTownLike(place)) return false;
    return ok;
  }

  return true;
}

function matchesStyle(place, { wantChicche, wantClassici }) {
  const vis = String(place.visibility || "").toLowerCase();
  if (!wantChicche && !wantClassici) return true;
  if (vis === "chicca") return !!wantChicche;
  return !!wantClassici;
}

// -------------------- SCORING --------------------
function baseScorePlace({ driveMin, targetMin, beautyScore, isChicca }) {
  const t = clamp(1 - Math.abs(driveMin - targetMin) / Math.max(25, targetMin * 0.9), 0, 1);
  const b = clamp(Number(beautyScore) || 0.70, 0.35, 1);
  const c = isChicca ? 0.07 : 0;
  return 0.60 * t + 0.33 * b + c;
}

function rotationPenalty(pid, recentSet) {
  let pen = 0;
  if (pid && pid === LAST_SHOWN_PID) pen += 0.22;
  if (SESSION_SEEN.has(pid)) pen += 0.18;
  if (recentSet.has(pid)) pen += 0.10;
  return pen;
}

function familySpaPenalty(place, category) {
  if (category !== "family") return 0;
  if (!isSpaPlace(place)) return 0;
  return 0.10;
}

// -------------------- TIME WIDEN --------------------
function widenMinutesSteps(m, category) {
  const base = clamp(Number(m) || 120, 10, 600);
  const steps = [base];

  const muls =
    category === "family" ? [1.25, 1.45, 1.70] :
    category === "mare" ?   [1.20, 1.40, 1.65] :
    category === "storia" ? [1.20, 1.40, 1.60] :
                            [1.20, 1.40, 1.60];

  for (const k of muls) steps.push(clamp(Math.round(base * k), base, 600));
  steps.push(clamp(Math.max(240, base), base, 600));

  return Array.from(new Set(steps)).sort((a,b)=>a-b);
}

// -------------------- CANDIDATES / PICK --------------------
function buildCandidatesFromPool(
  pool,
  origin,
  maxMinutes,
  category,
  styles,
  {
    ignoreVisited = false,
    ignoreRotation = false,
    familyStrict = false,
  } = {}
) {
  const visited = getVisitedSet();
  const recentSet = getRecentSet();
  const target = Number(maxMinutes);

  const oLat = num(origin.lat);
  const oLon = num(origin.lon);

  const candidates = [];

  for (const raw of pool) {
    const p = normalizePlace(raw, raw?.type || null);
    if (!p) continue;

    const nm = String(p.name || "").trim();
    if (!nm || nm.length < 2 || normName(nm) === "meta") continue;

    if (!matchesCategory(p, category, { familyStrict })) continue;
    if (!matchesStyle(p, styles)) continue;

    const pid = safeIdFromPlace(p);
    if (!ignoreVisited && visited.has(pid)) continue;

    const km = haversineKm(oLat, oLon, p.lat, p.lon);
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

    if (category === "family") {
      if (isFamilyAttraction(p)) s += 0.20;
      else if (isFamilySecondary(p)) s += 0.10;
      else if (isSpaPlace(p)) s += 0.05;
      s -= familySpaPenalty(p, category);
    }

    if (!ignoreRotation) s -= rotationPenalty(pid, recentSet);

    candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
  }

  candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
  return candidates;
}

function pickBest(pool, origin, minutes, category, styles) {
  if (category === "family") {
    let strict = buildCandidatesFromPool(pool, origin, minutes, category, styles, {
      ignoreVisited: false,
      ignoreRotation: false,
      familyStrict: true,
    });
    if (strict.length) return { chosen: strict[0], alternatives: strict.slice(1, 3), totalCandidates: strict.length, strictUsed: true };

    strict = buildCandidatesFromPool(pool, origin, minutes, category, styles, {
      ignoreVisited: false,
      ignoreRotation: true,
      familyStrict: true,
    });
    if (strict.length) return { chosen: strict[0], alternatives: strict.slice(1, 3), totalCandidates: strict.length, strictUsed: true };

    let wide = buildCandidatesFromPool(pool, origin, minutes, category, styles, {
      ignoreVisited: true,
      ignoreRotation: true,
      familyStrict: true,
    });
    return { chosen: wide[0] || null, alternatives: wide.slice(1, 3), totalCandidates: wide.length, strictUsed: true };
  }

  let c = buildCandidatesFromPool(pool, origin, minutes, category, styles, { ignoreVisited: false, ignoreRotation: false });
  if (c.length === 0) c = buildCandidatesFromPool(pool, origin, minutes, category, styles, { ignoreVisited: false, ignoreRotation: true });
  if (c.length === 0) c = buildCandidatesFromPool(pool, origin, minutes, category, styles, { ignoreVisited: true, ignoreRotation: true });

  return { chosen: c[0] || null, alternatives: c.slice(1, 3), totalCandidates: c.length, strictUsed: false };
}

// -------------------- LIVE fallback (/api/destinations) --------------------
function minutesToRadiusKm(minutes) {
  const m = clamp(Number(minutes) || 120, 10, 600);
  const drive = Math.max(6, m - FIXED_OVERHEAD_MIN);
  const km = (drive / 60) * AVG_KMH / ROAD_FACTOR;
  return clamp(Math.round(km), 5, 260);
}

function overpassElToPlace(el, cat) {
  const tagsObj = el?.tags || {};
  const name = tagsObj?.name || tagsObj?.["name:it"] || "";
  const lat = num(el.lat ?? el.center?.lat);
  const lon = num(el.lon ?? el.center?.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return normalizePlace({
    id: `live_${cat}_${el.type}_${el.id}`,
    name: String(name).trim(),
    lat,
    lon,
    type: cat,
    visibility: "classica",
    tags: tagsObj, // ✅ oggetto, poi normalizePlace lo gestisce
    beauty_score: 0.70,
    country: tagsObj["addr:country"] || "",
    area: ""
  }, cat);
}

async function fetchLiveFallback(origin, minutes, category, signal) {
  const radiusKm = minutesToRadiusKm(minutes);
  const url = `/api/destinations?lat=${encodeURIComponent(origin.lat)}&lon=${encodeURIComponent(origin.lon)}&radiusKm=${encodeURIComponent(radiusKm)}&cat=${encodeURIComponent(category)}`;
  const j = await fetchJson(url, { signal });
  if (!j?.ok || !j?.data?.elements) return [];
  const els = Array.isArray(j.data.elements) ? j.data.elements : [];
  return els.map(el => overpassElToPlace(el, category)).filter(Boolean);
}

// -------------------- CARD HELPERS --------------------
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

function microWhatToDo(place, category) {
  const { kv, arr } = getKV(place);
  const n = normName(place.name);
  const tags = arr.join(" ");

  if (category === "family") {
    if (isFamilyAttraction(place)) {
      if (isWaterPark(place)) return "Scivoli e piscine: controlla apertura (spesso stagionale).";
      if (kv.tourism === "zoo" || n.includes("zoo")) return "Zoo/animali: percorsi, aree picnic, perfetto con bambini.";
      if (kv.tourism === "aquarium" || kv.amenity === "aquarium" || n.includes("acquario")) return "Acquario spesso indoor: ottimo anche d’inverno.";
      return "Attrazione family: tante cose da fare sul posto.";
    }
    if (isFamilySecondary(place)) return "Attività per bambini: gioco, movimento e divertimento.";
    if (isSpaPlace(place)) return "Terme/piscine: relax anche in famiglia (controlla accesso bimbi).";
    return "Gita family: esplora e abbina qualcosa di vicino.";
  }

  if (category === "relax") {
    if (isSpaPlace(place)) return "Terme/benessere: piscine, spa o acqua calda (verifica orari).";
    return "Relax: posto tranquillo + pausa.";
  }

  if (category === "storia") {
    if (kv.tourism === "museum" || n.includes("museo")) return "Museo/mostre + centro storico: visita e pausa caffè.";
    if (kv.historic === "castle" || n.includes("castello") || n.includes("rocca")) return "Castello/rocca: vista, storia e foto.";
    return "Storia e cultura: visita e passeggiata.";
  }

  if (category === "mare") return "Spiagge, passeggiata sul mare e tramonto.";
  if (category === "natura") return "Natura vera: sentieri, panorami, cascata/lago/riserva nei dintorni.";
  if (category === "borghi") return "Borgo da esplorare: vicoli, belvedere, cibo tipico e foto.";
  if (category === "citta") return "Centro, piazze, monumenti e locali: passeggiata + cose da vedere.";
  return "Esplora, foto, cibo e cose da fare nei dintorni.";
}

function chipsFromPlace(place, category) {
  const { kv, arr } = getKV(place);
  const chips = [];

  if (category === "family") {
    if (isFamilyAttraction(place)) chips.push("🎟️ attrazione");
    if (isFamilySecondary(place)) chips.push("🧒 kids");
    if (isSpaPlace(place)) chips.push("🧖 terme");
    if (isWaterPark(place)) chips.push("💦 acqua");
    if (looksIndoor(place)) chips.push("🏠 indoor");
    if (isWinterNow() && isWaterPark(place) && !looksIndoor(place)) chips.push("❄️ stagionale");
  }
  if (category === "relax") chips.push("🧖 relax");
  if (category === "storia") {
    if (kv.tourism === "museum") chips.push("🖼️ museo");
    if (kv.historic === "castle" || kv.historic === "ruins") chips.push("🏰 storico");
  }

  return chips.slice(0, 5);
}

// -------------------- RENDER --------------------
function renderNoResultFinal(maxMinutesShown, category, datasetInfo) {
  const area = $("resultArea");
  if (!area) return;

  area.innerHTML = `
    <div class="card errbox">
      <div class="small">❌ Nessuna meta trovata entro ${maxMinutesShown} min per la categoria <b>${category}</b>.</div>
      <div class="small muted" style="margin-top:6px;">
        Suggerimento: aumenta minuti oppure cambia categoria/stile.
      </div>
      <div class="small muted" style="margin-top:10px;">
        Dataset: ${datasetInfo}
      </div>
      <div class="row wrap gap" style="margin-top:12px;">
        <button class="btn btn-ghost" id="btnResetRotation">🧽 Reset “proposte di oggi”</button>
      </div>
    </div>
  `;

  $("btnResetRotation")?.addEventListener("click", () => {
    resetRotation();
    showStatus("ok", "Reset fatto ✅ Ora posso ripescare anche mete già proposte oggi/sessione.");
    runSearch({ silent: true });
  });
}

function renderResult(origin, maxMinutesShown, chosen, alternatives = [], meta = {}) {
  const area = $("resultArea");
  if (!area) return;

  const category = meta.category || "ovunque";

  if (!chosen) {
    renderNoResultFinal(maxMinutesShown, category, meta.datasetInfo || "—");
    return;
  }

  const p = chosen.place;
  const pid = chosen.pid;
  const country = p.country || p.area || "—";
  const badge = String(p.visibility || "").toLowerCase() === "chicca" ? "✨ chicca" : "✅ classica";
  const tb = typeBadge(category);
  const what = microWhatToDo(p, category);
  const chips = chipsFromPlace(p, category);

  const lat = num(p.lat);
  const lon = num(p.lon);

  const zoom = chosen.km < 20 ? 12 : chosen.km < 60 ? 10 : 8;
  const img1 = osmStaticImgPrimary(lat, lon, zoom);
  const img2 = osmStaticImgFallback(lat, lon, zoom);

  const q = (p.country || p.area) ? `${p.name}, ${p.country || p.area}` : p.name;

  area.innerHTML = `
    <div class="card okbox" style="overflow:hidden; padding:0;">
      <div style="position:relative; width:100%; aspect-ratio: 2 / 1; border-bottom:1px solid var(--border);">
        <img src="${img1}" alt="" loading="lazy" decoding="async"
             style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; opacity:.95;"
             onerror="(function(img){
               if(!img.dataset.fallbackTried){
                 img.dataset.fallbackTried='1';
                 img.src='${img2}';
                 return;
               }
               img.style.display='none';
               var ph = img.parentElement.querySelector('.heroPlaceholder');
               if(ph) ph.style.display='flex';
             })(this)"
        />
        <div class="heroPlaceholder"
             style="position:absolute; inset:0; display:none; align-items:center; justify-content:center; gap:10px;
                    background: linear-gradient(135deg, rgba(0,224,255,.18), rgba(26,255,213,.08));
                    color: rgba(255,255,255,.92); font-weight:900; letter-spacing:.2px;">
          📍 ${p.name}
        </div>

        <div style="position:absolute; left:12px; top:12px; display:flex; gap:8px; flex-wrap:wrap; max-width: calc(100% - 24px);">
          <div class="pill">${tb.emoji} ${tb.label}</div>
          <div class="pill">🚗 ~${chosen.driveMin} min • ${fmtKm(chosen.km)}</div>
          <div class="pill">${badge}</div>
          ${category === "family" && isWaterPark(p) && isWinterNow() && !looksIndoor(p) ? `<div class="pill">❄️ stagionale</div>` : ""}
        </div>
      </div>

      <div style="padding:14px;">
        <div style="font-weight:950; font-size:28px; line-height:1.12; margin:0;">
          ${p.name} <span class="small muted" style="font-weight:700;">(${country})</span>
        </div>

        <div class="small muted" style="margin-top:8px; line-height:1.35;">
          Dataset: ${meta.datasetInfo || "—"} • score: ${chosen.score}
          ${meta.usedMinutes && meta.usedMinutes !== maxMinutesShown ? ` • widen: ${meta.usedMinutes} min` : ""}
          ${meta.liveUsed ? ` • LIVE fallback ✅` : ""}
        </div>

        <div style="margin-top:12px; font-weight:900;">Cosa si fa</div>
        <div class="small muted" style="margin-top:6px; line-height:1.45;">${what}</div>

        ${chips.length ? `
          <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;">
            ${chips.map(c => `<div class="pill">${c}</div>`).join("")}
          </div>
        ` : ""}

        <div class="row wrap gap" style="margin-top:14px;">
          <a class="btn" target="_blank" rel="noopener" href="${mapsPlaceUrl(lat, lon)}">🗺️ Maps</a>
          <a class="btn" target="_blank" rel="noopener" href="${mapsDirUrl(origin.lat, origin.lon, lat, lon)}">🚗 Percorso</a>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleImagesUrl(q)}">📸 Foto</a>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleThingsToDoUrl(q)}">👀 Cosa vedere</a>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleDoUrl(q)}">🎯 Cosa fare</a>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${restaurantsUrl(q)}">🍝 Ristoranti</a>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${wikiUrl(q)}">📚 Wiki</a>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${eventsUrl(q)}">📅 Eventi</a>
        </div>

        <div class="row wrap gap" style="margin-top:14px;">
          <button class="btn btn-ghost" id="btnVisited">✅ Già visitato</button>
          <button class="btn" id="btnChange">🔁 Cambia meta</button>
          <button class="btn btn-ghost" id="btnResetRotation">🧽 Reset “oggi”</button>
        </div>
      </div>
    </div>

    ${alternatives?.length ? `
      <div style="margin-top:14px;">
        <div class="small muted" style="margin-bottom:8px;">Alternative (2)</div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
          ${alternatives.slice(0, 2).map(a => {
            const ap = a.place;
            const alat = num(ap.lat);
            const alon = num(ap.lon);
            const acountry = ap.country || ap.area || "";
            return `
              <div class="card" style="padding:10px;">
                <div style="font-weight:900; line-height:1.2;">${ap.name}</div>
                <div class="small muted" style="margin-top:4px;">
                  🚗 ~${a.driveMin} min • ${fmtKm(a.km)} ${acountry ? `• (${acountry})` : ""}
                </div>
                <div class="row wrap gap" style="margin-top:10px;">
                  <a class="btn btn-ghost" target="_blank" rel="noopener" href="${mapsDirUrl(origin.lat, origin.lon, alat, alon)}">Percorso</a>
                  <button class="btn btn-ghost" data-pid="${a.pid}">Scegli</button>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    ` : ""}
  `;

  LAST_SHOWN_PID = pid;
  SESSION_SEEN.add(pid);
  addRecent(pid);

  $("btnVisited")?.addEventListener("click", () => {
    markVisited(pid);
    showStatus("ok", "Segnato come visitato ✅ (non te lo ripropongo più).");
  });

  $("btnChange")?.addEventListener("click", () => {
    runSearch({ silent: true, forbidPid: pid });
  });

  $("btnResetRotation")?.addEventListener("click", () => {
    resetRotation();
    showStatus("ok", "Reset fatto ✅ Ora posso ripescare anche mete già proposte oggi/sessione.");
    runSearch({ silent: true });
  });

  area.querySelectorAll("button[data-pid]").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetPid = btn.getAttribute("data-pid");
      if (!targetPid) return;
      runSearch({ silent: true, forcePid: targetPid });
    });
  });
}

// -------------------- MAIN SEARCH (OFFLINE + LIVE fallback) --------------------
async function runSearch({ silent = false, forbidPid = null, forcePid = null } = {}) {
  try { SEARCH_ABORT?.abort?.(); } catch {}
  SEARCH_ABORT = new AbortController();
  const signal = SEARCH_ABORT.signal;
  const token = ++SEARCH_TOKEN;

  try {
    if (!silent) hideStatus();
    showResultProgress();

    const origin = getOrigin();
    if (!origin || !Number.isFinite(num(origin.lat)) || !Number.isFinite(num(origin.lon))) {
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

    // 1) OFFLINE widening
    for (const mins of steps) {
      usedMinutes = mins;

      let picked = pickBest(basePool, origin, mins, category, styles);
      chosen = picked.chosen;
      alternatives = picked.alternatives;

      if (forcePid) {
        const forced = buildCandidatesFromPool(basePool, origin, mins, category, styles, { ignoreVisited: true, ignoreRotation: true, familyStrict: category==="family" })
          .find(x => x.pid === forcePid);
        if (forced) {
          const rest = buildCandidatesFromPool(basePool, origin, mins, category, styles, { ignoreVisited: true, ignoreRotation: true, familyStrict: category==="family" })
            .filter(x => x.pid !== forcePid)
            .slice(0, 2);
          chosen = forced;
          alternatives = rest;
        }
      } else if (forbidPid && chosen?.pid === forbidPid) {
        const cands = buildCandidatesFromPool(basePool, origin, mins, category, styles, { ignoreVisited: true, ignoreRotation: true, familyStrict: category==="family" })
          .filter(x => x.pid !== forbidPid);
        chosen = cands[0] || null;
        alternatives = cands.slice(1, 3);
      }

      if (chosen) break;
      if (token !== SEARCH_TOKEN) return;
    }

    if (token !== SEARCH_TOKEN) return;

    // 2) LIVE fallback (solo se offline vuoto)
    if (!chosen) {
      showResultProgress("Offline vuoto. Provo LIVE (Overpass) senza cambiare categoria…");
      for (const mins of steps) {
        usedMinutes = mins;

        const livePlaces = await fetchLiveFallback(origin, mins, category, signal).catch(() => []);
        if (token !== SEARCH_TOKEN) return;

        if (livePlaces.length) {
          const merged = basePool.concat(livePlaces);
          const picked = pickBest(merged, origin, mins, category, styles);
          chosen = picked.chosen;
          alternatives = picked.alternatives;
          liveUsed = !!chosen;
        }
        if (chosen) break;
      }
    }

    if (token !== SEARCH_TOKEN) return;

    renderResult(origin, maxMinutesInput, chosen, alternatives, {
      category,
      datasetInfo,
      usedMinutes,
      liveUsed,
    });

    if (!chosen) {
      showStatus("warn", `Nessuna meta entro ${maxMinutesInput} min per "${category}". Prova ad aumentare i minuti o cambia categoria.`);
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
      if (Number.isFinite(num(o?.lat)) && Number.isFinite(num(o?.lon))) setOrigin(o);
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
      (err) => {
        console.error(err);
        if ($("originStatus")) $("originStatus").textContent = "❌ GPS non disponibile (permessi?)";
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
      setOrigin({ label: result.label || label, lat: result.lat, lon: result.lon });
      showStatus("ok", "Partenza impostata ✅");
      DATASET = { kind:null, source:null, places:[], meta:{} };
      await ensureDatasetLoaded(getOrigin(), { signal: undefined }).catch(() => {});
    } catch (e) {
      console.error(e);
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

// init chips
initChips("timeChips", { multi: false });
initChips("categoryChips", { multi: false });
initChips("styleChips", { multi: true });

initTimeChipsSync();
restoreOrigin();
bindOriginButtons();
bindMainButtons();

hideStatus();

// preload dataset (best effort)
(async () => {
  try {
    const origin = getOrigin();
    if (origin) await ensureDatasetLoaded(origin, { signal: undefined });
  } catch {}
})();
