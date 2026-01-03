/* Jamo — Auto-only — app.js v4.0 (EU+UK ALL)
 * FIXES:
 * - Uses ONLY euuk_macro_all.json (no regional 404)
 * - Reset “proposte di oggi” works + can re-run search
 * - Better destination quality (filters junk/industrial/zone names)
 * - Strong “info buttons”: Cosa vedere, Cosa fare, Foto, Ristoranti, Wiki
 * - Monetization links: Booking, GYG, Tiqets (robust), Amazon, Flights/Trains/Bus
 */

const $ = (id) => document.getElementById(id);

// -------------------- SETTINGS --------------------
const MACRO_URL = "/data/macros/euuk_macro_all.json"; // ✅ ONE macro for all EU+UK (+ IT)

// driving estimator (offline)
const ROAD_FACTOR = 1.25;
const AVG_KMH = 72;
const FIXED_OVERHEAD_MIN = 8;

// ROTATION
const RECENT_TTL_MS = 1000 * 60 * 60 * 20; // ~20h: “oggi”
const RECENT_MAX = 140;
let SESSION_SEEN = new Set();
let LAST_SHOWN_PID = null;

// Monetization IDs (fill with your real IDs)
const BOOKING_AID = ""; // Booking affiliate id (aid)
const AMAZON_TAG  = ""; // Amazon tag (es: tuonome-21)
const GYG_PID     = ""; // GetYourGuide partner_id
const TIQETS_PID  = ""; // Tiqets partner

// Optional: WhatsApp lead (simple local monetization)
// Example: const WHATSAPP_NUMBER = "39333XXXXXXX"; // +39...
const WHATSAPP_NUMBER = "";

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

// -------------------- “INFO” LINKS (instant value) --------------------
function googleThingsToDoUrl(placeName, countryCode = "") {
  // Google “things to do” style query
  const q = `${placeName}${countryCode ? " " + countryCode : ""} cosa vedere`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}&tbm=pts`; // pts = places/things to do UI (works in many locales)
}

function googleWhatToDoUrl(placeName, countryCode = "") {
  const q = `${placeName}${countryCode ? " " + countryCode : ""} cosa fare attività`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

function googleImagesUrl(placeName, countryCode = "") {
  const q = `${placeName}${countryCode ? " " + countryCode : ""}`;
  return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`;
}

function googleRestaurantsUrl(placeName, countryCode = "") {
  const q = `${placeName}${countryCode ? " " + countryCode : ""} ristoranti`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function wikipediaUrl(placeName, countryCode = "") {
  // try IT Wikipedia; if not found user can switch language
  const title = String(placeName || "").trim().replace(/\s+/g, "_");
  // fallback search if title not exact
  const q = `${placeName}${countryCode ? " " + countryCode : ""}`;
  return `https://it.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`;
}

// -------------------- Monetization URLs (robust) --------------------
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
  // Tiqets è “capriccioso” sugli slug → usiamo search robusto, non pagina diretta
  const q = `${placeName}${countryCode ? " " + countryCode : ""}`;
  const base = `https://www.tiqets.com/it/search/?query=${encodeURIComponent(q)}`;
  return affId ? `${base}&partner=${encodeURIComponent(affId)}` : base;
}

function amazonEssentialsUrl(tag = "") {
  const base = `https://www.amazon.it/s?k=${encodeURIComponent("accessori viaggio")}`;
  return tag ? `${base}&tag=${encodeURIComponent(tag)}` : base;
}

// Flights / Trains / Bus (no routes, just search pages)
function flightsUrl(placeName, countryCode = "") {
  const q = `${placeName}${countryCode ? " " + countryCode : ""}`;
  // Google Flights query (simple)
  return `https://www.google.com/travel/flights?q=${encodeURIComponent("voli per " + q)}`;
}

function trainsUrl(placeName, countryCode = "") {
  const q = `${placeName}${countryCode ? " " + countryCode : ""}`;
  return `https://www.thetrainline.com/it/search?searchTerm=${encodeURIComponent(q)}`;
}

function busUrl(placeName, countryCode = "") {
  const q = `${placeName}${countryCode ? " " + countryCode : ""}`;
  return `https://www.omio.com/search-frontend/results/${encodeURIComponent(q)}`;
}

// WhatsApp lead (local guides / custom itineraries)
function whatsappLeadUrl(placeName) {
  if (!WHATSAPP_NUMBER) return "";
  const msg = `Ciao! Vorrei info/itinerario per: ${placeName}.`;
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
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
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
  // de-dup keeping newest
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
  return j.result; // {label, lat, lon}
}

// -------------------- QUALITY FILTERS (anti “mete brutte”) --------------------
function isJunkPlaceName(name) {
  const n = normName(name);
  if (!n) return true;

  // super “no”
  const badTokens = [
    "nucleo industriale", "zona industriale", "area industriale", "interporto",
    "zona artigianale", "area artigianale", "polo industriale",
    "centro commerciale", "outlet", "iper", "shopping center",
    "svincolo", "uscita", "casello", "stazione di servizio", "autogrill",
    "deposito", "capannone", "magazzino", "cimitero", "discarica",
    "zona", "area", "frazione", "contrada"
  ];

  // se contiene questi pattern + non contiene nulla di “turistico”, scarta
  const containsBad = badTokens.some(t => n.includes(t));
  if (!containsBad) return false;

  const goodHints = [
    "castello","abbazia","eremo","museo","cattedrale","santuario","duomo",
    "spiaggia","lido","costa","parco","riserva","gole","cascata","lago",
    "borgo","centro storico","belvedere","monte","vetta","rifugio",
    "terme","sentiero","trek","treno storico","faro","porto","isola"
  ];

  const containsGood = goodHints.some(t => n.includes(t));
  return !containsGood;
}

function hasTouristicSignals(place) {
  const type = String(place.type || "").toLowerCase();
  const tags = (place.tags || []).map(t => String(t).toLowerCase());
  const name = String(place.name || "");

  if (["mare","montagna","natura","storia","relax","bambini","borgo","citta"].includes(type)) return true;
  if (tags.includes("spiagge") || tags.includes("trabocchi") || tags.includes("museo") || tags.includes("castello") ||
      tags.includes("abbazia") || tags.includes("lago") || tags.includes("gole") || tags.includes("cascata") ||
      tags.includes("parco") || tags.includes("trekking") || tags.includes("panorama") || tags.includes("fotografico"))
    return true;

  // name hints
  const n = normName(name);
  if (n.includes("castello") || n.includes("abbazia") || n.includes("eremo") || n.includes("spiaggia") ||
      n.includes("riserva") || n.includes("parco") || n.includes("gole") || n.includes("cascata") ||
      n.includes("lago") || n.includes("belvedere"))
    return true;

  return false;
}

// -------------------- FILTERS --------------------
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
    tags.includes("riserva")
  );
  if (cat === "storia") return (
    type === "storia" ||
    tags.includes("storia") ||
    tags.includes("castello") ||
    tags.includes("abbazia") ||
    tags.includes("museo")
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
    tags.includes("acquario")
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
  const b = clamp(Number(beautyScore) || 0.78, 0.4, 1);
  const c = isChicca ? 0.06 : 0;
  return 0.60 * t + 0.36 * b + c;
}

function rotationPenalty(pid, recentSet) {
  let pen = 0;
  if (pid && pid === LAST_SHOWN_PID) pen += 0.28;
  if (SESSION_SEEN.has(pid)) pen += 0.22;
  if (recentSet.has(pid)) pen += 0.14;
  return pen;
}

// -------------------- TIME “SMART” --------------------
function effectiveMaxMinutes(maxMinutes, category) {
  const m = Number(maxMinutes);
  if (!Number.isFinite(m)) return 120;

  if (category === "mare" && m < 75) {
    const widened = Math.round(m * 1.35);
    return clamp(widened, m, 180);
  }
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
    const lon = Number(p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    // ✅ quality: avoid junk + keep tourism signals
    if (isJunkPlaceName(p.name)) continue;
    if (!hasTouristicSignals(p)) continue;

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

    // Extra boost for clearly “wow” tags (keeps results beautiful)
    const tags = (p.tags || []).map(x => String(x).toLowerCase());
    if (tags.includes("panorama") || tags.includes("fotografico")) s += 0.03;
    if (tags.includes("spiagge") || tags.includes("castello") || tags.includes("abbazia") || tags.includes("gole") || tags.includes("cascata")) s += 0.04;

    if (!ignoreRotation) {
      s = s - rotationPenalty(pid, recentSet);
    }

    candidates.push({
      place: p,
      pid,
      km,
      driveMin,
      score: Number(s.toFixed(4))
    });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.driveMin - b.driveMin;
  });

  return candidates;
}

function pickDestination(origin, maxMinutes, category, styles) {
  let candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: false, ignoreRotation: false });
  if (candidates.length === 0) {
    candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: false, ignoreRotation: true });
  }
  if (candidates.length === 0) {
    candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: true, ignoreRotation: true });
  }

  const chosen = candidates[0] || null;
  const alternatives = candidates.slice(1, 3);
  return { chosen, alternatives, totalCandidates: candidates.length };
}

// -------------------- RENDER HELPERS --------------------
function quickInfoButtonsHtml(placeName, countryCode = "IT") {
  const ttd = googleThingsToDoUrl(placeName, countryCode);
  const todo = googleWhatToDoUrl(placeName, countryCode);
  const img = googleImagesUrl(placeName, countryCode);
  const eat = googleRestaurantsUrl(placeName, countryCode);
  const wiki = wikipediaUrl(placeName, countryCode);

  return `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Info subito</div>
      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn" target="_blank" rel="noopener" href="${ttd}">👀 Cosa vedere</a>
        <a class="btn" target="_blank" rel="noopener" href="${todo}">🎯 Cosa fare</a>
        <a class="btn" target="_blank" rel="noopener" href="${img}">📷 Foto</a>
        <a class="btn" target="_blank" rel="noopener" href="${eat}">🍝 Ristoranti</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${wiki}">📚 Wiki</a>
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
      </div>

      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${flightsUrl(placeName, countryCode)}">✈️ Voli</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${trainsUrl(placeName, countryCode)}">🚆 Treni</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${busUrl(placeName, countryCode)}">🚌 Bus</a>
        ${wa ? `<a class="btn btn-ghost" target="_blank" rel="noopener" href="${wa}">💬 WhatsApp</a>` : ""}
      </div>

      <div class="small muted" style="margin-top:8px;">
        Inserisci i tuoi ID affiliato in app.js (BOOKING_AID / GYG_PID / TIQETS_PID / AMAZON_TAG)
      </div>
    </div>
  `;
}

function renderNoResult(maxMinutesShown, category) {
  const area = $("resultArea");
  const extra = (category === "mare" && Number(maxMinutesShown) < 75)
    ? `Hai scelto <b>Mare</b>: spesso serve 90–180 min reali.`
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

  if (!chosen) {
    renderNoResult(maxMinutesShown, category);
    return;
  }

  const p = chosen.place;
  const pid = chosen.pid;

  const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
  const badge = isChicca ? "✨ chicca" : "✅ classica";

  const placeUrl = mapsPlaceUrl(p.lat, p.lon);
  const dirUrl = mapsDirUrl(origin.lat, origin.lon, p.lat, p.lon);

  const why = Array.isArray(p.why) ? p.why.slice(0, 4) : [];
  const whyHtml = why.length
    ? `<ul style="margin:10px 0 0; padding-left:18px; color: var(--muted);">
         ${why.map(x => `<li>${x}</li>`).join("")}
       </ul>`
    : "";

  const country = p.country || "IT";

  const altHtml = (alternatives || []).length ? `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Alternative (tocca per scegliere)</div>
      <div style="margin-top:10px; display:flex; flex-direction:column; gap:10px;">
        ${(alternatives || []).map(a => {
          const ap = a.place;
          const aPid = a.pid;
          const aIsChicca = String(ap.visibility || "").toLowerCase() === "chicca";
          const aBadge = aIsChicca ? "✨" : "✅";
          const aPlaceUrl = mapsPlaceUrl(ap.lat, ap.lon);
          const aDirUrl = mapsDirUrl(origin.lat, origin.lon, ap.lat, ap.lon);
          const aCountry = ap.country || "IT";

          return `
            <div class="card" data-alt="1" data-pid="${aPid}"
                 style="padding:12px 12px; cursor:pointer; border-color: rgba(255,255,255,.12);">
              <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
                <div>
                  <div style="font-weight:800; font-size:16px; line-height:1.2;">
                    ${ap.name} <span class="small muted">(${aBadge})</span>
                  </div>
                  <div class="small muted" style="margin-top:4px;">
                    ~${a.driveMin} min • ${fmtKm(a.km)} • ${ap.type || "meta"}
                  </div>
                </div>
                <div class="pill" style="white-space:nowrap;">Scegli</div>
              </div>

              <div class="row wrap gap" style="margin-top:10px;">
                <a class="btn btn-ghost" href="${aPlaceUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Maps</a>
                <a class="btn btn-ghost" href="${aDirUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Percorso</a>
                <a class="btn btn-ghost" href="${googleImagesUrl(ap.name, aCountry)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Foto</a>
                <a class="btn btn-ghost" href="${googleRestaurantsUrl(ap.name, aCountry)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Ristoranti</a>
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
        ${category === "mare" && Number(maxMinutesShown) < 75 ? ` • <span class="muted">(Mare: raggio smart attivo)</span>` : ""}
      </div>

      <div class="row wrap gap" style="margin-top:12px;">
        <a class="btn" href="${placeUrl}" target="_blank" rel="noopener">🗺️ Maps</a>
        <a class="btn" href="${dirUrl}" target="_blank" rel="noopener">🚗 Percorso</a>
        <a class="btn" href="${googleImagesUrl(p.name, country)}" target="_blank" rel="noopener">📷 Foto</a>
        <a class="btn" href="${googleRestaurantsUrl(p.name, country)}" target="_blank" rel="noopener">🍝 Ristoranti</a>
      </div>

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

  // track shown (for rotation)
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

  // ✅ FIX: reset now re-runs search too
  $("btnResetRotation")?.addEventListener("click", () => {
    resetRotation();
    showStatus("ok", "Reset fatto ✅ Ora rilancio la ricerca…");
    runSearch({ silent: true });
  });

  // Alternatives clickable
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

    let { chosen, alternatives } = pickDestination(origin, effMax, category, styles);

    // forbid immediate pid
    if (forbidPid && chosen?.pid === forbidPid) {
      // just mark it as session seen and rerun once
      SESSION_SEEN.add(forbidPid);
      ({ chosen, alternatives } = pickDestination(origin, effMax, category, styles));
    }

    renderResult(origin, maxMinutesInput, chosen, alternatives, { category, effMax });

    if (!chosen) {
      showStatus("warn", `Nessuna meta entro ${maxMinutesInput} min. Prova ad aumentare i minuti o cambiare filtri.`);
    } else if (!silent) {
      const extra = (category === "mare" && effMax !== maxMinutesInput)
        ? ` (Mare: ho allargato il raggio a ~${effMax} min per non lasciarti a secco)`
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
