/* Jamo — Auto-only (offline macro) — v3.2
 * Fix:
 * - Geocoding più robusto (accetta anche "lat,lon", gestisce apostrofi, fallback POST/GET)
 * - Se entro X minuti non trova nulla: fallback soft-cap (fino a +25%) con messaggio chiaro
 * - Alternative: cliccabili (tap -> mostra quella meta come principale)
 * - Alternative: leggibili (stile inline ad alto contrasto)
 * - Chips: toggle single/multi stabile (niente “rimangono premuti entrambi” quando non devono)
 */

const $ = (id) => document.getElementById(id);

// -------------------- SETTINGS --------------------
const MACRO_URL = "/data/macros/it_macro_01_abruzzo.json"; // macro attiva

// car minutes estimator
const ROAD_FACTOR = 1.25;
const AVG_KMH = 72;
const FIXED_OVERHEAD_MIN = 8;

// Monetization placeholders (metti i tuoi ID)
const BOOKING_AID = "";
const AMAZON_TAG  = "";
const GYG_PID     = "";
const TIQETS_PID  = "";

// fallback se non trova entro i minuti richiesti (es: 60min)
const SOFT_CAP_MULTIPLIER = 1.25; // +25% max
const MIN_RESULTS_TARGET = 1;     // basta 1 per dire “ok”
const ALT_COUNT = 2;              // alternative = 2 (come volevi)

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
  return Math.round(clamp(driveMin + FIXED_OVERHEAD_MIN, 10, 600));
}

function fmtKm(km) {
  const n = Math.round(km);
  return `${n} km`;
}

function mapsPlaceUrl(lat, lon) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lon)}`;
}

function mapsDirUrl(oLat, oLon, dLat, dLon) {
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(oLat + "," + oLon)}&destination=${encodeURIComponent(dLat + "," + dLon)}&travelmode=driving`;
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
  const base = `https://www.tiqets.com/it/search/?query=${encodeURIComponent(city)}`;
  return affId ? `${base}&partner=${encodeURIComponent(affId)}` : base;
}
function amazonEssentialsUrl(tag = "") {
  const base = `https://www.amazon.it/s?k=${encodeURIComponent("accessori viaggio")}`;
  return tag ? `${base}&tag=${encodeURIComponent(tag)}` : base;
}

// -------------------- STORAGE: origin + visited --------------------
function setOrigin({ label, lat, lon }) {
  $("originLabel").value = label ?? "";
  $("originLat").value = String(lat);
  $("originLon").value = String(lon);
  localStorage.setItem("jamo_origin", JSON.stringify({ label, lat, lon }));
  $("originStatus").textContent =
    `✅ Partenza impostata: ${label || "posizione"} (${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)})`;
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

// -------------------- UI state (chips) --------------------
function initChips(containerId, { multi = false } = {}) {
  const el = $(containerId);
  if (!el) return;

  el.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;

    if (!multi) {
      // single-select: solo uno attivo
      [...el.querySelectorAll(".chip")].forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
    } else {
      // multi-select: toggle
      chip.classList.toggle("active");
    }

    // sync time chips to input
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
let LAST_PICK = null; // { origin, maxMinutes, category, styles, chosen, alternatives, candidates, usedSoftCap }

async function loadMacro() {
  const r = await fetch(MACRO_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`Macro non trovato (${r.status})`);
  const j = await r.json();
  if (!j?.places || !Array.isArray(j.places)) throw new Error("Macro invalido: manca places[]");
  MACRO = j;
  return j;
}

// -------------------- GEOcoding (robusto) --------------------
function tryParseLatLon(text) {
  // accetta "42.35,13.39" oppure "42.35 13.39"
  const s = String(text || "").trim();
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, label: s };
}

async function geocodeLabel(label) {
  const qRaw = String(label || "").trim();
  if (!qRaw) throw new Error("Inserisci un luogo");

  // se l’utente ha messo direttamente lat/lon, non chiamare l’API
  const parsed = tryParseLatLon(qRaw);
  if (parsed) return parsed;

  // normalizza apostrofi “strani” (mobile)
  const q = qRaw
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  // 1) prova GET (tuo client attuale usa GET)
  try {
    const r1 = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { cache: "no-store" });
    const j1 = await r1.json().catch(() => null);
    if (j1?.ok && j1?.result && Number.isFinite(Number(j1.result.lat)) && Number.isFinite(Number(j1.result.lon))) {
      return { label: j1.result.label || qRaw, lat: Number(j1.result.lat), lon: Number(j1.result.lon) };
    }
  } catch {}

  // 2) fallback POST (se il tuo /api/geocode accetta POST)
  try {
    const r2 = await fetch(`/api/geocode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q })
    });
    const j2 = await r2.json().catch(() => null);
    if (j2?.ok) {
      // supporta sia {ok:true,result:{...}} sia {ok:true,lat,lon}
      const lat = j2?.result?.lat ?? j2?.lat;
      const lon = j2?.result?.lon ?? j2?.lon;
      const lbl = j2?.result?.label ?? j2?.label ?? qRaw;
      if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) {
        return { label: lbl, lat: Number(lat), lon: Number(lon) };
      }
    }
  } catch {}

  throw new Error("Geocoding fallito (prova: 'Città, Regione' oppure 'lat,lon').");
}

// -------------------- FILTERING --------------------
function matchesCategory(place, cat) {
  if (!cat || cat === "ovunque") return true;

  const type = String(place.type || "").toLowerCase();
  const tags = (place.tags || []).map(t => String(t).toLowerCase());

  if (cat === "citta") return type === "citta" || tags.includes("citta");
  if (cat === "borghi") return type === "borgo" || tags.includes("borgo");
  if (cat === "mare") return type === "mare" || tags.includes("mare") || tags.includes("trabocchi") || tags.includes("spiagge");
  if (cat === "montagna") return type === "montagna" || tags.includes("montagna") || tags.includes("neve");
  if (cat === "natura") return type === "natura" || tags.includes("natura") || tags.includes("lago") || tags.includes("parco_nazionale");
  if (cat === "storia") return type === "storia" || tags.includes("storia") || tags.includes("castello") || tags.includes("abbazia");
  if (cat === "relax") return type === "relax" || tags.includes("relax") || tags.includes("terme");
  if (cat === "family") return type === "bambini" || tags.includes("famiglie") || tags.includes("bambini") || tags.includes("family") || tags.includes("animali");

  return true;
}

function matchesStyle(place, { wantChicche, wantClassici }) {
  const vis = String(place.visibility || "").toLowerCase(); // "chicca" | "conosciuta"
  if (!wantChicche && !wantClassici) return true;
  if (vis === "chicca") return !!wantChicche;
  return !!wantClassici;
}

function scorePlace({ driveMin, targetMin, beautyScore, isChicca }) {
  const t = clamp(1 - Math.abs(driveMin - targetMin) / Math.max(25, targetMin * 0.85), 0, 1);
  const b = clamp(Number(beautyScore) || 0.75, 0.4, 1);
  const c = isChicca ? 0.06 : 0;
  return 0.62 * t + 0.34 * b + c;
}

// -------------------- PICK DESTINATION (con soft cap) --------------------
function buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited = false, capMultiplier = 1.0 } = {}) {
  const visited = getVisitedSet();
  const target = Number(maxMinutes);
  const cap = target * capMultiplier;

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
    const driveMin = estCarMinutesFromKm(km);

    // scarta "sei già lì"
    if (km < 1.2) continue;

    // cap (hard) sul capMultiplier (soft cap)
    if (driveMin > cap) continue;

    const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
    const s = scorePlace({ driveMin, targetMin: target, beautyScore: p.beauty_score, isChicca });

    candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
  }

  candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
  return candidates;
}

function pickDestination(origin, maxMinutes, category, styles) {
  // 1) entro target preciso
  let candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: false, capMultiplier: 1.0 });
  let usedSoftCap = false;
  let ignoredVisited = false;

  // 2) se zero -> ignora visited
  if (candidates.length < MIN_RESULTS_TARGET) {
    candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: true, capMultiplier: 1.0 });
    ignoredVisited = true;
  }

  // 3) se ancora pochi -> soft cap (+25%)
  if (candidates.length < MIN_RESULTS_TARGET) {
    candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: true, capMultiplier: SOFT_CAP_MULTIPLIER });
    usedSoftCap = true;
    ignoredVisited = true;
  }

  const chosen = candidates[0] || null;
  const alternatives = candidates.slice(1, 1 + ALT_COUNT);

  return { chosen, alternatives, candidates, usedSoftCap, ignoredVisited };
}

// -------------------- RENDER --------------------
function renderResult(origin, maxMinutes, picked) {
  const area = $("resultArea");
  const { chosen, alternatives, usedSoftCap, ignoredVisited } = picked || {};

  if (!chosen) {
    area.innerHTML = `
      <div class="card errbox">
        <div class="small">❌ Nessuna meta trovata.</div>
        <div class="small muted" style="margin-top:6px;">
          Prova ad aumentare i minuti, oppure cambia categoria/stile.
        </div>
      </div>
    `;
    return;
  }

  const p = chosen.place;
  const pid = chosen.pid;
  const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
  const badge = isChicca ? "✨ chicca" : "✅ classica";

  const placeUrl = mapsPlaceUrl(p.lat, p.lon);
  const dirUrl = mapsDirUrl(origin.lat, origin.lon, p.lat, p.lon);

  const why = Array.isArray(p.why) ? p.why.slice(0, 3) : [];
  const whyHtml = why.length
    ? `<ul style="margin:10px 0 0; padding-left:18px; color: var(--muted);">
         ${why.map(x => `<li>${x}</li>`).join("")}
       </ul>`
    : "";

  const country = p.country || "IT";

  const note = usedSoftCap
    ? `⚠️ Ho sforato di poco il tempo: entro ~${Math.round(maxMinutes * SOFT_CAP_MULTIPLIER)} min per non lasciarti a secco.`
    : ignoredVisited
      ? `ℹ️ Hai segnato tante mete “visitato”: per trovartene una ho ignorato i visitati (puoi fare reset).`
      : "";

  const monetHtml = `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Prenota / Scopri (link monetizzabili)</div>
      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn" target="_blank" rel="noopener" href="${bookingUrl(p.name, country, BOOKING_AID)}">🏨 Hotel</a>
        <a class="btn" target="_blank" rel="noopener" href="${getYourGuideUrl(p.name, GYG_PID)}">🎟️ Tour</a>
        <a class="btn" target="_blank" rel="noopener" href="${tiqetsUrl(p.name, TIQETS_PID)}">🏛️ Attrazioni</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${amazonEssentialsUrl(AMAZON_TAG)}">🧳 Essenziali</a>
      </div>
    </div>
  `;

  const altHtml = (alternatives || []).length ? `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Alternative (cliccabili)</div>
      <div style="margin-top:10px; display:flex; flex-direction:column; gap:10px;">
        ${(alternatives || []).map(a => {
          const ap = a.place;
          const aBadge = String(ap.visibility || "").toLowerCase() === "chicca" ? "✨" : "✅";
          // STILE LEGGIBILE (alto contrasto)
          return `
            <button
              type="button"
              class="btn btn-ghost"
              data-alt-pid="${a.pid}"
              style="
                width:100%;
                justify-content:space-between;
                align-items:flex-start;
                text-align:left;
                padding:14px 14px;
                border-radius:16px;
                border:1px solid rgba(255,255,255,.10);
                background: rgba(255,255,255,.05);
              ">
              <div>
                <div style="font-weight:800; font-size:16px; line-height:1.1; color:#fff;">
                  ${ap.name} <span style="opacity:.85; font-weight:700;">(${aBadge})</span>
                </div>
                <div style="margin-top:6px; font-size:12px; color: rgba(255,255,255,.75);">
                  ~${a.driveMin} min • ${fmtKm(a.km)}
                </div>
              </div>
              <div style="opacity:.75; font-weight:800; padding-left:10px;">›</div>
            </button>
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
      </div>

      ${note ? `<div class="card warnbox" style="margin-top:10px;"><div class="small">${note}</div></div>` : ""}

      <div class="row wrap gap" style="margin-top:12px;">
        <a class="btn" href="${placeUrl}" target="_blank" rel="noopener">📍 Apri su Google Maps</a>
        <a class="btn btn-ghost" href="${dirUrl}" target="_blank" rel="noopener">🧭 Apri percorso</a>
      </div>

      ${whyHtml}

      <div class="row wrap gap" style="margin-top:12px;">
        <button class="btn btn-ghost" id="btnVisited">✅ Già visitato</button>
        <button class="btn" id="btnChange">🔁 Cambia meta</button>
      </div>
    </div>

    ${monetHtml}
    ${altHtml}
  `;

  // buttons
  $("btnVisited")?.addEventListener("click", () => {
    markVisited(pid);
    showStatus("ok", "Segnato come visitato ✅ — La prossima volta ti proporrò un’altra meta.");
  });

  $("btnChange")?.addEventListener("click", () => {
    runSearch({ silent: true, forceDifferentFrom: pid });
  });

  // alternative click
  [...area.querySelectorAll("[data-alt-pid]")].forEach((btn) => {
    btn.addEventListener("click", () => {
      const altPid = btn.getAttribute("data-alt-pid");
      if (!altPid || !LAST_PICK?.candidates?.length) return;
      const found = LAST_PICK.candidates.find(x => x.pid === altPid);
      if (!found) return;

      // promuovi alternativa a scelta principale senza ricalcolare tutto
      const newChosen = found;
      const rest = LAST_PICK.candidates.filter(x => x.pid !== altPid);
      const newAlternatives = rest.slice(0, ALT_COUNT);

      const nextPick = {
        ...LAST_PICK,
        chosen: newChosen,
        alternatives: newAlternatives
      };
      LAST_PICK = nextPick;
      renderResult(LAST_PICK.origin, LAST_PICK.maxMinutes, LAST_PICK);
      showStatus("ok", `Meta cambiata ✅ (${newChosen.place.name})`);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

// -------------------- MAIN SEARCH --------------------
async function runSearch({ silent = false, forceDifferentFrom = null } = {}) {
  try {
    if (!silent) hideStatus();
    if (!MACRO) await loadMacro();

    const origin = getOrigin();
    if (!origin || !Number.isFinite(Number(origin.lat)) || !Number.isFinite(Number(origin.lon))) {
      showStatus("err", "Imposta una partenza: GPS oppure scrivi un luogo e premi “Usa questo luogo”.");
      return;
    }

    const maxMinutes = clamp(Number($("maxMinutes").value) || 120, 10, 600);
    const category = getActiveCategory();
    const styles = getActiveStyles();

    let picked = pickDestination(origin, maxMinutes, category, styles);

    // forzare “diversa”
    if (forceDifferentFrom && picked?.chosen?.pid === forceDifferentFrom) {
      const filtered = picked.candidates.filter(x => x.pid !== forceDifferentFrom);
      picked = {
        ...picked,
        chosen: filtered[0] || null,
        alternatives: filtered.slice(1, 1 + ALT_COUNT),
        candidates: filtered
      };
    }

    LAST_PICK = { origin, maxMinutes, category, styles, ...picked };

    renderResult(origin, maxMinutes, LAST_PICK);

    if (!LAST_PICK.chosen) {
      showStatus("warn", `Nessuna meta trovata. Prova ad aumentare i minuti o cambiare filtri.`);
    } else if (!silent) {
      const capInfo = LAST_PICK.usedSoftCap ? ` (soft-cap attivo)` : ``;
      showStatus("ok", `Meta trovata ✅ (~${LAST_PICK.chosen.driveMin} min in auto)${capInfo}`);
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
      if (o?.lat && o?.lon) setOrigin(o);
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
        showStatus("err", "GPS non disponibile. Prova a scrivere un luogo e usare “Usa questo luogo”.");
      },
      { enableHighAccuracy: true, timeout: 12000 }
    );
  });

  $("btnFindPlace")?.addEventListener("click", async () => {
    try {
      const label = ($("originLabel").value || "").trim();
      if (!label) throw new Error("Scrivi un luogo (es: “Pescara” o “Roma, Lazio” o “42.35, 13.39”).");

      $("originStatus").textContent = "🔎 Cerco il luogo…";
      const result = await geocodeLabel(label);

      setOrigin({ label: result.label || label, lat: result.lat, lon: result.lon });
      showStatus("ok", "Partenza impostata dal luogo ✅");
    } catch (e) {
      console.error(e);
      $("originStatus").textContent = `❌ ${String(e.message || e)}`;
      showStatus("err", `Geocoding fallito: ${String(e.message || e)}`);
    }
  });

  // comodità: Enter nel campo -> geocode
  $("originLabel")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("btnFindPlace")?.click();
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

// preload macro
loadMacro().catch(() => {});
hideStatus();
