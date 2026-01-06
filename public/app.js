/* Jamo — app.js v10.4 (Region offline support + macro fallback)
 * ✅ NEW:
 * - Dataset REGIONS: /data/regions/<region_id>.json (es: it-veneto)
 * - Region-first (offline & fast). If fails -> macro as before
 * - Map region schema {places:[{lat,lng,types,beauty_score,season...}]} -> Jamo place schema
 */

const $ = (id) => document.getElementById(id);

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

// -------------------- DATA SOURCES --------------------
const REGIONS_BASE_URL = "/data/regions";
// ✅ TEMP: default region for IT (we'll make it selectable next)
const DEFAULT_IT_REGION_ID = "it-veneto";

// MACROS (your existing)
const MACROS_INDEX_URL = "/data/macros/macros_index.json";
const FALLBACK_MACRO_URLS = [
  "/data/macros/euuk_macro_all.json",
  "/data/macros/euuk_country_it.json",
];

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
  if (!Number.isFinite(km)) return NaN;
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

// -------------------- STORAGE: ORIGIN --------------------
function setOrigin({ label, lat, lon, country_code }) {
  if ($("originLabel")) $("originLabel").value = label ?? "";
  if ($("originLat")) $("originLat").value = String(lat);
  if ($("originLon")) $("originLon").value = String(lon);

  const cc = String(country_code || "").toUpperCase();
  if ($("originCC")) $("originCC").value = cc;

  localStorage.setItem("jamo_origin", JSON.stringify({ label, lat, lon, country_code: cc }));

  if ($("originStatus")) {
    $("originStatus").textContent =
      `✅ Partenza: ${label || "posizione"} (${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)})${cc ? " • " + cc : ""}`;
  }
}

function getOrigin() {
  const lat = Number($("originLat")?.value);
  const lon = Number($("originLon")?.value);
  const label = ($("originLabel")?.value || "").trim();
  const ccDom = String($("originCC")?.value || "").toUpperCase();

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return { label, lat, lon, country_code: ccDom };
  }

  const raw = localStorage.getItem("jamo_origin");
  if (raw) {
    try {
      const o = JSON.parse(raw);
      if (Number.isFinite(Number(o?.lat)) && Number.isFinite(Number(o?.lon))) {
        return {
          label: String(o.label || ""),
          lat: Number(o.lat),
          lon: Number(o.lon),
          country_code: String(o.country_code || "").toUpperCase(),
        };
      }
    } catch {}
  }
  return null;
}

// -------------------- STORAGE: VISITED + RECENT --------------------
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

// -------------------- DATASET --------------------
let MACROS_INDEX = null;
let DATASET = { kind: null, source: null, places: [], meta: {} };

function normalizeVisibility(v) {
  const s = String(v || "").toLowerCase().trim();
  if (s === "chicca") return "chicca";
  return "classica";
}
function normalizeType(t) {
  const s = String(t || "").toLowerCase().trim();
  if (!s) return "";
  if (s === "borgo") return "borghi";
  if (s === "città") return "citta";
  return s;
}
function normalizePlace(p) {
  if (!p) return null;
  const lat = Number(p.lat);
  const lon = Number(p.lon ?? p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const out = { ...p };
  out.lat = lat;
  out.lon = lon;

  out.name = String(out.name || "").trim();
  out.type = normalizeType(out.type);
  out.visibility = normalizeVisibility(out.visibility);

  out.tags = Array.isArray(out.tags) ? out.tags.map(x => String(x).toLowerCase()) : [];
  out.country = String(out.country || "").toUpperCase();
  out.area = String(out.area || "");

  return out;
}

// ---------- REGIONS: map schema -> places ----------
function mapRegionPlaceToJamoPlace(rp, regionMeta) {
  // region file uses lat/lng, types[], highlights[], season[]
  const lat = Number(rp?.lat);
  const lon = Number(rp?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const name = String(rp?.name || "").trim();
  if (!name) return null;

  const typesArr = Array.isArray(rp?.types) ? rp.types.map(x => normalizeType(x)) : [];
  const primaryType = typesArr[0] || "ovunque";

  const seasonArr = Array.isArray(rp?.season) ? rp.season.map(s => String(s).toLowerCase()) : [];
  const highlightsArr = Array.isArray(rp?.highlights) ? rp.highlights.map(h => String(h).toLowerCase()) : [];

  // tags: types + season + some highlights keywords
  const tags = [
    ...typesArr.map(t => `type:${t}`),
    ...seasonArr.map(s => `season:${s}`),
  ];

  // quick enrichment for family
  const n = normName(name);
  if (n.includes("gardaland") || n.includes("parco") || n.includes("zoo") || n.includes("acquario")) {
    tags.push("family");
  }

  const beauty = Number(rp?.beauty_score);
  const visibility = Number.isFinite(beauty) && beauty >= 0.93 ? "chicca" : "classica";

  return normalizePlace({
    id: String(rp?.id || safeIdFromPlace({ name, lat, lon })),
    name,
    lat,
    lon,
    type: primaryType,
    visibility,
    beauty_score: Number.isFinite(beauty) ? beauty : 0.78,
    tags: Array.from(new Set(tags.concat(highlightsArr.map(x => `hl:${x}`)))).slice(0, 22),
    country: regionMeta?.country || "IT",
    area: regionMeta?.label_it || regionMeta?.region_id || "",
  });
}

async function tryLoadRegion(regionId, signal) {
  const rid = String(regionId || "").trim();
  if (!rid) return null;

  const url = `${REGIONS_BASE_URL}/${encodeURIComponent(rid)}.json`;
  const j = await fetchJson(url, { signal }).catch(() => null);
  if (!j || !Array.isArray(j.places) || !j.places.length) return null;

  const meta = {
    region_id: String(j.region_id || rid),
    country: String(j.country || "IT").toUpperCase(),
    label_it: String(j.label_it || ""),
    bbox_hint: j.bbox_hint || null,
  };

  const places = j.places.map(p => mapRegionPlaceToJamoPlace(p, meta)).filter(Boolean);
  if (!places.length) return null;

  return { url, meta, places };
}

// ---------- MACROS (existing) ----------
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
  const placesRaw = Array.isArray(j?.places) ? j.places : null;
  if (!placesRaw || !placesRaw.length) return null;

  const places = placesRaw.map(normalizePlace).filter(Boolean);
  if (!places.length) return null;

  return { ...j, places };
}
function findCountryMacroPath(cc) {
  if (!MACROS_INDEX?.items?.length) return null;
  const c = String(cc || "").toUpperCase();
  if (!c) return null;

  const hit1 = MACROS_INDEX.items.find(x =>
    String(x.id || "") === `euuk_country_${c.toLowerCase()}` ||
    (String(x.path || "").includes(`euuk_country_${c.toLowerCase()}.json`))
  );
  if (hit1?.path) return hit1.path;

  const hit2 = MACROS_INDEX.items.find(x =>
    String(x.id || "").toLowerCase() === `eu_${c.toLowerCase()}` ||
    String(x.path || "").includes(`eu_macro_${c.toLowerCase()}.json`)
  );
  if (hit2?.path) return hit2.path;

  return null;
}

async function ensureDatasetLoaded(origin, { signal } = {}) {
  if (DATASET?.places?.length) return DATASET;

  const cc = String(origin?.country_code || $("originCC")?.value || "").toUpperCase();

  // ✅ 0) REGION-FIRST for Italy (fast offline)
  if (cc === "IT") {
    const regionId = DEFAULT_IT_REGION_ID; // TEMP; next step: make selectable
    const region = await tryLoadRegion(regionId, signal);
    if (region) {
      DATASET = {
        kind: "region",
        source: region.url,
        places: region.places,
        meta: { region: region.meta, cc },
      };
      return DATASET;
    }
  }

  // 1) macros as before
  await loadMacrosIndexSafe(signal);

  const cPath = findCountryMacroPath(cc);
  const candidates = [];

  if (cPath) candidates.push(cPath);

  const euAll = MACROS_INDEX?.items?.find(x => x.id === "euuk_macro_all" || String(x.path || "").includes("euuk_macro_all.json"));
  if (euAll?.path) candidates.push(euAll.path);

  for (const u of FALLBACK_MACRO_URLS) candidates.push(u);

  const saved = localStorage.getItem("jamo_macro_url");
  if (saved) candidates.unshift(saved);

  const uniq = [];
  const seen = new Set();
  for (const u of candidates) {
    const s = String(u || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    uniq.push(s);
  }

  for (const url of uniq) {
    const m = await tryLoadMacro(url, signal);
    if (m) {
      DATASET = {
        kind: "macro",
        source: url,
        places: m.places,
        meta: { macro: m, cc },
      };
      localStorage.setItem("jamo_macro_url", url);
      return DATASET;
    }
  }

  throw new Error("Nessun dataset offline valido disponibile.");
}

// -------------------- GEOCODING --------------------
async function geocodeLabel(label) {
  const q = String(label || "").trim();
  if (!q) throw new Error("Scrivi un luogo (es: L'Aquila, Roma, Milano...)");
  const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { method: "GET", cache: "no-store" });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error("Geocoding fallito (risposta vuota)");
  if (!j.ok) throw new Error(j.error || "Geocoding fallito");
  if (!j.result || !Number.isFinite(Number(j.result.lat)) || !Number.isFinite(Number(j.result.lon))) {
    throw new Error("Geocoding fallito (coordinate non valide)");
  }
  return j.result;
}

// -------------------- TAGS / CATEGORY (PRECISI) --------------------
function placeTags(place) {
  return (place.tags || []).map(t => String(t).toLowerCase());
}
function tagsStr(place) {
  return placeTags(place).join(" ");
}

function looksIndoor(place) {
  const t = tagsStr(place);
  const n = normName(place?.name);
  return (
    t.includes("indoor") ||
    t.includes("coperto") ||
    n.includes("indoor") ||
    n.includes("coperto")
  );
}

function isSpaPlace(place) {
  const n = normName(place?.name);
  const t = tagsStr(place);
  const type = normalizeType(place?.type);
  return (
    type === "relax" ||
    t.includes("terme") || t.includes("spa") ||
    t.includes("hot_spring") || t.includes("public_bath") ||
    t.includes("amenity=spa") || t.includes("leisure=spa") ||
    n.includes("terme") || n.includes("spa") || n.includes("thermal") || n.includes("benessere")
  );
}

function isWaterPark(place) {
  const n = normName(place?.name);
  const t = tagsStr(place);
  return (
    t.includes("water_park") ||
    t.includes("leisure=water_park") ||
    n.includes("acquapark") || n.includes("aqua park") || n.includes("water park") || n.includes("parco acquatico")
  );
}

function isZooOrAquarium(place) {
  const n = normName(place?.name);
  const t = tagsStr(place);
  return (
    t.includes("tourism=zoo") || t.includes("tourism=aquarium") ||
    n.includes("zoo") || n.includes("acquario") || n.includes("aquarium")
  );
}

function isThemePark(place) {
  const n = normName(place?.name);
  const t = tagsStr(place);
  return (
    t.includes("tourism=theme_park") ||
    n.includes("parco divertimenti") || n.includes("lunapark") || n.includes("luna park") || n.includes("giostre") ||
    n.includes("gardaland")
  );
}

function isKidsMuseum(place) {
  const n = normName(place?.name);
  const t = tagsStr(place);
  return (
    t.includes("kids_museum") ||
    t.includes("children") ||
    n.includes("museo dei bambini") || n.includes("children museum") ||
    n.includes("science center") || n.includes("planetario") || n.includes("planetarium")
  );
}

function isPlaygroundLike(place) {
  const n = normName(place?.name);
  const t = tagsStr(place);
  return (
    t.includes("playground") || t.includes("leisure=playground") ||
    t.includes("trampoline") ||
    n.includes("parco giochi") || n.includes("area giochi") || n.includes("trampolin") || n.includes("kids")
  );
}

function isViewpoint(place) {
  const n = normName(place?.name);
  const t = tagsStr(place);
  return (
    t.includes("tourism=viewpoint") ||
    n.includes("belvedere") || n.includes("panoram") || n.includes("viewpoint") || n.includes("scenic") || n.includes("terrazza")
  );
}

function isHiking(place) {
  const n = normName(place?.name);
  const t = tagsStr(place);
  return (
    t.includes("hiking") ||
    t.includes("information=guidepost") ||
    t.includes("amenity=shelter") ||
    n.includes("sentiero") || n.includes("trail") || n.includes("trek") || n.includes("trekking") || n.includes("via ferrata") || n.includes("rifugio")
  );
}

function isMountain(place) {
  const n = normName(place?.name);
  const t = tagsStr(place);

  if (t.includes("place=city") || t.includes("place=town") || t.includes("place=village") || t.includes("place=hamlet")) return false;

  return (
    t.includes("natural=peak") ||
    t.includes("mountain") ||
    n.includes("monte") || n.includes("cima") || n.includes("massiccio") ||
    n.includes("rifugio") || n.includes("passo") || n.includes("valico") ||
    t.includes("type:montagna")
  );
}

function isBorgo(place) {
  const type = normalizeType(place?.type);
  const n = normName(place?.name);
  const t = tagsStr(place);

  if (n.includes("passo ") || n.startsWith("passo")) return false;
  if (n.includes("stazione") || n.includes("casello") || n.includes("area di servizio")) return false;

  return (
    type === "borghi" ||
    n.includes("borgo") ||
    t.includes("place=village") || t.includes("place=hamlet") ||
    t.includes("type:borghi")
  );
}

function isCity(place) {
  const type = normalizeType(place?.type);
  const t = tagsStr(place);
  return (
    type === "citta" ||
    t.includes("place=city") || t.includes("place=town") ||
    t.includes("type:citta")
  );
}

function matchesCategoryStrict(place, cat) {
  if (!cat || cat === "ovunque") return true;

  const type = normalizeType(place?.type);
  const n = normName(place?.name);
  const t = tagsStr(place);

  if (cat === "mare") return type === "mare" || t.includes("natural=beach") || n.includes("spiaggia") || n.includes("beach") || t.includes("type:mare");
  if (cat === "storia") return type === "storia" || t.includes("historic=") || t.includes("tourism=museum") || n.includes("castello") || n.includes("museo") || n.includes("rocca") || t.includes("type:storia");
  if (cat === "natura") return type === "natura" || t.includes("nature_reserve") || t.includes("boundary=national_park") || n.includes("cascata") || n.includes("lago") || n.includes("riserva") || t.includes("type:natura");
  if (cat === "relax") return isSpaPlace(place) || type === "relax" || t.includes("type:relax");
  if (cat === "borghi") return isBorgo(place);
  if (cat === "citta") return isCity(place);
  if (cat === "montagna") return isMountain(place);

  if (cat === "theme_park") return isThemePark(place) || isWaterPark(place);
  if (cat === "kids_museum") return isKidsMuseum(place);
  if (cat === "viewpoints") return isViewpoint(place);
  if (cat === "hiking") return isHiking(place);

  if (cat === "family") {
    // family = SOLO roba family vera; spa esclusa
    return (
      isThemePark(place) ||
      isWaterPark(place) ||
      isZooOrAquarium(place) ||
      isKidsMuseum(place) ||
      isPlaygroundLike(place) ||
      t.includes("family")
    );
  }

  return true;
}

function matchesStyle(place, { wantChicche, wantClassici }) {
  const vis = normalizeVisibility(place?.visibility);
  if (!wantChicche && !wantClassici) return true;
  if (vis === "chicca") return !!wantChicche;
  return !!wantClassici;
}

// -------------------- SCORING --------------------
function baseScorePlace({ driveMin, targetMin, beautyScore, isChicca }) {
  const t = clamp(1 - Math.abs(driveMin - targetMin) / Math.max(18, targetMin * 0.9), 0, 1);
  const b = clamp(Number(beautyScore) || 0.72, 0.35, 1);
  const c = isChicca ? 0.06 : 0;
  return 0.62 * t + 0.32 * b + c;
}

function rotationPenalty(pid, recentSet) {
  let pen = 0;
  if (pid && pid === LAST_SHOWN_PID) pen += 0.22;
  if (SESSION_SEEN.has(pid)) pen += 0.18;
  if (recentSet.has(pid)) pen += 0.10;
  return pen;
}

function familyBoost(place, category) {
  if (category !== "family") return 0;
  if (isThemePark(place)) return 0.26;
  if (isWaterPark(place)) return 0.24;
  if (isZooOrAquarium(place)) return 0.22;
  if (isKidsMuseum(place)) return 0.18;
  if (isPlaygroundLike(place)) return 0.12;
  return 0;
}

// -------------------- TIME WIDEN --------------------
function widenMinutesSteps(m, category) {
  const base = clamp(Number(m) || 120, 10, 600);
  const steps = [base];

  const muls =
    category === "family" ?     [1.15, 1.30, 1.50] :
    category === "theme_park" ? [1.15, 1.30, 1.55] :
    category === "mare" ?       [1.20, 1.40, 1.65] :
    category === "storia" ?     [1.20, 1.40, 1.60] :
                                [1.20, 1.40, 1.60];

  for (const k of muls) steps.push(clamp(Math.round(base * k), base, 600));
  steps.push(clamp(Math.max(240, base), base, 600));

  return Array.from(new Set(steps)).sort((a, b) => a - b);
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
    allowSpaInFamily = false,
  } = {}
) {
  const visited = getVisitedSet();
  const recentSet = getRecentSet();
  const target = Number(maxMinutes);

  const oLat = Number(origin.lat);
  const oLon = Number(origin.lon);

  const candidates = [];

  for (const raw of pool) {
    const p = normalizePlace(raw);
    if (!p) continue;

    const nm = String(p.name || "").trim();
    if (!nm || nm.length < 2 || normName(nm) === "meta") continue;

    const okCat = matchesCategoryStrict(p, category) || (
      category === "family" && allowSpaInFamily && isSpaPlace(p)
    );
    if (!okCat) continue;

    if (!matchesStyle(p, styles)) continue;

    const pid = safeIdFromPlace(p);
    if (!ignoreVisited && visited.has(pid)) continue;

    const km = haversineKm(oLat, oLon, p.lat, p.lon);
    const driveMin = estCarMinutesFromKm(km);

    if (!Number.isFinite(driveMin)) continue;
    if (driveMin > target) continue;
    if (km < (category === "family" ? 0.8 : 1.2)) continue;

    const isChicca = normalizeVisibility(p.visibility) === "chicca";

    let s = baseScorePlace({
      driveMin,
      targetMin: target,
      beautyScore: p.beauty_score,
      isChicca
    });

    s += familyBoost(p, category);

    if (category === "family" && isSpaPlace(p) && !allowSpaInFamily) s -= 0.35;
    if (!ignoreRotation) s -= rotationPenalty(pid, recentSet);

    candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
  }

  candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
  return candidates;
}

function pickBest(pool, origin, minutes, category, styles) {
  let c = buildCandidatesFromPool(pool, origin, minutes, category, styles, {
    ignoreVisited: false,
    ignoreRotation: false,
    allowSpaInFamily: false,
  });
  if (c.length) return { chosen: c[0], alternatives: c.slice(1, 3), total: c.length, spaFallback: false };

  if (category === "family") {
    c = buildCandidatesFromPool(pool, origin, minutes, category, styles, {
      ignoreVisited: false,
      ignoreRotation: true,
      allowSpaInFamily: true,
    });
    if (c.length) return { chosen: c[0], alternatives: c.slice(1, 3), total: c.length, spaFallback: true };
  }

  c = buildCandidatesFromPool(pool, origin, minutes, category, styles, {
    ignoreVisited: false,
    ignoreRotation: true,
    allowSpaInFamily: false,
  });
  if (c.length) return { chosen: c[0], alternatives: c.slice(1, 3), total: c.length, spaFallback: false };

  c = buildCandidatesFromPool(pool, origin, minutes, category, styles, {
    ignoreVisited: true,
    ignoreRotation: true,
    allowSpaInFamily: category === "family",
  });

  return { chosen: c[0] || null, alternatives: c.slice(1, 3), total: c.length, spaFallback: category === "family" };
}

// -------------------- LIVE fallback (/api/destinations) --------------------
function minutesToRadiusKm(minutes) {
  const m = clamp(Number(minutes) || 120, 10, 600);
  const drive = Math.max(6, m - FIXED_OVERHEAD_MIN);
  const straightKm = (drive / 60) * AVG_KMH / ROAD_FACTOR;
  return clamp(Math.round(straightKm * 0.85), 4, 220);
}

async function fetchLiveFallback(origin, minutes, category, signal) {
  const radiusKm = minutesToRadiusKm(minutes);
  const url = `/api/destinations?lat=${encodeURIComponent(origin.lat)}&lon=${encodeURIComponent(origin.lon)}&radiusKm=${encodeURIComponent(radiusKm)}&cat=${encodeURIComponent(category)}`;
  const j = await fetchJson(url, { signal });
  const els = j?.data?.elements;
  if (!Array.isArray(els) || !els.length) return [];
  return els.map(normalizePlace).filter(Boolean);
}

// -------------------- CARD HELPERS --------------------
function typeBadge(category) {
  const map = {
    family: { emoji: "👨‍👩‍👧‍👦", label: "Family" },
    theme_park:{ emoji:"🎢", label:"Parchi" },
    kids_museum:{ emoji:"🧒🏛️", label:"Musei kids" },
    viewpoints:{ emoji:"🌅", label:"Panorami" },
    hiking:{ emoji:"🥾", label:"Trekking" },

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
  if (category === "family" || category === "theme_park") {
    if (isThemePark(place)) return "Parchi/giostre: controlla orari e biglietti, perfetto con bimbi.";
    if (isWaterPark(place)) return "Acquapark: spesso stagionale — verifica apertura.";
    if (isZooOrAquarium(place)) return "Zoo/acquario: percorsi, aree picnic e tante cose da vedere.";
    if (isKidsMuseum(place)) return "Museo kids/science center: ottimo anche con brutto tempo.";
    if (isPlaygroundLike(place)) return "Parco giochi/attività kids: semplice e super efficace.";
    return "Attività family: controlla foto e cosa fare nei dintorni.";
  }
  if (category === "relax") return "Relax: terme/spa o posto tranquillo + pausa.";
  if (category === "storia") return "Storia e cultura: visita + centro storico.";
  if (category === "mare") return "Mare: spiaggia, passeggiata e tramonto.";
  if (category === "natura") return "Natura: sentieri, panorami, cascata/lago/riserva.";
  if (category === "borghi") return "Borgo: vicoli, belvedere, cibo tipico e foto.";
  if (category === "citta") return "Città: centro, piazze, monumenti e locali.";
  if (category === "montagna") return "Montagna: vista, rifugio o punto panoramico.";
  return "Esplora, foto, cibo e cose da fare nei dintorni.";
}

function chipsFromPlace(place, category) {
  const chips = [];
  if (category === "family" || category === "theme_park") {
    if (isThemePark(place)) chips.push("🎢 parco");
    if (isWaterPark(place)) chips.push("💦 acqua");
    if (isZooOrAquarium(place)) chips.push("🦁 zoo");
    if (isKidsMuseum(place)) chips.push("🧒 kids");
    if (isPlaygroundLike(place)) chips.push("🛝 giochi");
    if (looksIndoor(place)) chips.push("🏠 indoor");
    if (isWinterNow() && isWaterPark(place) && !looksIndoor(place)) chips.push("❄️ stagionale");
  }
  if (category === "montagna") chips.push("🏔️ montagna");
  if (category === "borghi") chips.push("🏘️ borgo");
  if (category === "storia") chips.push("🏛️ storia");
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

  const badge = normalizeVisibility(p.visibility) === "chicca" ? "✨ chicca" : "✅ classica";
  const tb = typeBadge(category);

  const what = microWhatToDo(p, category);
  const chips = chipsFromPlace(p, category);

  const lat = Number(p.lat);
  const lon = Number(p.lon);

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
          ${meta.liveUsed ? `<div class="pill">🛰️ LIVE</div>` : ""}
          ${meta.spaFallback ? `<div class="pill">⚠️ fallback (spa)</div>` : ""}
        </div>
      </div>

      <div style="padding:14px;">
        <div style="font-weight:950; font-size:28px; line-height:1.12; margin:0;">
          ${p.name} <span class="small muted" style="font-weight:700;">(${p.country || p.area || "—"})</span>
        </div>

        <div class="small muted" style="margin-top:8px; line-height:1.35;">
          Dataset: ${meta.datasetInfo || "—"} • score: ${chosen.score}
          ${meta.usedMinutes && meta.usedMinutes !== maxMinutesShown ? ` • widen: ${meta.usedMinutes} min` : ""}
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
            return `
              <div class="card" style="padding:10px;">
                <div style="font-weight:900; line-height:1.2;">${ap.name}</div>
                <div class="small muted" style="margin-top:4px;">
                  🚗 ~${a.driveMin} min • ${fmtKm(a.km)} ${ap.country ? `• (${ap.country})` : ""}
                </div>
                <div class="row wrap gap" style="margin-top:10px;">
                  <a class="btn btn-ghost" target="_blank" rel="noopener" href="${mapsDirUrl(origin.lat, origin.lon, ap.lat, ap.lon)}">Percorso</a>
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
    if (!origin || !Number.isFinite(Number(origin.lat)) || !Number.isFinite(Number(origin.lon))) {
      showStatus("err", "Imposta una partenza: GPS oppure scrivi un luogo e premi “Usa questo luogo”.");
      return;
    }

    DATASET = { kind: null, source: null, places: [], meta: {} };
    await ensureDatasetLoaded(origin, { signal });

    const basePool = Array.isArray(DATASET?.places) ? DATASET.places : [];
    const datasetInfo =
      DATASET.kind === "region"
        ? `REGION:${(DATASET.source || "").split("/").pop()} (${basePool.length})`
        : DATASET.kind === "macro"
          ? `MACRO:${(DATASET.source || "").split("/").pop()} (${basePool.length})`
          : `—`;

    const maxMinutesInput = clamp(Number($("maxMinutes")?.value) || 120, 10, 600);
    const category = getActiveCategory();
    const styles = getActiveStyles();

    const steps = widenMinutesSteps(maxMinutesInput, category);

    let chosen = null;
    let alternatives = [];
    let usedMinutes = steps[0];
    let liveUsed = false;
    let spaFallback = false;

    // 1) OFFLINE widening
    for (const mins of steps) {
      usedMinutes = mins;

      const picked = pickBest(basePool, origin, mins, category, styles);
      chosen = picked.chosen;
      alternatives = picked.alternatives;
      spaFallback = !!picked.spaFallback;

      if (forcePid) {
        const all = buildCandidatesFromPool(basePool, origin, mins, category, styles, { ignoreVisited: true, ignoreRotation: true, allowSpaInFamily: true });
        const forced = all.find(x => x.pid === forcePid);
        if (forced) {
          chosen = forced;
          alternatives = all.filter(x => x.pid !== forcePid).slice(0, 2);
        }
      } else if (forbidPid && chosen?.pid === forbidPid) {
        const all = buildCandidatesFromPool(basePool, origin, mins, category, styles, { ignoreVisited: true, ignoreRotation: true, allowSpaInFamily: true })
          .filter(x => x.pid !== forbidPid);
        chosen = all[0] || null;
        alternatives = all.slice(1, 3);
      }

      if (chosen) break;
      if (token !== SEARCH_TOKEN) return;
    }

    if (token !== SEARCH_TOKEN) return;

    // 2) LIVE fallback only if offline empty OR not enough choices
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
          spaFallback = !!picked.spaFallback;
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
      spaFallback,
    });

    if (!chosen) {
      showStatus("warn", `Nessuna meta entro ${maxMinutesInput} min per "${category}". Prova ad aumentare i minuti o cambia categoria.`);
    } else if (!silent) {
      const extra = usedMinutes !== maxMinutesInput ? ` (ho allargato a ${usedMinutes} min)` : "";
      const live = liveUsed ? " • LIVE ok" : "";
      const fam = spaFallback ? " • (fallback spa)" : "";
      showStatus("ok", `Meta trovata ✅ (~${chosen.driveMin} min) • categoria: ${category}${extra}${live}${fam}`);
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
      if (Number.isFinite(Number(o?.lat)) && Number.isFinite(Number(o?.lon))) {
        setOrigin({
          label: o.label,
          lat: o.lat,
          lon: o.lon,
          country_code: o.country_code || ""
        });
      }
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
