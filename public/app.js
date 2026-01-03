/* Jamo — Auto-only (offline macro) — app.js v4.0 (EU+UK ready, FIXED UI)
 * Compatibile con il tuo HTML attuale (stessi ID e flusso).
 * Fix:
 * - Macro loader: prova EU+UK macro all, fallback Abruzzo
 * - Category matching: Family / Borghi / Storia molto più permissivo (tags + name + type)
 * - Reset “proposte di oggi”: ora azzera davvero e aggiorna la UI
 * - Link utili: Foto / Cosa vedere / Ristoranti / Eventi (sempre validi)
 * - Monetization: bottoni più “immediati” + fallback “Biglietti (Google)” (mai 404)
 */

const $ = (id) => document.getElementById(id);

// -------------------- SETTINGS --------------------
// Priorità macro: EU+UK all -> Abruzzo
const MACRO_URL_CANDIDATES = [
  "/data/macros/euuk_macro_all.json",
  "/data/macros/euuk_country_it.json",
  "/data/macros/it_macro_01_abruzzo.json",
];

// driving estimator (offline)
const ROAD_FACTOR = 1.25;
const AVG_KMH = 72;
const FIXED_OVERHEAD_MIN = 8;

// ROTATION
const RECENT_TTL_MS = 1000 * 60 * 60 * 20; // ~20h
const RECENT_MAX = 120;
let SESSION_SEEN = new Set();
let LAST_SHOWN_PID = null;

// Monetization placeholders (metti i tuoi ID affiliato)
const BOOKING_AID = ""; // Booking affiliate id (aid)
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
  return p.id || `p_${normName(p.name)}_${String(p.lat).slice(0,6)}_${String(p.lon ?? p.lng).slice(0,6)}`;
}

function estCarMinutesFromKm(km) {
  const roadKm = km * ROAD_FACTOR;
  const driveMin = (roadKm / AVG_KMH) * 60;
  return Math.round(clamp(driveMin + FIXED_OVERHEAD_MIN, 8, 900));
}

function fmtKm(km) { return `${Math.round(km)} km`; }

function mapsPlaceUrl(lat, lon, name = "") {
  if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lon)}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}`;
}

function mapsDirUrl(oLat, oLon, dLat, dLon, name = "") {
  if (Number.isFinite(Number(dLat)) && Number.isFinite(Number(dLon))) {
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(oLat + "," + oLon)}&destination=${encodeURIComponent(dLat + "," + dLon)}&travelmode=driving`;
  }
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(oLat + "," + oLon)}&destination=${encodeURIComponent(name)}&travelmode=driving`;
}

function googleImagesUrl(q) {
  return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`;
}
function googleThingsToDoUrl(q) {
  return `https://www.google.com/search?q=${encodeURIComponent("cosa vedere " + q)}`;
}
function googleEventsUrl(q) {
  return `https://www.google.com/search?q=${encodeURIComponent("eventi vicino " + q)}`;
}
function googleTicketsUrl(q) {
  return `https://www.google.com/search?q=${encodeURIComponent("biglietti " + q)}`;
}
function googleRestaurantsUrl(q) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("ristoranti " + q)}`;
}

// Monetization URLs
function bookingUrl(city, countryCode, affId = "") {
  const q = `${city}${countryCode ? ", " + countryCode : ""}`;
  const base = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(q)}`;
  return affId ? `${base}&aid=${encodeURIComponent(affId)}` : base;
}

function getYourGuideUrl(city, affId = "") {
  const base = `https://www.getyourguide.com/s/?q=${encodeURIComponent(city)}`;
  return affId ? `${base}&partner_id=${encodeURIComponent(affId)}` : base;
}

function tiqetsUrl(city, affId = "") {
  // Tiqets può essere “capriccioso” per località piccole: lo teniamo ma aggiungiamo sempre Google Tickets
  const base = `https://www.tiqets.com/it/search/?query=${encodeURIComponent(city)}`;
  return affId ? `${base}&partner=${encodeURIComponent(affId)}` : base;
}

function amazonEssentialsUrl(tag = "") {
  const base = `https://www.amazon.it/s?k=${encodeURIComponent("accessori viaggio")}`;
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

function resetRotationHard() {
  // RESET VERO: today + session + last
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

// -------------------- DATA loading --------------------
let MACRO = null;
let MACRO_URL_USED = null;

async function tryLoadMacro(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Macro non trovato (${r.status})`);
  const j = await r.json();
  if (!j?.places || !Array.isArray(j.places)) throw new Error("Macro invalido: manca places[]");
  return j;
}

async function loadMacro() {
  // prova ultima macro usata
  const last = localStorage.getItem("jamo_macro_url");
  const candidates = last ? [last, ...MACRO_URL_CANDIDATES] : MACRO_URL_CANDIDATES;

  let lastErr = null;
  for (const url of candidates) {
    try {
      const j = await tryLoadMacro(url);
      MACRO = j;
      MACRO_URL_USED = url;
      localStorage.setItem("jamo_macro_url", url);
      return j;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Impossibile caricare la macro");
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

// -------------------- FILTERS (POTENZIATI) --------------------
function hasAny(tags, arr) {
  const set = new Set((tags || []).map(t => String(t).toLowerCase()));
  return arr.some(x => set.has(String(x).toLowerCase()));
}

function matchesCategory(place, cat) {
  if (!cat || cat === "ovunque") return true;

  const type = String(place.type || "").toLowerCase();
  const name = String(place.name || "").toLowerCase();
  const tags = (place.tags || []).map(t => String(t).toLowerCase());

  // FAMILY (molto più permissivo)
  if (cat === "family") {
    return (
      type === "bambini" || type === "family" ||
      hasAny(tags, ["famiglie","bambini","family","animali","parco","parchi","zoo","acquario","parco_avventura","playground","giochi","luna_park","theme_park","amusement"]) ||
      name.includes("parco") || name.includes("zoo") || name.includes("acquario") ||
      name.includes("playground") || name.includes("luna park") || name.includes("park")
    );
  }

  // BORGHI
  if (cat === "borghi") {
    return (
      type === "borgo" ||
      hasAny(tags, ["borgo","borghi","centro_storico"]) ||
      name.includes("borgo") || name.includes("centro storico") || name.includes("old town")
    );
  }

  // STORIA
  if (cat === "storia") {
    return (
      type === "storia" ||
      hasAny(tags, ["storia","castello","abbazia","museo","museum","cattedrale","duomo","archeologia","rovine","monastero"]) ||
      name.includes("castello") || name.includes("abbazia") || name.includes("museo") ||
      name.includes("cattedrale") || name.includes("duomo") || name.includes("archeolog")
    );
  }

  // altri
  if (cat === "citta") return type === "citta" || tags.includes("citta");
  if (cat === "mare") return (
    type === "mare" ||
    hasAny(tags, ["mare","spiagge","spiaggia","lido","trabocchi","beach"]) ||
    name.includes("spiaggia") || name.includes("beach")
  );
  if (cat === "montagna") return type === "montagna" || hasAny(tags, ["montagna","neve","ski"]) || name.includes("monte");
  if (cat === "natura") return (
    type === "natura" ||
    hasAny(tags, ["natura","lago","parco","gole","cascata","riserva","park","national"]) ||
    name.includes("lago") || name.includes("parco") || name.includes("gole") || name.includes("cascat")
  );
  if (cat === "relax") return type === "relax" || hasAny(tags, ["relax","terme","spa"]) || name.includes("terme") || name.includes("spa");

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

function rotationPenalty(pid, recentSet) {
  let pen = 0;
  if (pid && pid === LAST_SHOWN_PID) pen += 0.22;
  if (SESSION_SEEN.has(pid)) pen += 0.20;
  if (recentSet.has(pid)) pen += 0.12;
  return pen;
}

// -------------------- TIME “SMART” --------------------
function effectiveMaxMinutes(maxMinutes, category) {
  const m = Number(maxMinutes);
  if (!Number.isFinite(m)) return 120;

  // Mare: allarga un po'
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
    const lon = Number(p.lon ?? p.lng);
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
    let s = baseScorePlace({
      driveMin,
      targetMin: target,
      beautyScore: p.beauty_score,
      isChicca
    });

    // Family boost: se filtro family, spingi forte
    if (category === "family") {
      const tags = (p.tags || []).map(x => String(x).toLowerCase());
      const nm = String(p.name || "").toLowerCase();
      if (tags.includes("famiglie") || tags.includes("bambini") || tags.includes("family")) s += 0.14;
      if (nm.includes("parco") || nm.includes("zoo") || nm.includes("acquario")) s += 0.12;
      s += 0.06; // boost generale
    }

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

// -------------------- RENDER --------------------
function monetBoxHtml(placeName, country = "IT") {
  const q = placeName;

  return `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">💸 Link veloci (monetizzabili + utili)</div>
      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn" target="_blank" rel="noopener" href="${bookingUrl(q, country, BOOKING_AID)}">🏨 Hotel</a>
        <a class="btn" target="_blank" rel="noopener" href="${getYourGuideUrl(q, GYG_PID)}">🎯 Cosa fare</a>
        <a class="btn" target="_blank" rel="noopener" href="${tiqetsUrl(q, TIQETS_PID)}">🎟️ Tiqets</a>
        <a class="btn" target="_blank" rel="noopener" href="${googleTicketsUrl(q)}">🎫 Biglietti</a>
        <a class="btn" target="_blank" rel="noopener" href="${googleRestaurantsUrl(q)}">🍝 Ristoranti</a>
        <a class="btn" target="_blank" rel="noopener" href="${googleEventsUrl(q)}">🎪 Eventi</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${amazonEssentialsUrl(AMAZON_TAG)}">🧳 Essenziali</a>
      </div>
      <div class="small muted" style="margin-top:8px;">
        (Per monetizzare: inserisci i tuoi ID in app.js: BOOKING_AID / GYG_PID / TIQETS_PID / AMAZON_TAG)
      </div>
    </div>
  `;
}

function infoBoxHtml(placeName, lat, lon, origin) {
  const q = placeName;
  const placeUrl = mapsPlaceUrl(lat, lon, q);
  const dirUrl = mapsDirUrl(origin.lat, origin.lon, lat, lon, q);
  const imgUrl = googleImagesUrl(q);
  const todoUrl = googleThingsToDoUrl(q);

  return `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">🔎 Info rapide</div>
      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn" target="_blank" rel="noopener" href="${imgUrl}">📷 Foto</a>
        <a class="btn" target="_blank" rel="noopener" href="${todoUrl}">🗺️ Cosa vedere</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${placeUrl}">Maps</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${dirUrl}">Percorso</a>
      </div>
    </div>
  `;
}

function renderResult(origin, maxMinutesShown, chosen, alternatives, meta = {}) {
  const area = $("resultArea");
  if (!area) return;

  const category = meta.category || "ovunque";

  if (!chosen) {
    const extra = (category === "mare" && Number(maxMinutesShown) < 75)
      ? `Hai scelto <b>Mare</b>: a volte serve un po' più tempo. (Prova 90–120 min)`
      : `Prova ad aumentare i minuti o cambiare categoria/stile.`;

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
      resetRotationHard();
      showStatus("ok", "Reset fatto ✅ Ora ti ripropongo mete che avevo evitato oggi.");
      runSearch({ silent: true });
    });

    return;
  }

  const p = chosen.place;
  const pid = chosen.pid;

  const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
  const badge = isChicca ? "✨ chicca" : "✅ classica";

  const lat = Number(p.lat);
  const lon = Number(p.lon ?? p.lng);
  const placeUrl = mapsPlaceUrl(lat, lon, p.name);
  const dirUrl = mapsDirUrl(origin.lat, origin.lon, lat, lon, p.name);

  const why = Array.isArray(p.why) ? p.why.slice(0, 4) : [];
  const whyHtml = why.length
    ? `<ul style="margin:10px 0 0; padding-left:18px; color: var(--muted);">
         ${why.map(x => `<li>${x}</li>`).join("")}
       </ul>`
    : "";

  const country = p.country || "IT";

  const altHtml = (alternatives || []).length ? `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Alternative (clicca per scegliere)</div>
      <div style="margin-top:10px; display:flex; flex-direction:column; gap:10px;">
        ${(alternatives || []).map(a => {
          const ap = a.place;
          const aPid = a.pid;
          const aIsChicca = String(ap.visibility || "").toLowerCase() === "chicca";
          const aBadge = aIsChicca ? "✨" : "✅";

          const alat = Number(ap.lat);
          const alon = Number(ap.lon ?? ap.lng);

          const aPlaceUrl = mapsPlaceUrl(alat, alon, ap.name);
          const aDirUrl = mapsDirUrl(origin.lat, origin.lon, alat, alon, ap.name);
          const aImgUrl = googleImagesUrl(ap.name);
          const aTodoUrl = googleThingsToDoUrl(ap.name);

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
                <a class="btn btn-ghost" href="${aImgUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Foto</a>
                <a class="btn btn-ghost" href="${aTodoUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Cosa vedere</a>
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
        <a class="btn" href="${placeUrl}" target="_blank" rel="noopener">🗺️ Apri su Maps</a>
        <a class="btn" href="${googleImagesUrl(p.name)}" target="_blank" rel="noopener">📷 Foto</a>
        <a class="btn" href="${googleThingsToDoUrl(p.name)}" target="_blank" rel="noopener">👀 Cosa vedere</a>
        <a class="btn btn-ghost" href="${dirUrl}" target="_blank" rel="noopener">🧭 Percorso</a>
      </div>

      ${whyHtml}

      <div class="row wrap gap" style="margin-top:12px;">
        <button class="btn btn-ghost" id="btnVisited">✅ Già visitato</button>
        <button class="btn" id="btnChange">🔁 Cambia meta</button>
        <button class="btn btn-ghost" id="btnResetRotation">🧽 Reset “proposte di oggi”</button>
      </div>
      <div class="small muted" style="margin-top:8px;">
        Macro: <b>${MACRO_URL_USED || "?"}</b>
      </div>
    </div>

    ${infoBoxHtml(p.name, lat, lon, origin)}
    ${monetBoxHtml(p.name, country)}
    ${altHtml}
  `;

  // track shown
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
    resetRotationHard();
    showStatus("ok", "Reset fatto ✅ Ora posso ripescare anche mete già proposte oggi/sessione.");
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

    // forbid specific pid (“cambia meta”)
    if (forbidPid && chosen?.pid === forbidPid) {
      const visited = getVisitedSet();
      const recentSet = getRecentSet();
      const target = effMax;
      const oLat = Number(origin.lat), oLon = Number(origin.lon);

      const candidates = [];
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
        if (km < 1.2) continue;
        if (pid === forbidPid) continue;

        const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
        let s = baseScorePlace({ driveMin, targetMin: target, beautyScore: p.beauty_score, isChicca });
        if (category === "family") s += 0.08;

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
    if (match) match.classList.add
