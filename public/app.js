/* Jamo — app.p1.js (BASE)
 * - Config + Utils + Origin + UI chips + Dataset loaders + Eventi bridge
 * - NON include: search flow + rendering finale (arriva in p2/p3)
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

  // -------------------- STATE (shared) --------------------
  let SESSION_SEEN = new Set();
  let LAST_SHOWN_PID = null;

  let SEARCH_TOKEN = 0;
  let SEARCH_ABORT = null;

  let MACROS_INDEX = null;
  let IT_REGIONS_INDEX = null;
  let DATASETS_USED = [];

  // risultati (li usa p2/p3)
  let ALL_OPTIONS = [];
  let VISIBLE_ALTS = 0;
  let CURRENT_CHOSEN = null;

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

  function scrollToId(id) {
    const el = $(id);
    if (!el) return;
    setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "start" }), 20);
  }

  function isWinterNow() {
    const m = new Date().getMonth() + 1;
    return m === 11 || m === 12 || m === 1 || m === 2 || m === 3;
  }
  function isSummerNow() {
    const m = new Date().getMonth() + 1;
    return m === 6 || m === 7 || m === 8 || m === 9;
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

  // -------------------- ORIGIN COLLAPSE --------------------
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

  // -------------------- ORIGIN STORAGE --------------------
  function setOrigin({ label, lat, lon, country_code }) {
    $("originLabel") && ($("originLabel").value = label ?? "");
    $("originLat") && ($("originLat").value = String(lat));
    $("originLon") && ($("originLon").value = String(lon));

    const cc = String(country_code || "").toUpperCase();
    $("originCC") && ($("originCC").value = cc);

    localStorage.setItem("jamo_origin", JSON.stringify({ label, lat, lon, country_code: cc }));

    if ($("originStatus")) {
      $("originStatus").textContent = `✅ Partenza impostata: ${label || "posizione"} (${Number(lat).toFixed(
        4
      )}, ${Number(lon).toFixed(4)})${cc ? " • " + cc : ""}`;
    }
    collapseOriginCard(true);
  }

  function clearOrigin({ keepText = false } = {}) {
    localStorage.removeItem("jamo_origin");
    $("originLat") && ($("originLat").value = "");
    $("originLon") && ($("originLon").value = "");
    $("originCC") && ($("originCC").value = "");
    if (!keepText) $("originLabel") && ($("originLabel").value = "");
    if ($("originStatus")) {
      $("originStatus").textContent =
        "🧽 Partenza resettata. Inserisci un nuovo luogo e premi “Usa questo luogo”.";
    }
    collapseOriginCard(false);
    showStatus("ok", "Partenza resettata ✅");
    scrollToId("quickStartCard");
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
    try {
      return new Set(JSON.parse(raw) || []);
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
      const a = JSON.parse(raw);
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
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

  // -------------------- CHIPS --------------------
  function canonicalCategory(cat) {
    const c = String(cat || "").toLowerCase().trim();
    if (c === "trekking" || c === "hiking") return "hiking";
    if (c === "eventi") return "eventi";
    return c || "natura";
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

      if (containerId === "timeChips") {
        const v = Number(chip.dataset.min);
        if (Number.isFinite(v) && $("maxMinutes")) $("maxMinutes").value = String(v);
      }

      if (containerId === "categoryChips") refreshEventsSubfiltersUI();
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

  // -------------------- FETCH JSON --------------------
  async function fetchJson(url, { signal } = {}) {
    const r = await fetch(url, { cache: "no-store", signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }

  // -------------------- EVENTI BRIDGE --------------------
  async function runEventsSearchBridge({ origin, maxMinutesInput, categoryUI }) {
    const runner = window?.JAMO_EVENTS?.run;
    if (typeof runner !== "function") {
      showStatus("err", "Eventi non disponibili: manca events.js oppure non è stato caricato.");
      const area = $("resultArea");
      if (area) {
        area.innerHTML = `
          <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
            <div style="font-weight:950; font-size:18px;">❌ Eventi non disponibili</div>
            <div class="small muted" style="margin-top:8px; line-height:1.45;">
              Controlla che in <b>index.html</b> ci sia <b>/events.js</b> prima di <b>/app.p1.js</b>.
            </div>
          </div>
        `;
      }
      scrollToId("resultCard");
      return;
    }

    await runner({
      origin,
      maxMinutes: maxMinutesInput,
      eventType: getEventType(),
      eventWhen: getEventWhen(),
      haversineKm,
      estCarMinutesFromKm,
      escapeHtml,
      showStatus,
      scrollToId,
    });
  }

  // -------------------- NORMALIZE PLACE --------------------
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
    try {
      MACROS_INDEX = await fetchJson(CFG.MACROS_INDEX_URL, { signal });
    } catch {
      MACROS_INDEX = null;
    }
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

      const p1 = region.paths?.[cat] || `/data/pois/regions/${rid}-${cat}.json`;
      const loaded1 = await tryLoadPlacesFile(p1, signal);
      if (loaded1) {
        pools.push({ kind: "region", source: p1, places: loaded1.places, bbox: region.bbox || null, regionId: rid });
        DATASETS_USED.push({ kind: "region", source: p1, placesLen: loaded1.places.length });
      }

      const p2 = region.paths?.core || `/data/pois/regions/${rid}.json`;
      const loaded2 = await tryLoadPlacesFile(p2, signal);
      if (loaded2) {
        pools.push({ kind: "region", source: p2, places: loaded2.places, bbox: region.bbox || null, regionId: rid });
        DATASETS_USED.push({ kind: "region", source: p2, placesLen: loaded2.places.length });
      }
    }

    const p3 = `/data/pois/regions/radius-${cat}.json`;
    const loaded3 = await tryLoadPlacesFile(p3, signal);
    if (loaded3) {
      pools.push({ kind: "radius", source: p3, places: loaded3.places, bbox: null });
      DATASETS_USED.push({ kind: "radius", source: p3, placesLen: loaded3.places.length });
    }

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

    const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, {
      method: "GET",
      cache: "no-store",
    });

    const j = await r.json().catch(() => null);
    if (!j) throw new Error("Geocoding fallito (risposta vuota)");
    if (!j.ok) throw new Error(j.error || "Geocoding fallito");
    if (!j.result || !Number.isFinite(Number(j.result.lat)) || !Number.isFinite(Number(j.result.lon))) {
      throw new Error("Geocoding fallito (coordinate non valide)");
    }
    return j.result;
  }

  // -------------------- BOOT (solo setup base) --------------------
  function initChipsAll() {
    initChips("timeChips", { multi: false });
    initChips("categoryChips", { multi: false });
    initChips("styleChips", { multi: true });
    initChips("eventTypeChips", { multi: false });
    initChips("eventWhenChips", { multi: false });
    initTimeChipsSync();
  }

  function disableGPS() {
    const b = $("btnUseGPS");
    if (b) {
      b.style.display = "none";
      b.disabled = true;
      b.setAttribute("aria-hidden", "true");
    }
  }

  function bindOriginButtonsBase() {
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

        showStatus("ok", "Partenza impostata ✅");
        scrollToId("searchCard");
      } catch (e) {
        console.error(e);
        if ($("originStatus")) $("originStatus").textContent = `❌ ${String(e.message || e)}`;
        showStatus("err", `Geocoding fallito: ${String(e.message || e)}`);
        scrollToId("quickStartCard");
      }
    });

    $("btnResetOrigin")?.addEventListener("click", () => clearOrigin({ keepText: false }));
  }

  function bootP1() {
    injectMiniCssOnce();
    initChipsAll();
    restoreOrigin();
    bindOriginButtonsBase();
    hideStatus();
    refreshEventsSubfiltersUI();

    const origin = getOrigin();
    if (origin) collapseOriginCard(true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootP1, { once: true });
  } else {
    bootP1();
  }

  // -------------------- EXPORT (per p2/p3) --------------------
  window.JAMO = window.JAMO || {};
  Object.assign(window.JAMO, {
    CFG,

    // state refs (p2/p3 li useranno)
    state: {
      get SESSION_SEEN() { return SESSION_SEEN; },
      set SESSION_SEEN(v) { SESSION_SEEN = v; },
      get LAST_SHOWN_PID() { return LAST_SHOWN_PID; },
      set LAST_SHOWN_PID(v) { LAST_SHOWN_PID = v; },

      get SEARCH_TOKEN() { return SEARCH_TOKEN; },
      set SEARCH_TOKEN(v) { SEARCH_TOKEN = v; },
      get SEARCH_ABORT() { return SEARCH_ABORT; },
      set SEARCH_ABORT(v) { SEARCH_ABORT = v; },

      get DATASETS_USED() { return DATASETS_USED; },
      set DATASETS_USED(v) { DATASETS_USED = v; },

      get ALL_OPTIONS() { return ALL_OPTIONS; },
      set ALL_OPTIONS(v) { ALL_OPTIONS = v; },
      get VISIBLE_ALTS() { return VISIBLE_ALTS; },
      set VISIBLE_ALTS(v) { VISIBLE_ALTS = v; },
      get CURRENT_CHOSEN() { return CURRENT_CHOSEN; },
      set CURRENT_CHOSEN(v) { CURRENT_CHOSEN = v; },

      get LAST_DATASET_INFO() { return LAST_DATASET_INFO; },
      set LAST_DATASET_INFO(v) { LAST_DATASET_INFO = v; },
      get LAST_USED_MINUTES() { return LAST_USED_MINUTES; },
      set LAST_USED_MINUTES(v) { LAST_USED_MINUTES = v; },
      get LAST_MAX_MINUTES_INPUT() { return LAST_MAX_MINUTES_INPUT; },
      set LAST_MAX_MINUTES_INPUT(v) { LAST_MAX_MINUTES_INPUT = v; },
    },

    // utils
    $,
    clamp,
    toRad,
    haversineKm,
    estCarMinutesFromKm,
    fmtKm,
    normName,
    escapeHtml,
    safeIdFromPlace,
    withinBBox,
    scrollToId,
    isWinterNow,
    isSummerNow,

    // ui
    showStatus,
    hideStatus,
    refreshEventsSubfiltersUI,

    // origin + visited
    setOrigin,
    clearOrigin,
    getOrigin,
    restoreOrigin,
    collapseOriginCard,
    markVisited,
    resetVisited,
    addRecent,
    getRecentSet,
    resetRotation,

    // links + maps
    osmStaticImgPrimary,
    osmStaticImgFallback,
    mapsDirUrl,
    googleSearchUrl,
    googleImagesUrl,
    wikiUrl,
    bookingSearchUrl,
    gygSearchUrl,
    theforkSearchUrl,

    // category & style
    canonicalCategory,
    getActiveCategory,
    getActiveStyles,
    getEventType,
    getEventWhen,

    // data loaders
    fetchJson,
    normalizePlace,
    normalizeType,
    normalizeVisibility,
    loadPoolsRegionFirst,
    datasetInfoLabel,

    // bridge eventi
    runEventsSearchBridge,
  });
})();
// ===============================
  // UI STATE (MINIMALE)
  // ===============================

  let UI_STATE = {
    maxMinutes: 120,
    category: "natura",
    styles: {
      chicche: true,
      classici: true
    }
  };

  // ===============================
  // CHIP HANDLERS
  // ===============================

  function initTimeChips() {
    const box = $("timeChips");
    if (!box) return;

    box.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;

      [...box.querySelectorAll(".chip")].forEach(c => c.classList.remove("active"));
      chip.classList.add("active");

      const min = Number(chip.dataset.min);
      if (Number.isFinite(min)) {
        UI_STATE.maxMinutes = min;
        $("maxMinutes").value = String(min);
      }
    });

    $("maxMinutes")?.addEventListener("input", () => {
      const v = Number($("maxMinutes").value);
      if (!Number.isFinite(v)) return;
      UI_STATE.maxMinutes = v;
    });
  }

  function initCategoryChips() {
    const box = $("categoryChips");
    if (!box) return;

    box.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;

      [...box.querySelectorAll(".chip")].forEach(c => c.classList.remove("active"));
      chip.classList.add("active");

      UI_STATE.category = chip.dataset.cat || "natura";

      // toggle eventi subfilters
      const sub = $("eventsSubfilters");
      if (sub) {
        sub.classList.toggle("active", UI_STATE.category === "eventi");
      }
    });
  }

  function initStyleChips() {
    const box = $("styleChips");
    if (!box) return;

    box.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;

      chip.classList.toggle("active");

      UI_STATE.styles.chicche =
        !!box.querySelector('[data-style="chicche"].active');
      UI_STATE.styles.classici =
        !!box.querySelector('[data-style="classici"].active');
    });
  }

  // ===============================
  // BUTTONI
  // ===============================

  function initButtons() {
    $("btnFind")?.addEventListener("click", () => {
      onSearch();
    });

    $("btnResetVisited")?.addEventListener("click", () => {
      localStorage.removeItem("jamo_visited");
      showStatus("ok", "Visitati azzerati ✅");
    });

    $("btnResetOrigin")?.addEventListener("click", () => {
      clearOrigin();
    });
  }

  // ===============================
  // SEARCH (MOCK)
  // ===============================

  function onSearch() {
    const origin = getOrigin();
    if (!origin) {
      showStatus("err", "Imposta prima una partenza.");
      scrollToId("quickStartCard");
      return;
    }

    hideStatus();

    const area = $("resultArea");
    if (!area) return;

    area.innerHTML = `
      <div class="card clickSafe">
        <div style="font-weight:950; font-size:18px;">
          🔎 Ricerca avviata
        </div>
        <div class="small muted" style="margin-top:8px; line-height:1.45;">
          <b>Categoria:</b> ${escapeHtml(UI_STATE.category)}<br>
          <b>Tempo max:</b> ${UI_STATE.maxMinutes} min<br>
          <b>Stile:</b>
          ${UI_STATE.styles.chicche ? "✨ Chicche " : ""}
          ${UI_STATE.styles.classici ? "✅ Classici" : ""}
        </div>

        <div class="small muted" style="margin-top:10px;">
          (Qui nel prossimo step collegheremo <b>Mai fatto</b> / suggerimenti reali)
        </div>
      </div>
    `;

    scrollToId("resultCard");
  }

  // ===============================
  // INIT
  // ===============================

  function initAppUI() {
    initTimeChips();
    initCategoryChips();
    initStyleChips();
    initButtons();
    restoreOrigin();
    injectMiniCssOnce();
  }

  document.addEventListener("DOMContentLoaded", initAppUI);
