/* Jamo — Auto-only — app.js v5.0 (HYBRID: Macro + Overpass fallback)
 * - Uses offline macros for curated destinations
 * - If few candidates near: calls /api/destinations?cat=... for live nearby POIs/places
 * - Merges + ranks in one flow
 * - DOM-safe
 */

const $ = (id) => document.getElementById(id);

// -------------------- DATA SOURCES --------------------
const MACROS_INDEX_URL = "/data/macros/macros_index.json";
const FALLBACK_MACRO_URLS = [
  "/data/macros/euuk_macro_all.json",
  "/data/macros/it_macro_01_abruzzo.json",
];

// LIVE nearby (Overpass proxy)
const LIVE_DESTINATIONS_API = "/api/destinations";

// -------------------- ROUTING / ESTIMATOR --------------------
const ROAD_FACTOR = 1.22;
const AVG_KMH = 70;

// overhead scalable
function overheadMinFromKm(km) {
  if (km < 3) return 2;
  if (km < 10) return 4;
  if (km < 30) return 6;
  return 8;
}

const MIN_KM_AVOID_SAME_PLACE = 0.2; // 200m (avoid “sei già lì”)

// -------------------- ROTATION --------------------
const RECENT_TTL_MS = 1000 * 60 * 60 * 20; // ~20h
const RECENT_MAX = 160;
let SESSION_SEEN = new Set();
let LAST_SHOWN_PID = null;

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

// -------------------- MAPS + INFO LINKS --------------------
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

// -------------------- STORAGE: origin + visited + recent --------------------
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
    // country_code may be stored in localStorage
    const raw = localStorage.getItem("jamo_origin");
    if (raw) {
      try {
        const o = JSON.parse(raw);
        return { label, lat, lon, country_code: o?.country_code || "" };
      } catch {}
    }
    return { label, lat, lon, country_code: "" };
  }

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

// -------------------- UI state (chips) --------------------
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
  try {
    MACROS_INDEX = await fetchJson(MACROS_INDEX_URL);
    return MACROS_INDEX;
  } catch {
    MACROS_INDEX = null;
    return null;
  }
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

// pick macro: country first (if macros_index has it), else all
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

  // country macro if available in index
  if (cc && MACROS_INDEX?.items?.length) {
    const wantId = `euuk_country_${cc.toLowerCase()}`;
    const item = MACROS_INDEX.items.find(x => x.id === wantId || String(x.path || "").includes(`${wantId}.json`));
    if (item?.path) candidates.push(item.path);
  }

  // all EU/UK macro if available
  if (MACROS_INDEX?.items?.length) {
    const euukAll = MACROS_INDEX.items.find(x => x.id === "euuk_macro_all" || String(x.path || "").includes("euuk_macro_all.json"));
    if (euukAll?.path) candidates.push(euukAll.path);
  }

  // fallbacks that MUST exist
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

// -------------------- GEOCODING --------------------
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
  return j.result; // includes country_code (v2.1)
}

// -------------------- FILTERS --------------------
function placeTags(place) {
  return (place.tags || []).map(t => String(t).toLowerCase());
}

function isFamilyPlace(place) {
  const tags = placeTags(place);
  const t = String(place.type || "").toLowerCase();
  if (t === "family" || t === "bambini") return true;
  if (tags.includes("famiglie") || tags.includes("family") || tags.includes("bambini") || tags.includes("animali")) return true;
  if (place.family && (place.family.bimbi || place.family.ragazzi || (Number(place.family.score) || 0) >= 0.2)) return true;

  const n = normName(place.name);
  if (n.includes("parco") || n.includes("zoo") || n.includes("acquario") || n.includes("playground") || n.includes("piscina") || n.includes("water park")) return true;

  return false;
}

function matchesCategory(place, cat) {
  if (!cat || cat === "ovunque") return true;

  const type = String(place.type || "").toLowerCase();
  const tags = placeTags(place);
  const n = normName(place.name);

  if (cat === "citta") return type === "citta" || tags.includes("citta") || tags.includes("city") || tags.includes("town");
  if (cat === "borghi") return type === "borgo" || tags.includes("borgo") || tags.includes("village") || n.includes("borgo") || n.includes("old town");
  if (cat === "mare") return (
    type === "mare" ||
    tags.includes("mare") ||
    tags.includes("spiaggia") ||
    tags.includes("beach") ||
    tags.includes("beach_resort") ||
    n.includes("spiaggia") ||
    n.includes("beach")
  );
  if (cat === "montagna") return (
    type === "montagna" ||
    tags.includes("montagna") ||
    tags.includes("neve") ||
    tags.includes("peak") ||
    n.includes("monte") ||
    n.includes("mount")
  );
  if (cat === "natura") return (
    type === "natura" ||
    tags.includes("natura") ||
    tags.includes("parco") ||
    tags.includes("nature_reserve") ||
    tags.includes("national_park") ||
    tags.includes("waterfall") ||
    tags.includes("viewpoint") ||
    n.includes("parco") ||
    n.includes("waterfall")
  );
  if (cat === "storia") return (
    type === "storia" ||
    tags.includes("storia") ||
    tags.includes("castello") ||
    tags.includes("museum") ||
    tags.includes("attraction") ||
    tags.includes("castle") ||
    n.includes("castello") ||
    n.includes("museum")
  );
  if (cat === "relax") return type === "relax" || tags.includes("relax") || tags.includes("spa") || tags.includes("terme");
  if (cat === "family") return isFamilyPlace(place);

  return true;
}

function matchesStyle(place, { wantChicche, wantClassici }) {
  const vis = String(place.visibility || "").toLowerCase();
  if (!wantChicche && !wantClassici) return true;
  if (vis === "chicca") return !!wantChicche;
  return !!wantClassici;
}

function baseScorePlace({ driveMin, targetMin, beautyScore, familyBoost, isChicca }) {
  const t = clamp(1 - Math.abs(driveMin - targetMin) / Math.max(25, targetMin * 0.9), 0, 1);
  const b = clamp(Number(beautyScore) || 0.70, 0.35, 1);
  const c = isChicca ? 0.05 : 0;
  const f = clamp(familyBoost || 0, 0, 0.12);
  return 0.58 * t + 0.33 * b + c + f;
}

function rotationPenalty(pid, recentSet) {
  let pen = 0;
  if (pid && pid === LAST_SHOWN_PID) pen += 0.22;
  if (SESSION_SEEN.has(pid)) pen += 0.18;
  if (recentSet.has(pid)) pen += 0.10;
  return pen;
}

// -------------------- TIME SMART WIDENING --------------------
function effectiveMaxMinutes(maxMinutes, category) {
  const m = Number(maxMinutes);
  if (!Number.isFinite(m)) return 120;

  if (category === "family" && m < 60) return clamp(Math.round(m * 1.35), m, 160);
  if (category === "mare" && m < 75) return clamp(Math.round(m * 1.30), m, 180);
  if (category === "storia" && m < 45) return clamp(Math.round(m * 1.20), m, 140);

  return clamp(m, 10, 600);
}

// -------------------- LIVE (OVERPASS) CACHE --------------------
const LIVE_CACHE = new Map(); // key -> {ts, places[]}
const LIVE_TTL_MS = 1000 * 60 * 8; // 8 min

function liveKey(origin, radiusKm, cat) {
  const la = Number(origin.lat).toFixed(3);
  const lo = Number(origin.lon).toFixed(3);
  return `${cat}|${radiusKm}|${la}|${lo}`;
}

// map UI category -> api cat
function apiCatFromUi(cat) {
  // your chips: family/borghi/citta/mare/natura/storia/ovunque
  if (!cat) return "ovunque";
  const c = String(cat).toLowerCase();
  const allowed = new Set(["family", "borghi", "citta", "mare", "natura", "storia", "ovunque"]);
  return allowed.has(c) ? c : "ovunque";
}

function pickNameFromTags(tags = {}) {
  return tags.name || tags["name:it"] || tags["name:en"] || tags["brand"] || "";
}

function tagsToArray(tagsObj = {}) {
  const out = [];
  const push = (x) => { if (x && !out.includes(x)) out.push(x); };

  // common classifiers
  push(tagsObj.tourism);
  push(tagsObj.leisure);
  push(tagsObj.amenity);
  push(tagsObj.natural);
  push(tagsObj.historic);
  push(tagsObj.sport);
  push(tagsObj.attraction);

  // add some friendly tags
  if (tagsObj.place) push(tagsObj.place);
  if (tagsObj.boundary) push(tagsObj.boundary);

  return out.filter(Boolean).map(x => String(x).toLowerCase()).slice(0, 14);
}

function inferTypeFromTags(tagsObj = {}) {
  // normalize to your app categories
  const t = (k) => String(tagsObj[k] || "").toLowerCase();

  if (t("tourism") === "theme_park" || t("leisure") === "water_park") return "family";
  if (t("leisure") === "swimming_pool" || t("sport") === "swimming") return "family";
  if (t("amenity") === "zoo" || t("amenity") === "aquarium") return "family";
  if (t("leisure") === "playground" || t("tourism") === "picnic_site") return "family";

  if (t("natural") === "beach" || t("leisure") === "beach_resort" || t("amenity") === "bathing_place") return "mare";

  if (t("historic") === "castle" || t("historic") === "ruins" || t("tourism") === "museum") return "storia";

  if (t("boundary") === "national_park" || t("leisure") === "nature_reserve" || t("natural") === "waterfall" || t("tourism") === "viewpoint" || t("natural") === "peak") return "natura";

  if (t("place") === "village" || t("place") === "hamlet") return "borgo";
  if (t("place") === "city" || t("place") === "town") return "citta";

  if (t("tourism") === "attraction") return "storia";
  return "meta";
}

function elementToPlace(el) {
  const tags = el?.tags || {};
  const name = pickNameFromTags(tags);
  if (!name) return null;

  // coordinates:
  // - node: el.lat/el.lon
  // - way/relation: el.center.lat/el.center.lon (because we use out center)
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const type = inferTypeFromTags(tags);
  const tagArr = tagsToArray(tags);

  // minimal "place" object compatible with your pipeline
  return {
    id: `osm_${el.type}_${el.id}`,
    name: name,
    lat,
    lon,
    type,
    visibility: "classica",
    tags: tagArr,
    // mild beauty baseline; can be tuned
    beauty_score: 0.62
  };
}

async function fetchLivePlaces(origin, radiusKm, uiCategory) {
  const cat = apiCatFromUi(uiCategory);
  const key = liveKey(origin, radiusKm, cat);
  const hit = LIVE_CACHE.get(key);
  const now = Date.now();
  if (hit && now - hit.ts < LIVE_TTL_MS) return hit.places;

  const url = `${LIVE_DESTINATIONS_API}?lat=${encodeURIComponent(origin.lat)}&lon=${encodeURIComponent(origin.lon)}&radiusKm=${encodeURIComponent(radiusKm)}&cat=${encodeURIComponent(cat)}`;
  const r = await fetch(url, { method: "GET" });
  const j = await r.json().catch(() => null);

  // compatible: {ok:true, data:{elements:[]}}
  const elements = j?.data?.elements || j?.elements || [];
  const places = Array.isArray(elements)
    ? elements.map(elementToPlace).filter(Boolean)
    : [];

  // de-dup by id
  const seen = new Set();
  const uniq = places.filter(p => (seen.has(p.id) ? false : (seen.add(p.id), true)));

  LIVE_CACHE.set(key, { ts: now, places: uniq });
  return uniq;
}

// -------------------- CANDIDATES (macro + live merge) --------------------
function buildCandidatesFromPlaces(placesArr, origin, maxMinutes, category, styles, { ignoreVisited = false, ignoreRotation = false } = {}) {
  const visited = getVisitedSet();
  const recentSet = getRecentSet();
  const target = Number(maxMinutes);

  const oLat = Number(origin.lat);
  const oLon = Number(origin.lon);

  const candidates = [];

  for (const p of placesArr) {
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
    if (km < MIN_KM_AVOID_SAME_PLACE) continue;

    const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
    const familyBoost =
      (category === "family" || isFamilyPlace(p))
        ? clamp((Number(p.family?.score) || 0.3) * 0.12, 0, 0.12)
        : 0;

    let s = baseScorePlace({
      driveMin,
      targetMin: target,
      beautyScore: p.beauty_score,
      familyBoost,
      isChicca
    });

    if (!ignoreRotation) s = s - rotationPenalty(pid, recentSet);

    candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
  }

  candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
  return candidates;
}

function pickFromCandidates(origin, maxMinutesShown, candidates, meta) {
  const chosen = candidates[0] || null;
  const alternatives = candidates.slice(1, 3);
  return { chosen, alternatives, totalCandidates: candidates.length, meta };
}

// -------------------- RENDER --------------------
function quickLinksHtml(place, origin) {
  const name = place?.name || "";
  const country = place?.country || place?.area || "";
  const q = country ? `${name}, ${country}` : name;

  const lat = Number(place.lat);
  const lon = Number(place.lon ?? place.lng);

  const placeUrl = mapsPlaceUrl(lat, lon);
  const dirUrl = mapsDirUrl(origin.lat, origin.lon, lat, lon);

  return `
    <div class="card" style="margin-top:12px;">
      <div class="row wrap gap" style="margin-top:2px;">
        <a class="btn" target="_blank" rel="noopener" href="${placeUrl}">🗺️ Maps</a>
        <a class="btn" target="_blank" rel="noopener" href="${dirUrl}">🚗 Percorso</a>
      </div>

      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleImagesUrl(q)}">📸 Foto</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleThingsToDoUrl(q)}">👀 Cosa vedere</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleDoUrl(q)}">🎯 Cosa fare</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${restaurantsUrl(q)}">🍝 Ristoranti</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${wikiUrl(q)}">📚 Wiki</a>
      </div>

      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${eventsUrl(q)}">📅 Eventi</a>
      </div>
    </div>
  `;
}

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

  area.innerHTML = `
    <div class="card okbox">
      <div class="pill">🚗 auto • ~${chosen.driveMin} min • ${fmtKm(chosen.km)} • ${badge}</div>
      <div class="resultTitle">${p.name} <span class="small muted">(${country})</span></div>

      <div class="small muted" style="margin-top:6px;">
        Categoria: <b>${p.type || "meta"}</b> • Punteggio: <b>${chosen.score}</b>
        ${meta?.macroFile ? ` • <span class="muted">macro: ${meta.macroFile}</span>` : ""}
        ${meta?.liveUsed ? ` • <span class="muted">live: sì</span>` : ` • <span class="muted">live: no</span>`}
      </div>

      <div class="row wrap gap" style="margin-top:12px;">
        <button class="btn btn-ghost" id="btnVisited">✅ Già visitato</button>
        <button class="btn" id="btnChange">🔁 Cambia meta</button>
        <button class="btn btn-ghost" id="btnResetRotation">🧽 Reset “oggi”</button>
      </div>
    </div>

    ${quickLinksHtml(p, origin)}
    ${alternatives?.length ? `
      <div class="card" style="margin-top:12px;">
        <div class="small muted">Alternative</div>
        <div style="margin-top:10px; display:flex; flex-direction:column; gap:10px;">
          ${alternatives.map(a => {
            const ap = a.place;
            const alat = Number(ap.lat);
            const alon = Number(ap.lon ?? ap.lng);
            return `
              <div class="card" style="padding:12px; border-color: rgba(255,255,255,.14);">
                <div style="font-weight:900; font-size:16px; line-height:1.2;">${ap.name}</div>
                <div class="small muted" style="margin-top:4px;">~${a.driveMin} min • ${fmtKm(a.km)} • ${ap.type || "meta"}</div>
                <div class="row wrap gap" style="margin-top:10px;">
                  <a class="btn btn-ghost" href="${mapsPlaceUrl(alat, alon)}" target="_blank" rel="noopener">Maps</a>
                  <a class="btn btn-ghost" href="${googleImagesUrl(ap.name)}" target="_blank" rel="noopener">Foto</a>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    ` : ""}
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

// -------------------- MAIN SEARCH (HYBRID) --------------------
async function runSearch({ silent = false, forbidPid = null } = {}) {
  try {
    if (!silent) hideStatus();

    // make sure macro is loaded
    await ensureMacroLoaded();

    const origin = getOrigin();
    if (!origin || !Number.isFinite(Number(origin.lat)) || !Number.isFinite(Number(origin.lon))) {
      showStatus("err", "Imposta una partenza: GPS oppure scrivi un luogo e premi “Usa questo luogo”.");
      return;
    }

    const maxMinutesInput = clamp(Number($("maxMinutes")?.value) || 120, 10, 600);
    const category = getActiveCategory();
    const styles = getActiveStyles();
    const effMax = effectiveMaxMinutes(maxMinutesInput, category);

    // 1) candidates from macro
    const macroPlaces = Array.isArray(MACRO?.places) ? MACRO.places : [];
    let candidates = buildCandidatesFromPlaces(macroPlaces, origin, effMax, category, styles, { ignoreVisited: false, ignoreRotation: false });

    // 2) Decide if we need LIVE fallback
    // Trigger live if:
    // - few candidates
    // - or category is family (activity density needed)
    const needLive = (candidates.length < 10) || (category === "family");

    let liveUsed = false;
    let mergedPlaces = macroPlaces;

    if (needLive) {
      // radius for live: based on minutes (rough)
      const radiusKm = clamp(Math.round((effMax / 60) * 55), 8, 80);

      const livePlaces = await fetchLivePlaces(origin, radiusKm, category);

      if (livePlaces.length) {
        liveUsed = true;

        // merge: macro first + live
        const byId = new Map();
        for (const p of macroPlaces) byId.set(safeIdFromPlace(p), p);
        for (const p of livePlaces) {
          const pid = safeIdFromPlace(p);
          if (!byId.has(pid)) byId.set(pid, p);
        }
        mergedPlaces = [...byId.values()];

        // rebuild candidates with merged
        candidates = buildCandidatesFromPlaces(mergedPlaces, origin, effMax, category, styles, { ignoreVisited: false, ignoreRotation: false });
      }
    }

    // 3) forbid specific pid (cambia meta)
    if (forbidPid && candidates[0]?.pid === forbidPid) {
      // mark as seen temporarily and re-pick
      SESSION_SEEN.add(forbidPid);
      candidates = candidates.filter(c => c.pid !== forbidPid);
    }

    // 4) if still empty, loosen rotation/visited
    if (!candidates.length) {
      candidates = buildCandidatesFromPlaces(mergedPlaces, origin, effMax, category, styles, { ignoreVisited: false, ignoreRotation: true });
    }
    if (!candidates.length) {
      candidates = buildCandidatesFromPlaces(mergedPlaces, origin, effMax, category, styles, { ignoreVisited: true, ignoreRotation: true });
    }

    const { chosen, alternatives } = pickFromCandidates(origin, maxMinutesInput, candidates, {
      liveUsed,
      macroFile: MACRO_SOURCE_URL ? MACRO_SOURCE_URL.split("/").pop() : ""
    });

    renderResult(origin, maxMinutesInput, chosen, alternatives, { liveUsed, macroFile: MACRO_SOURCE_URL ? MACRO_SOURCE_URL.split("/").pop() : "" });

    if (!chosen) {
      showStatus("warn", `Nessuna meta entro ${maxMinutesInput} min. Prova ad aumentare i minuti o cambiare categoria.`);
    } else if (!silent) {
      const extra = (effMax !== maxMinutesInput) ? ` (ho allargato a ~${effMax} min per non lasciarti a secco)` : "";
      const liveTxt = liveUsed ? " • live vicino: sì" : "";
      showStatus("ok", `Meta trovata ✅ (~${chosen.driveMin} min)${extra}${liveTxt}`);
    }
  } catch (e) {
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

        // keep stored country_code if any; could be empty (we can geocode later if needed)
        setOrigin({ label: "La mia posizione", lat, lon, country_code: "" });
        showStatus("ok", "Partenza GPS impostata ✅");

        // reset macro so it can reload for this area
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

// init chips
initChips("timeChips", { multi: false });
initChips("categoryChips", { multi: false });
initChips("styleChips", { multi: true });

initTimeChipsSync();
restoreOrigin();
bindOriginButtons();
bindMainButtons();

// preload macro + index
loadMacrosIndexSafe().catch(() => {});
ensureMacroLoaded().catch(() => {});
hideStatus();
