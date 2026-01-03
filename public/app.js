/* Jamo — Auto-only — app.js v4.2 (EU+UK ALL + FAMILY BOOST)
 * FIXES:
 * - Family category is now VERY inclusive (parks/lakes/easy nature/borghi + kids POIs)
 * - Adds "Family vicino casa" list (8–12 nearby ideas) when category=family
 * - Family scoring boost prioritizes easy/near/family-signals
 */

const $ = (id) => document.getElementById(id);

// -------------------- SETTINGS --------------------
const MACRO_URL = "/data/macros/euuk_macro_all.json";

// driving estimator (offline)
const ROAD_FACTOR = 1.25;
const AVG_KMH = 72;
const FIXED_OVERHEAD_MIN = 8;

// ROTATION
const RECENT_TTL_MS = 1000 * 60 * 60 * 20;
const RECENT_MAX = 160;
let SESSION_SEEN = new Set();
let LAST_SHOWN_PID = null;

// Monetization IDs
const BOOKING_AID = "";
const AMAZON_TAG  = "";
const GYG_PID     = "";
const TIQETS_PID  = "";

// Optional WhatsApp lead
const WHATSAPP_NUMBER = "";

// Family "vicino casa" defaults
const FAMILY_NEARBY_MAX_MIN = 60; // idee immediate entro 60 min
const FAMILY_NEARBY_LIMIT = 12;

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

// -------------------- QUICK “INFO” LINKS --------------------
function googleThingsToDoUrl(placeName, countryCode = "") {
  const q = `${placeName}${countryCode ? " " + countryCode : ""} cosa vedere things to do`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}&tbm=pts`;
}
function googleWhatToDoUrl(placeName, countryCode = "") {
  const q = `${placeName}${countryCode ? " " + countryCode : ""} cosa fare activities`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}
function googleImagesUrl(placeName, countryCode = "") {
  const q = `${placeName}${countryCode ? " " + countryCode : ""}`;
  return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`;
}
function googleRestaurantsUrl(placeName, countryCode = "") {
  const q = `${placeName}${countryCode ? " " + countryCode : ""} ristoranti restaurants`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}
function wikipediaUrl(placeName, countryCode = "") {
  const q = `${placeName}${countryCode ? " " + countryCode : ""}`;
  return `https://it.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`;
}

// -------------------- Monetization URLs --------------------
function bookingUrl(placeName, countryCode = "", affId = "") {
  const q = `${placeName}${countryCode ? ", " + countryCode : ""}`;
  const base = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(q)}`;
  return affId ? `${base}&aid=${encodeURIComponent(affId)}` : base;
}
function getYourGuideUrl(placeName, countryCode = "", affId = "") {
  const q = `${placeName}${countryCode ? " " + countryCode : ""}`;
  const base = `https://www.getyourguide.com/s/?q=${encodeURIComponent(q)}`;
  return affId ? `${base}&partner_id=${encodeURIComponent(affId)}` : base;
}
function tiqetsUrl(placeName, countryCode = "", affId = "") {
  const q = `${placeName}${countryCode ? " " + countryCode : ""}`;
  const base = `https://www.tiqets.com/it/search/?query=${encodeURIComponent(q)}`;
  return affId ? `${base}&partner=${encodeURIComponent(affId)}` : base;
}
function amazonEssentialsUrl(tag = "") {
  const base = `https://www.amazon.it/s?k=${encodeURIComponent("accessori viaggio bambini")}`;
  return tag ? `${base}&tag=${encodeURIComponent(tag)}` : base;
}
function whatsappLeadUrl(placeName) {
  if (!WHATSAPP_NUMBER) return "";
  const msg = `Ciao! Mi consigli un'idea FAMILY vicino a ${placeName}? (itinerario facile con bambini)`;
  return `https://wa.me/${WHATSAPP_NUMBER.replace(/\D/g, "")}?text=${encodeURIComponent(msg)}`;
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
function saveVisitedSet(set) { localStorage.setItem("jamo_visited", JSON.stringify([...set])); }
function markVisited(placeId) { const s = getVisitedSet(); s.add(placeId); saveVisitedSet(s); }
function resetVisited() { localStorage.removeItem("jamo_visited"); }

function loadRecent() {
  const raw = localStorage.getItem("jamo_recent");
  if (!raw) return [];
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; } catch { return []; }
}
function saveRecent(list) { localStorage.setItem("jamo_recent", JSON.stringify(list.slice(0, RECENT_MAX))); }
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

// -------------------- UI (chips) --------------------
function initChips(containerId, { multi = false } = {}) {
  const el = $(containerId);
  if (!el) return;

  el.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;

    if (!multi) {
      [...el.querySelectorAll(".chip")].forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
    } else chip.classList.toggle("active");

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
  return { wantChicche: actives.includes("chicche"), wantClassici: actives.includes("classici") };
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
function hideStatus() { $("statusBox").style.display = "none"; $("statusText").textContent = ""; }

// -------------------- DATA --------------------
let MACRO = null;
async function loadMacro() {
  const r = await fetch(MACRO_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`Macro non trovato (${r.status}) → ${MACRO_URL}`);
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
  return j.result;
}

// -------------------- FAMILY SIGNALS --------------------
function familySignals(place) {
  const tags = (place.tags || []).map(t => String(t).toLowerCase());
  const n = normName(place.name || "");
  const type = String(place.type || "").toLowerCase();

  // strong kids-specific
  const strong = [
    "zoo","aquarium","acquario","theme park","themepark","parco divertimenti","luna park",
    "playground","area giochi","kids","children","bambini","family","fattoria didattica","farm",
    "parco avventura","adventure park"
  ];
  if (strong.some(x => n.includes(x)) || tags.some(t => strong.includes(t))) return 3;

  // medium: parks/lakes/beaches/easy nature (great with family)
  const mediumTags = ["park","parco","lago","lake","beach","spiaggia","mare","natura","riserva","reserve","viewpoint","panorama"];
  const mediumName = ["parco","park","lago","lake","spiaggia","beach","riserva","reserve","belvedere","viewpoint","cascata","waterfall"];
  if (
    mediumTags.some(x => tags.includes(x)) ||
    mediumName.some(x => n.includes(x)) ||
    ["natura","mare","relax","borgo","citta","city"].includes(type)
  ) return 2;

  // light: museums/castles can still be family-friendly
  const light = ["museo","museum","castello","castle","abbazia","abbey","centro storico","old town"];
  if (light.some(x => n.includes(x)) || tags.some(t => light.includes(t))) return 1;

  return 0;
}

function familyWhyQuick(place) {
  const n = normName(place.name || "");
  const tags = (place.tags || []).map(t => String(t).toLowerCase());

  // short ideas (no AI needed, deterministic)
  const ideas = [];

  if (n.includes("parco") || tags.includes("parco") || tags.includes("park")) ideas.push("Passeggiata + area verde (easy).");
  if (n.includes("lago") || tags.includes("lago") || tags.includes("lake")) ideas.push("Giro lago + foto + merenda.");
  if (n.includes("spiaggia") || tags.includes("beach") || tags.includes("mare")) ideas.push("Spiaggia facile (se stagione) + passeggio.");
  if (n.includes("cascata") || tags.includes("waterfall")) ideas.push("Mini-trekking semplice (scarpe comode).");
  if (n.includes("zoo") || tags.includes("zoo")) ideas.push("Animali + attività per bambini.");
  if (n.includes("acquario") || tags.includes("aquarium")) ideas.push("Visita indoor perfetta anche se piove.");
  if (n.includes("castello") || tags.includes("castle")) ideas.push("Castello = visita breve + wow per i bimbi.");

  if (ideas.length === 0) ideas.push("Gita easy + passeggio + gelato.");

  return ideas.slice(0, 3);
}

// -------------------- FILTERS --------------------
function matchesCategory(place, cat) {
  if (!cat || cat === "ovunque") return true;

  const type = String(place.type || "").toLowerCase();
  const tags = (place.tags || []).map(t => String(t).toLowerCase());
  const n = normName(place.name || "");

  const hasAnyTag = (...xs) => xs.some(x => tags.includes(x));
  const nameHasAny = (...xs) => xs.some(x => n.includes(x));

  if (cat === "citta") {
    return type === "citta" || type === "city" || hasAnyTag("citta","city") || nameHasAny("city","citta");
  }

  if (cat === "borghi") {
    return (
      type === "borgo" ||
      hasAnyTag("borgo","oldtown","old_town","historic","heritage") ||
      nameHasAny("borgo","centro storico","old town","historic centre","historic center","castel","castello","rocca")
    );
  }

  if (cat === "mare") {
    return (
      type === "mare" ||
      hasAnyTag("mare","sea","beach","spiagge","spiaggia","coast","costa","lido","trabocchi") ||
      nameHasAny("spiaggia","beach","lido","marina","costa","coast","faro","harbour","porto")
    );
  }

  if (cat === "montagna") {
    return (
      type === "montagna" ||
      hasAnyTag("montagna","mountain","neve","snow","ski") ||
      nameHasAny("monte","mount","mountain","peak","vetta","rifugio","ski")
    );
  }

  if (cat === "natura") {
    return (
      type === "natura" ||
      hasAnyTag("natura","nature","lago","lake","parco","park","national_park","parco_nazionale","riserva","reserve","canyon","gole","cascata","waterfall","sentiero","trail","trekking") ||
      nameHasAny("parco","park","riserva","reserve","gole","canyon","cascata","waterfall","lago","lake","sentiero","trail")
    );
  }

  if (cat === "storia") {
    return (
      type === "storia" ||
      hasAnyTag("storia","history","museo","museum","castello","castle","abbazia","abbey","cathedral","duomo","church","archaeology","heritage") ||
      nameHasAny("castello","castle","rocca","forte","fortress","abbazia","abbey","duomo","cattedrale","cathedral","basilica","church","chiesa","museo","museum","archeo","anfiteatro","amphitheatre","teatro romano","roman theatre")
    );
  }

  if (cat === "relax") {
    return (
      type === "relax" ||
      hasAnyTag("relax","spa","terme","thermal","wellness") ||
      nameHasAny("terme","spa","thermal","wellness")
    );
  }

  if (cat === "family") {
    // ✅ SUPER-INCLUSIVE:
    // - anything with familySignals >= 2
    // - plus parks/lakes/beaches/borghi (great for kids) unless obviously "nightlife"
    const sig = familySignals(place);
    if (sig >= 2) return true;

    const anti = ["nightclub","club","discoteca","casino"];
    if (anti.some(x => n.includes(x))) return false;

    // fallback: places that are generally family friendly (easy categories)
    if (["natura","mare","borgo","citta","city","relax"].includes(type)) return true;
    if (hasAnyTag("parco","park","lago","lake","beach","spiaggia","mare","natura")) return true;
    if (nameHasAny("parco","park","lago","lake","spiaggia","beach","belvedere","viewpoint")) return true;

    return false;
  }

  return true;
}

function matchesStyle(place, { wantChicche, wantClassici }) {
  const vis = String(place.visibility || "").toLowerCase();
  if (!wantChicche && !wantClassici) return true;
  if (vis === "chicca") return !!wantChicche;
  return !!wantClassici;
}

function rotationPenalty(pid, recentSet) {
  let pen = 0;
  if (pid && pid === LAST_SHOWN_PID) pen += 0.28;
  if (SESSION_SEEN.has(pid)) pen += 0.22;
  if (recentSet.has(pid)) pen += 0.14;
  return pen;
}

function baseScorePlace({ driveMin, targetMin, beautyScore, isChicca, familyMode, familySig }) {
  const t = clamp(1 - Math.abs(driveMin - targetMin) / Math.max(25, targetMin * 0.85), 0, 1);
  const b = clamp(Number(beautyScore) || 0.78, 0.4, 1);
  const c = isChicca ? 0.06 : 0;

  let s = 0.60 * t + 0.36 * b + c;

  // ✅ family boost (prefer easy + strong signals)
  if (familyMode) {
    // stronger signals matter
    s += 0.06 * clamp(familySig / 3, 0, 1);
    // prefer closer (kids)
    if (driveMin <= 35) s += 0.04;
    else if (driveMin <= 55) s += 0.02;
  }

  return s;
}

// -------------------- TIME “SMART” --------------------
function effectiveMaxMinutes(maxMinutes, category) {
  const m = Number(maxMinutes);
  if (!Number.isFinite(m)) return 120;
  if (category === "mare" && m < 75) return clamp(Math.round(m * 1.35), m, 180);
  return clamp(m, 10, 600);
}

// -------------------- PICK DESTINATION --------------------
function buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited = false, ignoreRotation = false } = {}) {
  const visited = getVisitedSet();
  const recentSet = getRecentSet();

  const target = Number(maxMinutes);
  const oLat = Number(origin.lat);
  const oLon = Number(origin.lon);

  const familyMode = category === "family";

  const candidates = [];

  for (const p of MACRO.places) {
    const lat = Number(p.lat);
    const lon = Number(p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    if (!matchesCategory(p, category)) continue;
    if (!matchesStyle(p, styles)) continue;

    const pid = safeIdFromPlace(p);
    if (!ignoreVisited && visited.has(pid)) continue;

    const km = haversineKm(oLat, oLon, lat, lon);
    const driveMin = estCarMinutesFromKm(km);

    if (driveMin > target) continue;
    if (km < 1.2) continue;

    const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
    const familySig = familySignals(p);

    let s = baseScorePlace({
      driveMin,
      targetMin: target,
      beautyScore: p.beauty_score,
      isChicca,
      familyMode,
      familySig
    });

    // small boosts
    const tags = (p.tags || []).map(x => String(x).toLowerCase());
    const n = normName(p.name || "");
    if (tags.includes("panorama") || n.includes("belvedere") || n.includes("viewpoint")) s += 0.03;
    if (tags.includes("spiagge") || tags.includes("castle") || tags.includes("castello") || tags.includes("abbazia")) s += 0.04;

    if (!ignoreRotation) s -= rotationPenalty(pid, recentSet);

    candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)), familySig });
  }

  candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
  return candidates;
}

function pickDestination(origin, maxMinutes, category, styles) {
  let candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: false, ignoreRotation: false });
  if (candidates.length === 0) candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: false, ignoreRotation: true });
  if (candidates.length === 0) candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: true, ignoreRotation: true });

  const chosen = candidates[0] || null;
  const alternatives = candidates.slice(1, 3);
  return { chosen, alternatives, candidates };
}

// -------------------- RENDER HELPERS --------------------
function quickInfoButtonsHtml(placeName, countryCode = "IT") {
  return `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Info subito</div>
      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn" target="_blank" rel="noopener" href="${googleThingsToDoUrl(placeName, countryCode)}">👀 Cosa vedere</a>
        <a class="btn" target="_blank" rel="noopener" href="${googleWhatToDoUrl(placeName, countryCode)}">🎯 Cosa fare</a>
        <a class="btn" target="_blank" rel="noopener" href="${googleImagesUrl(placeName, countryCode)}">📷 Foto</a>
        <a class="btn" target="_blank" rel="noopener" href="${googleRestaurantsUrl(placeName, countryCode)}">🍝 Ristoranti</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${wikipediaUrl(placeName, countryCode)}">📚 Wiki</a>
      </div>
    </div>
  `;
}

function monetBoxHtml(placeName, countryCode = "IT") {
  const wa = whatsappLeadUrl(placeName);
  return `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Prenota / Scopri (monetizzabile)</div>
      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn" target="_blank" rel="noopener" href="${bookingUrl(placeName, countryCode, BOOKING_AID)}">🏨 Hotel</a>
        <a class="btn" target="_blank" rel="noopener" href="${getYourGuideUrl(placeName, countryCode, GYG_PID)}">🎟️ Tour</a>
        <a class="btn" target="_blank" rel="noopener" href="${tiqetsUrl(placeName, countryCode, TIQETS_PID)}">🏛️ Biglietti</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${amazonEssentialsUrl(AMAZON_TAG)}">🧳 Essenziali</a>
        ${wa ? `<a class="btn btn-ghost" target="_blank" rel="noopener" href="${wa}">💬 WhatsApp</a>` : ""}
      </div>
      <div class="small muted" style="margin-top:8px;">
        Inserisci i tuoi ID affiliato in app.js (BOOKING_AID / GYG_PID / TIQETS_PID / AMAZON_TAG)
      </div>
    </div>
  `;
}

function familyNearbyHtml(list, origin) {
  if (!list || list.length === 0) return "";

  return `
    <div class="card" style="margin-top:12px;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
        <div class="small muted">👨‍👩‍👧‍👦 Family vicino casa (idee immediate)</div>
        <div class="pill">entro ~${FAMILY_NEARBY_MAX_MIN} min</div>
      </div>

      <div class="small muted" style="margin-top:8px;">
        Toccane una per vedere foto / cosa fare / percorso.
      </div>

      <div style="margin-top:10px; display:flex; flex-direction:column; gap:10px;">
        ${list.map(x => {
          const p = x.place;
          const country = p.country || "IT";
          const placeUrl = mapsPlaceUrl(p.lat, p.lon);
          const dirUrl = mapsDirUrl(origin.lat, origin.lon, p.lat, p.lon);
          const ideas = familyWhyQuick(p).join(" • ");

          return `
            <div class="card" style="padding:12px; border-color: rgba(255,255,255,.12);">
              <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
                <div>
                  <div style="font-weight:800; font-size:15px; line-height:1.2;">
                    ${p.name} <span class="small muted">(${p.type || "meta"})</span>
                  </div>
                  <div class="small muted" style="margin-top:4px;">
                    ~${x.driveMin} min • ${fmtKm(x.km)} • ${ideas}
                  </div>
                </div>
                <div class="pill">Family</div>
              </div>

              <div class="row wrap gap" style="margin-top:10px;">
                <a class="btn" href="${googleImagesUrl(p.name, country)}" target="_blank" rel="noopener">📷 Foto</a>
                <a class="btn" href="${googleWhatToDoUrl(p.name, country)}" target="_blank" rel="noopener">🎯 Cosa fare</a>
                <a class="btn btn-ghost" href="${placeUrl}" target="_blank" rel="noopener">Maps</a>
                <a class="btn btn-ghost" href="${dirUrl}" target="_blank" rel="noopener">Percorso</a>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

// -------------------- RENDER MAIN RESULT --------------------
function renderNoResult(maxMinutesShown, category) {
  const area = $("resultArea");
  const extra = (category === "family")
    ? `Consiglio: prova 45–90 min. Family “vicino casa” ti dovrebbe mostrare comunque idee immediate.`
    : `Prova ad aumentare i minuti o cambiare categoria/stile.`;

  area.innerHTML = `
    <div class="card errbox">
      <div class="small">❌ Nessuna meta trovata entro ${maxMinutesShown} min con i filtri attuali.</div>
      <div class="small muted" style="margin-top:6px;">${extra}</div>
      <div class="row wrap gap" style="margin-top:12px;">
        <button class="btn" id="btnResetRotation">🧽 Reset “proposte di oggi”</button>
      </div>
    </div>
  `;

  $("btnResetRotation")?.addEventListener("click", () => {
    resetRotation();
    showStatus("ok", "Reset fatto ✅ Ora rilancio la ricerca…");
    runSearch({ silent: true });
  });
}

function renderResult(origin, maxMinutesShown, chosen, alternatives, meta = {}) {
  const area = $("resultArea");
  const category = meta.category || "ovunque";
  const familyNearbyBlock = meta.familyNearbyHtml || "";

  if (!chosen) {
    area.innerHTML = familyNearbyBlock + `<div style="margin-top:12px;"></div>`;
    renderNoResult(maxMinutesShown, category);
    return;
  }

  const p = chosen.place;
  const pid = chosen.pid;
  const country = p.country || "IT";

  const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
  const badge = isChicca ? "✨ chicca" : "✅ classica";

  const placeUrl = mapsPlaceUrl(p.lat, p.lon);
  const dirUrl = mapsDirUrl(origin.lat, origin.lon, p.lat, p.lon);

  const why = Array.isArray(p.why) ? p.why.slice(0, 4) : [];
  const whyHtml = why.length
    ? `<ul style="margin:10px 0 0; padding-left:18px; color: var(--muted);">${why.map(x => `<li>${x}</li>`).join("")}</ul>`
    : "";

  const familyIdeas = (category === "family")
    ? `<div class="small muted" style="margin-top:8px;">👨‍👩‍👧‍👦 Idee family: <b>${familyWhyQuick(p).join(" • ")}</b></div>`
    : "";

  const altHtml = (alternatives || []).length ? `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Alternative (tocca per scegliere)</div>
      <div style="margin-top:10px; display:flex; flex-direction:column; gap:10px;">
        ${(alternatives || []).map(a => {
          const ap = a.place;
          const aPid = a.pid;
          const aCountry = ap.country || "IT";
          const aPlaceUrl = mapsPlaceUrl(ap.lat, ap.lon);
          const aDirUrl = mapsDirUrl(origin.lat, origin.lon, ap.lat, ap.lon);
          const aIsChicca = String(ap.visibility || "").toLowerCase() === "chicca";
          const aBadge = aIsChicca ? "✨" : "✅";
          const ideas = (category === "family") ? ` • ${familyWhyQuick(ap).join(" • ")}` : "";

          return `
            <div class="card" data-alt="1" data-pid="${aPid}" style="padding:12px; cursor:pointer; border-color: rgba(255,255,255,.12);">
              <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
                <div>
                  <div style="font-weight:800; font-size:16px; line-height:1.2;">
                    ${ap.name} <span class="small muted">(${aBadge})</span>
                  </div>
                  <div class="small muted" style="margin-top:4px;">
                    ~${a.driveMin} min • ${fmtKm(a.km)} • ${ap.type || "meta"}${ideas}
                  </div>
                </div>
                <div class="pill" style="white-space:nowrap;">Scegli</div>
              </div>

              <div class="row wrap gap" style="margin-top:10px;">
                <a class="btn btn-ghost" href="${aPlaceUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Maps</a>
                <a class="btn btn-ghost" href="${aDirUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Percorso</a>
                <a class="btn btn-ghost" href="${googleImagesUrl(ap.name, aCountry)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Foto</a>
                <a class="btn btn-ghost" href="${googleWhatToDoUrl(ap.name, aCountry)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Cosa fare</a>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  ` : "";

  area.innerHTML = `
    ${familyNearbyBlock}

    <div class="card okbox" style="margin-top:12px;">
      <div class="pill">🚗 auto • ~${chosen.driveMin} min • ${fmtKm(chosen.km)} • ${badge}</div>
      <div class="resultTitle">${p.name}, ${country}</div>

      <div class="small muted" style="margin-top:6px;">
        Categoria: <b>${p.type || "meta"}</b> • Punteggio: <b>${chosen.score}</b>
      </div>

      <div class="row wrap gap" style="margin-top:12px;">
        <a class="btn" href="${placeUrl}" target="_blank" rel="noopener">🗺️ Maps</a>
        <a class="btn" href="${dirUrl}" target="_blank" rel="noopener">🚗 Percorso</a>
        <a class="btn" href="${googleImagesUrl(p.name, country)}" target="_blank" rel="noopener">📷 Foto</a>
        <a class="btn" href="${googleWhatToDoUrl(p.name, country)}" target="_blank" rel="noopener">🎯 Cosa fare</a>
      </div>

      ${familyIdeas}
      ${whyHtml}

      <div class="row wrap gap" style="margin-top:12px;">
        <button class="btn btn-ghost" id="btnVisited">✅ Già visitato</button>
        <button class="btn" id="btnChange">🔁 Cambia meta</button>
        <button class="btn btn-ghost" id="btnResetRotation">🧽 Reset “proposte di oggi”</button>
      </div>
    </div>

    ${quickInfoButtonsHtml(p.name, country)}
    ${monetBoxHtml(p.name, country)}
    ${altHtml}
  `;

  // rotation
  LAST_SHOWN_PID = pid;
  SESSION_SEEN.add(pid);
  addRecent(pid);

  $("btnVisited")?.addEventListener("click", () => {
    markVisited(pid);
    showStatus("ok", "Segnato come visitato ✅ (non te lo ripropongo più).");
  });

  $("btnChange")?.addEventListener("click", () => runSearch({ silent: true, forbidPid: pid }));

  $("btnResetRotation")?.addEventListener("click", () => {
    resetRotation();
    showStatus("ok", "Reset fatto ✅ Ora rilancio la ricerca…");
    runSearch({ silent: true });
  });

  // alternative click
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

      renderResult(origin, maxMinutesShown, alt, newAlternatives, meta);
      showStatus("ok", "Ok ✅ Ho scelto l’alternativa.");
    });
  });
}

// -------------------- FAMILY NEARBY LIST --------------------
function buildFamilyNearby(origin) {
  if (!MACRO || !origin) return [];
  const oLat = Number(origin.lat);
  const oLon = Number(origin.lon);
  if (!Number.isFinite(oLat) || !Number.isFinite(oLon)) return [];

  const visited = getVisitedSet();

  const out = [];
  for (const p of MACRO.places) {
    const lat = Number(p.lat), lon = Number(p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    // must be family-ish
    const sig = familySignals(p);
    const type = String(p.type || "").toLowerCase();
    if (sig === 0 && !["natura","mare","borgo","citta","city","relax"].includes(type)) continue;

    const pid = safeIdFromPlace(p);
    if (visited.has(pid)) continue;

    const km = haversineKm(oLat, oLon, lat, lon);
    const driveMin = estCarMinutesFromKm(km);
    if (driveMin > FAMILY_NEARBY_MAX_MIN) continue;
    if (km < 1.2) continue;

    // score: prefer closer + stronger family signal
    let s = 0;
    s += clamp(1 - (driveMin / FAMILY_NEARBY_MAX_MIN), 0, 1) * 0.6;
    s += clamp(sig / 3, 0, 1) * 0.3;
    s += clamp((Number(p.beauty_score) || 0.75), 0.4, 1) * 0.1;

    out.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
  }

  out.sort((a,b)=> (b.score-a.score) || (a.driveMin-b.driveMin));
  return out.slice(0, FAMILY_NEARBY_LIMIT);
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
    const effMax = effectiveMaxMinutes(maxMinutesInput, category);

    // family nearby block
    const familyNearby = (category === "family") ? buildFamilyNearby(origin) : [];
    const familyNearbyBlock = (category === "family") ? familyNearbyHtml(familyNearby, origin) : "";

    let { chosen, alternatives } = pickDestination(origin, effMax, category, styles);

    if (forbidPid && chosen?.pid === forbidPid) {
      SESSION_SEEN.add(forbidPid);
      ({ chosen, alternatives } = pickDestination(origin, effMax, category, styles));
    }

    renderResult(origin, maxMinutesInput, chosen, alternatives, { category, effMax, familyNearbyHtml: familyNearbyBlock });

    if (!chosen) {
      showStatus("warn", `Nessuna meta entro ${maxMinutesInput} min. Prova ad aumentare i minuti o cambiare filtri.`);
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
      if (Number.isFinite(Number(o?.lat)) && Number.isFinite(Number(o?.lon))) setOrigin(o);
    } catch {}
  }
}

function bindOriginButtons() {
  $("btnUseGPS")?.addEventListener("click", () => {
    $("originStatus").textContent = "📍 Sto leggendo il GPS…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setOrigin({ label: "La mia posizione", lat: pos.coords.latitude, lon: pos.coords.longitude });
        showStatus("ok", "Partenza GPS impostata ✅");
      },
      () => {
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

loadMacro().catch(() => {});
hideStatus();
