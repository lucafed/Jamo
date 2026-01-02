/* Jamo — Auto-only (offline macro) — app.js v3.2
 * FIX:
 * - geocode robusto (GET + POST fallback, supporta diversi formati risposta)
 * - risultati sempre “nuovi” (exclude recenti oltre a visited)
 * - fallback soft se 0 risultati entro minuti (fino a +20%)
 * - alternative cliccabili + leggibili (azioni: scegli / maps / percorso)
 */

const $ = (id) => document.getElementById(id);

// -------------------- SETTINGS --------------------
const MACRO_URL = "/data/macros/it_macro_01_abruzzo.json";

// stima auto (offline)
const ROAD_FACTOR = 1.22;       // un filo meno severo → più risultati a 60 min
const AVG_KMH = 72;
const FIXED_OVERHEAD_MIN = 8;

// “nuovi risultati”
const RECENT_MAX = 18;          // quante mete recenti evitare
const SOFT_FALLBACK_MULT = 1.2; // se non trova nulla, prova fino a +20%

// monetization placeholders
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

function fmtKm(km) { return `${Math.round(km)} km`; }

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

function getRecentList() {
  const raw = localStorage.getItem("jamo_recent");
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch { return []; }
}
function pushRecent(placeId) {
  const pid = String(placeId);
  const arr = getRecentList().filter(x => x !== pid);
  arr.unshift(pid);
  localStorage.setItem("jamo_recent", JSON.stringify(arr.slice(0, RECENT_MAX)));
}
function resetVisitedAndRecent() {
  localStorage.removeItem("jamo_visited");
  localStorage.removeItem("jamo_recent");
}

// -------------------- UI state (chips) --------------------
function initChips(containerId, { multi = false } = {}) {
  const el = $(containerId);
  if (!el) return;

  el.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;

    // evita “rimane premuto” su mobile (tap doppio)
    e.preventDefault();

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
  }, { passive: false });
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

// -------------------- GEOcoding (robusto) --------------------
function normalizeGeocodeResponse(j, fallbackLabel) {
  // accetta:
  // A) { ok:true, result:{ lat, lon, label } }
  // B) { ok:true, lat, lon, label }
  // C) { ok:true, result:{ ... }, lat, lon } (misto)
  if (!j || !j.ok) return null;

  const r = j.result || j;
  const lat = Number(r.lat);
  const lon = Number(r.lon ?? r.lng);
  const label = String(r.label || j.label || fallbackLabel || "").trim();

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, label: label || fallbackLabel || "Partenza" };
}

async function geocodeLabel(label) {
  const q = String(label || "").trim();
  if (!q) throw new Error("Inserisci un luogo");

  // 1) prova GET
  try {
    const r1 = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { method: "GET" });
    const j1 = await r1.json().catch(() => null);
    const out1 = normalizeGeocodeResponse(j1, q);
    if (r1.ok && out1) return out1;
  } catch {}

  // 2) fallback POST
  const r2 = await fetch(`/api/geocode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q })
  });
  const j2 = await r2.json().catch(() => null);
  const out2 = normalizeGeocodeResponse(j2, q);
  if (r2.ok && out2) return out2;

  const errMsg = (j2 && (j2.error || j2.message)) ? String(j2.error || j2.message) : "Geocoding fallito";
  throw new Error(errMsg);
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
    tags.includes("mare") || tags.includes("trabocchi") || tags.includes("spiagge") ||
    tags.includes("spiaggia") || tags.includes("baia") || tags.includes("riserva")
  );
  if (cat === "montagna") return type === "montagna" || tags.includes("montagna") || tags.includes("neve");
  if (cat === "natura") return type === "natura" || tags.includes("natura") || tags.includes("lago") || tags.includes("parco_nazionale") || tags.includes("riserva");
  if (cat === "storia") return type === "storia" || tags.includes("storia") || tags.includes("castello") || tags.includes("abbazia") || tags.includes("museo");
  if (cat === "relax") return type === "relax" || tags.includes("relax") || tags.includes("terme") || tags.includes("spa");
  if (cat === "family") return (
    type === "bambini" ||
    tags.includes("famiglie") || tags.includes("bambini") || tags.includes("family") ||
    tags.includes("parco_avventura") || tags.includes("zoo") || tags.includes("animali") ||
    tags.includes("spiagge") || tags.includes("lago") || tags.includes("parco_nazionale")
  );

  return true;
}

function matchesStyle(place, { wantChicche, wantClassici }) {
  const vis = String(place.visibility || "").toLowerCase();
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

// -------------------- PICK DESTINATION (evita ripetizioni) --------------------
function buildCandidates(origin, maxMinutes, category, styles, { softCapMult = 1.0 } = {}) {
  const visited = getVisitedSet();
  const recent = new Set(getRecentList());

  const target = Number(maxMinutes) * Number(softCapMult);
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

    // evita ripetizioni
    if (visited.has(pid)) continue;
    if (recent.has(pid)) continue;

    const km = haversineKm(oLat, oLon, lat, lon);
    const driveMin = estCarMinutesFromKm(km);

    if (driveMin > target) continue;

    const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
    const s = scorePlace({ driveMin, targetMin: Number(maxMinutes), beautyScore: p.beauty_score, isChicca });

    candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
  }

  candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
  return candidates;
}

function pickDestination(origin, maxMinutes, category, styles) {
  // 1) normale
  let candidates = buildCandidates(origin, maxMinutes, category, styles, { softCapMult: 1.0 });

  // 2) fallback soft se zero
  let usedSoftFallback = false;
  if (candidates.length === 0) {
    candidates = buildCandidates(origin, maxMinutes, category, styles, { softCapMult: SOFT_FALLBACK_MULT });
    usedSoftFallback = candidates.length > 0;
  }

  // 3) ultimo fallback: ignora “recent” ma rispetta “visited”
  if (candidates.length === 0) {
    const visited = getVisitedSet();
    const target = Number(maxMinutes) * SOFT_FALLBACK_MULT;
    const oLat = Number(origin.lat), oLon = Number(origin.lon);

    for (const p of MACRO.places) {
      const lat = Number(p.lat), lon = Number(p.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (!matchesCategory(p, category)) continue;
      if (!matchesStyle(p, styles)) continue;

      const pid = safeIdFromPlace(p);
      if (visited.has(pid)) continue;

      const km = haversineKm(oLat, oLon, lat, lon);
      const driveMin = estCarMinutesFromKm(km);
      if (driveMin > target) continue;

      const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
      const s = scorePlace({ driveMin, targetMin: Number(maxMinutes), beautyScore: p.beauty_score, isChicca });

      candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
    }

    candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
    usedSoftFallback = candidates.length > 0;
  }

  const chosen = candidates[0] || null;
  const alternatives = candidates.slice(1, 3); // due alternative
  return { chosen, alternatives, totalCandidates: candidates.length, usedSoftFallback };
}

// -------------------- RENDER --------------------
function renderAlternatives(origin, alternatives) {
  if (!alternatives || !alternatives.length) return "";

  const html = alternatives.map((a, idx) => {
    const p = a.place;
    const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
    const badge = isChicca ? "✨" : "✅";
    const placeUrl = mapsPlaceUrl(p.lat, p.lon);
    const dirUrl = mapsDirUrl(origin.lat, origin.lon, p.lat, p.lon);

    // card cliccabile + bottoni
    return `
      <div class="card altCard" data-alt-idx="${idx}" style="padding:12px;">
        <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
          <div>
            <div style="font-weight:800; font-size:16px; line-height:1.2;">
              ${p.name} <span class="small muted">(${badge})</span>
            </div>
            <div class="small muted" style="margin-top:6px;">
              ~${a.driveMin} min • ${fmtKm(a.km)} • ${p.type || "meta"}
            </div>
          </div>
          <button class="btn btn-ghost altPickBtn" data-alt-idx="${idx}" type="button">Scegli</button>
        </div>

        <div class="row wrap gap" style="margin-top:10px;">
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${placeUrl}">Maps</a>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${dirUrl}">Percorso</a>
        </div>
      </div>
    `;
  }).join("");

  return `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Alternative (toccane una)</div>
      <div style="margin-top:10px; display:flex; flex-direction:column; gap:10px;">
        ${html}
      </div>
    </div>
  `;
}

function renderResult(origin, maxMinutes, chosen, alternatives, usedSoftFallback) {
  const area = $("resultArea");

  if (!chosen) {
    area.innerHTML = `
      <div class="card errbox">
        <div class="small">❌ Nessuna meta trovata entro ${maxMinutes} min con i filtri attuali.</div>
        <div class="small muted" style="margin-top:6px;">Prova ad aumentare i minuti oppure cambia categoria/stile.</div>
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

  const why = Array.isArray(p.why) ? p.why.slice(0, 4) : [];
  const whyHtml = why.length
    ? `<ul style="margin:10px 0 0; padding-left:18px; color: var(--muted);">
         ${why.map(x => `<li>${x}</li>`).join("")}
       </ul>`
    : "";

  const country = p.country || "IT";
  const cityForLinks = p.name;

  const monetHtml = `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Prenota / Scopri (link monetizzabili)</div>
      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn" target="_blank" rel="noopener" href="${bookingUrl(cityForLinks, country, BOOKING_AID)}">🏨 Hotel</a>
        <a class="btn" target="_blank" rel="noopener" href="${getYourGuideUrl(cityForLinks, GYG_PID)}">🎟️ Tour</a>
        <a class="btn" target="_blank" rel="noopener" href="${tiqetsUrl(cityForLinks, TIQETS_PID)}">🏛️ Attrazioni</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${amazonEssentialsUrl(AMAZON_TAG)}">🧳 Essenziali</a>
      </div>
      <div class="small muted" style="margin-top:8px;">
        (Inserisci i tuoi ID affiliato in app.js: BOOKING_AID / GYG_PID / TIQETS_PID / AMAZON_TAG)
      </div>
    </div>
  `;

  const fallbackNote = usedSoftFallback
    ? `<div class="small muted" style="margin-top:8px;">⚠️ Nota: ho allargato leggermente la soglia per trovarti qualcosa (fino a ~${Math.round(maxMinutes * SOFT_FALLBACK_MULT)} min stimati).</div>`
    : "";

  area.innerHTML = `
    <div class="card okbox">
      <div class="pill">🚗 auto • ~${chosen.driveMin} min • ${fmtKm(chosen.km)} • ${badge}</div>
      <div class="resultTitle">${p.name}</div>
      <div class="small muted" style="margin-top:6px;">
        Categoria: <b>${p.type || "meta"}</b> • Punteggio: <b>${chosen.score}</b>
      </div>
      ${fallbackNote}

      <div class="row wrap gap" style="margin-top:12px;">
        <a class="btn" href="${placeUrl}" target="_blank" rel="noopener">Apri su Google Maps</a>
        <a class="btn btn-ghost" href="${dirUrl}" target="_blank" rel="noopener">Apri percorso</a>
      </div>

      ${whyHtml}

      <div class="row wrap gap" style="margin-top:12px;">
        <button class="btn btn-ghost" id="btnVisited" type="button">✅ Già visitato</button>
        <button class="btn" id="btnChange" type="button">🔁 Cambia meta</button>
      </div>
    </div>

    ${monetHtml}
    ${renderAlternatives(origin, alternatives)}
  `;

  // segna come “mostrato di recente” (così la prossima ricerca cambia)
  pushRecent(pid);

  // buttons
  $("btnVisited")?.addEventListener("click", () => {
    markVisited(pid);
    showStatus("ok", "Segnato come visitato ✅ — La prossima volta ti proporrò un’altra meta.");
  });

  $("btnChange")?.addEventListener("click", () => {
    runSearch({ silent: true });
  });

  // alternative: scegli
  area.querySelectorAll(".altPickBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.altIdx);
      const alt = (alternatives || [])[idx];
      if (!alt) return;
      // renderizza l’alternativa come principale
      renderResult(origin, maxMinutes, alt, alternatives.filter((_, i) => i !== idx), false);
      showStatus("ok", "Ok ✅ Hai scelto un’alternativa.");
    });
  });

  // card cliccabile (tap ovunque sulla card → scegli)
  area.querySelectorAll(".altCard").forEach(card => {
    card.addEventListener("click", (e) => {
      // se clicchi su link/bottone, non forzare choose
      const a = e.target.closest("a,button");
      if (a) return;
      const idx = Number(card.dataset.altIdx);
      const alt = (alternatives || [])[idx];
      if (!alt) return;
      renderResult(origin, maxMinutes, alt, alternatives.filter((_, i) => i !== idx), false);
      showStatus("ok", "Ok ✅ Hai scelto un’alternativa.");
    });
  });
}

// -------------------- MAIN SEARCH --------------------
async function runSearch({ silent = false } = {}) {
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

    const { chosen, alternatives, usedSoftFallback } = pickDestination(origin, maxMinutes, category, styles);

    renderResult(origin, maxMinutes, chosen, alternatives, usedSoftFallback);

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
}

function bindMainButtons() {
  $("btnFind")?.addEventListener("click", () => runSearch());

  $("btnResetVisited")?.addEventListener("click", () => {
    resetVisitedAndRecent();
    showStatus("ok", "Reset fatto ✅ (visitati + recenti). Ora ti proporrà mete nuove.");
    $("resultArea").innerHTML = "";
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

// default
hideStatus();
