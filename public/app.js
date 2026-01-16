/* Jamo — app.js v20.0 (FULL)
 * Mobile-first • Offline-first (dataset in /public/data/...)
 *
 * OBIETTIVO:
 * - Stessa logica per TUTTE le categorie:
 *   1) Regione+Categoria (PRIMA)  -> solo dentro regione
 *   2) Regione Core (riempimento) -> solo dentro regione
 *   3) Radius Categoria (fuori regione ma vicino)
 *   4) Macro paese / fallback (ultimissimo)
 *
 * NOTE:
 * - NO GPS
 * - Italia: regione da it-regions-index.json (bbox)
 * - Fuori regione: OK solo dopo aver provato dentro regione (o per riempire se pochi)
 * - Family: meno playground, più attrazioni vere e invernali
 */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // -------------------- CONFIG --------------------
  const CFG = {
    ROAD_FACTOR: 1.25,
    AVG_KMH: 72,
    FIXED_OVERHEAD_MIN: 8,

    RECENT_TTL_MS: 1000 * 60 * 60 * 20,
    RECENT_MAX: 160,

    OPTIONS_POOL_MAX: 80,
    ALTS_INITIAL: 7,
    ALTS_PAGE: 7,

    IT_REGIONS_INDEX_URL: "/data/pois/regions/it-regions-index.json",

    MACROS_INDEX_URL: "/data/macros/macros_index.json",
    FALLBACK_MACRO_URLS: [
      "/data/macros/euuk_country_it.json",
      "/data/macros/euuk_macro_all.json",
    ],

    LIVE_ENABLED: false,

    AFFILIATE: {
      BOOKING_AID: "",
      GYG_PARTNER_ID: "",
      VIATOR_PID: "",
      THEFORK_AFFID: "",
    },

    // Dedupe: distanza tra posti con stesso nome
    CLONE_KM: 2.2,

    // Family tuning
    FAMILY_PLAYGROUND_MAX_SHARE: 0.18, // max ~18% di playground nelle opzioni
    MIN_GOOD_OPTIONS_IN_REGION: 14,    // se dentro regione trovi meno di così, allora riempi con fuori regione
  };

  // -------------------- STATE --------------------
  let SESSION_SEEN = new Set();
  let LAST_SHOWN_PID = null;

  let SEARCH_TOKEN = 0;
  let SEARCH_ABORT = null;

  let MACROS_INDEX = null;
  let IT_REGIONS_INDEX = null;

  // Nota: ora gestiamo più "pool" e non un solo dataset
  let REGION_ID = "";
  let REGION_ITEM = null;

  let ALL_OPTIONS = [];
  let VISIBLE_ALTS = 0;
  let CURRENT_CHOSEN = null;

  // cache semplice per file json caricati
  const FILE_CACHE = new Map();

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

  function estCarMinutesFromKm(km) {
    if (!Number.isFinite(km)) return NaN;
    const roadKm = km * CFG.ROAD_FACTOR;
    const driveMin = (roadKm / CFG.AVG_KMH) * 60;
    return Math.round(clamp(driveMin + CFG.FIXED_OVERHEAD_MIN, 6, 900));
  }

  function fmtKm(km) { return `${Math.round(km)} km`; }

  function normName(s) {
    return String(s ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function safeIdFromPlace(p) {
    if (p && p.id) return String(p.id);
    const nm = normName(p && p.name);
    const lat = String(p && p.lat != null ? p.lat : "").slice(0, 8);
    const lon = String(p && (p.lon != null ? p.lon : p.lng != null ? p.lng : "")).slice(0, 8);
    return `p_${nm || "x"}_${lat}_${lon}`;
  }

  function withinBBox(lat, lon, bbox) {
    if (!bbox) return false;
    return lat >= bbox.minLat && lat <= bbox.maxLat && lon >= bbox.minLon && lon <= bbox.maxLon;
  }

  function isWinterNow() {
    const m = new Date().getMonth() + 1;
    return (m === 11 || m === 12 || m === 1 || m === 2 || m === 3);
  }
  function isSummerNow() {
    const m = new Date().getMonth() + 1;
    return (m === 6 || m === 7 || m === 8 || m === 9);
  }

  function scrollToId(id) {
    const el = $(id);
    if (!el) return;
    setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "start" }), 30);
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function injectMiniCssOnce() {
    if (document.getElementById("jamo-mini-css")) return;
    const st = document.createElement("style");
    st.id = "jamo-mini-css";
    st.textContent = `
      .moreBtn{width:100%; border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.04); color:#fff; border-radius:16px; padding:12px; font-weight:950; cursor:pointer;}
      .btnDanger{background:rgba(255,90,90,.12); border:1px solid rgba(255,90,90,.25); color:#fff;}
      .pill2{display:inline-flex; align-items:center; gap:6px; padding:6px 10px; border-radius:999px; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.06); font-weight:900; font-size:12px;}
      .optBtn{width:100%; text-align:left; border-radius:16px; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.04); padding:12px; margin-bottom:10px; cursor:pointer;}
      .optBtn.active{border-color:rgba(0,224,255,.30); background:rgba(0,224,255,.06);}
      .optList{margin-top:10px;}
    `;
    document.head.appendChild(st);
  }

  // -------------------- MAP STATIC --------------------
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
  function mapsDirUrl(oLat, oLon, dLat, dLon) {
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(oLat + "," + oLon)}&destination=${encodeURIComponent(dLat + "," + dLon)}&travelmode=driving`;
  }
  function stableQuery(name, area) {
    const n = String(name || "").trim();
    const a = String(area || "").trim();
    return a ? `"${n}" ${a}` : `"${n}"`;
  }
  function googleSearchUrl(q) {
    return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  }
  function googleImagesUrl(name, area) {
    return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(stableQuery(name, area))}`;
  }
  function wikiUrl(name, area) {
    const q = area ? `${name} ${area}` : name;
    return `https://it.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`;
  }
  function bookingSearchUrl(name, area) {
    const aid = CFG.AFFILIATE.BOOKING_AID && CFG.AFFILIATE.BOOKING_AID.trim();
    if (!aid) return googleSearchUrl(`${stableQuery(name, area)} hotel spa terme`);
    return `https://www.booking.com/searchresults.it.html?aid=${encodeURIComponent(aid)}&ss=${encodeURIComponent(`${name} ${area || ""}`)}`;
  }
  function gygSearchUrl(name, area) {
    const pid = CFG.AFFILIATE.GYG_PARTNER_ID && CFG.AFFILIATE.GYG_PARTNER_ID.trim();
    if (!pid) return googleSearchUrl(`${stableQuery(name, area)} biglietti prenota tour`);
    return `https://www.getyourguide.com/s/?partner_id=${encodeURIComponent(pid)}&q=${encodeURIComponent(`${name} ${area || ""}`)}`;
  }
  function theforkSearchUrl(name, area, lat, lon) {
    const aff = CFG.AFFILIATE.THEFORK_AFFID && CFG.AFFILIATE.THEFORK_AFFID.trim();
    const q = `ristoranti vicino ${name} ${area || ""}`.trim();
    if (!aff) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}&center=${encodeURIComponent(lat + "," + lon)}`;
    return googleSearchUrl(q);
  }

  // -------------------- ORIGIN STORAGE --------------------
  function setOrigin({ label, lat, lon, country_code }) {
    if ($("originLabel")) $("originLabel").value = label ?? "";
    if ($("originLat")) $("originLat").value = String(lat);
    if ($("originLon")) $("originLon").value = String(lon);

    const cc = String(country_code || "").toUpperCase();
    if ($("originCC")) $("originCC").value = cc;

    localStorage.setItem("jamo_origin", JSON.stringify({ label, lat, lon, country_code: cc }));

    if ($("originStatus")) {
      $("originStatus").textContent =
        `✅ Partenza impostata: ${label || "posizione"} (${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)})${cc ? " • " + cc : ""}`;
    }

    collapseOriginCard(true);
  }

  function clearOrigin({ keepLabel = false } = {}) {
    localStorage.removeItem("jamo_origin");
    if ($("originLat")) $("originLat").value = "";
    if ($("originLon")) $("originLon").value = "";
    if ($("originCC")) $("originCC").value = "";
    if (!keepLabel && $("originLabel")) $("originLabel").value = "";
    if ($("originStatus")) $("originStatus").textContent = "📍 Inserisci un luogo di partenza.";
    REGION_ID = "";
    REGION_ITEM = null;
    CURRENT_CHOSEN = null;
    ALL_OPTIONS = [];
    VISIBLE_ALTS = 0;
    renderEmptyResult();
  }

  function getOrigin() {
    const lat = Number($("originLat") && $("originLat").value);
    const lon = Number($("originLon") && $("originLon").value);
    const label = ($("originLabel") ? $("originLabel").value : "").trim();
    const ccDom = String($("originCC") ? $("originCC").value : "").toUpperCase();

    if (Number.isFinite(lat) && Number.isFinite(lon)) return { label, lat, lon, country_code: ccDom };

    const raw = localStorage.getItem("jamo_origin");
    if (raw) {
      try {
        const o = JSON.parse(raw);
        if (Number.isFinite(Number(o && o.lat)) && Number.isFinite(Number(o && o.lon))) {
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

  function collapseOriginCard(shouldCollapse) {
    const card = $("quickStartCard");
    if (!card) return;

    if (!card.dataset.collapseReady) {
      card.dataset.collapseReady = "1";

      const header = document.createElement("button");
      header.type = "button";
      header.id = "originToggle";
      header.className = "btnGhost";
      header.style.width = "100%";
      header.style.justifyContent = "space-between";
      header.style.marginBottom = "10px";
      header.innerHTML = `<span>📍 Partenza</span><span id="originToggleIcon">⬇️</span>`;
      card.insertBefore(header, card.firstChild);

      header.addEventListener("click", () => {
        const collapsed = card.classList.toggle("collapsed");
        const icon = $("originToggleIcon");
        if (icon) icon.textContent = collapsed ? "⬆️" : "⬇️";
        if (!collapsed) scrollToId("quickStartCard");
      });

      // Bottone reset partenza
      const swap = document.createElement("button");
      swap.type = "button";
      swap.id = "btnChangeOrigin";
      swap.className = "btn btnDanger";
      swap.style.width = "100%";
      swap.style.marginTop = "10px";
      swap.textContent = "🔄 Cambia partenza";
      card.appendChild(swap);

      swap.addEventListener("click", () => {
        clearOrigin({ keepLabel: false });
        card.classList.remove("collapsed");
        const icon2 = $("originToggleIcon");
        if (icon2) icon2.textContent = "⬇️";
        scrollToId("quickStartCard");
        showStatus("ok", "Ok! Inserisci una nuova partenza e premi “Usa questo luogo”.");
      });
    }

    if (typeof shouldCollapse === "boolean") {
      card.classList.toggle("collapsed", shouldCollapse);
      const icon = $("originToggleIcon");
      if (icon) icon.textContent = shouldCollapse ? "⬆️" : "⬇️";
    }
  }

  function restoreOrigin() {
    const raw = localStorage.getItem("jamo_origin");
    if (!raw) return;
    try {
      const o = JSON.parse(raw);
      if (Number.isFinite(Number(o && o.lat)) && Number.isFinite(Number(o && o.lon))) {
        setOrigin({ label: o.label, lat: o.lat, lon: o.lon, country_code: o.country_code || "" });
        collapseOriginCard(true);
      }
    } catch {}
  }

  // -------------------- VISITED + RECENT --------------------
  function getVisitedSet() {
    const raw = localStorage.getItem("jamo_visited");
    if (!raw) return new Set();
    try { return new Set(JSON.parse(raw) || []); } catch { return new Set(); }
  }
  function saveVisitedSet(set) { localStorage.setItem("jamo_visited", JSON.stringify([...set])); }
  function markVisited(placeId) { const s = getVisitedSet(); s.add(placeId); saveVisitedSet(s); }
  function resetVisited() { localStorage.removeItem("jamo_visited"); }

  function loadRecent() {
    const raw = localStorage.getItem("jamo_recent");
    if (!raw) return [];
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  function saveRecent(list) { localStorage.setItem("jamo_recent", JSON.stringify(list.slice(0, CFG.RECENT_MAX))); }
  function cleanupRecent(list) {
    const t = Date.now();
    return list.filter(x => x && x.pid && (t - (x.ts || 0) <= CFG.RECENT_TTL_MS));
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

  // -------------------- UI HELPERS --------------------
  function showStatus(type, text) {
    const box = $("statusBox");
    const t = $("statusText");
    if (!box || !t) return;
    t.textContent = text;
    box.style.display = "block";
    box.style.borderColor =
      type === "ok" ? "rgba(26,255,213,.35)" :
      type === "err" ? "rgba(255,90,90,.40)" :
      "rgba(255,180,80,.40)";
  }
  function hideStatus() {
    const box = $("statusBox");
    const t = $("statusText");
    if (!box || !t) return;
    box.style.display = "none";
    t.textContent = "";
  }

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

  function initTimeChipsSync() {
    const maxMinutes = $("maxMinutes");
    if (!maxMinutes) return;
    maxMinutes.addEventListener("input", () => {
      const v = Number(maxMinutes.value);
      const chipsEl = $("timeChips");
      if (!chipsEl) return;
      const chips = [...chipsEl.querySelectorAll(".chip")];
      chips.forEach(c => c.classList.remove("active"));
      const match = chips.find(c => Number(c.dataset.min) === v);
      if (match) match.classList.add("active");
    });
  }

  function getActiveCategory() {
    const el = $("categoryChips");
    const active = el ? el.querySelector(".chip.active") : null;
    return (active && active.dataset && active.dataset.cat) ? active.dataset.cat : "ovunque";
  }

  function getActiveStyles() {
    const el = $("styleChips");
    const actives = [...(el ? el.querySelectorAll(".chip.active") : [])].map(c => c.dataset.style);
    return { wantChicche: actives.includes("chicche"), wantClassici: actives.includes("classici") };
  }

  // -------------------- FETCH JSON + CACHE --------------------
  async function fetchJson(url, { signal } = {}) {
    const r = await fetch(url, { cache: "no-store", signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }

  async function loadPlacesFile(url, signal) {
    const u = String(url || "").trim();
    if (!u) return null;
    if (FILE_CACHE.has(u)) return FILE_CACHE.get(u);

    try {
      const r = await fetch(u, { cache: "no-store", signal });
      if (!r.ok) { FILE_CACHE.set(u, null); return null; }
      const j = await r.json().catch(() => null);
      if (!j) { FILE_CACHE.set(u, null); return null; }
      const placesRaw = Array.isArray(j.places) ? j.places : null;
      if (!placesRaw || !placesRaw.length) { FILE_CACHE.set(u, null); return null; }
      const places = placesRaw.map(normalizePlace).filter(Boolean);
      if (!places.length) { FILE_CACHE.set(u, null); return null; }

      const out = { url: u, json: j, places };
      FILE_CACHE.set(u, out);
      return out;
    } catch {
      FILE_CACHE.set(u, null);
      return null;
    }
  }

  // -------------------- NORMALIZATION --------------------
  function normalizeVisibility(v) {
    const raw = String(v ?? "").trim();
    if (!raw) return "unknown";
    const s = raw.toLowerCase().trim();
    if (s === "chicca") return "chicca";
    if (s === "classica") return "classica";
    return "unknown";
  }

  function normalizeType(t) {
    const s = String(t || "").toLowerCase().trim();
    if (!s) return "";
    if (s === "borgo" || s === "borghi") return "borghi";
    if (s === "città" || s === "citta") return "citta";
    if (s === "panorami") return "viewpoints";
    if (s === "trekking") return "hiking";
    return s;
  }

  function normalizePlace(p) {
    if (!p) return null;
    const lat = Number(p.lat);
    const lon = Number(p.lon != null ? p.lon : p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const out = { ...p };
    out.lat = lat;
    out.lon = lon;
    out.name = String(out.name || "").trim();

    out.type = normalizeType(out.type || out.primary_category || out.category || "");
    out.visibility = normalizeVisibility(out.visibility);

    out.tags = Array.isArray(out.tags) ? out.tags.map(x => String(x).toLowerCase()) : [];
    out.country = String(out.country || "").toUpperCase();
    out.area = String(out.area || "");
    return out;
  }

  // -------------------- IT REGIONS INDEX --------------------
  async function loadItalyRegionsIndexSafe(signal) {
    try { IT_REGIONS_INDEX = await fetchJson(CFG.IT_REGIONS_INDEX_URL, { signal }); }
    catch { IT_REGIONS_INDEX = null; }
    return IT_REGIONS_INDEX;
  }

  function pickItalyRegionByOrigin(origin) {
    const lat = Number(origin && origin.lat);
    const lon = Number(origin && origin.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { id: "", item: null };
    if (!IT_REGIONS_INDEX || !Array.isArray(IT_REGIONS_INDEX.items)) return { id: "", item: null };

    for (const r of IT_REGIONS_INDEX.items) {
      if (!r || !r.bbox) continue;
      if (withinBBox(lat, lon, r.bbox)) return { id: String(r.id || ""), item: r };
    }
    return { id: "", item: null };
  }

  // -------------------- MACROS INDEX --------------------
  async function loadMacrosIndexSafe(signal) {
    try { MACROS_INDEX = await fetchJson(CFG.MACROS_INDEX_URL, { signal }); }
    catch { MACROS_INDEX = null; }
    return MACROS_INDEX;
  }

  function findCountryMacroPathRobust(cc) {
    if (!MACROS_INDEX || !Array.isArray(MACROS_INDEX.items)) return null;
    const c = String(cc || "").toUpperCase();
    if (!c) return null;

    for (const x of MACROS_INDEX.items) {
      const id = String(x && x.id || "");
      const p = String(x && x.path || "");
      if (id === `euuk_country_${c.toLowerCase()}`) return p || null;
      if (p.includes(`euuk_country_${c.toLowerCase()}.json`)) return p || null;
    }
    return null;
  }

  // -------------------- CATEGORIES CANON --------------------
  function canonicalCategory(catUI) {
    const c = String(catUI || "").toLowerCase().trim();
    if (!c || c === "ovunque") return "core";
    if (c === "panorami") return "viewpoints";
    if (c === "trekking") return "hiking";
    if (c === "città" || c === "city") return "citta";
    return c;
  }

  // -------------------- GEOCODING --------------------
  async function geocodeLabel(label) {
    const q = String(label || "").trim();
    if (!q) throw new Error("Scrivi un luogo (es: Verona, L'Aquila, Roma...)");
    const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { method: "GET", cache: "no-store" });
    const j = await r.json().catch(() => null);
    if (!j) throw new Error("Geocoding fallito (risposta vuota)");
    if (!j.ok) throw new Error(j.error || "Geocoding fallito");
    if (!j.result || !Number.isFinite(Number(j.result.lat)) || !Number.isFinite(Number(j.result.lon))) {
      throw new Error("Geocoding fallito (coordinate non valide)");
    }
    return j.result;
  }

  // -------------------- TAGS / FILTERS --------------------
  function placeTags(place) { return (place && place.tags ? place.tags : []).map(t => String(t).toLowerCase()); }
  function tagsStr(place) { return placeTags(place).join(" "); }

  function hasAny(str, arr) {
    for (const k of arr) if (str.includes(k)) return true;
    return false;
  }

  // Anti-spazzatura duro
  function isClearlyIrrelevantPlace(place) {
    const t = tagsStr(place);
    const n = normName(place && place.name);

    if (hasAny(t, [
      "highway=", "railway=", "public_transport=", "route=", "junction=",
      "amenity=bus_station", "highway=bus_stop", "highway=platform",
      "railway=station", "railway=halt", "railway=tram_stop"
    ])) return true;

    if (hasAny(t, [
      "amenity=parking", "amenity=parking_entrance", "amenity=parking_space",
      "highway=rest_area", "amenity=fuel", "amenity=charging_station"
    ])) return true;

    if (hasAny(t, [
      "landuse=industrial", "landuse=commercial", "building=industrial",
      "building=warehouse", "building=office", "man_made=works"
    ])) return true;

    if (hasAny(t, [
      "man_made=survey_point", "power=", "telecom=", "pipeline=",
      "boundary=", "place=locality"
    ])) return true;

    if (hasAny(n, [
      "parcheggio", "stazione", "fermata", "svincolo", "uscita", "km ",
      "cabina", "impianto", "linea", "tratto"
    ])) return true;

    // azienda/brand non turistici
    const looksCompany = (n.endsWith(" spa") || n.includes(" s p a") || n.includes(" s.p.a") || n.includes(" azienda "));
    const looksWellness = hasAny(n, ["terme","spa","wellness","termale","thermal"]);
    if (looksCompany && !looksWellness) return true;

    return false;
  }

  function looksWellnessByName(place) {
    const n = normName(place && place.name);
    return hasAny(n, [
      "terme","termale","thermal","spa","wellness","benessere","hammam","hamam",
      "bagno turco","sauna","piscine termali","acqua termale","idroterapia"
    ]);
  }

  function looksKidsByName(place) {
    const n = normName(place && place.name);
    return hasAny(n, [
      "bambin","kids","family","ragazzi","ludoteca","infanzia","junior",
      "museo dei bambini","children","science center","planetario","acquario","zoo",
      "fattoria didattica","didattica","baby","bimbi","indoor playground","gonfiabili"
    ]);
  }

  function isSpaPlace(place) {
    const t = tagsStr(place);
    const nm = normName(place && place.name);

    const spaTags =
      t.includes("amenity=spa") || t.includes("leisure=spa") || t.includes("tourism=spa") ||
      t.includes("natural=hot_spring") || t.includes("amenity=public_bath") ||
      t.includes("amenity=sauna") || t.includes("leisure=sauna") ||
      t.includes("healthcare=sauna") || t.includes("healthcare=spa") ||
      t.includes("bath:type=thermal") ||
      t.includes("thermal") || t.includes("terme");

    const spaName = looksWellnessByName(place);

    const poolSpaLike =
      t.includes("leisure=swimming_pool") && (
        nm.includes("terme") || nm.includes("spa") || nm.includes("thermal") ||
        nm.includes("benessere") || nm.includes("wellness")
      );

    return spaTags || spaName || poolSpaLike;
  }

  function isMuseum(place) { return tagsStr(place).includes("tourism=museum"); }
  function isAttraction(place) { return tagsStr(place).includes("tourism=attraction"); }

  function isChurchOrCathedral(place) {
    const t = tagsStr(place);
    return t.includes("amenity=place_of_worship") || t.includes("building=church") || t.includes("historic=church");
  }

  function isCastleLike(place) {
    const t = tagsStr(place);
    return t.includes("historic=castle") || t.includes("historic=fort") || t.includes("historic=fortress");
  }

  function isArchaeology(place) {
    const t = tagsStr(place);
    return t.includes("historic=archaeological_site") || t.includes("site_type=archaeological");
  }

  function isMonument(place) {
    const t = tagsStr(place);
    return t.includes("historic=monument") || t.includes("historic=memorial") || t.includes("tourism=artwork");
  }

  function isSquare(place) {
    const t = tagsStr(place);
    const n = normName(place && place.name);
    // piazze "famose": le prendiamo solo se hanno name decente o tag tourism
    return (t.includes("place=square") || n.startsWith("piazza ")) && (n.length >= 8);
  }

  function isRealViewpoint(place) {
    const t = tagsStr(place);
    return t.includes("tourism=viewpoint") || t.includes("man_made=observation_tower") || t.includes("tower:type=observation");
  }

  function isHiking(place) {
    const t = tagsStr(place);
    const type = normalizeType(place && place.type);

    if (type === "hiking") return true;
    if (t.includes("tourism=alpine_hut") || t.includes("amenity=shelter")) return true;

    // guidepost: solo se sembra sentiero vero
    if (t.includes("information=guidepost")) {
      const n = String(place && place.name || "").trim();
      if (!n || n.length < 6) return false;
      const nn = normName(n);
      return (nn.includes("sentier") || nn.includes("cai") || nn.includes("anello") || nn.includes("trail"));
    }
    return false;
  }

  function isMountain(place) {
    const t = tagsStr(place);
    if (t.includes("place=city") || t.includes("place=town") || t.includes("place=village") || t.includes("place=hamlet")) return false;
    return (
      normalizeType(place && place.type) === "montagna" ||
      t.includes("natural=peak") || t.includes("natural=saddle") ||
      t.includes("tourism=alpine_hut") || t.includes("amenity=shelter") ||
      t.includes("aerialway=") || t.includes("piste:type=")
    );
  }

  function isNature(place) {
    const t = tagsStr(place);
    const type = normalizeType(place && place.type);
    return (
      type === "natura" ||
      t.includes("natural=waterfall") ||
      t.includes("natural=spring") ||
      t.includes("natural=cave_entrance") ||
      t.includes("natural=water") || t.includes("water=lake") || t.includes("water=reservoir") ||
      t.includes("waterway=river") || t.includes("waterway=stream") || t.includes("waterway=riverbank") ||
      t.includes("leisure=nature_reserve") || t.includes("boundary=national_park") ||
      t.includes("natural=wood") || t.includes("natural=gorge")
    );
  }

  function isBorgo(place) {
    const t = tagsStr(place);
    const n = normName(place && place.name);
    const hasPlaceTag = t.includes("place=village") || t.includes("place=hamlet");
    const hasBorgoName = n.includes("borgo") || n.includes("centro storico") || n.includes("frazione");
    return normalizeType(place && place.type) === "borghi" || hasPlaceTag || hasBorgoName;
  }

  function isCity(place) {
    const t = tagsStr(place);
    const type = normalizeType(place && place.type);
    return type === "citta" || t.includes("place=city") || t.includes("place=town");
  }

  // Family “vere”
  function isThemePark(place) { return tagsStr(place).includes("tourism=theme_park"); }
  function isWaterPark(place) { return tagsStr(place).includes("leisure=water_park"); }
  function isZooOrAquarium(place) {
    const t = tagsStr(place);
    return t.includes("tourism=zoo") || t.includes("tourism=aquarium") || t.includes("amenity=aquarium");
  }
  function isAdventurePark(place) {
    const t = tagsStr(place);
    const n = normName(place && place.name);
    return (
      t.includes("leisure=adventure_park") ||
      n.includes("parco avventura") || n.includes("adventure park") ||
      n.includes("zipline") || n.includes("zip line") ||
      n.includes("percorsi sospesi")
    );
  }
  function isIceRink(place) {
    const t = tagsStr(place);
    const n = normName(place && place.name);
    return (
      t.includes("leisure=ice_rink") ||
      t.includes("sport=ice_skating") ||
      t.includes("sport=ice_hockey") ||
      n.includes("palaghiaccio") ||
      n.includes("pattinaggio")
    );
  }
  function isIndoorFun(place) {
    const t = tagsStr(place);
    const n = normName(place && place.name);
    // indoor playground / trampolini / fun center
    return (
      t.includes("leisure=indoor_play") ||
      t.includes("leisure=trampoline_park") ||
      n.includes("trampoline") ||
      n.includes("jump park") ||
      n.includes("fun center") ||
      n.includes("indoor playground") ||
      n.includes("gonfiabil")
    );
  }
  function isKidsMuseum(place) {
    const n = normName(place && place.name);
    const t = tagsStr(place);
    const kidsish = looksKidsByName(place) || n.includes("museo dei bambini") || n.includes("planetario");
    return isMuseum(place) && (kidsish || t.includes("museum=children"));
  }
  function isWinterFamily(place) {
    const t = tagsStr(place);
    const n = normName(place && place.name);
    // baby park / ski school / piste per principianti spesso taggati male -> prendiamo segnali soft
    const skiSignals = t.includes("piste:type=") || t.includes("sport=skiing") || t.includes("aerialway=");
    const babySignals = n.includes("baby park") || n.includes("snow park") || n.includes("parco neve") || n.includes("scuola sci");
    return isIceRink(place) || skiSignals || babySignals;
  }

  function isSummerThing(place) {
    const t = tagsStr(place);
    return t.includes("leisure=water_park") || t.includes("natural=beach") || t.includes("leisure=marina");
  }
  function isWinterThing(place) {
    const t = tagsStr(place);
    return t.includes("piste:type=") || t.includes("sport=skiing") || t.includes("aerialway=");
  }

  // Rimuove hotel/ristoranti normali
  function isLodgingOrFood(place, cat) {
    const t = tagsStr(place);

    const lodging =
      t.includes("tourism=hotel") || t.includes("tourism=hostel") || t.includes("tourism=guest_house") ||
      t.includes("tourism=apartment") || t.includes("tourism=camp_site") || t.includes("tourism=caravan_site") ||
      t.includes("tourism=chalet") || t.includes("tourism=motel");

    if (lodging && cat === "relax") {
      if (isSpaPlace(place) || looksWellnessByName(place)) return false;
    }

    const food =
      t.includes("amenity=restaurant") || t.includes("amenity=fast_food") || t.includes("amenity=cafe") ||
      t.includes("amenity=bar") || t.includes("amenity=pub") || t.includes("amenity=ice_cream");

    // ristoranti/food in generale fuori
    return lodging || food;
  }

  // cantine
  function isWinery(place) {
    const t = tagsStr(place);
    const n = normName(place && place.name);
    if (t.includes("craft=winery")) return true;
    if (t.includes("shop=wine")) return true;
    if (t.includes("amenity=wine_bar")) return true;
    if (hasAny(n, ["cantina","winery","vini","vino","enoteca","degustaz","wine tasting","wine tour"])) return true;
    return false;
  }

  // Playground
  function isPlayground(place) {
    const t = tagsStr(place);
    return t.includes("leisure=playground");
  }

  // -------------------- CATEGORY MATCH --------------------
  function matchesCategoryStrict(place, catUI) {
    const cat = canonicalCategory(catUI);
    if (!cat || cat === "core") return true;

    const t = tagsStr(place);
    const type = normalizeType(place && place.type);

    if (cat === "natura") return isNature(place);
    if (cat === "mare") return type === "mare" || t.includes("natural=beach") || t.includes("leisure=marina") || t.includes("natural=coastline");
    if (cat === "relax") return isSpaPlace(place);
    if (cat === "borghi") return isBorgo(place);
    if (cat === "citta") return isCity(place);
    if (cat === "viewpoints") return isRealViewpoint(place);
    if (cat === "hiking") return isHiking(place);
    if (cat === "montagna") return isMountain(place);
    if (cat === "cantine") return isWinery(place);

    if (cat === "storia") {
      // STORIA: castelli/forti + chiese/cattedrali + musei + siti archeologici + monumenti + piazze belle
      return (
        type === "storia" ||
        isCastleLike(place) ||
        isArchaeology(place) ||
        isMuseum(place) ||
        isChurchOrCathedral(place) ||
        isMonument(place) ||
        isSquare(place) ||
        (isAttraction(place) && (isCastleLike(place) || isMonument(place) || isArchaeology(place)))
      );
    }

    if (cat === "family") {
      // FAMILY: attrazioni vere + kids museum + indoor + invernali
      return (
        isThemePark(place) ||
        isWaterPark(place) ||
        isZooOrAquarium(place) ||
        isAdventurePark(place) ||
        isKidsMuseum(place) ||
        isIndoorFun(place) ||
        isIceRink(place) ||
        isWinterFamily(place) ||
        (isAttraction(place) && looksKidsByName(place)) ||
        // playground passa ma sarà limitato e penalizzato
        isPlayground(place)
      );
    }

    // default
    return true;
  }

  function matchesCategoryRelaxed(place, catUI) {
    const cat = canonicalCategory(catUI);
    if (!cat || cat === "core") return true;
    const t = tagsStr(place);
    const n = normName(place && place.name);

    if (cat === "relax") {
      return isSpaPlace(place) || t.includes("leisure=swimming_pool") || n.includes("wellness");
    }

    if (cat === "cantine") {
      return isWinery(place) || hasAny(n, ["enoteca","degustaz","wine"]);
    }

    if (cat === "storia") {
      return matchesCategoryStrict(place, "storia") || isAttraction(place) || isMuseum(place);
    }

    if (cat === "family") {
      return matchesCategoryStrict(place, "family") || isAttraction(place) || isIndoorFun(place);
    }

    return matchesCategoryStrict(place, cat);
  }

  function matchesStyle(place, { wantChicche, wantClassici }) {
    const vis = normalizeVisibility(place && place.visibility);

    if (!wantChicche && !wantClassici) return true;
    if (vis === "unknown") return true;

    if (vis === "chicca") return !!wantChicche;
    return !!wantClassici;
  }

  function matchesAnyGoodCategory(place) {
    // “Ovunque” = solo roba turistica bella
    return (
      isNature(place) ||
      isRealViewpoint(place) ||
      isHiking(place) ||
      isMountain(place) ||
      isSpaPlace(place) ||
      isBorgo(place) ||
      isCity(place) ||
      matchesCategoryStrict(place, "storia") ||
      matchesCategoryStrict(place, "family") ||
      isWinery(place) ||
      isAttraction(place) ||
      isMuseum(place)
    );
  }

  // -------------------- SCORING --------------------
  function baseScorePlace({ driveMin, targetMin, beautyScore, isChicca }) {
    const t = clamp(1 - Math.abs(driveMin - targetMin) / Math.max(18, targetMin * 0.9), 0, 1);
    const b = clamp(Number(beautyScore) || 0.72, 0.35, 1);
    const c = isChicca ? 0.06 : 0;
    return 0.62 * t + 0.32 * b + c;
  }

  function rotationPenalty(pid, recentSet) {
    let pen = 0;
    if (pid && pid === LAST_SHOWN_PID) pen += 0.22;
    if (SESSION_SEEN.has(pid)) pen += 0.18;
    if (recentSet.has(pid)) pen += 0.10;
    return pen;
  }

  function seasonAdjust(place) {
    if (isWinterNow() && isSummerThing(place)) return -0.18;
    if (isSummerNow() && isWinterThing(place)) return -0.18;

    if (isWinterNow() && isSpaPlace(place)) return +0.12;
    if (isSummerNow() && isSummerThing(place)) return +0.06;

    // Family invernale: boost in inverno
    if (isWinterNow() && isWinterFamily(place)) return +0.10;

    return 0;
  }

  function tourismBoost(place, catUI) {
    const cat = canonicalCategory(catUI);
    const t = tagsStr(place);
    const n = normName(place && place.name);

    let b = 0;

    // Boost base turistico/monetizzabile
    if (t.includes("tourism=attraction")) b += 0.14;
    if (t.includes("tourism=museum")) b += 0.13;
    if (isCastleLike(place)) b += 0.16;
    if (isArchaeology(place)) b += 0.14;
    if (isMonument(place)) b += 0.12;
    if (isRealViewpoint(place)) b += 0.12;

    // Categoria-specific boosts
    if (cat === "relax" && isSpaPlace(place)) b += 0.18;
    if (cat === "cantine" && isWinery(place)) b += 0.18;
    if (cat === "storia") {
      if (isChurchOrCathedral(place)) b += 0.10;
      if (isSquare(place)) b += 0.06;
    }
    if (cat === "family") {
      if (isThemePark(place)) b += 0.26;
      if (isWaterPark(place)) b += 0.20;
      if (isZooOrAquarium(place)) b += 0.22;
      if (isAdventurePark(place)) b += 0.16;
      if (isKidsMuseum(place)) b += 0.14;
      if (isIndoorFun(place)) b += 0.14;
      if (isIceRink(place)) b += 0.16;
      if (isWinterFamily(place)) b += 0.10;
    }

    // Penalità playground (soprattutto fuori family)
    if (isPlayground(place)) b -= (cat === "family" ? 0.22 : 0.55);

    // Penalità parchi generici non turistici
    if (t.includes("leisure=park") && !t.includes("tourism=") && !isAttraction(place)) b -= 0.08;

    // Bonus “famoso” soft (solo per spingere roba che la gente cerca)
    if (hasAny(n, ["castel", "rocca", "duomo", "basilica", "museo", "terme", "spa"])) b += 0.04;

    return b;
  }

  function widenMinutesSteps(m, categoryUI) {
    const cat = canonicalCategory(categoryUI);
    const base = clamp(Number(m) || 120, 10, 600);
    const steps = [base];

    const muls =
      cat === "family" ? [1.15, 1.30, 1.50] :
      cat === "mare"   ? [1.20, 1.40, 1.65] :
      cat === "storia" ? [1.20, 1.40, 1.60] :
      cat === "natura" ? [1.20, 1.40, 1.60] :
                         [1.20, 1.40, 1.60];

    for (const k of muls) steps.push(clamp(Math.round(base * k), base, 600));
    steps.push(clamp(Math.max(240, base), base, 600));
    return Array.from(new Set(steps)).sort((a, b) => a - b);
  }

  // -------------------- BUILD CANDIDATES (con inside/outside regione) --------------------
  function buildCandidatesFromPool(pool, origin, maxMinutes, categoryUI, styles, regionBbox, {
    ignoreVisited = false,
    ignoreRotation = false,
    relaxedCategory = false,
    forceInsideRegion = false,
    sourceLabel = "unknown"
  } = {}) {
    const visited = getVisitedSet();
    const recentSet = getRecentSet();
    const target = Number(maxMinutes);

    const oLat = Number(origin.lat);
    const oLon = Number(origin.lon);

    const candidates = [];

    for (const raw of pool) {
      const p = normalizePlace(raw);
      if (!p) continue;

      const nm = String(p.name || "").trim();
      if (!nm || nm.length < 2) continue;

      if (isClearlyIrrelevantPlace(p)) continue;

      const cat = canonicalCategory(categoryUI);
      if (isLodgingOrFood(p, cat)) continue;

      // region constraint (fase 1/2)
      const inside = regionBbox ? withinBBox(p.lat, p.lon, regionBbox) : true;
      if (forceInsideRegion && !inside) continue;

      let okCat = true;
      if (String(categoryUI) === "ovunque") {
        okCat = matchesAnyGoodCategory(p);
      } else {
        okCat = relaxedCategory
          ? matchesCategoryRelaxed(p, categoryUI)
          : matchesCategoryStrict(p, categoryUI);
      }
      if (!okCat) continue;

      if (!matchesStyle(p, styles)) continue;

      const pid = safeIdFromPlace(p);
      if (!ignoreVisited && visited.has(pid)) continue;

      const km = haversineKm(oLat, oLon, p.lat, p.lon);
      const driveMin = estCarMinutesFromKm(km);
      if (!Number.isFinite(driveMin) || driveMin > target) continue;

      if (km < (cat === "family" ? 1.0 : 1.6)) continue;

      const isChicca = normalizeVisibility(p.visibility) === "chicca";
      let s = baseScorePlace({ driveMin, targetMin: target, beautyScore: p.beauty_score, isChicca });

      s += seasonAdjust(p);
      s += tourismBoost(p, categoryUI);

      if (!ignoreRotation) s -= rotationPenalty(pid, recentSet);

      candidates.push({
        place: p,
        pid,
        km,
        driveMin,
        score: Number(s.toFixed(4)),
        inside_region: !!inside,
        source: sourceLabel
      });
    }

    candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
    return candidates;
  }

  function dedupeDiverse(list) {
    const out = [];
    const seenPid = new Set();
    const seenNameBuckets = new Map();

    for (const x of list) {
      if (!x || !x.pid) continue;
      if (seenPid.has(x.pid)) continue;

      const p = x.place;
      const nkey = normName(p && p.name);
      const lat = Number(p && p.lat);
      const lon = Number(p && p.lon);

      let tooCloseSameName = false;
      if (nkey) {
        const bucket = seenNameBuckets.get(nkey) || [];
        for (const b of bucket) {
          const d = haversineKm(lat, lon, b.lat, b.lon);
          if (d < CFG.CLONE_KM) { tooCloseSameName = true; break; }
        }
        if (!tooCloseSameName) {
          bucket.push({ lat, lon });
          seenNameBuckets.set(nkey, bucket);
        }
      }

      if (tooCloseSameName) continue;

      seenPid.add(x.pid);
      out.push(x);
    }

    return out;
  }

  function limitPlaygroundsIfFamily(list, categoryUI) {
    if (canonicalCategory(categoryUI) !== "family") return list;
    if (!Array.isArray(list) || !list.length) return list;

    const maxPlay = Math.max(1, Math.round(list.length * CFG.FAMILY_PLAYGROUND_MAX_SHARE));

    const good = [];
    const plays = [];
    for (const x of list) {
      if (isPlayground(x && x.place)) plays.push(x);
      else good.push(x);
    }
    return good.concat(plays.slice(0, maxPlay));
  }

  // -------------------- DATA PLAN (stessa logica per tutte categorie) --------------------
  function buildFilePlan(regionId, categoryUI, originCC) {
    const cat = canonicalCategory(categoryUI);

    const plan = [];

    // 1) Regione+Categoria (dentro regione)
    if (regionId) {
      if (cat !== "core") plan.push({ url: `/data/pois/regions/${regionId}-${cat}.json`, label: `REGION:${regionId}-${cat}`, forceInside: true });
      plan.push({ url: `/data/pois/regions/${regionId}.json`, label: `REGION:${regionId}:core`, forceInside: true });
    }

    // 2) Radius (fuori regione vicino)
    if (cat !== "core") plan.push({ url: `/data/pois/regions/radius-${cat}.json`, label: `RADIUS:${cat}`, forceInside: false });

    // 3) Macro paese / fallback
    const cc = String(originCC || "").toUpperCase() || "IT";
    const countryMacro = findCountryMacroPathRobust(cc);
    if (countryMacro) plan.push({ url: countryMacro, label: `MACRO:country:${cc}`, forceInside: false });
    for (const u of CFG.FALLBACK_MACRO_URLS) plan.push({ url: u, label: `MACRO:fallback`, forceInside: false });

    // 4) Macro salvato (ultimissimo)
    const savedMacro = localStorage.getItem("jamo_macro_url");
    if (savedMacro) plan.push({ url: savedMacro, label: `MACRO:saved`, forceInside: false });

    // uniq per url
    const out = [];
    const seen = new Set();
    for (const x of plan) {
      if (!x || !x.url) continue;
      if (seen.has(x.url)) continue;
      seen.add(x.url);
      out.push(x);
    }
    return out;
  }

  // -------------------- PICK OPTIONS (regione prima, poi fuori) --------------------
  async function pickOptionsWithRegionFirst(origin, maxMinutes, categoryUI, styles, signal) {
    const steps = widenMinutesSteps(maxMinutes, categoryUI);

    // prepara region id/bbox
    await loadItalyRegionsIndexSafe(signal);
    await loadMacrosIndexSafe(signal);

    const picked = pickItalyRegionByOrigin(origin);
    REGION_ID = picked.id || "";
    REGION_ITEM = picked.item || null;

    const regionBbox = REGION_ITEM && REGION_ITEM.bbox ? REGION_ITEM.bbox : null;

    const filePlan = buildFilePlan(REGION_ID, categoryUI, origin && origin.country_code);

    let usedMinutes = steps[0];
    let usedFallback = false;

    for (const mins of steps) {
      usedMinutes = mins;

      // 1) Prima: solo inside regione (region-cat + region-core)
      let insideAll = [];
      for (const fp of filePlan) {
        if (!fp.forceInside) continue;
        const loaded = await loadPlacesFile(fp.url, signal);
        if (!loaded) continue;

        const strictList = buildCandidatesFromPool(
          loaded.places, origin, mins, categoryUI, styles, regionBbox,
          { ignoreVisited:false, ignoreRotation:false, relaxedCategory:false, forceInsideRegion:true, sourceLabel: fp.label }
        );
        if (strictList.length) insideAll = insideAll.concat(strictList);
      }
      insideAll = dedupeDiverse(insideAll);
      insideAll = limitPlaygroundsIfFamily(insideAll, categoryUI);

      // se abbiamo abbastanza dentro regione, stop qui
      if (insideAll.length >= CFG.MIN_GOOD_OPTIONS_IN_REGION) {
        insideAll.sort((a,b)=> (b.score-a.score) || (a.driveMin-b.driveMin));
        return { list: insideAll, usedMinutes, usedFallback:false, regionId: REGION_ID, regionName: REGION_ITEM ? REGION_ITEM.name : "" };
      }

      // 2) Se pochi dentro regione: RIEMPI con fuori regione (radius + macro)
      let outsideAll = [];
      for (const fp of filePlan) {
        if (fp.forceInside) continue;
        const loaded = await loadPlacesFile(fp.url, signal);
        if (!loaded) continue;

        // tentativi: strict -> no rotation -> relaxed
        let out = buildCandidatesFromPool(
          loaded.places, origin, mins, categoryUI, styles, regionBbox,
          { ignoreVisited:false, ignoreRotation:false, relaxedCategory:false, forceInsideRegion:false, sourceLabel: fp.label }
        );

        if (!out.length) {
          out = buildCandidatesFromPool(
            loaded.places, origin, mins, categoryUI, styles, regionBbox,
            { ignoreVisited:false, ignoreRotation:true, relaxedCategory:false, forceInsideRegion:false, sourceLabel: fp.label }
          );
        }
        if (!out.length) {
          out = buildCandidatesFromPool(
            loaded.places, origin, mins, categoryUI, styles, regionBbox,
            { ignoreVisited:false, ignoreRotation:true, relaxedCategory:true, forceInsideRegion:false, sourceLabel: fp.label }
          );
          if (out.length) usedFallback = true;
        }

        if (out.length) outsideAll = outsideAll.concat(out);

        // salva macro buono (se è macro)
        if (loaded.url && fp.label.startsWith("MACRO:") && out.length) {
          localStorage.setItem("jamo_macro_url", loaded.url);
        }
      }

      // Merge: dentro regione sempre prima (ma non blocchiamo fuori)
      let merged = insideAll.concat(outsideAll);
      merged = dedupeDiverse(merged);
      merged = limitPlaygroundsIfFamily(merged, categoryUI);

      // Se ancora nulla, proviamo super-relaxed ignorando visitati (solo come ultima spiaggia)
      if (!merged.length) {
        for (const fp of filePlan) {
          const loaded = await loadPlacesFile(fp.url, signal);
          if (!loaded) continue;
          const out = buildCandidatesFromPool(
            loaded.places, origin, mins, categoryUI, styles, regionBbox,
            { ignoreVisited:true, ignoreRotation:true, relaxedCategory:true, forceInsideRegion: !!fp.forceInside, sourceLabel: fp.label }
          );
          merged = merged.concat(out);
        }
        merged = dedupeDiverse(merged);
        merged = limitPlaygroundsIfFamily(merged, categoryUI);
        if (merged.length) usedFallback = true;
      }

      if (merged.length) {
        // Ordine finale: prima inside_region, poi score
        merged.sort((a,b)=> {
          const ai = a.inside_region ? 1 : 0;
          const bi = b.inside_region ? 1 : 0;
          if (bi !== ai) return (bi - ai); // inside prima
          return (b.score - a.score) || (a.driveMin - b.driveMin);
        });
        return { list: merged, usedMinutes, usedFallback, regionId: REGION_ID, regionName: REGION_ITEM ? REGION_ITEM.name : "" };
      }
    }

    return { list: [], usedMinutes, usedFallback, regionId: REGION_ID, regionName: REGION_ITEM ? REGION_ITEM.name : "" };
  }

  // -------------------- COPY / UI --------------------
  function typeBadge(categoryUI) {
    const c = String(categoryUI || "");
    const map = {
      natura: { emoji:"🌿", label:"Natura" },
      family: { emoji:"👨‍👩‍👧‍👦", label:"Family" },
      storia: { emoji:"🏛️", label:"Storia" },
      montagna:{ emoji:"🏔️", label:"Montagna" },
      mare:   { emoji:"🌊", label:"Mare" },
      relax:  { emoji:"🧖", label:"Relax" },
      borghi: { emoji:"🏘️", label:"Borghi" },
      citta:  { emoji:"🏙️", label:"Città" },
      cantine:{ emoji:"🍷", label:"Cantine" },
      panorami:{ emoji:"🌅", label:"Panorami" },
      trekking:{ emoji:"🥾", label:"Trekking" },
      ovunque:{ emoji:"🎲", label:"Meta" },
    };
    return map[c] || { emoji:"📍", label:"Meta" };
  }

  function visibilityLabel(place) {
    const v = normalizeVisibility(place && place.visibility);
    if (v === "chicca") return "✨ chicca";
    if (v === "classica") return "✅ classica";
    return "⭐ selezione";
  }

  function regionLabelShort() {
    if (!REGION_ITEM) return "Regione: (non rilevata)";
    return `Regione: ${REGION_ITEM.name} (${REGION_ID})`;
  }

  function shortWhatIs(place, categoryUI) {
    const cat = canonicalCategory(categoryUI);
    const t = tagsStr(place);

    if (cat === "cantine") return "Cantina/Enoteca • degustazioni e visite (prenotazione consigliata).";
    if (cat === "relax") return "Relax • terme/spa/sauna (spesso su prenotazione).";
    if (cat === "borghi") return "Borgo • centro storico, scorci e foto.";
    if (cat === "citta") return "Città • centro, musei e monumenti.";
    if (cat === "viewpoints") return "Panorama vero • ottimo al tramonto.";
    if (cat === "hiking") return "Trekking • controlla meteo e sentiero.";
    if (cat === "montagna") return "Montagna • meteo importante.";
    if (cat === "mare") return "Mare • spiaggia/marina, stagione consigliata.";

    if (cat === "storia") {
      if (isCastleLike(place)) return "Castello/Rocca/Forte • spesso visitabile (biglietti).";
      if (isChurchOrCathedral(place)) return "Chiesa/Cattedrale • visita (orari).";
      if (isArchaeology(place)) return "Sito archeologico • visita (orari/biglietti).";
      if (isMuseum(place)) return "Museo • visita (biglietti).";
      if (isMonument(place)) return "Monumento • spot turistico.";
      if (isSquare(place)) return "Piazza/centro storico • perfetta per passeggio e foto.";
      if (isAttraction(place)) return "Attrazione storica • info e biglietti.";
      return "Luogo storico • verifica orari/mostre.";
    }

    if (cat === "family") {
      if (isThemePark(place)) return "Parco divertimenti • biglietti/orari (top monetizzazione).";
      if (isWaterPark(place)) return "Acquapark • biglietti/orari (stagionale).";
      if (isZooOrAquarium(place)) return "Zoo/Acquario • perfetto per famiglie.";
      if (isAdventurePark(place)) return "Parco avventura • percorsi sospesi, zipline.";
      if (isKidsMuseum(place)) return "Museo kids-friendly • spesso interattivo.";
      if (isIndoorFun(place)) return "Indoor fun • trampolini/giochi al coperto.";
      if (isIceRink(place)) return "Palaghiaccio • attività invernale family.";
      if (isWinterFamily(place)) return "Attrazione invernale • ideale con bambini.";
      if (isPlayground(place)) return "Parco giochi • opzione easy (meno prioritaria).";
      return "Family • esperienza adatta ai bambini.";
    }

    if (cat === "natura") {
      if (t.includes("natural=waterfall")) return "Cascata • ideale per foto e passeggiata.";
      if (t.includes("natural=cave_entrance")) return "Grotta • verifica accesso e sicurezza.";
      if (t.includes("water=lake") || t.includes("natural=water")) return "Lago / acqua • relax e foto.";
      if (t.includes("boundary=national_park") || t.includes("leisure=nature_reserve")) return "Parco / riserva • trekking leggero e foto.";
      return "Spot naturalistico • perfetto per uscita veloce.";
    }

    // ovunque
    if (isCastleLike(place)) return "Castello/Rocca/Forte • spesso visitabile.";
    if (isMuseum(place)) return "Museo • visita (biglietti).";
    if (isAttraction(place)) return "Attrazione • spot turistico.";
    if (isSpaPlace(place)) return "Relax • terme/spa.";
    if (isWinery(place)) return "Cantina/Enoteca • degustazioni.";
    if (isNature(place)) return "Natura • lago/cascata/gola/riserva.";
    if (isBorgo(place)) return "Borgo • centro storico e scorci.";
    if (isCity(place)) return "Città • centro, musei e monumenti.";
    if (isRealViewpoint(place)) return "Panorama vero • ottimo al tramonto.";
    return "Meta consigliata in base a tempo e categoria.";
  }

  // -------------------- RENDER --------------------
  function renderEmptyResult() {
    const area = $("resultArea");
    if (!area) return;
    area.innerHTML = `
      <div class="card" style="box-shadow:none; border-color:rgba(255,255,255,.10); background:rgba(255,255,255,.03);">
        <div style="font-weight:950;">Pronto ✅</div>
        <div class="small muted" style="margin-top:6px;">Imposta la partenza, scegli categoria e premi CERCA.</div>
      </div>
    `;
  }

  function showResultProgress(msg = "Cerco nel dataset offline…") {
    const area = $("resultArea");
    if (!area) return;
    area.innerHTML = `
      <div class="card" style="box-shadow:none; border-color:rgba(255,180,80,.35); background:rgba(255,180,80,.06);">
        <div style="font-weight:950; font-size:18px;">🔎 Sto cercando…</div>
        <div class="small muted" style="margin-top:8px; line-height:1.4;">${escapeHtml(msg)}</div>
      </div>
    `;
  }

  function renderNoResult(maxMinutesShown, categoryUI, infoLine) {
    const area = $("resultArea");
    if (!area) return;

    area.innerHTML = `
      <div class="card" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
        <div class="small">❌ Nessuna meta trovata entro <b>${maxMinutesShown} min</b> per <b>${escapeHtml(categoryUI)}</b>.</div>
        <div class="small muted" style="margin-top:6px;">Tip: aumenta minuti oppure cambia categoria/stile.</div>
        <div class="small muted" style="margin-top:10px;">${escapeHtml(infoLine || "")}</div>
        <div class="row wraprow" style="gap:10px; margin-top:12px;">
          <button class="btnGhost" id="btnResetRotation">🧽 Reset “oggi”</button>
          <button class="btn btnPrimary" id="btnTryAgain">🎯 Riprova</button>
        </div>
      </div>
    `;

    const rr = $("btnResetRotation");
    if (rr) rr.addEventListener("click", () => { resetRotation(); showStatus("ok", "Reset fatto ✅"); });

    const ta = $("btnTryAgain");
    if (ta) ta.addEventListener("click", () => runSearch({ silent: true }));

    CURRENT_CHOSEN = null;
    scrollToId("resultCard");
  }

  function renderOptionsList() {
    const chosen = CURRENT_CHOSEN;
    if (!chosen) return "";

    const alts = ALL_OPTIONS.filter(x => x.pid !== chosen.pid);
    if (!alts.length) return "";

    const visible = alts.slice(0, VISIBLE_ALTS);

    const items = visible.map((x) => {
      const p = x.place;
      const name = escapeHtml(p.name || "");
      const time = `~${x.driveMin} min`;
      const sub = `${escapeHtml((p.area || p.country || "—").trim())} • ${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`;
      const vis = visibilityLabel(p);
      const inside = x.inside_region ? "IN REGIONE" : "FUORI REGIONE";
      const active = (CURRENT_CHOSEN && CURRENT_CHOSEN.pid === x.pid) ? "active" : "";
      return `
        <button class="optBtn ${active}" data-pid="${escapeHtml(x.pid)}" type="button">
          <div style="display:flex; justify-content:space-between; gap:10px;">
            <div style="font-weight:950; font-size:16px; line-height:1.2;">${name}</div>
            <div class="small muted" style="font-weight:950;">${time}</div>
          </div>
          <div class="small muted" style="margin-top:6px;">${escapeHtml(vis)} • ${sub}</div>
          <div class="small muted" style="margin-top:6px;">${escapeHtml(inside)} • ${escapeHtml(x.source || "")}</div>
        </button>
      `;
    }).join("");

    const canMore = VISIBLE_ALTS < alts.length;

    return `
      <div style="margin-top:14px;">
        <div style="font-weight:950; font-size:18px; margin: 6px 0 10px;">Altre opzioni</div>
        <div class="optList">${items}</div>
        ${canMore ? `<button class="moreBtn" id="btnMoreAlts" type="button">⬇️ Altre ${CFG.ALTS_PAGE}</button>` : ""}
        <div class="small muted" style="margin-top:10px;">Tocca un’opzione per aprire la scheda (senza rifare ricerca).</div>
      </div>
    `;
  }

  function bindOptionsClicks() {
    const area = $("resultArea");
    if (!area) return;

    area.querySelectorAll(".optBtn").forEach(btn => {
      btn.addEventListener("click", () => {
        const pid2 = btn.getAttribute("data-pid");
        const found = ALL_OPTIONS.find(x => x.pid === pid2);
        if (!found) return;
        openChosen(found, { scroll: true });
      });
    });

    const more = $("btnMoreAlts");
    if (more) {
      more.addEventListener("click", () => {
        VISIBLE_ALTS = Math.min((ALL_OPTIONS.length - 1), VISIBLE_ALTS + CFG.ALTS_PAGE);
        openChosen(CURRENT_CHOSEN, { scroll: false });
        setTimeout(() => {
          const m = $("btnMoreAlts");
          (m || $("resultCard")) && (m || $("resultCard")).scrollIntoView({ behavior: "smooth", block: "center" });
        }, 30);
      });
    }
  }

  function renderChosenCard(origin, chosen, categoryUI, usedMinutes, maxMinutesInput, metaInfoLine) {
    const area = $("resultArea");
    if (!area) return;

    const p = chosen.place;
    const pid = chosen.pid;

    const tb = typeBadge(categoryUI);
    const areaLabel = (p.area || p.country || "").trim() || "—";
    const name = p.name || "";

    const lat = Number(p.lat);
    const lon = Number(p.lon);
    const zoom = chosen.km < 20 ? 12 : chosen.km < 60 ? 10 : 8;
    const img1 = osmStaticImgPrimary(lat, lon, zoom);
    const img2 = osmStaticImgFallback(lat, lon, zoom);

    const what = shortWhatIs(p, categoryUI);
    const vis = visibilityLabel(p);

    const widenText = usedMinutes && usedMinutes !== maxMinutesInput ? ` • widen: ${usedMinutes} min` : "";
    const inside = chosen.inside_region ? "IN REGIONE" : "FUORI REGIONE";

    area.innerHTML = `
      <div style="border-radius:18px; overflow:hidden; border:1px solid rgba(0,224,255,.18);">
        <div style="position:relative; width:100%; aspect-ratio: 2 / 1; border-bottom:1px solid rgba(255,255,255,.10);">
          <img src="${img1}" alt="" loading="lazy" decoding="async"
               style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; opacity:.95;"
               onerror="(function(img){
                 if(!img.dataset.fallbackTried){ img.dataset.fallbackTried='1'; img.src='${img2}'; return; }
                 img.style.display='none';
               })(this)"
          />
          <div style="position:absolute; left:12px; top:12px; display:flex; gap:8px; flex-wrap:wrap; max-width: calc(100% - 24px);">
            <div class="pill2">${tb.emoji} ${tb.label}</div>
            <div class="pill2">🚗 ~${chosen.driveMin} min • ${fmtKm(chosen.km)}</div>
            <div class="pill2">${escapeHtml(vis)}</div>
            <div class="pill2">${escapeHtml(inside)}</div>
          </div>
        </div>

        <div style="padding:14px;">
          <div style="font-weight:1000; font-size:30px; line-height:1.08;">
            ${escapeHtml(name)}
          </div>

          <div class="small muted" style="margin-top:6px;">
            📍 ${escapeHtml(areaLabel)} • ${lat.toFixed(5)}, ${lon.toFixed(5)}
          </div>

          <div class="small muted" style="margin-top:8px;">
            ${escapeHtml(metaInfoLine || "")} • source: ${escapeHtml(chosen.source || "")} • score: ${chosen.score}${escapeHtml(widenText)}
          </div>

          <div style="margin-top:12px; font-weight:950;">Cos’è (subito chiaro)</div>
          <div class="small muted" style="margin-top:6px; line-height:1.45;">
            ${escapeHtml(what)}
          </div>

          <div class="actionGrid">
            <button class="btn btnPrimary" id="btnGo" type="button">🧭 Vai</button>
            <button class="btn" id="btnBook" type="button">🎟️ Prenota</button>
            <button class="btnGhost" id="btnEat" type="button">🍝 Mangia</button>
            <button class="btnGhost" id="btnPhotos" type="button">📸 Foto</button>
            <button class="btnGhost" id="btnWiki" type="button">📚 Wiki</button>
            <button class="btnGhost" id="btnVisited" type="button">✅ Visitato</button>
          </div>

          <div class="row wraprow" style="gap:10px; margin-top:12px;">
            <button class="btn" id="btnChange" type="button">🔁 Cambia meta</button>
            <button class="btnGhost" id="btnSearchAgain" type="button">🎯 Nuova ricerca</button>
          </div>

          ${renderOptionsList()}
        </div>
      </div>
    `;

    const btnGo = $("btnGo");
    if (btnGo) btnGo.addEventListener("click", () => {
      window.open(mapsDirUrl(origin.lat, origin.lon, lat, lon), "_blank", "noopener");
    });

    const btnBook = $("btnBook");
    if (btnBook) btnBook.addEventListener("click", () => {
      const cat = canonicalCategory(categoryUI);
      const t = tagsStr(p);

      // biglietti: attrazioni / musei / storia / family / castelli / cantine
      const isTicketish =
        cat === "family" || cat === "storia" || cat === "cantine" ||
        t.includes("tourism=museum") || t.includes("tourism=theme_park") ||
        t.includes("tourism=zoo") || t.includes("tourism=aquarium") ||
        t.includes("tourism=attraction") || t.includes("leisure=water_park") ||
        isCastleLike(p) || isArchaeology(p) || isMonument(p);

      const url = isTicketish ? gygSearchUrl(name, areaLabel) : bookingSearchUrl(name, areaLabel);
      window.open(url, "_blank", "noopener");
    });

    const btnEat = $("btnEat");
    if (btnEat) btnEat.addEventListener("click", () => {
      window.open(theforkSearchUrl(name, areaLabel, lat, lon), "_blank", "noopener");
    });

    const btnPhotos = $("btnPhotos");
    if (btnPhotos) btnPhotos.addEventListener("click", () => {
      window.open(googleImagesUrl(name, areaLabel), "_blank", "noopener");
    });

    const btnWiki = $("btnWiki");
    if (btnWiki) btnWiki.addEventListener("click", () => {
      window.open(wikiUrl(name, areaLabel), "_blank", "noopener");
    });

    const btnVisited = $("btnVisited");
    if (btnVisited) btnVisited.addEventListener("click", () => {
      markVisited(pid);
      showStatus("ok", "Segnato come visitato ✅");
    });

    const btnChange = $("btnChange");
    if (btnChange) btnChange.addEventListener("click", () => {
      runSearch({ silent: true, forbidPid: pid });
    });

    const btnSearchAgain = $("btnSearchAgain");
    if (btnSearchAgain) btnSearchAgain.addEventListener("click", () => {
      scrollToId("searchCard");
    });

    bindOptionsClicks();

    LAST_SHOWN_PID = pid;
    SESSION_SEEN.add(pid);
    addRecent(pid);

    scrollToId("resultCard");
  }

  // -------------------- SEARCH --------------------
  async function runSearch({ silent = false, forbidPid = null } = {}) {
    try { if (SEARCH_ABORT && SEARCH_ABORT.abort) SEARCH_ABORT.abort(); } catch {}
    SEARCH_ABORT = new AbortController();
    const signal = SEARCH_ABORT.signal;
    const token = ++SEARCH_TOKEN;

    try {
      if (!silent) hideStatus();
      showResultProgress();

      const origin = getOrigin();
      if (!origin || !Number.isFinite(Number(origin.lat)) || !Number.isFinite(Number(origin.lon))) {
        showStatus("err", "Prima imposta la partenza (Usa questo luogo).");
        scrollToId("quickStartCard");
        return;
      }

      const maxMinutesInput = clamp(Number($("maxMinutes") && $("maxMinutes").value) || 120, 10, 600);
      const categoryUI = getActiveCategory();
      const styles = getActiveStyles();

      const result = await pickOptionsWithRegionFirst(origin, maxMinutesInput, categoryUI, styles, signal);

      if (token !== SEARCH_TOKEN) return;

      let list = Array.isArray(result.list) ? result.list : [];
      list = dedupeDiverse(list);

      // separa se forbidPid
      if (forbidPid) list = list.filter(x => x.pid !== forbidPid);

      // ordina: inside prima
      list.sort((a,b)=> {
        const ai = a.inside_region ? 1 : 0;
        const bi = b.inside_region ? 1 : 0;
        if (bi !== ai) return (bi - ai);
        return (b.score - a.score) || (a.driveMin - b.driveMin);
      });

      if (!list.length) {
        renderNoResult(maxMinutesInput, categoryUI, regionLabelShort());
        showStatus("warn", `Nessuna meta entro ${maxMinutesInput} min per "${categoryUI}". Aumenta minuti o cambia categoria/stile.`);
        return;
      }

      // taglia pool
      ALL_OPTIONS = list.slice(0, CFG.OPTIONS_POOL_MAX);

      const chosen = ALL_OPTIONS[0];
      CURRENT_CHOSEN = chosen;

      const maxAlts = Math.max(0, ALL_OPTIONS.length - 1);
      VISIBLE_ALTS = Math.min(CFG.ALTS_INITIAL, maxAlts);

      const metaInfoLine = `${regionLabelShort()} • opzioni: ${ALL_OPTIONS.length}`;

      renderChosenCard(origin, chosen, categoryUI, result.usedMinutes, maxMinutesInput, metaInfoLine);

      if (!silent) {
        const extra = result.usedMinutes !== maxMinutesInput ? ` (ho allargato a ${result.usedMinutes} min)` : "";
        const fb = result.usedFallback ? " • criteri allargati per trovare più risultati" : "";
        showStatus("ok", `Trovate ${ALL_OPTIONS.length} opzioni ✅ • categoria: ${categoryUI}${extra}${fb}`);
      }
    } catch (e) {
      if (String(e && e.name || "").includes("Abort")) return;
      console.error(e);
      showStatus("err", `Errore: ${String(e && e.message ? e.message : e)}`);
    }
  }

  function openChosen(chosen, meta = {}) {
    const origin = meta.origin || getOrigin();
    const categoryUI = meta.category || getActiveCategory();
    const usedMinutes = meta.usedMinutes;
    const maxMinutesInput = meta.maxMinutesInput || Number($("maxMinutes") && $("maxMinutes").value) || 120;

    const metaInfoLine = `${regionLabelShort()} • opzioni: ${ALL_OPTIONS.length}`;
    CURRENT_CHOSEN = chosen;
    renderChosenCard(origin, chosen, categoryUI, usedMinutes, maxMinutesInput, metaInfoLine);

    if (meta.scroll !== false) scrollToId("resultCard");
  }

  // -------------------- ORIGIN BUTTONS --------------------
  function disableGPS() {
    const b = $("btnUseGPS");
    if (b) {
      b.style.display = "none";
      b.disabled = true;
      b.setAttribute("aria-hidden", "true");
    }
  }

  function bindOriginButtons() {
    disableGPS();

    const btnFindPlace = $("btnFindPlace");
    if (btnFindPlace) {
      btnFindPlace.addEventListener("click", async () => {
        try {
          const label = $("originLabel") ? $("originLabel").value : "";
          if ($("originStatus")) $("originStatus").textContent = "🔎 Cerco il luogo…";

          const result = await geocodeLabel(label);

          setOrigin({
            label: result.label || label,
            lat: result.lat,
            lon: result.lon,
            country_code: result.country_code || "",
          });

          showStatus("ok", "Partenza impostata ✅ Ora scegli categoria/stile e premi CERCA.");
          scrollToId("searchCard");
        } catch (e) {
          console.error(e);
          if ($("originStatus")) $("originStatus").textContent = `❌ ${String(e && e.message ? e.message : e)}`;
          showStatus("err", `Geocoding fallito: ${String(e && e.message ? e.message : e)}`);
          scrollToId("quickStartCard");
        }
      });
    }
  }

  // -------------------- MAIN BUTTONS --------------------
  function bindMainButtons() {
    const btnFind = $("btnFind");
    if (btnFind) btnFind.addEventListener("click", () => runSearch({ silent: false }));

    const btnResetVisited = $("btnResetVisited");
    if (btnResetVisited) btnResetVisited.addEventListener("click", () => { resetVisited(); showStatus("ok", "Visitati resettati ✅"); });
  }

  function initChipsAll() {
    initChips("timeChips", { multi: false });
    initChips("categoryChips", { multi: false });
    initChips("styleChips", { multi: true });
    initTimeChipsSync();
  }

  // -------------------- BOOT --------------------
  function boot() {
    injectMiniCssOnce();
    initChipsAll();
    restoreOrigin();
    collapseOriginCard(!!getOrigin());
    bindOriginButtons();
    bindMainButtons();
    hideStatus();
    renderEmptyResult();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();

  // debug helper
  window.__jamo = {
    runSearch,
    resetRotation,
    resetVisited,
    getOrigin,
    clearOrigin,
    getRegion: () => ({ id: REGION_ID, item: REGION_ITEM }),
    cacheKeys: () => [...FILE_CACHE.keys()],
  };
})();
