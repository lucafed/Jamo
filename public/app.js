/* Jamo — app.js v4.0
 * - Macro selector from /data/macros/macros_index.json (no HTML changes needed)
 * - Rotation: avoids repeats in session + “today”
 * - Better alternatives UI (clickable + readable)
 * - Monetization links: Booking / GYG / Tiqets (fixed) / Amazon + Restaurants
 * - “Reset proposte di oggi” works
 */

const $ = (id) => document.getElementById(id);

// -------------------- SETTINGS --------------------
const MACROS_INDEX_URL = "/data/macros/macros_index.json";
const DEFAULT_MACRO_URL = "/data/macros/it_macro_01_abruzzo.json";
const LS_MACRO_URL_KEY = "jamo_macro_url";

// driving estimator (offline)
const ROAD_FACTOR = 1.25;
const AVG_KMH = 72;
const FIXED_OVERHEAD_MIN = 8;

// ROTATION
const RECENT_TTL_MS = 1000 * 60 * 60 * 20; // ~20h
const RECENT_MAX = 160;                    // quante mete ricordare “oggi”
let SESSION_SEEN = new Set();
let LAST_SHOWN_PID = null;

// Monetization placeholders (fill with your IDs)
const BOOKING_AID = ""; // Booking affiliate id (aid)
const AMAZON_TAG  = ""; // Amazon tag
const GYG_PID     = ""; // GetYourGuide partner_id
const TIQETS_PID  = ""; // Tiqets partner
const THEFORK_AFF = ""; // opzionale: se hai affiliazione TheFork (se vuoto, link normale)

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
  return p.id || `p_${normName(p.name)}_${String(p.lat).slice(0, 6)}_${String(p.lon).slice(0, 6)}`;
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

function googleThingsToDoUrl(placeName) {
  const q = `cosa vedere ${placeName}`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

function googleRestaurantsUrl(placeName) {
  const q = `ristoranti vicino ${placeName}`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

// -------------------- Monetization URLs --------------------
function bookingUrl(place, countryCode, affId = "") {
  const q = `${place}${countryCode ? ", " + countryCode : ""}`;
  const base = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(q)}`;
  return affId ? `${base}&aid=${encodeURIComponent(affId)}` : base;
}

function getYourGuideUrl(place, affId = "") {
  // query più “robusta” (GYG spesso capisce meglio così)
  const q = `${place} tickets things to do`;
  const base = `https://www.getyourguide.com/s/?q=${encodeURIComponent(q)}&locale=it`;
  return affId ? `${base}&partner_id=${encodeURIComponent(affId)}` : base;
}

function tiqetsUrl(place, affId = "") {
  // FIX: /it/search spesso fa 404. /en/search è più stabile.
  const base = `https://www.tiqets.com/en/search/?query=${encodeURIComponent(place)}`;
  return affId ? `${base}&partner=${encodeURIComponent(affId)}` : base;
}

function amazonEssentialsUrl(tag = "") {
  const base = `https://www.amazon.it/s?k=${encodeURIComponent("accessori viaggio")}`;
  return tag ? `${base}&tag=${encodeURIComponent(tag)}` : base;
}

function theForkSearchUrl(place, aff = "") {
  // TheFork non sempre supporta aff param pubblico stabile: metto aff solo se lo usi nel tuo programma
  const base = `https://www.thefork.it/search?query=${encodeURIComponent(place)}`;
  return aff ? `${base}&utm_source=${encodeURIComponent(aff)}` : base;
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

// -------------------- UI: status --------------------
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

// -------------------- MACROS: index + selector --------------------
let MACRO_URL = localStorage.getItem(LS_MACRO_URL_KEY) || DEFAULT_MACRO_URL;
let MACROS_INDEX = null;

function groupLabel(item) {
  const scope = item?.scope || "";
  if (scope === "region" && item.country === "IT") return "Italia — Regioni";
  if (scope === "country") return "Europa+UK — Paesi";
  if (scope === "euuk") return "Europa+UK — Macro";
  return "Altri";
}

function buildMacroSelector(indexJson) {
  // Trova la card sinistra (quella con “Partenza”): è la prima .card dentro .grid
  const grid = document.querySelector(".grid");
  const leftCard = grid?.querySelector(".card");
  if (!leftCard) return;

  // Evita doppio inserimento
  if (document.getElementById("macroSelect")) return;

  const wrap = document.createElement("div");
  wrap.className = "card";
  wrap.style.marginBottom = "12px";

  wrap.innerHTML = `
    <h3>Area / Dataset</h3>
    <div class="small muted" style="margin-top:-6px;">
      Scegli dove cercare (es: EU+UK per vedere tutta Europa + Regno Unito).
    </div>
    <div style="margin-top:10px;">
      <select id="macroSelect"></select>
      <div id="macroInfo" class="small muted" style="margin-top:8px;"></div>
    </div>
  `;

  // Inserisci sopra la card Partenza (prima del leftCard)
  leftCard.parentNode.insertBefore(wrap, leftCard);

  const sel = document.getElementById("macroSelect");
  const info = document.getElementById("macroInfo");

  const items = Array.isArray(indexJson?.items) ? indexJson.items : [];

  // raggruppa in optgroup
  const groups = new Map();
  for (const it of items) {
    const g = groupLabel(it);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }

  // ordine gruppi: macro euuk, it regioni, paesi
  const orderedGroupNames = [
    "Europa+UK — Macro",
    "Italia — Regioni",
    "Europa+UK — Paesi",
    "Altri"
  ].filter(g => groups.has(g));

  for (const gName of orderedGroupNames) {
    const og = document.createElement("optgroup");
    og.label = gName;

    const arr = groups.get(gName) || [];
    // ordina alfabetico
    arr.sort((a, b) => String(a.label || "").localeCompare(String(b.label || ""), "it"));

    for (const it of arr) {
      const opt = document.createElement("option");
      opt.value = it.path;
      opt.textContent = it.label;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }

  // selezione attuale
  sel.value = MACRO_URL;
  if (!sel.value) {
    // se MACRO_URL non è tra le options, fallback ad Abruzzo
    sel.value = DEFAULT_MACRO_URL;
    MACRO_URL = DEFAULT_MACRO_URL;
    localStorage.setItem(LS_MACRO_URL_KEY, MACRO_URL);
  }

  function updateInfo() {
    const chosen = items.find(x => x.path === sel.value);
    if (!chosen) {
      info.textContent = `Dataset: ${sel.value}`;
      return;
    }
    const scope = chosen.scope || "";
    const hint =
      chosen.id === "euuk_macro_all" ? "👉 Questo contiene tutta EU+UK." :
      scope === "region" ? `Regione: ${chosen.region || ""}` :
      scope === "country" ? `Paese: ${chosen.country || ""}` :
      "";
    info.textContent = hint || `Dataset: ${chosen.label}`;
  }

  updateInfo();

  sel.addEventListener("change", async () => {
    try {
      MACRO_URL = sel.value;
      localStorage.setItem(LS_MACRO_URL_KEY, MACRO_URL);

      // ricarica macro
      MACRO = null;
      await loadMacro(true);

      resetRotation(); // quando cambi dataset, resetto rotazione per non “tagliare” risultati
      showStatus("ok", `Dataset cambiato ✅ (${sel.options[sel.selectedIndex].text})`);
      updateInfo();

      // se già hai una partenza, rifai la ricerca al volo
      const o = getOrigin();
      if (o?.lat && o?.lon) runSearch({ silent: true });
    } catch (e) {
      console.error(e);
      showStatus("err", `Errore nel caricamento dataset: ${String(e.message || e)}`);
    }
  });
}

async function loadMacrosIndex() {
  const r = await fetch(MACROS_INDEX_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`macros_index.json non trovato (${r.status})`);
  const j = await r.json();
  MACROS_INDEX = j;
  buildMacroSelector(j);
  return j;
}

// -------------------- DATA loading --------------------
let MACRO = null;

async function loadMacro(silent = false) {
  const r = await fetch(MACRO_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`Macro non trovato (${r.status}) → ${MACRO_URL}`);
  const j = await r.json();
  if (!j?.places || !Array.isArray(j.places)) throw new Error("Macro invalido: manca places[]");
  MACRO = j;

  if (!silent) {
    showStatus("ok", `Dataset caricato ✅ (${j.name || "macro"}) — mete: ${j.places.length}`);
  }
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
    tags.includes("lido") ||
    tags.includes("costa")
  );

  if (cat === "montagna") return (
    type === "montagna" || tags.includes("montagna") || tags.includes("neve") || tags.includes("sci")
  );

  if (cat === "natura") return (
    type === "natura" ||
    tags.includes("natura") ||
    tags.includes("lago") ||
    tags.includes("parco_nazionale") ||
    tags.includes("gole") ||
    tags.includes("cascata") ||
    tags.includes("cascate") ||
    tags.includes("riserva") ||
    tags.includes("trekking")
  );

  if (cat === "storia") return (
    type === "storia" ||
    tags.includes("storia") ||
    tags.includes("castello") ||
    tags.includes("abbazia") ||
    tags.includes("museo") ||
    tags.includes("monumenti") ||
    tags.includes("archeologia")
  );

  if (cat === "relax") return (
    type === "relax" ||
    tags.includes("relax") ||
    tags.includes("terme") ||
    tags.includes("spa") ||
    tags.includes("benessere")
  );

  if (cat === "family") return (
    type === "bambini" ||
    tags.includes("famiglie") ||
    tags.includes("bambini") ||
    tags.includes("family") ||
    tags.includes("animali") ||
    tags.includes("parco_avventura") ||
    tags.includes("acquario") ||
    tags.includes("zoo") ||
    tags.includes("divertimento")
  );

  return true;
}

function matchesStyle(place, { wantChicche, wantClassici }) {
  const vis = String(place.visibility || "").toLowerCase();
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
  if (pid && pid === LAST_SHOWN_PID) pen += 0.24;
  if (SESSION_SEEN.has(pid)) pen += 0.20;
  if (recentSet.has(pid)) pen += 0.14;
  return pen;
}

// -------------------- TIME “SMART” --------------------
function effectiveMaxMinutes(maxMinutes, category) {
  const m = Number(maxMinutes);
  if (!Number.isFinite(m)) return 120;

  // Mare: spesso oltre 60' se sei in interno
  if (category === "mare" && m < 75) return clamp(Math.round(m * 1.35), m, 180);

  // Storia: a 30' può essere poco in alcune zone, allarghiamo leggero
  if (category === "storia" && m <= 35) return clamp(Math.round(m * 1.25), m, 120);

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

    if (!matchesCategory(p, category)) continue;
    if (!matchesStyle(p, styles)) continue;

    const pid = safeIdFromPlace(p);
    if (!ignoreVisited && visited.has(pid)) continue;

    const km = haversineKm(oLat, oLon, lat, lon);
    if (km < 1.2) continue;

    const driveMin = estCarMinutesFromKm(km);
    if (driveMin > target) continue;

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

function pickDestination(origin, maxMinutes, category, styles) {
  let candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: false, ignoreRotation: false });

  if (candidates.length === 0) {
    candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: false, ignoreRotation: true });
  }
  if (candidates.length === 0) {
    candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: true, ignoreRotation: true });
  }

  const chosen = candidates[0] || null;
  const alternatives = candidates.slice(1, 3); // 2 alternative
  return { chosen, alternatives, totalCandidates: candidates.length };
}

// -------------------- RENDER --------------------
function monetBoxHtml(placeName, country = "IT") {
  // bottoni più “cliccabili”: larghi e con min-width
  const btnStyle = `style="flex:1; min-width:160px; justify-content:center;"`;

  return `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Link rapidi (prenota / scopri)</div>

      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn" ${btnStyle} target="_blank" rel="noopener" href="${bookingUrl(placeName, country, BOOKING_AID)}">🏨 Hotel</a>
        <a class="btn" ${btnStyle} target="_blank" rel="noopener" href="${getYourGuideUrl(placeName, GYG_PID)}">🎟️ Tour</a>
        <a class="btn" ${btnStyle} target="_blank" rel="noopener" href="${tiqetsUrl(placeName, TIQETS_PID)}">🏛️ Biglietti</a>
        <a class="btn btn-ghost" ${btnStyle} target="_blank" rel="noopener" href="${amazonEssentialsUrl(AMAZON_TAG)}">🧳 Essenziali</a>
      </div>

      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn btn-ghost" ${btnStyle} target="_blank" rel="noopener" href="${theForkSearchUrl(placeName, THEFORK_AFF)}">🍝 Ristoranti</a>
        <a class="btn btn-ghost" ${btnStyle} target="_blank" rel="noopener" href="${googleThingsToDoUrl(placeName)}">📸 Foto / Cosa fare</a>
      </div>

      <div class="small muted" style="margin-top:8px;">
        Tip: per monetizzare davvero inserisci i tuoi ID in app.js (BOOKING_AID / GYG_PID / TIQETS_PID / AMAZON_TAG).
      </div>
    </div>
  `;
}

function noResultCard(maxMinutesShown, category) {
  const extra = (category === "mare" && Number(maxMinutesShown) < 75)
    ? `Hai scelto <b>Mare</b>: spesso serve più tempo. Prova 90–120 min.`
    : `Prova ad aumentare i minuti o cambiare categoria/stile.`;

  return `
    <div class="card errbox">
      <div class="small">❌ Nessuna meta trovata entro ${maxMinutesShown} min con i filtri attuali.</div>
      <div class="small muted" style="margin-top:6px;">${extra}</div>
      <div class="row wrap gap" style="margin-top:12px;">
        <button class="btn btn-ghost" id="btnResetRotationInline">🧽 Reset “proposte di oggi”</button>
        <button class="btn" id="btnTryAgain">🔁 Riprova</button>
      </div>
    </div>
  `;
}

function renderResult(origin, maxMinutesShown, chosen, alternatives, meta = {}) {
  const area = $("resultArea");
  const category = meta.category || "ovunque";

  if (!chosen) {
    area.innerHTML = noResultCard(maxMinutesShown, category);

    $("btnResetRotationInline")?.addEventListener("click", () => {
      resetRotation();
      showStatus("ok", "Reset fatto ✅ Ora ti ripropongo mete che avevo evitato oggi.");
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
    ? `<ul style="margin:10px 0 0; padding-left:18px; color: var(--muted);">
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
                 style="
                   padding:14px 14px;
                   cursor:pointer;
                   border-color: rgba(0,224,255,.22);
                   background: linear-gradient(180deg, rgba(0,224,255,.06), rgba(255,255,255,.02));
                 ">
              <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
                <div style="flex:1;">
                  <div style="font-weight:850; font-size:17px; line-height:1.2;">
                    ${ap.name} <span class="small muted">(${aBadge})</span>
                  </div>
                  <div class="small muted" style="margin-top:6px;">
                    🚗 ~${a.driveMin} min • ${fmtKm(a.km)} • ${ap.type || "meta"}
                  </div>
                </div>
                <div class="pill" style="white-space:nowrap;">Scegli</div>
              </div>

              <div class="row wrap gap" style="margin-top:12px;">
                <a class="btn btn-ghost" target="_blank" rel="noopener" href="${aPlaceUrl}" onclick="event.stopPropagation()" style="min-width:140px;">📸 Foto</a>
                <a class="btn btn-ghost" target="_blank" rel="noopener" href="${aDirUrl}" onclick="event.stopPropagation()" style="min-width:140px;">🧭 Percorso</a>
                <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleThingsToDoUrl(ap.name)}" onclick="event.stopPropagation()" style="min-width:160px;">🗺️ Cosa fare</a>
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

      <div class="small muted" style="margin-top:8px;">
        Categoria: <b>${p.type || "meta"}</b> • Punteggio: <b>${chosen.score}</b>
        ${category === "mare" && meta.effMax && meta.effMax !== maxMinutesShown ? ` • <span class="muted">(Mare: raggio smart ~${meta.effMax} min)</span>` : ""}
      </div>

      <div class="row wrap gap" style="margin-top:12px;">
        <a class="btn" href="${placeUrl}" target="_blank" rel="noopener" style="min-width:220px;">📸 Foto / Scheda</a>
        <a class="btn btn-ghost" href="${dirUrl}" target="_blank" rel="noopener" style="min-width:220px;">🧭 Percorso</a>
        <a class="btn btn-ghost" href="${googleThingsToDoUrl(p.name)}" target="_blank" rel="noopener" style="min-width:220px;">🗺️ Cosa vedere</a>
      </div>

      ${whyHtml}

      <div class="row wrap gap" style="margin-top:14px;">
        <button class="btn btn-ghost" id="btnVisited">✅ Già visitato</button>
        <button class="btn" id="btnChange">🔁 Cambia meta</button>
        <button class="btn btn-ghost" id="btnResetRotationTop">🧽 Reset “proposte di oggi”</button>
      </div>
    </div>

    ${monetBoxHtml(p.name, country)}
    ${altHtml}
  `;

  // track shown (for rotation)
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

  $("btnResetRotationTop")?.addEventListener("click", () => {
    resetRotation();
    showStatus("ok", "Reset fatto ✅ Ora posso ripescare anche mete già proposte oggi/sessione.");
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
    if (!MACRO) await loadMacro(true);

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

    // forbid immediate specific pid (e.g. “cambia meta”)
    if (forbidPid && chosen?.pid === forbidPid) {
      // rebuild excluding forbid pid
      const recentSet = getRecentSet();
      const visited = getVisitedSet();
      const oLat = Number(origin.lat), oLon = Number(origin.lon);

      const candidates = [];
      for (const p of MACRO.places) {
        const lat = Number(p.lat), lon = Number(p.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const pid = safeIdFromPlace(p);

        if (pid === forbidPid) continue;
        if (visited.has(pid)) continue;
        if (!matchesCategory(p, category)) continue;
        if (!matchesStyle(p, styles)) continue;

        const km = haversineKm(oLat, oLon, lat, lon);
        if (km < 1.2) continue;

        const driveMin = estCarMinutesFromKm(km);
        if (driveMin > effMax) continue;

        const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
        let s = baseScorePlace({ driveMin, targetMin: effMax, beautyScore: p.beauty_score, isChicca });
        s -= rotationPenalty(pid, recentSet);

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
      if (Number.isFinite(Number(o?.lat)) && Number.isFinite(Number(o?.lon))) setOrigin(o);
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

// init chips
initChips("timeChips", { multi: false });
initChips("categoryChips", { multi: false });
initChips("styleChips", { multi: true });

initTimeChipsSync();
restoreOrigin();
bindOriginButtons();
bindMainButtons();

// Load macros index (build selector) + load selected macro
loadMacrosIndex()
  .catch(() => {
    // se index non c’è, vai comunque con default macro
  })
  .finally(async () => {
    try {
      await loadMacro(true);
    } catch (e) {
      console.error(e);
      showStatus("err", `Errore macro: ${String(e.message || e)}`);
    }
  });

hideStatus();
