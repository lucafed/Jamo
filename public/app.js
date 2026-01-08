/* Jamo — app.js v15.2
 * Mobile-first • Offline-only • Flow sequenziale • Multi opzioni • Dock actions
 *
 * ✅ NO GPS (pulsante nascosto)
 * ✅ OFFLINE-ONLY
 * ✅ Natura presente
 * ✅ Relax migliorato (meno “solo piscine”)
 * ✅ FAMILY potenziata: zoo/acquari/musei kids/science/avventura/theme/waterpark/playground
 * ✅ Fattorie didattiche penalizzate
 * ✅ Filtro turistico più stretto (Family)
 * ✅ 5 opzioni senza duplicati, cliccabili
 * ✅ Scroll automatico sul risultato
 * ✅ Partenza collassabile dopo set
 * ✅ Dock: Cerca/Vai/Prenota/Mangia
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

    OPTIONS_TOTAL: 5,

    // dataset
    MACROS_INDEX_URL: "/data/macros/macros_index.json",
    FALLBACK_MACRO_URLS: [
      "/data/macros/euuk_country_it.json",
      "/data/macros/euuk_macro_all.json",
    ],

    REGIONAL_POIS_BY_ID: {
      "it-veneto": "/data/pois/regions/it-veneto.json",
    },

    REGION_BBOX: {
      "it-veneto": { minLat: 44.70, maxLat: 46.70, minLon: 10.20, maxLon: 13.20 },
    },

    // OFFLINE ONLY
    LIVE_ENABLED: false,

    // “Turistico” (stringiamo Family)
    TOURIST_MIN_DEFAULT: 0.46,
    TOURIST_MIN_FAMILY: 0.60,

    // Affiliate placeholders
    AFFILIATE: {
      BOOKING_AID: "",
      GYG_PARTNER_ID: "",
      VIATOR_PID: "",
      THEFORK_AFFID: "",
    }
  };

  // -------------------- STATE --------------------
  let SESSION_SEEN = new Set();
  let LAST_SHOWN_PID = null;

  let SEARCH_TOKEN = 0;
  let SEARCH_ABORT = null;

  let MACROS_INDEX = null;
  let DATASET = { kind: null, source: null, places: [], meta: {} };

  let LAST_OPTIONS = [];
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
  function mapsPlaceUrl(lat, lon) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lon)}`;
  }
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

  // Affiliate-ready (fallback google)
  function bookingSearchUrl(name, area) {
    const aid = CFG.AFFILIATE.BOOKING_AID?.trim();
    if (!aid) return googleSearchUrl(`${stableQuery(name, area)} hotel`);
    return `https://www.booking.com/searchresults.it.html?aid=${encodeURIComponent(aid)}&ss=${encodeURIComponent(`${name} ${area || ""}`)}`;
  }
  function gygSearchUrl(name, area) {
    const pid = CFG.AFFILIATE.GYG_PARTNER_ID?.trim();
    if (!pid) return googleSearchUrl(`${stableQuery(name, area)} biglietti`);
    return `https://www.getyourguide.com/s/?partner_id=${encodeURIComponent(pid)}&q=${encodeURIComponent(`${name} ${area || ""}`)}`;
  }
  function viatorSearchUrl(name, area) {
    const pid = CFG.AFFILIATE.VIATOR_PID?.trim();
    if (!pid) return googleSearchUrl(`${stableQuery(name, area)} tour`);
    return `https://www.viator.com/searchResults/all?pid=${encodeURIComponent(pid)}&text=${encodeURIComponent(`${name} ${area || ""}`)}`;
  }
  function theforkSearchUrl(name, area, lat, lon) {
    const q = `ristoranti vicino ${name} ${area || ""}`.trim();
    const aff = CFG.AFFILIATE.THEFORK_AFFID?.trim();
    if (!aff) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}&center=${encodeURIComponent(lat + "," + lon)}`;
    return googleSearchUrl(q);
  }

  // -------------------- STORAGE: ORIGIN --------------------
  function setOrigin({ label, lat, lon, country_code }) {
    $("originLabel") && ($("originLabel").value = label ?? "");
    $("originLat") && ($("originLat").value = String(lat));
    $("originLon") && ($("originLon").value = String(lon));

    const cc = String(country_code || "").toUpperCase();
    $("originCC") && ($("originCC").value = cc);

    localStorage.setItem("jamo_origin", JSON.stringify({ label, lat, lon, country_code: cc }));

    if ($("originStatus")) {
      $("originStatus").textContent =
        `✅ Partenza: ${label || "posizione"} (${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)})${cc ? " • " + cc : ""}`;
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

      const style = document.createElement("style");
      style.textContent = `#quickStartCard.collapsed .originBody { display:none; }`;
      document.head.appendChild(style);

      const kids = [...card.children].filter(el => el.id !== "originToggle");
      const body = document.createElement("div");
      body.className = "originBody";
      kids.forEach(k => body.appendChild(k));
      card.appendChild(body);
    }

    if (shouldCollapse) {
      card.classList.add("collapsed");
      const icon = $("originToggleIcon");
      if (icon) icon.textContent = "⬆️";
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
      type === "err" ? "rgba(255,90,90,.35)" :
      "rgba(255,180,80,.35)";
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
    const s = String(v || "").toLowerCase().trim();
    return s === "chicca" ? "chicca" : "classica";
  }
  function normalizeType(t) {
    const s = String(t || "").toLowerCase().trim();
    if (!s) return "";
    if (s === "borgo") return "borghi";
    if (s === "città" || s === "citta") return "citta";
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

  // -------------------- DATASET LOADING --------------------
  async function loadMacrosIndexSafe(signal) {
    try { MACROS_INDEX = await fetchJson(CFG.MACROS_INDEX_URL, { signal }); }
    catch { MACROS_INDEX = null; }
    return MACROS_INDEX;
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

      return { json: j, places };
    } catch {
      return null;
    }
  }

  function findCountryMacroPath(cc) {
    if (!MACROS_INDEX?.items?.length) return null;
    const c = String(cc || "").toUpperCase();
    if (!c) return null;

    const hit = MACROS_INDEX.items.find(x =>
      String(x.id || "") === `euuk_country_${c.toLowerCase()}` ||
      String(x.path || "").includes(`euuk_country_${c.toLowerCase()}.json`)
    );
    return hit?.path || null;
  }

  function pickRegionIdFromOrigin(origin) {
    const lat = Number(origin?.lat);
    const lon = Number(origin?.lon);
    const cc = String(origin?.country_code || "").toUpperCase();

    const saved = localStorage.getItem("jamo_region_id");
    if (saved && CFG.REGIONAL_POIS_BY_ID[saved] && withinBBox(lat, lon, CFG.REGION_BBOX[saved])) return saved;
    if (cc === "IT" && withinBBox(lat, lon, CFG.REGION_BBOX["it-veneto"])) return "it-veneto";
    return "";
  }

  async function ensureDatasetLoaded(origin, { signal } = {}) {
    if (DATASET?.places?.length) return DATASET;

    await loadMacrosIndexSafe(signal);

    const candidates = [];
    const regionId = pickRegionIdFromOrigin(origin);
    if (regionId && CFG.REGIONAL_POIS_BY_ID[regionId]) candidates.push(CFG.REGIONAL_POIS_BY_ID[regionId]);

    const cc = String(origin?.country_code || "").toUpperCase();
    const countryMacro = findCountryMacroPath(cc);
    if (countryMacro) candidates.push(countryMacro);

    for (const u of CFG.FALLBACK_MACRO_URLS) candidates.push(u);

    const savedMacro = localStorage.getItem("jamo_macro_url");
    if (savedMacro) candidates.push(savedMacro);

    const uniq = [];
    const seen = new Set();
    for (const u of candidates) {
      const s = String(u || "").trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      uniq.push(s);
    }

    for (const url of uniq) {
      const loaded = await tryLoadPlacesFile(url, signal);
      if (!loaded) continue;

      const isRegional = url.includes("/data/pois/regions/");
      DATASET = {
        kind: isRegional ? "pois_region" : "macro",
        source: url,
        places: loaded.places,
        meta: { raw: loaded.json, cc, regionId },
      };

      if (isRegional && regionId) localStorage.setItem("jamo_region_id", regionId);
      if (!isRegional) localStorage.setItem("jamo_macro_url", url);

      return DATASET;
    }

    throw new Error("Nessun dataset offline valido disponibile.");
  }

  // -------------------- GEOCODING (server) --------------------
  async function geocodeLabel(label) {
    const q = String(label || "").trim();
    if (!q) throw new Error("Scrivi un luogo (es: Verona, Padova...)");
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

  function isLodgingOrFood(place) {
    const t = tagsStr(place);
    if (
      t.includes("tourism=hotel") || t.includes("tourism=hostel") || t.includes("tourism=guest_house") ||
      t.includes("tourism=apartment") || t.includes("tourism=camp_site") || t.includes("tourism=caravan_site") ||
      t.includes("tourism=chalet") || t.includes("tourism=motel")
    ) return true;

    if (
      t.includes("amenity=restaurant") || t.includes("amenity=fast_food") || t.includes("amenity=cafe") ||
      t.includes("amenity=bar") || t.includes("amenity=pub") || t.includes("amenity=ice_cream")
    ) return true;

    return false;
  }

  // season signals
  function isSummerThing(place) {
    const t = tagsStr(place);
    return t.includes("leisure=water_park") || t.includes("natural=beach") || t.includes("leisure=marina");
  }
  function isWinterThing(place) {
    const t = tagsStr(place);
    return t.includes("piste:type=") || t.includes("sport=skiing") || t.includes("aerialway=");
  }

  function isThemePark(place) { return tagsStr(place).includes("tourism=theme_park"); }
  function isWaterPark(place) { return tagsStr(place).includes("leisure=water_park"); }
  function isZooOrAquarium(place) {
    const t = tagsStr(place);
    return t.includes("tourism=zoo") || t.includes("tourism=aquarium") || t.includes("amenity=aquarium");
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
      return (nn.includes("sentier") || nn.includes("cai") || nn.includes("anello") || nn.includes("trail") || nn.includes("via"));
    }
    return false;
  }

  function isMountain(place) {
    const t = tagsStr(place);
    const type = normalizeType(place?.type);
    if (t.includes("place=city") || t.includes("place=town") || t.includes("place=village") || t.includes("place=hamlet")) return false;

    return (
      type === "montagna" ||
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
      t.includes("natural=water") ||
      t.includes("waterway=river") || t.includes("waterway=stream") || t.includes("waterway=riverbank") ||
      t.includes("leisure=nature_reserve") || t.includes("boundary=national_park") ||
      t.includes("natural=wood")
    );
  }

  function isBorgo(place) {
    const t = tagsStr(place);
    const type = normalizeType(place?.type);
    return type === "borghi" || t.includes("place=village") || t.includes("place=hamlet");
  }

  function isCity(place) {
    const t = tagsStr(place);
    const type = normalizeType(place?.type);
    return type === "citta" || t.includes("place=city") || t.includes("place=town");
  }

  // ✅ NEW: Parco avventura / adventure park
  function isAdventurePark(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    return (
      t.includes("leisure=adventure_park") ||
      t.includes("tourism=theme_park") && (n.includes("avventura") || n.includes("adventure")) ||
      n.includes("parco avventura") || n.includes("adventure park") ||
      n.includes("zip line") || n.includes("ziplin") ||
      t.includes("sport=climbing") || t.includes("leisure=climbing") ||
      t.includes("high_ropes_course=yes")
    );
  }

  // ✅ NEW: fattoria didattica (penalizziamo in family)
  function isEducationalFarm(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    return (
      n.includes("fattoria") || n.includes("agritur") || n.includes("azienda agric") ||
      n.includes("didattic") || n.includes("farm") ||
      t.includes("tourism=farm") || t.includes("landuse=farmyard") || t.includes("landuse=farmland")
    );
  }

  // Relax migliorato: “piscina” solo se sembra terme/spa
  function isSpaPlace(place) {
    const t = tagsStr(place);
    const nm = normName(place?.name || "");
    return (
      t.includes("amenity=spa") || t.includes("leisure=spa") || t.includes("tourism=spa") ||
      t.includes("natural=hot_spring") || t.includes("amenity=public_bath") ||
      t.includes("amenity=sauna") || t.includes("leisure=sauna") ||
      (t.includes("leisure=swimming_pool") && (nm.includes("terme") || nm.includes("spa") || nm.includes("thermal") || nm.includes("benessere")))
    );
  }

  // -------------------- CATEGORY MATCH --------------------
  function matchesCategoryStrict(place, cat) {
    if (!cat || cat === "ovunque") return true;

    const type = normalizeType(place?.type);
    const t = tagsStr(place);
    const nm = normName(place?.name || "");

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

    // ✅ FAMILY potenziata
    if (cat === "family") {
      const isKidsMuseum =
        t.includes("tourism=museum") &&
        (nm.includes("bambin") || nm.includes("kids") || nm.includes("children") ||
         nm.includes("scienza") || nm.includes("science") || nm.includes("planet") ||
         nm.includes("play"));

      const isBigPlayground =
        t.includes("leisure=playground") || (t.includes("leisure=park") && nm.includes("gioco"));

      return (
        isThemePark(place) ||
        isWaterPark(place) ||
        isZooOrAquarium(place) ||
        isAdventurePark(place) ||
        isKidsMuseum ||
        isBigPlayground ||
        type === "family" ||
        (t.includes("tourism=attraction") &&
          (nm.includes("parco") || nm.includes("kids") || nm.includes("bimbi") || nm.includes("family") || nm.includes("divert")))
      );
    }

    return true;
  }

  function matchesStyle(place, { wantChicche, wantClassici }) {
    const vis = normalizeVisibility(place?.visibility);
    if (!wantChicche && !wantClassici) return true;
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
    if (isWinterNow() && isSummerThing(place)) return -0.18;
    if (isSummerNow() && isWinterThing(place)) return -0.18;

    if (isWinterNow() && isSpaPlace(place)) return +0.08;
    if (isSummerNow() && (isSummerThing(place) || normalizeType(place?.type) === "mare")) return +0.06;

    return 0;
  }

  // ✅ FAMILY boost ordinato
  function familyBoost(place, category) {
    if (category !== "family") return 0;

    if (isThemePark(place)) return 0.30;
    if (isWaterPark(place)) return 0.26;
    if (isZooOrAquarium(place)) return 0.24;

    const t = tagsStr(place);
    const nm = normName(place?.name || "");
    const isKidsMuseum =
      t.includes("tourism=museum") &&
      (nm.includes("bambin") || nm.includes("kids") || nm.includes("children") ||
       nm.includes("scienza") || nm.includes("science") || nm.includes("planet"));

    if (isKidsMuseum) return 0.22;
    if (isAdventurePark(place)) return 0.20;
    if (t.includes("leisure=playground")) return 0.16;

    if (isEducationalFarm(place)) return -0.18;

    return 0;
  }

  // “quanto è turistico” (stringiamo family)
  function touristScore(place, category) {
    const t = tagsStr(place);
    const nm = normName(place?.name || "");
    let s = 0.0;

    // base: tag “tourist”
    if (t.includes("tourism=attraction")) s += 0.20;
    if (t.includes("tourism=museum")) s += 0.18;
    if (t.includes("historic=")) s += 0.12;
    if (t.includes("tourism=viewpoint")) s += 0.12;
    if (t.includes("boundary=national_park") || t.includes("leisure=nature_reserve")) s += 0.12;

    // nomi “wow”
    if (nm.includes("parco") || nm.includes("castello") || nm.includes("museo")) s += 0.08;
    if (nm.includes("cascat") || nm.includes("grott") || nm.includes("lago")) s += 0.08;

    // Family: boost extra
    if (category === "family") {
      if (t.includes("tourism=theme_park")) s += 0.20;
      if (t.includes("leisure=water_park")) s += 0.18;
      if (t.includes("tourism=zoo") || t.includes("tourism=aquarium") || t.includes("amenity=aquarium")) s += 0.18;
      if (t.includes("tourism=museum")) s += 0.12;
      if (nm.includes("bambin") || nm.includes("kids") || nm.includes("children")) s += 0.15;
      if (nm.includes("scienza") || nm.includes("science") || nm.includes("planet")) s += 0.10;
      if (t.includes("leisure=playground")) s += 0.10;

      // penalizza fattorie/agriturismi
      if (isEducationalFarm(place)) s -= 0.40;
    }

    // Relax: penalizza piscine “pure”
    if (category === "relax") {
      if (t.includes("natural=hot_spring")) s += 0.15;
      if (t.includes("amenity=spa") || t.includes("leisure=spa") || t.includes("tourism=spa")) s += 0.12;
      if (t.includes("amenity=sauna") || t.includes("leisure=sauna")) s += 0.10;
      if (t.includes("leisure=swimming_pool") && !isSpaPlace(place)) s -= 0.25;
    }

    return clamp(s, -0.6, 0.9);
  }

  function widenMinutesSteps(m, category) {
    const base = clamp(Number(m) || 120, 10, 600);
    const steps = [base];

    const muls =
      category === "family" ? [1.15, 1.30, 1.50] :
      category === "mare"   ? [1.20, 1.40, 1.65] :
      category === "storia" ? [1.20, 1.40, 1.60] :
      category === "natura" ? [1.20, 1.40, 1.60] :
                              [1.20, 1.40, 1.60];

    for (const k of muls) steps.push(clamp(Math.round(base * k), base, 600));
    steps.push(clamp(Math.max(240, base), base, 600));
    return Array.from(new Set(steps)).sort((a, b) => a - b);
  }

  // -------------------- PICK --------------------
  function buildCandidatesFromPool(pool, origin, maxMinutes, category, styles, { ignoreVisited=false, ignoreRotation=false } = {}) {
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
      if (!nm || nm.length < 2 || normName(nm) === "meta") continue;

      if (isLodgingOrFood(p)) continue;
      if (!matchesCategoryStrict(p, category)) continue;
      if (!matchesStyle(p, styles)) continue;

      const pid = safeIdFromPlace(p);
      if (!ignoreVisited && visited.has(pid)) continue;

      const km = haversineKm(oLat, oLon, p.lat, p.lon);
      const driveMin = estCarMinutesFromKm(km);
      if (!Number.isFinite(driveMin) || driveMin > target) continue;

      if (km < (category === "family" ? 1.2 : 1.6)) continue;

      const isChicca = normalizeVisibility(p.visibility) === "chicca";
      let s = baseScorePlace({ driveMin, targetMin: target, beautyScore: p.beauty_score, isChicca });

      s += familyBoost(p, category);
      s += seasonAdjust(p);

      // ✅ filtro turistico “stretto”
      const tScore = touristScore(p, category);
      const minT = (category === "family") ? CFG.TOURIST_MIN_FAMILY : CFG.TOURIST_MIN_DEFAULT;
      if (tScore < minT) continue;

      // Relax extra: penalizza piscine “pure”
      if (category === "relax") {
        const t = tagsStr(p);
        if (t.includes("natural=hot_spring")) s += 0.10;
        if (t.includes("amenity=spa") || t.includes("leisure=spa") || t.includes("tourism=spa")) s += 0.08;
        if (t.includes("amenity=sauna") || t.includes("leisure=sauna")) s += 0.06;
        if (t.includes("leisure=swimming_pool") && !isSpaPlace(p)) s -= 0.18;
      }

      if (!ignoreRotation) s -= rotationPenalty(pid, recentSet);

      candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
    }

    candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
    return candidates;
  }

  function pickTopOptions(pool, origin, minutes, category, styles) {
    let c = buildCandidatesFromPool(pool, origin, minutes, category, styles, { ignoreVisited:false, ignoreRotation:false });
    if (c.length) return c;

    c = buildCandidatesFromPool(pool, origin, minutes, category, styles, { ignoreVisited:false, ignoreRotation:true });
    if (c.length) return c;

    c = buildCandidatesFromPool(pool, origin, minutes, category, styles, { ignoreVisited:true, ignoreRotation:true });
    return c;
  }

  function uniqueByPid(list) {
    const out = [];
    const seen = new Set();
    for (const x of list) {
      if (!x?.pid || seen.has(x.pid)) continue;
      seen.add(x.pid);
      out.push(x);
    }
    return out;
  }

  // -------------------- COPY --------------------
  function typeBadge(category) {
    const map = {
      natura: { emoji:"🌿", label:"Natura" },
      family: { emoji:"👨‍👩‍👧‍👦", label:"Family" },
      storia: { emoji:"🏛️", label:"Storia" },
      montagna:{ emoji:"🏔️", label:"Montagna" },
      mare:   { emoji:"🌊", label:"Mare" },
      relax:  { emoji:"🧖", label:"Relax" },
      borghi: { emoji:"🏘️", label:"Borghi" },
      citta:  { emoji:"🏙️", label:"Città" },
      viewpoints:{ emoji:"🌅", label:"Panorami" },
      hiking:{ emoji:"🥾", label:"Trekking" },
      ovunque:{ emoji:"🎲", label:"Meta" },
    };
    return map[category] || { emoji:"📍", label:"Meta" };
  }

  function visibilityLabel(place) {
    return normalizeVisibility(place?.visibility) === "chicca" ? "✨ chicca" : "✅ classica";
  }

  function shortWhatIs(place, category) {
    const t = tagsStr(place);
    const nm = normName(place?.name || "");
    const bits = [];

    if (category === "family") {
      if (t.includes("tourism=theme_park")) bits.push("parco divertimenti");
      else if (t.includes("leisure=water_park")) bits.push("acquapark");
      else if (t.includes("tourism=zoo")) bits.push("zoo");
      else if (t.includes("tourism=aquarium") || t.includes("amenity=aquarium")) bits.push("acquario");
      else if (t.includes("tourism=museum")) {
        if (nm.includes("bambin") || nm.includes("kids") || nm.includes("children")) bits.push("museo per bambini");
        else if (nm.includes("scienza") || nm.includes("science") || nm.includes("planet")) bits.push("museo/scienza interattivo");
        else bits.push("museo (family)");
      }
      else if (isAdventurePark(place)) bits.push("parco avventura");
      else if (t.includes("leisure=playground")) bits.push("parco giochi");
      else bits.push("attrazione adatta a bimbi");
      bits.push("controlla orari e biglietti");
      return bits.join(" • ");
    }

    if (category === "natura") {
      if (t.includes("natural=waterfall")) bits.push("cascata");
      else if (t.includes("natural=spring")) bits.push("sorgente/risorgiva");
      else if (t.includes("natural=cave_entrance")) bits.push("grotta");
      else if (t.includes("natural=water")) bits.push("lago/specchio d’acqua");
      else if (t.includes("waterway=river") || t.includes("waterway=riverbank") || t.includes("waterway=stream")) bits.push("fiume/torrente");
      else if (t.includes("leisure=nature_reserve") || t.includes("boundary=national_park")) bits.push("parco/riserva");
      else bits.push("spot naturalistico");
      bits.push("perfetto per foto e passeggiata");
      return bits.join(" • ");
    }

    if (category === "viewpoints") return "punto panoramico (viewpoint vero) • top per tramonto e foto";
    if (category === "hiking") return "trekking: sentiero/rifugio • controlla meteo e percorso";
    if (category === "storia") return "luogo storico • visita, musei, castelli e siti";
    if (category === "mare") return "mare: spiaggia/marina • perfetto in stagione";
    if (category === "montagna") return "montagna: cime/rifugi/impianti • controlla meteo";
    if (category === "relax") return "relax: spa/terme/sauna • spesso su prenotazione";
    if (category === "borghi") return "borgo: centro storico e scorci • passeggiata + foto";
    if (category === "citta") return "città: centro/musei/monumenti • visita easy";
    return "meta consigliata in base a categoria e tempo";
  }

  // -------------------- RENDER --------------------
  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function showResultProgress(msg = "Cerco nel dataset offline…") {
    const area = $("resultArea");
    if (!area) return;
    area.innerHTML = `
      <div class="card" style="border-color:rgba(255,180,80,.35); background:rgba(255,180,80,.06);">
        <div style="font-weight:950; font-size:18px;">🔎 Sto cercando…</div>
        <div class="small muted" style="margin-top:8px; line-height:1.4;">${escapeHtml(msg)}</div>
      </div>
    `;
  }

  function renderNoResult(maxMinutesShown, category, datasetInfo) {
    const area = $("resultArea");
    if (!area) return;

    area.innerHTML = `
      <div class="card" style="border-color:rgba(255,90,90,.35); background:rgba(255,90,90,.08);">
        <div class="small">❌ Nessuna meta trovata entro <b>${maxMinutesShown} min</b> per <b>${escapeHtml(category)}</b>.</div>
        <div class="small muted" style="margin-top:6px;">Tip: aumenta minuti oppure cambia categoria/stile.</div>
        <div class="small muted" style="margin-top:10px;">Dataset: ${escapeHtml(datasetInfo || "—")}</div>
        <div class="row wraprow" style="gap:10px; margin-top:12px;">
          <button class="btnGhost" id="btnResetRotation">🧽 Reset “oggi”</button>
          <button class="btn" id="btnGoSearch">🎯 Cerca di nuovo</button>
        </div>
      </div>
    `;

    $("btnResetRotation")?.addEventListener("click", () => {
      resetRotation();
      showStatus("ok", "Reset fatto ✅");
    });
    $("btnGoSearch")?.addEventListener("click", () => {
      runSearch({ silent: true });
    });

    CURRENT_CHOSEN = null;
    scrollToId("resultCard");
  }

  function renderOptionsList(options) {
    if (!options?.length) return "";

    const items = options.map((x, idx) => {
      const p = x.place;
      const name = escapeHtml(p.name || "");
      const time = `~${x.driveMin} min`;
      const sub = `${escapeHtml((p.area || p.country || "Italia").trim())} • ${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`;
      const vis = visibilityLabel(p);
      const active = (CURRENT_CHOSEN?.pid === x.pid) ? `style="border-color:rgba(0,224,255,.55); background:rgba(0,224,255,.08)"` : "";
      return `
        <button class="optItem" data-pid="${escapeHtml(x.pid)}" ${active}
          style="width:100%; text-align:left; border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.06); border-radius:16px; padding:12px; cursor:pointer;">
          <div style="display:flex; justify-content:space-between; gap:10px;">
            <div style="font-weight:950; font-size:16px; line-height:1.2;">${idx === 0 ? "⭐ " : ""}${name}</div>
            <div class="small muted" style="font-weight:900;">${time}</div>
          </div>
          <div class="small muted" style="margin-top:6px;">${vis} • ${sub}</div>
        </button>
      `;
    }).join("");

    return `
      <div style="margin-top:14px;">
        <div style="font-weight:950; font-size:18px; margin: 6px 0 10px;">Altre opzioni</div>
        <div style="display:flex; flex-direction:column; gap:10px;">
          ${items}
        </div>
        <div class="small muted" style="margin-top:10px;">Tocca un’opzione per aprire la scheda (senza rifare ricerca).</div>
      </div>
    `;
  }

  function renderChosenCard(origin, chosen, category, datasetInfo, usedMinutes, maxMinutesInput) {
    const area = $("resultArea");
    if (!area) return;

    const p = chosen.place;
    const pid = chosen.pid;

    const tb = typeBadge(category);
    const areaLabel = (p.area || p.country || "").trim() || "Italia";
    const name = p.name || "";

    const lat = Number(p.lat);
    const lon = Number(p.lon);
    const zoom = chosen.km < 20 ? 12 : chosen.km < 60 ? 10 : 8;
    const img1 = osmStaticImgPrimary(lat, lon, zoom);
    const img2 = osmStaticImgFallback(lat, lon, zoom);

    const what = shortWhatIs(p, category);
    const vis = visibilityLabel(p);
    const widenText = usedMinutes && usedMinutes !== maxMinutesInput ? ` • widen: ${usedMinutes} min` : "";

    area.innerHTML = `
      <div class="card" style="padding:0; overflow:hidden; border-color:rgba(0,224,255,.22);">
        <div style="position:relative; width:100%; aspect-ratio: 2 / 1; border-bottom:1px solid rgba(255,255,255,.10);">
          <img src="${img1}" alt="" loading="lazy" decoding="async"
              style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; opacity:.95;"
              onerror="(function(img){
                if(!img.dataset.fallbackTried){ img.dataset.fallbackTried='1'; img.src='${img2}'; return; }
                img.style.display='none';
              })(this)"
          />
          <div style="position:absolute; left:12px; top:12px; display:flex; gap:8px; flex-wrap:wrap; max-width: calc(100% - 24px);">
            <div style="border:1px solid rgba(255,255,255,.12); background:rgba(0,0,0,.25); padding:6px 10px; border-radius:999px; font-size:12px; color:rgba(255,255,255,.92); font-weight:900;">
              ${tb.emoji} ${tb.label}
            </div>
            <div style="border:1px solid rgba(255,255,255,.12); background:rgba(0,0,0,.25); padding:6px 10px; border-radius:999px; font-size:12px; color:rgba(255,255,255,.92); font-weight:900;">
              🚗 ~${chosen.driveMin} min • ${fmtKm(chosen.km)}
            </div>
            <div style="border:1px solid rgba(255,255,255,.12); background:rgba(0,0,0,.25); padding:6px 10px; border-radius:999px; font-size:12px; color:rgba(255,255,255,.92); font-weight:900;">
              ${vis}
            </div>
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
            Dataset: ${escapeHtml(datasetInfo || "—")} • score: ${chosen.score}${widenText}
          </div>

          <div style="margin-top:12px; font-weight:950;">Cos’è (in 1 riga)</div>
          <div class="small muted" style="margin-top:6px; line-height:1.45;">
            ${escapeHtml(what)}
          </div>

          <div style="margin-top:14px; display:flex; flex-wrap:wrap; gap:10px;">
            <a class="btn" target="_blank" rel="noopener" href="${mapsPlaceUrl(lat, lon)}">🗺️ Maps</a>
            <a class="btnGhost" target="_blank" rel="noopener" href="${googleImagesUrl(name, areaLabel)}">📸 Foto</a>
            <a class="btnGhost" target="_blank" rel="noopener" href="${wikiUrl(name, areaLabel)}">📚 Wiki</a>
            <button class="btnGhost" id="btnVisited" type="button">✅ Visitato</button>
            <button class="btn" id="btnChange" type="button">🔁 Cambia</button>
          </div>

          ${renderOptionsList(LAST_OPTIONS)}
        </div>
      </div>
    `;

    $("btnVisited")?.addEventListener("click", () => {
      markVisited(pid);
      showStatus("ok", "Segnato come visitato ✅");
    });

    $("btnChange")?.addEventListener("click", () => {
      runSearch({ silent: true, forbidPid: pid });
    });

    area.querySelectorAll(".optItem")?.forEach(btn => {
      btn.addEventListener("click", () => {
        const pid2 = btn.getAttribute("data-pid");
        const found = LAST_OPTIONS.find(x => x.pid === pid2);
        if (!found) return;
        openChosen(found, { keepOptions: true, scroll: true });
      });
    });

    // rotation tracking
    LAST_SHOWN_PID = pid;
    SESSION_SEEN.add(pid);
    addRecent(pid);

    CURRENT_CHOSEN = chosen;
    scrollToId("resultCard");
  }

  // -------------------- DOCK ACTIONS --------------------
  function dockAction(kind) {
    const origin = getOrigin();
    const chosen = CURRENT_CHOSEN;

    if (!origin || !chosen) {
      showStatus("warn", "Prima premi Cerca per ottenere una meta.");
      scrollToId("searchCard");
      return;
    }

    const p = chosen.place;
    const areaLabel = (p.area || p.country || "").trim() || "Italia";
    const name = p.name || "";
    const lat = Number(p.lat);
    const lon = Number(p.lon);

    if (kind === "nav") {
      window.open(mapsDirUrl(origin.lat, origin.lon, lat, lon), "_blank", "noopener");
      return;
    }

    if (kind === "book") {
      // Biglietti per family/storia/attrazioni
      const cat = getActiveCategory();
      const t = tagsStr(p);

      const isTicketish =
        cat === "family" || cat === "storia" ||
        t.includes("tourism=museum") || t.includes("tourism=theme_park") ||
        t.includes("tourism=zoo") || t.includes("tourism=aquarium") ||
        t.includes("tourism=attraction") || t.includes("leisure=water_park");

      const url = isTicketish
        ? gygSearchUrl(name, areaLabel)
        : bookingSearchUrl(name, areaLabel);

      window.open(url, "_blank", "noopener");
      return;
    }

    if (kind === "eat") {
      window.open(theforkSearchUrl(name, areaLabel, lat, lon), "_blank", "noopener");
      return;
    }
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
        showStatus("err", "Imposta la partenza (Usa questo luogo).");
        scrollToId("quickStartCard");
        return;
      }

      await ensureDatasetLoaded(origin, { signal });

      const basePool = Array.isArray(DATASET?.places) ? DATASET.places : [];
      const datasetInfo =
        DATASET.kind === "pois_region"
          ? `POI:${(DATASET.source || "").split("/").pop()} (${basePool.length})`
          : DATASET.kind === "macro"
            ? `MACRO:${(DATASET.source || "").split("/").pop()} (${basePool.length})`
            : `—`;

      const maxMinutesInput = clamp(Number($("maxMinutes")?.value) || 120, 10, 600);
      const category = getActiveCategory();
      const styles = getActiveStyles();
      const steps = widenMinutesSteps(maxMinutesInput, category);

      let usedMinutes = steps[0];
      let options = [];

      for (const mins of steps) {
        usedMinutes = mins;

        const found = pickTopOptions(basePool, origin, mins, category, styles);
        options = uniqueByPid(found);

        if (forbidPid) options = options.filter(x => x.pid !== forbidPid);

        if (options.length) break;
        if (token !== SEARCH_TOKEN) return;
      }

      if (token !== SEARCH_TOKEN) return;

      if (!options.length) {
        renderNoResult(maxMinutesInput, category, datasetInfo);
        showStatus("warn", `Nessuna meta entro ${maxMinutesInput} min per "${category}". Prova ad aumentare i minuti o cambia categoria/stile.`);
        return;
      }

      options = options.slice(0, CFG.OPTIONS_TOTAL);
      LAST_OPTIONS = options;

      const chosen = options[0];
      openChosen(chosen, { origin, category, datasetInfo, usedMinutes, maxMinutesInput });

      if (!silent) {
        const extra = usedMinutes !== maxMinutesInput ? ` (ho allargato a ${usedMinutes} min)` : "";
        showStatus("ok", `Trovate ${options.length} opzioni ✅ • categoria: ${category}${extra}`);
      }

    } catch (e) {
      if (String(e?.name || "").includes("Abort")) return;
      console.error(e);
      showStatus("err", `Errore: ${String(e.message || e)}`);
    }
  }

  function openChosen(chosen, meta = {}) {
    const origin = meta.origin || getOrigin();
    const category = meta.category || getActiveCategory();
    const datasetInfo = meta.datasetInfo || "";
    const usedMinutes = meta.usedMinutes;
    const maxMinutesInput = meta.maxMinutesInput || Number($("maxMinutes")?.value) || 120;

    CURRENT_CHOSEN = chosen;
    renderChosenCard(origin, chosen, category, datasetInfo, usedMinutes, maxMinutesInput);
    scrollToId("resultCard");
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

        showStatus("ok", "Partenza impostata ✅ Ora premi Cerca.");
        DATASET = { kind: null, source: null, places: [], meta: {} };
        await ensureDatasetLoaded(getOrigin(), { signal: undefined }).catch(() => {});

        scrollToId("searchCard");
      } catch (e) {
        console.error(e);
        if ($("originStatus")) $("originStatus").textContent = `❌ ${String(e.message || e)}`;
        showStatus("err", `Geocoding fallito: ${String(e.message || e)}`);
        scrollToId("quickStartCard");
      }
    });
  }

  // -------------------- MAIN BUTTONS + DOCK --------------------
  function bindMainButtons() {
    $("btnFind")?.addEventListener("click", () => runSearch());
    $("btnResetVisited")?.addEventListener("click", () => { resetVisited(); showStatus("ok", "Visitati resettati ✅"); });

    $("dockSearch")?.addEventListener("click", () => runSearch({ silent: false }));
    $("dockNav")?.addEventListener("click", () => dockAction("nav"));
    $("dockBook")?.addEventListener("click", () => dockAction("book"));
    $("dockEat")?.addEventListener("click", () => dockAction("eat"));
  }

  // -------------------- BOOT --------------------
  function boot() {
    initChips("timeChips", { multi: false });
    initChips("categoryChips", { multi: false });
    initChips("styleChips", { multi: true });

    initTimeChipsSync();
    restoreOrigin();
    bindOriginButtons();
    bindMainButtons();

    hideStatus();

    const origin = getOrigin();
    if (origin) collapseOriginCard(true);

    (async () => {
      try { const o = getOrigin(); if (o) await ensureDatasetLoaded(o, { signal: undefined }); }
      catch {}
    })();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();

  // expose
  window.__jamo = {
    runSearch,
    resetRotation,
    resetVisited,
    getOrigin,
    getDataset: () => DATASET,
    dockAction,
    forceRegion: (id) => { localStorage.setItem("jamo_region_id", id); DATASET = { kind:null, source:null, places:[], meta:{} }; },
    clearRegion: () => { localStorage.removeItem("jamo_region_id"); DATASET = { kind:null, source:null, places:[], meta:{} }; },
  };
})();
