/* Jamo — Auto-only (offline macro) — app.js v3.3
 * FIX principali:
 * ✅ “Geocoding fallito” risolto: prova GET /api/geocode?q= e fallback POST {q}
 * ✅ Categoria “MARE” molto più intelligente (città di mare, costa, riserve, trabocchi, spiagge…)
 * ✅ Alternative cliccabili (diventano la meta principale)
 * ✅ Alternative = 2 (come vuoi tu)
 * ✅ Reset ricerca (pulisce risultato + status, non tocca visitati)
 */

const $ = (id) => document.getElementById(id);

// -------------------- SETTINGS --------------------
const MACRO_URL = "/data/macros/it_macro_01_abruzzo.json";

// speed model (car): estimate "drive minutes" from haversine distance
const ROAD_FACTOR = 1.25;
const AVG_KMH = 72;
const FIXED_OVERHEAD_MIN = 8;

// monetization placeholders (fill with your IDs)
const BOOKING_AID = "";
const AMAZON_TAG  = "";
const GYG_PID     = "";
const TIQETS_PID  = "";

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

// -------------------- GEOcoding (FIX) --------------------
async function geocodeLabel(label) {
  const q = String(label || "").trim();
  if (!q) throw new Error("Inserisci un luogo");

  // 1) prova GET classico: /api/geocode?q=
  try {
    const r1 = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { method: "GET" });
    const j1 = await r1.json().catch(() => null);
    if (r1.ok && j1?.ok && j1?.result && Number.isFinite(+j1.result.lat) && Number.isFinite(+j1.result.lon)) {
      return j1.result; // {label, lat, lon}
    }
    // alcuni endpoint rispondono {ok:true, lat, lon, label}
    if (r1.ok && j1?.ok && Number.isFinite(+j1.lat) && Number.isFinite(+j1.lon)) {
      return { label: j1.label || q, lat: +j1.lat, lon: +j1.lon };
    }
  } catch {}

  // 2) fallback POST: /api/geocode {q}
  const r2 = await fetch(`/api/geocode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q })
  });

  const j2 = await r2.json().catch(() => null);
  if (!r2.ok) throw new Error(j2?.error || "Geocoding fallito");

  if (j2?.ok && j2?.result && Number.isFinite(+j2.result.lat) && Number.isFinite(+j2.result.lon)) {
    return j2.result;
  }
  if (j2?.ok && Number.isFinite(+j2.lat) && Number.isFinite(+j2.lon)) {
    return { label: j2.label || q, lat: +j2.lat, lon: +j2.lon };
  }

  throw new Error(j2?.error || "Geocoding fallito (risposta non valida)");
}

// -------------------- SCORING & FILTERING --------------------
function matchesCategory(place, cat) {
  if (!cat || cat === "ovunque") return true;

  const type = String(place.type || "").toLowerCase();
  const tags = (place.tags || []).map(t => String(t).toLowerCase());

  const hasAnyTag = (...xs) => xs.some(x => tags.includes(x));

  if (cat === "citta") return type === "citta" || tags.includes("citta");
  if (cat === "borghi") return type === "borgo" || tags.includes("borgo");

  // ✅ FIX MARE: include città costiere, natura costiera, trabocchi, riserve, spiagge
  if (cat === "mare") {
    const isCoastalType = (type === "mare");
    const coastalTags =
      hasAnyTag("mare","spiagge","costa","litorale","trabocchi","riserva","baia","scogliera","promontorio","faro","porto");
    const coastalCity =
      (type === "citta" || tags.includes("citta")) &&
      hasAnyTag("mare","spiagge","costa","litorale","porto","trabocchi");
    const coastalNature =
      (type === "natura") && hasAnyTag("mare","spiagge","costa","litorale","riserva","baia","scogliera");

    // fallback “dintorni mare”: a volte taggati panorama/relax ma sono costa
    const trabocchiHint = hasAnyTag("trabocchi");
    return isCoastalType || coastalTags || coastalCity || coastalNature || trabocchiHint;
  }

  if (cat === "montagna") return type === "montagna" || hasAnyTag("montagna","neve","altopiano");
  if (cat === "natura") return type === "natura" || hasAnyTag("natura","lago","parco_nazionale","riserva","gole","cascata","bosco");
  if (cat === "storia") return type === "storia" || hasAnyTag("storia","castello","abbazia","fortezza","archeologia","museo","eremo");
  if (cat === "relax") return type === "relax" || hasAnyTag("relax","terme","spa","benessere");

  if (cat === "family") {
    return (
      type === "bambini" ||
      hasAnyTag("famiglie","bambini","family","animali","parco_nazionale","spiagge","lago","facile","passeggiata")
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

function scorePlace({ driveMin, targetMin, beautyScore, isChicca }) {
  const t = clamp(1 - Math.abs(driveMin - targetMin) / Math.max(25, targetMin * 0.85), 0, 1);
  const b = clamp(Number(beautyScore) || 0.75, 0.4, 1);
  const c = isChicca ? 0.06 : 0;
  return 0.62 * t + 0.34 * b + c;
}

// -------------------- PICK DESTINATION --------------------
function collectCandidates(origin, maxMinutes, category, styles, visitedOverrideSet = null) {
  const visited = visitedOverrideSet || getVisitedSet();
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
    if (visited.has(pid)) continue;

    const km = haversineKm(oLat, oLon, lat, lon);
    const driveMin = estCarMinutesFromKm(km);
    if (driveMin > target) continue;

    const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
    const s = scorePlace({
      driveMin,
      targetMin: target,
      beautyScore: p.beauty_score,
      isChicca
    });

    candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
  }

  candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
  return candidates;
}

function pickDestination(origin, maxMinutes, category, styles) {
  // prima: escludi visitati
  let candidates = collectCandidates(origin, maxMinutes, category, styles, null);

  // fallback: se zero, ignora visitati
  if (candidates.length === 0) {
    candidates = collectCandidates(origin, maxMinutes, category, styles, new Set());
  }

  const chosen = candidates[0] || null;
  const alternatives = candidates.slice(1, 3); // ✅ 2 alternative
  return { chosen, alternatives, totalCandidates: candidates.length };
}

// -------------------- RENDER --------------------
function renderResult(origin, maxMinutes, chosen, alternatives) {
  const area = $("resultArea");

  if (!chosen) {
    area.innerHTML = `
      <div class="card errbox">
        <div class="small">❌ Nessuna meta trovata entro ${maxMinutes} min con i filtri attuali.</div>
        <div class="small muted" style="margin-top:6px;">Prova ad aumentare i minuti, oppure cambia categoria/stile.</div>
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

  const cityForLinks = p.name;
  const country = p.country || "IT";

  const monetHtml = `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Prenota / Scopri (link monetizzabili)</div>
      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn" target="_blank" rel="noopener" href="${bookingUrl(cityForLinks, country, BOOKING_AID)}">🏨 Hotel</a>
        <a class="btn" target="_blank" rel="noopener" href="${getYourGuideUrl(cityForLinks, GYG_PID)}">🎟️ Tour</a>
        <a class="btn" target="_blank" rel="noopener" href="${tiqetsUrl(cityForLinks, TIQETS_PID)}">🏛️ Attrazioni</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${amazonEssentialsUrl(AMAZON_TAG)}">🧳 Essenziali</a>
      </div>
    </div>
  `;

  const altHtml = (alternatives || []).length ? `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Alternative (cliccabili)</div>
      <div style="margin-top:10px; display:flex; flex-direction:column; gap:8px;">
        ${(alternatives || []).map(a => {
          const ap = a.place;
          const aBadge = String(ap.visibility || "").toLowerCase() === "chicca" ? "✨" : "✅";
          return `
            <button class="card altBtn" data-pid="${a.pid}" style="padding:10px 12px; text-align:left; cursor:pointer;">
              <div style="font-weight:750;">${ap.name} <span class="small muted">(${aBadge})</span></div>
              <div class="small muted">~${a.driveMin} min • ${fmtKm(a.km)}</div>
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

      <div class="row wrap gap" style="margin-top:12px;">
        <a class="btn" href="${placeUrl}" target="_blank" rel="noopener">Apri su Google Maps</a>
        <a class="btn btn-ghost" href="${dirUrl}" target="_blank" rel="noopener">Apri percorso</a>
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

  // ✅ alternative clickable => diventano la meta principale
  area.querySelectorAll(".altBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const apid = btn.dataset.pid;
      if (!apid) return;
      // ricalcola e rendi quella la scelta principale
      runSearch({ silent: true, forcePickPid: apid });
    });
  });
}

// -------------------- MAIN SEARCH --------------------
async function runSearch({ silent = false, forceDifferentFrom = null, forcePickPid = null } = {}) {
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

    // candidates
    let candidates = collectCandidates(origin, maxMinutes, category, styles, null);

    if (candidates.length === 0) {
      candidates = collectCandidates(origin, maxMinutes, category, styles, new Set());
    }

    // forceDifferentFrom: escludi quel pid per questo run
    if (forceDifferentFrom) {
      candidates = candidates.filter(c => c.pid !== forceDifferentFrom);
    }

    // forcePickPid: porta in testa quel pid (se esiste)
    if (forcePickPid) {
      const idx = candidates.findIndex(c => c.pid === forcePickPid);
      if (idx >= 0) {
        const picked = candidates.splice(idx, 1)[0];
        candidates.unshift(picked);
      }
    }

    const chosen = candidates[0] || null;
    const alternatives = candidates.slice(1, 3); // ✅ 2 alternative

    renderResult(origin, maxMinutes, chosen, alternatives);

    if (!chosen) {
      showStatus("warn", `Nessuna meta entro ${maxMinutes} min con i filtri attuali. Prova ad aumentare i minuti o cambiare filtri.`);
    } else if (!silent) {
      showStatus("ok", `Meta trovata ✅ (~${chosen.driveMin} min in auto)`);
    }
  } catch (e) {
    console.error(e);
    showStatus("err", `Errore: ${String(e.message || e)}`);
  }
}

// -------------------- RESET SEARCH (UI) --------------------
function resetSearchUI() {
  hideStatus();
  $("resultArea").innerHTML = "";
  $("originStatus").textContent = "";
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
      if (Number.isFinite(+o?.lat) && Number.isFinite(+o?.lon)) setOrigin(o);
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
      const label = $("originLabel").value;
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

  // se l’utente modifica lat/lon manualmente, aggiorna localStorage (best effort)
  const syncManual = () => {
    const lat = Number($("originLat").value);
    const lon = Number($("originLon").value);
    const label = ($("originLabel").value || "").trim();
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      localStorage.setItem("jamo_origin", JSON.stringify({ label, lat, lon }));
      $("originStatus").textContent = `✅ Partenza manuale: ${label || "coordinate"} (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
    }
  };
  $("originLat")?.addEventListener("change", syncManual);
  $("originLon")?.addEventListener("change", syncManual);
}

function bindMainButtons() {
  $("btnFind")?.addEventListener("click", () => runSearch());
  $("btnResetVisited")?.addEventListener("click", () => {
    resetVisited();
    showStatus("ok", "Visitati resettati ✅");
  });

  // reset ricerca con ESC
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") resetSearchUI();
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

// preload macro (non blocca UI)
loadMacro().catch(() => {});

// default
hideStatus();
