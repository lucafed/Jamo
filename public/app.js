/* Jamo — public/app.js v8.0 (CLEAN + FAST + LIVE-ROBUST)
 * ✅ Offline macro + LIVE Overpass merge (sempre tentato)
 * ✅ UI reset immediato (niente “vecchia card” mentre cerca)
 * ✅ Anti-race (abort + token)
 * ✅ FAMILY: privilegia attrazioni (parchi, zoo, acquari, waterpark, piscine) ma NON lascia vuoto
 * ✅ Storia / Natura / Mare: LIVE + offline, con fallback se LIVE va in timeout
 * ✅ 2 alternative sempre (se disponibili) e “live: sì/no” anche sulle alternative
 * ✅ Card pulite: niente parole accavallate, niente “mappa …” quando l’immagine fallisce
 * ✅ Link monetizzabili più evidenti
 */

const $ = (id) => document.getElementById(id);

// -------------------- DATA SOURCES --------------------
const MACROS_INDEX_URL = "/data/macros/macros_index.json";
const FALLBACK_MACRO_URLS = [
  "/data/macros/euuk_macro_all.json",
  "/data/macros/it_macro_01_abruzzo.json",
];
const LIVE_API_URL = "/api/destinations"; // GET ?lat&lon&radiusKm&cat

// -------------------- ROUTING / ESTIMATOR --------------------
const ROAD_FACTOR = 1.22;
const AVG_KMH = 74;
const FIXED_OVERHEAD_MIN = 7;

// -------------------- ROTATION --------------------
const RECENT_TTL_MS = 1000 * 60 * 60 * 20; // 20h
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

// -------------------- STATIC MAP IMAGES (safe) --------------------
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
function restaurantsUrl(q) { return gmapsQueryUrl(`${q} ristoranti`); }
function eventsUrl(q) { return `https://www.google.com/search?q=${encodeURIComponent("eventi " + q)}`; }

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

// -------------------- STORAGE: origin + visited + recent --------------------
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
  try { return new Set(JSON.parse(raw) || []); } catch { return new Set(); }
}
function saveVisitedSet(set) { localStorage.setItem("jamo_visited", JSON.stringify([...set])); }
function markVisited(pid) { const s = getVisitedSet(); s.add(pid); saveVisitedSet(s); }
function resetVisited() { localStorage.removeItem("jamo_visited"); }

function loadRecent() {
  const raw = localStorage.getItem("jamo_recent");
  if (!raw) return [];
  try { return Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : []; } catch { return []; }
}
function saveRecent(list) { localStorage.setItem("jamo_recent", JSON.stringify(list.slice(0, RECENT_MAX))); }
function cleanupRecent(list) {
  const t = Date.now();
  return list.filter(x => x && x.pid && (t - (x.ts || 0) <= RECENT_TTL_MS));
}
function addRecent(pid) {
  let list = cleanupRecent(loadRecent());
  list.unshift({ pid, ts: Date.now() });
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

// -------------------- UI: chips + status + instant reset --------------------
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
  return { wantChicche: actives.includes("chicche"), wantClassici: actives.includes("classici") };
}

function showStatus(type, text) {
  const box = $("statusBox"), t = $("statusText");
  if (!box || !t) return;

  box.classList.remove("okbox", "warnbox", "errbox");
  if (type === "ok") box.classList.add("okbox");
  else if (type === "err") box.classList.add("errbox");
  else box.classList.add("warnbox");

  t.textContent = text;
  box.style.display = "block";
}
function hideStatus() {
  const box = $("statusBox"), t = $("statusText");
  if (!box || !t) return;
  box.style.display = "none";
  t.textContent = "";
}

function setResultSkeleton(text = "🔎 Sto cercando…") {
  const area = $("resultArea");
  if (!area) return;
  area.innerHTML = `
    <div class="card warnbox" style="border-style:dashed;">
      <div style="font-weight:900;">${text}</div>
      <div class="small muted" style="margin-top:6px;">Sto aggiornando la proposta…</div>
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
  try { MACROS_INDEX = await fetchJson(MACROS_INDEX_URL); return MACROS_INDEX; }
  catch { MACROS_INDEX = null; return null; }
}

async function tryLoadMacro(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j?.places || !Array.isArray(j.places) || !j.places.length) return null;
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

// -------------------- TAGS / CATEGORY LOGIC --------------------
function placeTags(place) {
  return (place?.tags || []).map(t => String(t).toLowerCase());
}

function looksIndoor(place) {
  const tags = placeTags(place).join(" ");
  const n = normName(place?.name);
  return tags.includes("indoor") || tags.includes("coperto") || n.includes("indoor") || n.includes("coperto");
}

function isWaterPark(place) {
  const t = String(place?.type || "").toLowerCase();
  const tags = placeTags(place);
  const n = normName(place?.name);
  return (
    t.includes("water") || t.includes("acqua") ||
    tags.includes("water_park") || tags.includes("parco acquatico") ||
    n.includes("acquapark") || n.includes("aqua park") || n.includes("water park")
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
    n.includes("terme") || n.includes("spa") || n.includes("thermal")
  );
}

function isFamilyAttraction(place) {
  const tags = placeTags(place);
  const type = String(place?.type || "").toLowerCase();
  const n = normName(place?.name);

  const strongTags = [
    "theme_park", "amusement_park", "water_park",
    "zoo", "aquarium", "attraction",
    "trampoline", "indoor_play", "play_centre",
    "swimming_pool", "piscina", "acquapark",
  ];

  if (type.includes("theme") || type.includes("amusement") || type.includes("water") || type.includes("zoo") || type.includes("aquarium")) return true;
  if (strongTags.some(x => tags.includes(x))) return true;

  if (
    n.includes("gardaland") ||
    n.includes("mirabilandia") ||
    n.includes("aquapark") ||
    n.includes("aqua park") ||
    n.includes("water park") ||
    n.includes("parco divertimenti") ||
    n.includes("parco acquatico") ||
    n.includes("zoo") ||
    n.includes("acquario") ||
    n.includes("luna park") ||
    n.includes("parco giochi")
  ) return true;

  return false;
}

function isSoftFamily(place) {
  const tags = placeTags(place);
  const t = String(place?.type || "").toLowerCase();
  const n = normName(place?.name);

  if (t === "family" || t === "bambini") return true;
  if (tags.includes("famiglie") || tags.includes("family") || tags.includes("bambini")) return true;

  // gite con bimbi anche se non attrazione
  if (["natura","mare","borgo","citta","storia","montagna"].includes(t)) return true;
  if (tags.includes("parco") || tags.includes("riserva") || tags.includes("lago")) return true;

  if (n.includes("parco") || n.includes("giardino") || n.includes("botanic")) return true;
  if (n.includes("area giochi") || n.includes("playground")) return true;

  return false;
}

function matchesCategory(place, cat) {
  if (!cat || cat === "ovunque") return true;

  const type = String(place?.type || "").toLowerCase();
  const tags = placeTags(place);
  const n = normName(place?.name);

  if (cat === "citta") return type === "citta" || tags.includes("citta") || tags.includes("city");
  if (cat === "borghi") return type === "borgo" || tags.includes("borgo") || n.includes("borgo") || n.includes("old town");

  if (cat === "mare") {
    // Nota: senza dati mare in macro, il LIVE è importante.
    return type === "mare" || tags.includes("mare") || tags.includes("spiaggia") || n.includes("spiaggia") || n.includes("beach");
  }

  if (cat === "montagna") return type === "montagna" || tags.includes("montagna") || n.includes("monte") || n.includes("mount");
  if (cat === "natura") return type === "natura" || tags.includes("natura") || tags.includes("parco") || tags.includes("riserva") || n.includes("parco");
  if (cat === "storia") return type === "storia" || tags.includes("storia") || tags.includes("castello") || tags.includes("museo") || n.includes("castello") || n.includes("museo");

  if (cat === "relax") return isSpaPlace(place);

  if (cat === "family") {
    // family deve quasi sempre trovare qualcosa:
    // - forte attrazione
    // - soft family
    // - terme/piscine ok ma un filo meno in score
    return (isFamilyAttraction(place) || isSoftFamily(place) || isSpaPlace(place));
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
function baseScorePlace({ driveMin, targetMin, beautyScore, familyBoost, isChicca }) {
  const t = clamp(1 - Math.abs(driveMin - targetMin) / Math.max(25, targetMin * 0.9), 0, 1);
  const b = clamp(Number(beautyScore) || 0.70, 0.35, 1);
  const c = isChicca ? 0.05 : 0;
  const f = clamp(familyBoost || 0, 0, 0.22);
  return 0.58 * t + 0.33 * b + c + f;
}

function rotationPenalty(pid, recentSet) {
  let pen = 0;
  if (pid && pid === LAST_SHOWN_PID) pen += 0.22;
  if (SESSION_SEEN.has(pid)) pen += 0.18;
  if (recentSet.has(pid)) pen += 0.10;
  return pen;
}

function familyPenalty(place, category) {
  if (category !== "family") return 0;
  // Terme ok ma non devono dominare: piccola penalità
  if (isSpaPlace(place) && !isFamilyAttraction(place)) return 0.07;
  return 0;
}

// -------------------- TIME WIDENING --------------------
function effectiveMaxMinutes(maxMinutes, category) {
  const m = Number(maxMinutes);
  if (!Number.isFinite(m)) return 120;

  if (category === "family" && m < 60) return clamp(Math.round(m * 1.55), m, 170);
  if (category === "mare" && m < 80) return clamp(Math.round(m * 1.35), m, 200);
  if (category === "storia" && m < 55) return clamp(Math.round(m * 1.35), m, 170);
  if (category === "natura" && m < 55) return clamp(Math.round(m * 1.28), m, 160);

  return clamp(m, 10, 600);
}

// -------------------- LIVE FETCH (robust + retry if timeout) --------------------
function mapLiveToPlace(el) {
  const tags = el?.tags || {};
  const name = tags.name || tags["name:it"] || tags.brand || tags.operator || "";
  const cleanedName = String(name || "").trim();
  if (!cleanedName || cleanedName.length < 2) return null;

  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const typeGuess = (() => {
    // FAMILY / attractions
    if (tags.tourism === "theme_park") return "family";
    if (tags.leisure === "water_park") return "family";
    if (tags.amenity === "swimming_pool") return "family";
    if (tags.leisure === "amusement_arcade") return "family";
    if (tags.tourism === "zoo" || tags.amenity === "zoo") return "family";
    if (tags.tourism === "aquarium" || tags.amenity === "aquarium") return "family";
    if (tags.tourism === "attraction") return "family";
    if (tags.tourism === "viewpoint") return "natura";

    // STORIA
    if (tags.tourism === "museum") return "storia";
    if (tags.historic) return "storia";

    // MARE / NATURA
    if (tags.natural === "beach") return "mare";
    if (tags.boundary === "national_park" || tags.leisure === "nature_reserve") return "natura";
    if (tags.natural === "peak" || tags.natural === "waterfall") return "natura";

    // BORGO / CITY
    if (tags.place === "village" || tags.place === "hamlet") return "borgo";
    if (tags.place === "town" || tags.place === "city") return "citta";

    // RELAX
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

  const id = `live_${el.type}_${el.id}`;

  return {
    id,
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
  const hard = setTimeout(() => ctrl.abort(), 11000); // hard timeout
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

    // expected shape: { ok:true, data:{elements:[]}, meta:{} } OR { ok:false,... }
    if (!j || !j.ok || !j.data || !Array.isArray(j.data.elements)) {
      return { ok: false, count: 0, places: [], error: j?.error || j?.details || "live_not_ok" };
    }

    const places = j.data.elements.map(mapLiveToPlace).filter(Boolean);

    // dedupe by name+tile
    const seen = new Set();
    const uniq = [];
    for (const p of places) {
      const k = `${normName(p.name)}_${String(p.lat).slice(0, 5)}_${String(p.lon).slice(0, 5)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(p);
    }

    return { ok: true, count: uniq.length, places: uniq.slice(0, 420), error: null };
  } catch (e) {
    return { ok: false, count: 0, places: [], error: String(e?.name || e?.message || "live_error") };
  } finally {
    clearTimeout(hard);
  }
}

async function fetchLiveWithFallback(origin, radiusKm, category, outerSignal) {
  // 1) try requested radius
  const a = await fetchLivePlaces(origin, radiusKm, category, outerSignal);
  if (a.ok) return a;

  // 2) if timeout or query heavy, retry with smaller radius
  const err = String(a.error || "");
  const shouldRetry = err.toLowerCase().includes("abort") || err.toLowerCase().includes("timeout") || err.toLowerCase().includes("timed");
  if (!shouldRetry) return a;

  const smaller = clamp(Math.round(radiusKm * 0.62), 15, radiusKm);
  if (smaller >= radiusKm - 5) return a;

  const b = await fetchLivePlaces(origin, smaller, category, outerSignal);
  if (b.ok) return b;

  // 3) last attempt very small for dense POI (family/storia)
  const tiny = clamp(Math.round(smaller * 0.6), 10, 45);
  if (tiny === smaller) return b;

  const c = await fetchLivePlaces(origin, tiny, category, outerSignal);
  return c.ok ? c : b;
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
    const nmNorm = normName(nm);
    if (!nm || nm.length < 2 || nmNorm === "meta") continue; // evita “Meta”

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
    if (km < (category === "family" ? 0.6 : 1.0)) continue;

    const isChicca = String(p.visibility || "").toLowerCase() === "chicca";

    let familyBoost = 0;
    if (category === "family") {
      familyBoost += isFamilyAttraction(p) ? 0.22 : (isSoftFamily(p) ? 0.10 : (isSpaPlace(p) ? 0.06 : 0));
    } else if (isFamilyAttraction(p)) {
      familyBoost += 0.05;
    }

    let s = baseScorePlace({
      driveMin,
      targetMin: target,
      beautyScore: p.beauty_score,
      familyBoost,
      isChicca
    });

    s -= familyPenalty(p, category);
    if (!ignoreRotation) s -= rotationPenalty(pid, recentSet);

    candidates.push({
      place: p,
      pid,
      km,
      driveMin,
      score: Number(s.toFixed(4)),
      source: p.live ? "live" : "offline",
    });
  }

  candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
  return candidates;
}

function pickDestinationFromPool(pool, origin, maxMinutes, category, styles) {
  let candidates = buildCandidatesFromPool(pool, origin, maxMinutes, category, styles, { ignoreVisited: false, ignoreRotation: false });
  if (!candidates.length) candidates = buildCandidatesFromPool(pool, origin, maxMinutes, category, styles, { ignoreVisited: false, ignoreRotation: true });
  if (!candidates.length) candidates = buildCandidatesFromPool(pool, origin, maxMinutes, category, styles, { ignoreVisited: true, ignoreRotation: true });

  const chosen = candidates[0] || null;
  const alternatives = candidates.slice(1, 3); // 2 alternative
  return { chosen, alternatives, totalCandidates: candidates.length };
}

// -------------------- CARD UI HELPERS --------------------
function badgeForCategory(cat) {
  const map = {
    family: { e: "👨‍👩‍👧‍👦", t: "Family" },
    storia: { e: "🏛️", t: "Storia" },
    borghi: { e: "🏘️", t: "Borghi" },
    citta:  { e: "🏙️", t: "Città" },
    mare:   { e: "🌊", t: "Mare" },
    natura: { e: "🌿", t: "Natura" },
    montagna:{e:"🏔️",t:"Montagna"},
    relax:  { e: "🧖", t: "Relax" },
    ovunque:{ e: "🎲", t: "Ovunque" },
  };
  return map[cat] || { e: "📍", t: "Meta" };
}

function chipsFromPlace(place, category) {
  const tags = placeTags(place);
  const n = normName(place.name);
  const out = [];

  if (category === "family" || isSoftFamily(place)) {
    if (isFamilyAttraction(place)) out.push("🎟️ attrazione");
    if (isWaterPark(place)) out.push("💦 acqua");
    if (looksIndoor(place)) out.push("🏠 indoor");
    if (isSpaPlace(place)) out.push("🧖 terme");
    if (isWinterNow() && isWaterPark(place) && !looksIndoor(place)) out.push("❄️ stagionale");
    if (n.includes("zoo")) out.push("🦁 zoo");
    if (n.includes("acquario")) out.push("🐠 acquario");
    if (n.includes("piscina")) out.push("🏊 piscina");
  }

  if (category === "storia") {
    if (n.includes("castello")) out.push("🏰 castello");
    if (n.includes("museo")) out.push("🖼️ museo");
    if (tags.includes("historic")) out.push("📜 storico");
  }

  if (category === "mare") out.push("🌊 mare/spiaggia");
  if (category === "natura") out.push("🌿 natura");

  return out.slice(0, 5);
}

function microWhatToDo(place, category) {
  const n = normName(place.name);
  const tags = placeTags(place);

  if (category === "family") {
    if (isFamilyAttraction(place)) {
      if (n.includes("gardaland")) return "Parco divertimenti top: attrazioni, show e aree kids. Giornata piena.";
      if (isWaterPark(place)) return "Scivoli e piscine: controlla apertura (spesso stagionale).";
      if (tags.includes("zoo") || n.includes("zoo")) return "Animali + percorsi: perfetto con bambini.";
      if (tags.includes("aquarium") || n.includes("acquario")) return "Percorso spesso indoor: ottimo anche d’inverno.";
      if (tags.includes("swimming_pool") || n.includes("piscina")) return "Piscine e attività: spesso adatto a famiglie.";
      return "Attrazione family: attività e cose da fare sul posto.";
    }
    if (isSpaPlace(place)) return "Terme/SPA: relax (spesso con piscine). Verifica se ci sono aree family.";
    return "Gita family: passeggio, foto e cose da fare nei dintorni.";
  }

  if (category === "relax") {
    if (isSpaPlace(place)) return "Terme e relax: piscine, spa o acqua calda. Verifica orari e accesso.";
    return "Relax e stacco: posto tranquillo + pausa.";
  }

  if (category === "storia") {
    if (tags.includes("museum") || n.includes("museo")) return "Museo/mostre + passeggiata: perfetto anche con poco tempo.";
    if (n.includes("castello")) return "Castello/rocca: vista, storia e foto pazzesche.";
    return "Storia e cultura: visita + giro nel centro/area storica.";
  }

  if (category === "mare") return "Mare e passeggiata: spiaggia, lungomare e tramonto.";
  if (category === "natura") return "Natura vera: sentieri, panorami e punti notevoli nei dintorni.";
  if (category === "borghi") return "Borgo da esplorare: vicoli, belvedere e cibo tipico.";
  if (category === "citta") return "Centro, monumenti e locali: passeggiata + cose da vedere.";
  return "Esplora, foto, cibo e cose da fare nei dintorni.";
}

// -------------------- MONET BOX --------------------
function monetBoxHtml(placeName, country = "") {
  const q = country ? `${placeName}, ${country}` : placeName;

  return `
    <div class="card" style="margin-top:12px;">
      <div style="font-weight:900;">💸 Prenota al volo</div>
      <div class="small muted" style="margin-top:4px;">Link monetizzabili (metti i tuoi ID in app.js)</div>

      <div class="row wrap gap" style="margin-top:12px;">
        <a class="btn" target="_blank" rel="noopener" href="${bookingUrl(q, "", BOOKING_AID)}">🏨 Hotel</a>
        <a class="btn" target="_blank" rel="noopener" href="${getYourGuideUrl(q, GYG_PID)}">🎟️ Tour</a>
        <a class="btn" target="_blank" rel="noopener" href="${tiqetsUrl(q, TIQETS_PID)}">🏛️ Biglietti</a>
        <a class="btn" target="_blank" rel="noopener" href="${amazonEssentialsUrl(AMAZON_TAG)}">🧳 Essenziali</a>
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
        <div style="font-weight:900;">❌ Nessuna meta entro ${maxMinutesShown} min</div>
        <div class="small muted" style="margin-top:6px;">Prova ad aumentare i minuti o cambiare categoria/stile.</div>
        <div class="row wrap gap" style="margin-top:12px;">
          <button class="btn btn-ghost" id="btnResetRotation">🧽 Reset “proposte di oggi”</button>
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
  const vis = String(p.visibility || "").toLowerCase() === "chicca" ? "✨ chicca" : "✅ classica";
  const liveLabel = meta?.liveUsed ? `live: sì (${meta.liveCount || 0})` : (meta?.liveAttempted ? "live: no" : "live: —");
  const srcLabel = chosen.source === "live" ? "LIVE" : "OFFLINE";

  const tb = badgeForCategory(category);
  const what = microWhatToDo(p, category);
  const chips = chipsFromPlace(p, category);

  const lat = Number(p.lat);
  const lon = Number(p.lon ?? p.lng);

  const zoom = chosen.km < 18 ? 12 : chosen.km < 55 ? 10 : 8;
  const img1 = osmStaticImgPrimary(lat, lon, zoom);
  const img2 = osmStaticImgFallback(lat, lon, zoom);

  const q = (p.country || p.area) ? `${p.name}, ${p.country || p.area}` : p.name;

  // MAIN CARD
  area.innerHTML = `
    <div class="card okbox" style="padding:0; overflow:hidden;">
      <div style="position:relative; width:100%; aspect-ratio: 2 / 1; border-bottom:1px solid var(--border); background:
        radial-gradient(circle at 20% 20%, rgba(26,255,213,.14), rgba(0,224,255,.08)),
        linear-gradient(180deg, rgba(20,28,34,.0), rgba(10,15,20,.65));">
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
             style="position:absolute; inset:0; display:none; align-items:center; justify-content:center;
                    padding:18px; text-align:center;
                    background: linear-gradient(135deg, rgba(0,224,255,.18), rgba(26,255,213,.08));
                    color: rgba(255,255,255,.92); font-weight:950; letter-spacing:.2px;">
          📍 ${p.name}
        </div>

        <div style="position:absolute; left:12px; right:12px; top:12px; display:flex; gap:8px; flex-wrap:wrap;">
          <div class="pill">${tb.e} ${tb.t}</div>
          <div class="pill">🚗 ~${chosen.driveMin} min • ${fmtKm(chosen.km)}</div>
          <div class="pill">${vis}</div>
          ${category === "family" && isWinterNow() && isWaterPark(p) && !looksIndoor(p) ? `<div class="pill">❄️ stagionale</div>` : ""}
        </div>
      </div>

      <div style="padding:14px;">
        <div style="font-weight:950; font-size:26px; line-height:1.15; margin:0; word-break:break-word;">
          ${p.name} <span class="small muted" style="font-weight:750;">(${country})</span>
        </div>

        <div class="small muted" style="margin-top:8px; line-height:1.35;">
          ${liveLabel} • src: ${srcLabel}
          ${MACRO_SOURCE_URL ? ` • macro: ${MACRO_SOURCE_URL.split("/").pop()}` : ""}
          • score: ${chosen.score}
        </div>

        <div style="margin-top:12px; font-weight:900;">Cosa fai qui</div>
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

    ${renderAlternativesHtml(origin, alternatives, category)}
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
    showStatus("ok", "Reset fatto ✅ Ora posso ripescare anche mete già proposte oggi.");
    runSearch({ silent: true });
  });

  // alternative choose
  area.querySelectorAll("button[data-pid]").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetPid = btn.getAttribute("data-pid");
      if (!targetPid) return;
      runSearch({ silent: true, forcePid: targetPid });
    });
  });
}

function renderAlternativesHtml(origin, alternatives, category) {
  const list = (alternatives || []).slice(0, 2);
  if (!list.length) return "";

  const title = category === "family" ? "Altre idee family" : "Altre idee vicino";

  return `
    <div style="margin-top:14px;">
      <div class="small muted" style="margin-bottom:8px;">${title}</div>
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
        ${list.map(a => {
          const ap = a.place;
          const alat = Number(ap.lat);
          const alon = Number(ap.lon ?? ap.lng);
          const acountry = ap.country || ap.area || "";
          const src = a.source === "live" ? "LIVE" : "OFFLINE";
          return `
            <div class="card" style="padding:10px;">
              <div style="font-weight:900; line-height:1.2; word-break:break-word;">${ap.name}</div>
              <div class="small muted" style="margin-top:4px; line-height:1.35;">
                🚗 ~${a.driveMin} min • ${fmtKm(a.km)} ${acountry ? `• (${acountry})` : ""} • ${src}
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
  `;
}

// -------------------- MAIN SEARCH --------------------
async function runSearch({ silent = false, forbidPid = null, forcePid = null } = {}) {
  try { SEARCH_ABORT?.abort?.(); } catch {}
  SEARCH_ABORT = new AbortController();
  const signal = SEARCH_ABORT.signal;
  const token = ++SEARCH_TOKEN;

  try {
    if (!silent) hideStatus();

    // ✅ immediate clear so no stale card
    setResultSkeleton("🔎 Sto cercando la meta…");

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

    // OFFLINE pool
    const offlinePool = Array.isArray(MACRO?.places) ? MACRO.places : [];
    let pool = offlinePool.slice();

    // OFFLINE pick
    let { chosen, alternatives } = pickDestinationFromPool(pool, origin, effMax, category, styles);

    // if forced / forbidden
    ({ chosen, alternatives } = applyForceForbid(pool, origin, effMax, category, styles, chosen, alternatives, forcePid, forbidPid));

    if (token !== SEARCH_TOKEN) return;

    // render OFFLINE immediately
    renderResult(origin, maxMinutesInput, chosen, alternatives, {
      category,
      effMax,
      liveAttempted: true,
      liveUsed: false,
      liveCount: 0
    });

    if (!silent) showStatus("warn", "🛰️ LIVE: cerco attrazioni e mete vicine…");

    // compute radius from time
    const baseRadius = Math.round((effMax / 60) * 52);
    const radiusKm =
      (category === "family") ? clamp(Math.round(baseRadius * 1.55), 25, 200)
      : (category === "mare") ? clamp(Math.round(baseRadius * 1.35), 20, 180)
      : clamp(baseRadius, 18, 165);

    // ALWAYS attempt LIVE (robust + retry smaller)
    const live = await fetchLiveWithFallback(origin, radiusKm, category, signal);
    if (token !== SEARCH_TOKEN) return;

    let liveUsed = false;
    let liveCount = 0;

    if (live.ok && live.places.length) {
      liveUsed = true;
      liveCount = live.places.length;

      // merge live into pool (avoid duplicates by normalized name)
      const seenNames = new Set(pool.map(p => normName(p?.name)));
      for (const lp of live.places) {
        const k = normName(lp.name);
        if (!k || seenNames.has(k)) continue;
        seenNames.add(k);
        pool.push(lp);
      }

      // repick with merged pool
      let picked = pickDestinationFromPool(pool, origin, effMax, category, styles);

      // FAMILY safety: if still empty, widen to ovunque but keep family-ish
      if (category === "family" && !picked.chosen) {
        const widened = buildCandidatesFromPool(pool, origin, effMax, "ovunque", styles, { ignoreVisited: false, ignoreRotation: true })
          .filter(x => isFamilyAttraction(x.place) || isSoftFamily(x.place) || isSpaPlace(x.place))
          .slice(0, 140);
        if (widened.length) picked = { chosen: widened[0], alternatives: widened.slice(1, 3) };
      }

      chosen = picked.chosen;
      alternatives = picked.alternatives;

      // apply force/forbid again on merged pool
      ({ chosen, alternatives } = applyForceForbid(pool, origin, effMax, category, styles, chosen, alternatives, forcePid, forbidPid));
    }

    if (token !== SEARCH_TOKEN) return;

    renderResult(origin, maxMinutesInput, chosen, alternatives, {
      category,
      effMax,
      liveAttempted: true,
      liveUsed,
      liveCount
    });

    if (!chosen) {
      showStatus("warn", `Nessuna meta entro ${maxMinutesInput} min. Aumenta minuti o cambia filtri.`);
    } else if (!silent) {
      const extra = (effMax !== maxMinutesInput) ? ` (ho allargato a ~${effMax} min)` : "";
      showStatus("ok", `Meta trovata ✅ (~${chosen.driveMin} min) • ${liveUsed ? "LIVE ok" : "LIVE no"}${extra}`);
    }

  } catch (e) {
    if (String(e?.name || "").includes("Abort")) return;
    console.error(e);
    showStatus("err", `Errore: ${String(e.message || e)}`);
  }
}

function applyForceForbid(pool, origin, maxMinutes, category, styles, chosen, alternatives, forcePid, forbidPid) {
  // forcePid: choose exactly this if present
  if (forcePid) {
    const all = buildCandidatesFromPool(pool, origin, maxMinutes, category, styles, { ignoreVisited: true, ignoreRotation: true });
    const forced = all.find(x => x.pid === forcePid);
    if (forced) {
      const rest = all.filter(x => x.pid !== forcePid).slice(0, 2);
      return { chosen: forced, alternatives: rest };
    }
  }

  // forbidPid: if chosen equals it, pick next
  if (forbidPid && chosen?.pid === forbidPid) {
    const all = buildCandidatesFromPool(pool, origin, maxMinutes, category, styles, { ignoreVisited: true, ignoreRotation: true })
      .filter(x => x.pid !== forbidPid);
    return { chosen: all[0] || null, alternatives: all.slice(1, 3) };
  }

  return { chosen, alternatives };
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
      () => {
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

// 🔁 SW update hint (riduce rischio “vecchio app.js”)
(async function swUpdateHint(){
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      regs.forEach(r => r.update().catch(()=>{}));
    }
  } catch {}
})();
