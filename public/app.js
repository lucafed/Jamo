/* Jamo — app.js v11.0
 * ✅ Frontend semplificato: la logica “posti giusti EU+UK + categoria + distanza/tempo” la fa /api/jamo
 * ✅ Mantiene UI: chips, geocode, GPS, visited, rotation “oggi”
 * ✅ Estrae lat/lon dal link gmaps dell’API per render map + links
 */

const $ = (id) => document.getElementById(id);

// -------------------- ROTATION --------------------
const RECENT_TTL_MS = 1000 * 60 * 60 * 20;
const RECENT_MAX = 160;
let SESSION_SEEN = new Set();
let LAST_SHOWN_PID = null;

// anti-race / abort
let SEARCH_TOKEN = 0;
let SEARCH_ABORT = null;

// -------------------- UTIL --------------------
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function normName(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function safeIdFromPlace(p) {
  if (p?.id) return String(p.id);
  const nm = normName(p?.name);
  const lat = String(p?.lat ?? "").slice(0, 8);
  const lon = String(p?.lon ?? p?.lng ?? "").slice(0, 8);
  return `p_${nm || "x"}_${lat}_${lon}`;
}

function isWinterNow() {
  const m = new Date().getMonth() + 1;
  return (m === 11 || m === 12 || m === 1 || m === 2 || m === 3);
}

// -------------------- MAP STATIC IMAGES --------------------
function osmStaticImgPrimary(lat, lon, z = 12) {
  const size = "720x360";
  const marker = `${lat},${lon},lightblue1`;
  return `https://staticmap.openstreetmap.de/staticmap.php?center=${encodeURIComponent(lat + "," + lon)}&zoom=${encodeURIComponent(z)}&size=${encodeURIComponent(size)}&maptype=mapnik&markers=${encodeURIComponent(marker)}`;
}
function osmStaticImgFallback(lat, lon, z = 12) {
  const size = "720x360";
  const marker = `color:blue|${lat},${lon}`;
  return `https://staticmap.openstreetmap.fr/osmfr/staticmap.php?center=${encodeURIComponent(lat + "," + lon)}&zoom=${encodeURIComponent(z)}&size=${encodeURIComponent(size)}&markers=${encodeURIComponent(marker)}`;
}

// -------------------- LINKS --------------------
function mapsPlaceUrl(lat, lon) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lon)}`;
}
function mapsDirUrl(oLat, oLon, dLat, dLon) {
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(oLat + "," + oLon)}&destination=${encodeURIComponent(dLat + "," + dLon)}&travelmode=driving`;
}
function gmapsQueryUrl(q) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}
function googleImagesUrl(q) {
  return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`;
}
function googleThingsToDoUrl(q) {
  return `https://www.google.com/search?q=${encodeURIComponent("cosa vedere " + q)}`;
}
function googleDoUrl(q) {
  return `https://www.google.com/search?q=${encodeURIComponent("cosa fare " + q)}`;
}
function wikiUrl(title) {
  return `https://it.wikipedia.org/w/index.php?search=${encodeURIComponent(title)}`;
}
function restaurantsUrl(q) {
  return gmapsQueryUrl(`${q} ristoranti`);
}
function eventsUrl(q) {
  return `https://www.google.com/search?q=${encodeURIComponent("eventi " + q)}`;
}

// -------------------- STORAGE: ORIGIN --------------------
function setOrigin({ label, lat, lon, country_code }) {
  if ($("originLabel")) $("originLabel").value = label ?? "";
  if ($("originLat")) $("originLat").value = String(lat);
  if ($("originLon")) $("originLon").value = String(lon);

  const cc = String(country_code || "").toUpperCase();
  if ($("originCC")) $("originCC").value = cc;

  localStorage.setItem("jamo_origin", JSON.stringify({ label, lat, lon, country_code: cc }));

  if ($("originStatus")) {
    $("originStatus").textContent =
      `✅ Partenza: ${label || "posizione"} (${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)})${cc ? " • " + cc : ""}`;
  }
}

function getOrigin() {
  const lat = Number($("originLat")?.value);
  const lon = Number($("originLon")?.value);
  const label = ($("originLabel")?.value || "").trim();
  const ccDom = String($("originCC")?.value || "").toUpperCase();

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return { label, lat, lon, country_code: ccDom };
  }

  const raw = localStorage.getItem("jamo_origin");
  if (raw) {
    try {
      const o = JSON.parse(raw);
      if (Number.isFinite(Number(o?.lat)) && Number.isFinite(Number(o?.lon))) {
        return {
          label: String(o.label || ""),
          lat: Number(o.lat),
          lon: Number(o.lon),
          country_code: String(o.country_code || "").toUpperCase(),
        };
      }
    } catch {}
  }
  return null;
}

// -------------------- STORAGE: VISITED + RECENT --------------------
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
function resetVisited() {
  localStorage.removeItem("jamo_visited");
}

function loadRecent() {
  const raw = localStorage.getItem("jamo_recent");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
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
  list = list.filter(x => (seen.has(x.pid) ? false : (seen.add(x.pid), true)));
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

// -------------------- UI --------------------
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
      if (Number.isFinite(v) && $("maxMinutes")) $("maxMinutes").value = String(v);
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

// ✅ flavor deciso in modo coerente (1 valore) per /api/jamo
function chooseFlavor(category, styles) {
  if (category === "family") return "famiglia";
  if (styles.wantChicche && !styles.wantClassici) return "chicche";
  return "classici";
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

function showResultProgress(msg = "Cerco la meta (EU+UK) rispettando categoria e distanza/tempo…") {
  const area = $("resultArea");
  if (!area) return;
  area.innerHTML = `
    <div class="card warnbox">
      <div style="font-weight:900; font-size:18px;">🔎 Sto cercando…</div>
      <div class="small muted" style="margin-top:8px; line-height:1.4;">
        ${msg}
      </div>
    </div>
  `;
}

// -------------------- FETCH JSON --------------------
async function fetchJson(url, { signal, method = "GET", body } = {}) {
  const r = await fetch(url, {
    method,
    cache: "no-store",
    signal,
    headers: body ? { "Content-Type": "application/json", "Accept": "application/json" } : { "Accept": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text().catch(() => "");
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) {
    const msg = j?.error ? String(j.error) : `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return j;
}

// -------------------- GEOCODING --------------------
async function geocodeLabel(label) {
  const q = String(label || "").trim();
  if (!q) throw new Error("Scrivi un luogo (es: L'Aquila, Roma, Milano...)");
  const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { method: "GET", cache: "no-store" });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error("Geocoding fallito (risposta vuota)");
  if (!j.ok) throw new Error(j.error || "Geocoding fallito");
  if (!j.result || !Number.isFinite(Number(j.result.lat)) || !Number.isFinite(Number(j.result.lon))) {
    throw new Error("Geocoding fallito (coordinate non valide)");
  }
  return j.result;
}

// -------------------- Category UX helpers (microcopy) --------------------
function typeBadge(category) {
  const map = {
    family: { emoji: "👨‍👩‍👧‍👦", label: "Family" },
    theme_park:{ emoji:"🎢", label:"Parchi" },
    kids_museum:{ emoji:"🧒🏛️", label:"Musei kids" },
    viewpoints:{ emoji:"🌅", label:"Panorami" },
    hiking:{ emoji:"🥾", label:"Trekking" },

    storia: { emoji: "🏛️", label: "Storia" },
    borghi: { emoji: "🏘️", label: "Borghi" },
    citta:  { emoji: "🏙️", label: "Città" },
    mare:   { emoji: "🌊", label: "Mare" },
    natura: { emoji: "🌿", label: "Natura" },
    montagna:{emoji:"🏔️",label:"Montagna"},
    relax:  { emoji: "🧖", label: "Relax" },
    ovunque:{ emoji: "🎲", label: "Meta" },
  };
  return map[category] || { emoji: "📍", label: "Meta" };
}

function microWhatToDo(placeName, category) {
  if (category === "family" || category === "theme_park") return "Family: controlla orari e foto prima di partire.";
  if (category === "kids_museum") return "Esperienza kids/indoor: perfetta anche con brutto tempo.";
  if (category === "viewpoints") return "Panorama: tramonto, foto e passeggiata breve.";
  if (category === "hiking") return "Trekking: scarpe buone e controlla meteo.";
  if (category === "relax") return "Relax: terme/spa o posto tranquillo + pausa.";
  if (category === "storia") return "Storia e cultura: visita + centro storico.";
  if (category === "mare") return "Mare: spiaggia, passeggiata e tramonto.";
  if (category === "natura") return "Natura: sentieri, panorami, cascata/lago/riserva.";
  if (category === "borghi") return "Borgo: vicoli, belvedere, cibo tipico e foto.";
  if (category === "citta") return "Città: centro, piazze, monumenti e locali.";
  if (category === "montagna") return "Montagna: vista, rifugio o punto panoramico.";
  return "Esplora, foto, cibo e cose da fare nei dintorni.";
}

// -------------------- API -> UI adapter --------------------

// Estrae destination lat/lon dal link /maps/dir/?...destination=LAT%2CLON
function extractLatLonFromGmapsDir(url) {
  try {
    const u = new URL(url);
    const dest = u.searchParams.get("destination");
    if (!dest) return null;
    const parts = decodeURIComponent(dest).split(",");
    if (parts.length < 2) return null;
    const lat = Number(parts[0]);
    const lon = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  } catch {
    return null;
  }
}

function apiPlaceToChosen(apiPlace) {
  if (!apiPlace) return null;

  const coords = extractLatLonFromGmapsDir(apiPlace.gmaps || "");
  const lat = coords?.lat;
  const lon = coords?.lon;

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const place = {
    id: apiPlace.id,
    name: apiPlace.name,
    lat,
    lon,
    country: apiPlace.area || "", // non sempre è country; ma per UI basta
    area: apiPlace.area || "",
    type: apiPlace.type || "place",
    visibility: apiPlace.visibility || "",
    tags: Array.isArray(apiPlace.tags) ? apiPlace.tags : [],
    beauty_score: apiPlace.beauty_score
  };

  const pid = safeIdFromPlace(place);

  return {
    place,
    pid,
    km: Number(apiPlace.distance_km) || NaN,
    driveMin: Number(apiPlace.eta_min) || NaN,
    score: 0.0, // score è server-side; qui non serve
    gmaps: apiPlace.gmaps
  };
}

// -------------------- RENDER --------------------
function renderNoResultFinal(maxMinutesShown, category, datasetInfo) {
  const area = $("resultArea");
  if (!area) return;

  area.innerHTML = `
    <div class="card errbox">
      <div class="small">❌ Nessuna meta trovata entro ${maxMinutesShown} min per la categoria <b>${category}</b>.</div>
      <div class="small muted" style="margin-top:6px;">
        Suggerimento: aumenta minuti oppure cambia categoria/stile.
      </div>
      <div class="small muted" style="margin-top:10px;">
        Dataset: ${datasetInfo}
      </div>
      <div class="row wrap gap" style="margin-top:12px;">
        <button class="btn btn-ghost" id="btnResetRotation">🧽 Reset “proposte di oggi”</button>
      </div>
    </div>
  `;

  $("btnResetRotation")?.addEventListener("click", () => {
    resetRotation();
    showStatus("ok", "Reset fatto ✅ Ora posso ripescare anche mete già proposte oggi/sessione.");
    runSearch({ silent: true });
  });
}

function renderResult(origin, maxMinutesShown, chosen, alternatives = [], meta = {}) {
  const area = $("resultArea");
  if (!area) return;

  const category = meta.category || "ovunque";

  if (!chosen) {
    renderNoResultFinal(maxMinutesShown, category, meta.datasetInfo || "—");
    return;
  }

  const p = chosen.place;
  const pid = chosen.pid;

  const badge = String(p.visibility || "").toLowerCase().includes("chicca") ? "✨ chicca" : "✅ classica";
  const tb = typeBadge(category);

  const what = microWhatToDo(p.name, category);

  const lat = Number(p.lat);
  const lon = Number(p.lon);

  const zoom = (chosen.km || 999) < 20 ? 12 : (chosen.km || 999) < 60 ? 10 : 8;
  const img1 = osmStaticImgPrimary(lat, lon, zoom);
  const img2 = osmStaticImgFallback(lat, lon, zoom);

  const q = (p.country || p.area) ? `${p.name}, ${p.country || p.area}` : p.name;

  const kmText = Number.isFinite(chosen.km) ? `${Math.round(chosen.km)} km` : "— km";
  const minText = Number.isFinite(chosen.driveMin) ? `${Math.round(chosen.driveMin)} min` : "— min";

  area.innerHTML = `
    <div class="card okbox" style="overflow:hidden; padding:0;">
      <div style="position:relative; width:100%; aspect-ratio: 2 / 1; border-bottom:1px solid var(--border);">
        <img src="${img1}" alt="" loading="lazy" decoding="async"
             style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; opacity:.95;"
             onerror="(function(img){
               if(!img.dataset.fallbackTried){
                 img.dataset.fallbackTried='1';
                 img.src='${img2}';
                 return;
               }
               img.style.display='none';
               var ph = img.parentElement.querySelector('.heroPlaceholder');
               if(ph) ph.style.display='flex';
             })(this)"
        />
        <div class="heroPlaceholder"
             style="position:absolute; inset:0; display:none; align-items:center; justify-content:center; gap:10px;
                    background: linear-gradient(135deg, rgba(0,224,255,.18), rgba(26,255,213,.08));
                    color: rgba(255,255,255,.92); font-weight:900; letter-spacing:.2px;">
          📍 ${p.name}
        </div>

        <div style="position:absolute; left:12px; top:12px; display:flex; gap:8px; flex-wrap:wrap; max-width: calc(100% - 24px);">
          <div class="pill">${tb.emoji} ${tb.label}</div>
          <div class="pill">🚗 ~${minText} • ${kmText}</div>
          <div class="pill">${badge}</div>
          <div class="pill">EU+UK</div>
          ${meta.forceEuUkAll ? `<div class="pill">🧭 all</div>` : ""}
          ${meta.radiusKm ? `<div class="pill">📏 ${meta.radiusKm} km</div>` : ""}
        </div>
      </div>

      <div style="padding:14px;">
        <div style="font-weight:950; font-size:28px; line-height:1.12; margin:0;">
          ${p.name} <span class="small muted" style="font-weight:700;">(${p.country || p.area || "—"})</span>
        </div>

        <div class="small muted" style="margin-top:8px; line-height:1.35;">
          Sorgente: /api/jamo • ${meta.flavor ? `flavor: ${meta.flavor}` : ""} ${meta.radiusKm ? ` • radius: ${meta.radiusKm} km` : ""}
        </div>

        <div style="margin-top:12px; font-weight:900;">Cosa si fa</div>
        <div class="small muted" style="margin-top:6px; line-height:1.45;">${what}</div>

        <div class="row wrap gap" style="margin-top:14px;">
          <a class="btn" target="_blank" rel="noopener" href="${mapsPlaceUrl(lat, lon)}">🗺️ Maps</a>
          <a class="btn" target="_blank" rel="noopener" href="${mapsDirUrl(origin.lat, origin.lon, lat, lon)}">🚗 Percorso</a>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleImagesUrl(q)}">📸 Foto</a>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleThingsToDoUrl(q)}">👀 Cosa vedere</a>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleDoUrl(q)}">🎯 Cosa fare</a>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${restaurantsUrl(q)}">🍝 Ristoranti</a>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${wikiUrl(q)}">📚 Wiki</a>
          <a class="btn btn-ghost" target="_blank" rel="noopener" href="${eventsUrl(q)}">📅 Eventi</a>
        </div>

        <div class="row wrap gap" style="margin-top:14px;">
          <button class="btn btn-ghost" id="btnVisited">✅ Già visitato</button>
          <button class="btn" id="btnChange">🔁 Cambia meta</button>
          <button class="btn btn-ghost" id="btnResetRotation">🧽 Reset “oggi”</button>
        </div>
      </div>
    </div>

    ${alternatives?.length ? `
      <div style="margin-top:14px;">
        <div class="small muted" style="margin-bottom:8px;">Alternative (2)</div>
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
          ${alternatives.slice(0, 2).map(a => {
            const ap = a.place;
            const aKm = Number.isFinite(a.km) ? `${Math.round(a.km)} km` : "— km";
            const aMin = Number.isFinite(a.driveMin) ? `${Math.round(a.driveMin)} min` : "— min";
            return `
              <div class="card" style="padding:10px;">
                <div style="font-weight:900; line-height:1.2;">${ap.name}</div>
                <div class="small muted" style="margin-top:4px;">
                  🚗 ~${aMin} • ${aKm} ${ap.country ? `• (${ap.country})` : ""}
                </div>
                <div class="row wrap gap" style="margin-top:10px;">
                  <a class="btn btn-ghost" target="_blank" rel="noopener" href="${mapsDirUrl(origin.lat, origin.lon, ap.lat, ap.lon)}">Percorso</a>
                  <button class="btn btn-ghost" data-pid="${a.pid}">Scegli</button>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    ` : ""}
  `;

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
    showStatus("ok", "Reset fatto ✅ Ora posso ripescare anche mete già proposte oggi/sessione.");
    runSearch({ silent: true });
  });

  area.querySelectorAll("button[data-pid]").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetPid = btn.getAttribute("data-pid");
      if (!targetPid) return;
      runSearch({ silent: true, forcePid: targetPid });
    });
  });
}

// -------------------- MAIN SEARCH (API /api/jamo) --------------------
function minutesToRadiusKm(minutes) {
  // raggio realistico: convertiamo “tempo” in un raggio prudente
  const AVG_KMH = 72;
  const ROAD_FACTOR = 1.25;
  const FIXED_OVERHEAD_MIN = 8;

  const m = clamp(Number(minutes) || 120, 10, 600);
  const drive = Math.max(6, m - FIXED_OVERHEAD_MIN);

  const straightKm = (drive / 60) * AVG_KMH / ROAD_FACTOR;
  return clamp(Math.round(straightKm * 0.85), 4, 220);
}

function rotationPenalty(pid, recentSet) {
  let pen = 0;
  if (pid && pid === LAST_SHOWN_PID) pen += 1;
  if (SESSION_SEEN.has(pid)) pen += 1;
  if (recentSet.has(pid)) pen += 1;
  return pen;
}

function applyRotationFilter(top, alts) {
  const recentSet = getRecentSet();

  const all = [top, ...(alts || [])].filter(Boolean);
  if (!all.length) return { top: null, alts: [] };

  // scegli il primo con meno penalità
  all.sort((a, b) => {
    const pa = rotationPenalty(a.pid, recentSet);
    const pb = rotationPenalty(b.pid, recentSet);
    return pa - pb;
  });

  const best = all[0];
  const rest = all.slice(1, 3);
  return { top: best, alts: rest };
}

async function runSearch({ silent = false, forbidPid = null, forcePid = null } = {}) {
  try { SEARCH_ABORT?.abort?.(); } catch {}
  SEARCH_ABORT = new AbortController();
  const signal = SEARCH_ABORT.signal;
  const token = ++SEARCH_TOKEN;

  try {
    if (!silent) hideStatus();
    showResultProgress();

    const origin = getOrigin();
    if (!origin || !Number.isFinite(Number(origin.lat)) || !Number.isFinite(Number(origin.lon))) {
      showStatus("err", "Imposta una partenza: GPS oppure scrivi un luogo e premi “Usa questo luogo”.");
      return;
    }

    const maxMinutesInput = clamp(Number($("maxMinutes")?.value) || 120, 10, 600);
    const category = getActiveCategory();
    const styles = getActiveStyles();
    const flavor = chooseFlavor(category, styles);

    // ✅ opzionale ma consigliato: radiusKm “reale” per avere distanza coerente
    // se vuoi solo tempo, metti radiusKm = null
    const radiusKm = minutesToRadiusKm(maxMinutesInput);

    const visitedIds = [...getVisitedSet()];
    const weekIds = [...getRecentSet()];

    const body = {
      origin: { lat: origin.lat, lon: origin.lon, label: origin.label || "", country_code: origin.country_code || "" },
      maxMinutes: maxMinutesInput,
      flavor,
      category: category === "ovunque" ? "" : category,
      radiusKm,              // ✅ distanza vera
      forceEuUkAll: true,    // ✅ sempre EU+UK all (come vuoi tu)
      visitedIds,
      weekIds
    };

    const j = await fetchJson("/api/jamo", { method: "POST", body, signal });

    if (token !== SEARCH_TOKEN) return;

    let top = apiPlaceToChosen(j?.top);
    let alts = Array.isArray(j?.alternatives) ? j.alternatives.map(apiPlaceToChosen).filter(Boolean) : [];

    // forcePid / forbidPid a livello client (scelta alternative)
    if (forcePid) {
      const all = [top, ...alts].filter(Boolean);
      const forced = all.find(x => x.pid === forcePid);
      if (forced) {
        top = forced;
        alts = all.filter(x => x.pid !== forcePid).slice(0, 2);
      }
    } else if (forbidPid && top?.pid === forbidPid) {
      const all = [top, ...alts].filter(Boolean).filter(x => x.pid !== forbidPid);
      top = all[0] || null;
      alts = all.slice(1, 3);
    }

    // rotazione “oggi”: se top è ripetuto, prova a scegliere un’alternativa migliore
    const rotated = applyRotationFilter(top, alts);
    top = rotated.top;
    alts = rotated.alts;

    renderResult(origin, maxMinutesInput, top, alts, {
      category,
      flavor,
      radiusKm,
      forceEuUkAll: true
    });

    if (!top) {
      showStatus("warn", `Nessuna meta entro ${maxMinutesInput} min per "${category}". Prova ad aumentare i minuti o cambia categoria.`);
    } else if (!silent) {
      showStatus("ok", `Meta trovata ✅ (~${top.driveMin} min) • categoria: ${category} • EU+UK`);
    }

  } catch (e) {
    if (String(e?.name || "").includes("Abort")) return;
    console.error(e);
    showStatus("err", `Errore: ${String(e.message || e)}`);
  }
}

// -------------------- INIT --------------------
function initTimeChipsSync() {
  $("maxMinutes")?.addEventListener("input", () => {
    const v = Number($("maxMinutes").value);
    const chipsEl = $("timeChips");
    if (!chipsEl) return;
    const chips = [...chipsEl.querySelectorAll(".chip")];
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
        setOrigin({
          label: o.label,
          lat: o.lat,
          lon: o.lon,
          country_code: o.country_code || ""
        });
      }
    } catch {}
  }
}

function bindOriginButtons() {
  $("btnUseGPS")?.addEventListener("click", () => {
    if ($("originStatus")) $("originStatus").textContent = "📍 Sto leggendo il GPS…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        setOrigin({ label: "La mia posizione", lat, lon, country_code: "" });
        showStatus("ok", "Partenza GPS impostata ✅");
      },
      (err) => {
        console.error(err);
        if ($("originStatus")) $("originStatus").textContent = "❌ GPS non disponibile (permessi?)";
        showStatus("err", "GPS non disponibile. Scrivi un luogo e usa “Usa questo luogo”.");
      },
      { enableHighAccuracy: true, timeout: 12000 }
    );
  });

  $("btnFindPlace")?.addEventListener("click", async () => {
    try {
      const label = $("originLabel")?.value || "";
      if ($("originStatus")) $("originStatus").textContent = "🔎 Cerco il luogo…";

      const result = await geocodeLabel(label);

      setOrigin({
        label: result.label || label,
        lat: result.lat,
        lon: result.lon,
        country_code: result.country_code || ""
      });

      showStatus("ok", "Partenza impostata ✅");
    } catch (e) {
      console.error(e);
      if ($("originStatus")) $("originStatus").textContent = `❌ ${String(e.message || e)}`;
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

hideStatus();
