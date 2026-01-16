/* Jamo — app.js v20.1 (FULL, REGION-FIRST + OUTSIDE-REGION)
 * Mobile-first • Offline-first • Robust region pick
 *
 * ✅ NO GPS
 * ✅ OFFLINE datasets in /public/data/...
 * ✅ IT: regione da bbox (it-regions-index.json)
 * ✅ PRIORITÀ (sempre, per ogni categoria):
 *    A) SOLO Regione: (categoria) + (core)  -> tenta prima qui
 *    B) Regione + Fuori regione: aggiunge radius/macro se regione è povera
 *    C) SOLO Fuori regione: radius/macro se regione vuota
 *
 * ✅ Risultati fuori regione: OK se rientrano nei minuti
 * ✅ Regione scelta robusta (best-fit bbox) per evitare Veneto->Lombardia, L'Aquila->Lazio
 * ✅ Tap: listeners puliti, niente overlay che blocca tocchi
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

    CLONE_KM: 2.2,

    // Regione: soglie
    REGION_MIN_RESULTS: 10,      // se >=10 dentro regione, NON aggiungere fuori
    REGION_SOFT_MIN_RESULTS: 3,  // se >=3 dentro regione, mostra prima regione e poi aggiungi fuori

    AFFILIATE: {
      BOOKING_AID: "",
      GYG_PARTNER_ID: "",
      VIATOR_PID: "",
      THEFORK_AFFID: "",
    },
  };

  // -------------------- STATE --------------------
  let SESSION_SEEN = new Set();
  let LAST_SHOWN_PID = null;

  let SEARCH_TOKEN = 0;
  let SEARCH_ABORT = null;

  let IT_REGIONS_INDEX = null;
  let MACROS_INDEX = null;

  let DATASETS_USED = []; // [{kind, source, placesLen}...]

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

  // -------------------- MINI CSS --------------------
  function injectMiniCssOnce() {
    if (document.getElementById("jamo-mini-css")) return;
    const st = document.createElement("style");
    st.id = "jamo-mini-css";
    st.textContent = `
      .moreBtn{width:100%; border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.04); color:#fff; border-radius:16px; padding:12px; font-weight:950; cursor:pointer;}
      .optBtn{width:100%; text-align:left; border:1px solid rgba(255,255,255,.10); background:rgba(255,255,255,.03); color:#fff; border-radius:16px; padding:12px; cursor:pointer;}
      .optBtn:active{transform:scale(.99)}
      .optList{display:flex; flex-direction:column; gap:10px;}
      .pill{display:inline-flex; gap:8px; align-items:center; padding:7px 10px; border-radius:999px; border:1px solid rgba(255,255,255,.14); background:rgba(0,0,0,.25); font-weight:850; font-size:13px;}
      .actionGrid{display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-top:12px;}
      .wraprow{flex-wrap:wrap;}
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

  // -------------------- DATA NORMALIZATION --------------------
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
    if (s === "borgo") return "borghi";
    if (s === "borghi") return "borghi";
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
    if (IT_REGIONS_INDEX?.items?.length) return IT_REGIONS_INDEX;
    try {
      IT_REGIONS_INDEX = await fetchJson(CFG.IT_REGIONS_INDEX_URL, { signal });
    } catch {
      IT_REGIONS_INDEX = null;
    }
    return IT_REGIONS_INDEX;
  }

  function pickItalyRegionByOrigin(origin) {
    const lat = Number(origin?.lat);
    const lon = Number(origin?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const items = IT_REGIONS_INDEX?.items;
    if (!Array.isArray(items) || !items.length) return null;

    // Best-fit: bbox più piccola che contiene il punto (riduce errori Veneto/Lombardia e Abruzzo/Lazio)
    let best = null;
    for (const r of items) {
      if (!r?.bbox) continue;
      if (!withinBBox(lat, lon, r.bbox)) continue;
      const area = Math.abs((r.bbox.maxLat - r.bbox.minLat) * (r.bbox.maxLon - r.bbox.minLon));
      if (!best || area < best.area) best = { r, area };
    }
    return best?.r || null;
  }

  // -------------------- MACROS INDEX --------------------
  async function loadMacrosIndexSafe(signal) {
    if (MACROS_INDEX?.items?.length) return MACROS_INDEX;
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
      if (p.endsWith(`/euuk_country_${c.toLowerCase()}.json`)) return p || null;
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

  function canonicalCategory(cat) {
    const c = String(cat || "").toLowerCase().trim();
    if (!c || c === "ovunque") return "core";
    if (c === "panorami") return "viewpoints";
    if (c === "trekking") return "hiking";
    if (c === "città" || c === "city") return "citta";
    return c;
  }

  function datasetInfoLabel(kind, src, poolLen) {
    const file = String(src || "").split("/").pop() || "";
    if (kind === "region") return `POI:${file} (${poolLen})`;
    if (kind === "radius") return `RADIUS:${file} (${poolLen})`;
    if (kind === "macro") return `MACRO:${file} (${poolLen})`;
    return `offline (${poolLen})`;
  }

  async function loadPoolsRegionFirst(origin, categoryUI, { signal } = {}) {
    await loadItalyRegionsIndexSafe(signal);
    await loadMacrosIndexSafe(signal);

    DATASETS_USED = [];

    const cc = String(origin?.country_code || "").toUpperCase();
    const region = pickItalyRegionByOrigin(origin);
    const isItaly = (cc === "IT") || !!region;

    const cat = canonicalCategory(categoryUI);
    const pools = [];

    // 1) Regione categoria
    if (isItaly && region?.id) {
      const rid = String(region.id);

      const pCat = (cat !== "core")
        ? (region.paths?.[cat] || `/data/pois/regions/${rid}-${cat}.json`)
        : null;

      if (pCat) {
        const loaded = await tryLoadPlacesFile(pCat, signal);
        if (loaded) {
          pools.push({ kind: "region", source: pCat, places: loaded.places, bbox: region.bbox || null, regionId: rid });
          DATASETS_USED.push({ kind: "region", source: pCat, placesLen: loaded.places.length });
        }
      }

      // 2) Regione core
      const pCore = region.paths?.core || `/data/pois/regions/${rid}.json`;
      if (pCore) {
        const loaded = await tryLoadPlacesFile(pCore, signal);
        if (loaded) {
          pools.push({ kind: "region", source: pCore, places: loaded.places, bbox: region.bbox || null, regionId: rid });
          DATASETS_USED.push({ kind: "region", source: pCore, placesLen: loaded.places.length });
        }
      }
    }

    // 3) Radius categoria
    if (cat !== "core") {
      const pRadius = `/data/pois/regions/radius-${cat}.json`;
      const loaded = await tryLoadPlacesFile(pRadius, signal);
      if (loaded) {
        pools.push({ kind: "radius", source: pRadius, places: loaded.places, bbox: null });
        DATASETS_USED.push({ kind: "radius", source: pRadius, placesLen: loaded.places.length });
      }
    }

    // 4) Macro paese + fallback
    const countryMacro = findCountryMacroPathRobust(cc || (isItaly ? "IT" : ""));
    const macroUrls = [];
    if (countryMacro) macroUrls.push(countryMacro);
    for (const u of CFG.FALLBACK_MACRO_URLS) macroUrls.push(u);

    const savedMacro = localStorage.getItem("jamo_macro_url");
    if (savedMacro) macroUrls.push(savedMacro);

    const uniq = [];
    const seen = new Set();
    for (const u of macroUrls) {
      const s = String(u || "").trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      uniq.push(s);
    }

    for (const u of uniq) {
      const loaded = await tryLoadPlacesFile(u, signal);
      if (!loaded) continue;
      pools.push({ kind: "macro", source: u, places: loaded.places, bbox: null });
      DATASETS_USED.push({ kind: "macro", source: u, placesLen: loaded.places.length });
      localStorage.setItem("jamo_macro_url", u);
      break; // basta 1 macro valida
    }

    if (!pools.length) throw new Error("Nessun dataset offline valido disponibile.");
    return { pools, region };
  }

  // -------------------- GEOCODING --------------------
  async function geocodeLabel(label) {
    const q = String(label || "").trim();
    if (!q) throw new Error("Scrivi un luogo (es: Verona, Padova, Venezia...)");
    const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { method: "GET", cache: "no-store" });
    const j = await r.json().catch(() => null);
    if (!j) throw new Error("Geocoding fallito (risposta vuota)");
    if (!j.ok) throw new Error(j.error || "Geocoding fallito");
    if (!j.result || !Number.isFinite(Number(j.result.lat)) || !Number.isFinite(Number(j.result.lon))) {
      throw new Error("Geocoding fallito (coordinate non valide)");
    }
    return j.result;
  }

  // -------------------- FILTERS / CATEGORIES --------------------
  function placeTags(place) { return (place.tags || []).map(t => String(t).toLowerCase()); }
  function tagsStr(place) { return placeTags(place).join(" "); }
  function hasAny(str, arr) { for (const k of arr) if (str.includes(k)) return true; return false; }

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

  function isLodgingOrFood(place, category) {
    const t = tagsStr(place);

    const lodging =
      t.includes("tourism=hotel") || t.includes("tourism=hostel") || t.includes("tourism=guest_house") ||
      t.includes("tourism=apartment") || t.includes("tourism=camp_site") || t.includes("tourism=caravan_site") ||
      t.includes("tourism=chalet") || t.includes("tourism=motel");

    const food =
      t.includes("amenity=restaurant") || t.includes("amenity=fast_food") || t.includes("amenity=cafe") ||
      t.includes("amenity=bar") || t.includes("amenity=pub") || t.includes("amenity=ice_cream");

    // In "relax" lasciamo passare hotel SPA se ha segnali benessere dal nome
    if (lodging && category === "relax") {
      const n = normName(place?.name || "");
      if (hasAny(n, ["terme","spa","wellness","benessere","thermal"])) return false;
    }

    return lodging || food;
  }

  function looksWellnessByName(place) {
    const n = normName(place?.name || "");
    return hasAny(n, ["terme","spa","wellness","benessere","thermal","termale","sauna","hammam","hamam"]);
  }

  function looksKidsByName(place) {
    const n = normName(place?.name || "");
    return hasAny(n, ["bambin","kids","family","ragazzi","giochi","ludoteca","infanzia","junior","parco giochi","bimbi"]);
  }

  function isSpaPlace(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    return (
      t.includes("amenity=spa") || t.includes("leisure=spa") || t.includes("tourism=spa") ||
      t.includes("natural=hot_spring") || t.includes("amenity=public_bath") ||
      t.includes("amenity=sauna") || t.includes("leisure=sauna") ||
      t.includes("bath:type=thermal") || t.includes("thermal") || t.includes("terme") ||
      looksWellnessByName(place) ||
      (t.includes("leisure=swimming_pool") && hasAny(n, ["terme","spa","thermal","wellness","benessere"]))
    );
  }

  function isNature(place) {
    const t = tagsStr(place);
    return (
      t.includes("natural=waterfall") ||
      t.includes("natural=spring") ||
      t.includes("natural=cave_entrance") ||
      t.includes("natural=water") || t.includes("water=lake") || t.includes("water=reservoir") ||
      t.includes("waterway=river") || t.includes("waterway=stream") ||
      t.includes("leisure=nature_reserve") || t.includes("boundary=national_park") ||
      t.includes("natural=wood") || t.includes("natural=gorge")
    );
  }

  function isRealViewpoint(place) {
    const t = tagsStr(place);
    return t.includes("tourism=viewpoint") || t.includes("man_made=observation_tower") || t.includes("tower:type=observation");
  }

  function isHiking(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    if (t.includes("tourism=alpine_hut") || t.includes("amenity=shelter")) return true;
    if (t.includes("information=guidepost")) return hasAny(n, ["sentier","cai","anello","trail"]);
    return hasAny(n, ["sentiero","trek","trail","cai"]);
  }

  function isMountain(place) {
    const t = tagsStr(place);
    if (t.includes("place=city") || t.includes("place=town") || t.includes("place=village")) return false;
    return (
      t.includes("natural=peak") || t.includes("natural=saddle") ||
      t.includes("tourism=alpine_hut") || t.includes("amenity=shelter") ||
      t.includes("aerialway=") || t.includes("piste:type=")
    );
  }

  function isBorgo(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    return (
      t.includes("place=village") || t.includes("place=hamlet") ||
      hasAny(n, ["borgo","centro storico","paese","frazione"])
    );
  }

  function isCity(place) {
    const t = tagsStr(place);
    return t.includes("place=city") || t.includes("place=town");
  }

  function isWinery(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    return (
      t.includes("craft=winery") || t.includes("shop=wine") || t.includes("amenity=wine_bar") ||
      hasAny(n, ["cantina","winery","enoteca","degustaz","wine tasting","wine tour","vini","vino"])
    );
  }

  function matchesCategoryStrict(place, catUI) {
    const cat = canonicalCategory(catUI);
    if (!cat || cat === "core") return true;

    const t = tagsStr(place);

    if (cat === "natura") return isNature(place);
    if (cat === "mare") return t.includes("natural=beach") || t.includes("leisure=marina") || t.includes("natural=coastline");
    if (cat === "storia") {
      return (
        t.includes("historic=castle") || t.includes("historic=fort") ||
        t.includes("historic=citywalls") || t.includes("historic=archaeological_site") ||
        t.includes("tourism=museum") || t.includes("tourism=attraction") ||
        t.includes("amenity=place_of_worship") || t.includes("historic=church")
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
      const n = normName(place?.name || "");
      return (
        t.includes("tourism=theme_park") ||
        t.includes("leisure=water_park") ||
        t.includes("tourism=zoo") || t.includes("tourism=aquarium") ||
        t.includes("leisure=playground") ||
        hasAny(n, ["parco avventura","adventure park","kids","bimbi","bambini","planetario","acquario"])
      );
    }

    return true;
  }

  function matchesAnyGoodCategory(place) {
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
      isWinery(place)
    );
  }

  // -------------------- STYLE --------------------
  function matchesStyle(place, { wantChicche, wantClassici }) {
    const vis = normalizeVisibility(place?.visibility);
    if (!wantChicche && !wantClassici) return true;
    if (vis === "unknown") return true;
    if (vis === "chicca") return !!wantChicche;
    return !!wantClassici;
  }

  function visibilityLabel(place) {
    const v = normalizeVisibility(place?.visibility);
    if (v === "chicca") return "✨ chicca";
    if (v === "classica") return "✅ classica";
    return "⭐ selezione";
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
    const t = tagsStr(place);
    if (isWinterNow() && (t.includes("leisure=water_park") || t.includes("natural=beach"))) return -0.18;
    if (isSummerNow() && (t.includes("piste:type=") || t.includes("sport=skiing"))) return -0.18;

    if (isWinterNow() && isSpaPlace(place)) return +0.12;
    if (isSummerNow() && (t.includes("natural=beach") || t.includes("leisure=marina"))) return +0.06;

    return 0;
  }

  function buildCandidatesFromPool(pool, origin, maxMinutes, categoryUI, styles, {
    ignoreVisited=false,
    ignoreRotation=false
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
      if (isLodgingOrFood(p, canonicalCategory(categoryUI))) continue;

      let okCat = true;
      if (String(categoryUI) === "ovunque") {
        okCat = matchesAnyGoodCategory(p);
      } else {
        okCat = matchesCategoryStrict(p, categoryUI);
      }
      if (!okCat) continue;
      if (!matchesStyle(p, styles)) continue;

      const pid = safeIdFromPlace(p);
      if (!ignoreVisited && visited.has(pid)) continue;

      const km = haversineKm(oLat, oLon, p.lat, p.lon);
      const driveMin = estCarMinutesFromKm(km);
      if (!Number.isFinite(driveMin) || driveMin > target) continue;
      if (km < 1.2) continue;

      const isChicca = normalizeVisibility(p.visibility) === "chicca";
      let s = baseScorePlace({ driveMin, targetMin: target, beautyScore: p.beauty_score, isChicca });
      s += seasonAdjust(p);

      if (!ignoreRotation) s -= rotationPenalty(pid, recentSet);

      candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
    }

    candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
    return candidates;
  }

  function pickTopOptions(pool, origin, minutes, categoryUI, styles) {
    let c = buildCandidatesFromPool(pool, origin, minutes, categoryUI, styles, { ignoreVisited:false, ignoreRotation:false });
    if (c.length) return { list: c, usedFallback: false };

    c = buildCandidatesFromPool(pool, origin, minutes, categoryUI, styles, { ignoreVisited:false, ignoreRotation:true });
    if (c.length) return { list: c, usedFallback: true };

    c = buildCandidatesFromPool(pool, origin, minutes, categoryUI, styles, { ignoreVisited:true, ignoreRotation:true });
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

  function widenMinutesSteps(m, categoryUI) {
    const base = clamp(Number(m) || 120, 10, 600);
    const steps = [base, clamp(Math.round(base * 1.2), base, 600), clamp(Math.round(base * 1.4), base, 600)];
    steps.push(clamp(Math.max(240, base), base, 600));
    return Array.from(new Set(steps)).sort((a, b) => a - b);
  }

  // -------------------- BADGES / COPY --------------------
  function typeBadge(categoryUI) {
    const category = String(categoryUI || "");
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
    return map[category] || { emoji:"📍", label:"Meta" };
  }

  function shortWhatIs(place, categoryUI) {
    const category = canonicalCategory(categoryUI);
    if (category === "relax") return "Relax • terme/spa/benessere (spesso su prenotazione).";
    if (category === "cantine") return "Cantina/Enoteca • degustazioni e visite (prenota).";
    if (category === "family") return "Family • attrazione kids-friendly (verifica orari/biglietti).";
    if (category === "storia") return "Storia • castelli, musei, chiese, siti visitabili.";
    if (category === "natura") return "Natura • lago/cascata/riserva/paesaggi.";
    if (category === "borghi") return "Borgo • centro storico, scorci, foto.";
    if (category === "citta") return "Città • centro, monumenti, musei.";
    if (category === "montagna") return "Montagna • meteo importante, panorami.";
    if (category === "viewpoints") return "Panorami • viewpoint vero (top al tramonto).";
    if (category === "hiking") return "Trekking • percorso/sentiero (meteo e scarpe).";
    if (category === "mare") return "Mare • spiaggia/marina, stagione consigliata.";
    return "Meta consigliata in base a tempo e preferenze.";
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
          <button class="btnGhost" id="btnResetRotation" type="button">🧽 Reset “oggi”</button>
          <button class="btn btnPrimary" id="btnTryAgain" type="button">🎯 Riprova</button>
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

  function bindOptionsClicks(meta) {
    const area = $("resultArea");
    if (!area) return;

    area.querySelectorAll(".optBtn").forEach(btn => {
      btn.addEventListener("click", () => {
        const pid2 = btn.getAttribute("data-pid");
        const found = ALL_OPTIONS.find(x => x.pid === pid2);
        if (!found) return;
        openChosen(found, { ...meta, scroll: true });
      });
    });

    $("btnMoreAlts")?.addEventListener("click", () => {
      VISIBLE_ALTS = Math.min((ALL_OPTIONS.length - 1), VISIBLE_ALTS + CFG.ALTS_PAGE);
      openChosen(CURRENT_CHOSEN, { ...meta, scroll: false });
      setTimeout(() => {
        const more = $("btnMoreAlts");
        (more || $("resultCard"))?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 30);
    });
  }

  function renderChosenCard(origin, chosen, categoryUI, datasetInfo, usedMinutes, maxMinutesInput, meta) {
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
      const url =
        (cat === "storia" || cat === "family" || t.includes("tourism=museum") || t.includes("tourism=attraction"))
          ? gygSearchUrl(name, areaLabel)
          : bookingSearchUrl(name, areaLabel);
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

    bindOptionsClicks(meta);

    LAST_SHOWN_PID = pid;
    SESSION_SEEN.add(pid);
    addRecent(pid);

    scrollToId("resultCard");
  }

  // -------------------- SEARCH CORE --------------------
  function scoreBoostInRegion(list, regionBBox) {
    if (!regionBBox || !list?.length) return list;
    for (const x of list) {
      if (withinBBox(x.place.lat, x.place.lon, regionBBox)) x.score = Number((x.score + 0.06).toFixed(4));
    }
    list.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
    return list;
  }

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

      const { pools, region } = await loadPoolsRegionFirst(origin, categoryUI, { signal });
      if (token !== SEARCH_TOKEN) return;

      const regionBBox = region?.bbox || null;

      const steps = widenMinutesSteps(maxMinutesInput, categoryUI);

      let usedMinutes = steps[0];
      let usedFallback = false;
      let poolCandidates = [];
      let chosenDatasetInfo = "";

      for (const mins of steps) {
        usedMinutes = mins;

        // REGION POOLS
        const regionPools = pools.filter(p => p.kind === "region");
        const otherPools = pools.filter(p => p.kind !== "region");

        // 1) Solo regione (categoria+core già dentro regionPools)
        let regionMerged = [];
        for (const pl of regionPools) regionMerged = regionMerged.concat(pl.places || []);
        let regionRes = regionMerged.length ? pickTopOptions(regionMerged, origin, mins, categoryUI, styles) : { list: [], usedFallback: false };
        let regionList = dedupeDiverse(regionRes.list);
        if (forbidPid) regionList = regionList.filter(x => x.pid !== forbidPid);
        scoreBoostInRegion(regionList, regionBBox);

        // Se regione basta -> stop
        if (regionList.length >= CFG.REGION_MIN_RESULTS) {
          poolCandidates = regionList;
          usedFallback = regionRes.usedFallback;
          const firstRegion = regionPools[0];
          chosenDatasetInfo = datasetInfoLabel("region", firstRegion?.source, firstRegion?.places?.length || 0);
          break;
        }

        // 2) Regione povera ma presente -> aggiungi fuori regione
        if (regionList.length >= CFG.REGION_SOFT_MIN_RESULTS) {
          let otherMerged = [];
          for (const pl of otherPools) otherMerged = otherMerged.concat(pl.places || []);
          const otherRes = otherMerged.length ? pickTopOptions(otherMerged, origin, mins, categoryUI, styles) : { list: [], usedFallback: false };
          let otherList = dedupeDiverse(otherRes.list);
          if (forbidPid) otherList = otherList.filter(x => x.pid !== forbidPid);

          const combined = dedupeDiverse(regionList.concat(otherList));
          poolCandidates = combined;

          usedFallback = regionRes.usedFallback || otherRes.usedFallback;

          const firstRegion = regionPools[0];
          const firstOther = otherPools[0];
          chosenDatasetInfo =
            `REGION:${(firstRegion?.source||"").split("/").pop() || "—"} + ${datasetInfoLabel(firstOther?.kind, firstOther?.source, firstOther?.places?.length || 0)}`;
          break;
        }

        // 3) Regione vuota -> solo fuori regione
        let otherMerged = [];
        for (const pl of otherPools) otherMerged = otherMerged.concat(pl.places || []);
        const otherRes = otherMerged.length ? pickTopOptions(otherMerged, origin, mins, categoryUI, styles) : { list: [], usedFallback: false };
        let otherList = dedupeDiverse(otherRes.list);
        if (forbidPid) otherList = otherList.filter(x => x.pid !== forbidPid);

        if (otherList.length) {
          poolCandidates = otherList;
          usedFallback = otherRes.usedFallback;
          const firstOther = otherPools[0];
          chosenDatasetInfo = datasetInfoLabel(firstOther?.kind, firstOther?.source, firstOther?.places?.length || 0);
          break;
        }

        if (token !== SEARCH_TOKEN) return;
      }

      if (token !== SEARCH_TOKEN) return;

      if (!poolCandidates.length) {
        const ds = (DATASETS_USED || []).map(x => `${x.kind}:${(x.source||"").split("/").pop()} (${x.placesLen})`).join(" • ");
        renderNoResult(maxMinutesInput, categoryUI, ds || "offline");
        showStatus("warn", `Nessuna meta entro ${maxMinutesInput} min per "${categoryUI}". Aumenta minuti o cambia categoria/stile.`);
        return;
      }

      ALL_OPTIONS = poolCandidates.slice(0, CFG.OPTIONS_POOL_MAX);

      const chosen = ALL_OPTIONS[0];
      CURRENT_CHOSEN = chosen;

      const maxAlts = Math.max(0, ALL_OPTIONS.length - 1);
      VISIBLE_ALTS = Math.min(CFG.ALTS_INITIAL, maxAlts);

      const meta = { origin, categoryUI, datasetInfo: chosenDatasetInfo, usedMinutes, maxMinutesInput };
      renderChosenCard(origin, chosen, categoryUI, chosenDatasetInfo, usedMinutes, maxMinutesInput, meta);

      if (!silent) {
        const extra = usedMinutes !== maxMinutesInput ? ` (ho allargato a ${usedMinutes} min)` : "";
        const fb = usedFallback ? " • criteri allargati per trovare più risultati" : "";
        const reg = region?.name ? ` • regione: ${region.name}` : "";
        showStatus("ok", `Trovate ${ALL_OPTIONS.length} opzioni ✅ • categoria: ${categoryUI}${extra}${reg}${fb}`);
      }
    } catch (e) {
      if (String(e?.name || "").includes("Abort")) return;
      console.error(e);
      showStatus("err", `Errore: ${String(e.message || e)}`);
    }
  }

  function openChosen(chosen, meta = {}) {
    const origin = meta.origin || getOrigin();
    const categoryUI = meta.categoryUI || getActiveCategory();
    const datasetInfo = meta.datasetInfo || "";
    const usedMinutes = meta.usedMinutes;
    const maxMinutesInput = meta.maxMinutesInput || Number($("maxMinutes")?.value) || 120;

    CURRENT_CHOSEN = chosen;
    renderChosenCard(origin, chosen, categoryUI, datasetInfo, usedMinutes, maxMinutesInput, meta);

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

        setOrigin({ label: result.label || label, lat: result.lat, lon: result.lon, country_code: result.country_code || "" });

        showStatus("ok", "Partenza impostata ✅ Ora scegli categoria/stile e premi CERCA.");
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
    bindOriginButtons();
    bindMainButtons();
    hideStatus();

    const origin = getOrigin();
    if (origin) collapseOriginCard(true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();

  window.__jamo = {
    runSearch,
    resetRotation,
    resetVisited,
    getOrigin,
    getDatasetsUsed: () => DATASETS_USED
  };
})();
