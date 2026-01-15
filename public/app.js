/* Jamo — app.js v19.0 (FULL)
 * Mobile-first • Offline-first (dataset in /public/data/...)
 *
 * ✅ NO GPS
 * ✅ Italia: regione da it-regions-index.json (bbox)
 * ✅ STRATEGIA:
 *    1) Regione + categoria (it-<regione>-<cat>.json)
 *    2) Regione core (it-<regione>.json)
 *    3) Radius categoria (radius-<cat>.json)  -> fuori regione ma vicino
 *    4) Macro paese / fallback macro
 *
 * ✅ Fuori regione: OK se rientra nei minuti
 * ✅ Pulsante "Cambia partenza" (reset immediato)
 * ✅ Family: meno playground, più cose turistiche/monetizzabili
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

    OPTIONS_POOL_MAX: 60,
    ALTS_INITIAL: 6,
    ALTS_PAGE: 6,

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

    // Dedupe distanza tra posti con stesso nome
    CLONE_KM: 2.2,

    // Family tuning
    FAMILY_PLAYGROUND_MAX_SHARE: 0.22, // max ~22% in lista opzioni
  };

  // -------------------- STATE --------------------
  let SESSION_SEEN = new Set();
  let LAST_SHOWN_PID = null;

  let SEARCH_TOKEN = 0;
  let SEARCH_ABORT = null;

  let MACROS_INDEX = null;
  let IT_REGIONS_INDEX = null;

  let DATASET = { key: null, kind: null, source: null, places: [], meta: {} };

  let ALL_OPTIONS = [];
  let VISIBLE_ALTS = 0;
  let CURRENT_CHOSEN = null;

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
    if (p?.id) return String(p.id);
    const nm = normName(p?.name);
    const lat = String(p?.lat ?? "").slice(0, 8);
    const lon = String(p?.lon ?? p?.lng ?? "").slice(0, 8);
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
    const aid = CFG.AFFILIATE.BOOKING_AID?.trim();
    if (!aid) return googleSearchUrl(`${stableQuery(name, area)} hotel spa terme`);
    return `https://www.booking.com/searchresults.it.html?aid=${encodeURIComponent(aid)}&ss=${encodeURIComponent(`${name} ${area || ""}`)}`;
  }
  function gygSearchUrl(name, area) {
    const pid = CFG.AFFILIATE.GYG_PARTNER_ID?.trim();
    if (!pid) return googleSearchUrl(`${stableQuery(name, area)} biglietti prenota tour`);
    return `https://www.getyourguide.com/s/?partner_id=${encodeURIComponent(pid)}&q=${encodeURIComponent(`${name} ${area || ""}`)}`;
  }
  function theforkSearchUrl(name, area, lat, lon) {
    const aff = CFG.AFFILIATE.THEFORK_AFFID?.trim();
    const q = `ristoranti vicino ${name} ${area || ""}`.trim();
    if (!aff) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}&center=${encodeURIComponent(lat + "," + lon)}`;
    return googleSearchUrl(q);
  }

  // -------------------- ORIGIN STORAGE --------------------
  function setOrigin({ label, lat, lon, country_code }) {
    $("originLabel") && ($("originLabel").value = label ?? "");
    $("originLat") && ($("originLat").value = String(lat));
    $("originLon") && ($("originLon").value = String(lon));

    const cc = String(country_code || "").toUpperCase();
    $("originCC") && ($("originCC").value = cc);

    localStorage.setItem("jamo_origin", JSON.stringify({ label, lat, lon, country_code: cc }));

    if ($("originStatus")) {
      $("originStatus").textContent =
        `✅ Partenza impostata: ${label || "posizione"} (${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)})${cc ? " • " + cc : ""}`;
    }

    collapseOriginCard(true);
  }

  function clearOrigin({ keepLabel = false } = {}) {
    localStorage.removeItem("jamo_origin");
    $("originLat") && ($("originLat").value = "");
    $("originLon") && ($("originLon").value = "");
    $("originCC") && ($("originCC").value = "");
    if (!keepLabel) $("originLabel") && ($("originLabel").value = "");
    if ($("originStatus")) $("originStatus").textContent = "📍 Inserisci un luogo di partenza.";
    DATASET = { key: null, kind: null, source: null, places: [], meta: {} };
    CURRENT_CHOSEN = null;
    ALL_OPTIONS = [];
    VISIBLE_ALTS = 0;
  }

  function getOrigin() {
    const lat = Number($("originLat")?.value);
    const lon = Number($("originLon")?.value);
    const label = ($("originLabel")?.value || "").trim();
    const ccDom = String($("originCC")?.value || "").toUpperCase();

    if (Number.isFinite(lat) && Number.isFinite(lon)) return { label, lat, lon, country_code: ccDom };

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

      // ✅ aggiungi bottone "Cambia partenza" dentro la card (se c'è un footer)
      // lo mettiamo anche se non esiste markup specifico: lo appendiamo in fondo
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
      if (Number.isFinite(Number(o?.lat)) && Number.isFinite(Number(o?.lon))) {
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

  function getActiveCategory() {
    const el = $("categoryChips");
    const active = el?.querySelector(".chip.active");
    return active?.dataset.cat || "ovunque";
  }

  function getActiveStyles() {
    const el = $("styleChips");
    const actives = [...(el?.querySelectorAll(".chip.active") || [])].map(c => c.dataset.style);
    return { wantChicche: actives.includes("chicche"), wantClassici: actives.includes("classici") };
  }

  // -------------------- FETCH JSON --------------------
  async function fetchJson(url, { signal } = {}) {
    const r = await fetch(url, { cache: "no-store", signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
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
    const lon = Number(p.lon ?? p.lng);
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

  function pickItalyRegionIdByOrigin(origin) {
    const lat = Number(origin?.lat);
    const lon = Number(origin?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "";
    if (!IT_REGIONS_INDEX?.items?.length) return "";

    for (const r of IT_REGIONS_INDEX.items) {
      if (!r?.bbox) continue;
      if (withinBBox(lat, lon, r.bbox)) return String(r.id || "");
    }
    return "";
  }

  // -------------------- MACROS INDEX --------------------
  async function loadMacrosIndexSafe(signal) {
    try { MACROS_INDEX = await fetchJson(CFG.MACROS_INDEX_URL, { signal }); }
    catch { MACROS_INDEX = null; }
    return MACROS_INDEX;
  }

  function findCountryMacroPathRobust(cc) {
    if (!MACROS_INDEX?.items?.length) return null;
    const c = String(cc || "").toUpperCase();
    if (!c) return null;

    for (const x of MACROS_INDEX.items) {
      const id = String(x?.id || "");
      const p = String(x?.path || "");
      if (id === `euuk_country_${c.toLowerCase()}`) return p || null;
      if (p.includes(`euuk_country_${c.toLowerCase()}.json`)) return p || null;
    }
    return null;
  }

  // -------------------- DATASET LOADING --------------------
  async function tryLoadPlacesFile(url, signal) {
    try {
      const r = await fetch(url, { cache: "no-store", signal });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      if (!j) return null;

      const placesRaw = Array.isArray(j?.places) ? j.places : null;
      if (!placesRaw || !placesRaw.length) return null;

      const places = placesRaw.map(normalizePlace).filter(Boolean);
      if (!places.length) return null;

      return { json: j, places };
    } catch {
      return null;
    }
  }

  function canonicalCategory(catUI) {
    const c = String(catUI || "").toLowerCase().trim();
    if (!c || c === "ovunque") return "core";
    if (c === "panorami") return "viewpoints";
    if (c === "trekking") return "hiking";
    if (c === "città" || c === "city") return "citta";
    return c;
  }

  function preferredDatasetUrls(origin, categoryUI) {
    const urls = [];
    const push = (u) => { const s = String(u || "").trim(); if (s) urls.push(s); };

    const cat = canonicalCategory(categoryUI);
    const cc = String(origin?.country_code || "").toUpperCase();

    const regionId = pickItalyRegionIdByOrigin(origin);
    const isItaly = (cc === "IT") || !!regionId;

    // 1) Regione: categoria -> core
    if (isItaly && regionId) {
      if (cat !== "core") push(`/data/pois/regions/${regionId}-${cat}.json`);
      push(`/data/pois/regions/${regionId}.json`);
    }

    // 2) Radius: fuori regione ma vicino
    if (cat !== "core") push(`/data/pois/regions/radius-${cat}.json`);

    // 3) Macro
    const macroCC = cc || (isItaly ? "IT" : "");
    const countryMacro = findCountryMacroPathRobust(macroCC);
    if (countryMacro) push(countryMacro);
    for (const u of CFG.FALLBACK_MACRO_URLS) push(u);

    // 4) Macro salvato
    const savedMacro = localStorage.getItem("jamo_macro_url");
    if (savedMacro) push(savedMacro);

    // uniq
    const out = [];
    const seen = new Set();
    for (const u of urls) {
      if (!u || seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
    return out;
  }

  async function ensureDatasetLoaded(origin, categoryUI, { signal } = {}) {
    await loadItalyRegionsIndexSafe(signal);
    await loadMacrosIndexSafe(signal);

    const preferred = preferredDatasetUrls(origin, categoryUI);
    const key = `${origin?.lat?.toFixed?.(3) || "x"}|${origin?.lon?.toFixed?.(3) || "y"}|${String(categoryUI || "ovunque")}|${preferred[0] || "none"}`;

    if (DATASET?.places?.length && DATASET.key === key) return DATASET;

    for (const url of preferred) {
      const loaded = await tryLoadPlacesFile(url, signal);
      if (!loaded) continue;

      const file = String(url).split("/").pop() || "";
      const isRadius = file.startsWith("radius-");
      const isRegional = url.includes("/data/pois/regions/") && file.startsWith("it-");

      DATASET = {
        key,
        kind: isRadius ? "radius" : isRegional ? "pois_region" : "macro",
        source: url,
        places: loaded.places,
        meta: { raw: loaded.json, cc: String(origin?.country_code || "").toUpperCase() },
      };

      if (DATASET.kind === "macro") localStorage.setItem("jamo_macro_url", url);

      console.log("[JAMO] dataset loaded:", url, "places:", loaded.places.length);
      return DATASET;
    }

    throw new Error("Nessun dataset offline valido disponibile.");
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
  function placeTags(place) { return (place.tags || []).map(t => String(t).toLowerCase()); }
  function tagsStr(place) { return placeTags(place).join(" "); }

  function hasAny(str, arr) {
    for (const k of arr) if (str.includes(k)) return true;
    return false;
  }

  // Anti-spazzatura
  function isClearlyIrrelevantPlace(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");

    if (hasAny(t, [
      "highway=", "railway=", "public_transport=", "route=", "junction=",
      "amenity=bus_station", "highway=bus_stop", "highway=platform"
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
      "man_made=survey_point", "power=", "telecom=", "pipeline=", "tower:type=",
      "boundary=", "place=locality"
    ])) return true;

    if (hasAny(n, [
      "parcheggio", "stazione", "fermata", "area ", "intermedia", "intermedio",
      "cabina", "impianto", "linea", "tratto", "svincolo", "uscita", "km "
    ])) return true;

    const looksCompany = (n.endsWith(" spa") || n.includes(" s p a") || n.includes(" s.p.a") || n.includes(" azienda "));
    const looksWellness = hasAny(n, ["terme","spa","wellness","termale","thermal"]);
    if (looksCompany && !looksWellness) return true;

    return false;
  }

  function looksWellnessByName(place) {
    const n = normName(place?.name || "");
    return hasAny(n, [
      "terme","termale","thermal","spa","wellness","benessere","hammam","hamam",
      "bagno turco","sauna","piscine termali","acqua termale","idroterapia"
    ]);
  }

  function looksKidsByName(place) {
    const n = normName(place?.name || "");
    return hasAny(n, [
      "bambin","kids","family","ragazzi","giochi","ludoteca","infanzia","junior",
      "museo dei bambini","children","science center","planetario","acquario","zoo",
      "fattoria didattica","didattica","baby","bimbi"
    ]);
  }

  function isIceRink(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    return (
      t.includes("leisure=ice_rink") ||
      t.includes("sport=ice_skating") ||
      t.includes("sport=ice_hockey") ||
      n.includes("palaghiaccio") ||
      n.includes("pattinaggio")
    );
  }

  function isEducationalKids(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    return (
      (t.includes("amenity=library") && (n.includes("bambin") || n.includes("kids"))) ||
      n.includes("museo interattivo") ||
      n.includes("science center") ||
      n.includes("planetario") ||
      (t.includes("tourism=museum") && (t.includes("science") || t.includes("planetarium")))
    );
  }

  function isSpaPlace(place) {
    const t = tagsStr(place);
    const nm = normName(place?.name || "");

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

  function isThemePark(place) { return tagsStr(place).includes("tourism=theme_park"); }
  function isWaterPark(place) { return tagsStr(place).includes("leisure=water_park"); }
  function isZooOrAquarium(place) {
    const t = tagsStr(place);
    return t.includes("tourism=zoo") || t.includes("tourism=aquarium") || t.includes("amenity=aquarium");
  }

  function isAdventurePark(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    return (
      t.includes("leisure=adventure_park") ||
      n.includes("parco avventura") || n.includes("adventure park") ||
      n.includes("zipline") || n.includes("zip line") ||
      n.includes("percorsi sospesi")
    );
  }

  function isMuseum(place) { return tagsStr(place).includes("tourism=museum"); }

  function isKidsMuseum(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    const kidsish = looksKidsByName(place) || n.includes("museo dei bambini") || n.includes("planetario");
    return isMuseum(place) && kidsish;
  }

  function isAttraction(place) {
    const t = tagsStr(place);
    return t.includes("tourism=attraction");
  }

  function isPlayground(place) {
    const t = tagsStr(place);
    return t.includes("leisure=playground");
  }

  function isRealViewpoint(place) {
    const t = tagsStr(place);
    return t.includes("tourism=viewpoint") || t.includes("man_made=observation_tower") || t.includes("tower:type=observation");
  }

  function isHiking(place) {
    const t = tagsStr(place);
    const type = normalizeType(place?.type);

    if (type === "hiking") return true;
    if (t.includes("amenity=shelter") || t.includes("tourism=alpine_hut")) return true;

    if (t.includes("information=guidepost")) {
      const n = String(place?.name || "").trim();
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
      normalizeType(place?.type) === "montagna" ||
      t.includes("natural=peak") || t.includes("natural=saddle") ||
      t.includes("tourism=alpine_hut") || t.includes("amenity=shelter") ||
      t.includes("aerialway=") || t.includes("piste:type=")
    );
  }

  function isNature(place) {
    const t = tagsStr(place);
    const type = normalizeType(place?.type);
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
    const n = normName(place?.name || "");
    const hasPlaceTag = t.includes("place=village") || t.includes("place=hamlet") || t.includes("place=suburb");
    const hasBorgoName = n.includes("borgo") || n.includes("centro storico") || n.includes("frazione");
    return normalizeType(place?.type) === "borghi" || hasPlaceTag || hasBorgoName;
  }

  function isCity(place) {
    const t = tagsStr(place);
    const type = normalizeType(place?.type);
    return type === "citta" || t.includes("place=city") || t.includes("place=town");
  }

  function isSummerThing(place) {
    const t = tagsStr(place);
    return t.includes("leisure=water_park") || t.includes("natural=beach") || t.includes("leisure=marina");
  }
  function isWinterThing(place) {
    const t = tagsStr(place);
    return t.includes("piste:type=") || t.includes("sport=skiing") || t.includes("aerialway=");
  }

  function isLodgingOrFood(place, cat) {
    const t = tagsStr(place);

    const lodging =
      t.includes("tourism=hotel") || t.includes("tourism=hostel") || t.includes("tourism=guest_house") ||
      t.includes("tourism=apartment") || t.includes("tourism=camp_site") || t.includes("tourism=caravan_site") ||
      t.includes("tourism=chalet") || t.includes("tourism=motel");

    if (lodging && (cat === "relax")) {
      if (isSpaPlace(place) || looksWellnessByName(place)) return false;
    }

    const food =
      t.includes("amenity=restaurant") || t.includes("amenity=fast_food") || t.includes("amenity=cafe") ||
      t.includes("amenity=bar") || t.includes("amenity=pub") || t.includes("amenity=ice_cream");

    // cantine: lasciamo passare enoteche/wine bar, ma togliamo ristoranti normali
    if (cat === "cantine") {
      const n = normName(place?.name || "");
      const looksWine = hasAny(n, ["cantina","winery","vino","vini","enoteca","degustaz","wine"]);
      const tWine = t.includes("craft=winery") || t.includes("shop=wine") || t.includes("amenity=wine_bar");
      if (tWine || looksWine) return false;
      if (food) return true;
    }

    return lodging || food;
  }

  function isWinery(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    if (t.includes("craft=winery")) return true;
    if (t.includes("shop=wine")) return true;
    if (t.includes("amenity=wine_bar")) return true;
    if (hasAny(n, ["cantina","winery","vini","vino","enoteca","degustaz","wine tasting","wine tour"])) return true;
    return false;
  }

  function matchesCategoryStrict(place, catUI) {
    const cat = canonicalCategory(catUI);
    if (!cat || cat === "core") return true;

    const type = normalizeType(place?.type);
    const t = tagsStr(place);

    if (cat === "natura") return isNature(place);
    if (cat === "mare") return type === "mare" || t.includes("natural=beach") || t.includes("leisure=marina") || t.includes("natural=coastline");
    if (cat === "storia") {
      return (
        type === "storia" ||
        t.includes("historic=castle") || t.includes("historic=fort") ||
        t.includes("historic=citywalls") || t.includes("historic=archaeological_site") ||
        t.includes("tourism=museum") || t.includes("tourism=attraction")
      );
    }
    if (cat === "relax") return isSpaPlace(place);
    if (cat === "borghi") return isBorgo(place);
    if (cat === "citta") return isCity(place);
    if (cat === "montagna") return isMountain(place);
    if (cat === "viewpoints") return isRealViewpoint(place);
    if (cat === "hiking") return isHiking(place);
    if (cat === "cantine") return isWinery(place);

    if (cat === "family") {
      // Family: NON vogliamo che sia quasi solo playground
      return (
        isThemePark(place) ||
        isWaterPark(place) ||
        isZooOrAquarium(place) ||
        isAdventurePark(place) ||
        isKidsMuseum(place) ||
        isEducationalKids(place) ||
        isIceRink(place) ||
        (isAttraction(place) && looksKidsByName(place)) ||
        (isMuseum(place) && looksKidsByName(place)) ||
        // playground lo lasciamo passare ma verrà penalizzato forte a scoring
        isPlayground(place)
      );
    }

    return true;
  }

  function matchesCategoryRelaxed(place, catUI) {
    const cat = canonicalCategory(catUI);
    if (!cat || cat === "core") return true;
    const t = tagsStr(place);

    if (cat === "relax") {
      return isSpaPlace(place) || t.includes("leisure=swimming_pool") || t.includes("leisure=swimming_area");
    }

    if (cat === "cantine") {
      const n = normName(place?.name || "");
      return isWinery(place) || hasAny(n, ["enoteca","degustaz","wine"]);
    }

    if (cat === "family") {
      return (
        matchesCategoryStrict(place, "family") ||
        isZooOrAquarium(place) ||
        isAdventurePark(place) ||
        isEducationalKids(place) ||
        isIceRink(place)
      );
    }

    return matchesCategoryStrict(place, cat);
  }

  function matchesStyle(place, { wantChicche, wantClassici }) {
    const vis = normalizeVisibility(place?.visibility);

    if (!wantChicche && !wantClassici) return true;
    if (vis === "unknown") return true;

    if (vis === "chicca") return !!wantChicche;
    return !!wantClassici;
  }

  function matchesAnyGoodCategory(place) {
    // “Ovunque” = mix di mete "buone"
    return (
      isNature(place) ||
      isRealViewpoint(place) ||
      isHiking(place) ||
      isMountain(place) ||
      isSpaPlace(place) ||
      isBorgo(place) ||
      isCity(place) ||
      matchesCategoryStrict(place, "storia") ||
      // family ma con bias turistico via scoring
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
    if (isSummerNow() && (isSummerThing(place) || normalizeType(place?.type) === "mare")) return +0.06;

    return 0;
  }

  function tourismBoost(place, catUI) {
    const cat = canonicalCategory(catUI);
    const t = tagsStr(place);

    let b = 0;

    // boosts "monetizzabili" / turistici
    if (t.includes("tourism=attraction")) b += 0.14;
    if (t.includes("tourism=museum")) b += 0.12;
    if (t.includes("historic=castle") || t.includes("historic=fort")) b += 0.14;
    if (t.includes("historic=archaeological_site")) b += 0.12;
    if (t.includes("tourism=viewpoint")) b += 0.12;

    if (isThemePark(place)) b += 0.24;
    if (isWaterPark(place)) b += 0.20;
    if (isZooOrAquarium(place)) b += 0.20;
    if (isAdventurePark(place)) b += 0.16;

    if (isSpaPlace(place)) b += (cat === "relax" ? 0.18 : 0.10);
    if (isWinery(place)) b += (cat === "cantine" ? 0.18 : 0.10);

    // Penalità: playground (soprattutto se non siamo in family)
    if (isPlayground(place)) {
      b -= (cat === "family" ? 0.22 : 0.45);
    }

    // Penalità: parchi generici non turistici
    if (t.includes("leisure=park") && !t.includes("tourism=")) b -= 0.06;

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

  // -------------------- PICK OPTIONS --------------------
  function buildCandidatesFromPool(pool, origin, maxMinutes, categoryUI, styles, {
    ignoreVisited=false,
    ignoreRotation=false,
    relaxedCategory=false
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

      candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
    }

    candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
    return candidates;
  }

  function pickTopOptions(pool, origin, minutes, categoryUI, styles) {
    let c = buildCandidatesFromPool(pool, origin, minutes, categoryUI, styles, { ignoreVisited:false, ignoreRotation:false, relaxedCategory:false });
    if (c.length) return { list: c, usedFallback: false };

    c = buildCandidatesFromPool(pool, origin, minutes, categoryUI, styles, { ignoreVisited:false, ignoreRotation:true, relaxedCategory:false });
    if (c.length) return { list: c, usedFallback: false };

    c = buildCandidatesFromPool(pool, origin, minutes, categoryUI, styles, { ignoreVisited:false, ignoreRotation:true, relaxedCategory:true });
    if (c.length) return { list: c, usedFallback: true };

    c = buildCandidatesFromPool(pool, origin, minutes, categoryUI, styles, { ignoreVisited:true, ignoreRotation:true, relaxedCategory:true });
    return { list: c, usedFallback: true };
  }

  function dedupeDiverse(list) {
    const out = [];
    const seenPid = new Set();
    const seenNameBuckets = new Map();

    for (const x of list) {
      if (!x?.pid) continue;
      if (seenPid.has(x.pid)) continue;

      const p = x.place;
      const nkey = normName(p?.name || "");
      const lat = Number(p?.lat);
      const lon = Number(p?.lon);

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

  // ✅ Family: limita quantità playground nelle opzioni finali
  function limitPlaygroundsIfFamily(list, categoryUI) {
    if (canonicalCategory(categoryUI) !== "family") return list;
    if (!Array.isArray(list) || !list.length) return list;

    const maxPlay = Math.max(1, Math.round(list.length * CFG.FAMILY_PLAYGROUND_MAX_SHARE));

    const good = [];
    const plays = [];
    for (const x of list) {
      if (isPlayground(x?.place)) plays.push(x);
      else good.push(x);
    }

    // mantieni ordine (già ordinato)
    return good.concat(plays.slice(0, maxPlay));
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
    const v = normalizeVisibility(place?.visibility);
    if (v === "chicca") return "✨ chicca";
    if (v === "classica") return "✅ classica";
    return "⭐ selezione";
  }

  function shortWhatIs(place, categoryUI) {
    const cat = canonicalCategory(categoryUI);
    const t = tagsStr(place);
    const n = normName(place?.name || "");

    if (cat === "cantine") return "Cantina/Enoteca • degustazioni e visite (prenotazione consigliata).";
    if (cat === "family") {
      if (isThemePark(place)) return "Parco divertimenti • biglietti/orari (monetizzabile).";
      if (isWaterPark(place)) return "Acquapark • biglietti/orari (stagionale).";
      if (isZooOrAquarium(place)) return "Zoo/Acquario • perfetto per famiglie.";
      if (isAdventurePark(place)) return "Parco avventura • percorsi sospesi, zipline.";
      if (isKidsMuseum(place) || isEducationalKids(place)) return "Museo/esperienza kids-friendly • spesso interattivo.";
      if (isIceRink(place)) return "Palaghiaccio • attività family.";
      if (isPlayground(place)) return "Parco giochi • opzione easy (meno prioritaria).";
      return "Family • esperienza adatta ai bambini.";
    }
    if (cat === "relax") return "Relax • terme/spa/sauna (spesso su prenotazione).";
    if (cat === "borghi") return "Borgo • centro storico, scorci e foto.";
    if (String(categoryUI) === "ovunque") {
      if (isWinery(place)) return "Cantina/Enoteca • degustazioni e visite.";
      if (isSpaPlace(place) || hasAny(n, ["terme","spa","wellness"])) return "Relax • terme/spa.";
      if (t.includes("historic=castle") || t.includes("historic=fort")) return "Storia • castello/forte visitabile.";
      if (isMuseum(place)) return "Museo • visita e biglietti.";
      if (isAttraction(place)) return "Attrazione • spot turistico.";
      if (isNature(place)) return "Natura • lago/cascata/gola/riserva.";
      if (isRealViewpoint(place)) return "Panorama vero • ottimo al tramonto.";
      if (isBorgo(place)) return "Borgo • centro storico e scorci.";
      if (isCity(place)) return "Città • centro, musei e monumenti.";
      if (isMountain(place)) return "Montagna • meteo importante.";
      if (isHiking(place)) return "Trekking • controlla meteo e sentiero.";
      return "Meta consigliata in base a tempo e mix categorie.";
    }

    if (cat === "natura") {
      if (t.includes("natural=waterfall")) return "Cascata • ideale per foto e passeggiata.";
      if (t.includes("natural=spring")) return "Sorgente/risorgiva • acqua e natura.";
      if (t.includes("natural=cave_entrance")) return "Grotta • verifica accesso e sicurezza.";
      if (t.includes("natural=water") || t.includes("water=lake")) return "Lago / acqua • relax e foto.";
      if (t.includes("waterway=river") || t.includes("waterway=stream")) return "Fiume / torrente • natura e panorami.";
      if (t.includes("boundary=national_park") || t.includes("leisure=nature_reserve")) return "Parco / riserva • trekking leggero e foto.";
      return "Spot naturalistico • perfetto per uscita veloce.";
    }

    if (cat === "viewpoints") return "Panorama vero • ottimo al tramonto.";
    if (cat === "hiking") return "Trekking • controlla meteo e sentiero.";
    if (cat === "storia") return "Luogo storico • verifica orari/mostre.";
    if (cat === "mare") return "Mare • spiaggia/marina, stagione consigliata.";
    if (cat === "montagna") return "Montagna • meteo importante.";
    if (cat === "citta") return "Città • centro, musei e monumenti.";
    return "Meta consigliata in base a tempo e categoria.";
  }

  // -------------------- RENDER --------------------
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

  function renderNoResult(maxMinutesShown, categoryUI, datasetInfo) {
    const area = $("resultArea");
    if (!area) return;

    area.innerHTML = `
      <div class="card" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
        <div class="small">❌ Nessuna meta trovata entro <b>${maxMinutesShown} min</b> per <b>${escapeHtml(categoryUI)}</b>.</div>
        <div class="small muted" style="margin-top:6px;">Tip: aumenta minuti oppure cambia categoria/stile.</div>
        <div class="small muted" style="margin-top:10px;">Dataset: ${escapeHtml(datasetInfo || "offline")}</div>
        <div class="row wraprow" style="gap:10px; margin-top:12px;">
          <button class="btnGhost" id="btnResetRotation">🧽 Reset “oggi”</button>
          <button class="btn btnPrimary" id="btnTryAgain">🎯 Riprova</button>
        </div>
      </div>
    `;

    $("btnResetRotation")?.addEventListener("click", () => {
      resetRotation();
      showStatus("ok", "Reset fatto ✅");
    });

    $("btnTryAgain")?.addEventListener("click", () => runSearch({ silent: true }));

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
      const active = (CURRENT_CHOSEN?.pid === x.pid) ? "active" : "";
      return `
        <button class="optBtn ${active}" data-pid="${escapeHtml(x.pid)}" type="button">
          <div style="display:flex; justify-content:space-between; gap:10px;">
            <div style="font-weight:950; font-size:16px; line-height:1.2;">${name}</div>
            <div class="small muted" style="font-weight:950;">${time}</div>
          </div>
          <div class="small muted" style="margin-top:6px;">${escapeHtml(vis)} • ${sub}</div>
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

    area.querySelectorAll(".optBtn")?.forEach(btn => {
      btn.addEventListener("click", () => {
        const pid2 = btn.getAttribute("data-pid");
        const found = ALL_OPTIONS.find(x => x.pid === pid2);
        if (!found) return;
        openChosen(found, { scroll: true });
      });
    });

    $("btnMoreAlts")?.addEventListener("click", () => {
      VISIBLE_ALTS = Math.min((ALL_OPTIONS.length - 1), VISIBLE_ALTS + CFG.ALTS_PAGE);
      openChosen(CURRENT_CHOSEN, { scroll: false });
      setTimeout(() => {
        const more = $("btnMoreAlts");
        (more || $("resultCard"))?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 30);
    });
  }

  function datasetInfoLabel(dataset, poolLen) {
    const src = String(dataset?.source || "");
    const file = src.split("/").pop() || "";
    if (dataset?.kind === "radius") return `RADIUS:${file} (${poolLen})`;
    if (dataset?.kind === "pois_region") return `POI:${file} (${poolLen})`;
    if (dataset?.kind === "macro") return `MACRO:${file} (${poolLen})`;
    return `offline (${poolLen})`;
  }

  function renderChosenCard(origin, chosen, categoryUI, datasetInfo, usedMinutes, maxMinutesInput) {
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
            <div class="pill">${tb.emoji} ${tb.label}</div>
            <div class="pill">🚗 ~${chosen.driveMin} min • ${fmtKm(chosen.km)}</div>
            <div class="pill">${escapeHtml(vis)}</div>
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
            Dataset: ${escapeHtml(datasetInfo || "offline")} • score: ${chosen.score}${escapeHtml(widenText)}
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

    $("btnGo")?.addEventListener("click", () => {
      window.open(mapsDirUrl(origin.lat, origin.lon, lat, lon), "_blank", "noopener");
    });

    $("btnBook")?.addEventListener("click", () => {
      const cat = canonicalCategory(categoryUI);
      const t = tagsStr(p);

      // più "monetizzabile": tickets per attrazioni / musei / family
      const isTicketish =
        cat === "family" || cat === "storia" ||
        t.includes("tourism=museum") || t.includes("tourism=theme_park") ||
        t.includes("tourism=zoo") || t.includes("tourism=aquarium") ||
        t.includes("tourism=attraction") || t.includes("leisure=water_park") ||
        t.includes("historic=castle") || t.includes("historic=fort") ||
        cat === "cantine";

      const url = isTicketish ? gygSearchUrl(name, areaLabel) : bookingSearchUrl(name, areaLabel);
      window.open(url, "_blank", "noopener");
    });

    $("btnEat")?.addEventListener("click", () => {
      window.open(theforkSearchUrl(name, areaLabel, lat, lon), "_blank", "noopener");
    });

    $("btnPhotos")?.addEventListener("click", () => {
      window.open(googleImagesUrl(name, areaLabel), "_blank", "noopener");
    });

    $("btnWiki")?.addEventListener("click", () => {
      window.open(wikiUrl(name, areaLabel), "_blank", "noopener");
    });

    $("btnVisited")?.addEventListener("click", () => {
      markVisited(pid);
      showStatus("ok", "Segnato come visitato ✅");
    });

    $("btnChange")?.addEventListener("click", () => {
      runSearch({ silent: true, forbidPid: pid });
    });

    $("btnSearchAgain")?.addEventListener("click", () => {
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
    try { SEARCH_ABORT?.abort?.(); } catch {}
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

      const maxMinutesInput = clamp(Number($("maxMinutes")?.value) || 120, 10, 600);
      const categoryUI = getActiveCategory();
      const styles = getActiveStyles();

      await ensureDatasetLoaded(origin, categoryUI, { signal });

      const basePool = Array.isArray(DATASET?.places) ? DATASET.places : [];
      const datasetInfo = datasetInfoLabel(DATASET, basePool.length);

      const steps = widenMinutesSteps(maxMinutesInput, categoryUI);

      let usedMinutes = steps[0];
      let usedFallback = false;
      let poolCandidates = [];

      for (const mins of steps) {
        usedMinutes = mins;

        const res = pickTopOptions(basePool, origin, mins, categoryUI, styles);
        usedFallback = !!res.usedFallback;

        poolCandidates = dedupeDiverse(res.list);

        // ✅ Family: limita playground nelle opzioni
        poolCandidates = limitPlaygroundsIfFamily(poolCandidates, categoryUI);

        if (forbidPid) poolCandidates = poolCandidates.filter(x => x.pid !== forbidPid);

        if (poolCandidates.length) break;
        if (token !== SEARCH_TOKEN) return;
      }

      if (token !== SEARCH_TOKEN) return;

      if (!poolCandidates.length) {
        renderNoResult(maxMinutesInput, categoryUI, datasetInfo);
        showStatus("warn", `Nessuna meta entro ${maxMinutesInput} min per "${categoryUI}". Aumenta minuti o cambia categoria/stile.`);
        return;
      }

      ALL_OPTIONS = poolCandidates.slice(0, CFG.OPTIONS_POOL_MAX);

      const chosen = ALL_OPTIONS[0];
      CURRENT_CHOSEN = chosen;

      const maxAlts = Math.max(0, ALL_OPTIONS.length - 1);
      VISIBLE_ALTS = Math.min(CFG.ALTS_INITIAL, maxAlts);

      renderChosenCard(origin, chosen, categoryUI, datasetInfo, usedMinutes, maxMinutesInput);

      if (!silent) {
        const extra = usedMinutes !== maxMinutesInput ? ` (ho allargato a ${usedMinutes} min)` : "";
        const fb = usedFallback ? " • criteri allargati per trovare più risultati" : "";
        showStatus("ok", `Trovate ${ALL_OPTIONS.length} opzioni ✅ • categoria: ${categoryUI}${extra}${fb}`);
      }
    } catch (e) {
      if (String(e?.name || "").includes("Abort")) return;
      console.error(e);
      showStatus("err", `Errore: ${String(e.message || e)}`);
    }
  }

  function openChosen(chosen, meta = {}) {
    const origin = meta.origin || getOrigin();
    const categoryUI = meta.category || getActiveCategory();
    const datasetInfo = meta.datasetInfo || "";
    const usedMinutes = meta.usedMinutes;
    const maxMinutesInput = meta.maxMinutesInput || Number($("maxMinutes")?.value) || 120;

    CURRENT_CHOSEN = chosen;
    renderChosenCard(origin, chosen, categoryUI, datasetInfo, usedMinutes, maxMinutesInput);

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

    $("btnFindPlace")?.addEventListener("click", async () => {
      try {
        const label = $("originLabel")?.value || "";
        if ($("originStatus")) $("originStatus").textContent = "🔎 Cerco il luogo…";

        const result = await geocodeLabel(label);

        setOrigin({
          label: result.label || label,
          lat: result.lat,
          lon: result.lon,
          country_code: result.country_code || "",
        });

        showStatus("ok", "Partenza impostata ✅ Ora scegli categoria/stile e premi CERCA.");
        DATASET = { key: null, kind: null, source: null, places: [], meta: {} };

        scrollToId("searchCard");
      } catch (e) {
        console.error(e);
        if ($("originStatus")) $("originStatus").textContent = `❌ ${String(e.message || e)}`;
        showStatus("err", `Geocoding fallito: ${String(e.message || e)}`);
        scrollToId("quickStartCard");
      }
    });
  }

  // -------------------- MAIN BUTTONS --------------------
  function bindMainButtons() {
    $("btnFind")?.addEventListener("click", () => runSearch({ silent: false }));
    $("btnResetVisited")?.addEventListener("click", () => { resetVisited(); showStatus("ok", "Visitati resettati ✅"); });
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
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();

  window.__jamo = {
    runSearch,
    resetRotation,
    resetVisited,
    getOrigin,
    clearOrigin,
    getDataset: () => DATASET
  };
})();
