/* Jamo — app.js (LITE • CLEAN • MONETIZZABILE • TAP-SAFE)
 * ✅ NO GPS
 * ✅ OFFLINE datasets in /public/data/...
 * ✅ IT: regione da bbox (it-regions-index.json)
 * ✅ PRIORITÀ: Regione(cat) → Regione(core) → Radius(cat) → Macro
 * ✅ SOLO LUOGHI TURISTICI MONETIZZABILI (gate unico)
 * ✅ TAP-SAFE: chip su pointerdown, AZIONI (apri link) SOLO su click
 */

(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // -------------------- CONFIG --------------------
  const CFG = {
    ROAD_FACTOR: 1.25,
    AVG_KMH: 72,
    FIXED_OVERHEAD_MIN: 8,

    OPTIONS_POOL_MAX: 50,
    ALTS_INITIAL: 6,
    ALTS_PAGE: 6,

    CLONE_KM: 2.2,

    IT_REGIONS_INDEX_URL: "/data/pois/regions/it-regions-index.json",
    MACROS_INDEX_URL: "/data/macros/macros_index.json",
    FALLBACK_MACRO_URLS: [
      "/data/macros/euuk_country_it.json",
      "/data/macros/euuk_macro_all.json",
    ],

    // Se regione ha pochi risultati, completa con fuori regione
    REGION_MIN_RESULTS: 8,
    REGION_SOFT_MIN_RESULTS: 3,

    AFFILIATE: {
      BOOKING_AID: "",
      GYG_PARTNER_ID: "",
      THEFORK_AFFID: "",
    },
  };

  // -------------------- STATE --------------------
  let SEARCH_ABORT = null;
  let SEARCH_TOKEN = 0;

  let IT_REGIONS_INDEX = null;
  let MACROS_INDEX = null;

  let DATASETS_USED = [];
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

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
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

  // -------------------- MINI CSS (tap-safe) --------------------
  function injectMiniCssOnce() {
    if (document.getElementById("jamo-mini-css")) return;
    const st = document.createElement("style");
    st.id = "jamo-mini-css";
    st.textContent = `
      /* chip: sempre cliccabili */
      #timeChips, #categoryChips, #styleChips { position:relative; z-index:10; pointer-events:auto; }
      .chip, .chip * { pointer-events:auto !important; touch-action:manipulation; }

      /* elimina overlay invisibili che rubano tap */
      .card::before, .card::after, .glass::before, .glass::after { pointer-events:none !important; }

      .moreBtn{width:100%; border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.04); color:#fff; border-radius:16px; padding:12px; font-weight:950; cursor:pointer;}
      .optBtn{width:100%; text-align:left; border:1px solid rgba(255,255,255,.10); background:rgba(255,255,255,.03); color:#fff; border-radius:16px; padding:12px; cursor:pointer;}
      .optBtn:active{transform:scale(.99)}
      .optList{display:flex; flex-direction:column; gap:10px;}
      .pill{display:inline-flex; gap:8px; align-items:center; padding:7px 10px; border-radius:999px; border:1px solid rgba(255,255,255,.14); background:rgba(0,0,0,.25); font-weight:850; font-size:13px;}
    `;
    document.head.appendChild(st);
  }

  // -------------------- MAP IMG --------------------
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
    if (!aid) return googleSearchUrl(`${stableQuery(name, area)} hotel`);
    return `https://www.booking.com/searchresults.it.html?aid=${encodeURIComponent(aid)}&ss=${encodeURIComponent(`${name} ${area || ""}`)}`;
  }
  function gygSearchUrl(name, area) {
    const pid = CFG.AFFILIATE.GYG_PARTNER_ID?.trim();
    if (!pid) return googleSearchUrl(`${stableQuery(name, area)} biglietti tour prenotazione`);
    return `https://www.getyourguide.com/s/?partner_id=${encodeURIComponent(pid)}&q=${encodeURIComponent(`${name} ${area || ""}`)}`;
  }
  function theforkSearchUrl(name, area, lat, lon) {
    const q = `ristoranti vicino ${name} ${area || ""}`.trim();
    // se non hai affiliazione, apri Maps search (più utile)
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}&center=${encodeURIComponent(lat + "," + lon)}`;
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
      });
    }

    if (typeof shouldCollapse === "boolean") {
      card.classList.toggle("collapsed", shouldCollapse);
      const icon = $("originToggleIcon");
      if (icon) icon.textContent = shouldCollapse ? "⬆️" : "⬇️";
    }
  }

  // -------------------- VISITED --------------------
  function getVisitedSet() {
    const raw = localStorage.getItem("jamo_visited");
    if (!raw) return new Set();
    try { return new Set(JSON.parse(raw) || []); } catch { return new Set(); }
  }
  function saveVisitedSet(set) {
    localStorage.setItem("jamo_visited", JSON.stringify([...set]));
  }
  function markVisited(pid) {
    const s = getVisitedSet();
    s.add(pid);
    saveVisitedSet(s);
  }
  function resetVisited() { localStorage.removeItem("jamo_visited"); }

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
        <div class="small">❌ Nessuna meta monetizzabile trovata entro <b>${escapeHtml(maxMinutesShown)} min</b> per <b>${escapeHtml(categoryUI)}</b>.</div>
        <div class="small muted" style="margin-top:6px;">Tip: aumenta minuti o cambia categoria.</div>
        <div class="small muted" style="margin-top:10px;">Dataset: ${escapeHtml(datasetInfo || "offline")}</div>
        <div class="row wraprow" style="gap:10px; margin-top:12px;">
          <button class="btn btnPrimary" id="btnTryAgain" type="button">🎯 Riprova</button>
        </div>
      </div>
    `;
    $("btnTryAgain")?.addEventListener("click", () => runSearch({ silent: true }));
    CURRENT_CHOSEN = null;
  }

  // -------------------- CHIPS --------------------
  function initChips(containerId, { multi = false } = {}) {
    const el = $(containerId);
    if (!el) return;

    // pointerdown SOLO per chip: evita delay e funziona su mobile
    el.addEventListener("pointerdown", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;

      e.preventDefault(); // evita click fantasma su iOS
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
    }, { passive: false });
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

  // -------------------- FETCH / LOAD --------------------
  async function fetchJson(url, { signal } = {}) {
    const r = await fetch(url, { cache: "no-store", signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }

  function normalizeType(t) {
    const s = String(t || "").toLowerCase().trim();
    if (!s) return "";
    if (s === "città" || s === "citta") return "citta";
    if (s === "panorami") return "viewpoints";
    if (s === "trekking") return "hiking";
    if (s === "borgo") return "borghi";
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
    out.tags = Array.isArray(out.tags) ? out.tags.map(x => String(x).toLowerCase()) : [];
    out.country = String(out.country || "").toUpperCase();
    out.area = String(out.area || "");
    return out;
  }

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

      return { places };
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

  async function loadPoolsRegionFirst(origin, categoryUI, { signal } = {}) {
    await loadItalyRegionsIndexSafe(signal);
    await loadMacrosIndexSafe(signal);

    DATASETS_USED = [];

    const cc = String(origin?.country_code || "").toUpperCase();
    const region = pickItalyRegionByOrigin(origin);
    const isItaly = (cc === "IT") || !!region;

    const cat = canonicalCategory(categoryUI);
    const pools = []; // [{kind, source, places, bbox?}]

    // 1) Regione categoria
    if (isItaly && region?.id) {
      const rid = String(region.id);
      const p1 = (cat !== "core") ? (region.paths?.[cat] || `/data/pois/regions/${rid}-${cat}.json`) : null;
      if (p1) {
        const loaded = await tryLoadPlacesFile(p1, signal);
        if (loaded) {
          pools.push({ kind: "region", source: p1, places: loaded.places, bbox: region.bbox || null });
          DATASETS_USED.push({ kind: "region", source: p1, placesLen: loaded.places.length });
        }
      }
      // 2) Regione core
      const p2 = region.paths?.core || `/data/pois/regions/${rid}.json`;
      if (p2) {
        const loaded = await tryLoadPlacesFile(p2, signal);
        if (loaded) {
          pools.push({ kind: "region", source: p2, places: loaded.places, bbox: region.bbox || null });
          DATASETS_USED.push({ kind: "region", source: p2, placesLen: loaded.places.length });
        }
      }
    }

    // 3) Radius categoria
    if (cat !== "core") {
      const p3 = `/data/pois/regions/radius-${cat}.json`;
      const loaded = await tryLoadPlacesFile(p3, signal);
      if (loaded) {
        pools.push({ kind: "radius", source: p3, places: loaded.places, bbox: null });
        DATASETS_USED.push({ kind: "radius", source: p3, placesLen: loaded.places.length });
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
      break; // basta una macro valida
    }

    if (!pools.length) throw new Error("Nessun dataset offline valido disponibile.");
    return { pools, region };
  }

  // -------------------- GEOCODE --------------------
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

  // -------------------- TAGS / GATE MONETIZZABILE --------------------
  function tagsStr(place) { return (place?.tags || []).map(t => String(t).toLowerCase()).join(" "); }
  function hasAny(str, arr) { for (const k of arr) if (str.includes(k)) return true; return false; }

  function hasQualitySignals(place) {
    const t = tagsStr(place);
    return (
      t.includes("wikipedia=") ||
      t.includes("wikidata=") ||
      t.includes("website=") ||
      t.includes("contact:website=") ||
      t.includes("opening_hours=")
    );
  }

  function isIrrelevant(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    if (!place?.name || String(place.name).length < 2) return true;

    if (hasAny(t, ["highway=", "railway=", "route=", "junction=", "public_transport="])) return true;
    if (hasAny(t, ["amenity=parking", "amenity=fuel", "amenity=charging_station", "highway=bus_stop"])) return true;
    if (hasAny(t, ["landuse=industrial", "building=warehouse", "man_made=works", "building=office"])) return true;
    if (hasAny(n, ["parcheggio", "stazione", "fermata", "svincolo", "uscita", "km "])) return true;

    return false;
  }

  function isSpa(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    return (
      t.includes("amenity=spa") || t.includes("leisure=spa") || t.includes("tourism=spa") ||
      t.includes("natural=hot_spring") || t.includes("amenity=public_bath") ||
      n.includes("terme") || n.includes("spa") || n.includes("wellness")
    );
  }

  function isWinery(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    return (
      t.includes("craft=winery") || t.includes("shop=wine") || t.includes("amenity=wine_bar") ||
      hasAny(n, ["cantina", "enoteca", "degustaz", "wine"])
    );
  }

  function matchesCategory(place, catUI) {
    const cat = canonicalCategory(catUI);
    if (cat === "core") return true;

    const t = tagsStr(place);
    const type = normalizeType(place?.type);

    if (cat === "relax") return isSpa(place);
    if (cat === "cantine") return isWinery(place);

    if (cat === "storia") {
      return (
        t.includes("historic=") ||
        t.includes("heritage=") ||
        t.includes("tourism=museum") ||
        t.includes("tourism=attraction")
      );
    }

    if (cat === "family") {
      return (
        t.includes("tourism=theme_park") ||
        t.includes("leisure=water_park") ||
        t.includes("tourism=zoo") ||
        t.includes("tourism=aquarium") ||
        t.includes("tourism=museum") ||
        t.includes("tourism=attraction")
      );
    }

    if (cat === "mare") return t.includes("natural=beach") || type === "mare" || t.includes("leisure=marina");
    if (cat === "natura") return (
      t.includes("tourism=viewpoint") ||
      t.includes("natural=waterfall") ||
      t.includes("natural=cave_entrance") ||
      t.includes("boundary=national_park") ||
      t.includes("leisure=nature_reserve") ||
      t.includes("natural=beach")
    );

    if (cat === "viewpoints") return t.includes("tourism=viewpoint");
    if (cat === "hiking") return t.includes("tourism=alpine_hut") || t.includes("amenity=shelter") || type === "hiking";
    if (cat === "borghi") return type === "borghi" || t.includes("place=village") || normName(place?.name || "").includes("borgo");
    if (cat === "citta") return type === "citta" || t.includes("place=city") || t.includes("place=town");
    if (cat === "montagna") return t.includes("natural=peak") || type === "montagna";

    return true;
  }

  function isMonetizableTourism(place, catUI) {
    const t = tagsStr(place);
    const q = hasQualitySignals(place);
    const n = normName(place?.name || "");

    // Ticket / esperienze vendibili
    const ticket =
      t.includes("tourism=museum") ||
      t.includes("tourism=theme_park") ||
      t.includes("tourism=zoo") ||
      t.includes("tourism=aquarium") ||
      t.includes("tourism=gallery") ||
      t.includes("tourism=attraction");

    const relax = isSpa(place);
    const wine = isWinery(place);

    const heritage =
      t.includes("historic=") || t.includes("heritage=") ||
      t.includes("historic=castle") || t.includes("historic=archaeological_site") ||
      t.includes("historic=palace") || t.includes("historic=ruins");

    const natureAttraction =
      t.includes("tourism=viewpoint") ||
      t.includes("natural=waterfall") ||
      t.includes("natural=cave_entrance") ||
      t.includes("natural=beach") ||
      t.includes("boundary=national_park") ||
      t.includes("leisure=nature_reserve");

    // Se categoria è relax/cantine, deve combaciare davvero
    const cat = canonicalCategory(catUI);
    if (cat === "relax") return relax;
    if (cat === "cantine") return wine && q;

    // Regola monetizzazione: ok se ticket/relax/wine/heritage
    if (ticket || relax || wine || heritage) return true;

    // Natura solo se qualificata
    if (natureAttraction && q) return true;

    // fallback (qualità + keyword turistica forte)
    if (q && hasAny(n, ["castell", "abbazi", "duomo", "museo", "belvedere", "cascat", "gole", "parco"])) return true;

    return false;
  }

  // -------------------- SCORING (semplice) --------------------
  function scorePlace({ driveMin, targetMin, quality }) {
    // vicino al target = meglio
    const t = clamp(1 - Math.abs(driveMin - targetMin) / Math.max(18, targetMin * 0.9), 0, 1);
    const q = quality ? 1 : 0.6;
    return 0.7 * t + 0.3 * q;
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

  // -------------------- BUILD CANDIDATES --------------------
  function buildCandidates(pool, origin, maxMinutes, categoryUI) {
    const visited = getVisitedSet();
    const target = Number(maxMinutes);

    const oLat = Number(origin.lat);
    const oLon = Number(origin.lon);

    const out = [];
    for (const raw of pool) {
      const p = normalizePlace(raw);
      if (!p) continue;

      if (isIrrelevant(p)) continue;
      if (!matchesCategory(p, categoryUI)) continue;
      if (!isMonetizableTourism(p, categoryUI)) continue;

      const pid = safeIdFromPlace(p);
      if (visited.has(pid)) continue;

      const km = haversineKm(oLat, oLon, p.lat, p.lon);
      const driveMin = estCarMinutesFromKm(km);
      if (!Number.isFinite(driveMin) || driveMin > target) continue;
      if (km < 1.2) continue;

      const quality = hasQualitySignals(p);
      const score = Number(scorePlace({ driveMin, targetMin: target, quality }).toFixed(4));
      out.push({ place: p, pid, km, driveMin, score });
    }

    out.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
    return dedupeDiverse(out);
  }

  // -------------------- RENDER --------------------
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
    const cat = canonicalCategory(categoryUI);
    const t = tagsStr(place);
    const n = normName(place?.name || "");

    if (cat === "relax") return "Relax • terme/spa (spesso su prenotazione).";
    if (cat === "cantine") return "Cantina/Enoteca • degustazioni e visite (prenotazione consigliata).";

    if (t.includes("tourism=museum")) return "Museo • biglietti/orari.";
    if (t.includes("tourism=theme_park")) return "Parco divertimenti • biglietti/orari.";
    if (t.includes("tourism=zoo") || t.includes("tourism=aquarium")) return "Zoo/Acquario • esperienza family.";
    if (t.includes("tourism=viewpoint")) return "Belvedere • foto e tramonto (verifica accesso).";
    if (t.includes("natural=waterfall")) return "Cascata • natura e foto (sentiero).";
    if (t.includes("natural=cave_entrance")) return "Grotta • verifica accesso e sicurezza.";
    if (t.includes("historic=") || t.includes("heritage=") || hasAny(n, ["castell", "abbazi", "duomo"])) return "Storia • luogo iconico (orari).";

    return "Meta turistica • informazioni e prenotazione consigliata.";
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
      const sub = `${escapeHtml((p.area || p.country || "—").trim())}`;
      return `
        <button class="optBtn" data-pid="${escapeHtml(x.pid)}" type="button">
          <div style="display:flex; justify-content:space-between; gap:10px;">
            <div style="font-weight:950; font-size:16px; line-height:1.2;">${name}</div>
            <div class="small muted" style="font-weight:950;">${time}</div>
          </div>
          <div class="small muted" style="margin-top:6px;">${sub}</div>
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

  function bindClick(id, fn) {
    const el = $(id);
    if (!el) return;
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
  }

  function bindOptionsClicks(meta) {
    const area = $("resultArea");
    if (!area) return;

    // delegation: click (NON pointerdown)
    area.addEventListener("click", (e) => {
      const btn = e.target.closest(".optBtn");
      if (!btn) return;
      e.preventDefault();
      const pid2 = btn.getAttribute("data-pid");
      const found = ALL_OPTIONS.find(x => x.pid === pid2);
      if (!found) return;
      openChosen(found, { ...meta, scroll: true });
    }, { passive: false });

    $("btnMoreAlts")?.addEventListener("click", (e) => {
      e.preventDefault();
      VISIBLE_ALTS = Math.min((ALL_OPTIONS.length - 1), VISIBLE_ALTS + CFG.ALTS_PAGE);
      openChosen(CURRENT_CHOSEN, { ...meta, scroll: false });
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

    // IMPORTANTISSIMO: SOLO click (NON pointerdown) per aprire link
    bindClick("btnGo", () => window.open(mapsDirUrl(origin.lat, origin.lon, lat, lon), "_blank", "noopener"));

    bindClick("btnBook", () => {
      const cat = canonicalCategory(categoryUI);
      if (cat === "cantine") return window.open(gygSearchUrl(name, areaLabel), "_blank", "noopener");
      if (cat === "relax") return window.open(bookingSearchUrl(name, areaLabel), "_blank", "noopener");

      const t = tagsStr(p);
      const ticketish =
        cat === "family" || cat === "storia" ||
        t.includes("tourism=museum") || t.includes("tourism=theme_park") ||
        t.includes("tourism=zoo") || t.includes("tourism=aquarium") ||
        t.includes("tourism=attraction") || t.includes("leisure=water_park");

      const url = ticketish ? gygSearchUrl(name, areaLabel) : bookingSearchUrl(name, areaLabel);
      window.open(url, "_blank", "noopener");
    });

    bindClick("btnEat", () => window.open(theforkSearchUrl(name, areaLabel, lat, lon), "_blank", "noopener"));
    bindClick("btnPhotos", () => window.open(googleImagesUrl(name, areaLabel), "_blank", "noopener"));
    bindClick("btnWiki", () => window.open(wikiUrl(name, areaLabel), "_blank", "noopener"));

    bindClick("btnVisited", () => {
      markVisited(pid);
      showStatus("ok", "Segnato come visitato ✅");
    });

    bindClick("btnChange", () => runSearch({ silent: true, forbidPid: pid }));
    bindClick("btnSearchAgain", () => {
      const el = $("searchCard");
      el && el.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    bindOptionsClicks(meta);

    // scroll
    const resultCard = $("resultCard") || $("resultArea");
    resultCard && setTimeout(() => resultCard.scrollIntoView({ behavior: "smooth", block: "start" }), 30);
  }

  function openChosen(chosen, meta = {}) {
    const origin = meta.origin || getOrigin();
    const categoryUI = meta.categoryUI || getActiveCategory();
    const datasetInfo = meta.datasetInfo || "";
    const usedMinutes = meta.usedMinutes;
    const maxMinutesInput = meta.maxMinutesInput || Number($("maxMinutes")?.value) || 120;

    CURRENT_CHOSEN = chosen;
    renderChosenCard(origin, chosen, categoryUI, datasetInfo, usedMinutes, maxMinutesInput, meta);
  }

  // -------------------- SEARCH --------------------
  function widenSteps(base) {
    const m = clamp(Number(base) || 120, 10, 600);
    const steps = [m, clamp(Math.round(m * 1.25), m, 600), clamp(Math.round(m * 1.5), m, 600), clamp(Math.round(m * 1.75), m, 600)];
    return Array.from(new Set(steps)).sort((a, b) => a - b);
  }

  function datasetInfoShort() {
    return (DATASETS_USED || []).map(x => `${x.kind}:${(x.source || "").split("/").pop()} (${x.placesLen})`).join(" • ");
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
        return;
      }

      const maxMinutesInput = clamp(Number($("maxMinutes")?.value) || 120, 10, 600);
      const categoryUI = getActiveCategory();

      const { pools, region } = await loadPoolsRegionFirst(origin, categoryUI, { signal });
      if (token !== SEARCH_TOKEN) return;

      const steps = widenSteps(maxMinutesInput);

      let usedMinutes = steps[0];
      let poolCandidates = [];
      let chosenDatasetInfo = "";

      // helper: merge places
      const mergePlaces = (list) => {
        let merged = [];
        for (const pl of list) merged = merged.concat(pl.places || []);
        return merged;
      };

      for (const mins of steps) {
        usedMinutes = mins;

        const regionPools = pools.filter(p => p.kind === "region");
        const otherPools = pools.filter(p => p.kind !== "region");

        // A) prova regione
        let regionList = [];
        if (regionPools.length) {
          regionList = buildCandidates(mergePlaces(regionPools), origin, mins, categoryUI);
          if (forbidPid) regionList = regionList.filter(x => x.pid !== forbidPid);
        }

        if (regionList.length >= CFG.REGION_MIN_RESULTS) {
          poolCandidates = regionList;
          const firstRegion = regionPools[0];
          chosenDatasetInfo = `REGION:${(firstRegion?.source || "").split("/").pop() || "—"}`;
          break;
        }

        if (regionList.length >= CFG.REGION_SOFT_MIN_RESULTS) {
          // completa fuori regione
          let otherList = buildCandidates(mergePlaces(otherPools), origin, mins, categoryUI);
          if (forbidPid) otherList = otherList.filter(x => x.pid !== forbidPid);
          poolCandidates = dedupeDiverse(regionList.concat(otherList));
          const firstRegion = regionPools[0];
          const firstOther = otherPools[0];
          chosenDatasetInfo = `REGION:${(firstRegion?.source || "").split("/").pop() || "—"} + ${(firstOther?.kind || "OTHER").toUpperCase()}:${(firstOther?.source || "").split("/").pop() || "—"}`;
          break;
        }

        // B) solo fuori regione
        let otherList = buildCandidates(mergePlaces(otherPools), origin, mins, categoryUI);
        if (forbidPid) otherList = otherList.filter(x => x.pid !== forbidPid);

        if (otherList.length) {
          poolCandidates = otherList;
          const firstOther = otherPools[0];
          chosenDatasetInfo = `${(firstOther?.kind || "OTHER").toUpperCase()}:${(firstOther?.source || "").split("/").pop() || "—"}`;
          break;
        }

        if (token !== SEARCH_TOKEN) return;
      }

      if (token !== SEARCH_TOKEN) return;

      if (!poolCandidates.length) {
        renderNoResult(maxMinutesInput, categoryUI, datasetInfoShort() || "offline");
        if (!silent) showStatus("warn", `Nessuna meta monetizzabile entro ${maxMinutesInput} min per "${categoryUI}".`);
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
        const reg = region?.name ? ` • regione: ${region.name}` : "";
        showStatus("ok", `Trovate ${ALL_OPTIONS.length} opzioni ✅ • categoria: ${categoryUI}${extra}${reg}`);
      }
    } catch (e) {
      if (String(e?.name || "").includes("Abort")) return;
      console.error(e);
      showStatus("err", `Errore: ${String(e.message || e)}`);
    }
  }

  // -------------------- BUTTONS / BOOT --------------------
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
        showStatus("ok", "Partenza impostata ✅ Ora scegli categoria e premi CERCA.");
      } catch (e) {
        console.error(e);
        if ($("originStatus")) $("originStatus").textContent = `❌ ${String(e.message || e)}`;
        showStatus("err", `Geocoding fallito: ${String(e.message || e)}`);
      }
    });
  }

  function bindMainButtons() {
    $("btnFind")?.addEventListener("click", () => runSearch({ silent: false }));
    $("btnResetVisited")?.addEventListener("click", () => {
      resetVisited();
      showStatus("ok", "Visitati resettati ✅");
    });
  }

  function boot() {
    injectMiniCssOnce();
    initChips("timeChips", { multi: false });
    initChips("categoryChips", { multi: false });
    initChips("styleChips", { multi: true }); // se hai chips stile, resta compatibile
    initTimeChipsSync();
    restoreOrigin();
    bindOriginButtons();
    bindMainButtons();
    hideStatus();

    const origin = getOrigin();
    if (origin) collapseOriginCard(true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();

  // expose debug
  window.__jamo = {
    runSearch,
    resetVisited,
    getOrigin,
    getDatasetsUsed: () => DATASETS_USED
  };
})();
