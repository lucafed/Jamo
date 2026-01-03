/* Jamo — Auto-only — app.js v6.1 (FULL)
 * - Offline macro first, then Live (Overpass) merge
 * - Live status: no / tentato / sì (+ live_items)
 * - Anti-race token (no results popping back)
 * - Family ranking: theme park / zoo / aquarium / attractions for kids
 * - Water parks seasonal: penalized in winter unless indoor/coperto
 * - Cards: immediate (OSM static map image + "cosa si fa" + chips + links + monetization)
 * - NEVER show "Meta": live elements without a meaningful name are discarded or labeled from tags
 */

const $ = (id) => document.getElementById(id);

// -------------------- DATA SOURCES --------------------
const MACROS_INDEX_URL = "/data/macros/macros_index.json";
const FALLBACK_MACRO_URLS = [
  "/data/macros/euuk_macro_all.json",
  "/data/macros/it_macro_01_abruzzo.json",
];
const LIVE_DESTINATIONS_API = "/api/destinations";

// -------------------- MONETIZATION IDS --------------------
const BOOKING_AID = ""; // Booking.com affiliate id (aid)
const AMAZON_TAG  = ""; // Amazon tag
const GYG_PID     = ""; // GetYourGuide partner_id
const TIQETS_PID  = ""; // Tiqets partner

// -------------------- ROUTING / ESTIMATOR --------------------
const ROAD_FACTOR = 1.22;
const AVG_KMH = 70;
const MIN_KM_AVOID_SAME_PLACE = 0.2;

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
function overheadMinFromKm(km) {
  if (km < 3) return 2;
  if (km < 10) return 4;
  if (km < 30) return 6;
  return 8;
}
function estCarMinutesFromKm(km) {
  const roadKm = km * ROAD_FACTOR;
  const driveMin = (roadKm / AVG_KMH) * 60;
  const overhead = overheadMinFromKm(km);
  return Math.round(clamp(driveMin + overhead, 3, 900));
}
function fmtKm(km) { return `${Math.round(km)} km`; }

function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function safeIdFromPlace(p) {
  const lat = String(p.lat ?? "");
  const lon = String(p.lon ?? p.lng ?? "");
  return p.id || `p_${normName(p.name)}_${lat.slice(0, 7)}_${lon.slice(0, 7)}`;
}

// -------------------- ANTI-RACE TOKEN --------------------
let RUN_TOKEN = 0;
function nextRunToken() { RUN_TOKEN += 1; return RUN_TOKEN; }
function isStaleToken(token) { return token !== RUN_TOKEN; }

// -------------------- ROTATION --------------------
const RECENT_TTL_MS = 1000 * 60 * 60 * 20;
const RECENT_MAX = 160;
let SESSION_SEEN = new Set();
let LAST_SHOWN_PID = null;

function loadRecent() {
  const raw = localStorage.getItem("jamo_recent");
  if (!raw) return [];
  try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
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

// -------------------- VISITED --------------------
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

// -------------------- STATUS UI --------------------
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
function setLoadingUI(on, msg) {
  const btn = $("btnFind");
  if (btn) {
    btn.disabled = !!on;
    btn.style.opacity = on ? "0.75" : "1";
    btn.textContent = on ? (msg || "🔎 Cerco…") : "🎯 TROVAMI LA META";
  }
}
function clearResultAreaWithSpinner(text) {
  const area = $("resultArea");
  if (!area) return;
  area.innerHTML = `
    <div class="card warnbox">
      <div class="small">${text || "🔎 Sto cercando mete…"}</div>
      <div class="small muted" style="margin-top:6px;">Mostro subito una proposta offline, poi aggiorno con live.</div>
    </div>
  `;
}

// -------------------- UI CHIPS --------------------
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
  return { wantChicche: actives.includes("chicche"), wantClassici: actives.includes("classici") };
}

// -------------------- ORIGIN --------------------
function setOrigin({ label, lat, lon, country_code }) {
  if ($("originLabel")) $("originLabel").value = label ?? "";
  if ($("originLat")) $("originLat").value = String(lat);
  if ($("originLon")) $("originLon").value = String(lon);
  localStorage.setItem("jamo_origin", JSON.stringify({ label, lat, lon, country_code }));
  if ($("originStatus")) {
    $("originStatus").textContent =
      `✅ Partenza: ${label || "posizione"} (${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)})`;
  }
}
function getOrigin() {
  const latEl = $("originLat");
  const lonEl = $("originLon");
  const labEl = $("originLabel");

  const lat = Number(latEl?.value);
  const lon = Number(lonEl?.value);
  const label = (labEl?.value || "").trim();

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    const raw = localStorage.getItem("jamo_origin");
    if (raw) { try { const o = JSON.parse(raw); return { label, lat, lon, country_code: o?.country_code || "" }; } catch {} }
    return { label, lat, lon, country_code: "" };
  }

  const raw = localStorage.getItem("jamo_origin");
  if (raw) { try { return JSON.parse(raw); } catch {} }
  return null;
}

// -------------------- GEOCODE --------------------
async function geocodeLabel(label) {
  const q = String(label || "").trim();
  if (!q) throw new Error("Scrivi un luogo (es: Roma, London, Paris)");
  const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { method: "GET" });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error("Geocoding fallito (risposta vuota)");
  if (!j.ok) throw new Error(j.error || "Geocoding fallito");
  if (!j.result || !Number.isFinite(Number(j.result.lat)) || !Number.isFinite(Number(j.result.lon))) {
    throw new Error("Geocoding fallito (coordinate non valide)");
  }
  return j.result;
}

// -------------------- MACRO LOADING --------------------
let MACROS_INDEX = null;
let MACRO = null;
let MACRO_SOURCE_URL = null;

async function fetchJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}
async function loadMacrosIndexSafe() {
  try { MACROS_INDEX = await fetchJson(MACROS_INDEX_URL); return MACROS_INDEX; }
  catch { MACROS_INDEX = null; return null; }
}
async function tryLoadMacro(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j?.places || !Array.isArray(j.places) || j.places.length === 0) return null;
  return j;
}
function countryCodeFromOrigin(origin) {
  const cc = String(origin?.country_code || "").toUpperCase().trim();
  return cc || "";
}
async function loadBestMacroForOrigin(origin) {
  if (!origin) origin = getOrigin();

  const saved = localStorage.getItem("jamo_macro_url");
  if (saved) {
    const m = await tryLoadMacro(saved);
    if (m) { MACRO = m; MACRO_SOURCE_URL = saved; return m; }
  }

  await loadMacrosIndexSafe();

  const candidates = [];
  const cc = countryCodeFromOrigin(origin);

  if (cc && MACROS_INDEX?.items?.length) {
    const wantId = `euuk_country_${cc.toLowerCase()}`;
    const item = MACROS_INDEX.items.find(x => x.id === wantId || String(x.path || "").includes(`${wantId}.json`));
    if (item?.path) candidates.push(item.path);
  }

  if (MACROS_INDEX?.items?.length) {
    const euukAll = MACROS_INDEX.items.find(x => x.id === "euuk_macro_all" || String(x.path || "").includes("euuk_macro_all.json"));
    if (euukAll?.path) candidates.push(euukAll.path);
  }

  for (const u of FALLBACK_MACRO_URLS) candidates.push(u);

  for (const url of candidates) {
    const m = await tryLoadMacro(url);
    if (m) {
      MACRO = m;
      MACRO_SOURCE_URL = url;
      localStorage.setItem("jamo_macro_url", url);
      return m;
    }
  }

  throw new Error("Macro non trovato: nessun dataset valido disponibile.");
}
async function ensureMacroLoaded() {
  if (MACRO) return MACRO;
  return await loadBestMacroForOrigin(getOrigin());
}

// -------------------- SEASONALITY --------------------
function isWinterNow() {
  const m = new Date().getMonth() + 1; // 1..12
  return (m === 11 || m === 12 || m === 1 || m === 2 || m === 3);
}
function placeTags(place) {
  return (place?.tags || []).map(t => String(t).toLowerCase());
}
function looksIndoor(place) {
  const n = normName(place?.name);
  const tags = placeTags(place);
  return (
    n.includes("indoor") || n.includes("coperto") || n.includes("covered") || n.includes("al chiuso") ||
    tags.includes("indoor")
  );
}
function hasAnyName(place) {
  return String(place?.name || "").trim().length > 0;
}
function isThermeSpa(place) {
  const tags = placeTags(place);
  const n = normName(place.name);
  return tags.includes("spa") || tags.includes("hot_spring") || tags.includes("public_bath") || n.includes("terme") || n.includes("spa");
}
function isWaterPark(place) {
  const tags = placeTags(place);
  const n = normName(place.name);
  return tags.includes("water_park") || n.includes("parco acquatico") || n.includes("aquapark") || n.includes("water park");
}
function isBigAttraction(place) {
  const tags = placeTags(place);
  const n = normName(place.name);
  const strongTags = new Set(["theme_park", "water_park", "zoo", "aquarium", "attraction"]);
  if (tags.some(t => strongTags.has(t))) return true;

  if (
    n.includes("gardaland") ||
    n.includes("movieland") ||
    n.includes("caneva") ||
    n.includes("aquapark") ||
    n.includes("parco acquatico") ||
    n.includes("parco divertimenti") ||
    n.includes("theme park") ||
    n.includes("luna park") ||
    n.includes("zoo") ||
    n.includes("acquario") ||
    n.includes("aquarium")
  ) return true;

  return false;
}
function isTinyPark(place) {
  const tags = placeTags(place);
  const n = normName(place.name);
  const looksPark = tags.includes("park") || n.includes("parco");
  const notStrong = !isBigAttraction(place);
  const notReserve = !(tags.includes("national_park") || tags.includes("nature_reserve"));
  return looksPark && notStrong && notReserve;
}
function isFamilyPlace(place) {
  const t = String(place.type || "").toLowerCase();
  if (t === "family" || t === "bambini") return true;
  if (isBigAttraction(place)) return true;

  const tags = placeTags(place);
  if (tags.includes("famiglie") || tags.includes("family") || tags.includes("bambini") || tags.includes("animali")) return true;

  const n = normName(place.name);
  if (n.includes("zoo") || n.includes("acquario") || n.includes("piscina") || n.includes("parco acquatico")) return true;

  if (isThermeSpa(place)) return true;

  return false;
}
function isHistoryPlace(place) {
  const tags = placeTags(place);
  const n = normName(place.name);
  const type = String(place.type || "").toLowerCase();
  if (type === "storia") return true;

  const strong = [
    "museum", "gallery", "castle", "fort", "ruins", "monument", "memorial",
    "archaeological_site", "tower", "city_gate", "attraction", "historic"
  ];
  if (tags.some(t => strong.includes(t))) return true;

  if (
    n.includes("abbazia") || n.includes("abbey") ||
    n.includes("monastero") || n.includes("monastery") ||
    n.includes("convento") || n.includes("cattedrale") || n.includes("cathedral") ||
    n.includes("chiesa") || n.includes("basilica") || n.includes("duomo") ||
    n.startsWith("san ") || n.startsWith("santa ")
  ) return true;

  if (n.includes("castello") || n.includes("rocca") || n.includes("forte") || n.includes("fortezza") || n.includes("torre")) return true;
  if (n.includes("anfiteatro") || n.includes("teatro romano") || n.includes("area archeologica") || n.includes("archeolog")) return true;
  if (n.includes("museo") || n.includes("pinacoteca")) return true;

  return false;
}

// -------------------- CATEGORY MATCH --------------------
function matchesCategory(place, cat) {
  if (!cat || cat === "ovunque") return true;

  const type = String(place.type || "").toLowerCase();
  const tags = placeTags(place);
  const n = normName(place.name);

  if (cat === "citta") return type === "citta" || tags.includes("city") || tags.includes("town") || type === "city";
  if (cat === "borghi") return type === "borgo" || tags.includes("village") || tags.includes("hamlet") || n.includes("borgo") || n.includes("old town");
  if (cat === "mare") return type === "mare" || tags.includes("beach") || tags.includes("beach_resort") || tags.includes("bathing_place") || n.includes("spiaggia") || n.includes("beach");
  if (cat === "montagna") return type === "montagna" || tags.includes("peak") || n.includes("monte") || n.includes("mount");
  if (cat === "natura") return type === "natura" || tags.includes("national_park") || tags.includes("nature_reserve") || tags.includes("waterfall") || tags.includes("viewpoint") || tags.includes("peak") || n.includes("parco");
  if (cat === "relax") return type === "relax" || isThermeSpa(place);
  if (cat === "family") return isFamilyPlace(place);
  if (cat === "storia") return isHistoryPlace(place);

  return true;
}
function matchesStyle(place, { wantChicche, wantClassici }) {
  const vis = String(place.visibility || "").toLowerCase();
  if (!wantChicche && !wantClassici) return true;
  if (vis === "chicca") return !!wantChicche;
  return !!wantClassici;
}

// -------------------- SCORING --------------------
function rotationPenalty(pid, recentSet) {
  let pen = 0;
  if (pid && pid === LAST_SHOWN_PID) pen += 0.22;
  if (SESSION_SEEN.has(pid)) pen += 0.18;
  if (recentSet.has(pid)) pen += 0.10;
  return pen;
}
function attractionBoostFamily(place) {
  const tags = placeTags(place);
  const n = normName(place.name);

  if (tags.includes("theme_park") || n.includes("parco divertimenti")) return 0.34;
  if (tags.includes("zoo") || n.includes("zoo")) return 0.28;
  if (tags.includes("aquarium") || n.includes("acquario")) return 0.28;
  if (tags.includes("attraction")) return 0.22;

  if (isWaterPark(place)) {
    if (looksIndoor(place)) return 0.26;
    if (isWinterNow()) return 0.06;
    return 0.26;
  }

  if (tags.includes("swimming_pool") || n.includes("piscina")) return 0.14;
  if (isThermeSpa(place)) return 0.08;
  if (isBigAttraction(place)) return 0.20;

  return 0.0;
}
function baseScorePlace({ driveMin, targetMin, beautyScore, isChicca, extraBoost }) {
  const t = clamp(1 - Math.abs(driveMin - targetMin) / Math.max(25, targetMin * 0.9), 0, 1);
  const b = clamp(Number(beautyScore) || 0.70, 0.35, 1);
  const c = isChicca ? 0.05 : 0;
  const x = clamp(extraBoost || 0, 0, 0.38);
  return 0.52 * t + 0.30 * b + c + x;
}

// -------------------- TIME WIDENING --------------------
function effectiveMaxMinutes(maxMinutes, category) {
  const m = Number(maxMinutes);
  if (!Number.isFinite(m)) return 120;

  if (category === "family" && m < 90) return clamp(Math.round(m * 1.45), m, 220);
  if (category === "storia" && m < 60) return clamp(Math.round(m * 1.25), m, 180);
  if (category === "mare" && m < 75) return clamp(Math.round(m * 1.30), m, 180);

  return clamp(m, 10, 600);
}

// -------------------- LIVE (OVERPASS) --------------------
const LIVE_CACHE = new Map();
const LIVE_TTL_MS = 1000 * 60 * 7;

function liveKey(origin, radiusKm, cat) {
  const la = Number(origin.lat).toFixed(3);
  const lo = Number(origin.lon).toFixed(3);
  return `${cat}|${radiusKm}|${la}|${lo}`;
}
function apiCatFromUi(cat) {
  const c = String(cat || "").toLowerCase().trim();
  if (c === "montagna") return "natura";
  if (c === "relax") return "ovunque";
  const allowed = new Set(["family", "borghi", "citta", "mare", "natura", "storia", "ovunque"]);
  return allowed.has(c) ? c : "ovunque";
}
function tagsToArray(tagsObj = {}) {
  const out = [];
  const push = (x) => { if (x && !out.includes(x)) out.push(x); };

  push(tagsObj.tourism);
  push(tagsObj.leisure);
  push(tagsObj.amenity);
  push(tagsObj.natural);
  push(tagsObj.historic);
  push(tagsObj.sport);
  push(tagsObj.man_made);
  push(tagsObj.building);
  push(tagsObj.place);

  // a bit extra (helps filtering)
  push(tagsObj.boundary);
  push(tagsObj.waterway);

  return out.filter(Boolean).map(x => String(x).toLowerCase()).slice(0, 18);
}

/* ✅ FIX: never return "Meta"
 * - if name missing: build from tags + city
 * - if cannot build: return null (discard)
 */
function elementToPlace(el) {
  const tags = el?.tags || {};

  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const tourism  = String(tags.tourism || "").toLowerCase();
  const leisure  = String(tags.leisure || "").toLowerCase();
  const amenity  = String(tags.amenity || "").toLowerCase();
  const historic = String(tags.historic || "").toLowerCase();
  const natural  = String(tags.natural || "").toLowerCase();

  const nameRaw = String(
    tags.name || tags["name:it"] || tags["name:en"] || tags.brand || tags.operator || ""
  ).trim();

  const city =
    String(tags["addr:city"] || tags["is_in:city"] || tags["addr:suburb"] || tags["addr:town"] || "").trim();

  function labelFromTags() {
    if (tourism === "theme_park") return "Parco divertimenti";
    if (leisure === "water_park") return "Parco acquatico";
    if (tourism === "zoo" || amenity === "zoo") return "Zoo";
    if (tourism === "aquarium" || amenity === "aquarium") return "Acquario";
    if (tourism === "museum") return "Museo";
    if (tourism === "attraction") return "Attrazione";
    if (amenity === "spa" || amenity === "public_bath" || natural === "hot_spring") return "Terme / Spa";
    if (historic) return "Luogo storico";
    if (natural === "beach") return "Spiaggia";
    if (natural === "peak") return "Vetta / Monte";
    if (String(tags.waterway || "").toLowerCase() === "waterfall") return "Cascata";
    return "";
  }

  let name = nameRaw;
  if (!name) {
    const base = labelFromTags();
    if (!base) return null; // ✅ discard useless unnamed stuff
    name = city ? `${base} (${city})` : base;
  }

  const tagArr = tagsToArray(tags);

  let type = "meta";
  if (
    tourism === "theme_park" ||
    leisure === "water_park" ||
    tourism === "zoo" || amenity === "zoo" ||
    tourism === "aquarium" || amenity === "aquarium" ||
    tourism === "attraction"
  ) type = "family";
  else if (amenity === "spa" || amenity === "public_bath" || natural === "hot_spring") type = "relax";
  else if (historic || tourism === "museum" || tourism === "gallery") type = "storia";
  else if (natural === "beach") type = "mare";
  else if (String(tags.boundary || "").toLowerCase() === "national_park" || leisure === "nature_reserve") type = "natura";

  const strong =
    tourism === "theme_park" ||
    leisure === "water_park" ||
    tourism === "attraction" ||
    tourism === "museum" ||
    historic === "castle" ||
    historic === "archaeological_site";

  return {
    id: `osm_${el.type}_${el.id}`,
    name,
    lat,
    lon,
    type,
    visibility: "classica",
    tags: tagArr,
    beauty_score: strong ? 0.80 : 0.62,
    area: city || ""
  };
}

async function fetchLivePlaces(origin, radiusKm, uiCategory, token) {
  const cat = apiCatFromUi(uiCategory);
  const key = liveKey(origin, radiusKm, cat);
  const hit = LIVE_CACHE.get(key);
  const now = Date.now();
  if (hit && now - hit.ts < LIVE_TTL_MS) return hit.places;

  const url =
    `${LIVE_DESTINATIONS_API}?lat=${encodeURIComponent(origin.lat)}&lon=${encodeURIComponent(origin.lon)}` +
    `&radiusKm=${encodeURIComponent(radiusKm)}&cat=${encodeURIComponent(cat)}`;

  const r = await fetch(url, { method: "GET" });
  if (isStaleToken(token)) return [];

  const j = await r.json().catch(() => null);
  const elements = j?.data?.elements || j?.elements || [];
  const places = Array.isArray(elements) ? elements.map(elementToPlace).filter(Boolean) : [];

  // Dedup by id
  const seen = new Set();
  const uniq = places.filter(p => (seen.has(p.id) ? false : (seen.add(p.id), true)));

  LIVE_CACHE.set(key, { ts: now, places: uniq });
  return uniq;
}

// -------------------- CANDIDATE BUILDER --------------------
function buildCandidatesFromPlaces(placesArr, origin, maxMinutes, category, styles, { ignoreVisited = false, ignoreRotation = false } = {}) {
  const visited = getVisitedSet();
  const recentSet = getRecentSet();
  const target = Number(maxMinutes);

  const oLat = Number(origin.lat);
  const oLon = Number(origin.lon);

  const candidates = [];

  for (const p of placesArr) {
    if (!p) continue;
    if (!hasAnyName(p)) continue;

    const lat = Number(p.lat);
    const lon = Number(p.lon ?? p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    if (!matchesCategory(p, category)) continue;
    if (!matchesStyle(p, styles)) continue;

    if (category === "family" && isTinyPark(p)) continue;

    const pid = safeIdFromPlace(p);
    if (!ignoreVisited && visited.has(pid)) continue;

    const km = haversineKm(oLat, oLon, lat, lon);
    const driveMin = estCarMinutesFromKm(km);

    if (driveMin > target) continue;
    if (km < MIN_KM_AVOID_SAME_PLACE) continue;

    const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
    const extraBoost = (category === "family") ? attractionBoostFamily(p) : 0;

    const beauty = Number.isFinite(Number(p.beauty_score)) ? Number(p.beauty_score) : 0.70;

    let s = baseScorePlace({
      driveMin,
      targetMin: target,
      beautyScore: beauty,
      isChicca,
      extraBoost
    });

    if (!ignoreRotation) s = s - rotationPenalty(pid, recentSet);

    candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
  }

  candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
  return candidates;
}

// -------------------- LINKS + IMAGES --------------------
function mapsPlaceUrl(lat, lon) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lon)}`;
}
function mapsDirUrl(oLat, oLon, dLat, dLon) {
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(oLat + "," + oLon)}&destination=${encodeURIComponent(dLat + "," + dLon)}&travelmode=driving`;
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
function restaurantsUrl(q) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q + " ristoranti")}`;
}
function wikiUrl(title) {
  return `https://it.wikipedia.org/w/index.php?search=${encodeURIComponent(title)}`;
}
function eventsUrl(q) {
  return `https://www.google.com/search?q=${encodeURIComponent("eventi " + q)}`;
}

// OSM static map image (no API key)
function osmStaticImg(lat, lon, z = 12) {
  const size = "720x360";
  const marker = `${lat},${lon},lightblue1`;
  return `https://staticmap.openstreetmap.de/staticmap.php?center=${encodeURIComponent(lat + "," + lon)}&zoom=${encodeURIComponent(z)}&size=${encodeURIComponent(size)}&maptype=mapnik&markers=${encodeURIComponent(marker)}`;
}

// -------------------- Monetization URLs --------------------
function bookingUrl(q, affId = "") {
  const base = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(q)}`;
  return affId ? `${base}&aid=${encodeURIComponent(affId)}` : base;
}
function getYourGuideUrl(q, affId = "") {
  const base = `https://www.getyourguide.com/s/?q=${encodeURIComponent(q)}`;
  return affId ? `${base}&partner_id=${encodeURIComponent(affId)}` : base;
}
function tiqetsUrl(q, affId = "") {
  const base = `https://www.tiqets.com/en/search/?query=${encodeURIComponent(q)}`;
  return affId ? `${base}&partner=${encodeURIComponent(affId)}` : base;
}
function amazonEssentialsUrl(tag = "") {
  const base = `https://www.amazon.it/s?k=${encodeURIComponent("accessori viaggio bambini")}`;
  return tag ? `${base}&tag=${encodeURIComponent(tag)}` : base;
}

// -------------------- CARD HELPERS --------------------
function typeBadge(place, category) {
  const t = String(place?.type || "").toLowerCase();
  const tags = placeTags(place);
  const n = normName(place?.name);

  if (category === "family") {
    if (tags.includes("theme_park") || n.includes("parco divertimenti")) return { emoji: "🎢", label: "Parco divertimenti" };
    if (isWaterPark(place)) return { emoji: "💦", label: "Parco acquatico" };
    if (tags.includes("zoo") || n.includes("zoo")) return { emoji: "🦁", label: "Zoo" };
    if (tags.includes("aquarium") || n.includes("acquario")) return { emoji: "🐠", label: "Acquario" };
    if (isThermeSpa(place)) return { emoji: "♨️", label: "Terme / Spa" };
    if (tags.includes("swimming_pool") || n.includes("piscina")) return { emoji: "🏊", label: "Piscina" };
    if (tags.includes("attraction")) return { emoji: "🎯", label: "Attrazione" };
    return { emoji: "👨‍👩‍👧‍👦", label: "Family" };
  }

  if (category === "storia" || t === "storia") {
    if (tags.includes("castle") || n.includes("castello") || n.includes("rocca")) return { emoji: "🏰", label: "Castello / Rocca" };
    if (tags.includes("museum") || n.includes("museo")) return { emoji: "🖼️", label: "Museo" };
    if (n.includes("abbazia") || n.includes("monastero") || n.includes("chiesa") || n.includes("duomo") || n.includes("basilica")) return { emoji: "⛪", label: "Abbazia / Chiesa" };
    if (tags.includes("archaeological_site") || n.includes("archeolog")) return { emoji: "🏺", label: "Archeologia" };
    if (tags.includes("tower") || n.includes("torre")) return { emoji: "🗼", label: "Torre / Forte" };
    return { emoji: "🏛️", label: "Storia" };
  }

  if (t === "mare") return { emoji: "🌊", label: "Mare" };
  if (t === "montagna") return { emoji: "🏔️", label: "Montagna" };
  if (t === "natura") return { emoji: "🌿", label: "Natura" };
  if (t === "borgo") return { emoji: "🏘️", label: "Borgo" };
  if (t === "citta" || t === "city") return { emoji: "🏙️", label: "Città" };
  if (isThermeSpa(place)) return { emoji: "♨️", label: "Terme / Spa" };

  return { emoji: "📍", label: "Meta" };
}

function microWhatToDo(place, category) {
  const tags = placeTags(place);
  const n = normName(place?.name);

  if (category === "family") {
    if (tags.includes("theme_park") || n.includes("parco divertimenti")) return "Giostre, spettacoli, aree kids, adrenalina e foto.";
    if (isWaterPark(place)) return looksIndoor(place) ? "Scivoli e piscine indoor (ok anche in inverno)." : "Scivoli e piscine (stagionale).";
    if (tags.includes("zoo") || n.includes("zoo")) return "Animali, percorsi, aree bimbi, show e ristoro.";
    if (tags.includes("aquarium") || n.includes("acquario")) return "Vasche, tunnel, show, perfetto con bambini.";
    if (isThermeSpa(place)) return "Relax, piscine termali, area benessere (spesso family-friendly).";
    if (tags.includes("swimming_pool") || n.includes("piscina")) return "Nuoto, area bimbi, pomeriggio facile.";
    if (tags.includes("attraction")) return "Attrazione turistica: visita, foto, attività in zona.";
    return "Gita facile: attività, cibo, cose da fare in zona.";
  }

  if (category === "storia") {
    if (n.includes("abbazia") || n.includes("monastero")) return "Visita, architettura, storia e atmosfera.";
    if (n.includes("castello") || n.includes("rocca")) return "Panorama, mura, visita e foto top.";
    if (n.includes("museo")) return "Mostre, collezioni, visita culturale.";
    if (n.includes("archeolog")) return "Resti, percorso, storia antica.";
    return "Visita culturale: centro storico, monumenti e luoghi iconici.";
  }

  if (tags.includes("viewpoint")) return "Belvedere: panorama e foto.";
  if (tags.includes("museum")) return "Museo: visita culturale.";
  return "Esplora, foto, cibo e cose da fare nei dintorni.";
}

function chipsFromPlace(place, category) {
  const chips = [];
  const tags = placeTags(place);
  const n = normName(place?.name);

  const push = (x) => { if (x && !chips.includes(x)) chips.push(x); };

  if (category === "family") {
    if (tags.includes("theme_park") || n.includes("parco divertimenti")) push("🎢 Theme Park");
    if (isWaterPark(place)) push(isWinterNow() && !looksIndoor(place) ? "❄️ Stagionale" : "💦 Water Park");
    if (looksIndoor(place)) push("🏠 Indoor");
    if (tags.includes("zoo") || n.includes("zoo")) push("🦁 Zoo");
    if (tags.includes("aquarium") || n.includes("acquario")) push("🐠 Acquario");
    if (isThermeSpa(place)) push("♨️ Terme");
    if (tags.includes("attraction")) push("🎯 Attrazione");
  } else if (category === "storia") {
    if (n.includes("castello") || n.includes("rocca") || tags.includes("castle")) push("🏰 Castello");
    if (n.includes("abbazia") || n.includes("monastero")) push("⛪ Abbazia");
    if (tags.includes("museum") || n.includes("museo")) push("🖼️ Museo");
    if (tags.includes("archaeological_site") || n.includes("archeolog")) push("🏺 Archeologia");
  }

  if (tags.includes("attraction")) push("📸 Foto top");
  if (tags.includes("viewpoint")) push("👀 Panorama");
  if (tags.includes("nature_reserve") || tags.includes("national_park")) push("🌿 Natura");

  return chips.slice(0, 5);
}

function monetBoxHtml(placeName, country = "") {
  const q = country ? `${placeName}, ${country}` : placeName;

  return `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">💸 Prenota al volo</div>

      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn" target="_blank" rel="noopener" href="${bookingUrl(q, BOOKING_AID)}">🏨 Hotel</a>
        <a class="btn" target="_blank" rel="noopener" href="${getYourGuideUrl(q, GYG_PID)}">🎟️ Tour</a>
        <a class="btn" target="_blank" rel="noopener" href="${tiqetsUrl(q, TIQETS_PID)}">🏛️ Biglietti</a>
        <a class="btn" target="_blank" rel="noopener" href="${amazonEssentialsUrl(AMAZON_TAG)}">🧳 Essentials</a>
      </div>

      <div class="small muted" style="margin-top:8px;">
        (Inserisci i tuoi ID in app.js: BOOKING_AID / GYG_PID / TIQETS_PID / AMAZON_TAG)
      </div>
    </div>
  `;
}

// -------------------- RENDER --------------------
function renderResult(origin, maxMinutesShown, chosen, alternatives, meta = {}) {
  const area = $("resultArea");
  if (!area) return;

  if (!chosen) {
    area.innerHTML = `
      <div class="card errbox">
        <div class="small">❌ Nessuna meta trovata entro ${maxMinutesShown} min con i filtri attuali.</div>
        <div class="small muted" style="margin-top:6px;">Prova ad aumentare i minuti o cambiare categoria.</div>
        <div class="row wrap gap" style="margin-top:12px;">
          <button class="btn btn-ghost" id="btnResetRotation">🧽 Reset “proposte di oggi”</button>
        </div>
      </div>
    `;
    $("btnResetRotation")?.addEventListener("click", () => {
      resetRotation();
      showStatus("ok", "Reset fatto ✅ Ora ti ripropongo mete anche già viste oggi.");
      runSearch({ silent: true });
    });
    return;
  }

  const p = chosen.place;
  const pid = chosen.pid;
  const country = p.country || p.area || "—";
  const badge = String(p.visibility || "").toLowerCase() === "chicca" ? "✨ chicca" : "✅ classica";

  const category = meta?.category || getActiveCategory();
  const tb = typeBadge(p, category);
  const what = microWhatToDo(p, category);
  const chips = chipsFromPlace(p, category);

  const lat = Number(p.lat);
  const lon = Number(p.lon ?? p.lng);
  const mapImg = osmStaticImg(lat, lon, chosen.km < 20 ? 12 : chosen.km < 60 ? 10 : 8);

  const liveLabel =
    meta?.liveUsed ? "live: sì" :
    (meta?.liveAttempted ? "live: tentato" : "live: no");

  const q = country ? `${p.name}, ${country}` : p.name;

  area.innerHTML = `
    <div class="card okbox" style="overflow:hidden; padding:0;">
      <div style="position:relative;">
        <img src="${mapImg}" alt="mappa ${p.name}" style="width:100%; display:block; border-bottom:1px solid var(--border);">
        <div style="position:absolute; left:12px; top:12px; display:flex; gap:8px; flex-wrap:wrap;">
          <div class="pill">${tb.emoji} ${tb.label}</div>
          <div class="pill">🚗 ~${chosen.driveMin} min • ${fmtKm(chosen.km)}</div>
          <div class="pill">${badge}</div>
          ${category === "family" && isWaterPark(p) && isWinterNow() && !looksIndoor(p) ? `<div class="pill">❄️ stagionale</div>` : ""}
        </div>
      </div>

      <div style="padding:14px;">
        <div class="resultTitle" style="font-size:28px; margin:0;">${p.name} <span class="small muted">(${country})</span></div>

        <div class="small muted" style="margin-top:6px;">
          ${liveLabel}${Number.isFinite(meta?.liveCount) ? ` • live_items: ${meta.liveCount}` : ""}
          ${meta?.macroFile ? ` • macro: ${meta.macroFile}` : ""}
          • score: ${chosen.score}
        </div>

        <div style="margin-top:10px; font-weight:800;">Cosa si fa</div>
        <div class="small muted" style="margin-top:4px; line-height:1.35;">${what}</div>

        ${chips.length ? `
          <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">
            ${chips.map(c => `<div class="pill">${c}</div>`).join("")}
          </div>
        ` : ""}

        <div class="row wrap gap" style="margin-top:12px;">
          <a class="btn" target="_blank" rel="noopener" href="${mapsPlaceUrl(lat, lon)}">🗺️ Maps</a>
          <a class="btn" target="_blank" rel="noopener" href="${mapsDirUrl(origin.lat, origin.lon, lat, lon)}">🚗 Percorso</a>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleImagesUrl(q)}">📸 Foto</a>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleThingsToDoUrl(q)}">👀 Cosa vedere</a>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleDoUrl(q)}">🎯 Cosa fare</a>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${restaurantsUrl(q)}">🍝 Ristoranti</a>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${wikiUrl(q)}">📚 Wiki</a>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${eventsUrl(q)}">📅 Eventi</a>
        </div>

        <div class="row wrap gap" style="margin-top:12px;">
          <button class="btn btn-ghost" id="btnVisited">✅ Già visitato</button>
          <button class="btn" id="btnChange">🔁 Cambia meta</button>
          <button class="btn btn-ghost" id="btnResetRotation">🧽 Reset “oggi”</button>
        </div>
      </div>
    </div>

    ${monetBoxHtml(p.name, country)}
  `;

  // rotation tracking
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
}

// -------------------- MAIN SEARCH (PROGRESSIVE) --------------------
async function runSearch({ silent = false, forbidPid = null } = {}) {
  const token = nextRunToken();

  try {
    if (!silent) hideStatus();

    const origin = getOrigin();
    if (!origin || !Number.isFinite(Number(origin.lat)) || !Number.isFinite(Number(origin.lon))) {
      showStatus("err", "Imposta una partenza: GPS oppure scrivi un luogo e premi “Usa questo luogo”.");
      return;
    }

    const maxMinutesInput = clamp(Number($("maxMinutes")?.value) || 120, 10, 600);
    const category = getActiveCategory();
    const styles = getActiveStyles();
    const effMax = effectiveMaxMinutes(maxMinutesInput, category);

    clearResultAreaWithSpinner(
      category === "family" ? "🔎 Cerco attrazioni family…" :
      (category === "storia" ? "🔎 Cerco luoghi storici…" : "🔎 Cerco mete…")
    );
    setLoadingUI(true, "🔎 Cerco…");

    await ensureMacroLoaded();
    if (isStaleToken(token)) return;

    const macroPlaces = Array.isArray(MACRO?.places) ? MACRO.places : [];

    // 1) Macro candidates (FAST)
    let macroCandidates = buildCandidatesFromPlaces(macroPlaces, origin, effMax, category, styles, {
      ignoreVisited: false, ignoreRotation: false
    });

    if (forbidPid && macroCandidates[0]?.pid === forbidPid) {
      SESSION_SEEN.add(forbidPid);
      macroCandidates = macroCandidates.filter(c => c.pid !== forbidPid);
    }

    const macroChosen = macroCandidates[0] || null;
    const macroAlts = macroCandidates.slice(1, 3);

    if (macroChosen && !isStaleToken(token)) {
      renderResult(origin, maxMinutesInput, macroChosen, macroAlts, {
        category,
        liveUsed: false,
        liveAttempted: false,
        liveCount: null,
        macroFile: MACRO_SOURCE_URL ? MACRO_SOURCE_URL.split("/").pop() : ""
      });
      showStatus("ok", "Proposta immediata ✅ (offline). Cerco anche live…");
    }

    // 2) Live: needed if few OR family OR storia
    const needLive = (macroCandidates.length < 12) || (category === "family") || (category === "storia");

    let liveAttempted = false;
    let liveUsed = false;
    let liveCount = null;

    if (needLive) {
      liveAttempted = true;

      const base = clamp(Math.round((effMax / 60) * 45), 10, 130);
      const famBoost = category === "family" ? 1.15 : 1.0;
      const storiaBoost = category === "storia" ? 1.35 : 1.0;

      const r1 = clamp(Math.round(base * famBoost * storiaBoost), 12, 180);
      const r2 = clamp(Math.round(base * 1.55 * famBoost * storiaBoost), 18, 240);

      const tryLive = async (radiusKm) => {
        const livePlaces = await fetchLivePlaces(origin, radiusKm, category, token);
        if (isStaleToken(token)) return { places: [], radiusKm };
        return { places: livePlaces, radiusKm };
      };

      let { places: live1 } = await tryLive(r1);
      if (isStaleToken(token)) return;

      let livePlaces = live1;
      if (livePlaces.length < 30) {
        const { places: live2 } = await tryLive(r2);
        if (isStaleToken(token)) return;
        if (live2.length > livePlaces.length) livePlaces = live2;
      }

      liveCount = livePlaces.length;

      if (livePlaces.length) {
        liveUsed = true;

        // Merge macro + live (dedupe)
        const byKey = new Map();
        for (const p of macroPlaces) byKey.set(safeIdFromPlace(p), p);
        for (const p of livePlaces) {
          const k = safeIdFromPlace(p);
          if (!byKey.has(k)) byKey.set(k, p);
        }
        const mergedPlaces = [...byKey.values()];

        let liveCandidates = buildCandidatesFromPlaces(mergedPlaces, origin, effMax, category, styles, {
          ignoreVisited: false, ignoreRotation: false
        });

        if (forbidPid && liveCandidates[0]?.pid === forbidPid) {
          SESSION_SEEN.add(forbidPid);
          liveCandidates = liveCandidates.filter(c => c.pid !== forbidPid);
        }

        if (!liveCandidates.length) {
          liveCandidates = buildCandidatesFromPlaces(mergedPlaces, origin, Math.round(effMax * 1.15), category, styles, {
            ignoreVisited: false, ignoreRotation: true
          });
        }
        if (!liveCandidates.length) {
          liveCandidates = buildCandidatesFromPlaces(mergedPlaces, origin, Math.round(effMax * 1.25), category, styles, {
            ignoreVisited: true, ignoreRotation: true
          });
        }

        if (isStaleToken(token)) return;

        const liveChosen = liveCandidates[0] || null;
        const liveAlts = liveCandidates.slice(1, 3);

        const shouldReplace =
          !macroChosen ||
          (category === "storia" && liveChosen) ||
          (liveChosen && liveChosen.score > (macroChosen?.score ?? 0) + 0.03);

        if (shouldReplace && liveChosen) {
          renderResult(origin, maxMinutesInput, liveChosen, liveAlts, {
            category,
            liveUsed: true,
            liveAttempted: true,
            liveCount,
            macroFile: MACRO_SOURCE_URL ? MACRO_SOURCE_URL.split("/").pop() : ""
          });
        } else if (macroChosen) {
          renderResult(origin, maxMinutesInput, macroChosen, macroAlts, {
            category,
            liveUsed: false,
            liveAttempted: true,
            liveCount,
            macroFile: MACRO_SOURCE_URL ? MACRO_SOURCE_URL.split("/").pop() : ""
          });
        }
      } else if (macroChosen && !isStaleToken(token)) {
        renderResult(origin, maxMinutesInput, macroChosen, macroAlts, {
          category,
          liveUsed: false,
          liveAttempted: true,
          liveCount: 0,
          macroFile: MACRO_SOURCE_URL ? MACRO_SOURCE_URL.split("/").pop() : ""
        });
      }
    }

    if (isStaleToken(token)) return;
    setLoadingUI(false);

    const liveTxt =
      liveUsed ? `live: sì (${liveCount ?? "?"})` :
      (liveAttempted ? `live: tentato (${liveCount ?? "?"})` : "live: no");

    showStatus("ok", `Ok ✅ • ${liveTxt}`);

  } catch (e) {
    console.error(e);
    if (!isStaleToken(token)) {
      setLoadingUI(false);
      showStatus("err", `Errore: ${String(e.message || e)}`);
    }
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
        setOrigin({ label: "La mia posizione", lat, lon, country_code: "" });
        showStatus("ok", "Partenza GPS impostata ✅");
        MACRO = null;
        await ensureMacroLoaded().catch(() => {});
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

      setOrigin({
        label: result.label || label,
        lat: result.lat,
        lon: result.lon,
        country_code: result.country_code || ""
      });

      showStatus("ok", "Partenza impostata ✅");
      MACRO = null;
      await ensureMacroLoaded().catch(() => {});
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

// chips
initChips("timeChips", { multi: false });
initChips("categoryChips", { multi: false });
initChips("styleChips", { multi: true });

initTimeChipsSync();
restoreOrigin();
bindOriginButtons();
bindMainButtons();

loadMacrosIndexSafe().catch(() => {});
ensureMacroLoaded().catch(() => {});
hideStatus();
