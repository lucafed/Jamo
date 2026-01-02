/* Jamo — Auto-only (offline macro) — v3.2
 * Fixes:
 * - "Geocoding fallito": robust handling + retries + accepts "lat,lon" direct input
 * - "Sempre mete nuove": rotates suggestions using a per-filter "seen" pool in localStorage
 * - Alternative cliccabili: tap an alternative to set it as main result
 * - Better results at low minutes: soft fallback (up to +15%) if no matches
 */

const $ = (id) => document.getElementById(id);

// -------------------- SETTINGS --------------------
const MACRO_URL = "/data/macros/it_macro_01_abruzzo.json";

// Driving estimate (simple + stable)
const ROAD_FACTOR = 1.18;
const AVG_KMH = 78;
const FIXED_OVERHEAD_MIN = 6;

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
  return Math.round(clamp(driveMin + FIXED_OVERHEAD_MIN, 8, 600));
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

// -------------------- STORAGE: origin + visited + seen-rotation --------------------
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
function saveVisitedSet(set) { localStorage.setItem("jamo_visited", JSON.stringify([...set])); }
function markVisited(placeId) { const s = getVisitedSet(); s.add(placeId); saveVisitedSet(s); }
function resetVisited() { localStorage.removeItem("jamo_visited"); }

// Seen rotation key: depends on category + styles + minutes bucket (so it rotates within that context)
function seenKey({ category, styles, maxMinutes }) {
  const chic = styles.wantChicche ? "1" : "0";
  const clas = styles.wantClassici ? "1" : "0";
  // bucket minutes to avoid exploding keys (30-min buckets)
  const b = Math.round(clamp(maxMinutes,10,600) / 30) * 30;
  return `jamo_seen_v1_${category}_${chic}${clas}_${b}`;
}
function getSeenSet(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return new Set();
  try { return new Set(JSON.parse(raw) || []); } catch { return new Set(); }
}
function saveSeenSet(key, set) {
  // keep it bounded
  const arr = [...set].slice(-800);
  localStorage.setItem(key, JSON.stringify(arr));
}
function resetSeenForCurrentFilters() {
  const maxMinutes = Number($("maxMinutes").value) || 120;
  const category = getActiveCategory();
  const styles = getActiveStyles();
  localStorage.removeItem(seenKey({ category, styles, maxMinutes }));
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
  // accepts "42.35, 13.39" or "42.35 13.39"
  const m = String(text || "").trim().match(/(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { label: `${lat}, ${lon}`, lat, lon };
}

async function geocodeLabel(label) {
  const q = String(label || "").trim();
  if (!q) throw new Error("Inserisci un luogo");

  // direct lat/lon shortcut
  const parsed = tryParseLatLon(q);
  if (parsed) return parsed;

  // 2 tries (sometimes mobile network hiccups)
  let lastErr = null;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));

      // Accept both shapes:
      // A) { ok:true, result:{label,lat,lon} }
      // B) { ok:true, lat, lon, label }
      if (j?.ok && j?.result && Number.isFinite(Number(j.result.lat)) && Number.isFinite(Number(j.result.lon))) {
        return { label: j.result.label || q, lat: Number(j.result.lat), lon: Number(j.result.lon) };
      }
      if (j?.ok && Number.isFinite(Number(j.lat)) && Number.isFinite(Number(j.lon))) {
        return { label: j.label || q, lat: Number(j.lat), lon: Number(j.lon) };
      }

      throw new Error(j?.error || "Geocoding fallito");
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 250));
    }
  }
  throw lastErr || new Error("Geocoding fallito");
}

// -------------------- FILTERING --------------------
function matchesCategory(place, cat) {
  if (!cat || cat === "ovunque") return true;

  const type = String(place.type || "").toLowerCase();
  const tags = (place.tags || []).map(t => String(t).toLowerCase());

  if (cat === "citta") return type === "citta" || tags.includes("citta");
  if (cat === "borghi") return type === "borgo" || tags.includes("borgo");
  if (cat === "mare") {
    return (
      type === "mare" ||
      tags.includes("mare") ||
      tags.includes("spiagge") ||
      tags.includes("spiaggia") ||
      tags.includes("trabocchi") ||
      tags.includes("costa") ||
      tags.includes("lido") ||
      tags.includes("marina")
    );
  }
  if (cat === "montagna") return type === "montagna" || tags.includes("montagna") || tags.includes("neve");
  if (cat === "natura") return type === "natura" || tags.includes("natura") || tags.includes("lago") || tags.includes("parco_nazionale") || tags.includes("fiume") || tags.includes("cascata");
  if (cat === "storia") return type === "storia" || tags.includes("storia") || tags.includes("castello") || tags.includes("abbazia") || tags.includes("archeologia");
  if (cat === "relax") return type === "relax" || tags.includes("relax") || tags.includes("terme");
  if (cat === "family") return type === "bambini" || tags.includes("famiglie") || tags.includes("bambini") || tags.includes("family") || tags.includes("attivita") || tags.includes("animali");

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

// Choose one among top-N with weights (and rotate)
function weightedPickTop(cands, topN = 18) {
  const pool = cands.slice(0, Math.min(topN, cands.length));
  const weights = pool.map((c, i) => Math.max(0.01, c.score * (1 - i * 0.03)));
  const sum = weights.reduce((a,b)=>a+b,0);
  let r = Math.random() * sum;
  for (let i=0;i<pool.length;i++){
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[0];
}

// -------------------- PICK DESTINATION --------------------
function buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited=false, ignoreSeen=false } = {}) {
  const visited = getVisitedSet();
  const oLat = Number(origin.lat);
  const oLon = Number(origin.lon);
  const target = Number(maxMinutes);

  const key = seenKey({ category, styles, maxMinutes: target });
  const seen = getSeenSet(key);

  const candidates = [];

  for (const p of MACRO.places) {
    const lat = Number(p.lat);
    const lon = Number(p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    if (!matchesCategory(p, category)) continue;
    if (!matchesStyle(p, styles)) continue;

    const pid = safeIdFromPlace(p);
    if (!ignoreVisited && visited.has(pid)) continue;
    if (!ignoreSeen && seen.has(pid)) continue;

    const km = haversineKm(oLat, oLon, lat, lon);
    const driveMin = estCarMinutesFromKm(km);

    // soft cap: first try <= target, later caller may allow +15%
    if (driveMin > target) continue;

    const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
    const s = scorePlace({ driveMin, targetMin: target, beautyScore: p.beauty_score, isChicca });

    candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
  }

  candidates.sort((a,b)=> (b.score-a.score) || (a.driveMin-b.driveMin));
  return { candidates, key };
}

function pickDestination(origin, maxMinutes, category, styles) {
  // 1) strict: within minutes, not visited, not seen
  let { candidates, key } = buildCandidates(origin, maxMinutes, category, styles);
  let usedSoftCap = false;

  // 2) if none, allow +15% soft cap (still respects visited/seen)
  if (candidates.length === 0) {
    const soft = Math.round(maxMinutes * 1.15);
    usedSoftCap = true;
    const r = buildCandidates(origin, soft, category, styles);
    candidates = r.candidates; key = r.key;
  }

  // 3) if still none, ignore seen (but keep visited)
  if (candidates.length === 0) {
    const r = buildCandidates(origin, maxMinutes, category, styles, { ignoreSeen:true });
    candidates = r.candidates; key = r.key;
  }

  // 4) if still none, ignore visited too (last resort)
  if (candidates.length === 0) {
    const r = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited:true, ignoreSeen:true });
    candidates = r.candidates; key = r.key;
  }

  if (candidates.length === 0) return { chosen:null, alternatives:[], key, usedSoftCap };

  // pick = weighted among top 18 to avoid always same #1
  const chosen = weightedPickTop(candidates, 18);

  // alternatives = next best excluding chosen (take 2)
  const alternatives = candidates.filter(c => c.pid !== chosen.pid).slice(0, 2);

  // mark chosen as seen for this filter context
  const seen = getSeenSet(key);
  seen.add(chosen.pid);
  saveSeenSet(key, seen);

  return { chosen, alternatives, key, usedSoftCap };
}

// -------------------- RENDER --------------------
function renderResult(origin, maxMinutes, chosen, alternatives, usedSoftCap) {
  const area = $("resultArea");
  if (!chosen) {
    area.innerHTML = `
      <div class="card errbox">
        <div class="small">❌ Nessuna meta trovata entro ${maxMinutes} min con i filtri attuali.</div>
        <div class="small muted" style="margin-top:6px;">Prova ad aumentare i minuti o cambiare categoria/stile.</div>
      </div>`;
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

  const monetHtml = `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Prenota / Scopri (link monetizzabili)</div>
      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn" target="_blank" rel="noopener" href="${bookingUrl(p.name, country, BOOKING_AID)}">🏨 Hotel</a>
        <a class="btn" target="_blank" rel="noopener" href="${getYourGuideUrl(p.name, GYG_PID)}">🎟️ Tour</a>
        <a class="btn" target="_blank" rel="noopener" href="${tiqetsUrl(p.name, TIQETS_PID)}">🏛️ Attrazioni</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${amazonEssentialsUrl(AMAZON_TAG)}">🧳 Essenziali</a>
      </div>
    </div>`;

  const altHtml = (alternatives || []).length ? `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Alternative (cliccabili)</div>
      <div style="margin-top:10px; display:flex; flex-direction:column; gap:8px;">
        ${(alternatives || []).map(a => {
          const ap = a.place;
          const aBadge = String(ap.visibility || "").toLowerCase() === "chicca" ? "✨" : "✅";
          return `
            <button class="card altbtn" data-pid="${a.pid}" style="padding:12px 12px; text-align:left; cursor:pointer;">
              <div style="font-weight:800; font-size:16px; line-height:1.25;">${ap.name} <span class="small muted">(${aBadge})</span></div>
              <div class="small muted">~${a.driveMin} min • ${fmtKm(a.km)}</div>
            </button>`;
        }).join("")}
      </div>
    </div>` : "";

  const softNote = usedSoftCap
    ? `<div class="small muted" style="margin-top:8px;">Nota: ho allargato leggermente il tempo (+15%) perché non c'erano mete nel limite esatto.</div>`
    : "";

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

      ${softNote}
      ${whyHtml}

      <div class="row wrap gap" style="margin-top:12px;">
        <button class="btn btn-ghost" id="btnVisited">✅ Già visitato</button>
        <button class="btn" id="btnChange">🔁 Cambia meta</button>
      </div>
    </div>

    ${monetHtml}
    ${altHtml}
  `;

  $("btnVisited")?.addEventListener("click", () => {
    markVisited(pid);
    showStatus("ok", "Segnato come visitato ✅ — La prossima volta ti proporrò un’altra meta.");
  });

  $("btnChange")?.addEventListener("click", () => runSearch({ silent: true }));

  // alternative click = promote
  area.querySelectorAll(".altbtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const pid2 = btn.getAttribute("data-pid");
      const alt = (alternatives || []).find(x => x.pid === pid2);
      if (!alt) return;

      const maxMinutes = clamp(Number($("maxMinutes").value) || 120, 10, 600);
      const category = getActiveCategory();
      const styles = getActiveStyles();
      const key = seenKey({ category, styles, maxMinutes });
      const seen = getSeenSet(key);
      seen.add(pid2);
      saveSeenSet(key, seen);

      renderResult(origin, maxMinutes, alt, alternatives.filter(x=>x.pid!==pid2), false);
      showStatus("ok", "Meta selezionata ✅");
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

    const { chosen, alternatives, usedSoftCap } = pickDestination(origin, maxMinutes, category, styles);
    renderResult(origin, maxMinutes, chosen, alternatives, usedSoftCap);

    if (!chosen) {
      showStatus("warn", `Nessuna meta entro ${maxMinutes} min con i filtri attuali.`);
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
    resetVisited();
    showStatus("ok", "Visitati resettati ✅");
  });

  // Optional: long-press reset "seen" rotation for current filters
  $("btnResetVisited")?.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    resetSeenForCurrentFilters();
    showStatus("ok", "Rotazione mete resettata ✅ (filtri attuali)");
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

loadMacro().catch(() => {});
hideStatus();
