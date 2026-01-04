/* Jamo — app.js v8.0 (FIXED + CLEAN)
 * - Fix bottoni non cliccabili (niente errori JS / init in DOMContentLoaded)
 * - Offline macro + Live Overpass merge (LIVE sempre tentato)
 * - UI: mostra chiaramente la fase "LIVE: sto cercando..." senza far credere che non ci sia nulla
 * - Family: priorità attrazioni vere > kids > zoo/acquari > piscine > spa/terme > parchi grandi
 * - Categoria coerente: family NON deve sparare paesi/città a caso
 * - 2 alternative
 * - Anti-race: abort previous search + token
 */

const $ = (id) => document.getElementById(id);

// -------------------- DATA SOURCES --------------------
const MACROS_INDEX_URL = "/data/macros/macros_index.json";
const FALLBACK_MACRO_URLS = [
  "/data/macros/euuk_macro_all.json",
  "/data/macros/it_macro_01_abruzzo.json",
];

// Live API (Next/Vercel): api/destinations.js -> /api/destinations
const LIVE_API_URL = "/api/destinations";

// -------------------- ROUTING / ESTIMATOR --------------------
const ROAD_FACTOR = 1.25;
const AVG_KMH = 72;
const FIXED_OVERHEAD_MIN = 8;

// -------------------- ROTATION --------------------
const RECENT_TTL_MS = 1000 * 60 * 60 * 20; // 20h
const RECENT_MAX = 160;
let SESSION_SEEN = new Set();
let LAST_SHOWN_PID = null;

// -------------------- MONETIZATION IDS --------------------
const BOOKING_AID = "";
const AMAZON_TAG  = "";
const GYG_PID     = "";
const TIQETS_PID  = "";

// -------------------- SEARCH CONTROL --------------------
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

function placeTags(place) {
  return (place?.tags || []).map(t => String(t).toLowerCase());
}

function looksIndoor(place) {
  const tags = placeTags(place).join(" ");
  const n = normName(place?.name);
  return (
    tags.includes("indoor") ||
    tags.includes("coperto") ||
    tags.includes("al coperto") ||
    n.includes("indoor") ||
    n.includes("coperto")
  );
}

function isWaterPark(place) {
  const t = String(place?.type || "").toLowerCase();
  const tags = placeTags(place);
  const n = normName(place?.name);
  return (
    t.includes("water") || t.includes("acqua") ||
    tags.includes("water_park") ||
    tags.includes("leisure=water_park") ||
    n.includes("acquapark") ||
    n.includes("aqua park") ||
    n.includes("water park") ||
    n.includes("parco acquatico")
  );
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

// -------------------- MONETIZATION URLs --------------------
function bookingUrl(q, countryCode = "", affId = "") {
  const query = `${q}${countryCode ? ", " + countryCode : ""}`;
  const base = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(query)}`;
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
  const base = `https://www.amazon.it/s?k=${encodeURIComponent("accessori viaggio")}`;
  return tag ? `${base}&tag=${encodeURIComponent(tag)}` : base;
}

// -------------------- STORAGE (origin + visited + recent) --------------------
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

// -------------------- UI (chips + status + loading) --------------------
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
  const active = $("categoryChips")?.querySelector(".chip.active");
  return active?.dataset.cat || "ovunque";
}

function getActiveStyles() {
  const actives = [...($("styleChips")?.querySelectorAll(".chip.active") || [])].map(c => c.dataset.style);
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

function showSearchingCard(stageText) {
  const area = $("resultArea");
  if (!area) return;
  area.innerHTML = `
    <div class="card warnbox">
      <div style="font-weight:900;">${stageText || "🔎 Sto cercando…"}</div>
      <div class="small muted" style="margin-top:6px; line-height:1.4;">
        Sto aggiornando la proposta: prima offline (veloce), poi LIVE (attrazioni/mete reali).
      </div>
    </div>
  `;
}

// -------------------- MACRO LOADING --------------------
let MACROS_INDEX = null;
let MACRO = null;
let MACRO_SOURCE_URL = null;

async function fetchJson(url, { signal } = {}) {
  const r = await fetch(url, { cache: "no-store", signal });
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

function inferScopeFromOriginLabel(label) {
  const s = normName(label || "");
  if (s.includes("italia") || s.includes("italy") || s.includes("roma") || s.includes("l aquila") || s.includes("pescara")) return "IT";
  return "EUUK";
}

async function loadBestMacroForOrigin(origin) {
  if (!origin) origin = getOrigin();

  const saved = localStorage.getItem("jamo_macro_url");
  if (saved) {
    const m = await tryLoadMacro(saved);
    if (m) { MACRO = m; MACRO_SOURCE_URL = saved; return m; }
  }

  await loadMacrosIndexSafe();

  const preferredScope = inferScopeFromOriginLabel(origin?.label || "");
  const candidates = [];

  if (MACROS_INDEX?.items?.length) {
    const euukAll = MACROS_INDEX.items.find(x => x.id === "euuk_macro_all" || String(x.path || "").includes("euuk_macro_all.json"));
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
  if (!q) throw new Error("Scrivi un luogo (es: Bussolengo, L'Aquila, Roma...)");
  const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { method: "GET", cache: "no-store" });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error("Geocoding fallito (risposta vuota)");
  if (!j.ok) throw new Error(j.error || "Geocoding fallito");
  if (!j.result || !Number.isFinite(Number(j.result.lat)) || !Number.isFinite(Number(j.result.lon))) {
    throw new Error("Geocoding fallito (coordinate non valide)");
  }
  return j.result;
}

// -------------------- CATEGORY LOGIC --------------------
function isSpaPlace(place) {
  const n = normName(place?.name);
  const tags = placeTags(place);
  const t = String(place?.type || "").toLowerCase();
  return (
    t === "relax" ||
    tags.includes("terme") || tags.includes("spa") ||
    tags.includes("hot_spring") || tags.includes("public_bath") ||
    n.includes("terme") || n.includes("spa") || n.includes("thermal")
  );
}

function isFamilyAttraction(place) {
  const tags = placeTags(place);
  const type = String(place?.type || "").toLowerCase();
  const n = normName(place?.name);

  // hard signals
  const strong = [
    "theme_park","amusement_park","water_park",
    "zoo","aquarium","attraction",
    "trampoline_park","indoor_play",
    "swimming_pool","piscina","acquapark"
  ];
  if (strong.some(x => tags.includes(x))) return true;

  // type hints
  if (type.includes("theme") || type.includes("amusement") || type.includes("water") || type.includes("zoo") || type.includes("aquarium")) return true;

  // name hints
  if (
    n.includes("gardaland") ||
    n.includes("mirabilandia") ||
    n.includes("acquapark") ||
    n.includes("aqua park") ||
    n.includes("water park") ||
    n.includes("parco divertimenti") ||
    n.includes("parco acquatico") ||
    n.includes("luna park") ||
    n.includes("zoo") ||
    n.includes("acquario")
  ) return true;

  return false;
}

function isKidsPlace(place) {
  const tags = placeTags(place);
  const n = normName(place?.name);
  return (
    tags.includes("playground") ||
    tags.includes("indoor_play") ||
    tags.includes("play_centre") ||
    tags.includes("trampoline_park") ||
    n.includes("parco giochi") ||
    n.includes("area giochi") ||
    n.includes("gonfiabil") ||
    n.includes("kids") ||
    n.includes("bambin")
  );
}

function isBigPark(place) {
  const tags = placeTags(place);
  const n = normName(place?.name);
  // non perfetto, ma meglio di niente: grandi parchi/giardini/avventura
  return (
    tags.includes("park") ||
    n.includes("parco naturale") ||
    n.includes("parco regionale") ||
    n.includes("parco nazionale") ||
    n.includes("parco avventura") ||
    n.includes("giardini") ||
    n.includes("giardino")
  );
}

function matchesCategory(place, cat) {
  if (!cat || cat === "ovunque") return true;

  const type = String(place?.type || "").toLowerCase();
  const tags = placeTags(place);
  const n = normName(place?.name);

  if (cat === "citta") return type === "citta" || tags.includes("city") || tags.includes("citta") || tags.includes("town") || type === "town";
  if (cat === "borghi") return type === "borgo" || tags.includes("village") || tags.includes("hamlet") || tags.includes("borgo") || n.includes("borgo");
  if (cat === "mare") return type === "mare" || tags.includes("beach") || tags.includes("natural=beach") || n.includes("spiaggia") || n.includes("beach") || tags.includes("mare");
  if (cat === "montagna") return type === "montagna" || tags.includes("peak") || n.includes("monte") || n.includes("cima") || n.includes("mount");
  if (cat === "natura") return type === "natura" || tags.includes("waterfall") || tags.includes("viewpoint") || tags.includes("nature_reserve") || n.includes("cascata") || n.includes("riserva") || n.includes("parco");
  if (cat === "storia") return type === "storia" || tags.includes("museum") || tags.includes("castle") || tags.includes("historic") || n.includes("museo") || n.includes("castello") || n.includes("rocca") || n.includes("abbazia");
  if (cat === "relax") return isSpaPlace(place);

  if (cat === "family") {
    // Family = priorità attrazioni vere e cose kids-friendly.
    // Importante: NON “citta/borghi” generici.
    if (isFamilyAttraction(place)) return true;
    if (isKidsPlace(place)) return true;
    if (isWaterPark(place)) return true;
    if (tags.includes("zoo") || tags.includes("aquarium")) return true;
    if (tags.includes("swimming_pool") || n.includes("piscina")) return true;
    if (isSpaPlace(place)) return true; // consentito
    if (isBigPark(place)) return true;  // fallback “parchi grandi”
    return false;
  }

  return true;
}

function matchesStyle(place, { wantChicche, wantClassici }) {
  const vis = String(place?.visibility || "").toLowerCase();
  if (!wantChicche && !wantClassici) return true;
  if (vis === "chicca") return !!wantChicche;
  return !!wantClassici;
}

// -------------------- SCORING --------------------
function baseScorePlace({ driveMin, targetMin, beautyScore, isChicca }) {
  const t = clamp(1 - Math.abs(driveMin - targetMin) / Math.max(25, targetMin * 0.9), 0, 1);
  const b = clamp(Number(beautyScore) || 0.70, 0.35, 1);
  const c = isChicca ? 0.06 : 0;
  return 0.60 * t + 0.34 * b + c;
}

function rotationPenalty(pid, recentSet) {
  let pen = 0;
  if (pid && pid === LAST_SHOWN_PID) pen += 0.22;
  if (SESSION_SEEN.has(pid)) pen += 0.18;
  if (recentSet.has(pid)) pen += 0.10;
  return pen;
}

function chiccaPenaltyForTooFamous(place, styles) {
  if (!styles?.wantChicche) return 0;
  // se l’utente vuole chicche, penalizza posti iper noti (brand noti / capoluoghi)
  const n = normName(place?.name);
  const famous = [
    "venezia","rome","roma","milano","florence","firenze","napoli","bologna","verona",
    "gardaland","mirabilandia"
  ];
  if (famous.some(x => n.includes(x))) return 0.18;
  return 0;
}

function familyBoost(place, category) {
  if (category !== "family") return 0;

  // ordine di priorità
  if (isFamilyAttraction(place)) return 0.22;
  if (isWaterPark(place)) return 0.18;
  if (isKidsPlace(place)) return 0.16;
  if (placeTags(place).includes("zoo") || normName(place?.name).includes("zoo")) return 0.14;
  if (placeTags(place).includes("aquarium") || normName(place?.name).includes("acquario")) return 0.14;
  if (placeTags(place).includes("swimming_pool") || normName(place?.name).includes("piscina")) return 0.10;
  if (isSpaPlace(place)) return 0.06;
  if (isBigPark(place)) return 0.05;

  return 0;
}

function familySeasonPenalty(place, category) {
  if (category !== "family") return 0;
  // water park outdoor in inverno -> un po’ giù, ma NON escluso
  if (isWinterNow() && isWaterPark(place) && !looksIndoor(place)) return 0.10;
  return 0;
}

// -------------------- TIME WIDEN --------------------
function effectiveMaxMinutes(maxMinutes, category) {
  const m = Number(maxMinutes);
  if (!Number.isFinite(m)) return 120;

  if (category === "family" && m < 60) return clamp(Math.round(m * 1.55), m, 170);
  if (category === "mare" && m < 75) return clamp(Math.round(m * 1.35), m, 180);
  if (category === "storia" && m < 50) return clamp(Math.round(m * 1.30), m, 150);

  return clamp(m, 10, 600);
}

// -------------------- LIVE FETCH --------------------
function mapLiveToPlace(el) {
  const tags = el?.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";
  const cleanedName = String(name || "").trim();

  // evita roba vuota o "Meta"
  if (!cleanedName || cleanedName.length < 2) return null;
  if (normName(cleanedName) === "meta") return null;

  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const typeGuess = (() => {
    if (tags.tourism === "theme_park") return "family";
    if (tags.leisure === "water_park") return "family";
    if (tags.tourism === "zoo" || tags.amenity === "zoo") return "family";
    if (tags.tourism === "aquarium" || tags.amenity === "aquarium") return "family";
    if (tags.tourism === "museum") return "storia";
    if (tags.historic) return "storia";
    if (tags.natural === "beach") return "mare";
    if (tags.boundary === "national_park" || tags.leisure === "nature_reserve") return "natura";
    if (tags.place === "village" || tags.place === "hamlet") return "borgo";
    if (tags.place === "town" || tags.place === "city") return "citta";
    if (tags.amenity === "spa" || tags.leisure === "spa" || tags.natural === "hot_spring") return "relax";
    return "meta";
  })();

  const tagList = [];
  if (tags.tourism) tagList.push(String(tags.tourism));
  if (tags.leisure) tagList.push(String(tags.leisure));
  if (tags.historic) tagList.push(String(tags.historic));
  if (tags.natural) tagList.push(String(tags.natural));
  if (tags.amenity) tagList.push(String(tags.amenity));
  if (tags.attraction) tagList.push("attraction");

  return {
    id: `live_${el.type}_${el.id}`,
    name: cleanedName,
    lat,
    lon,
    country: "",
    area: "",
    type: typeGuess,
    visibility: "classica",
    tags: Array.from(new Set(tagList)).slice(0, 12),
    beauty_score: 0.72,
    why: [],
    live: true,
  };
}

async function fetchLivePlaces(origin, radiusKm, category, outerSignal) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 14000);
  const signal = ctrl.signal;

  if (outerSignal) {
    outerSignal.addEventListener("abort", () => { try { ctrl.abort(); } catch {} }, { once: true });
  }

  try {
    const url =
      `${LIVE_API_URL}?lat=${encodeURIComponent(origin.lat)}&lon=${encodeURIComponent(origin.lon)}` +
      `&radiusKm=${encodeURIComponent(radiusKm)}&cat=${encodeURIComponent(category)}` +
      `&_ts=${Date.now()}`;

    const r = await fetch(url, { method: "GET", cache: "no-store", signal });
    const j = await r.json().catch(() => null);

    // supporta sia {ok:true,data:{elements}} sia {ok:true,elements}
    const elements = j?.data?.elements || j?.elements || null;
    if (!j || !j.ok || !Array.isArray(elements)) {
      return { ok: false, places: [] };
    }

    const mapped = elements.map(mapLiveToPlace).filter(Boolean);

    // uniq per nome+coord approx
    const seen = new Set();
    const uniq = [];
    for (const p of mapped) {
      const k = `${normName(p.name)}_${String(p.lat).slice(0, 5)}_${String(p.lon).slice(0, 5)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(p);
    }

    return { ok: true, places: uniq.slice(0, 420) };
  } catch {
    return { ok: false, places: [] };
  } finally {
    clearTimeout(t);
  }
}

// -------------------- CANDIDATES / PICK --------------------
function buildCandidatesFromPool(pool, origin, maxMinutes, category, styles, { ignoreVisited = false, ignoreRotation = false } = {}) {
  const visited = getVisitedSet();
  const recentSet = getRecentSet();
  const target = Number(maxMinutes);

  const oLat = Number(origin.lat);
  const oLon = Number(origin.lon);

  const candidates = [];

  for (const p of pool) {
    if (!p) continue;

    const nm = String(p.name || "").trim();
    if (!nm || nm.length < 2) continue;
    if (normName(nm) === "meta") continue;

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
    if (km < (category === "family" ? 0.6 : 1.2)) continue;

    const isChicca = String(p.visibility || "").toLowerCase() === "chicca";

    let s = baseScorePlace({
      driveMin,
      targetMin: target,
      beautyScore: p.beauty_score,
      isChicca
    });

    s += familyBoost(p, category);
    s -= familySeasonPenalty(p, category);
    s -= chiccaPenaltyForTooFamous(p, styles);

    if (!ignoreRotation) s -= rotationPenalty(pid, recentSet);

    candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
  }

  candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
  return candidates;
}

function pickDestinationFromPool(pool, origin, maxMinutes, category, styles) {
  let candidates = buildCandidatesFromPool(pool, origin, maxMinutes, category, styles, { ignoreVisited: false, ignoreRotation: false });
  if (candidates.length === 0) candidates = buildCandidatesFromPool(pool, origin, maxMinutes, category, styles, { ignoreVisited: false, ignoreRotation: true });
  if (candidates.length === 0) candidates = buildCandidatesFromPool(pool, origin, maxMinutes, category, styles, { ignoreVisited: true, ignoreRotation: true });
  return { chosen: candidates[0] || null, alternatives: candidates.slice(1, 3) };
}

// -------------------- CARD HELPERS --------------------
function typeBadge(category) {
  const map = {
    family: { emoji: "👨‍👩‍👧‍👦", label: "Family" },
    relax:  { emoji: "🧖", label: "Relax" },
    storia: { emoji: "🏛️", label: "Storia" },
    natura: { emoji: "🌿", label: "Natura" },
    mare:   { emoji: "🌊", label: "Mare" },
    borghi: { emoji: "🏘️", label: "Borghi" },
    citta:  { emoji: "🏙️", label: "Città" },
    montagna:{emoji:"🏔️",label:"Montagna"},
    ovunque:{ emoji: "🎲", label: "Ovunque" }
  };
  return map[category] || { emoji: "📍", label: "Meta" };
}

function microWhatToDo(place, category) {
  const n = normName(place?.name);
  const tags = placeTags(place);

  if (category === "family") {
    if (isFamilyAttraction(place)) {
      if (n.includes("gardaland")) return "Parco divertimenti top: attrazioni, show, aree kids, giornata piena.";
      if (isWaterPark(place)) return "Scivoli e piscine: spesso stagionale (controlla apertura).";
      if (tags.includes("zoo") || n.includes("zoo")) return "Animali e percorsi: perfetto con bambini.";
      if (tags.includes("aquarium") || n.includes("acquario")) return "Percorso spesso indoor: ottimo anche d’inverno.";
      return "Attrazione family: attività e cose da fare sul posto.";
    }
    if (isKidsPlace(place)) return "Posto per bimbi: giochi/indoor/attività (ideale 1–3 ore).";
    if (isSpaPlace(place)) return "Terme/relax: spesso con piscine e servizi (verifica accesso family).";
    if (isBigPark(place)) return "Parco grande: passeggiate, picnic e spazio per i bimbi.";
    return "Gita family: esplora e usa i link 'Cosa fare' per attività vicine.";
  }

  if (category === "relax") {
    if (isSpaPlace(place)) return "Relax e benessere: spa/terme/piscine (controlla orari e prenotazioni).";
    return "Stacco e tranquillità: luogo ideale per rilassarti.";
  }

  if (category === "storia") return "Storia e cultura: visita, centro storico, monumenti e punti panoramici.";
  if (category === "mare") return "Spiaggia e passeggiata sul mare: tramonto e relax.";
  if (category === "natura") return "Natura vera: sentieri, panorami e spot fotogenici.";
  if (category === "borghi") return "Borgo da esplorare: vicoli, belvedere e tipico.";
  if (category === "citta") return "Passeggiata in città: centro, piazze e cose da vedere.";
  if (category === "montagna") return "Montagna: vista, aria fresca e percorsi.";
  return "Esplora e usa i link per scoprire cosa fare sul posto.";
}

function chipsFromPlace(place, category) {
  const chips = [];
  if (category === "family") {
    if (isFamilyAttraction(place)) chips.push("🎟️ attrazione");
    if (isKidsPlace(place)) chips.push("🧸 kids");
    if (isWaterPark(place)) chips.push("💦 acqua");
    if (isSpaPlace(place)) chips.push("🧖 terme");
    if (looksIndoor(place)) chips.push("🏠 indoor");
    if (isWinterNow() && isWaterPark(place) && !looksIndoor(place)) chips.push("❄️ stagionale");
  }
  if (category === "relax" && isSpaPlace(place)) chips.push("🧖 benessere");
  return chips.slice(0, 5);
}

// -------------------- MONET BOX --------------------
function monetBoxHtml(placeName, country = "") {
  const q = country ? `${placeName}, ${country}` : placeName;
  return `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">💸 Prenota al volo (link monetizzabili)</div>
      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn" target="_blank" rel="noopener" href="${bookingUrl(q, "", BOOKING_AID)}">🏨 Hotel</a>
        <a class="btn" target="_blank" rel="noopener" href="${getYourGuideUrl(q, GYG_PID)}">🎟️ Tour</a>
        <a class="btn" target="_blank" rel="noopener" href="${tiqetsUrl(q, TIQETS_PID)}">🏛️ Biglietti</a>
        <a class="btn" target="_blank" rel="noopener" href="${amazonEssentialsUrl(AMAZON_TAG)}">🧳 Essenziali</a>
      </div>
      <div class="small muted" style="margin-top:8px;">
        (Inserisci i tuoi ID in app.js: BOOKING_AID / GYG_PID / TIQETS_PID / AMAZON_TAG)
      </div>
    </div>
  `;
}

// -------------------- RENDER --------------------
function renderResult(origin, maxMinutesShown, chosen, alternatives = [], meta = {}) {
  const area = $("resultArea");
  if (!area) return;

  const category = meta.category || "ovunque";

  if (!chosen) {
    // se LIVE è ancora in corso, NON mostrare "nessun risultato"
    if (meta.liveStage === "loading") {
      showSearchingCard("🛰️ LIVE: sto cercando attrazioni/mete vicine…");
      return;
    }

    area.innerHTML = `
      <div class="card errbox">
        <div class="small">❌ Nessuna meta trovata entro ${maxMinutesShown} min con i filtri attuali.</div>
        <div class="small muted" style="margin-top:6px;">Prova ad aumentare i minuti o cambiare categoria/stile.</div>
        <div class="row wrap gap" style="margin-top:12px;">
          <button class="btn btn-ghost" id="btnResetRotation">🧽 Reset “oggi”</button>
        </div>
      </div>
    `;
    $("btnResetRotation")?.addEventListener("click", () => {
      resetRotation();
      showStatus("ok", "Reset fatto ✅ Ora posso ripescare anche mete già proposte oggi.");
      runSearch({ silent: true });
    });
    return;
  }

  const p = chosen.place;
  const pid = chosen.pid;

  const country = p.country || p.area || "—";
  const badge = String(p.visibility || "").toLowerCase() === "chicca" ? "✨ chicca" : "✅ classica";
  const tb = typeBadge(category);
  const what = microWhatToDo(p, category);
  const chips = chipsFromPlace(p, category);

  const lat = Number(p.lat);
  const lon = Number(p.lon ?? p.lng);

  const zoom = chosen.km < 20 ? 12 : chosen.km < 60 ? 10 : 8;
  const img1 = osmStaticImgPrimary(lat, lon, zoom);
  const img2 = osmStaticImgFallback(lat, lon, zoom);

  const liveLine =
    meta.liveStage === "loading" ? "🛰️ LIVE: sto cercando…" :
    meta.liveUsed ? `🛰️ LIVE: ok (${meta.liveCount || 0})` :
    "🛰️ LIVE: non disponibile";

  const q = (p.country || p.area) ? `${p.name}, ${p.country || p.area}` : p.name;

  area.innerHTML = `
    <div class="card okbox" style="overflow:hidden; padding:0;">
      <div style="position:relative; width:100%; aspect-ratio: 2 / 1; background:
                  radial-gradient(circle at 30% 30%, rgba(26,255,213,.18), rgba(0,224,255,.08)),
                  linear-gradient(180deg, rgba(20,28,34,.0), rgba(10,15,20,.65));
                  border-bottom:1px solid var(--border);">
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
        <div style="font-weight:950; font-size:28px; line-height:1.12;">
          ${p.name} <span class="small muted" style="font-weight:700;">(${country})</span>
        </div>

        <div class="small muted" style="margin-top:8px; line-height:1.35;">
          ${liveLine}
          ${MACRO_SOURCE_URL ? ` • macro: ${MACRO_SOURCE_URL.split("/").pop()}` : ""}
          • score: ${chosen.score}
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
        <div class="small muted" style="margin-bottom:8px;">Altre 2 alternative</div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
          ${alternatives.slice(0, 2).map(a => {
            const ap = a.place;
            const alat = Number(ap.lat);
            const alon = Number(ap.lon ?? ap.lng);
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
    showStatus("ok", "Reset fatto ✅ Ora posso ripescare anche mete già proposte oggi.");
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

// -------------------- MAIN SEARCH --------------------
async function runSearch({ silent = false, forbidPid = null, forcePid = null } = {}) {
  // abort previous
  try { SEARCH_ABORT?.abort?.(); } catch {}
  SEARCH_ABORT = new AbortController();
  const signal = SEARCH_ABORT.signal;

  const token = ++SEARCH_TOKEN;

  try {
    if (!silent) hideStatus();

    showSearchingCard("🔎 Sto cercando la meta (offline)…");
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

    // OFFLINE
    let pool = Array.isArray(MACRO?.places) ? MACRO.places.slice() : [];
    let picked = pickDestinationFromPool(pool, origin, effMax, category, styles);
    let chosen = picked.chosen;
    let alternatives = picked.alternatives;

    // apply force / forbid (offline)
    if (forcePid) {
      const cands = buildCandidatesFromPool(pool, origin, effMax, category, styles, { ignoreVisited: true, ignoreRotation: true });
      const forced = cands.find(x => x.pid === forcePid);
      if (forced) {
        chosen = forced;
        alternatives = cands.filter(x => x.pid !== forcePid).slice(0, 2);
      }
    } else if (forbidPid && chosen?.pid === forbidPid) {
      const cands = buildCandidatesFromPool(pool, origin, effMax, category, styles, { ignoreVisited: true, ignoreRotation: true })
        .filter(x => x.pid !== forbidPid);
      chosen = cands[0] || null;
      alternatives = cands.slice(1, 3);
    }

    if (token !== SEARCH_TOKEN) return;

    // render offline but show that live is loading
    renderResult(origin, maxMinutesInput, chosen, alternatives, {
      category,
      liveStage: "loading",
      liveUsed: false,
      liveCount: 0
    });

    if (!silent) showStatus("warn", "🛰️ LIVE: sto cercando attrazioni/mete vicine…");

    // LIVE radius
    const baseRadius = Math.round((effMax / 60) * 55);
    const radiusKm = (category === "family")
      ? clamp(Math.round(baseRadius * 1.7), 35, 280)
      : clamp(baseRadius, 20, 200);

    const live = await fetchLivePlaces(origin, radiusKm, category, signal);
    if (token !== SEARCH_TOKEN) return;

    let liveUsed = false;
    let liveCount = 0;

    if (live.ok && live.places.length) {
      liveUsed = true;
      liveCount = live.places.length;

      // merge by normalized name
      const seenNames = new Set(pool.map(p => normName(p?.name)));
      for (const lp of live.places) {
        const k = normName(lp?.name);
        if (!k || seenNames.has(k)) continue;
        seenNames.add(k);
        pool.push(lp);
      }

      // repick with merged pool
      picked = pickDestinationFromPool(pool, origin, effMax, category, styles);
      chosen = picked.chosen;
      alternatives = picked.alternatives;

      // apply force/forbid again
      if (forcePid) {
        const cands = buildCandidatesFromPool(pool, origin, effMax, category, styles, { ignoreVisited: true, ignoreRotation: true });
        const forced = cands.find(x => x.pid === forcePid);
        if (forced) {
          chosen = forced;
          alternatives = cands.filter(x => x.pid !== forcePid).slice(0, 2);
        }
      } else if (forbidPid && chosen?.pid === forbidPid) {
        const cands = buildCandidatesFromPool(pool, origin, effMax, category, styles, { ignoreVisited: true, ignoreRotation: true })
          .filter(x => x.pid !== forbidPid);
        chosen = cands[0] || null;
        alternatives = cands.slice(1, 3);
      }
    }

    if (token !== SEARCH_TOKEN) return;

    renderResult(origin, maxMinutesInput, chosen, alternatives, {
      category,
      liveStage: "done",
      liveUsed,
      liveCount
    });

    if (!chosen) {
      showStatus("warn", `Nessuna meta entro ${maxMinutesInput} min. Aumenta minuti o cambia filtri.`);
    } else if (!silent) {
      showStatus("ok", `Meta trovata ✅ (~${chosen.driveMin} min) • ${liveUsed ? "LIVE ok" : "LIVE non disponibile"}`);
    }
  } catch (e) {
    if (String(e?.name || "").includes("Abort")) return;
    console.error(e);
    showStatus("err", `Errore: ${String(e?.message || e)}`);
    showSearchingCard("❌ Errore durante la ricerca. Riprova.");
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
      setOrigin({ label: result.label || label, lat: result.lat, lon: result.lon });
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

function initAll() {
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

  // SW update hint
  (async function swUpdateHint(){
    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        regs.forEach(r => r.update().catch(()=>{}));
      }
    } catch {}
  })();
}

document.addEventListener("DOMContentLoaded", initAll);
