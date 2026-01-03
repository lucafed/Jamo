/* Jamo — Auto-only (offline macro) — app.js v4.0
 * Fix:
 * - reset proposte oggi funziona (reset + rerun)
 * - filtri anti mete brutte/random
 * - widen intelligente quando non trova (anche storia 30')
 * - link rapidi: Foto / Cosa fare / Ristoranti (anche per alternative)
 * - monetizzazione più “clickabile” + link voli/treni/bus outbound (no tratte)
 */

const $ = (id) => document.getElementById(id);

// -------------------- SETTINGS --------------------
const MACRO_URL = "/data/macros/it_macro_01_abruzzo.json"; // per ora Abruzzo (poi lo rendiamo dinamico con macros_index)
const DEFAULT_COUNTRY = "IT";

// driving estimator (offline)
const ROAD_FACTOR = 1.25;
const AVG_KMH = 72;
const FIXED_OVERHEAD_MIN = 8;

// ROTATION
const RECENT_TTL_MS = 1000 * 60 * 60 * 20; // ~20h: “oggi”
const RECENT_MAX = 180;                    // quante mete ricordare “oggi”
let SESSION_SEEN = new Set();              // in-memory (sessione)
let LAST_SHOWN_PID = null;

// --- Monetization IDs (metti i tuoi) ---
const BOOKING_AID = "";     // Booking.com affiliate id (aid)
const AMAZON_TAG  = "";     // Amazon tag
const GYG_PID     = "";     // GetYourGuide partner_id
const TIQETS_PID  = "";     // Tiqets partner (se ce l’hai)
const OMIO_AID    = "";     // Omio / Trainline / ecc (placeholder)
const SKYSCANNER_AID = "";  // Skyscanner affiliate (placeholder)

// -------------------- QUALITY FILTERS --------------------
// parole che spesso indicano roba inutile / non turistica
const BAD_NAME_PATTERNS = [
  "progetto case", "zona industriale", "capannone", "deposito", "cimitero",
  "stazione", "fermata", "autostazione", "svincolo", "uscita", "casello",
  "centro commerciale", "iper", "supermercato", "distributore", "parcheggio",
  "area di servizio", "ufficio", "prefettura", "asl", "ospedale",
  "tribunale", "questura", "carcere", "palestra", "campo sportivo",
  "via ", "viale ", "piazza " // spesso indirizzi, non “mete”
].map(s => s.toLowerCase());

// soglie minime per evitare mete “meh”
const MIN_BEAUTY_DEFAULT = 0.74;
const MIN_BEAUTY_BY_CAT = {
  mare: 0.78,
  montagna: 0.76,
  natura: 0.76,
  storia: 0.76,
  borghi: 0.76,
  citta: 0.74,
  relax: 0.72,
  family: 0.70,
  ovunque: 0.74,
};

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
  return p.id || `p_${normName(p.name)}_${String(p.lat).slice(0,6)}_${String(p.lon).slice(0,6)}`;
}

function estCarMinutesFromKm(km) {
  const roadKm = km * ROAD_FACTOR;
  const driveMin = (roadKm / AVG_KMH) * 60;
  return Math.round(clamp(driveMin + FIXED_OVERHEAD_MIN, 8, 900));
}

function fmtKm(km) { return `${Math.round(km)} km`; }

function mapsPlaceUrl(lat, lon) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lon)}`;
}
function mapsDirUrl(oLat, oLon, dLat, dLon) {
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(oLat + "," + oLon)}&destination=${encodeURIComponent(dLat + "," + dLon)}&travelmode=driving`;
}

// “cosa fare / ristoranti / foto” (rapidi e sempre utili)
function mapsThingsToDoUrl(lat, lon, name = "") {
  const q = name ? `cose da fare ${name}` : "cose da fare";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}&query_place_id=&center=${encodeURIComponent(lat + "," + lon)}`;
}
function mapsRestaurantsUrl(lat, lon, name = "") {
  const q = name ? `ristoranti ${name}` : "ristoranti";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}&center=${encodeURIComponent(lat + "," + lon)}`;
}
function googleImagesUrl(name, country = "IT") {
  const q = `${name} ${country} foto`;
  return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`;
}

// -------------------- Monetization URLs --------------------
// NB: qui mettiamo link “outbound” + placeholder id. Quando mi dai i tuoi ID reali, li “stringiamo” meglio.
function bookingUrl(city, countryCode = "IT", affId = "") {
  const q = `${city}${countryCode ? ", " + countryCode : ""}`;
  const base = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(q)}`;
  return affId ? `${base}&aid=${encodeURIComponent(affId)}` : base;
}
function getYourGuideUrl(city, affId = "") {
  // GYG search: stabile
  const base = `https://www.getyourguide.com/s/?q=${encodeURIComponent(city)}`;
  return affId ? `${base}&partner_id=${encodeURIComponent(affId)}` : base;
}
function tiqetsUrl(city, affId = "") {
  // Tiqets spesso dà 404 su alcune query → fallback su home search generica
  const base = `https://www.tiqets.com/it/search/?query=${encodeURIComponent(city)}`;
  return affId ? `${base}&partner=${encodeURIComponent(affId)}` : base;
}
function amazonEssentialsUrl(tag = "") {
  const base = `https://www.amazon.it/s?k=${encodeURIComponent("accessori viaggio")}`;
  return tag ? `${base}&tag=${encodeURIComponent(tag)}` : base;
}

// Travel outbound (no tratte)
function flightsUrl(fromLabel = "", toLabel = "", aff = "") {
  // placeholder generico (poi lo colleghiamo a programma affiliato vero)
  const q = `${fromLabel} ${toLabel}`.trim();
  const base = `https://www.skyscanner.it/transport/flights/?q=${encodeURIComponent(q)}`;
  return aff ? `${base}&affilid=${encodeURIComponent(aff)}` : base;
}
function trainsBusUrl(fromLabel = "", toLabel = "", aff = "") {
  // Omio/Trainline ecc — placeholder generico (poi mettiamo link affiliato corretto)
  const q = `${fromLabel} ${toLabel}`.trim();
  const base = `https://www.omio.it/search-frontend/results/${encodeURIComponent(q)}`;
  return aff ? `${base}?aid=${encodeURIComponent(aff)}` : base;
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
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }
  return null;
}

function getVisitedSet() {
  const raw = localStorage.getItem("jamo_visited");
  if (!raw) return new Set();
  try {
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
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
  try { return Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : []; } catch { return []; }
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
  list = list.filter(x => {
    if (seen.has(x.pid)) return false;
    seen.add(x.pid);
    return true;
  });
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

// -------------------- DATA loading --------------------
let MACRO = null;

async function loadMacro() {
  const r = await fetch(MACRO_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`Macro non trovato (${r.status})`);
  const j = await r.json();
  if (!j?.places || !Array.isArray(j.places)) throw new Error("Macro invalido: manca places[]");
  MACRO = j;
  return j;
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

// -------------------- FILTERS --------------------
function hasBadName(name) {
  const n = String(name || "").toLowerCase();
  return BAD_NAME_PATTERNS.some(p => n.includes(p));
}

function minBeautyFor(cat) {
  return Number.isFinite(MIN_BEAUTY_BY_CAT[cat]) ? MIN_BEAUTY_BY_CAT[cat] : MIN_BEAUTY_DEFAULT;
}

function matchesCategory(place, cat) {
  if (!cat || cat === "ovunque") return true;

  const type = String(place.type || "").toLowerCase();
  const tags = (place.tags || []).map(t => String(t).toLowerCase());

  if (cat === "citta") return type === "citta" || tags.includes("citta");
  if (cat === "borghi") return type === "borgo" || tags.includes("borgo");
  if (cat === "mare") return (
    type === "mare" ||
    tags.includes("mare") ||
    tags.includes("trabocchi") ||
    tags.includes("spiagge") ||
    tags.includes("spiaggia") ||
    tags.includes("lido")
  );
  if (cat === "montagna") return type === "montagna" || tags.includes("montagna") || tags.includes("neve");
  if (cat === "natura") return (
    type === "natura" ||
    tags.includes("natura") ||
    tags.includes("lago") ||
    tags.includes("parco_nazionale") ||
    tags.includes("gole") ||
    tags.includes("cascate") ||
    tags.includes("riserva") ||
    tags.includes("cascata")
  );
  if (cat === "storia") return (
    type === "storia" ||
    tags.includes("storia") ||
    tags.includes("castello") ||
    tags.includes("abbazia") ||
    tags.includes("museo") ||
    tags.includes("rovine") ||
    tags.includes("archeologia")
  );
  if (cat === "relax") return type === "relax" || tags.includes("relax") || tags.includes("terme") || tags.includes("spa");
  if (cat === "family") return (
    type === "bambini" ||
    tags.includes("famiglie") ||
    tags.includes("bambini") ||
    tags.includes("family") ||
    tags.includes("animali") ||
    tags.includes("parco_avventura") ||
    tags.includes("luna_park") ||
    tags.includes("acquario") ||
    tags.includes("fattoria_didattica") ||
    tags.includes("playground")
  );

  return true;
}

function matchesStyle(place, { wantChicche, wantClassici }) {
  const vis = String(place.visibility || "").toLowerCase(); // "chicca" | "conosciuta"
  if (!wantChicche && !wantClassici) return true;
  if (vis === "chicca") return !!wantChicche;
  return !!wantClassici;
}

function baseScorePlace({ driveMin, targetMin, beautyScore, isChicca }) {
  const t = clamp(1 - Math.abs(driveMin - targetMin) / Math.max(25, targetMin * 0.85), 0, 1);
  const b = clamp(Number(beautyScore) || 0.75, 0.4, 1);
  const c = isChicca ? 0.06 : 0;
  return 0.62 * t + 0.34 * b + c;
}

// ROTATION penalty: avoid repeats in session + today
function rotationPenalty(pid, recentSet) {
  let pen = 0;
  if (pid && pid === LAST_SHOWN_PID) pen += 0.28;
  if (SESSION_SEEN.has(pid)) pen += 0.22;
  if (recentSet.has(pid)) pen += 0.14;
  return pen;
}

// -------------------- TIME “SMART” (widen when needed) --------------------
function widenedCaps(maxMinutes, category) {
  const m = clamp(Number(maxMinutes) || 120, 10, 600);

  // mare spesso non sta entro 60 reali
  if (category === "mare") {
    if (m <= 45) return [m, Math.round(m * 1.55), Math.round(m * 2.0)];
    if (m <= 75) return [m, Math.round(m * 1.35), Math.round(m * 1.75)];
    return [m, Math.round(m * 1.20)];
  }

  // storia 30' può essere dura in alcuni punti: allarga un filo
  if (category === "storia" && m <= 60) {
    return [m, Math.round(m * 1.35), Math.round(m * 1.75)];
  }

  // generale
  return [m, Math.round(m * 1.25), Math.round(m * 1.55)];
}

// -------------------- PICK DESTINATION (with rotation + quality) --------------------
function buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited = false, ignoreRotation = false } = {}) {
  const visited = getVisitedSet();
  const recentSet = getRecentSet();

  const target = Number(maxMinutes);
  const oLat = Number(origin.lat);
  const oLon = Number(origin.lon);

  const candidates = [];

  for (const p of MACRO.places) {
    const lat = Number(p.lat);
    const lon = Number(p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    // anti mete brutte
    if (hasBadName(p.name)) continue;

    // qualità minima
    const beauty = Number(p.beauty_score);
    const minB = minBeautyFor(category || "ovunque");
    if (Number.isFinite(beauty) && beauty < minB) continue;

    if (!matchesCategory(p, category)) continue;
    if (!matchesStyle(p, styles)) continue;

    const pid = safeIdFromPlace(p);
    if (!ignoreVisited && visited.has(pid)) continue;

    const km = haversineKm(oLat, oLon, lat, lon);
    const driveMin = estCarMinutesFromKm(km);

    if (driveMin > target) continue;
    if (km < 1.2) continue;

    const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
    let s = baseScorePlace({
      driveMin,
      targetMin: target,
      beautyScore: p.beauty_score,
      isChicca
    });

    if (!ignoreRotation) s -= rotationPenalty(pid, recentSet);

    candidates.push({
      place: p,
      pid,
      km,
      driveMin,
      score: Number(s.toFixed(4))
    });
  }

  candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
  return candidates;
}

function pickDestinationWithWiden(origin, maxMinutesInput, category, styles) {
  const caps = widenedCaps(maxMinutesInput, category);

  // tentativi progressivi
  for (let i = 0; i < caps.length; i++) {
    const cap = caps[i];

    let candidates = buildCandidates(origin, cap, category, styles, { ignoreVisited: false, ignoreRotation: false });
    if (candidates.length >= 1) return { capUsed: cap, chosen: candidates[0], alternatives: candidates.slice(1, 3) };

    candidates = buildCandidates(origin, cap, category, styles, { ignoreVisited: false, ignoreRotation: true });
    if (candidates.length >= 1) return { capUsed: cap, chosen: candidates[0], alternatives: candidates.slice(1, 3) };

    candidates = buildCandidates(origin, cap, category, styles, { ignoreVisited: true, ignoreRotation: true });
    if (candidates.length >= 1) return { capUsed: cap, chosen: candidates[0], alternatives: candidates.slice(1, 3) };
  }

  return { capUsed: caps[caps.length - 1], chosen: null, alternatives: [] };
}

// -------------------- RENDER --------------------
function monetBoxHtml(originLabel, placeName, country = "IT") {
  // bottoni più “immediati”: grandi + utili
  return `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Prenota / Scopri (link monetizzabili)</div>

      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn" target="_blank" rel="noopener" href="${bookingUrl(placeName, country, BOOKING_AID)}">🏨 Hotel</a>
        <a class="btn" target="_blank" rel="noopener" href="${getYourGuideUrl(placeName, GYG_PID)}">🎟️ Tour & Esperienze</a>
        <a class="btn" target="_blank" rel="noopener" href="${tiqetsUrl(placeName, TIQETS_PID)}">🏛️ Biglietti / Attrazioni</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${amazonEssentialsUrl(AMAZON_TAG)}">🧳 Essenziali</a>
      </div>

      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${flightsUrl(originLabel, placeName, SKYSCANNER_AID)}">✈️ Voli</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${trainsBusUrl(originLabel, placeName, OMIO_AID)}">🚆🚌 Treni/Bus</a>
      </div>

      <div class="small muted" style="margin-top:8px;">
        (Metti i tuoi ID in alto: BOOKING_AID / GYG_PID / TIQETS_PID / AMAZON_TAG / OMIO_AID / SKYSCANNER_AID)
      </div>
    </div>
  `;
}

function quickLinksHtml(p, origin) {
  const country = p.country || DEFAULT_COUNTRY;
  const placeUrl = mapsPlaceUrl(p.lat, p.lon);
  const dirUrl = mapsDirUrl(origin.lat, origin.lon, p.lat, p.lon);
  const todoUrl = mapsThingsToDoUrl(p.lat, p.lon, p.name);
  const foodUrl = mapsRestaurantsUrl(p.lat, p.lon, p.name);
  const photosUrl = googleImagesUrl(p.name, country);

  return `
    <div class="row wrap gap" style="margin-top:10px;">
      <a class="btn" href="${placeUrl}" target="_blank" rel="noopener">📍 Maps</a>
      <a class="btn btn-ghost" href="${dirUrl}" target="_blank" rel="noopener">🚗 Percorso</a>
      <a class="btn btn-ghost" href="${todoUrl}" target="_blank" rel="noopener">✨ Cosa fare</a>
      <a class="btn btn-ghost" href="${foodUrl}" target="_blank" rel="noopener">🍝 Ristoranti</a>
      <a class="btn btn-ghost" href="${photosUrl}" target="_blank" rel="noopener">📸 Foto</a>
    </div>
  `;
}

function renderResult(origin, maxMinutesInput, capUsed, chosen, alternatives, meta = {}) {
  const area = $("resultArea");
  const category = meta.category || "ovunque";
  const originLabel = (origin?.label || "").trim() || "partenza";

  if (!chosen) {
    area.innerHTML = `
      <div class="card errbox">
        <div class="small">❌ Nessuna meta trovata (anche allargando) entro ~${capUsed} min con i filtri attuali.</div>
        <div class="small muted" style="margin-top:6px;">
          Suggerimenti: aumenta i minuti, oppure prova “Ovunque” o attiva anche “Classici”.
        </div>
        <div class="row wrap gap" style="margin-top:12px;">
          <button class="btn btn-ghost" id="btnResetRotation">🧽 Reset proposte di oggi</button>
        </div>
      </div>
    `;
    $("btnResetRotation")?.addEventListener("click", () => {
      resetRotation();
      showStatus("ok", "Reset fatto ✅ Ora riparto da zero.");
      runSearch({ silent: true });
    });
    return;
  }

  const p = chosen.place;
  const pid = chosen.pid;

  const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
  const badge = isChicca ? "✨ chicca" : "✅ classica";
  const country = p.country || DEFAULT_COUNTRY;

  const why = Array.isArray(p.why) ? p.why.slice(0, 4) : [];
  const whyHtml = why.length
    ? `<ul style="margin:10px 0 0; padding-left:18px; color: var(--muted);">
         ${why.map(x => `<li>${x}</li>`).join("")}
       </ul>`
    : "";

  const widenNote = capUsed !== maxMinutesInput
    ? `<div class="small muted" style="margin-top:6px;">Ho allargato il raggio fino a ~${capUsed} min per non lasciarti a secco.</div>`
    : "";

  const altHtml = (alternatives || []).length ? `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Alternative (clicca per scegliere)</div>
      <div style="margin-top:10px; display:flex; flex-direction:column; gap:10px;">
        ${(alternatives || []).map(a => {
          const ap = a.place;
          const aPid = a.pid;
          const aIsChicca = String(ap.visibility || "").toLowerCase() === "chicca";
          const aBadge = aIsChicca ? "✨" : "✅";

          const aPhotos = googleImagesUrl(ap.name, ap.country || DEFAULT_COUNTRY);
          const aTodo = mapsThingsToDoUrl(ap.lat, ap.lon, ap.name);
          const aFood = mapsRestaurantsUrl(ap.lat, ap.lon, ap.name);
          const aMaps = mapsPlaceUrl(ap.lat, ap.lon);
          const aDir = mapsDirUrl(origin.lat, origin.lon, ap.lat, ap.lon);

          return `
            <div class="card" data-alt="1" data-pid="${aPid}"
                 style="padding:12px; cursor:pointer; border-color: rgba(255,255,255,.12);">
              <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
                <div>
                  <div style="font-weight:850; font-size:16px; line-height:1.2;">
                    ${ap.name} <span class="small muted">(${aBadge})</span>
                  </div>
                  <div class="small muted" style="margin-top:4px;">
                    ~${a.driveMin} min • ${fmtKm(a.km)} • ${ap.type || "meta"}
                  </div>
                </div>
                <div class="pill" style="white-space:nowrap;">Scegli</div>
              </div>

              <div class="row wrap gap" style="margin-top:10px;">
                <a class="btn btn-ghost" href="${aMaps}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Maps</a>
                <a class="btn btn-ghost" href="${aDir}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Percorso</a>
                <a class="btn btn-ghost" href="${aTodo}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Cosa fare</a>
                <a class="btn btn-ghost" href="${aFood}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Ristoranti</a>
                <a class="btn btn-ghost" href="${aPhotos}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Foto</a>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  ` : "";

  area.innerHTML = `
    <div class="card okbox">
      <div class="pill">🚗 auto • ~${chosen.driveMin} min • ${fmtKm(chosen.km)} • ${badge}</div>
      <div class="resultTitle">${p.name}, ${country}</div>

      <div class="small muted" style="margin-top:6px;">
        Categoria: <b>${p.type || "meta"}</b> • Punteggio: <b>${chosen.score}</b>
        ${category !== "ovunque" ? ` • filtro: <b>${category}</b>` : ""}
      </div>

      ${widenNote}

      ${quickLinksHtml(p, origin)}
      ${whyHtml}

      <div class="row wrap gap" style="margin-top:12px;">
        <button class="btn btn-ghost" id="btnVisited">✅ Già visitato</button>
        <button class="btn" id="btnChange">🔁 Cambia meta</button>
        <button class="btn btn-ghost" id="btnResetRotation">🧽 Reset proposte oggi</button>
      </div>
    </div>

    ${monetBoxHtml(originLabel, p.name, country)}
    ${altHtml}
  `;

  // track shown (rotation)
  LAST_SHOWN_PID = pid;
  SESSION_SEEN.add(pid);
  addRecent(pid);

  // buttons
  $("btnVisited")?.addEventListener("click", () => {
    markVisited(pid);
    showStatus("ok", "Segnato come visitato ✅ (non te lo ripropongo più).");
    runSearch({ silent: true }); // subito una nuova proposta
  });

  $("btnChange")?.addEventListener("click", () => {
    runSearch({ silent: true, forbidPid: pid });
  });

  $("btnResetRotation")?.addEventListener("click", () => {
    resetRotation();
    showStatus("ok", "Reset proposte oggi ✅ (riparto da zero).");
    runSearch({ silent: true });
  });

  // Alternative clickable -> diventa la main
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
        { place: chosen.place, pid: chosen.pid, km: chosen.km, driveMin: chosen.driveMin, score: chosen.score },
        ...remaining
      ].slice(0, 2);

      renderResult(origin, maxMinutesInput, capUsed, alt, newAlternatives, meta);
      showStatus("ok", "Ok ✅ Ho scelto l’alternativa.");
    });
  });
}

// -------------------- MAIN SEARCH --------------------
async function runSearch({ silent = false, forbidPid = null } = {}) {
  try {
    if (!silent) hideStatus();
    if (!MACRO) await loadMacro();

    const origin = getOrigin();
    if (!origin || !Number.isFinite(Number(origin.lat)) || !Number.isFinite(Number(origin.lon))) {
      showStatus("err", "Imposta una partenza: GPS oppure scrivi un luogo e premi “Usa questo luogo”.");
      return;
    }

    const maxMinutesInput = clamp(Number($("maxMinutes").value) || 120, 10, 600);
    const category = getActiveCategory();
    const styles = getActiveStyles();

    // pick with widen strategy
    let { capUsed, chosen, alternatives } = pickDestinationWithWiden(origin, maxMinutesInput, category, styles);

    // forbid immediate specific pid (cambia meta)
    if (forbidPid && chosen?.pid === forbidPid) {
      // “salta” quella
      SESSION_SEEN.add(forbidPid);
      ({ capUsed, chosen, alternatives } = pickDestinationWithWiden(origin, maxMinutesInput, category, styles));
    }

    renderResult(origin, maxMinutesInput, capUsed, chosen, alternatives, { category });

    if (!chosen) {
      showStatus("warn", `Nessuna meta trovata. Prova ad aumentare i minuti o cambiare filtri.`);
    } else if (!silent) {
      showStatus("ok", `Meta trovata ✅ (~${chosen.driveMin} min in auto)`);
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
      if (Number.isFinite(Number(o?.lat)) && Number.isFinite(Number(o?.lon))) {
        setOrigin(o);
      }
    } catch {}
  }
}

function bindOriginButtons() {
  $("btnUseGPS")?.addEventListener("click", () => {
    $("originStatus").textContent = "📍 Sto leggendo il GPS…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        setOrigin({ label: "La mia posizione", lat, lon });
        showStatus("ok", "Partenza GPS impostata ✅");
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
    runSearch({ silent: true });
  });
}

// init
initChips("timeChips", { multi: false });
initChips("categoryChips", { multi: false });
initChips("styleChips", { multi: true });

initTimeChipsSync();
restoreOrigin();
bindOriginButtons();
bindMainButtons();

// preload macro
loadMacro().catch(() => {});
hideStatus();
