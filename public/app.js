/* Jamo — Auto-only (offline macro) — app.js v3.3
 * - Origin: GPS or manual (geocode via /api/geocode?q=)
 * - Picks destinations from macro places based on:
 *   time (maxMinutes), category, style (chicche/classici), rotation (not repeating)
 * - Outputs: result card + 2 alternatives (clickable) + maps links + quick info links + monetization links
 */

const $ = (id) => document.getElementById(id);

// -------------------- SETTINGS --------------------
const MACRO_URL = "/data/macros/it_macro_01_abruzzo.json";

// driving estimator (offline)
const ROAD_FACTOR = 1.25;
const AVG_KMH = 72;
const FIXED_OVERHEAD_MIN = 8;

// ROTATION
const RECENT_TTL_MS = 1000 * 60 * 60 * 20; // ~20h: “oggi”
const RECENT_MAX = 120;                    // quante mete ricordare “oggi”
let SESSION_SEEN = new Set();              // in-memory (sessione)
let LAST_SHOWN_PID = null;

// ---- QUALITY GATE ----
// Se vuoi SOLO mete wow, alza:
const MIN_BEAUTY_DEFAULT = 0.78;

// Se minuti molto bassi: alziamo la qualità (meno mete “meh”)
function minBeautyForMinutes(m) {
  if (m <= 45) return 0.83;
  if (m <= 60) return 0.81;
  return MIN_BEAUTY_DEFAULT;
}

// --- Hard filters: mai proporre roba non turistica ---
const BAD_NAME_PATTERNS = [
  "nucleo industriale",
  "zona industriale",
  "area industriale",
  "industriale",
  "interporto",
  "scalo",
  "stazione",
  "autostrada",
  "casello",
  "uscita",
  "svincolo",
  "centro commerciale",
  "parcheggio",
  "iper",
  "outlet",
  "deposito",
  "capannone",
  "ospedale",
  "clinica",
  "cimitero",
];

function isBadPlaceName(name) {
  const n = normName(name);
  return BAD_NAME_PATTERNS.some(p => n.includes(p));
}

// Monetization placeholders (fill with your IDs)
const BOOKING_AID = ""; // Booking affiliate id (aid)
const AMAZON_TAG  = ""; // Amazon tag
const GYG_PID     = ""; // GetYourGuide partner_id
const TIQETS_PID  = ""; // Tiqets partner (se ce l'hai)

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

function cleanPlaceQuery(name) {
  // Rende la query più “search-friendly” per GYG/Tiqets/Booking
  let q = String(name || "").trim();

  // rimuove emoji e simboli strani
  q = q.replace(/[^\p{L}\p{N}\s,'’-]/gu, " ");

  // se c'è “( ... )” prendi solo prima parte
  q = q.replace(/\s*\(.*?\)\s*/g, " ").trim();

  // se ha “—” o “ - ” prendi prima parte
  q = q.split("—")[0].split(" - ")[0].trim();

  // normalizza spazi
  q = q.replace(/\s+/g, " ").trim();

  return q;
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

// Quick info links
function googleSearchUrl(q) {
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}
function googleImagesUrl(q) {
  return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`;
}
function mapsRestaurantsUrl(placeName) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("ristoranti " + placeName)}`;
}
function wikiSearchUrl(q) {
  return `https://it.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`;
}
function whatsappShareUrl(text) {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

// Monetization URLs
function bookingUrl(city, countryCode, affId = "") {
  const q = `${city}${countryCode ? ", " + countryCode : ""}`;
  const base = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(q)}`;
  return affId ? `${base}&aid=${encodeURIComponent(affId)}` : base;
}

function getYourGuideUrl(city, affId = "") {
  // Ricerca robusta (non deep-link fragile)
  const base = `https://www.getyourguide.com/s/?q=${encodeURIComponent(city)}`;
  return affId ? `${base}&partner_id=${encodeURIComponent(affId)}` : base;
}

function tiqetsUrl(city, affId = "") {
  // Ricerca robusta (evita 404)
  const base = `https://www.tiqets.com/it/search/?query=${encodeURIComponent(city)}`;
  return affId ? `${base}&partner=${encodeURIComponent(affId)}` : base;
}

function amazonEssentialsUrl(tag = "") {
  const base = `https://www.amazon.it/s?k=${encodeURIComponent("accessori viaggio auto gita")}`;
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
function matchesCategory(place, cat) {
  if (!cat || cat === "ovunque") return true;

  const type = String(place.type || "").toLowerCase();
  const tagsRaw = (place.tags || []).map(t => String(t));
  const tags = tagsRaw.map(t => normName(t)); // normalizzati

  // helper "tag contains"
  const hasTag = (x) => tags.includes(normName(x));

  if (cat === "citta") return type === "citta" || hasTag("citta") || hasTag("città");
  if (cat === "borghi") return type === "borgo" || hasTag("borgo");

  if (cat === "mare") return (
    type === "mare" ||
    hasTag("mare") ||
    hasTag("trabocchi") ||
    hasTag("spiagge") ||
    hasTag("spiaggia") ||
    hasTag("lido")
  );

  if (cat === "montagna") return type === "montagna" || hasTag("montagna") || hasTag("neve");

  if (cat === "natura") return (
    type === "natura" ||
    hasTag("natura") ||
    hasTag("lago") ||
    hasTag("parco nazionale") ||
    hasTag("parco_nazionale") ||
    hasTag("gole") ||
    hasTag("cascata") ||
    hasTag("cascate") ||
    hasTag("riserva")
  );

  // ✅ FIX STORIA: più robusto (anche se mancano tag nel macro)
  if (cat === "storia") {
    const n = normName(place.name);
    return (
      type === "storia" ||
      hasTag("storia") ||
      hasTag("arte") ||
      hasTag("monumenti") ||
      hasTag("museo") ||
      hasTag("castello") ||
      hasTag("abbazia") ||
      hasTag("cattedrale") ||
      hasTag("santuario") ||
      n.includes("castello") ||
      n.includes("abbazia") ||
      n.includes("basilica") ||
      n.includes("duomo") ||
      n.includes("museo") ||
      n.includes("anfiteatro") ||
      n.includes("teatro romano") ||
      n.includes("tempio")
    );
  }

  if (cat === "relax") return type === "relax" || hasTag("relax") || hasTag("terme") || hasTag("spa");

  if (cat === "family") return (
    type === "bambini" ||
    hasTag("famiglie") ||
    hasTag("famiglia") ||
    hasTag("bambini") ||
    hasTag("family") ||
    hasTag("animali") ||
    hasTag("parco avventura") ||
    hasTag("parco_avventura") ||
    hasTag("luna park") ||
    hasTag("luna_park") ||
    hasTag("acquario")
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
  const b = clamp(Number(beautyScore) || 0.75, 0.4, 1);
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

// -------------------- PICK DESTINATION (with rotation + quality gate) --------------------
function buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited = false, ignoreRotation = false } = {}) {
  const visited = getVisitedSet();
  const recentSet = getRecentSet();

  const target = Number(maxMinutes);
  const oLat = Number(origin.lat);
  const oLon = Number(origin.lon);

  const beautyMin = minBeautyForMinutes(target);

  const candidates = [];

  for (const p of MACRO.places) {
    const lat = Number(p.lat);
    const lon = Number(p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    // ✅ blocca mete non turistiche
    if (isBadPlaceName(p.name)) continue;

    // ✅ soglia qualità
    const beauty = Number(p.beauty_score);
    if (Number.isFinite(beauty) && beauty < beautyMin) continue;

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
  // 1) normale: visita esclusa + rotazione attiva
  let candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: false, ignoreRotation: false });

  // 2) se zero: ignora rotazione (ma non i visitati)
  if (candidates.length === 0) {
    candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: false, ignoreRotation: true });
  }

  // 3) se ancora zero: ignora anche visited (ultima spiaggia)
  if (candidates.length === 0) {
    candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: true, ignoreRotation: true });
  }

  const chosen = candidates[0] || null;
  const alternatives = candidates.slice(1, 3); // 2 alternative
  return { chosen, alternatives, totalCandidates: candidates.length };
}

// -------------------- RENDER HELPERS --------------------
function btnStylePrimary() {
  // Bottoni più “cliccabili” su mobile
  return `style="min-height:48px; padding:12px 14px; border-radius:16px; flex:1; min-width:150px;"`;
}
function btnStyleGhost() {
  return `style="min-height:48px; padding:12px 14px; border-radius:16px; flex:1; min-width:150px;"`;
}

function quickLinksHtml(placeName, country = "IT") {
  const q = cleanPlaceQuery(placeName);
  const title = `${q}${country ? ", " + country : ""}`;

  const linkFoto = googleImagesUrl(`${q} foto`);
  const linkVedere = googleSearchUrl(`cosa vedere a ${q}`);
  const linkFare = googleSearchUrl(`cosa fare a ${q}`);
  const linkRisto = mapsRestaurantsUrl(q);
  const linkWiki = wikiSearchUrl(q);

  const share = whatsappShareUrl(`Jamo mi ha proposto: ${title}. Idee: cosa vedere/cosa fare, foto e ristoranti:\n- Foto: ${linkFoto}\n- Cosa vedere: ${linkVedere}\n- Cosa fare: ${linkFare}\n- Ristoranti: ${linkRisto}`);

  return `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Info rapide (aprile subito)</div>
      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn" ${btnStylePrimary()} target="_blank" rel="noopener" href="${linkVedere}">👀 Cosa vedere</a>
        <a class="btn" ${btnStylePrimary()} target="_blank" rel="noopener" href="${linkFare}">🎯 Cosa fare</a>
        <a class="btn btn-ghost" ${btnStyleGhost()} target="_blank" rel="noopener" href="${linkFoto}">📸 Foto</a>
        <a class="btn btn-ghost" ${btnStyleGhost()} target="_blank" rel="noopener" href="${linkRisto}">🍝 Ristoranti</a>
        <a class="btn btn-ghost" ${btnStyleGhost()} target="_blank" rel="noopener" href="${linkWiki}">📚 Wiki</a>
        <a class="btn btn-ghost" ${btnStyleGhost()} target="_blank" rel="noopener" href="${share}">💬 WhatsApp</a>
      </div>
    </div>
  `;
}

function monetBoxHtml(placeName, country = "IT") {
  const q = cleanPlaceQuery(placeName);

  return `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Prenota / Scopri (monetizzazione)</div>
      <div class="row wrap gap" style="margin-top:10px;">
        <a class="btn" ${btnStylePrimary()} target="_blank" rel="noopener" href="${bookingUrl(q, country, BOOKING_AID)}">🏨 Hotel</a>
        <a class="btn" ${btnStylePrimary()} target="_blank" rel="noopener" href="${getYourGuideUrl(q, GYG_PID)}">🎟️ Tour</a>
        <a class="btn" ${btnStylePrimary()} target="_blank" rel="noopener" href="${tiqetsUrl(q, TIQETS_PID)}">🏛️ Biglietti</a>
        <a class="btn btn-ghost" ${btnStyleGhost()} target="_blank" rel="noopener" href="${amazonEssentialsUrl(AMAZON_TAG)}">🧳 Essenziali</a>
      </div>

      <div class="small muted" style="margin-top:10px;">
        Se alcuni link non trovano subito: prova “Tour/Biglietti” (ricerca) + “Cosa vedere”.
        <br/>
        Inserisci i tuoi ID affiliato in app.js: <b>BOOKING_AID</b> / <b>GYG_PID</b> / <b>TIQETS_PID</b> / <b>AMAZON_TAG</b>.
      </div>
    </div>
  `;
}

// -------------------- RENDER --------------------
function renderResult(origin, maxMinutesShown, chosen, alternatives, meta = {}) {
  const area = $("resultArea");
  const category = meta.category || "ovunque";

  if (!chosen) {
    const extra = (category === "mare" && Number(maxMinutesShown) < 75)
      ? `Hai scelto <b>Mare</b>: spesso serve un po' più tempo. (Prova 90–120 min)`
      : `Prova ad aumentare i minuti o cambiare categoria/stile.`;

    area.innerHTML = `
      <div class="card errbox">
        <div class="small">❌ Nessuna meta trovata entro ${maxMinutesShown} min con i filtri attuali.</div>
        <div class="small muted" style="margin-top:6px;">${extra}</div>
        <div class="row wrap gap" style="margin-top:12px;">
          <button class="btn btn-ghost" id="btnResetRotation" ${btnStyleGhost()}>🧽 Reset “proposte di oggi”</button>
        </div>
      </div>
    `;

    $("btnResetRotation")?.addEventListener("click", () => {
      resetRotation();
      showStatus("ok", "Reset fatto ✅ Ora non evito più le mete già proposte oggi.");
      // rilancia subito la ricerca
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

          const q = cleanPlaceQuery(ap.name);
          const foto = googleImagesUrl(`${q} foto`);

          return `
            <div class="card" data-alt="1" data-pid="${aPid}"
                 style="padding:14px; cursor:pointer; border-color: rgba(255,255,255,.12);">
              <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">
                <div>
                  <div style="font-weight:850; font-size:16px; line-height:1.2;">
                    ${ap.name} <span class="small muted">(${aBadge})</span>
                  </div>
                  <div class="small muted" style="margin-top:6px;">
                    ~${a.driveMin} min • ${fmtKm(a.km)} • ${ap.type || "meta"}
                  </div>
                </div>
                <div class="pill" style="white-space:nowrap;">Scegli</div>
              </div>

              <div class="row wrap gap" style="margin-top:12px;">
                <a class="btn btn-ghost" ${btnStyleGhost()} href="${aPlaceUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Maps</a>
                <a class="btn btn-ghost" ${btnStyleGhost()} href="${aDirUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Percorso</a>
                <a class="btn btn-ghost" ${btnStyleGhost()} href="${foto}" target="_blank" rel="noopener" onclick="event.stopPropagation()">📸 Foto</a>
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
        <a class="btn" ${btnStylePrimary()} href="${placeUrl}" target="_blank" rel="noopener">🗺️ Maps</a>
        <a class="btn btn-ghost" ${btnStyleGhost()} href="${dirUrl}" target="_blank" rel="noopener">🚗 Percorso</a>
      </div>

      ${whyHtml}

      <div class="row wrap gap" style="margin-top:12px;">
        <button class="btn btn-ghost" id="btnVisited" ${btnStyleGhost()}>✅ Già visitato</button>
        <button class="btn" id="btnChange" ${btnStylePrimary()}>🔁 Cambia meta</button>
        <button class="btn btn-ghost" id="btnResetRotation" ${btnStyleGhost()}>🧽 Reset oggi</button>
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
    showStatus("ok", "Reset fatto ✅ Ora ti propongo anche mete già mostrate oggi.");
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

    // forbid immediate specific pid (e.g. “cambia meta”)
    if (forbidPid && chosen?.pid === forbidPid) {
      const tmp = new Set(SESSION_SEEN);
      tmp.add(forbidPid);

      const visited = getVisitedSet();
      const recentSet = getRecentSet();
      const target = effMax;
      const beautyMin = minBeautyForMinutes(target);

      const candidates = [];
      const oLat = Number(origin.lat), oLon = Number(origin.lon);

      for (const p of MACRO.places) {
        const lat = Number(p.lat), lon = Number(p.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        if (isBadPlaceName(p.name)) continue;

        const beauty = Number(p.beauty_score);
        if (Number.isFinite(beauty) && beauty < beautyMin) continue;

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
