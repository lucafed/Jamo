/* Jamo — Auto-only (offline macro) — app.js v3.3 FULL
 * - Origin: GPS or manual (geocode via /api/geocode?q=)
 * - Picks destinations from macro places based on:
 *   time (maxMinutes), category, style (chicche/classici), rotation (not repeating)
 * - Outputs: result card + 2 alternatives (clickable) + maps + “foto/cosa fare” + monetization + transport links
 */

const $ = (id) => document.getElementById(id);

// -------------------- SETTINGS --------------------
const MACRO_URL = "/data/macros/it_macro_01_abruzzo.json";

// driving estimator (offline)
const ROAD_FACTOR = 1.22;        // leggermente meno aggressivo (più risultati a 30–60 min)
const AVG_KMH = 74;
const FIXED_OVERHEAD_MIN = 6;    // prima era 8: a corto raggio uccideva troppo

// ROTATION
const RECENT_TTL_MS = 1000 * 60 * 60 * 20; // ~20h: “oggi”
const RECENT_MAX = 180;                    // più memoria -> meno ripetizioni
let SESSION_SEEN = new Set();
let LAST_SHOWN_PID = null;

// Monetization placeholders (fill with your IDs)
const BOOKING_AID = "";     // Booking affiliate id (aid)
const AMAZON_TAG  = "";     // Amazon tag
const GYG_PID     = "";     // GetYourGuide partner_id
const VIATOR_AID  = "";     // Viator/Tripadvisor affiliate (placeholder)

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

function slugCity(s) {
  // slug “robusto” per link route-based (Omio ecc.)
  // es: "L'Aquila" -> "l-aquila", "San Vito Chietino" -> "san-vito-chietino"
  return normName(s).replace(/\s+/g, "-");
}

function safeIdFromPlace(p) {
  return p.id || `p_${normName(p.name)}_${String(p.lat).slice(0,6)}_${String(p.lon).slice(0,6)}`;
}

function estCarMinutesFromKm(km) {
  const roadKm = km * ROAD_FACTOR;
  const driveMin = (roadKm / AVG_KMH) * 60;
  return Math.round(clamp(driveMin + FIXED_OVERHEAD_MIN, 6, 900));
}

function fmtKm(km) { return `${Math.round(km)} km`; }

// -------------------- LINKS: MAPS / INFO / FOTO --------------------
function mapsPlaceUrl(lat, lon) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lon)}`;
}

function mapsDirUrl(oLat, oLon, dLat, dLon) {
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(oLat + "," + oLon)}&destination=${encodeURIComponent(dLat + "," + dLon)}&travelmode=driving`;
}

function googleImagesUrl(placeName) {
  return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(placeName + " foto")}`;
}

function googleWhatToDoUrl(placeName) {
  return `https://www.google.com/search?q=${encodeURIComponent(placeName + " cosa vedere cosa fare")}`;
}

function mapsThingsToDoUrl(placeName) {
  // “cose da fare” spesso meglio di un sito custom
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("cose da fare " + placeName)}`;
}

function mapsRestaurantsUrl(placeName) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("ristoranti vicino " + placeName)}`;
}

// -------------------- LINKS: MONETIZATION --------------------
function bookingUrl(city, countryCode, affId = "") {
  const q = `${city}${countryCode ? ", " + countryCode : ""}`;
  const base = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(q)}`;
  return affId ? `${base}&aid=${encodeURIComponent(affId)}` : base;
}

function getYourGuideUrl(city, affId = "") {
  const base = `https://www.getyourguide.com/s/?q=${encodeURIComponent(city)}`;
  return affId ? `${base}&partner_id=${encodeURIComponent(affId)}` : base;
}

function viatorUrl(city, affId = "") {
  // Viator search by text (stabile)
  // per affiliazione: userai il tuo link builder -> qui lasciamo placeholder
  const base = `https://www.viator.com/searchResults/all?text=${encodeURIComponent(city)}`;
  return affId ? `${base}&pid=${encodeURIComponent(affId)}` : base;
}

function amazonEssentialsUrl(tag = "") {
  const base = `https://www.amazon.it/s?k=${encodeURIComponent("accessori viaggio")} `;
  return tag ? `${base}&tag=${encodeURIComponent(tag)}` : base;
}

// -------------------- LINKS: TRANSPORT (NO TRATTE, SOLO LINK) --------------------
// Omio route-based pages: /trains/<from>/<to> , /buses/<from>/<to> , /flights/<from>/<to>
// Non è perfetto per ogni micro-località, ma funziona bene su città/mete principali.
// Se slug non matcha, l’utente atterra comunque su Omio e può aggiustare.
function omioTrainUrl(fromLabel, toLabel) {
  const from = slugCity(fromLabel || "roma");
  const to = slugCity(toLabel || "pescara");
  return `https://www.omio.com/trains/${encodeURIComponent(from)}/${encodeURIComponent(to)}`;
}
function omioBusUrl(fromLabel, toLabel) {
  const from = slugCity(fromLabel || "roma");
  const to = slugCity(toLabel || "pescara");
  return `https://www.omio.com/buses/${encodeURIComponent(from)}/${encodeURIComponent(to)}`;
}
function omioFlightsUrl(fromLabel, toLabel) {
  const from = slugCity(fromLabel || "rome");
  const to = slugCity(toLabel || "london");
  return `https://www.omio.com/flights/${encodeURIComponent(from)}/${encodeURIComponent(to)}`;
}

// fallback “sempre valido”
function travelSearchFallback(fromLabel, toLabel) {
  const q = `${fromLabel} ${toLabel} biglietti treno bus aereo`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
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
  t.innerHTML = text; // allow small html
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
function hasAny(tags, list) {
  for (const x of list) if (tags.includes(x)) return true;
  return false;
}

function matchesCategory(place, cat) {
  if (!cat || cat === "ovunque") return true;

  const type = String(place.type || "").toLowerCase();
  const tags = (place.tags || []).map(t => String(t).toLowerCase());
  const name = String(place.name || "").toLowerCase();

  if (cat === "citta") return type === "citta" || tags.includes("citta");

  if (cat === "borghi") return type === "borgo" || tags.includes("borgo");

  if (cat === "mare") return (
    type === "mare" ||
    hasAny(tags, ["mare","trabocchi","spiagge","spiaggia","lido","costa"]) ||
    name.includes("marina") || name.includes("lido") || name.includes("spiaggia") || name.includes("trabocc")
  );

  if (cat === "montagna") return (
    type === "montagna" ||
    hasAny(tags, ["montagna","neve","sci","trekking"]) ||
    name.includes("monte") || name.includes("gran sasso") || name.includes("majella")
  );

  if (cat === "natura") return (
    type === "natura" ||
    hasAny(tags, ["natura","lago","parco_nazionale","gole","cascata","cascate","riserva","sentieri","trekking"]) ||
    name.includes("lago") || name.includes("gole") || name.includes("riserva") || name.includes("cascat")
  );

  if (cat === "relax") return (
    type === "relax" ||
    hasAny(tags, ["relax","terme","spa","benessere"]) ||
    name.includes("terme") || name.includes("spa")
  );

  if (cat === "family") return (
    type === "bambini" ||
    hasAny(tags, ["famiglie","bambini","family","animali","parco_avventura","acquario","zoo","attivita","attività","giochi"]) ||
    name.includes("zoo") || name.includes("parco") || name.includes("avventura")
  );

  if (cat === "storia") {
    // IMPORTANT: “storia” era troppo stretta.
    // Ora include anche città/borghi se hanno tag cultura/storia/monumenti ecc.
    return (
      type === "storia" ||
      hasAny(tags, ["storia","castello","abbazia","museo","arte","monumenti","archeologia","centro_storico"]) ||
      (type === "citta" && hasAny(tags, ["storia","arte","centro_storico"])) ||
      (type === "borgo" && hasAny(tags, ["storia","centro_storico","arte"])) ||
      name.includes("castello") || name.includes("fortezza") || name.includes("abbazia") || name.includes("eremo") || name.includes("museo")
    );
  }

  return true;
}

function matchesStyle(place, { wantChicche, wantClassici }) {
  const vis = String(place.visibility || "").toLowerCase(); // "chicca" | "conosciuta"
  if (!wantChicche && !wantClassici) return true;
  if (vis === "chicca") return !!wantChicche;
  return !!wantClassici;
}

function baseScorePlace({ driveMin, targetMin, beautyScore, isChicca }) {
  const t = clamp(1 - Math.abs(driveMin - targetMin) / Math.max(20, targetMin * 0.85), 0, 1);
  const b = clamp(Number(beautyScore) || 0.78, 0.45, 1);
  const c = isChicca ? 0.06 : 0;
  return 0.60 * t + 0.36 * b + c;
}

function rotationPenalty(pid, recentSet) {
  let pen = 0;
  if (pid && pid === LAST_SHOWN_PID) pen += 0.26;
  if (SESSION_SEEN.has(pid)) pen += 0.22;
  if (recentSet.has(pid)) pen += 0.14;
  return pen;
}

// -------------------- TIME “SMART” --------------------
function effectiveMaxMinutes(maxMinutes, category) {
  const m = Number(maxMinutes);
  if (!Number.isFinite(m)) return 120;

  // MARE: spesso non c’è entro 60 reali
  if (category === "mare" && m < 75) return clamp(Math.round(m * 1.35), m, 180);

  // STORIA: a 30 min può essere “stretta” se dataset non ha castelli vicini -> piccolo allargamento
  if (category === "storia" && m <= 35) return clamp(Math.round(m * 1.20), m, 90);

  return clamp(m, 10, 600);
}

// -------------------- PICK DESTINATION --------------------
function buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited = false, ignoreRotation = false, softCategoryFallback = false } = {}) {
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

    // category match (optionally “soft” fallback)
    let catOk = matchesCategory(p, category);
    if (!catOk && softCategoryFallback) {
      // fallback leggero: se chiedi "storia" ma non c’è, includi città/borghi belli con tag “storia/arte”
      if (category === "storia") {
        const tags = (p.tags || []).map(x => String(x).toLowerCase());
        const type = String(p.type || "").toLowerCase();
        catOk = (type === "citta" || type === "borgo") && (tags.includes("storia") || tags.includes("arte") || tags.includes("centro_storico"));
      }
    }
    if (!catOk) continue;

    if (!matchesStyle(p, styles)) continue;

    const pid = safeIdFromPlace(p);
    if (!ignoreVisited && visited.has(pid)) continue;

    const km = haversineKm(oLat, oLon, lat, lon);
    const driveMin = estCarMinutesFromKm(km);

    if (driveMin > target) continue;
    if (km < 1.2) continue;

    const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
    let s = baseScorePlace({ driveMin, targetMin: target, beautyScore: p.beauty_score, isChicca });

    if (!ignoreRotation) s = s - rotationPenalty(pid, recentSet);

    candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
  }

  candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
  return candidates;
}

function pickDestination(origin, maxMinutes, category, styles) {
  // 1) normale
  let candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: false, ignoreRotation: false, softCategoryFallback: false });

  // 2) se zero: soft fallback (solo per storia)
  if (candidates.length === 0 && category === "storia") {
    candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: false, ignoreRotation: false, softCategoryFallback: true });
  }

  // 3) se zero: ignora rotazione
  if (candidates.length === 0) {
    candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: false, ignoreRotation: true, softCategoryFallback: category === "storia" });
  }

  // 4) se zero: ignora visited
  if (candidates.length === 0) {
    candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: true, ignoreRotation: true, softCategoryFallback: category === "storia" });
  }

  const chosen = candidates[0] || null;
  const alternatives = candidates.slice(1, 3); // 2 alternative
  return { chosen, alternatives, totalCandidates: candidates.length };
}

// -------------------- UI HTML HELPERS --------------------
function bigBtnStyle(extra = "") {
  return `style="padding:12px 14px; border-radius:16px; font-weight:750; ${extra}"`;
}

function monetBoxHtml(placeName, country = "IT") {
  return `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Prenota / Scopri (monetizzabile)</div>

      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn" ${bigBtnStyle()} target="_blank" rel="noopener" href="${bookingUrl(placeName, country, BOOKING_AID)}">🏨 Hotel</a>
        <a class="btn" ${bigBtnStyle()} target="_blank" rel="noopener" href="${getYourGuideUrl(placeName, GYG_PID)}">🎟️ Tour</a>
        <a class="btn" ${bigBtnStyle()} target="_blank" rel="noopener" href="${viatorUrl(placeName, VIATOR_AID)}">🏛️ Esperienze</a>
        <a class="btn btn-ghost" ${bigBtnStyle()} target="_blank" rel="noopener" href="${amazonEssentialsUrl(AMAZON_TAG)}">🧳 Essenziali</a>
      </div>

      <div class="small muted" style="margin-top:10px;">
        Suggerimento: Hotel + Tour + Esperienze rendono anche su mete vicine (weekend, pranzo, attività).
      </div>
    </div>
  `;
}

function infoBoxHtml(originLabel, placeName) {
  const from = originLabel || "La mia posizione";
  const to = placeName;

  const train = omioTrainUrl(from, to);
  const bus = omioBusUrl(from, to);
  const flight = omioFlightsUrl(from, to);
  const fallback = travelSearchFallback(from, to);

  return `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Foto • Cosa vedere • Ristoranti • Biglietti</div>

      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn btn-ghost" ${bigBtnStyle()} target="_blank" rel="noopener" href="${googleImagesUrl(to)}">📸 Foto</a>
        <a class="btn btn-ghost" ${bigBtnStyle()} target="_blank" rel="noopener" href="${googleWhatToDoUrl(to)}">👀 Cosa vedere</a>
        <a class="btn btn-ghost" ${bigBtnStyle()} target="_blank" rel="noopener" href="${mapsThingsToDoUrl(to)}">🎯 Cose da fare</a>
        <a class="btn btn-ghost" ${bigBtnStyle()} target="_blank" rel="noopener" href="${mapsRestaurantsUrl(to)}">🍝 Ristoranti</a>
      </div>

      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn" ${bigBtnStyle()} target="_blank" rel="noopener" href="${train}">🚆 Treni</a>
        <a class="btn" ${bigBtnStyle()} target="_blank" rel="noopener" href="${bus}">🚌 Bus</a>
        <a class="btn" ${bigBtnStyle()} target="_blank" rel="noopener" href="${flight}">✈️ Aerei</a>
        <a class="btn btn-ghost" ${bigBtnStyle()} target="_blank" rel="noopener" href="${fallback}">🔎 Cerca biglietti</a>
      </div>

      <div class="small muted" style="margin-top:10px;">
        (Qui non stiamo gestendo tratte/orari: apriamo il sito di acquisto direttamente. Per affiliazioni: vedi note sotto.)
      </div>
    </div>
  `;
}

// -------------------- RENDER --------------------
function renderResult(origin, maxMinutesShown, chosen, alternatives, meta = {}) {
  const area = $("resultArea");
  const category = meta.category || "ovunque";
  const effMax = meta.effMax ?? maxMinutesShown;

  if (!chosen) {
    const extra =
      (category === "mare" && Number(maxMinutesShown) < 75)
        ? `Hai scelto <b>Mare</b>: spesso serve più tempo. Prova 90–120 min.`
        : (category === "storia" && Number(maxMinutesShown) <= 35)
          ? `Hai scelto <b>Storia</b> a ${maxMinutesShown} min: può essere stretta. Prova 45–60 min.`
          : `Prova ad aumentare i minuti o cambiare categoria/stile.`;

    area.innerHTML = `
      <div class="card errbox">
        <div class="small">❌ Nessuna meta trovata entro ${maxMinutesShown} min con i filtri attuali.</div>
        <div class="small muted" style="margin-top:6px;">${extra}</div>
        <div class="row wrap gap" style="margin-top:12px;">
          <button class="btn btn-ghost" id="btnResetRotation">${"🧽 Reset proposte di oggi"}</button>
          <button class="btn" id="btnTryAgain">🔁 Riprova</button>
        </div>
      </div>
    `;

    $("btnResetRotation")?.addEventListener("click", () => {
      resetRotation();
      showStatus("ok", "Reset fatto ✅ Ora ti propongo mete diverse.");
      runSearch({ silent: true });
    });

    $("btnTryAgain")?.addEventListener("click", () => runSearch());

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
    ? `<ul style="margin:10px 0 0; padding-left:18px; color: var(--muted); font-size:13px;">
         ${why.map(x => `<li>${x}</li>`).join("")}
       </ul>`
    : "";

  const country = p.country || "IT";

  const altHtml = (alternatives || []).length ? `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Alternative (tocca per scegliere)</div>
      <div style="margin-top:10px; display:flex; flex-direction:column; gap:12px;">
        ${(alternatives || []).map(a => {
          const ap = a.place;
          const aPid = a.pid;
          const aIsChicca = String(ap.visibility || "").toLowerCase() === "chicca";
          const aBadge = aIsChicca ? "✨" : "✅";
          const aPlaceUrl = mapsPlaceUrl(ap.lat, ap.lon);
          const aDirUrl = mapsDirUrl(origin.lat, origin.lon, ap.lat, ap.lon);

          return `
            <div class="card" data-alt="1" data-pid="${aPid}"
                 style="padding:14px 14px; cursor:pointer; border-color: rgba(0,224,255,.25);">
              <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
                <div>
                  <div style="font-weight:850; font-size:18px; line-height:1.2;">
                    ${ap.name} <span class="small muted">(${aBadge})</span>
                  </div>
                  <div class="small" style="margin-top:6px; color: var(--text); opacity:.92;">
                    ~${a.driveMin} min • ${fmtKm(a.km)} • <span class="muted">${ap.type || "meta"}</span>
                  </div>
                </div>
                <div class="pill" style="white-space:nowrap; font-size:13px;">Scegli</div>
              </div>

              <div class="row wrap gap" style="margin-top:12px;">
                <a class="btn btn-ghost" ${bigBtnStyle("padding:10px 12px;")} href="${aPlaceUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Maps</a>
                <a class="btn btn-ghost" ${bigBtnStyle("padding:10px 12px;")} href="${aDirUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Percorso</a>
                <a class="btn btn-ghost" ${bigBtnStyle("padding:10px 12px;")} href="${googleImagesUrl(ap.name)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Foto</a>
                <a class="btn btn-ghost" ${bigBtnStyle("padding:10px 12px;")} href="${mapsRestaurantsUrl(ap.name)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Ristoranti</a>
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

      <div class="small muted" style="margin-top:8px; font-size:13px;">
        Categoria: <b>${p.type || "meta"}</b> • Punteggio: <b>${chosen.score}</b>
        ${category === "mare" && effMax !== maxMinutesShown ? ` • <span class="muted">(Mare: raggio smart ~${effMax} min)</span>` : ""}
      </div>

      <div class="row wrap gap" style="margin-top:14px;">
        <a class="btn" ${bigBtnStyle()} href="${placeUrl}" target="_blank" rel="noopener">🗺️ Google Maps</a>
        <a class="btn btn-ghost" ${bigBtnStyle()} href="${dirUrl}" target="_blank" rel="noopener">➡️ Percorso</a>
        <a class="btn btn-ghost" ${bigBtnStyle()} href="${googleImagesUrl(p.name)}" target="_blank" rel="noopener">📸 Foto</a>
      </div>

      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn btn-ghost" ${bigBtnStyle()} href="${googleWhatToDoUrl(p.name)}" target="_blank" rel="noopener">👀 Cosa vedere</a>
        <a class="btn btn-ghost" ${bigBtnStyle()} href="${mapsThingsToDoUrl(p.name)}" target="_blank" rel="noopener">🎯 Cose da fare</a>
        <a class="btn btn-ghost" ${bigBtnStyle()} href="${mapsRestaurantsUrl(p.name)}" target="_blank" rel="noopener">🍝 Ristoranti</a>
      </div>

      ${whyHtml}

      <div class="row wrap gap" style="margin-top:14px;">
        <button class="btn btn-ghost" ${bigBtnStyle()} id="btnVisited">✅ Già visitato</button>
        <button class="btn" ${bigBtnStyle()} id="btnChange">🔁 Cambia meta</button>
        <button class="btn btn-ghost" ${bigBtnStyle()} id="btnResetRotation">🧽 Reset proposte di oggi</button>
      </div>
    </div>

    ${infoBoxHtml(origin.label || origin.label === "" ? origin.label : "La mia posizione", p.name)}
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

  $("btnResetRotation")?.addEventListener("click", () => {
    resetRotation();
    showStatus("ok", "Reset fatto ✅ Ora ti propongo mete diverse (anche quelle già uscite oggi).");
    runSearch({ silent: true });
  });

  // Alternative clickable
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
      const visited = getVisitedSet();
      const recentSet = getRecentSet();
      const target = effMax;

      const candidates = [];
      const oLat = Number(origin.lat), oLon = Number(origin.lon);

      for (const p of MACRO.places) {
        const lat = Number(p.lat), lon = Number(p.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        const pid = safeIdFromPlace(p);
        if (visited.has(pid)) continue;
        if (pid === forbidPid) continue;

        if (!matchesCategory(p, category) && !(category === "storia")) continue;
        if (!matchesStyle(p, styles)) continue;

        const km = haversineKm(oLat, oLon, lat, lon);
        const driveMin = estCarMinutesFromKm(km);
        if (driveMin > target) continue;
        if (km < 1.2) continue;

        const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
        let s = baseScorePlace({ driveMin, targetMin: target, beautyScore: p.beauty_score, isChicca });
        s = s - rotationPenalty(pid, recentSet);

        candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
      }

      candidates.sort((a,b)=> (b.score-a.score) || (a.driveMin-b.driveMin));
      chosen = candidates[0] || null;
      alternatives = candidates.slice(1,3);
    }

    renderResult(origin, maxMinutesInput, chosen, alternatives, { category, effMax });

    if (!chosen) {
      showStatus("warn", `Nessuna meta entro ${maxMinutesInput} min. Prova ad aumentare i minuti o cambiare filtri.`);
    } else if (!silent) {
      const extra = (effMax !== maxMinutesInput)
        ? ` <span class="muted">(raggio smart: ~${effMax} min)</span>`
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
