/* Jamo — app.js v8.0 (FULL CLEAN)
 * ✅ Offline macro + LIVE Overpass merge (ALWAYS attempted)
 * ✅ Clear “LIVE searching…” UI (no fake “nessun risultato” while live is running)
 * ✅ Anti-race: abort previous + token
 * ✅ Category logic FIXED for ALL categories:
 *    - FAMILY: hard attractions > pools/terme > BIG PARKS > soft family (NO towns/borghi)
 *    - NATURA: only real nature (NO towns/borghi)
 *    - STORIA: castles/museums/heritage/old town POIs (NO generic towns)
 *    - MARE: beaches/coast/marinas (NO generic towns)
 *    - BORGHI: villages/hamlets only
 *    - CITTA: city/town + attractions
 *    - MONTAGNA: peaks/trails/huts/ropeways/viewpoints(named)
 *    - RELAX: spa/terme + wellness + scenic chill (named)
 * ✅ “Chicche” = real gems: penalize famous/big places, boost uncommon
 * ✅ No “Meta” placeholder places
 * ✅ Stable cards + 2 alternatives + better layout (no overlapping text)
 * ✅ Static map image with fallback; always visible placeholder if image fails
 */

const $ = (id) => document.getElementById(id);

// -------------------- DATA SOURCES --------------------
const MACROS_INDEX_URL = "/data/macros/macros_index.json";
const FALLBACK_MACRO_URLS = [
  "/data/macros/euuk_macro_all.json",
  "/data/macros/it_macro_01_abruzzo.json",
];

// Live API (Next/Vercel): /api/destinations
const LIVE_API_URL = "/api/destinations";

// -------------------- ROUTING / ESTIMATOR --------------------
const ROAD_FACTOR = 1.25;
const AVG_KMH = 72;
const FIXED_OVERHEAD_MIN = 8;

// -------------------- ROTATION --------------------
const RECENT_TTL_MS = 1000 * 60 * 60 * 20; // ~20h
const RECENT_MAX = 160;
let SESSION_SEEN = new Set();
let LAST_SHOWN_PID = null;

// -------------------- MONETIZATION IDS (fill yours) --------------------
const BOOKING_AID = "";
const AMAZON_TAG  = "";
const GYG_PID     = "";
const TIQETS_PID  = "";

// -------------------- GLOBAL SEARCH CONTROL --------------------
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

// -------------------- STATIC MAP IMAGES --------------------
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
  const latEl = $("originLat");
  const lonEl = $("originLon");
  const labEl = $("originLabel");

  const lat = Number(latEl?.value);
  const lon = Number(lonEl?.value);
  const label = (labEl?.value || "").trim();

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

    // trigger immediate search feels snappier (optional)
    // runSearch({ silent: true });

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

function setResultBanner({ title = "", subtitle = "", tone = "warn" } = {}) {
  const area = $("resultArea");
  if (!area) return;

  const klass = tone === "ok" ? "okbox" : tone === "err" ? "errbox" : "warnbox";
  const safeTitle = String(title || "");
  const safeSub = String(subtitle || "");

  area.innerHTML = `
    <div class="card ${klass}">
      <div style="font-weight:900; font-size:14px;">${safeTitle}</div>
      ${safeSub ? `<div class="small muted" style="margin-top:6px; line-height:1.35;">${safeSub}</div>` : ""}
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
  if (s.includes("italia") || s.includes("italy") || s.includes("l aquila") || s.includes("roma") || s.includes("pescara")) return "IT";
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

// -------------------- TAGS / CATEGORY INTENT --------------------
function placeTags(place) {
  const raw = Array.isArray(place?.tags) ? place.tags : [];
  // tags may come as "leisure=park" or "park"; normalize to lower
  return raw.map(t => String(t).toLowerCase());
}

function getLiveTag(place, key) {
  // for mapped LIVE objects we store tags as array like ["tourism", "theme_park"] etc.
  // so we just use name+type heuristics, not raw object.
  return null;
}

function isWaterPark(place) {
  const t = String(place?.type || "").toLowerCase();
  const tags = placeTags(place);
  const n = normName(place?.name);
  return (
    t.includes("water") || t.includes("acqua") ||
    tags.includes("water_park") ||
    n.includes("acquapark") || n.includes("aqua park") || n.includes("water park") || n.includes("parco acquatico")
  );
}

function isSpaPlace(place) {
  const n = normName(place?.name);
  const tags = placeTags(place);
  const t = String(place?.type || "").toLowerCase();
  return (
    t === "relax" ||
    tags.includes("terme") || tags.includes("spa") ||
    tags.includes("hot_spring") || tags.includes("public_bath") ||
    n.includes("terme") || n.includes("spa") || n.includes("thermal") || n.includes("benessere")
  );
}

// HARD family attractions
function isFamilyAttraction(place) {
  const tags = placeTags(place);
  const type = String(place?.type || "").toLowerCase();
  const n = normName(place?.name);

  // strong type guesses
  if (type.includes("theme") || type.includes("amusement") || type.includes("water") || type.includes("zoo") || type.includes("aquarium")) return true;

  const strong = [
    "theme_park", "amusement_park", "water_park",
    "zoo", "aquarium", "attraction",
    "trampoline", "trampoline_park",
    "indoor_play", "play_centre",
    "swimming_pool", "piscina", "acquapark",
    "adventure", "adventure_park"
  ];
  if (strong.some(x => tags.includes(x))) return true;

  if (
    n.includes("gardaland") ||
    n.includes("mirabilandia") ||
    n.includes("aquapark") ||
    n.includes("aqua park") ||
    n.includes("water park") ||
    n.includes("parco divertimenti") ||
    n.includes("parco acquatico") ||
    n.includes("luna park") ||
    n.includes("zoo") ||
    n.includes("acquario") ||
    n.includes("trampoline") ||
    n.includes("parco avventura") ||
    n.includes("adventure park")
  ) return true;

  return false;
}

// BIG parks: allowed in Family (as fallback, not first choice)
function isBigPark(place) {
  const tags = placeTags(place);
  const n = normName(place?.name);

  const isPark =
    tags.includes("park") ||
    tags.includes("leisure=park") ||
    tags.includes("leisure=park;name") ||
    n.includes("parco") ||
    n.includes("giardini") ||
    n.includes("giardino") ||
    n.includes("villa");

  const isPlayground =
    tags.includes("playground") ||
    n.includes("parco giochi") ||
    n.includes("area giochi") ||
    n.includes("playground");

  if (!isPark || isPlayground) return false;

  const strongWords = [
    "parco nazionale", "parco regionale", "riserva", "oasi",
    "giardini", "giardino", "villa", "bosco", "foresta", "pineta"
  ];
  if (strongWords.some(w => n.includes(w))) return true;

  // If it’s a named park (LIVE often provides name) consider it big-enough
  return n.includes("parco") || n.includes("giardini") || n.includes("villa");
}

// Soft family (no towns/borghi allowed)
function isSoftFamily(place) {
  const tags = placeTags(place);
  const t = String(place?.type || "").toLowerCase();
  const n = normName(place?.name);

  // exclude towns/borghi from family
  if (t === "citta" || t === "borgo") return false;
  if (tags.includes("citta") || tags.includes("city") || tags.includes("borgo")) return false;
  if (tags.includes("place=town") || tags.includes("place=city") || tags.includes("place=village") || tags.includes("place=hamlet")) return false;

  if (isBigPark(place)) return true;

  if (t === "family" || t === "bambini") return true;
  if (tags.includes("famiglie") || tags.includes("family") || tags.includes("bambini")) return true;

  // easy nature
  if (n.includes("lago") || n.includes("cascata") || n.includes("riserva") || n.includes("oasi")) return true;
  if (tags.includes("waterfall") || tags.includes("spring") || tags.includes("nature_reserve") || tags.includes("national_park")) return true;

  if (n.includes("fattoria") || n.includes("agriturismo")) return true;

  return false;
}

// Strict Nature
function isNaturePlace(place) {
  const tags = placeTags(place);
  const t = String(place?.type || "").toLowerCase();
  const n = normName(place?.name);

  // exclude towns/borghi
  if (t === "citta" || t === "borgo") return false;
  if (tags.includes("place=town") || tags.includes("place=city") || tags.includes("place=village") || tags.includes("place=hamlet")) return false;

  const strong = [
    "waterfall", "peak", "spring", "nature_reserve", "national_park",
    "natural=waterfall", "natural=peak", "natural=spring",
    "leisure=nature_reserve", "boundary=national_park"
  ];
  if (strong.some(x => tags.includes(x))) return true;

  if (
    n.includes("cascata") || n.includes("gola") || n.includes("forra") || n.includes("sentiero") ||
    n.includes("parco nazionale") || n.includes("riserva") || n.includes("oasi") ||
    n.includes("lago") || n.includes("monte") || n.includes("cima")
  ) return true;

  // named viewpoint can be okay but not dominate; handled by scoring
  if (tags.includes("viewpoint") || n.includes("belvedere")) return true;

  // parks only if "big park" or protected
  if (isBigPark(place)) return true;

  return (t === "natura");
}

// Strict History
function isHistoryPlace(place) {
  const tags = placeTags(place);
  const t = String(place?.type || "").toLowerCase();
  const n = normName(place?.name);

  // exclude generic towns unless explicitly "old town / centro storico" POI
  const isGenericTown =
    tags.includes("place=town") || tags.includes("place=city") ||
    tags.includes("place=village") || tags.includes("place=hamlet");

  const explicitOldTown =
    n.includes("centro storico") || n.includes("citta vecchia") || n.includes("old town");

  if (isGenericTown && !explicitOldTown) return false;

  const strong = ["castle", "ruins", "archaeological_site", "museum", "monument", "memorial", "fort"];
  if (strong.some(x => tags.includes(x))) return true;

  if (
    n.includes("castello") || n.includes("rocca") || n.includes("forte") ||
    n.includes("abbazia") || n.includes("basilica") || n.includes("duomo") ||
    n.includes("museo") || n.includes("anfiteatro") || n.includes("scavi") ||
    n.includes("necropol") || explicitOldTown
  ) return true;

  return (t === "storia");
}

// Sea
function isSeaPlace(place) {
  const tags = placeTags(place);
  const t = String(place?.type || "").toLowerCase();
  const n = normName(place?.name);

  const strong = ["beach", "natural=beach", "marina", "harbour", "coast"];
  if (strong.some(x => tags.includes(x))) return true;

  if (n.includes("spiaggia") || n.includes("lido") || n.includes("baia") || n.includes("cala")) return true;

  return (t === "mare");
}

// Mountain
function isMountainPlace(place) {
  const tags = placeTags(place);
  const t = String(place?.type || "").toLowerCase();
  const n = normName(place?.name);

  const strong = ["peak", "alpine_hut", "aerialway", "mountain_range"];
  if (strong.some(x => tags.includes(x))) return true;

  if (n.includes("monte") || n.includes("cima") || n.includes("rifugio") || n.includes("passo") || n.includes("funivia")) return true;

  return (t === "montagna");
}

// Borghi (only villages/hamlets + borgo keyword)
function isBorgoPlace(place) {
  const tags = placeTags(place);
  const t = String(place?.type || "").toLowerCase();
  const n = normName(place?.name);
  if (t === "borgo") return true;
  if (tags.includes("place=village") || tags.includes("place=hamlet")) return true;
  if (n.includes("borgo")) return true;
  return false;
}

// City (town/city)
function isCityPlace(place) {
  const tags = placeTags(place);
  const t = String(place?.type || "").toLowerCase();
  if (t === "citta") return true;
  if (tags.includes("place=city") || tags.includes("place=town")) return true;
  if (tags.includes("city") || tags.includes("town")) return true;
  return false;
}

// --- Category matcher (STRICT, no cross-category pollution) ---
function matchesCategory(place, cat) {
  if (!cat || cat === "ovunque") return true;

  if (cat === "family") return (isFamilyAttraction(place) || isSpaPlace(place) || isBigPark(place) || isSoftFamily(place));
  if (cat === "relax") return isSpaPlace(place);
  if (cat === "natura") return isNaturePlace(place);
  if (cat === "storia") return isHistoryPlace(place);
  if (cat === "mare") return isSeaPlace(place);
  if (cat === "montagna") return isMountainPlace(place);
  if (cat === "borghi") return isBorgoPlace(place);
  if (cat === "citta") return isCityPlace(place);

  return true;
}

function matchesStyle(place, { wantChicche, wantClassici }) {
  const vis = String(place?.visibility || "").toLowerCase();
  if (!wantChicche && !wantClassici) return true;
  if (vis === "chicca") return !!wantChicche;
  return !!wantClassici;
}

// -------------------- CHICCHE LOGIC (REAL) --------------------
function isObviouslyFamous(place) {
  const n = normName(place?.name);
  // add/extend as you like
  const famousWords = [
    "roma","milano","venezia","firenze","napoli","torino","bologna","verona",
    "lago di garda","garda","gardaland","colosseo","pompei","duomo"
  ];
  if (famousWords.some(w => n.includes(w))) return true;

  // very big settlements: penalize
  const tags = placeTags(place);
  if (tags.includes("place=city")) return true;
  return false;
}

function chiccaBoost(place, category) {
  const tags = placeTags(place);
  const n = normName(place?.name);

  // If user wants chicche and this is famous/big -> heavy penalty
  if (isObviouslyFamous(place)) return -0.18;

  // boosts for “interesting” types
  let b = 0;

  // attraction/nature/heritage signals feel like gems
  const gemSignals = [
    "waterfall", "peak", "spring", "nature_reserve", "national_park",
    "castle", "ruins", "archaeological_site", "museum", "monument",
    "theme_park", "water_park", "zoo", "aquarium", "attraction",
    "viewpoint"
  ];
  if (gemSignals.some(x => tags.includes(x))) b += 0.06;

  // name hints
  const words = ["belvedere","forra","gola","cascata","oasi","riserva","abbazia","rocca","eremo","laghetto","cala","baia"];
  if (words.some(w => n.includes(w))) b += 0.06;

  // category-specific
  if (category === "family" && isFamilyAttraction(place)) b += 0.05;
  if (category === "relax" && isSpaPlace(place)) b += 0.05;
  if (category === "natura" && isNaturePlace(place)) b += 0.05;
  if (category === "storia" && isHistoryPlace(place)) b += 0.05;

  return clamp(b, -0.2, 0.14);
}

// -------------------- SCORING --------------------
function baseScorePlace({ driveMin, targetMin, beautyScore }) {
  const t = clamp(1 - Math.abs(driveMin - targetMin) / Math.max(25, targetMin * 0.9), 0, 1);
  const b = clamp(Number(beautyScore) || 0.70, 0.35, 1);
  return 0.62 * t + 0.38 * b;
}

function rotationPenalty(pid, recentSet) {
  let pen = 0;
  if (pid && pid === LAST_SHOWN_PID) pen += 0.22;
  if (SESSION_SEEN.has(pid)) pen += 0.18;
  if (recentSet.has(pid)) pen += 0.10;
  return pen;
}

function familyTierBoost(place) {
  // family ranking: hard > spa/pool > big parks > soft
  if (isFamilyAttraction(place)) return 0.22;
  if (isSpaPlace(place)) return 0.10;
  if (isBigPark(place)) return 0.08;
  if (isSoftFamily(place)) return 0.05;
  return 0;
}

function natureQualityBoost(place) {
  const tags = placeTags(place);
  const n = normName(place?.name);
  let b = 0;
  if (tags.includes("waterfall") || n.includes("cascata")) b += 0.10;
  if (tags.includes("peak") || n.includes("cima") || n.includes("monte")) b += 0.06;
  if (tags.includes("nature_reserve") || tags.includes("national_park") || n.includes("riserva") || n.includes("parco nazionale")) b += 0.06;
  // viewpoints ok but small
  if (tags.includes("viewpoint") || n.includes("belvedere")) b += 0.02;
  return clamp(b, 0, 0.14);
}

function historyQualityBoost(place) {
  const tags = placeTags(place);
  const n = normName(place?.name);
  let b = 0;
  if (tags.includes("castle") || n.includes("castello") || n.includes("rocca") || n.includes("forte")) b += 0.10;
  if (tags.includes("archaeological_site") || n.includes("scavi") || n.includes("anfiteatro")) b += 0.08;
  if (tags.includes("museum") || n.includes("museo")) b += 0.06;
  if (n.includes("abbazia") || n.includes("basilica") || n.includes("duomo")) b += 0.05;
  if (n.includes("centro storico") || n.includes("old town")) b += 0.04;
  return clamp(b, 0, 0.14);
}

function relaxQualityBoost(place) {
  const n = normName(place?.name);
  let b = 0;
  if (isSpaPlace(place)) b += 0.10;
  if (n.includes("thermal") || n.includes("benessere")) b += 0.04;
  return clamp(b, 0, 0.12);
}

function seaQualityBoost(place) {
  const n = normName(place?.name);
  let b = 0;
  if (n.includes("spiaggia") || n.includes("baia") || n.includes("cala")) b += 0.08;
  return clamp(b, 0, 0.12);
}

function categoryQualityBoost(place, category) {
  if (category === "family") return familyTierBoost(place);
  if (category === "natura") return natureQualityBoost(place);
  if (category === "storia") return historyQualityBoost(place);
  if (category === "relax") return relaxQualityBoost(place);
  if (category === "mare") return seaQualityBoost(place);
  return 0;
}

// -------------------- TIME WIDENING (smart) --------------------
function effectiveMaxMinutes(maxMinutes, category) {
  const m = Number(maxMinutes);
  if (!Number.isFinite(m)) return 120;

  // widen only slightly; categories must stay strict (no cross)
  if (category === "family" && m < 60) return clamp(Math.round(m * 1.55), m, 170);
  if (category === "mare" && m < 75) return clamp(Math.round(m * 1.45), m, 210);
  if (category === "storia" && m < 50) return clamp(Math.round(m * 1.35), m, 160);
  if (category === "natura" && m < 50) return clamp(Math.round(m * 1.35), m, 160);

  return clamp(m, 10, 600);
}

// -------------------- LIVE FETCH + MAP --------------------
function mapLiveToPlace(el) {
  const tags = el?.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";
  const cleanedName = String(name || "").trim();
  if (!cleanedName || cleanedName.length < 2) return null;

  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const typeGuess = (() => {
    // family
    if (tags.tourism === "theme_park") return "family";
    if (tags.leisure === "water_park") return "family";
    if (tags.tourism === "zoo" || tags.amenity === "zoo") return "family";
    if (tags.tourism === "aquarium" || tags.amenity === "aquarium") return "family";
    if (tags.leisure === "trampoline_park") return "family";
    if (tags.leisure === "swimming_pool" || tags.amenity === "swimming_pool") return "family";

    // history
    if (tags.tourism === "museum") return "storia";
    if (tags.historic) return "storia";

    // sea / nature / relax
    if (tags.natural === "beach") return "mare";
    if (tags.boundary === "national_park" || tags.leisure === "nature_reserve" || tags.natural === "waterfall" || tags.natural === "peak") return "natura";
    if (tags.amenity === "spa" || tags.leisure === "spa" || tags.natural === "hot_spring" || tags.amenity === "public_bath") return "relax";

    // borghi/citta
    if (tags.place === "hamlet" || tags.place === "village") return "borgo";
    if (tags.place === "town" || tags.place === "city") return "citta";

    // fallback
    return "meta";
  })();

  // tag list for heuristics/scoring
  const tagList = [];
  if (tags.tourism) tagList.push(String(tags.tourism));
  if (tags.leisure) tagList.push(String(tags.leisure));
  if (tags.historic) tagList.push(String(tags.historic));
  if (tags.natural) tagList.push(String(tags.natural));
  if (tags.amenity) tagList.push(String(tags.amenity));
  if (tags.boundary) tagList.push(String(tags.boundary));
  if (tags.place) tagList.push(`place=${String(tags.place)}`);

  const id = `live_${el.type}_${el.id}`;

  // remove garbage names like "Meta"
  if (normName(cleanedName) === "meta") return null;

  return {
    id,
    name: cleanedName,
    lat,
    lon,
    country: "",
    area: "",
    type: typeGuess,
    visibility: "classica",
    tags: Array.from(new Set(tagList)).slice(0, 14),
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

    // destinations.js v3 returns ok:true always; still guard
    const elements = j?.data?.elements;
    if (!Array.isArray(elements)) return { ok: false, count: 0, places: [], meta: j?.meta || null };

    const places = elements.map(mapLiveToPlace).filter(Boolean);

    // dedupe by name+coords
    const seen = new Set();
    const uniq = [];
    for (const p of places) {
      const k = `${normName(p.name)}_${String(p.lat).slice(0, 5)}_${String(p.lon).slice(0, 5)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(p);
    }

    return { ok: true, count: uniq.length, places: uniq.slice(0, 420), meta: j?.meta || null };
  } catch {
    return { ok: false, count: 0, places: [], meta: null };
  } finally {
    clearTimeout(t);
  }
}

// -------------------- CANDIDATES / PICK --------------------
function buildCandidatesFromPool(
  pool,
  origin,
  maxMinutes,
  category,
  styles,
  { ignoreVisited = false, ignoreRotation = false } = {}
) {
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

    // strict category
    if (!matchesCategory(p, category)) continue;
    if (!matchesStyle(p, styles)) continue;

    const pid = safeIdFromPlace(p);
    if (!ignoreVisited && visited.has(pid)) continue;

    const km = haversineKm(oLat, oLon, lat, lon);
    const driveMin = estCarMinutesFromKm(km);

    if (driveMin > target) continue;
    if (km < 0.8) continue; // avoid “sei già lì”

    // base score
    let s = baseScorePlace({
      driveMin,
      targetMin: target,
      beautyScore: p.beauty_score,
    });

    // quality by category
    s += categoryQualityBoost(p, category);

    // chicche/classici shaping
    if (styles?.wantChicche && !styles?.wantClassici) {
      // only chicche: strong selection
      s += chiccaBoost(p, category);
      // further push down cities/towns in chicche mode
      if (isObviouslyFamous(p)) s -= 0.20;
      if (isCityPlace(p)) s -= 0.10;
    } else if (styles?.wantChicche) {
      // mixed: softer boost
      s += clamp(chiccaBoost(p, category) * 0.65, -0.12, 0.09);
    }

    // family seasonal hint: water parks in winter get slight penalty unless indoor
    if (category === "family" && isWaterPark(p) && isWinterNow() && !looksIndoor(p)) s -= 0.06;

    // rotation penalty
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

  const chosen = candidates[0] || null;
  const alternatives = candidates.slice(1, 3);
  return { chosen, alternatives, totalCandidates: candidates.length };
}

// -------------------- UI CONTENT HELPERS --------------------
function categoryLabel(cat) {
  const map = {
    family:   { emoji: "👨‍👩‍👧‍👦", label: "Family" },
    relax:    { emoji: "🧖", label: "Relax" },
    natura:   { emoji: "🌿", label: "Natura" },
    storia:   { emoji: "🏛️", label: "Storia" },
    mare:     { emoji: "🌊", label: "Mare" },
    borghi:   { emoji: "🏘️", label: "Borghi" },
    citta:    { emoji: "🏙️", label: "Città" },
    montagna: { emoji: "🏔️", label: "Montagna" },
    ovunque:  { emoji: "🎲", label: "Ovunque" },
  };
  return map[cat] || { emoji: "📍", label: "Meta" };
}

function microWhatToDo(place, category) {
  const n = normName(place.name);
  const tags = placeTags(place);

  if (category === "family") {
    if (isFamilyAttraction(place)) {
      if (n.includes("gardaland") || tags.includes("theme_park")) return "Parco divertimenti top: attrazioni, show e aree kids. Giornata piena.";
      if (isWaterPark(place)) return "Scivoli e piscine: controlla apertura (spesso stagionale).";
      if (tags.includes("zoo") || n.includes("zoo")) return "Animali + percorsi: perfetto con bambini.";
      if (tags.includes("aquarium") || n.includes("acquario")) return "Percorso spesso indoor: ottimo anche d’inverno.";
      if (tags.includes("trampoline_park") || n.includes("trampoline")) return "Attività kids/teen: energia e divertimento indoor.";
      return "Attrazione family: attività e cose da fare sul posto.";
    }
    if (isSpaPlace(place)) return "Relax con famiglia: terme/piscine/spa (spesso con aree dedicate).";
    if (isBigPark(place)) return "Gita nel verde: parco grande, passeggio, picnic e attività nei dintorni.";
    return "Gita family: passeggio, foto, snack e cose carine da fare vicino.";
  }

  if (category === "relax") {
    return "Relax e benessere: terme/spa/piscine + pausa lenta. Verifica accesso e orari.";
  }

  if (category === "storia") {
    if (tags.includes("museum") || n.includes("museo")) return "Musei/mostre e centro storico: visita + pausa caffè.";
    if (n.includes("castello") || tags.includes("castle") || n.includes("rocca") || n.includes("forte")) return "Castello/rocca: storia, vista e foto pazzesche.";
    return "Storia e cultura: monumenti, visite e scorci da scoprire.";
  }

  if (category === "mare") return "Mare: spiaggia, passeggiata e tramonto. Perfetto per relax e foto.";
  if (category === "natura") return "Natura: sentieri, panorami, lago/cascata/riserva nei dintorni.";
  if (category === "montagna") return "Montagna: cima/rifugio/panorami. Controlla meteo e condizioni.";
  if (category === "borghi") return "Borgo: vicoli, belvedere, cibo tipico e foto.";
  if (category === "citta") return "Città: piazze, monumenti e locali. Passeggio + cose da vedere.";
  return "Esplora, foto, cibo e cose da fare nei dintorni.";
}

function chipsFromPlace(place, category) {
  const tags = placeTags(place);
  const n = normName(place.name);
  const chips = [];

  if (category === "family") {
    if (isFamilyAttraction(place)) chips.push("🎟️ attrazione");
    if (isWaterPark(place)) chips.push("💦 acqua");
    if (isSpaPlace(place)) chips.push("🧖 terme");
    if (isBigPark(place)) chips.push("🌳 parco grande");
    if (looksIndoor(place)) chips.push("🏠 indoor");
    if (isWinterNow() && isWaterPark(place) && !looksIndoor(place)) chips.push("❄️ stagionale");
  }

  if (category === "natura") {
    if (tags.includes("waterfall") || n.includes("cascata")) chips.push("💧 cascata");
    if (tags.includes("peak") || n.includes("cima") || n.includes("monte")) chips.push("⛰️ cima");
    if (n.includes("lago")) chips.push("🏞️ lago");
    if (tags.includes("viewpoint") || n.includes("belvedere")) chips.push("👀 panorama");
  }

  if (category === "storia") {
    if (n.includes("castello") || n.includes("rocca") || tags.includes("castle")) chips.push("🏰 castello");
    if (n.includes("museo") || tags.includes("museum")) chips.push("🖼️ museo");
    if (n.includes("abbazia") || n.includes("basilica")) chips.push("⛪ chiesa");
  }

  if (category === "mare") {
    if (n.includes("spiaggia") || tags.includes("beach")) chips.push("🏖️ spiaggia");
    if (n.includes("baia") || n.includes("cala")) chips.push("🌅 baia/cala");
  }

  return chips.slice(0, 5);
}

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

// -------------------- RENDER (main + 2 alternatives) --------------------
function renderResult(origin, maxMinutesShown, chosen, alternatives = [], meta = {}) {
  const area = $("resultArea");
  if (!area) return;

  const category = meta.category || "ovunque";

  if (!chosen) {
    area.innerHTML = `
      <div class="card errbox">
        <div class="small">❌ Nessuna meta trovata entro ${maxMinutesShown} min per <b>${category}</b>.</div>
        ${meta.liveAttempted && !meta.liveDone ? `
          <div class="small muted" style="margin-top:8px;">🛰️ Sto ancora cercando LIVE…</div>
        ` : `
          <div class="small muted" style="margin-top:8px;">Prova ad aumentare i minuti o cambiare categoria/stile.</div>
        `}
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
    return;
  }

  const p = chosen.place;
  const pid = chosen.pid;
  const country = p.country || p.area || "—";

  const cb = categoryLabel(category);
  const what = microWhatToDo(p, category);
  const chips = chipsFromPlace(p, category);

  const lat = Number(p.lat);
  const lon = Number(p.lon ?? p.lng);

  const zoom = chosen.km < 20 ? 12 : chosen.km < 60 ? 10 : 8;
  const img1 = osmStaticImgPrimary(lat, lon, zoom);
  const img2 = osmStaticImgFallback(lat, lon, zoom);

  const q = (p.country || p.area) ? `${p.name}, ${p.country || p.area}` : p.name;

  // LIVE badge text
  const liveStateText =
    meta.liveAttempted
      ? (meta.liveDone
          ? (meta.liveUsed ? `🛰️ LIVE: ok (${meta.liveCount || 0} trovati)` : `🛰️ LIVE: non disponibile`)
          : `🛰️ LIVE: sto cercando…`)
      : "";

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
                    color: rgba(255,255,255,.92); font-weight:900; letter-spacing:.2px; text-align:center; padding:12px;">
          📍 ${p.name}
        </div>

        <div style="position:absolute; left:12px; top:12px; display:flex; gap:8px; flex-wrap:wrap; max-width: calc(100% - 24px);">
          <div class="pill">${cb.emoji} ${cb.label}</div>
          <div class="pill">🚗 ~${chosen.driveMin} min • ${fmtKm(chosen.km)}</div>
          ${category === "family" && isWaterPark(p) && isWinterNow() && !looksIndoor(p) ? `<div class="pill">❄️ stagionale</div>` : ""}
        </div>
      </div>

      <div style="padding:14px;">
        <div style="font-weight:950; font-size:28px; line-height:1.12; margin:0; word-break:break-word;">
          ${p.name} <span class="small muted" style="font-weight:700;">(${country})</span>
        </div>

        <div class="small muted" style="margin-top:8px; line-height:1.35;">
          ${liveStateText ? `${liveStateText} • ` : ""}
          ${MACRO_SOURCE_URL ? `macro: ${MACRO_SOURCE_URL.split("/").pop()} • ` : ""}
          score: ${chosen.score}
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
        <div class="small muted" style="margin-bottom:8px;">Alternative (${category})</div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
          ${alternatives.slice(0, 2).map((a, idx) => {
            const ap = a.place;
            const alat = Number(ap.lat);
            const alon = Number(ap.lon ?? ap.lng);
            const acountry = ap.country || ap.area || "";
            return `
              <div class="card" style="padding:10px; overflow:hidden;">
                <div style="font-weight:900; line-height:1.2; word-break:break-word;">${ap.name}</div>
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

  // buttons
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

// -------------------- MAIN SEARCH --------------------
async function runSearch({ silent = false, forbidPid = null, forcePid = null } = {}) {
  try { SEARCH_ABORT?.abort?.(); } catch {}
  SEARCH_ABORT = new AbortController();
  const signal = SEARCH_ABORT.signal;

  const token = ++SEARCH_TOKEN;

  try {
    if (!silent) hideStatus();

    // UI: immediate feedback (no stale)
    setResultBanner({
      title: "🔎 Sto cercando…",
      subtitle: "Prima offline, poi LIVE (attrazioni/mete vicine).",
      tone: "warn"
    });

    await ensureMacroLoaded();

    const origin = getOrigin();
    if (!origin || !Number.isFinite(Number(origin.lat)) || !Number.isFinite(Number(origin.lon))) {
      showStatus("err", "Imposta una partenza: GPS oppure scrivi un luogo e premi “Usa questo luogo”.");
      setResultBanner({ title: "❌ Partenza mancante", subtitle: "Usa GPS o inserisci un luogo.", tone: "err" });
      return;
    }

    const maxMinutesInput = clamp(Number($("maxMinutes")?.value) || 120, 10, 600);
    const category = getActiveCategory();
    const styles = getActiveStyles();
    const effMax = effectiveMaxMinutes(maxMinutesInput, category);

    const offlinePool = Array.isArray(MACRO?.places) ? MACRO.places : [];
    let pool = offlinePool.slice();

    // OFFLINE pick
    let { chosen, alternatives } = pickDestinationFromPool(pool, origin, effMax, category, styles);

    // Force/forbid (offline)
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

    // Render OFFLINE, BUT show clearly that LIVE is still running
    renderResult(origin, maxMinutesInput, chosen, alternatives, {
      category,
      effMax,
      liveAttempted: true,
      liveDone: false,
      liveUsed: false,
      liveCount: 0
    });

    if (!silent) showStatus("warn", "🛰️ LIVE: sto cercando attrazioni/mete vicine…");

    // LIVE radius: based on time, category-specific
    const baseRadius = Math.round((effMax / 60) * 55);
    const radiusKm =
      category === "mare" ? clamp(Math.round(baseRadius * 1.55), 35, 260) :
      category === "family" ? clamp(Math.round(baseRadius * 1.60), 35, 240) :
      clamp(baseRadius, 20, 200);

    const live = await fetchLivePlaces(origin, radiusKm, category, signal);
    if (token !== SEARCH_TOKEN) return;

    // Merge LIVE into pool (dedupe by normalized name)
    let liveUsed = false;
    let liveCount = 0;

    if (live.ok && Array.isArray(live.places) && live.places.length) {
      liveUsed = true;
      liveCount = live.places.length;

      const seenNames = new Set(pool.map(p => normName(p?.name)));
      for (const lp of live.places) {
        const k = normName(lp.name);
        if (!k || seenNames.has(k)) continue;
        seenNames.add(k);
        pool.push(lp);
      }
    }

    // Re-pick with merged pool (STRICT category still applies)
    let picked = pickDestinationFromPool(pool, origin, effMax, category, styles);

    // Apply force/forbid again after live merge
    if (forcePid) {
      const cands = buildCandidatesFromPool(pool, origin, effMax, category, styles, { ignoreVisited: true, ignoreRotation: true });
      const forced = cands.find(x => x.pid === forcePid);
      if (forced) {
        picked.chosen = forced;
        picked.alternatives = cands.filter(x => x.pid !== forcePid).slice(0, 2);
      }
    } else if (forbidPid && picked.chosen?.pid === forbidPid) {
      const cands = buildCandidatesFromPool(pool, origin, effMax, category, styles, { ignoreVisited: true, ignoreRotation: true })
        .filter(x => x.pid !== forbidPid);
      picked.chosen = cands[0] || null;
      picked.alternatives = cands.slice(1, 3);
    }

    if (token !== SEARCH_TOKEN) return;

    renderResult(origin, maxMinutesInput, picked.chosen, picked.alternatives, {
      category,
      effMax,
      liveAttempted: true,
      liveDone: true,
      liveUsed,
      liveCount
    });

    if (!picked.chosen) {
      showStatus("warn", `Nessuna meta entro ${maxMinutesInput} min per ${category}. Aumenta minuti o cambia filtri.`);
    } else if (!silent) {
      const extra = (effMax !== maxMinutesInput) ? ` (ho allargato a ~${effMax} min)` : "";
      showStatus("ok", `Meta trovata ✅ (~${picked.chosen.driveMin} min) • ${liveUsed ? "LIVE ok" : "LIVE non disponibile"}${extra}`);
    }

  } catch (e) {
    if (String(e?.name || "").includes("Abort")) return;
    console.error(e);
    showStatus("err", `Errore: ${String(e.message || e)}`);
    setResultBanner({ title: "❌ Errore", subtitle: String(e.message || e), tone: "err" });
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

// init chips
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

// SW update hint (reduce "old app.js")
(async function swUpdateHint(){
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      regs.forEach(r => r.update().catch(()=>{}));
    }
  } catch {}
})();
```0
