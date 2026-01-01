/* Jamo — Auto-only (offline macro)
 * - Origin: GPS or manual (geocode via /api/geocode?q=)
 * - Picks a destination from macro places based on:
 *   time (maxMinutes), category, style (chicche/classici), not visited
 * - Outputs: result card + alternatives (clickable) + maps links + monetization placeholders
 * - Adds: reset search, rating (local), better category matching + fallback
 */

const $ = (id) => document.getElementById(id);

// -------------------- SETTINGS --------------------
const MACRO_URL = "/data/macros/it_macro_01_abruzzo.json";

// car model
const ROAD_FACTOR = 1.28;       // a bit more realistic
const AVG_KMH = 70;             // average driving speed
const FIXED_OVERHEAD_MIN = 10;  // parking / urban slowdown

// monetization placeholders (fill with your IDs)
const BOOKING_AID = "";    // Booking affiliate id (aid)
const AMAZON_TAG  = "";    // Amazon tag
const GYG_PID     = "";    // GetYourGuide partner_id
const TIQETS_PID  = "";    // Tiqets partner

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

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function safeIdFromPlace(p) {
  const n = norm(p?.name);
  return p?.id || `p_${n.replace(/[^a-z0-9]+/g, "_")}_${String(p?.lat).slice(0,6)}_${String(p?.lon).slice(0,6)}`;
}

function estCarMinutesFromKm(km) {
  const roadKm = km * ROAD_FACTOR;
  const driveMin = (roadKm / AVG_KMH) * 60;
  return Math.round(clamp(driveMin + FIXED_OVERHEAD_MIN, 10, 900));
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

// -------------------- STORAGE: origin + visited + ratings --------------------
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
  } catch {
    return new Set();
  }
}
function saveVisitedSet(set) { localStorage.setItem("jamo_visited", JSON.stringify([...set])); }
function markVisited(placeId) { const s = getVisitedSet(); s.add(placeId); saveVisitedSet(s); }
function resetVisited() { localStorage.removeItem("jamo_visited"); }

// ratings: { [placeId]: 1..5 }
function getRatings() {
  const raw = localStorage.getItem("jamo_ratings");
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}
function setRating(placeId, rating) {
  const r = getRatings();
  r[placeId] = clamp(Number(rating) || 0, 1, 5);
  localStorage.setItem("jamo_ratings", JSON.stringify(r));
}
function getRating(placeId) {
  const r = getRatings();
  return Number(r[placeId] || 0);
}

// -------------------- UI helpers --------------------
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

function setChipExclusive(containerId, chipEl) {
  const el = $(containerId);
  [...el.querySelectorAll(".chip")].forEach(c => c.classList.remove("active"));
  chipEl.classList.add("active");
}
function initChips(containerId, { multi = false } = {}) {
  const el = $(containerId);
  if (!el) return;

  // use pointerdown to avoid sticky on mobile
  el.addEventListener("pointerdown", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    e.preventDefault();

    if (!multi) {
      setChipExclusive(containerId, chip);
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

// -------------------- GEOcoding --------------------
async function geocodeLabel(label) {
  const q = String(label || "").trim();
  if (!q) throw new Error("Inserisci un luogo");
  const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
  let j = null;
  try { j = await r.json(); } catch {}
  if (!j?.ok || !j?.result) throw new Error(j?.error || "Geocoding fallito");
  return j.result; // {label, lat, lon}
}

// -------------------- CATEGORY & STYLE MATCHING (robust) --------------------
function getTags(place) {
  return (place.tags || []).map(t => norm(t)).filter(Boolean);
}
function hasAny(tags, list) {
  const set = new Set(tags);
  return list.some(x => set.has(norm(x)));
}

const CAT_SYNONYMS = {
  mare: ["mare","spiagge","spiaggia","costa","trabocchi","lido","baia","scogliera","riserva","duna","promenade","lungomare"],
  montagna: ["montagna","neve","sci","rifugio","vetta","altopiano","trekking","parco_nazionale","panorama"],
  natura: ["natura","lago","gole","cascate","riserva","parco","panorama","trekking","sorgenti","forra","canyon"],
  relax: ["relax","terme","benessere","spa","slow","degustazioni","vino","tramonto","borgo_slow"],
  storia: ["storia","castello","abbazia","museo","archeologia","anfiteatro","eremo","santuario","cattedrale","borgo_storico"],
  family: ["bambini","famiglie","family","animali","parco_avventura","fattoria_didattica","acquario","museo_interattivo","bike_park","slitta","funivia"]
};

// category chip values expected in HTML:
// ovunque | mare | montagna | natura | relax | storia | family | citta | borghi
function matchesCategory(place, cat) {
  const type = norm(place.type);
  const tags = getTags(place);

  if (!cat || cat === "ovunque") return true;

  if (cat === "citta") return type === "citta" || type === "città" || tags.includes("citta");
  if (cat === "borghi") return type === "borgo" || tags.includes("borgo");

  if (cat === "mare") return type === "mare" || hasAny(tags, CAT_SYNONYMS.mare);
  if (cat === "montagna") return type === "montagna" || hasAny(tags, CAT_SYNONYMS.montagna);
  if (cat === "natura") return type === "natura" || hasAny(tags, CAT_SYNONYMS.natura);
  if (cat === "relax") return type === "relax" || hasAny(tags, CAT_SYNONYMS.relax);
  if (cat === "storia") return type === "storia" || hasAny(tags, CAT_SYNONYMS.storia);
  if (cat === "family") return type === "bambini" || hasAny(tags, CAT_SYNONYMS.family);

  return true;
}

function matchesStyle(place, { wantChicche, wantClassici }) {
  const vis = norm(place.visibility); // "chicca" | "conosciuta"
  if (!wantChicche && !wantClassici) return true; // no filter
  if (vis === "chicca") return !!wantChicche;
  return !!wantClassici;
}

// -------------------- SCORING --------------------
function scorePlace({ driveMin, targetMin, beautyScore, isChicca, rating }) {
  const t = clamp(1 - Math.abs(driveMin - targetMin) / Math.max(25, targetMin * 0.85), 0, 1);
  const b = clamp(Number(beautyScore) || 0.75, 0.4, 1);
  const c = isChicca ? 0.06 : 0;
  const r = rating ? (clamp(rating, 1, 5) / 5) * 0.10 : 0; // user rating boosts a bit
  return 0.58 * t + 0.32 * b + c + r;
}

// -------------------- PICK DESTINATION (with fallback) --------------------
function buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited = false, forbiddenId = null } = {}) {
  const visited = getVisitedSet();
  const target = Number(maxMinutes);
  const oLat = Number(origin.lat);
  const oLon = Number(origin.lon);

  const out = [];

  for (const p of MACRO.places) {
    const lat = Number(p.lat);
    const lon = Number(p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    if (!matchesStyle(p, styles)) continue;
    if (!matchesCategory(p, category)) continue;

    const pid = safeIdFromPlace(p);
    if (forbiddenId && pid === forbiddenId) continue;
    if (!ignoreVisited && visited.has(pid)) continue;

    const km = haversineKm(oLat, oLon, lat, lon);
    const driveMin = estCarMinutesFromKm(km);
    if (driveMin > target) continue;

    const isChicca = norm(p.visibility) === "chicca";
    const rating = getRating(pid);

    const s = scorePlace({ driveMin, targetMin: target, beautyScore: p.beauty_score, isChicca, rating });

    out.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
  }

  out.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
  return out;
}

function softCategoryFallback(origin, maxMinutes, category, styles, forbiddenId = null) {
  // If strict category too empty, allow "nearby cousins"
  // e.g. mare -> also include "panorama" + "riserva" etc; natura -> panorama/trekking, etc.
  const target = Number(maxMinutes);
  const oLat = Number(origin.lat);
  const oLon = Number(origin.lon);
  const visited = getVisitedSet();

  const softTagsMap = {
    mare: ["mare","costa","trabocchi","spiagge","spiaggia","riserva","lungomare","baia"],
    montagna: ["montagna","trekking","panorama","altopiano","parco_nazionale","rifugio"],
    natura: ["natura","panorama","parco","riserva","lago","gole","cascate","trekking"],
    relax: ["relax","terme","benessere","slow","tramonto","degustazioni"],
    storia: ["storia","borgo","castello","abbazia","eremo","museo"],
    family: ["famiglie","bambini","animali","parco_avventura","museo_interattivo","lago","spiagge"]
  };

  const softTags = softTagsMap[category] || [];
  const out = [];

  for (const p of MACRO.places) {
    const lat = Number(p.lat), lon = Number(p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    if (!matchesStyle(p, styles)) continue;

    const pid = safeIdFromPlace(p);
    if (forbiddenId && pid === forbiddenId) continue;
    if (visited.has(pid)) continue;

    const tags = getTags(p);
    if (!hasAny(tags, softTags)) continue;

    const km = haversineKm(oLat, oLon, lat, lon);
    const driveMin = estCarMinutesFromKm(km);
    if (driveMin > target) continue;

    const isChicca = norm(p.visibility) === "chicca";
    const rating = getRating(pid);
    const s = scorePlace({ driveMin, targetMin: target, beautyScore: p.beauty_score, isChicca, rating });

    out.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
  }

  out.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
  return out;
}

function pickDestination(origin, maxMinutes, category, styles, { forbiddenId = null } = {}) {
  // 1) strict (not visited)
  let candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: false, forbiddenId });

  // 2) if too few, try soft fallback (still not visited)
  if (candidates.length < 8 && category !== "ovunque") {
    const extra = softCategoryFallback(origin, maxMinutes, category, styles, forbiddenId);
    const seen = new Set(candidates.map(x => x.pid));
    for (const e of extra) if (!seen.has(e.pid)) candidates.push(e);
    candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
  }

  // 3) if still none: ignore visited
  if (candidates.length === 0) {
    candidates = buildCandidates(origin, maxMinutes, category, styles, { ignoreVisited: true, forbiddenId });
  }

  const chosen = candidates[0] || null;
  const alternatives = candidates.slice(1, 3); // keep 2 alternatives as requested
  return { chosen, alternatives, totalCandidates: candidates.length };
}

// -------------------- RENDER --------------------
function ratingStarsHtml(current) {
  const c = Number(current || 0);
  return `
    <div class="rating" style="display:flex; gap:6px; align-items:center;">
      <span class="small muted">Valuta:</span>
      ${[1,2,3,4,5].map(n => `
        <button class="starBtn ${c>=n ? "on" : ""}" data-star="${n}" aria-label="${n} stelle">★</button>
      `).join("")}
    </div>
  `;
}

function renderResult(origin, maxMinutes, chosen, alternatives) {
  const area = $("resultArea");

  if (!chosen) {
    area.innerHTML = `
      <div class="card errbox">
        <div class="small">❌ Nessuna meta entro ${maxMinutes} min con i filtri attuali.</div>
        <div class="small muted" style="margin-top:6px;">Suggerimento: aumenta i minuti oppure scegli “Ovunque”.</div>
      </div>
    `;
    return;
  }

  const p = chosen.place;
  const pid = chosen.pid;
  const isChicca = norm(p.visibility) === "chicca";
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
      <div class="small muted" style="margin-top:8px;">
        (Inserisci i tuoi ID affiliato in app.js: BOOKING_AID / GYG_PID / TIQETS_PID / AMAZON_TAG)
      </div>
    </div>
  `;

  const altHtml = (alternatives || []).length ? `
    <div class="card" style="margin-top:12px;">
      <div class="small muted">Alternative (tocca per scegliere)</div>
      <div style="margin-top:10px; display:flex; flex-direction:column; gap:8px;">
        ${(alternatives || []).map(a => {
          const ap = a.place;
          const aIsChicca = norm(ap.visibility) === "chicca";
          const aBadge = aIsChicca ? "✨" : "✅";
          return `
            <button class="altCard" data-pid="${a.pid}" style="text-align:left;">
              <div style="font-weight:750;">${ap.name} <span class="small muted">(${aBadge})</span></div>
              <div class="small muted">~${a.driveMin} min • ${fmtKm(a.km)} • score ${a.score}</div>
            </button>
          `;
        }).join("")}
      </div>
    </div>
  ` : "";

  const currentRating = getRating(pid);

  area.innerHTML = `
    <div class="card okbox">
      <div class="pill">🚗 auto • ~${chosen.driveMin} min • ${fmtKm(chosen.km)} • ${badge}</div>
      <div class="resultTitle">${p.name}, ${country}</div>
      <div class="small muted" style="margin-top:6px;">
        Categoria: <b>${p.type || "meta"}</b> • Score: <b>${chosen.score}</b>
      </div>

      <div class="row wrap gap" style="margin-top:12px;">
        <a class="btn" href="${placeUrl}" target="_blank" rel="noopener">Apri su Google Maps</a>
        <a class="btn btn-ghost" href="${dirUrl}" target="_blank" rel="noopener">Apri percorso</a>
      </div>

      ${whyHtml}

      <div style="margin-top:12px;">
        ${ratingStarsHtml(currentRating)}
        <div class="small muted" style="margin-top:6px;">(La valutazione resta sul tuo dispositivo)</div>
      </div>

      <div class="row wrap gap" style="margin-top:12px;">
        <button class="btn btn-ghost" id="btnVisited">✅ Già visitato</button>
        <button class="btn" id="btnChange">🔁 Cambia meta</button>
        <button class="btn btn-ghost" id="btnResetSearch">🧹 Reset ricerca</button>
      </div>
    </div>

    ${monetHtml}
    ${altHtml}
  `;

  // rating handlers
  area.querySelectorAll(".starBtn").forEach(btn => {
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const v = Number(btn.dataset.star);
      setRating(pid, v);
      showStatus("ok", `Valutato ${v}/5 ⭐`);
      // rerender to update stars
      renderResult(origin, maxMinutes, chosen, alternatives);
    });
  });

  // visited
  $("btnVisited")?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    markVisited(pid);
    showStatus("ok", "Segnato come visitato ✅ — La prossima volta ti propongo un’altra meta.");
  });

  // change meta (force different)
  $("btnChange")?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    runSearch({ silent: true, forceDifferentFrom: pid });
  });

  // reset search (keeps origin)
  $("btnResetSearch")?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resetSearchUI();
    showStatus("ok", "Ricerca resettata ✅");
  });

  // clickable alternatives
  area.querySelectorAll(".altCard").forEach(btn => {
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const altPid = btn.dataset.pid;
      if (!altPid) return;

      const alt = (alternatives || []).find(x => x.pid === altPid);
      if (!alt) return;

      // promote alt to chosen and rebuild alternatives (keep 2)
      const newChosen = alt;
      const newAlternatives = [
        chosen,
        ...(alternatives || []).filter(x => x.pid !== altPid),
      ].slice(0, 2);

      showStatus("ok", `Scelta alternativa: ${newChosen.place.name} ✅`);
      renderResult(origin, maxMinutes, newChosen, newAlternatives);
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

    const maxMinutes = clamp(Number($("maxMinutes").value) || 120, 10, 900);
    const category = getActiveCategory();
    const styles = getActiveStyles();

    let { chosen, alternatives } = pickDestination(origin, maxMinutes, category, styles, { forbiddenId: forceDifferentFrom });

    renderResult(origin, maxMinutes, chosen, alternatives);

    if (!chosen) {
      showStatus("warn", `Nessuna meta entro ${maxMinutes} min con i filtri attuali. Prova “Ovunque” o aumenta i minuti.`);
    } else if (!silent) {
      showStatus("ok", `Meta trovata ✅ (~${chosen.driveMin} min) • risultati: ${Math.max(1, (alternatives?.length||0)+1)}`);
    }
  } catch (e) {
    console.error(e);
    showStatus("err", `Errore: ${String(e.message || e)}`);
  }
}

// -------------------- RESET UI --------------------
function resetSearchUI() {
  // reset time -> 120
  $("maxMinutes").value = "120";
  // reset chip active (best effort)
  const timeEl = $("timeChips");
  if (timeEl) {
    [...timeEl.querySelectorAll(".chip")].forEach(c => c.classList.remove("active"));
    const chip120 = timeEl.querySelector(`.chip[data-min="120"]`);
    if (chip120) chip120.classList.add("active");
  }

  // category -> ovunque
  const catEl = $("categoryChips");
  if (catEl) {
    [...catEl.querySelectorAll(".chip")].forEach(c => c.classList.remove("active"));
    const ov = catEl.querySelector(`.chip[data-cat="ovunque"]`);
    if (ov) ov.classList.add("active");
  }

  // styles -> none selected (means both)
  const stEl = $("styleChips");
  if (stEl) {
    [...stEl.querySelectorAll(".chip")].forEach(c => c.classList.remove("active"));
  }

  // clear result card
  $("resultArea").innerHTML = "";
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
      if (o?.lat && o?.lon) setOrigin(o);
    } catch {}
  }
}

function bindOriginButtons() {
  $("btnUseGPS")?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
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

  $("btnFindPlace")?.addEventListener("pointerdown", async (e) => {
    e.preventDefault();
    try {
      const label = $("originLabel").value;
      $("originStatus").textContent = "🔎 Cerco il luogo…";
      const result = await geocodeLabel(label);
      setOrigin({ label: result.label || label, lat: result.lat, lon: result.lon });
      showStatus("ok", "Partenza impostata dal luogo ✅");
    } catch (e2) {
      console.error(e2);
      $("originStatus").textContent = `❌ ${String(e2.message || e2)}`;
      showStatus("err", `Geocoding fallito: ${String(e2.message || e2)}`);
    }
  });
}

function bindMainButtons() {
  $("btnFind")?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    runSearch();
  });

  $("btnResetVisited")?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resetVisited();
    showStatus("ok", "Visitati resettati ✅");
  });

  // optional: if you have a reset search button in index.html
  const btnReset = $("btnResetSearchTop");
  btnReset?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resetSearchUI();
    showStatus("ok", "Ricerca resettata ✅");
  });
}

// -------------------- INIT --------------------
initChips("timeChips", { multi: false });
initChips("categoryChips", { multi: false });
initChips("styleChips", { multi: true });

initTimeChipsSync();
restoreOrigin();
bindOriginButtons();
bindMainButtons();

loadMacro().catch(() => {});
hideStatus();
