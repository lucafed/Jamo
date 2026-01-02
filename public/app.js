/* Jamo — Auto-only (offline macro) — app.js v3.3 (FULL)
 * - Origin: GPS or manual (geocode via /api/geocode?q=) with robust fallback
 * - Picks destinations from macro places based on:
 *   time (maxMinutes), category, style (chicche/classici), rotation (not repeating)
 * - Outputs: result card + 2 alternatives (clickable) + maps links + REAL monetization blocks
 */

const $ = (id) => document.getElementById(id);

// -------------------- SETTINGS --------------------
const MACRO_URL = "/data/macros/it_macro_01_abruzzo.json";

// driving estimator (offline)
const ROAD_FACTOR = 1.25;
const AVG_KMH = 72;
const FIXED_OVERHEAD_MIN = 8;

// ROTATION
const RECENT_TTL_MS = 1000 * 60 * 60 * 20; // ~20h “oggi”
const RECENT_MAX = 160;                    // aumentato
let SESSION_SEEN = new Set();
let LAST_SHOWN_PID = null;
let LAST_SHOWN_NAMEKEY = null;

// -------------------- AFFILIATE CONFIG (METTI QUI I TUOI ID) --------------------
// Se lasci vuoto, il link funziona ma NON traccia.
const AFF = {
  bookingAid: "",        // Booking.com: aid=...
  amazonTag: "",         // Amazon Associates tag: ...-21
  gygPartnerId: "",      // GetYourGuide: partner_id=...
  tiqetsPartner: "",     // Tiqets: partner=...

  // Extra super-monetizzabili anche per mete vicine (opzionali):
  esimUrl: "",           // tuo affiliate link eSIM (Airalo/Holafly ecc.)
  insuranceUrl: "",      // tuo affiliate link assicurazione (Awin/CJ ecc.)
  carRentalUrl: ""       // tuo affiliate link noleggio auto (DiscoverCars/Rentalcars ecc.)
};

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

// -------------------- MONETIZATION URLS --------------------
function bookingUrl(city, countryCode, aid = "") {
  const q = `${city}${countryCode ? ", " + countryCode : ""}`;
  const base = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(q)}`;
  return aid ? `${base}&aid=${encodeURIComponent(aid)}` : base;
}

function getYourGuideUrl(city, partnerId = "") {
  const base = `https://www.getyourguide.com/s/?q=${encodeURIComponent(city)}`;
  return partnerId ? `${base}&partner_id=${encodeURIComponent(partnerId)}` : base;
}

function tiqetsUrl(city, partner = "") {
  const base = `https://www.tiqets.com/it/search/?query=${encodeURIComponent(city)}`;
  return partner ? `${base}&partner=${encodeURIComponent(partner)}` : base;
}

function amazonEssentialsUrl(tag = "", query = "accessori viaggio") {
  const base = `https://www.amazon.it/s?k=${encodeURIComponent(query)}`;
  return tag ? `${base}&tag=${encodeURIComponent(tag)}` : base;
}

function externalUrlOrFallback(url, fallback) {
  const u = String(url || "").trim();
  return u ? u : fallback;
}

// Small client-side event logger (optional; useful later for analytics)
function track(event, payload = {}) {
  try {
    const key = "jamo_events";
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    arr.unshift({ event, payload, ts: Date.now() });
    localStorage.setItem(key, JSON.stringify(arr.slice(0, 250)));
  } catch {}
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

function addRecent(pid, nameKey = "") {
  const t = Date.now();
  let list = cleanupRecent(loadRecent());
  list.unshift({ pid, nameKey, ts: t });
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

function getRecentNameKeySet() {
  const list = cleanupRecent(loadRecent());
  return new Set(list.map(x => x.nameKey).filter(Boolean));
}

function resetRotation() {
  localStorage.removeItem("jamo_recent");
  SESSION_SEEN = new Set();
  LAST_SHOWN_PID = null;
  LAST_SHOWN_NAMEKEY = null;
}

// -------------------- UI (chips + status) --------------------
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

    // UX: evita “rimane premuto” su mobile (toglie focus)
    chip.blur?.();
    document.activeElement?.blur?.();
  }, { passive: true });
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

// -------------------- DATA --------------------
let MACRO = null;

async function loadMacro() {
  const r = await fetch(MACRO_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`Macro non trovato (${r.status})`);
  const j = await r.json();
  if (!j?.places || !Array.isArray(j.places)) throw new Error("Macro invalido: manca places[]");
  MACRO = j;
  return j;
}

// -------------------- GEOCODING (ROBUST) --------------------
async function fetchWithTimeout(url, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r;
  } finally {
    clearTimeout(t);
  }
}

function pickCandidateUI(candidates) {
  // mini chooser (prompt) - semplice e stabile
  // ritorna indice scelto o -1
  const lines = candidates.map((c, i) => `${i + 1}) ${c.label}`).join("\n");
  const ans = window.prompt(
    `Ho trovato più risultati. Scrivi il numero giusto:\n\n${lines}\n\n(Annulla per uscire)`
  );
  const n = Number(String(ans || "").trim());
  if (!Number.isFinite(n) || n < 1 || n > candidates.length) return -1;
  return n - 1;
}

async function geocodeLabel(label) {
  let q = String(label || "").trim();
  if (!q) throw new Error("Scrivi un luogo (es: L'Aquila, Roma, Via Roma 10)");

  // 1) prova normale
  const url1 = `/api/geocode?q=${encodeURIComponent(q)}`;
  let r = await fetchWithTimeout(url1, 9000);
  let j = await r.json().catch(() => null);

  // 2) se fallisce, prova aggiungendo “Italia”
  if (!j || !j.ok) {
    const q2 = q.toLowerCase().includes("italia") ? q : `${q}, Italia`;
    const url2 = `/api/geocode?q=${encodeURIComponent(q2)}`;
    r = await fetchWithTimeout(url2, 9000);
    j = await r.json().catch(() => null);
  }

  // 3) se ancora nulla, prova “semplificazione” (togli parole tipo stazione/terminale)
  if (!j || !j.ok) {
    const simplified = q
      .replace(/stazione|termini|aeroporto|porto|centro|piazza|via|viale/ig, "")
      .replace(/\s+/g, " ")
      .trim();
    if (simplified && simplified.length >= 2 && simplified !== q) {
      const url3 = `/api/geocode?q=${encodeURIComponent(simplified + ", Italia")}`;
      r = await fetchWithTimeout(url3, 9000);
      j = await r.json().catch(() => null);
    }
  }

  if (!j) throw new Error("Geocoding fallito (risposta vuota)");
  if (!j.ok) throw new Error(j.error || "Geocoding fallito");

  // se ci sono candidates, per sicurezza (a volte best è “strano”)
  if (Array.isArray(j.candidates) && j.candidates.length >= 2) {
    // se il primo è molto diverso dalla query, fai scegliere
    const qn = normName(q);
    const best = j.result;
    const bestn = normName(best?.label || "");
    const suspicious = (qn.length >= 4 && bestn && !bestn.includes(qn.split(" ")[0]));
    if (suspicious) {
      const idx = pickCandidateUI(j.candidates);
      if (idx >= 0) return j.candidates[idx];
    }
  }

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
  if (cat === "storia") return type === "storia" || tags.includes("storia") || tags.includes("castello") || tags.includes("abbazia") || tags.includes("museo");
  if (cat === "relax") return type === "relax" || tags.includes("relax") || tags.includes("terme") || tags.includes("spa");
  if (cat === "family") return (
    type === "bambini" ||
    tags.includes("famiglie") ||
    tags.includes("bambini") ||
    tags.includes("family") ||
    tags.includes("animali") ||
    tags.includes("parco_avventura") ||
    tags.includes("luna_park") ||
    tags.includes("acquario") ||
    tags.includes("attivita") ||
    tags.includes("attività")
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

// rotation penalty: avoid repeats today/session + “similar consecutive”
function rotationPenalty(pid, nameKey, recentSet, recentNameKeys) {
  let pen = 0;
  if (pid && pid === LAST_SHOWN_PID) pen += 0.28;
  if (SESSION_SEEN.has(pid)) pen += 0.22;
  if (recentSet.has(pid)) pen += 0.14;

  // evita mete “simili” (stesso nome key) consecutive o “oggi”
  if (nameKey && nameKey === LAST_SHOWN_NAMEKEY) pen += 0.14;
  if (nameKey && recentNameKeys.has(nameKey)) pen += 0.06;

  return pen;
}

// -------------------- TIME SMART --------------------
function effectiveMaxMinutes(maxMinutes, category) {
  const m = Number(maxMinutes);
  if (!Number.isFinite(m)) return 120;

  // Mare: spesso serve un filo più di tempo (ma senza esagerare)
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
  const recentNameKeys = getRecentNameKeySet();

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
    const nameKey = normName(p.name);

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

    if (!ignoreRotation) {
      s = s - rotationPenalty(pid, nameKey, recentSet, recentNameKeys);
    }

    candidates.push({ place: p, pid, nameKey, km, driveMin, score: Number(s.toFixed(4)) });
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

// -------------------- MONETIZATION BLOCK (SMART) --------------------
function monetBoxHtml(place, category, country = "IT") {
  const placeName = place?.name || "Abruzzo";
  const tags = (place?.tags || []).map(x => String(x).toLowerCase());

  // query Amazon “smart”
  let amazonQ = "accessori viaggio";
  if (category === "mare" || tags.includes("mare") || tags.includes("spiagge")) amazonQ = "accessori mare spiaggia";
  if (category === "montagna" || tags.includes("montagna") || tags.includes("trekking")) amazonQ = "trekking zaino bastoncini";
  if (category === "family" || tags.includes("bambini") || tags.includes("famiglie")) amazonQ = "giochi da viaggio bambini";
  if (category === "relax" || tags.includes("terme") || tags.includes("spa")) amazonQ = "accappatoio spa ciabatte";

  const booking = bookingUrl(placeName, country, AFF.bookingAid);
  const gyg = getYourGuideUrl(placeName, AFF.gygPartnerId);
  const tiq = tiqetsUrl(placeName, AFF.tiqetsPartner);
  const ama = amazonEssentialsUrl(AFF.amazonTag, amazonQ);

  // extra (anche per mete vicine)
  const esim = externalUrlOrFallback(AFF.esimUrl, "");
  const ins = externalUrlOrFallback(AFF.insuranceUrl, "");
  const car = externalUrlOrFallback(AFF.carRentalUrl, "");

  const extraBtns = [
    esim ? `<a class="btn btn-ghost" target="_blank" rel="noopener" href="${esim}" data-track="esim">📶 eSIM</a>` : "",
    ins ? `<a class="btn btn-ghost" target="_blank" rel="noopener" href="${ins}" data-track="insurance">🛡️ Assicurazione</a>` : "",
    car ? `<a class="btn btn-ghost" target="_blank" rel="noopener" href="${car}" data-track="carrental">🚗 Noleggio</a>` : "",
  ].filter(Boolean).join("");

  // hint monet: se non hai inserito ID, mostra un warning leggero
  const missing =
    (!AFF.bookingAid && !AFF.gygPartnerId && !AFF.tiqetsPartner && !AFF.amazonTag && !AFF.esimUrl && !AFF.insuranceUrl && !AFF.carRentalUrl);

  return `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Prenota / Scopri (link monetizzabili)</div>

      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn" target="_blank" rel="noopener" href="${booking}" data-track="booking">🏨 Hotel</a>
        <a class="btn" target="_blank" rel="noopener" href="${gyg}" data-track="gyg">🎟️ Tour</a>
        <a class="btn" target="_blank" rel="noopener" href="${tiq}" data-track="tiqets">🏛️ Attrazioni</a>
        <a class="btn btn-ghost" target="_blank" rel="noopener" href="${ama}" data-track="amazon">🧳 Essenziali</a>
        ${extraBtns}
      </div>

      ${missing ? `<div class="small muted" style="margin-top:10px;">
        ⚠️ Per monetizzare davvero devi inserire gli ID affiliato in <b>AFF</b> (in cima a app.js).
      </div>` : ``}
    </div>
  `;
}

function bindMonetTracking(container, placeName) {
  // Traccia click monet (locale)
  [...container.querySelectorAll("[data-track]")].forEach(a => {
    a.addEventListener("click", () => {
      track("monet_click", { provider: a.getAttribute("data-track"), place: placeName });
    }, { passive: true });
  });
}

// -------------------- RENDER --------------------
function renderResult(origin, maxMinutesShown, chosen, alternatives, meta = {}) {
  const area = $("resultArea");
  const category = meta.category || "ovunque";

  if (!chosen) {
    const extra = (category === "mare" && Number(maxMinutesShown) < 75)
      ? `Hai scelto <b>Mare</b>: spesso serve più tempo. Prova 90–120 min.`
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
      resetRotation();
      showStatus("ok", "Reset fatto ✅ Ora ti ripropongo mete che avevo evitato oggi.");
    });
    return;
  }

  const p = chosen.place;
  const pid = chosen.pid;
  const nameKey = chosen.nameKey || normName(p.name);

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
      <div class="small muted">Alternative (clicca per scegliere)</div>
      <div style="margin-top:10px; display:flex; flex-direction:column; gap:10px;">
        ${(alternatives || []).map(a => {
          const ap = a.place;
          const aPid = a.pid;
          const aIsChicca = String(ap.visibility || "").toLowerCase() === "chicca";
          const aBadge = aIsChicca ? "✨" : "✅";
          const aPlaceUrl = mapsPlaceUrl(ap.lat, ap.lon);
          const aDirUrl = mapsDirUrl(origin.lat, origin.lon, ap.lat, ap.lon);

          return `
            <div class="card" data-alt="1" data-pid="${aPid}"
                 style="padding:12px 12px; cursor:pointer; border-color: rgba(255,255,255,.14);">
              <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
                <div>
                  <div style="font-weight:850; font-size:16px; line-height:1.2;">
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
        <a class="btn" href="${placeUrl}" target="_blank" rel="noopener">Apri su Google Maps</a>
        <a class="btn btn-ghost" href="${dirUrl}" target="_blank" rel="noopener">Apri percorso</a>
      </div>

      ${whyHtml}

      <div class="row wrap gap" style="margin-top:12px;">
        <button class="btn btn-ghost" id="btnVisited">✅ Già visitato</button>
        <button class="btn" id="btnChange">🔁 Cambia meta</button>
        <button class="btn btn-ghost" id="btnResetRotation">🧽 Reset “proposte di oggi”</button>
      </div>
    </div>

    ${monetBoxHtml(p, category, country)}
    ${altHtml}
  `;

  // rotation memory
  LAST_SHOWN_PID = pid;
  LAST_SHOWN_NAMEKEY = nameKey;
  SESSION_SEEN.add(pid);
  addRecent(pid, nameKey);

  // buttons
  $("btnVisited")?.addEventListener("click", () => {
    markVisited(pid);
    showStatus("ok", "Segnato come visitato ✅ (non te lo ripropongo più).");
  });

  $("btnChange")?.addEventListener("click", () => {
    runSearch({ silent: true, forbidPid: pid });
  });

  $("btnResetRotation")?.addEventListener("click", () => {
    resetRotation();
    showStatus("ok", "Reset fatto ✅ Ora posso ripescare anche mete già proposte oggi/sessione.");
  });

  // alternative click -> render as chosen
  [...area.querySelectorAll('[data-alt="1"][data-pid]')].forEach((el) => {
    el.addEventListener("click", () => {
      const pid2 = el.getAttribute("data-pid");
      const alt = (alternatives || []).find(x => x.pid === pid2);
      if (!alt) return;

      track("choose_alternative", { from: pid, to: pid2 });

      LAST_SHOWN_PID = pid2;
      LAST_SHOWN_NAMEKEY = alt.nameKey || normName(alt.place?.name);
      SESSION_SEEN.add(pid2);
      addRecent(pid2, LAST_SHOWN_NAMEKEY);

      const remaining = (alternatives || []).filter(x => x.pid !== pid2);
      const newAlternatives = [
        { place: chosen.place, pid: chosen.pid, nameKey: chosen.nameKey, km: chosen.km, driveMin: chosen.driveMin, score: chosen.score },
        ...remaining
      ].slice(0, 2);

      renderResult(origin, maxMinutesShown, alt, newAlternatives, meta);
      showStatus("ok", "Ok ✅ Ho scelto l’alternativa.");
    });
  });

  // bind monet tracking
  bindMonetTracking(area, p.name);
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

    // forbid immediate specific pid (“cambia meta”)
    if (forbidPid && chosen?.pid === forbidPid) {
      const visited = getVisitedSet();
      const recentSet = getRecentSet();
      const recentNameKeys = getRecentNameKeySet();
      const target = effMax;

      const candidates = [];
      const oLat = Number(origin.lat), oLon = Number(origin.lon);

      for (const p of MACRO.places) {
        const lat = Number(p.lat), lon = Number(p.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        if (!matchesCategory(p, category)) continue;
        if (!matchesStyle(p, styles)) continue;

        const pid = safeIdFromPlace(p);
        const nameKey = normName(p.name);
        if (pid === forbidPid) continue;
        if (visited.has(pid)) continue;

        const km = haversineKm(oLat, oLon, lat, lon);
        const driveMin = estCarMinutesFromKm(km);
        if (driveMin > target) continue;
        if (km < 1.2) continue;

        const isChicca = String(p.visibility || "").toLowerCase() === "chicca";
        let s = baseScorePlace({ driveMin, targetMin: target, beautyScore: p.beauty_score, isChicca });
        s = s - rotationPenalty(pid, nameKey, recentSet, recentNameKeys);

        candidates.push({ place: p, pid, nameKey, km, driveMin, score: Number(s.toFixed(4)) });
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

// -------------------- RESET SEARCH (NEW) --------------------
function resetSearchUI() {
  // reset chips to defaults (best-effort)
  const resetSingle = (id, keepIndex = 0) => {
    const el = $(id);
    if (!el) return;
    const chips = [...el.querySelectorAll(".chip")];
    chips.forEach(c => c.classList.remove("active"));
    if (chips[keepIndex]) chips[keepIndex].classList.add("active");
  };

  resetSingle("categoryChips", 0); // ovunque
  // style: chicche+classici attivi
  const style = $("styleChips");
  if (style) [...style.querySelectorAll(".chip")].forEach(c => c.classList.add("active"));

  $("maxMinutes").value = "120";
  const time = $("timeChips");
  if (time) {
    [...time.querySelectorAll(".chip")].forEach(c => c.classList.remove("active"));
    const match = [...time.querySelectorAll(".chip")].find(c => Number(c.dataset.min) === 120);
    if (match) match.classList.add("active");
  }

  $("resultArea").innerHTML = `<div class="small muted">Premi “TROVAMI LA META” per vedere una proposta.</div>`;
  hideStatus();
  track("reset_search");
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
        track("origin_set_gps", { lat: Number(lat.toFixed(4)), lon: Number(lon.toFixed(4)) });
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
      track("origin_set_text", { q: label, label: result.label || label });
    } catch (e) {
      console.error(e);
      $("originStatus").textContent = `❌ ${String(e.message || e)}`;
      showStatus("err", `Geocoding fallito: ${String(e.message || e)}`);
    }
  });
}

function bindMainButtons() {
  $("btnFind")?.addEventListener("click", () => {
    track("search");
    runSearch();
  });

  $("btnResetVisited")?.addEventListener("click", () => {
    resetVisited();
    showStatus("ok", "Visitati resettati ✅");
    track("reset_visited");
  });

  // se vuoi aggiungere un bottone reset ricerca in index.html:
  // <button id="btnResetSearch" class="btn btn-ghost">🧼 Reset ricerca</button>
  $("btnResetSearch")?.addEventListener("click", () => resetSearchUI());
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
