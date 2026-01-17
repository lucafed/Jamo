/* Jamo — app.js v22.2 (CLEAN • TOURISTIC • MONETIZZABILE • TAP-SAFE)
 * ✅ Offline-first • ✅ NO GPS • ✅ Region-first IT
 * ✅ Rimossi: Ovunque / Città / Panorami
 * ✅ Borghi: SOLO insediamenti veri
 * ✅ Trekking & Mare: filtri più larghi (trova di più, sempre turistico)
 * ✅ Montagna: categoria vera (picchi/rifugi/passi/attrazioni alpine)
 * ✅ Eventi: UI ok (subfiltri on/off) — dataset/eventi nel prossimo step
 * ✅ Reset partenza: usa btnResetOrigin dell’HTML (niente bottoni duplicati)
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
    ALTS_PAGE: 8,

    IT_REGIONS_INDEX_URL: "/data/pois/regions/it-regions-index.json",

    MACROS_INDEX_URL: "/data/macros/macros_index.json",
    FALLBACK_MACRO_URLS: [
      "/data/macros/euuk_country_it.json",
      "/data/macros/euuk_macro_all.json",
    ],

    AFFILIATE: {
      BOOKING_AID: "",
      GYG_PARTNER_ID: "",
      VIATOR_PID: "",
      THEFORK_AFFID: "",
    },

    CLONE_KM: 2.2,

    REGION_MIN_RESULTS: 8,
    REGION_SOFT_MIN_RESULTS: 3,

    MIN_KM_DEFAULT: 1.6,
    MIN_KM_FAMILY: 1.2,
  };

  // -------------------- STATE --------------------
  let SESSION_SEEN = new Set();
  let LAST_SHOWN_PID = null;

  let SEARCH_TOKEN = 0;
  let SEARCH_ABORT = null;

  let MACROS_INDEX = null;
  let IT_REGIONS_INDEX = null;
  let DATASETS_USED = [];

  let ALL_OPTIONS = [];
  let VISIBLE_ALTS = 0;
  let CURRENT_CHOSEN = null;

  // mantieni info ultima ricerca quando tocchi “Altre”
  let LAST_DATASET_INFO = "";
  let LAST_USED_MINUTES = null;
  let LAST_MAX_MINUTES_INPUT = null;

  // -------------------- UTIL --------------------
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const toRad = (x) => (x * Math.PI) / 180;

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

  const fmtKm = (km) => `${Math.round(km)} km`;

  function normName(s) {
    return String(s ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
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
    return (
      lat >= bbox.minLat &&
      lat <= bbox.maxLat &&
      lon >= bbox.minLon &&
      lon <= bbox.maxLon
    );
  }

  function isWinterNow() {
    const m = new Date().getMonth() + 1;
    return m === 11 || m === 12 || m === 1 || m === 2 || m === 3;
  }
  function isSummerNow() {
    const m = new Date().getMonth() + 1;
    return m === 6 || m === 7 || m === 8 || m === 9;
  }

  function scrollToId(id) {
    const el = $(id);
    if (!el) return;
    setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "start" }), 20);
  }

  // -------------------- MINI CSS --------------------
  function injectMiniCssOnce() {
    if (document.getElementById("jamo-mini-css")) return;
    const st = document.createElement("style");
    st.id = "jamo-mini-css";
    st.textContent = `
      .moreBtn{
        width:100%;
        border:1px solid rgba(255,255,255,.14);
        background:rgba(255,255,255,.05);
        color:#fff;
        border-radius:16px;
        padding:12px;
        font-weight:950;
        cursor:pointer;
      }
      .optBtn{
        width:100%;
        text-align:left;
        border:1px solid rgba(255,255,255,.10);
        background:rgba(255,255,255,.04);
        color:#fff;
        border-radius:18px;
        padding:12px;
        cursor:pointer;
      }
      .optBtn:active{transform:scale(.99)}
      .optList{display:flex; flex-direction:column; gap:10px;}
      .optTop{display:flex; justify-content:space-between; gap:10px; align-items:flex-start;}
      .optName{font-weight:950; font-size:16px; line-height:1.15;}
      .optMeta{display:flex; flex-wrap:wrap; gap:8px; margin-top:8px;}
      .pill{
        display:inline-flex; gap:8px; align-items:center;
        padding:7px 10px; border-radius:999px;
        border:1px solid rgba(255,255,255,.14);
        background:rgba(0,0,0,.25);
        font-weight:900; font-size:12px;
      }
      .pill.soft{opacity:.92}
      .pill.acc{border-color: rgba(0,224,255,.40); background: rgba(0,224,255,.10);}
      .clickSafe *{ -webkit-tap-highlight-color: transparent; }
    `;
    document.head.appendChild(st);
  }

  // -------------------- MAP STATIC --------------------
  function osmStaticImgPrimary(lat, lon, z = 12) {
    const size = "720x360";
    const marker = `${lat},${lon},lightblue1`;
    return `https://staticmap.openstreetmap.de/staticmap.php?center=${encodeURIComponent(
      lat + "," + lon
    )}&zoom=${encodeURIComponent(z)}&size=${encodeURIComponent(
      size
    )}&maptype=mapnik&markers=${encodeURIComponent(marker)}`;
  }
  function osmStaticImgFallback(lat, lon, z = 12) {
    const size = "720x360";
    const marker = `color:blue|${lat},${lon}`;
    return `https://staticmap.openstreetmap.fr/osmfr/staticmap.php?center=${encodeURIComponent(
      lat + "," + lon
    )}&zoom=${encodeURIComponent(z)}&size=${encodeURIComponent(
      size
    )}&markers=${encodeURIComponent(marker)}`;
  }

  // -------------------- LINKS --------------------
  function mapsDirUrl(oLat, oLon, dLat, dLon) {
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
      oLat + "," + oLon
    )}&destination=${encodeURIComponent(
      dLat + "," + dLon
    )}&travelmode=driving`;
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
    return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(
      stableQuery(name, area)
    )}`;
  }
  function wikiUrl(name, area) {
    const q = area ? `${name} ${area}` : name;
    return `https://it.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`;
  }

  function bookingSearchUrl(name, area) {
    const aid = CFG.AFFILIATE.BOOKING_AID?.trim();
    if (!aid) return googleSearchUrl(`${stableQuery(name, area)} hotel terme spa`);
    return `https://www.booking.com/searchresults.it.html?aid=${encodeURIComponent(
      aid
    )}&ss=${encodeURIComponent(`${name} ${area || ""}`)}`;
  }
  function gygSearchUrl(name, area) {
    const pid = CFG.AFFILIATE.GYG_PARTNER_ID?.trim();
    if (!pid) return googleSearchUrl(`${stableQuery(name, area)} biglietti tour prenota`);
    return `https://www.getyourguide.com/s/?partner_id=${encodeURIComponent(
      pid
    )}&q=${encodeURIComponent(`${name} ${area || ""}`)}`;
  }
  function theforkSearchUrl(name, area, lat, lon) {
    const q = `ristoranti vicino ${name} ${area || ""}`.trim();
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      q
    )}&center=${encodeURIComponent(lat + "," + lon)}`;
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
      $("originStatus").textContent = `✅ Partenza impostata: ${
        label || "posizione"
      } (${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)})${cc ? " • " + cc : ""}`;
    }

    collapseOriginCard(true);
  }

  function clearOrigin({ keepText = false } = {}) {
    localStorage.removeItem("jamo_origin");
    $("originLat") && ($("originLat").value = "");
    $("originLon") && ($("originLon").value = "");
    $("originCC") && ($("originCC").value = "");
    if (!keepText) $("originLabel") && ($("originLabel").value = "");
    if ($("originStatus"))
      $("originStatus").textContent =
        "🧽 Partenza resettata. Inserisci un nuovo luogo e premi “Usa questo luogo”.";
    collapseOriginCard(false);
    showStatus("ok", "Partenza resettata ✅");
    scrollToId("quickStartCard");
  }

  function getOrigin() {
    const lat = Number($("originLat")?.value);
    const lon = Number($("originLon")?.value);
    const label = ($("originLabel")?.value || "").trim();
    const ccDom = String($("originCC")?.value || "").toUpperCase();

    if (Number.isFinite(lat) && Number.isFinite(lon))
      return { label, lat, lon, country_code: ccDom };

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
  function saveVisitedSet(set) {
    localStorage.setItem("jamo_visited", JSON.stringify([...set]));
  }
  function markVisited(placeId) {
    const s = getVisitedSet();
    s.add(placeId);
    saveVisitedSet(s);
  }
  function resetVisited() { localStorage.removeItem("jamo_visited"); }

  function loadRecent() {
    const raw = localStorage.getItem("jamo_recent");
    if (!raw) return [];
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  function saveRecent(list) {
    localStorage.setItem("jamo_recent", JSON.stringify(list.slice(0, CFG.RECENT_MAX)));
  }
  function cleanupRecent(list) {
    const t = Date.now();
    return list.filter((x) => x && x.pid && t - (x.ts || 0) <= CFG.RECENT_TTL_MS);
  }
  function addRecent(pid) {
    const t = Date.now();
    let list = cleanupRecent(loadRecent());
    list.unshift({ pid, ts: t });
    const seen = new Set();
    list = list.filter((x) => (seen.has(x.pid) ? false : (seen.add(x.pid), true)));
    saveRecent(list);
  }
  function getRecentSet() {
    const list = cleanupRecent(loadRecent());
    saveRecent(list);
    return new Set(list.map((x) => x.pid));
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
      type === "ok"
        ? "rgba(26,255,213,.35)"
        : type === "err"
        ? "rgba(255,90,90,.40)"
        : "rgba(255,180,80,.40)";
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
        [...el.querySelectorAll(".chip")].forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
      } else {
        chip.classList.toggle("active");
      }

      // sync time
      if (containerId === "timeChips") {
        const v = Number(chip.dataset.min);
        if (Number.isFinite(v) && $("maxMinutes")) $("maxMinutes").value = String(v);
      }

      // toggle eventi subfilters on category click
      if (containerId === "categoryChips") {
        refreshEventsSubfiltersUI();
      }
    });
  }

  function initTimeChipsSync() {
    $("maxMinutes")?.addEventListener("input", () => {
      const v = Number($("maxMinutes").value);
      const chipsEl = $("timeChips");
      if (!chipsEl) return;
      const chips = [...chipsEl.querySelectorAll(".chip")];
      chips.forEach((c) => c.classList.remove("active"));
      const match = chips.find((c) => Number(c.dataset.min) === v);
      if (match) match.classList.add("active");
    });
  }

  function getActiveCategory() {
    const el = $("categoryChips");
    const active = el?.querySelector(".chip.active");
    const cat = String(active?.dataset.cat || "").trim().toLowerCase();
    return cat || "natura";
  }

  function getActiveStyles() {
    const el = $("styleChips");
    const actives = [...(el?.querySelectorAll(".chip.active") || [])].map((c) => c.dataset.style);
    return {
      wantChicche: actives.includes("chicche"),
      wantClassici: actives.includes("classici"),
    };
  }

  function getEventType() {
    const el = $("eventTypeChips");
    const a = el?.querySelector(".chip.active");
    return String(a?.dataset.etype || "tutti");
  }
  function getEventWhen() {
    const el = $("eventWhenChips");
    const a = el?.querySelector(".chip.active");
    return String(a?.dataset.ewhen || "oggi");
  }
  function refreshEventsSubfiltersUI() {
    const sub = $("eventsSubfilters");
    if (!sub) return;
    const cat = canonicalCategory(getActiveCategory());
    sub.classList.toggle("active", cat === "eventi");
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
    if (s === "borgo" || s === "borghi") return "borghi";
    if (s === "trekking") return "hiking";
    if (s === "montagna") return "montagna";
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

    out.tags = Array.isArray(out.tags) ? out.tags.map((x) => String(x).toLowerCase()) : [];
    out.country = String(out.country || "").toUpperCase();
    out.area = String(out.area || "");
    return out;
  }

  // -------------------- IT REGIONS INDEX --------------------
  async function loadItalyRegionsIndexSafe(signal) {
    if (IT_REGIONS_INDEX?.items?.length) return IT_REGIONS_INDEX;
    try { IT_REGIONS_INDEX = await fetchJson(CFG.IT_REGIONS_INDEX_URL, { signal }); }
    catch { IT_REGIONS_INDEX = null; }
    return IT_REGIONS_INDEX;
  }

  function pickItalyRegionByOrigin(origin) {
    const lat = Number(origin?.lat);
    const lon = Number(origin?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const items = IT_REGIONS_INDEX?.items;
    if (!Array.isArray(items) || !items.length) return null;

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

  // ✅ categoria canonica: no ovunque/citta/panorami
  function canonicalCategory(cat) {
    const c = String(cat || "").toLowerCase().trim();
    if (c === "trekking" || c === "hiking") return "hiking";
    if (c === "eventi") return "eventi";
    return c || "natura";
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
    const isItaly = cc === "IT" || !!region;

    const cat = canonicalCategory(categoryUI);
    const pools = [];

    if (isItaly && region?.id) {
      const rid = String(region.id);

      // regione-cat
      const p1 = region.paths?.[cat] || `/data/pois/regions/${rid}-${cat}.json`;
      const loaded1 = await tryLoadPlacesFile(p1, signal);
      if (loaded1) {
        pools.push({ kind: "region", source: p1, places: loaded1.places, bbox: region.bbox || null, regionId: rid });
        DATASETS_USED.push({ kind: "region", source: p1, placesLen: loaded1.places.length });
      }

      // regione-core
      const p2 = region.paths?.core || `/data/pois/regions/${rid}.json`;
      const loaded2 = await tryLoadPlacesFile(p2, signal);
      if (loaded2) {
        pools.push({ kind: "region", source: p2, places: loaded2.places, bbox: region.bbox || null, regionId: rid });
        DATASETS_USED.push({ kind: "region", source: p2, placesLen: loaded2.places.length });
      }
    }

    // radius-cat (utile)
    const p3 = `/data/pois/regions/radius-${cat}.json`;
    const loaded3 = await tryLoadPlacesFile(p3, signal);
    if (loaded3) {
      pools.push({ kind: "radius", source: p3, places: loaded3.places, bbox: null });
      DATASETS_USED.push({ kind: "radius", source: p3, placesLen: loaded3.places.length });
    }

    // macro
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
      break;
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

  // -------------------- TAGS / FILTERS --------------------
  const placeTags = (place) => (place.tags || []).map((t) => String(t).toLowerCase());
  const tagsStr = (place) => placeTags(place).join(" ");
  const hasAny = (str, arr) => { for (const k of arr) if (str.includes(k)) return true; return false; };

  function hasQualitySignals(place) {
    const t = tagsStr(place);
    return (
      t.includes("wikipedia=") ||
      t.includes("wikidata=") ||
      t.includes("website=") ||
      t.includes("opening_hours=") ||
      t.includes("contact:website=") ||
      t.includes("phone=") ||
      t.includes("contact:phone=")
    );
  }

  function isClearlyIrrelevantPlace(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    if (hasAny(t, ["highway=", "railway=", "public_transport=", "route=", "junction=", "highway=bus_stop", "highway=platform"])) return true;
    if (hasAny(t, ["amenity=parking", "amenity=parking_entrance", "amenity=parking_space", "highway=rest_area", "amenity=fuel", "amenity=charging_station"])) return true;
    if (hasAny(t, ["landuse=industrial", "landuse=commercial", "building=industrial", "building=warehouse", "building=office", "man_made=works"])) return true;
    if (hasAny(t, ["man_made=survey_point", "power=", "telecom=", "pipeline=", "place=locality"])) return true;
    if (hasAny(n, ["parcheggio", "stazione", "fermata", "svincolo", "uscita", "cabina", "impianto", "linea", "km "])) return true;
    return false;
  }

  function looksWellnessByName(place) {
    const n = normName(place?.name || "");
    return hasAny(n, ["terme","termale","thermal","spa","wellness","benessere","hammam","hamam","sauna"]);
  }
  function looksBeachByName(place) {
    const n = normName(place?.name || "");
    return hasAny(n, ["spiaggia","lido","baia","cala","scogliera","mare","beach"]);
  }
  function looksTrailByName(place) {
    const n = normName(place?.name || "");
    return hasAny(n, ["sentier","cai","trail","anello","percorso","via ferrata","ferrata","trek"]);
  }
  function looksMountainByName(place) {
    const n = normName(place?.name || "");
    return hasAny(n, ["monte","cima","passo","rifugio","malga","alpe","valico","piana","laghetto"]);
  }

  function isSpaPlace(place) {
    const t = tagsStr(place);
    const nm = normName(place?.name || "");
    const spaTags =
      t.includes("amenity=spa") || t.includes("leisure=spa") || t.includes("tourism=spa") ||
      t.includes("natural=hot_spring") || t.includes("amenity=public_bath") ||
      t.includes("amenity=sauna") || t.includes("leisure=sauna") ||
      t.includes("healthcare=sauna") || t.includes("healthcare=spa") ||
      t.includes("bath:type=thermal") || t.includes("thermal") || t.includes("terme");
    const poolSpaLike =
      t.includes("leisure=swimming_pool") && (nm.includes("terme") || nm.includes("spa") || nm.includes("thermal") || nm.includes("wellness"));
    return spaTags || looksWellnessByName(place) || poolSpaLike;
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
    return t.includes("leisure=adventure_park") || n.includes("parco avventura") || n.includes("zipline") || n.includes("percorsi sospesi");
  }

  function isNature(place) {
    const t = tagsStr(place);
    const type = normalizeType(place?.type);
    return (
      type === "natura" ||
      t.includes("natural=waterfall") ||
      t.includes("natural=cave_entrance") ||
      t.includes("natural=volcano") ||
      t.includes("natural=peak") ||
      t.includes("water=lake") || t.includes("natural=water") ||
      t.includes("natural=gorge") ||
      t.includes("boundary=national_park") ||
      t.includes("leisure=nature_reserve") ||
      t.includes("leisure=park") ||
      t.includes("leisure=garden")
    );
  }

  function isBorgo(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    const type = normalizeType(place?.type);

    const isSettlement =
      t.includes("place=village") ||
      t.includes("place=hamlet") ||
      t.includes("place=town") ||
      t.includes("place=suburb") ||
      t.includes("place=neighbourhood");

    const nameLooksBorgo = hasAny(n, ["borgo","centro storico","frazione","contrada","corte","castel"]);
    const nameLooksObject = hasAny(n, [
      "ponte","locomotiva","treno","museo","area archeologica","villa comunale","parco",
      "torre","rocca","forte","bagno","cascata","gola","sorgente","belvedere","sentiero",
      "rifugio","spiaggia","lido"
    ]);

    const typeSaysBorgo = (type === "borghi" || type === "borgo");

    if (isSettlement) return true;
    if ((typeSaysBorgo || nameLooksBorgo) && !nameLooksObject) return true;
    return false;
  }

  function isHiking(place) {
    const t = tagsStr(place);
    const type = normalizeType(place?.type);
    const n = normName(place?.name || "");

    if (type === "hiking") return true;

    if (t.includes("tourism=alpine_hut") || t.includes("amenity=shelter") || t.includes("building=hut")) return true;
    if (t.includes("information=guidepost") || t.includes("information=route_marker")) return true;

    const hasTrailTags =
      t.includes("route=hiking") ||
      t.includes("route=foot") ||
      t.includes("highway=path") ||
      t.includes("highway=footway") ||
      t.includes("highway=track") ||
      t.includes("sac_scale=") ||
      t.includes("trail_visibility=");

    if (hasTrailTags && (looksTrailByName(place) || hasQualitySignals(place))) return true;

    if (t.includes("natural=peak") && (hasTrailTags || looksTrailByName(place))) return true;

    if (hasQualitySignals(place) && looksTrailByName(place) && n.length >= 6) return true;

    return false;
  }

  function isSea(place) {
    const t = tagsStr(place);
    const type = normalizeType(place?.type);
    const quality = hasQualitySignals(place);
    const n = normName(place?.name || "");

    if (type === "mare") return true;
    if (t.includes("natural=beach")) return true;
    if (t.includes("leisure=marina")) return true;
    if (t.includes("man_made=pier") && (looksBeachByName(place) || quality)) return true;

    if (t.includes("tourism=attraction") && looksBeachByName(place)) return true;

    if (t.includes("natural=coastline")) return looksBeachByName(place) || quality;

    if (looksBeachByName(place) && (quality || t.includes("tourism=") || t.includes("natural="))) return true;

    if (hasAny(n, ["bar", "ristorante", "hotel"]) && looksBeachByName(place)) return false;

    return false;
  }

  function isMountain(place) {
    const t = tagsStr(place);
    const type = normalizeType(place?.type);
    const quality = hasQualitySignals(place);

    if (type === "montagna") return true;

    // forti
    if (t.includes("natural=peak")) return true;
    if (t.includes("tourism=alpine_hut") || t.includes("amenity=shelter") || t.includes("building=hut")) return true;
    if (t.includes("aerialway=")) return true;
    if (t.includes("piste:type=") || t.includes("sport=skiing")) return true;

    // passi / viewpoint alpini
    if (t.includes("mountain_pass=") || t.includes("natural=valley")) return true;

    // fallback: nome + qualità
    if (looksMountainByName(place) && (quality || t.includes("natural=") || t.includes("tourism="))) return true;

    return false;
  }

  function isWinery(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    if (t.includes("craft=winery")) return true;
    if (t.includes("shop=wine")) return true;
    if (t.includes("amenity=wine_bar")) return true;
    if (hasAny(n, ["cantina","winery","vino","vini","enoteca","degustaz","wine tasting","wine tour"])) return true;
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

    if (category === "relax" && lodging) {
      if (isSpaPlace(place) || looksWellnessByName(place)) return false;
    }
    if (category === "cantine" && food) {
      if (isWinery(place)) return false;
    }

    return lodging || food;
  }

  function isTouristicVisitabile(place, categoryUI) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    const cat = canonicalCategory(categoryUI);
    const quality = hasQualitySignals(place);

    if (cat === "borghi") return isBorgo(place);
    if (cat === "relax") return isSpaPlace(place);
    if (cat === "cantine") return isWinery(place) && (quality || t.includes("website="));
    if (cat === "hiking") return isHiking(place);
    if (cat === "mare") return isSea(place);
    if (cat === "montagna") return isMountain(place);

    // (eventi: prossimo step)
    if (cat === "eventi") return false;

    const strong =
      t.includes("tourism=attraction") ||
      t.includes("tourism=museum") ||
      t.includes("tourism=gallery") ||
      t.includes("tourism=theme_park") ||
      t.includes("tourism=zoo") ||
      t.includes("tourism=aquarium") ||
      t.includes("historic=") ||
      t.includes("heritage=") ||
      t.includes("natural=peak") ||
      t.includes("natural=waterfall") ||
      t.includes("natural=cave_entrance") ||
      t.includes("natural=volcano") ||
      t.includes("boundary=national_park") ||
      t.includes("leisure=nature_reserve") ||
      t.includes("leisure=park") ||
      t.includes("leisure=garden") ||
      t.includes("man_made=lighthouse") ||
      t.includes("man_made=tower");

    if (strong) return true;

    if (
      quality &&
      hasAny(n, ["castell","abbazi","duomo","cattedral","museo","gole","cascat","parco","riserva","oasi","lago","forte","rocca"])
    ) {
      return true;
    }

    return false;
  }

  function matchesCategoryStrict(place, catUI) {
    const cat = canonicalCategory(catUI);

    if (cat === "natura") return isNature(place);
    if (cat === "hiking") return isHiking(place);
    if (cat === "mare") return isSea(place);
    if (cat === "relax") return isSpaPlace(place);
    if (cat === "borghi") return isBorgo(place);
    if (cat === "cantine") return isWinery(place);
    if (cat === "montagna") return isMountain(place);

    const t = tagsStr(place);
    if (cat === "storia") {
      return (
        t.includes("historic=castle") ||
        t.includes("historic=fort") ||
        t.includes("historic=citywalls") ||
        t.includes("historic=archaeological_site") ||
        t.includes("historic=ruins") ||
        t.includes("historic=monument") ||
        t.includes("historic=memorial") ||
        t.includes("historic=palace") ||
        t.includes("tourism=museum") ||
        t.includes("tourism=attraction")
      );
    }
    if (cat === "family") {
      return (
        isThemePark(place) ||
        isWaterPark(place) ||
        isZooOrAquarium(place) ||
        isAdventurePark(place) ||
        (t.includes("tourism=museum") && (t.includes("children") || t.includes("science") || t.includes("planetarium")))
      );
    }

    return true;
  }

  function matchesStyle(place, { wantChicche, wantClassici }) {
    const vis = normalizeVisibility(place?.visibility);
    if (!wantChicche && !wantClassici) return true;
    if (vis === "unknown") return true;
    if (vis === "chicca") return !!wantChicche;
    return !!wantClassici;
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
    const summerThing = t.includes("leisure=water_park") || t.includes("natural=beach") || t.includes("leisure=marina");
    const winterThing = t.includes("piste:type=") || t.includes("sport=skiing") || t.includes("aerialway=");

    if (isWinterNow() && summerThing) return -0.18;
    if (isSummerNow() && winterThing) return -0.18;

    if (isWinterNow() && isSpaPlace(place)) return +0.12;
    if (isSummerNow() && summerThing) return +0.06;

    return 0;
  }

  function jitter() { return (Math.random() - 0.5) * 0.06; }

  function borgoBoost(place, categoryUI) {
    if (canonicalCategory(categoryUI) !== "borghi") return 0;
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    let b = 0;
    if (t.includes("historic=") || t.includes("heritage=")) b += 0.10;
    if (hasQualitySignals(place)) b += 0.08;
    if (hasAny(n, ["centro storico","borgo","castel","rocca","pieve","duomo"])) b += 0.06;
    return b;
  }

  // -------------------- PICK OPTIONS --------------------
  function buildCandidatesFromPool(pool, origin, maxMinutes, categoryUI, styles, { ignoreVisited=false, ignoreRotation=false } = {}) {
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

      if (!isTouristicVisitabile(p, categoryUI)) continue;
      if (!matchesCategoryStrict(p, categoryUI)) continue;

      if (!matchesStyle(p, styles)) continue;

      const pid = safeIdFromPlace(p);
      if (!ignoreVisited && visited.has(pid)) continue;

      const km = haversineKm(oLat, oLon, p.lat, p.lon);
      const driveMin = estCarMinutesFromKm(km);
      if (!Number.isFinite(driveMin) || driveMin > target) continue;

      const minKm = canonicalCategory(categoryUI) === "family" ? CFG.MIN_KM_FAMILY : CFG.MIN_KM_DEFAULT;
      if (km < minKm) continue;

      const isChicca = normalizeVisibility(p.visibility) === "chicca";
      let s = baseScorePlace({ driveMin, targetMin: target, beautyScore: p.beauty_score, isChicca });

      if (styles?.wantChicche && !styles?.wantClassici) {
        if (normalizeVisibility(p.visibility) === "unknown") s -= 0.06;
      }
      if (styles?.wantClassici && !styles?.wantChicche) {
        if (normalizeVisibility(p.visibility) === "unknown") s -= 0.04;
      }

      s += seasonAdjust(p);
      s += borgoBoost(p, categoryUI);

      if (!ignoreRotation) s -= rotationPenalty(pid, recentSet);
      s += jitter();

      candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
    }

    candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
    return candidates;
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

  function pickTopOptions(pool, origin, minutes, categoryUI, styles) {
    let c = buildCandidatesFromPool(pool, origin, minutes, categoryUI, styles, { ignoreVisited:false, ignoreRotation:false });
    if (c.length) return { list: c, usedFallback: false };

    c = buildCandidatesFromPool(pool, origin, minutes, categoryUI, styles, { ignoreVisited:false, ignoreRotation:true });
    if (c.length) return { list: c, usedFallback: true };

    c = buildCandidatesFromPool(pool, origin, minutes, categoryUI, styles, { ignoreVisited:true, ignoreRotation:true });
    return { list: c, usedFallback: true };
  }

  // -------------------- LABELS / ICONS --------------------
  function typeBadge(categoryUI) {
    const category = canonicalCategory(categoryUI);
    const map = {
      natura:   { emoji:"🌿", label:"Natura" },
      hiking:   { emoji:"🥾", label:"Trekking" },
      borghi:   { emoji:"🏘️", label:"Borghi" },
      storia:   { emoji:"🏛️", label:"Storia" },
      montagna: { emoji:"🏔️", label:"Montagna" },
      mare:     { emoji:"🌊", label:"Mare" },
      relax:    { emoji:"🧖", label:"Relax" },
      family:   { emoji:"👨‍👩‍👧‍👦", label:"Family" },
      cantine:  { emoji:"🍷", label:"Cantine" },
      eventi:   { emoji:"🎉", label:"Eventi" },
    };
    return map[category] || { emoji:"📍", label:"Meta" };
  }

  function visibilityLabel(place) {
    const v = normalizeVisibility(place?.visibility);
    if (v === "chicca") return "✨ Chicca";
    if (v === "classica") return "✅ Classica";
    return "⭐ Selezione";
  }

  function shortWhatIs(place, categoryUI) {
    const category = canonicalCategory(categoryUI);
    const t = tagsStr(place);

    if (category === "cantine") return "Cantina/Enoteca • degustazioni e visite (prenotazione consigliata).";
    if (category === "relax") return "Relax • terme/spa/sauna (spesso su prenotazione).";
    if (category === "mare") return "Mare • spiaggia/baia/scogliera (stagione consigliata).";
    if (category === "hiking") return "Trekking • controlla meteo e percorso (scarpe ok).";
    if (category === "montagna") return "Montagna • picchi/rifugi/passi/impianti (controlla meteo).";
    if (category === "storia") return "Storia • castelli/musei/attrazioni (verifica orari).";
    if (category === "borghi") return "Borgo • passeggiata nel centro, scorci e foto.";
    if (category === "natura") {
      if (t.includes("natural=waterfall")) return "Cascata • foto + passeggiata.";
      if (t.includes("natural=cave_entrance")) return "Grotta • verifica accesso/sicurezza.";
      if (t.includes("water=lake") || t.includes("natural=water")) return "Lago • relax e foto.";
      return "Spot natura • perfetto per uscita veloce.";
    }
    return "Meta selezionata in base a tempo e filtri.";
  }

  // -------------------- RENDER --------------------
  function showResultProgress(msg = "Cerco nel dataset offline…") {
    const area = $("resultArea");
    if (!area) return;
    area.innerHTML = `
      <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,180,80,.35); background:rgba(255,180,80,.06);">
        <div style="font-weight:950; font-size:18px;">🔎 Sto cercando…</div>
        <div class="small muted" style="margin-top:8px; line-height:1.4;">${escapeHtml(msg)}</div>
      </div>
    `;
  }

  function renderNoResult(maxMinutesShown, categoryUI, datasetInfo) {
    const area = $("resultArea");
    if (!area) return;

    area.innerHTML = `
      <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
        <div class="small">❌ Nessuna meta trovata entro <b>${maxMinutesShown} min</b> per <b>${escapeHtml(categoryUI)}</b>.</div>
        <div class="small muted" style="margin-top:6px;">Tip: aumenta i minuti oppure prova un’altra categoria.</div>
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

  function renderEventiPlaceholder() {
    const area = $("resultArea");
    if (!area) return;
    const et = getEventType();
    const ew = getEventWhen();
    area.innerHTML = `
      <div class="card clickSafe" style="box-shadow:none; border-color:rgba(0,224,255,.25); background:rgba(0,224,255,.06);">
        <div style="font-weight:950; font-size:18px;">🎉 Eventi (in arrivo)</div>
        <div class="small muted" style="margin-top:8px; line-height:1.45;">
          Subfiltri selezionati: <b>${escapeHtml(et)}</b> • <b>${escapeHtml(ew)}</b><br>
          Nel prossimo step aggiungiamo il dataset eventi offline + workflow di aggiornamento.
        </div>
      </div>
    `;
    showStatus("warn", "Eventi: funzione in arrivo (ora UI ok).");
    scrollToId("resultCard");
  }

  function renderOptionsListHTML() {
    const chosen = CURRENT_CHOSEN;
    if (!chosen) return "";

    const alts = ALL_OPTIONS.filter(x => x.pid !== chosen.pid);
    if (!alts.length) return "";

    const visible = alts.slice(0, VISIBLE_ALTS);
    const chosenCat = canonicalCategory(getActiveCategory());
    const tb = typeBadge(chosenCat);

    const items = visible.map((x) => {
      const p = x.place;
      const name = escapeHtml(p.name || "");
      const time = `~${x.driveMin} min`;
      const areaLabel = escapeHtml((p.area || p.country || "—").trim());
      const vis = escapeHtml(visibilityLabel(p));

      return `
        <button class="optBtn clickSafe" data-pid="${escapeHtml(x.pid)}" type="button">
          <div class="optTop">
            <div class="optName">${name}</div>
            <div class="small muted" style="font-weight:950;">${time}</div>
          </div>
          <div class="optMeta">
            <span class="pill acc">${tb.emoji} ${tb.label}</span>
            <span class="pill soft">${vis}</span>
            <span class="pill soft">📍 ${areaLabel}</span>
          </div>
        </button>
      `;
    }).join("");

    const canMore = VISIBLE_ALTS < alts.length;

    return `
      <div style="margin-top:14px;">
        <div style="font-weight:950; font-size:18px; margin: 6px 0 10px;">Altre destinazioni</div>
        <div class="optList">${items}</div>
        ${canMore ? `<button class="moreBtn clickSafe" id="btnMoreAlts" type="button">⬇️ Altre ${CFG.ALTS_PAGE}</button>` : ""}
        <div class="small muted" style="margin-top:10px;">Tocca un’opzione per aprire la scheda (senza rifare ricerca).</div>
      </div>
    `;
  }

  function updateAltsUI() {
    const altsArea = $("altsArea");
    if (!altsArea) return;
    altsArea.innerHTML = renderOptionsListHTML();
  }

  function renderChosenCard(origin, chosen, categoryUI, datasetInfo, usedMinutes, maxMinutesInput) {
    const area = $("resultArea");
    if (!area) return;

    const p = chosen.place;
    const pid = chosen.pid;

    const tb = typeBadge(canonicalCategory(categoryUI));
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
      <div class="clickSafe" style="border-radius:18px; overflow:hidden; border:1px solid rgba(0,224,255,.18);">
        <div style="position:relative; width:100%; aspect-ratio: 2 / 1; border-bottom:1px solid rgba(255,255,255,.10);">
          <img src="${img1}" alt="" loading="lazy" decoding="async"
               style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; opacity:.95;"
               onerror="(function(img){
                 if(!img.dataset.fallbackTried){ img.dataset.fallbackTried='1'; img.src='${img2}'; return; }
                 img.style.display='none';
               })(this)"
          />
          <div style="position:absolute; left:12px; top:12px; display:flex; gap:8px; flex-wrap:wrap; max-width: calc(100% - 24px);">
            <div class="pill acc">${tb.emoji} ${tb.label}</div>
            <div class="pill">🚗 ~${chosen.driveMin} min • ${fmtKm(chosen.km)}</div>
            <div class="pill soft">${escapeHtml(vis)}</div>
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

          <div id="altsArea">${renderOptionsListHTML()}</div>
        </div>
      </div>
    `;

    $("btnGo")?.addEventListener("click", () => {
      window.open(mapsDirUrl(origin.lat, origin.lon, lat, lon), "_blank", "noopener");
    });

    $("btnBook")?.addEventListener("click", () => {
      const cat = canonicalCategory(categoryUI);
      const url =
        (cat === "family" || cat === "storia" || cat === "montagna" || cat === "hiking")
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

    LAST_SHOWN_PID = pid;
    SESSION_SEEN.add(pid);
    addRecent(pid);
  }

  // -------------------- EVENT DELEGATION (opzioni + more) --------------------
  function bindResultAreaDelegation() {
    const area = $("resultArea");
    if (!area) return;

    area.addEventListener("click", (e) => {
      const moreBtn = e.target.closest("#btnMoreAlts");
      if (moreBtn) {
        const before = VISIBLE_ALTS;
        VISIBLE_ALTS = Math.min(Math.max(0, ALL_OPTIONS.length - 1), VISIBLE_ALTS + CFG.ALTS_PAGE);
        if (VISIBLE_ALTS !== before) {
          updateAltsUI();
          setTimeout(() => {
            const mb = $("btnMoreAlts") || moreBtn;
            mb?.scrollIntoView({ behavior: "smooth", block: "center" });
          }, 20);
        }
        return;
      }

      const opt = e.target.closest(".optBtn");
      if (opt) {
        const pid2 = opt.getAttribute("data-pid");
        const found = ALL_OPTIONS.find((x) => x.pid === pid2);
        if (!found) return;

        CURRENT_CHOSEN = found;
        const origin = getOrigin();
        const catUI = getActiveCategory();

        const usedMinutes = Number(LAST_USED_MINUTES ?? $("maxMinutes")?.value ?? 120);
        const maxMinutesInput = Number(LAST_MAX_MINUTES_INPUT ?? $("maxMinutes")?.value ?? 120);

        renderChosenCard(origin, found, catUI, LAST_DATASET_INFO, usedMinutes, maxMinutesInput);

        setTimeout(() => {
          $("resultCard")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 20);
        return;
      }
    });
  }

  // -------------------- SEARCH --------------------
  function widenMinutesSteps(m, categoryUI) {
    const category = canonicalCategory(categoryUI);
    const base = clamp(Number(m) || 120, 10, 600);

    const muls =
      category === "family" ? [1.15, 1.30, 1.50] :
      category === "mare"   ? [1.15, 1.35, 1.55] :
      category === "hiking" ? [1.15, 1.35, 1.60] :
      category === "montagna"?[1.15, 1.35, 1.60] :
                              [1.20, 1.40, 1.60];

    const steps = [base];
    for (const k of muls) steps.push(clamp(Math.round(base * k), base, 600));
    steps.push(clamp(Math.max(240, base), base, 600));
    return Array.from(new Set(steps)).sort((a, b) => a - b);
  }

  function combineAndScore(pools, origin, minutes, categoryUI, styles, regionBBox) {
    const regionPools = pools.filter((p) => p.kind === "region");
    const otherPools = pools.filter((p) => p.kind !== "region");

    const attempt = (poolList) => {
      let merged = [];
      for (const pl of poolList) merged = merged.concat(pl.places || []);
      const res = pickTopOptions(merged, origin, minutes, categoryUI, styles);
      return { list: dedupeDiverse(res.list), usedFallback: res.usedFallback };
    };

    if (regionPools.length) {
      const a = attempt(regionPools);
      if (a.list.length) {
        for (const x of a.list) {
          if (regionBBox && withinBBox(x.place.lat, x.place.lon, regionBBox)) x.score += 0.05;
        }
        a.list.sort((u, v) => (v.score - u.score) || (u.driveMin - v.driveMin));
      }
      return a;
    }

    const all = attempt(pools);
    if (all.list.length) return all;
    return attempt(otherPools);
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
      const cat = canonicalCategory(categoryUI);

      // Eventi: per ora solo placeholder (dataset nel prossimo step)
      if (cat === "eventi") {
        renderEventiPlaceholder();
        return;
      }

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

        const attemptRegion = combineAndScore(
          pools.filter(p => p.kind === "region"),
          origin, mins, categoryUI, styles, regionBBox
        );

        let regionList = attemptRegion.list;
        if (forbidPid) regionList = regionList.filter((x) => x.pid !== forbidPid);

        if (regionList.length >= CFG.REGION_MIN_RESULTS) {
          poolCandidates = regionList;
          usedFallback = attemptRegion.usedFallback;
          const firstRegion = pools.find((p) => p.kind === "region");
          chosenDatasetInfo = datasetInfoLabel("region", firstRegion?.source, firstRegion?.places?.length || 0);
          break;
        }

        if (regionList.length >= CFG.REGION_SOFT_MIN_RESULTS) {
          const otherPools = pools.filter((p) => p.kind !== "region");
          let mergedOther = [];
          for (const pl of otherPools) mergedOther = mergedOther.concat(pl.places || []);
          const attemptOther = pickTopOptions(mergedOther, origin, mins, categoryUI, styles);
          let otherList = dedupeDiverse(attemptOther.list);
          if (forbidPid) otherList = otherList.filter((x) => x.pid !== forbidPid);

          poolCandidates = dedupeDiverse(regionList.concat(otherList));
          usedFallback = attemptRegion.usedFallback || attemptOther.usedFallback;

          const firstRegion = pools.find((p) => p.kind === "region");
          const firstOther = pools.find((p) => p.kind !== "region");
          chosenDatasetInfo =
            `REGION:${(firstRegion?.source || "").split("/").pop() || "—"} + ${datasetInfoLabel(firstOther?.kind, firstOther?.source, firstOther?.places?.length || 0)}`;
          break;
        }

        const otherPools = pools.filter((p) => p.kind !== "region");
        let mergedOther = [];
        for (const pl of otherPools) mergedOther = mergedOther.concat(pl.places || []);
        const attemptOther = pickTopOptions(mergedOther, origin, mins, categoryUI, styles);
        let otherList = dedupeDiverse(attemptOther.list);
        if (forbidPid) otherList = otherList.filter((x) => x.pid !== forbidPid);

        if (otherList.length) {
          poolCandidates = otherList;
          usedFallback = attemptOther.usedFallback;

          const firstOther = pools.find((p) => p.kind !== "region");
          chosenDatasetInfo = datasetInfoLabel(firstOther?.kind, firstOther?.source, firstOther?.places?.length || 0);
          break;
        }

        if (token !== SEARCH_TOKEN) return;
      }

      if (token !== SEARCH_TOKEN) return;

      if (!poolCandidates.length) {
        const ds = (DATASETS_USED || [])
          .map((x) => `${x.kind}:${(x.source || "").split("/").pop()} (${x.placesLen})`)
          .join(" • ");
        renderNoResult(maxMinutesInput, categoryUI, ds || "offline");
        showStatus("warn", `Nessuna meta entro ${maxMinutesInput} min per "${categoryUI}".`);
        return;
      }

      ALL_OPTIONS = poolCandidates.slice(0, CFG.OPTIONS_POOL_MAX);
      CURRENT_CHOSEN = ALL_OPTIONS[0];

      const maxAlts = Math.max(0, ALL_OPTIONS.length - 1);
      VISIBLE_ALTS = Math.min(CFG.ALTS_INITIAL, maxAlts);

      LAST_DATASET_INFO = chosenDatasetInfo;
      LAST_USED_MINUTES = usedMinutes;
      LAST_MAX_MINUTES_INPUT = maxMinutesInput;

      renderChosenCard(origin, CURRENT_CHOSEN, categoryUI, chosenDatasetInfo, usedMinutes, maxMinutesInput);

      if (!silent) {
        const extra = usedMinutes !== maxMinutesInput ? ` (ho allargato a ${usedMinutes} min)` : "";
        const fb = usedFallback ? " • criteri allargati" : "";
        const reg = region?.name ? ` • regione: ${region.name}` : "";
        showStatus("ok", `Trovate ${ALL_OPTIONS.length} opzioni ✅ • categoria: ${categoryUI}${extra}${reg}${fb}`);
      }

      scrollToId("resultCard");
    } catch (e) {
      if (String(e?.name || "").includes("Abort")) return;
      console.error(e);
      showStatus("err", `Errore: ${String(e.message || e)}`);
    }
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
        scrollToId("searchCard");
      } catch (e) {
        console.error(e);
        if ($("originStatus")) $("originStatus").textContent = `❌ ${String(e.message || e)}`;
        showStatus("err", `Geocoding fallito: ${String(e.message || e)}`);
        scrollToId("quickStartCard");
      }
    });

    // ✅ usa il bottone dell’HTML
    $("btnResetOrigin")?.addEventListener("click", () => clearOrigin({ keepText: false }));
  }

  // -------------------- MAIN BUTTONS --------------------
  function bindMainButtons() {
    $("btnFind")?.addEventListener("click", () => runSearch({ silent: false }));
    $("btnResetVisited")?.addEventListener("click", () => {
      resetVisited();
      showStatus("ok", "Visitati resettati ✅");
    });
  }

  function initChipsAll() {
    initChips("timeChips", { multi: false });
    initChips("categoryChips", { multi: false });
    initChips("styleChips", { multi: true });

    // eventi sub-chips (non multi)
    initChips("eventTypeChips", { multi: false });
    initChips("eventWhenChips", { multi: false });

    initTimeChipsSync();
  }

  // -------------------- BOOT --------------------
  function boot() {
    injectMiniCssOnce();
    initChipsAll();
    restoreOrigin();
    bindOriginButtons();
    bindMainButtons();
    bindResultAreaDelegation();
    hideStatus();
    refreshEventsSubfiltersUI();

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
    clearOrigin,
    getDatasetsUsed: () => DATASETS_USED,
  };
})();
