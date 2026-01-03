/* Jamo — Auto-only — app.js v4.0 (FULL FIX)
 * - Macro loader: macros_index.json + robust fallback (no more 404 crashes)
 * - Better category matching (family/storia/borghi) + smart widening
 * - Working reset "proposte di oggi"
 * - Immediate links: Foto / Cosa vedere / Cosa fare / Ristoranti / Wiki (+ Flights/Trains/Bus)
 * - Bigger monetization buttons
 * - If macro contains things_to_do/family -> show Family panel + things nearby
 */

const $ = (id) => document.getElementById(id);

// -------------------- DATA SOURCES --------------------
const MACROS_INDEX_URL = "/data/macros/macros_index.json";

// Fallback macro that MUST exist (you have it in repo)
const FALLBACK_MACRO_URLS = [
  "/data/macros/euuk_macro_all.json",
  "/data/macros/it_macro_01_abruzzo.json",
];

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
const BOOKING_AID = ""; // Booking.com affiliate id (aid)
const AMAZON_TAG  = ""; // Amazon tag
const GYG_PID     = ""; // GetYourGuide partner_id
const TIQETS_PID  = ""; // Tiqets partner

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
  return p.id || `p_${normName(p.name)}_${String(p.lat).slice(0, 6)}_${String(p.lon ?? p.lng).slice(0, 6)}`;
}

function estCarMinutesFromKm(km) {
  const roadKm = km * ROAD_FACTOR;
  const driveMin = (roadKm / AVG_KMH) * 60;
  return Math.round(clamp(driveMin + FIXED_OVERHEAD_MIN, 6, 900));
}

function fmtKm(km) { return `${Math.round(km)} km`; }

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
  // "cosa vedere" / "cosa fare"
  return `https://www.google.com/search?q=${encodeURIComponent("cosa vedere " + q)}`;
}
function googleDoUrl(q) {
  return `https://www.google.com/search?q=${encodeURIComponent("cosa fare " + q)}`;
}
function wikiUrl(title) {
  // IT wikipedia search
  return `https://it.wikipedia.org/w/index.php?search=${encodeURIComponent(title)}`;
}
function restaurantsUrl(q) {
  return gmapsQueryUrl(`${q} ristoranti`);
}
function eventsUrl(q) {
  // simple, offline-safe: google search "eventi + luogo"
  return `https://www.google.com/search?q=${encodeURIComponent("eventi " + q)}`;
}

// transport (no routes, just search page)
function flightsUrl(cityOrPlace) {
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(cityOrPlace)}`;
}
function trainsUrl(cityOrPlace) {
  return `https://www.thetrainline.com/it?search=${encodeURIComponent(cityOrPlace)}`;
}
function busUrl(cityOrPlace) {
  return `https://www.omio.it/search?query=${encodeURIComponent(cityOrPlace)}`;
}

// -------------------- Monetization URLs (robust) --------------------
function bookingUrl(q, countryCode = "", affId = "") {
  const query = `${q}${countryCode ? ", " + countryCode : ""}`;
  const base = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(query)}`;
  return affId ? `${base}&aid=${encodeURIComponent(affId)}` : base;
}
function getYourGuideUrl(q, affId = "") {
  // GYG is picky: prefer query-only search (works better)
  const base = `https://www.getyourguide.com/s/?q=${encodeURIComponent(q)}`;
  return affId ? `${base}&partner_id=${encodeURIComponent(affId)}` : base;
}
function tiqetsUrl(q, affId = "") {
  // Tiqets query page sometimes 404 with certain locales/paths: use root + query
  const base = `https://www.tiqets.com/en/search/?query=${encodeURIComponent(q)}`;
  return affId ? `${base}&partner=${encodeURIComponent(affId)}` : base;
}
function amazonEssentialsUrl(tag = "") {
  const base = `https://www.amazon.it/s?k=${encodeURIComponent("accessori viaggio")}#`;
  return tag ? `${base}&tag=${encodeURIComponent(tag)}` : base;
}

// -------------------- STORAGE: origin + visited + recent --------------------
function setOrigin({ label, lat, lon }) {
  $("originLabel").value = label ?? "";
  $("originLat").value = String(lat);
  $("originLon").value = String(lon);
  localStorage.setItem("jamo_origin", JSON.stringify({ label, lat, lon }));
  $("originStatus").textContent =
    `✅ Partenza: ${label || "posizione"} (${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)})`;
}

function getOrigin() {
  const lat = Number($("originLat").value);
  const lon = Number($("originLon").value);
  const label = ($("originLabel").value || "").trim();
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
  try { return Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : []; }
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
      if (Number.isFinite(v)) $("maxMinutes").value = String(v);
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
  box.classList.remove("okbox", "warnbox", "errbox");
  if (type === "ok") box.classList.add("okbox");
  else if (type === "err") box.classList.add("errbox");
  else box.classList.add("warnbox");
  t.textContent = text;
  box.style.display = "block";
}

function hideStatus() {
  $("statusBox").style.display = "none";
  $("statusText").textContent = "";
}

// -------------------- MACRO LOADING (NO MORE 404) --------------------
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
  } catch (e) {
    // Index not required; we can still use fallback macro
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
  // super simple: if label contains a country/region in EU, still ok; we default to EUUK all
  // if label contains italian things, prefer italy country macro if exists
  if (s.includes("italia") || s.includes("italy") || s.includes("l aquila") || s.includes("roma") || s.includes("pescara")) return "IT";
  return "EUUK";
}

async function loadBestMacroForOrigin(origin) {
  if (!origin) origin = getOrigin();

  // If user previously picked a macro, try it first
  const saved = localStorage.getItem("jamo_macro_url");
  if (saved) {
    const m = await tryLoadMacro(saved);
    if (m) { MACRO = m; MACRO_SOURCE_URL = saved; return m; }
  }

  // Load index if present
  await loadMacrosIndexSafe();

  // Prefer EUUK all to avoid missing region files
  const preferredScope = inferScopeFromOriginLabel(origin?.label || "");

  const candidates = [];
  if (MACROS_INDEX?.items?.length) {
    // Always include euuk_macro_all if present
    const euukAll = MACROS_INDEX.items.find(x => x.id === "euuk_macro_all" || x.path?.includes("euuk_macro_all.json"));
    if (euukAll?.path) candidates.push(euukAll.path);

    // Include euuk_country_it if IT
    if (preferredScope === "IT") {
      const itCountry = MACROS_INDEX.items.find(x => x.id === "euuk_country_it" || (x.scope === "country" && x.country === "IT" && x.path?.includes("euuk_country_it.json")));
      if (itCountry?.path) candidates.unshift(itCountry.path);
    }
  }

  // Append hard fallbacks
  for (const u of FALLBACK_MACRO_URLS) candidates.push(u);

  // Try in order
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
  if (!q) throw new Error("Scrivi un luogo (es: L'Aquila, Roma, Via Roma 10)");
  const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { method: "GET" });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error("Geocoding fallito (risposta vuota)");
  if (!j.ok) throw new Error(j.error || "Geocoding fallito");
  if (!j.result || !Number.isFinite(Number(j.result.lat)) || !Number.isFinite(Number(j.result.lon))) {
    throw new Error("Geocoding fallito (coordinate non valide)");
  }
  return j.result; // {label, lat, lon}
}

// -------------------- FILTERS (IMPROVED) --------------------
function placeTags(place) {
  return (place.tags || []).map(t => String(t).toLowerCase());
}

function isFamilyPlace(place) {
  const tags = placeTags(place);
  const t = String(place.type || "").toLowerCase();
  if (t === "family" || t === "bambini") return true;

  // accepts many variants
  if (tags.includes("famiglie") || tags.includes("family") || tags.includes("bambini") || tags.includes("animali")) return true;

  // if macro has family object
  if (place.family && (place.family.bimbi || place.family.ragazzi || (Number(place.family.score) || 0) >= 0.2)) return true;

  // fallback: if has "parco" "zoo" etc in name
  const n = normName(place.name);
  if (n.includes("parco") || n.includes("zoo") || n.includes("acquario") || n.includes("area giochi") || n.includes("playground")) return true;

  return false;
}

function matchesCategory(place, cat) {
  if (!cat || cat === "ovunque") return true;

  const type = String(place.type || "").toLowerCase();
  const tags = placeTags(place);
  const n = normName(place.name);

  if (cat === "citta") return type === "citta" || tags.includes("citta") || tags.includes("city");
  if (cat === "borghi") return type === "borgo" || tags.includes("borgo") || n.includes("borgo") || n.includes("old town");
  if (cat === "mare") return (
    type === "mare" ||
    tags.includes("mare") ||
    tags.includes("trabocchi") ||
    tags.includes("spiagge") ||
    tags.includes("spiaggia") ||
    tags.includes("lido") ||
    n.includes("spiaggia") ||
    n.includes("beach")
  );
  if (cat === "montagna") return (
    type === "montagna" ||
    tags.includes("montagna") ||
    tags.includes("neve") ||
    n.includes("monte") ||
    n.includes("mount")
  );
  if (cat === "natura") return (
    type === "natura" ||
    tags.includes("natura") ||
    tags.includes("lago") ||
    tags.includes("gole") ||
    tags.includes("cascata") ||
    tags.includes("riserva") ||
    tags.includes("parco") ||
    n.includes("parco") ||
    n.includes("lake") ||
    n.includes("waterfall")
  );
  if (cat === "storia") return (
    type === "storia" ||
    tags.includes("storia") ||
    tags.includes("castello") ||
    tags.includes("abbazia") ||
    tags.includes("museo") ||
    n.includes("castello") ||
    n.includes("abbazia") ||
    n.includes("museum") ||
    n.includes("cathedral") ||
    n.includes("fort")
  );
  if (cat === "relax") return type === "relax" || tags.includes("relax") || tags.includes("terme") || tags.includes("spa");
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

  // family often needs a bit more range, but keep it sane
  if (category === "family" && m < 60) return clamp(Math.round(m * 1.4), m, 150);

  // mare needs more sometimes
  if (category === "mare" && m < 75) return clamp(Math.round(m * 1.35), m, 180);

  // storia at 30 sometimes too strict - gently widen
  if (category === "storia" && m < 45) return clamp(Math.round(m * 1.25), m, 120);

  return clamp(m, 10, 600);
}

// -------------------- PICK DESTINATION --------------------
function buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited = false, ignoreRotation = false } = {}) {
  const visited = getVisitedSet();
  const recentSet = getRecentSet();
  const target = Number(maxMinutes);

  const oLat = Number(origin.lat);
  const oLon = Number(origin.lon);

  const candidates = [];

  for (const p of MACRO.places) {
    const lat = Number(p.lat);
    const lon = Number(p.lon ?? p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    if (!matchesCategory(p, category)) continue;
    if (!matchesStyle(p, styles)) continue;

    const pid = safeIdFromPlace(p);
    if (!ignoreVisited && visited.has(pid)) continue;

    const km = haversineKm(oLat, oLon, lat, lon);
    const driveMin = estCarMinutesFromKm(km);

    // keep “nearby” results, allow closer than before for family
    if (driveMin > target) continue;
    if (km < (category === "family" ? 0.6 : 1.2)) continue;

    const isChicca = String(p.visibility || "").toLowerCase() === "chicca";

    // family boost if category is family OR place is family-friendly
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

function pickDestination(origin, maxMinutes, category, styles) {
  let candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: false, ignoreRotation: false });

  // If empty, progressively relax
  if (candidates.length === 0) candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: false, ignoreRotation: true });
  if (candidates.length === 0) candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: true, ignoreRotation: true });

  const chosen = candidates[0] || null;
  const alternatives = candidates.slice(1, 3);
  return { chosen, alternatives, totalCandidates: candidates.length };
}

// -------------------- UI HELPERS: big buttons --------------------
function quickLinksHtml(place, origin) {
  const name = place?.name || "";
  const country = place?.country || place?.area || "";
  const q = country ? `${name}, ${country}` : name;

  const placeUrl = mapsPlaceUrl(place.lat, place.lon ?? place.lng);
  const dirUrl = mapsDirUrl(origin.lat, origin.lon, place.lat, place.lon ?? place.lng);

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
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${flightsUrl(q)}">✈️ Voli</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${trainsUrl(q)}">🚆 Treni</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${busUrl(q)}">🚌 Bus</a>
      </div>
    </div>
  `;
}

function familyPanelHtml(place) {
  const fam = place.family || null;
  const ttd = place.things_to_do || null;

  // if macro doesn't provide it, we still show a generic family hint using tags
  const tags = placeTags(place);
  const isFam = isFamilyPlace(place);

  const score = fam ? (Number(fam.score) || 0) : (isFam ? 0.4 : 0);
  const bimbi = fam ? !!fam.bimbi : (tags.includes("bambini") || tags.includes("famiglie"));
  const ragazzi = fam ? !!fam.ragazzi : (tags.includes("family") || tags.includes("famiglie"));

  const toList = (arr) => (Array.isArray(arr) && arr.length)
    ? `<ul style="margin:8px 0 0; padding-left:18px; color: var(--muted);">
         ${arr.slice(0, 8).map(x => `<li>${x}</li>`).join("")}
       </ul>`
    : `<div class="small muted" style="margin-top:6px;">Nessun dettaglio salvato offline: usa “Cosa vedere / Cosa fare”.</div>`;

  return `
    <div class="card" style="margin-top:12px; border-color: rgba(0,224,255,.35);">
      <div class="pill">👨‍👩‍👧‍👦 Famiglia</div>
      <div class="small muted" style="margin-top:6px;">
        Consigliata: <b>${score >= 0.35 ? "Sì" : "Dipende"}</b>
        • Bimbi: <b>${bimbi ? "Sì" : "—"}</b>
        • Ragazzi: <b>${ragazzi ? "Sì" : "—"}</b>
      </div>

      ${ttd ? `
        <div class="small" style="margin-top:10px; font-weight:800;">🎟️ Attrazioni vicine</div>
        ${toList(ttd.attractions)}

        <div class="small" style="margin-top:10px; font-weight:800;">🌿 Natura / Passeggiate</div>
        ${toList(ttd.nature)}

        <div class="small" style="margin-top:10px; font-weight:800;">🍝 Food (segnali)</div>
        ${toList(ttd.food)}
      ` : `
        <div class="small muted" style="margin-top:10px;">
          Tip: apri “Ristoranti” e “Eventi” per idee family immediate.
        </div>
      `}
    </div>
  `;
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
        (Per monetizzare: inserisci i tuoi ID in app.js: BOOKING_AID / GYG_PID / TIQETS_PID / AMAZON_TAG)
      </div>
    </div>
  `;
}

// -------------------- RENDER --------------------
function renderResult(origin, maxMinutesShown, chosen, alternatives, meta = {}) {
  const area = $("resultArea");
  const category = meta.category || "ovunque";

  if (!chosen) {
    const extra = `Prova ad aumentare i minuti o cambiare categoria/stile.`;
    area.innerHTML = `
      <div class="card errbox">
        <div class="small">❌ Nessuna meta trovata entro ${maxMinutesShown} min con i filtri attuali.</div>
        <div class="small muted" style="margin-top:6px;">${extra}</div>
        <div class="row wrap gap" style="margin-top:12px;">
          <button class="btn btn-ghost" id="btnResetRotation">🧽 Reset “proposte di oggi”</button>
        </div>
      </div>
    `;
    $("btnResetRotation")?.addEventListener("click", () => {
      resetRotation();
      showStatus("ok", "Reset fatto ✅ Ora ti ripropongo mete anche già viste oggi.");
      // optional auto-run
      runSearch({ silent: true });
    });
    return;
  }

  const p = chosen.place;
  const pid = chosen.pid;

  const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
  const badge = isChicca ? "✨ chicca" : "✅ classica";
  const country = p.country || p.area || "—";

  const why = Array.isArray(p.why) ? p.why.slice(0, 4) : [];
  const whyHtml = why.length
    ? `<ul style="margin:10px 0 0; padding-left:18px; color: var(--muted);">
         ${why.map(x => `<li>${x}</li>`).join("")}
       </ul>`
    : "";

  const altHtml = (alternatives || []).length ? `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Alternative (tocca per scegliere)</div>
      <div style="margin-top:10px; display:flex; flex-direction:column; gap:10px;">
        ${(alternatives || []).map(a => {
          const ap = a.place;
          const aPid = a.pid;
          const aIsChicca = String(ap.visibility || "").toLowerCase() === "chicca";
          const aBadge = aIsChicca ? "✨" : "✅";
          const q = (ap.country || ap.area) ? `${ap.name}, ${ap.country || ap.area}` : ap.name;

          return `
            <div class="card" data-alt="1" data-pid="${aPid}"
                 style="padding:12px; cursor:pointer; border-color: rgba(255,255,255,.14);">
              <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
                <div>
                  <div style="font-weight:900; font-size:16px; line-height:1.2;">
                    ${ap.name} <span class="small muted">(${aBadge})</span>
                  </div>
                  <div class="small muted" style="margin-top:4px;">
                    ~${a.driveMin} min • ${fmtKm(a.km)} • ${ap.type || "meta"}
                  </div>
                </div>
                <div class="pill" style="white-space:nowrap;">Scegli</div>
              </div>

              <div class="row wrap gap" style="margin-top:10px;">
                <a class="btn btn-ghost" href="${mapsPlaceUrl(ap.lat, ap.lon ?? ap.lng)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Maps</a>
                <a class="btn btn-ghost" href="${googleImagesUrl(q)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Foto</a>
                <a class="btn btn-ghost" href="${googleThingsToDoUrl(q)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Cosa vedere</a>
                <a class="btn btn-ghost" href="${restaurantsUrl(q)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Ristoranti</a>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  ` : "";

  // main render
  area.innerHTML = `
    <div class="card okbox">
      <div class="pill">🚗 auto • ~${chosen.driveMin} min • ${fmtKm(chosen.km)} • ${badge}</div>
      <div class="resultTitle">${p.name} <span class="small muted">(${country})</span></div>

      <div class="small muted" style="margin-top:6px;">
        Categoria: <b>${p.type || "meta"}</b> • Punteggio: <b>${chosen.score}</b>
        ${MACRO_SOURCE_URL ? ` • <span class="muted">dataset: ${MACRO_SOURCE_URL.split("/").pop()}</span>` : ""}
      </div>

      ${whyHtml}

      <div class="row wrap gap" style="margin-top:12px;">
        <button class="btn btn-ghost" id="btnVisited">✅ Già visitato</button>
        <button class="btn" id="btnChange">🔁 Cambia meta</button>
        <button class="btn btn-ghost" id="btnResetRotation">🧽 Reset “oggi”</button>
      </div>
    </div>

    ${quickLinksHtml(p, origin)}
    ${familyPanelHtml(p)}
    ${monetBoxHtml(p.name, country)}
    ${altHtml}
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

  // Alternative click -> render as main
  [...area.querySelectorAll('[data-alt="1"][data-pid]')].forEach((el) => {
    el.addEventListener("click", () => {
      const pid2 = el.getAttribute("data-pid");
      const alt = (alternatives || []).find(x => x.pid === pid2);
      if (!alt) return;

      LAST_SHOWN_PID = pid2;
      SESSION_SEEN.add(pid2);
      addRecent(pid2);

      const remaining = (alternatives || []).filter(x => x.pid !== pid2);
      const newAlternatives = [
        { place: p, pid: pid, km: chosen.km, driveMin: chosen.driveMin, score: chosen.score },
        ...remaining
      ].slice(0, 2);

      renderResult(origin, maxMinutesShown, alt, newAlternatives, meta);
      showStatus("ok", "Ok ✅ Ho scelto l’alternativa.");
    });
  });
}

// -------------------- MAIN SEARCH --------------------
async function runSearch({ silent = false, forbidPid = null } = {}) {
  try {
    if (!silent) hideStatus();

    await ensureMacroLoaded();

    const origin = getOrigin();
    if (!origin || !Number.isFinite(Number(origin.lat)) || !Number.isFinite(Number(origin.lon))) {
      showStatus("err", "Imposta una partenza: GPS oppure scrivi un luogo e premi “Usa questo luogo”.");
      return;
    }

    const maxMinutesInput = clamp(Number($("maxMinutes").value) || 120, 10, 600);
    const category = getActiveCategory();
    const styles = getActiveStyles();

    const effMax = effectiveMaxMinutes(maxMinutesInput, category);

    let { chosen, alternatives } = pickDestination(origin, effMax, category, styles);

    // forbid immediate specific pid (cambia meta)
    if (forbidPid && chosen?.pid === forbidPid) {
      const tmp = new Set(SESSION_SEEN);
      tmp.add(forbidPid);

      const visited = getVisitedSet();
      const recentSet = getRecentSet();
      const target = effMax;

      const candidates = [];
      const oLat = Number(origin.lat), oLon = Number(origin.lon);

      for (const p of MACRO.places) {
        const lat = Number(p.lat), lon = Number(p.lon ?? p.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        const pid = safeIdFromPlace(p);
        if (visited.has(pid)) continue;
        if (!matchesCategory(p, category)) continue;
        if (!matchesStyle(p, styles)) continue;

        const km = haversineKm(oLat, oLon, lat, lon);
        const driveMin = estCarMinutesFromKm(km);
        if (driveMin > target) continue;
        if (km < (category === "family" ? 0.6 : 1.2)) continue;
        if (tmp.has(pid)) continue;

        const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
        const familyBoost =
          (category === "family" || isFamilyPlace(p))
            ? clamp((Number(p.family?.score) || 0.3) * 0.12, 0, 0.12)
            : 0;

        let s = baseScorePlace({ driveMin, targetMin: target, beautyScore: p.beauty_score, familyBoost, isChicca });
        s = s - rotationPenalty(pid, recentSet);

        candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
      }

      candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
      chosen = candidates[0] || null;
      alternatives = candidates.slice(1, 3);
    }

    renderResult(origin, maxMinutesInput, chosen, alternatives, { category, effMax });

    if (!chosen) {
      showStatus("warn", `Nessuna meta entro ${maxMinutesInput} min. Prova ad aumentare i minuti o cambiare filtri.`);
    } else if (!silent) {
      const extra = (effMax !== maxMinutesInput)
        ? ` (ho allargato a ~${effMax} min per non lasciarti a secco)`
        : "";
      showStatus("ok", `Meta trovata ✅ (~${chosen.driveMin} min in auto)${extra}`);
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
    const chips = [...$("timeChips").querySelectorAll(".chip")];
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
    $("originStatus").textContent = "📍 Sto leggendo il GPS…";
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        setOrigin({ label: "La mia posizione", lat, lon });
        showStatus("ok", "Partenza GPS impostata ✅");

        // also reload best macro for this origin
        MACRO = null;
        await ensureMacroLoaded().catch(() => {});
      },
      (err) => {
        console.error(err);
        $("originStatus").textContent = "❌ GPS non disponibile (permessi?)";
        showStatus("err", "GPS non disponibile. Scrivi un luogo e usa “Usa questo luogo”.");
      },
      { enableHighAccuracy: true, timeout: 12000 }
    );
  });

  $("btnFindPlace")?.addEventListener("click", async () => {
    try {
      const label = $("originLabel").value;
      $("originStatus").textContent = "🔎 Cerco il luogo…";
      const result = await geocodeLabel(label);
      setOrigin({ label: result.label || label, lat: result.lat, lon: result.lon });
      showStatus("ok", "Partenza impostata ✅");

      // reload best macro for this origin
      MACRO = null;
      await ensureMacroLoaded().catch(() => {});
    } catch (e) {
      console.error(e);
      $("originStatus").textContent = `❌ ${String(e.message || e)}`;
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
