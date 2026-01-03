/* Jamo — Auto-only (offline macro) — app.js v3.3
 * - Multi-macro loader via /data/macros/macros_index.json
 * - Macro picker UI (region/country)
 * - Better rotation reset (works + reruns)
 * - Better monetization links + "cosa vedere/fare/foto/ristoranti/wiki"
 * - Filters out non-touristic / industrial places
 * - Elastic time fallback if no results
 */

const $ = (id) => document.getElementById(id);

// -------------------- SETTINGS --------------------
const MACROS_INDEX_URL = "/data/macros/macros_index.json";
const DEFAULT_MACRO_PATH = "/data/macros/it_macro_01_abruzzo.json"; // fallback if index missing

// driving estimator (offline)
const ROAD_FACTOR = 1.22;
const AVG_KMH = 70;
const FIXED_OVERHEAD_MIN = 7;

// ROTATION
const RECENT_TTL_MS = 1000 * 60 * 60 * 20; // ~20h: “oggi”
const RECENT_MAX = 160;                    // quante mete ricordare “oggi”
let SESSION_SEEN = new Set();              // in-memory (sessione)
let LAST_SHOWN_PID = null;

// Monetization placeholders (fill with your IDs)
const BOOKING_AID = ""; // Booking affiliate id (aid)
const AMAZON_TAG  = ""; // Amazon tag
const GYG_PID     = ""; // GetYourGuide partner_id
const TIQETS_PID  = ""; // Tiqets partner (if you have it)

// Extra aggregators (no affiliate by default, but you can later attach programs/redirects)
const SKYSCANNER_AFFIL = ""; // optional, if you have one
const OMIO_AFFIL = "";       // optional, if you have one

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
  return Math.round(clamp(driveMin + FIXED_OVERHEAD_MIN, 6, 900));
}

function fmtKm(km) { return `${Math.round(km)} km`; }

function mapsPlaceUrl(lat, lon) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lon)}`;
}

function mapsDirUrl(oLat, oLon, dLat, dLon) {
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(oLat + "," + oLon)}&destination=${encodeURIComponent(dLat + "," + dLon)}&travelmode=driving`;
}

// Google helpers (instant “cosa vedere / fare / foto / ristoranti / wiki”)
function googleSearchUrl(q) {
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}
function googleImagesUrl(q) {
  return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`;
}
function mapsQueryUrl(q) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}
function wikipediaUrl(placeName) {
  // lazy but works: send to Google "site:wikipedia ..."
  return googleSearchUrl(`${placeName} site:wikipedia.org`);
}

// -------------------- MONETIZATION URLS --------------------
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
  // IMPORTANT: /it/search spesso cambia o dà 404 — uso EN stabile
  const base = `https://www.tiqets.com/en/search/?query=${encodeURIComponent(city)}`;
  return affId ? `${base}&partner=${encodeURIComponent(affId)}` : base;
}

function amazonEssentialsUrl(tag = "") {
  const base = `https://www.amazon.it/s?k=${encodeURIComponent("accessori viaggio")}`;
  return tag ? `${base}&tag=${encodeURIComponent(tag)}` : base;
}

// Transport links (no routes, just destination search)
function skyscannerUrl(placeName, countryCode = "") {
  // generic flights search page (destination keyword)
  // you can later swap to an affiliate deep-link/redirect
  const q = `${placeName}${countryCode ? " " + countryCode : ""}`.trim();
  const base = `https://www.skyscanner.net/transport/flights/`;
  // fallback: google search to skyscanner flights + query
  const g = googleSearchUrl(`Skyscanner voli ${q}`);
  return SKYSCANNER_AFFIL ? g : g;
}

function omioUrl(placeName, countryCode = "") {
  const q = `${placeName}${countryCode ? " " + countryCode : ""}`.trim();
  // Omio has deep links if affiliate; for now google query works best
  const g = googleSearchUrl(`Omio treni bus ${q}`);
  return OMIO_AFFIL ? g : g;
}

// -------------------- STORAGE: origin + visited + recent + macro selection --------------------
function setOrigin({ label, lat, lon, country_code }) {
  $("originLabel").value = label ?? "";
  $("originLat").value = String(lat);
  $("originLon").value = String(lon);
  localStorage.setItem("jamo_origin", JSON.stringify({ label, lat, lon, country_code }));
  $("originStatus").textContent =
    `✅ Partenza: ${label || "posizione"} (${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)})`;
}

function getOrigin() {
  const lat = Number($("originLat").value);
  const lon = Number($("originLon").value);
  const label = ($("originLabel").value || "").trim();

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    // keep any stored country_code if present
    const raw = localStorage.getItem("jamo_origin");
    if (raw) {
      try {
        const o = JSON.parse(raw);
        return { label, lat, lon, country_code: o?.country_code };
      } catch {}
    }
    return { label, lat, lon };
  }

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

// Macro selection persist
function setSelectedMacroPath(p) {
  localStorage.setItem("jamo_macro_path", p);
}
function getSelectedMacroPath() {
  return localStorage.getItem("jamo_macro_path") || "";
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

// -------------------- DATA loading: macros index + macro --------------------
let MACROS_INDEX = null;
let MACRO = null;
let MACRO_PATH_IN_USE = DEFAULT_MACRO_PATH;

async function loadMacrosIndex() {
  try {
    const r = await fetch(MACROS_INDEX_URL, { cache: "no-store" });
    if (!r.ok) throw new Error("macros_index missing");
    const j = await r.json();
    if (!j?.items || !Array.isArray(j.items)) throw new Error("macros_index invalid");
    MACROS_INDEX = j;
    return j;
  } catch {
    MACROS_INDEX = null;
    return null;
  }
}

async function loadMacroByPath(p) {
  const r = await fetch(p, { cache: "no-store" });
  if (!r.ok) throw new Error(`Macro non trovato (${r.status})`);
  const j = await r.json();
  if (!j?.places || !Array.isArray(j.places)) throw new Error("Macro invalido: manca places[]");
  MACRO = j;
  MACRO_PATH_IN_USE = p;
  return j;
}

async function loadMacroAuto() {
  // Priority:
  // 1) user selected macro
  // 2) if index available, try match origin country (and prefer region scope)
  // 3) fallback default
  const picked = getSelectedMacroPath();
  if (picked) return loadMacroByPath(picked);

  const idx = MACROS_INDEX || (await loadMacrosIndex());
  const origin = getOrigin();
  const cc = (origin?.country_code || "").toUpperCase();

  if (idx?.items?.length && cc) {
    const sameCountry = idx.items.filter(x => (x.country || "").toUpperCase() === cc);
    if (sameCountry.length) {
      // pick first region macro in that country
      const region = sameCountry.find(x => x.scope === "region") || sameCountry[0];
      setSelectedMacroPath(region.path);
      return loadMacroByPath(region.path);
    }
  }

  return loadMacroByPath(DEFAULT_MACRO_PATH);
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

  // try to extract country_code from candidates (your /api/geocode includes it there)
  let cc = "";
  if (Array.isArray(j.candidates) && j.candidates.length) {
    cc = String(j.candidates[0]?.country_code || "").toUpperCase();
  }

  return { ...j.result, country_code: cc }; // {label, lat, lon, country_code}
}

// -------------------- QUALITY FILTER: remove “brutte/non turistiche” --------------------
const BAD_NAME_PATTERNS = [
  "nucleo industriale",
  "zona industriale",
  "area industriale",
  "interporto",
  "autostrada",
  "uscita",
  "casello",
  "stazione di servizio",
  "distributore",
  "centro commerciale",
  "outlet",         // spesso ok, ma per “mete bellissime” meglio evitare
  "parcheggio",
  "deposito",
  "magazzino",
  "capannone",
  "scalo",
  "svincolo",
  "cimitero",
  "ospedale",
  "tribunale"
];

function isBadPlaceName(name) {
  const n = normName(name);
  if (!n) return true;
  // troppo “tecnico”
  for (const p of BAD_NAME_PATTERNS) {
    if (n.includes(p)) return true;
  }
  // roba tipo “via …” come meta
  if (n.startsWith("via ") || n.startsWith("viale ") || n.startsWith("piazza ")) return true;
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
    tags.includes("cascata") ||
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
  const t = clamp(1 - Math.abs(driveMin - targetMin) / Math.max(20, targetMin * 0.85), 0, 1);
  const b = clamp(Number(beautyScore) || 0.75, 0.45, 1);
  const c = isChicca ? 0.06 : 0;
  return 0.62 * t + 0.34 * b + c;
}

// ROTATION penalty: avoid repeats in session + today
function rotationPenalty(pid, recentSet) {
  let pen = 0;
  if (pid && pid === LAST_SHOWN_PID) pen += 0.22;   // evita duplicato immediato
  if (SESSION_SEEN.has(pid)) pen += 0.20;           // già proposto in sessione
  if (recentSet.has(pid)) pen += 0.12;              // già proposto “oggi”
  return pen;
}

// -------------------- TIME “SMART” (special cases) --------------------
function effectiveMaxMinutes(maxMinutes, category) {
  const m = Number(maxMinutes);
  if (!Number.isFinite(m)) return 120;

  // MARE: spesso non esiste entro 60' reali, quindi allarghiamo “gentilmente”
  if (category === "mare" && m < 75) {
    const widened = Math.round(m * 1.35);
    return clamp(widened, m, 180);
  }
  return clamp(m, 10, 600);
}

// If no results, elastic expand a bit
function elasticExpand(maxMinutes) {
  const m = Number(maxMinutes);
  if (!Number.isFinite(m)) return 120;
  // small times: expand more, because estimator is conservative
  if (m <= 45) return Math.round(m * 1.45);
  if (m <= 90) return Math.round(m * 1.25);
  return Math.round(m * 1.15);
}

// -------------------- PICK DESTINATION (with rotation) --------------------
function buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited = false, ignoreRotation = false } = {}) {
  const visited = getVisitedSet();
  const recentSet = getRecentSet();

  const target = Number(maxMinutes);
  const oLat = Number(origin.lat);
  const oLon = Number(origin.lon);

  const candidates = [];

  for (const p of (MACRO?.places || [])) {
    const lat = Number(p.lat);
    const lon = Number(p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    // quality filter
    if (isBadPlaceName(p.name)) continue;

    if (!matchesCategory(p, category)) continue;
    if (!matchesStyle(p, styles)) continue;

    const pid = safeIdFromPlace(p);
    if (!ignoreVisited && visited.has(pid)) continue;

    const km = haversineKm(oLat, oLon, lat, lon);
    const driveMin = estCarMinutesFromKm(km);

    if (driveMin > target) continue;
    if (km < 1.2) continue; // “sei già lì”

    const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
    let s = baseScorePlace({
      driveMin,
      targetMin: target,
      beautyScore: p.beauty_score,
      isChicca
    });

    if (!ignoreRotation) {
      s = s - rotationPenalty(pid, recentSet);
    }

    // tiny extra: prefer better beauty always
    s += clamp((Number(p.beauty_score) || 0.75) - 0.75, -0.05, 0.08);

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
  // 1) normale
  let candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: false, ignoreRotation: false });

  // 2) se zero: ignora rotazione (ma non i visitati)
  if (candidates.length === 0) {
    candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: false, ignoreRotation: true });
  }

  // 3) se ancora zero: elastic expand un po'
  if (candidates.length === 0) {
    const expanded = clamp(elasticExpand(maxMinutes), maxMinutes, 600);
    candidates = buildCandidates(origin, expanded, category, styles, { ignoreVisited: false, ignoreRotation: true });
  }

  // 4) se ancora zero: ignora anche visited (ultima spiaggia)
  if (candidates.length === 0) {
    const expanded = clamp(elasticExpand(maxMinutes), maxMinutes, 600);
    candidates = buildCandidates(origin, expanded, category, styles, { ignoreVisited: true, ignoreRotation: true });
  }

  const chosen = candidates[0] || null;
  const alternatives = candidates.slice(1, 3); // 2 alternative
  return { chosen, alternatives, totalCandidates: candidates.length };
}

// -------------------- RENDER --------------------
function quickLinksHtml(placeName, country = "IT") {
  const qBase = `${placeName}${country ? ", " + country : ""}`;
  const see = googleSearchUrl(`cosa vedere a ${qBase}`);
  const doo = googleSearchUrl(`cosa fare a ${qBase}`);
  const foto = googleImagesUrl(`${qBase}`);
  const food = mapsQueryUrl(`ristoranti ${qBase}`);
  const wiki = wikipediaUrl(qBase);

  return `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Info rapide</div>
      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn" target="_blank" rel="noopener" href="${see}">👀 Cosa vedere</a>
        <a class="btn" target="_blank" rel="noopener" href="${doo}">🎯 Cosa fare</a>
        <a class="btn" target="_blank" rel="noopener" href="${foto}">📸 Foto</a>
        <a class="btn" target="_blank" rel="noopener" href="${food}">🍝 Ristoranti</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${wiki}">📚 Wiki</a>
      </div>
    </div>
  `;
}

function monetBoxHtml(placeName, country = "IT") {
  return `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Prenota / Compra (link monetizzabili)</div>

      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn" target="_blank" rel="noopener" href="${bookingUrl(placeName, country, BOOKING_AID)}">🏨 Hotel</a>
        <a class="btn" target="_blank" rel="noopener" href="${getYourGuideUrl(placeName, GYG_PID)}">🎟️ Tour</a>
        <a class="btn" target="_blank" rel="noopener" href="${tiqetsUrl(placeName, TIQETS_PID)}">🏛️ Biglietti</a>
        <a class="btn" target="_blank" rel="noopener" href="${amazonEssentialsUrl(AMAZON_TAG)}">🧳 Essenziali</a>
      </div>

      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${skyscannerUrl(placeName, country)}">✈️ Voli</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${omioUrl(placeName, country)}">🚆 Treni/Bus</a>
      </div>

      <div class="small muted" style="margin-top:8px;">
        Per monetizzare davvero: inserisci i tuoi ID in app.js (BOOKING_AID / GYG_PID / TIQETS_PID / AMAZON_TAG).
      </div>
    </div>
  `;
}

function renderResult(origin, maxMinutesShown, chosen, alternatives, meta = {}) {
  const area = $("resultArea");
  const category = meta.category || "ovunque";

  if (!chosen) {
    const extra = (category === "mare" && Number(maxMinutesShown) < 75)
      ? `Hai scelto <b>Mare</b>: spesso serve un po' più tempo. Prova 90–120 min.`
      : `Prova ad aumentare i minuti o cambiare categoria/stile.`;

    area.innerHTML = `
      <div class="card errbox">
        <div class="small">❌ Nessuna meta trovata entro ${maxMinutesShown} min con i filtri attuali.</div>
        <div class="small muted" style="margin-top:6px;">${extra}</div>
        <div class="row wrap gap" style="margin-top:12px;">
          <button class="btn btn-ghost" type="button" id="btnResetRotation">🧽 Reset “proposte di oggi”</button>
        </div>
      </div>
    `;
    $("btnResetRotation")?.addEventListener("click", () => {
      resetRotation();
      showStatus("ok", "Reset fatto ✅ Ora riprovo subito.");
      runSearch({ silent: true });
    });
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

  const country = p.country || origin.country_code || "IT";

  const altHtml = (alternatives || []).length ? `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Alternative (clicca per scegliere)</div>
      <div style="margin-top:10px; display:flex; flex-direction:column; gap:10px;">
        ${(alternatives || []).map(a => {
          const ap = a.place;
          const aPid = a.pid;
          const aIsChicca = String(ap.visibility || "").toLowerCase() === "chicca";
          const aBadge = aIsChicca ? "✨" : "✅";
          const aPlaceUrl = mapsPlaceUrl(ap.lat, ap.lon);
          const aDirUrl = mapsDirUrl(origin.lat, origin.lon, ap.lat, ap.lon);
          const aInfo = googleSearchUrl(`cosa vedere a ${ap.name} ${country}`);
          const aFoto = googleImagesUrl(`${ap.name} ${country}`);

          return `
            <div class="card" data-alt="1" data-pid="${aPid}"
                 style="padding:12px 12px; cursor:pointer; border-color: rgba(255,255,255,.12);">
              <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
                <div style="min-width:0;">
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
                <a class="btn btn-ghost" href="${aPlaceUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Maps</a>
                <a class="btn btn-ghost" href="${aDirUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Percorso</a>
                <a class="btn btn-ghost" href="${aInfo}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Cosa vedere</a>
                <a class="btn btn-ghost" href="${aFoto}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Foto</a>
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
      </div>

      ${whyHtml}

      <div class="row wrap gap" style="margin-top:12px;">
        <button class="btn btn-ghost" type="button" id="btnVisited">✅ Già visitato</button>
        <button class="btn" type="button" id="btnChange">🔁 Cambia meta</button>
        <button class="btn btn-ghost" type="button" id="btnResetRotation">🧽 Reset oggi</button>
      </div>
    </div>

    ${quickLinksHtml(p.name, country)}
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
    showStatus("ok", "Reset fatto ✅ Ora riprovo subito.");
    runSearch({ silent: true });
  });

  // Alternative clickable: click -> set as main immediately
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

    if (!MACRO) {
      await loadMacroAuto();
    }

    const origin = getOrigin();
    if (!origin || !Number.isFinite(Number(origin.lat)) || !Number.isFinite(Number(origin.lon))) {
      showStatus("err", "Imposta una partenza: GPS oppure scrivi un luogo e premi “Usa questo luogo”.");
      return;
    }

    const maxMinutesInput = clamp(Number($("maxMinutes").value) || 120, 10, 600);
    const category = getActiveCategory();
    const styles = getActiveStyles();

    // smart effective time (especially for mare)
    const effMax = effectiveMaxMinutes(maxMinutesInput, category);

    // pick
    let { chosen, alternatives } = pickDestination(origin, effMax, category, styles);

    // forbid immediate specific pid (e.g. “cambia meta”)
    if (forbidPid && chosen?.pid === forbidPid) {
      const tmp = new Set(SESSION_SEEN);
      tmp.add(forbidPid);

      const visited = getVisitedSet();
      const recentSet = getRecentSet();
      const target = effMax;
      const candidates = [];
      const oLat = Number(origin.lat), oLon = Number(origin.lon);

      for (const p of (MACRO?.places || [])) {
        const lat = Number(p.lat), lon = Number(p.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        if (isBadPlaceName(p.name)) continue;

        const pid = safeIdFromPlace(p);
        if (visited.has(pid)) continue;
        if (!matchesCategory(p, category)) continue;
        if (!matchesStyle(p, styles)) continue;

        const km = haversineKm(oLat, oLon, lat, lon);
        const driveMin = estCarMinutesFromKm(km);
        if (driveMin > target) continue;
        if (km < 1.2) continue;
        if (tmp.has(pid)) continue;

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

// -------------------- INIT helpers --------------------
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
      setOrigin({ label: result.label || label, lat: result.lat, lon: result.lon, country_code: result.country_code });
      showStatus("ok", "Partenza impostata ✅");

      // if user hasn't selected a macro, try auto load a better macro for that country
      if (!getSelectedMacroPath()) {
        MACRO = null;
        await loadMacroAuto().catch(() => {});
      }
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

// -------------------- Macro picker UI (injected) --------------------
function injectMacroPicker() {
  const container = document.querySelector(".card"); // first card (filters)
  if (!container) return;

  const host = document.createElement("div");
  host.className = "hr";
  // insert after origin section (after lat/lon row if possible)
  const originStatus = $("originStatus");
  if (originStatus?.parentNode) {
    originStatus.parentNode.insertBefore(host, originStatus.nextSibling);
  }

  const wrap = document.createElement("div");
  wrap.style.marginTop = "12px";
  wrap.innerHTML = `
    <h3 style="margin:10px 0 8px; font-size:16px;">Dati / Regione</h3>
    <div class="small muted">Scegli il dataset (se hai più macro). Se non scegli, uso “Auto”.</div>
    <div class="row gap" style="margin-top:10px;">
      <select id="macroSelect"></select>
      <button id="btnMacroAuto" class="btn btn-ghost" type="button">🤖 Auto</button>
    </div>
    <div id="macroStatus" class="small muted" style="margin-top:8px;"></div>
  `;

  if (originStatus?.parentNode) {
    originStatus.parentNode.insertBefore(wrap, host.nextSibling);
  }

  const sel = $("macroSelect");
  const btnAuto = $("btnMacroAuto");
  const status = $("macroStatus");

  const saved = getSelectedMacroPath();

  const items = (MACROS_INDEX?.items || []).slice();
  // sort: IT regions first, then others
  items.sort((a,b) => {
    const ac = (a.country || "") === "IT" ? 0 : 1;
    const bc = (b.country || "") === "IT" ? 0 : 1;
    if (ac !== bc) return ac - bc;
    return String(a.label || a.id).localeCompare(String(b.label || b.id));
  });

  sel.innerHTML = `
    <option value="">🤖 Auto (in base alla partenza)</option>
    ${items.map(it => `<option value="${it.path}">${it.country} • ${it.label}</option>`).join("")}
  `;
  if (saved) sel.value = saved;

  function setStatusText() {
    const using = MACRO_PATH_IN_USE || saved || DEFAULT_MACRO_PATH;
    status.textContent = `Macro in uso: ${using}`;
  }

  sel.addEventListener("change", async () => {
    const v = sel.value;
    if (!v) {
      localStorage.removeItem("jamo_macro_path");
      MACRO = null;
      await loadMacroAuto().catch(() => {});
      setStatusText();
      showStatus("ok", "Modalità Auto ✅");
      return;
    }

    try {
      setSelectedMacroPath(v);
      MACRO = null;
      await loadMacroByPath(v);
      setStatusText();
      showStatus("ok", "Macro cambiato ✅");
    } catch (e) {
      console.error(e);
      showStatus("err", "Macro non disponibile (file mancante). Aggiungi il macro in public/data/macros/.");
    }
  });

  btnAuto.addEventListener("click", async () => {
    localStorage.removeItem("jamo_macro_path");
    sel.value = "";
    MACRO = null;
    await loadMacroAuto().catch(() => {});
    setStatusText();
    showStatus("ok", "Auto ✅");
  });

  setStatusText();
}

// -------------------- INIT --------------------
async function boot() {
  initChips("timeChips", { multi: false });
  initChips("categoryChips", { multi: false });
  initChips("styleChips", { multi: true });

  initTimeChipsSync();
  restoreOrigin();
  bindOriginButtons();
  bindMainButtons();

  await loadMacrosIndex().catch(() => {});
  injectMacroPicker();

  // preload macro
  await loadMacroAuto().catch(() => {});
  hideStatus();
}

boot();
