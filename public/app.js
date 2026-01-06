/* Jamo — app.js v10.7 (NO-GPS + OFFLINE-ONLY + REAL TAG CATEGORIES + SEASON + NATURA + MONETIZATION SAFE)
 * ✅ NO GPS: disattiva e nasconde il tasto GPS
 * ✅ OFFLINE-ONLY: niente LIVE fallback
 * ✅ Anti-sporco: esclude hotel/ristoranti/bar/cafe ecc.
 * ✅ Categorie REALI: matching SOLO tramite tag OSM (niente match per nome)
 * ✅ Panorami: SOLO tourism=viewpoint (+ observation tower)
 * ✅ Hiking: riduce spam (no guidepost anonimi)
 * ✅ NATURA: laghi/cascate/fiumi/parchi/riserve ecc. (tag-only)
 * ✅ Stagionalità OFFLINE (inverno/estate) -> boost su scoring
 * ✅ Link coerenti: query ancorate con nome + coordinate (no risultati a caso)
 * ✅ Monetizzazione: mostra pulsante PRENOTA solo se esiste tuo link monetizzabile nel POI
 */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // -------------------- ROUTING / ESTIMATOR --------------------
  const ROAD_FACTOR = 1.25;
  const AVG_KMH = 72;
  const FIXED_OVERHEAD_MIN = 8;

  // -------------------- ROTATION --------------------
  const RECENT_TTL_MS = 1000 * 60 * 60 * 20;
  const RECENT_MAX = 160;
  let SESSION_SEEN = new Set();
  let LAST_SHOWN_PID = null;

  // -------------------- GLOBAL SEARCH CONTROL (anti-race) --------------------
  let SEARCH_TOKEN = 0;
  let SEARCH_ABORT = null;

  // -------------------- OFFLINE DATA --------------------
  const MACROS_INDEX_URL = "/data/macros/macros_index.json";
  const FALLBACK_MACRO_URLS = [
    "/data/macros/euuk_country_it.json",
    "/data/macros/euuk_macro_all.json",
  ];

  // ✅ POI regionali (test Veneto)
  const REGIONAL_POIS_BY_ID = {
    "it-veneto": "/data/pois/regions/it-veneto.json",
  };

  // Veneto bbox (approssimata)
  const REGION_BBOX = {
    "it-veneto": { minLat: 44.70, maxLat: 46.70, minLon: 10.20, maxLon: 13.20 },
  };

  // OFFLINE-ONLY
  const LIVE_ENABLED = false;

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

  function safeIdFromPlace(p) {
    if (p?.id) return String(p.id);
    const nm = normName(p?.name);
    const lat = String(p?.lat ?? "").slice(0, 8);
    const lon = String(p?.lon ?? p?.lng ?? "").slice(0, 8);
    return `p_${nm || "x"}_${lat}_${lon}`;
  }

  function estCarMinutesFromKm(km) {
    if (!Number.isFinite(km)) return NaN;
    const roadKm = km * ROAD_FACTOR;
    const driveMin = (roadKm / AVG_KMH) * 60;
    return Math.round(clamp(driveMin + FIXED_OVERHEAD_MIN, 6, 900));
  }

  function fmtKm(km) { return `${Math.round(km)} km`; }

  function withinBBox(lat, lon, bbox) {
    if (!bbox) return false;
    return lat >= bbox.minLat && lat <= bbox.maxLat && lon >= bbox.minLon && lon <= bbox.maxLon;
  }

  function safeText(x) { return String(x ?? "").trim(); }

  // -------------------- STAGIONALITA' (OFFLINE) --------------------
  function getSeason() {
    const m = new Date().getMonth() + 1; // 1..12
    // Inverno: nov-mar, Estate: giu-set, Mezze stagioni: resto
    if (m <= 3 || m >= 11) return "winter";
    if (m >= 6 && m <= 9) return "summer";
    return "mid";
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

  // -------------------- LINKS (coerenti = nome + coord) --------------------
  function mapsPlaceUrl(lat, lon) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lon)}`;
  }
  function mapsDirUrl(oLat, oLon, dLat, dLon) {
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(oLat + "," + oLon)}&destination=${encodeURIComponent(dLat + "," + dLon)}&travelmode=driving`;
  }
  function buildAnchoredQuery(name, area, lat, lon, prefix = "") {
    const n = safeText(name);
    const a = safeText(area);
    const core = [prefix, n, a, `${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}`]
      .filter(Boolean)
      .join(" ");
    // niente virgolette obbligatorie (a volte peggiorano su mobile)
    return core.trim();
  }
  function googleImagesUrl(name, area, lat, lon) {
    const q = buildAnchoredQuery(name, area, lat, lon, "foto");
    return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`;
  }
  function googleThingsToDoUrl(name, area, lat, lon) {
    const q = buildAnchoredQuery(name, area, lat, lon, "cosa vedere");
    return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  }
  function googleDoUrl(name, area, lat, lon) {
    const q = buildAnchoredQuery(name, area, lat, lon, "cosa fare");
    return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  }
  function wikiUrl(name, area) {
    const q = [safeText(name), safeText(area)].filter(Boolean).join(" ");
    return `https://it.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`;
  }
  function eventsUrl(name, area, lat, lon) {
    const q = buildAnchoredQuery(name, area, lat, lon, "eventi");
    return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  }
  function restaurantsUrl(name, area, lat, lon) {
    const q = buildAnchoredQuery(name, area, lat, lon, "ristoranti vicino");
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
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
    let cat = active?.dataset.cat || "ovunque";

    // compat: se UI ha kids_museum, lo trattiamo come family
    if (cat === "kids_museum") cat = "family";

    return cat;
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

  function showResultProgress(msg = "Cerco nel dataset offline, rispettando categoria e tempo.") {
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
  async function fetchJson(url, { signal } = {}) {
    const r = await fetch(url, { cache: "no-store", signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }

  // -------------------- DATASET (OFFLINE) --------------------
  let MACROS_INDEX = null;
  let DATASET = { kind: null, source: null, places: [], meta: {} };

  function normalizeVisibility(v) {
    const s = String(v || "").toLowerCase().trim();
    if (s === "chicca") return "chicca";
    return "classica";
  }

  function normalizeType(t) {
    const s = String(t || "").toLowerCase().trim();
    if (!s) return "";
    if (s === "borgo") return "borghi";
    if (s === "città") return "citta";
    if (s === "citta") return "citta";
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

    const rawType = out.type || out.primary_category || out.category || "";
    out.type = normalizeType(rawType);

    out.visibility = normalizeVisibility(out.visibility);

    out.tags = Array.isArray(out.tags)
      ? out.tags.map(x => String(x).toLowerCase())
      : [];

    out.country = String(out.country || "").toUpperCase();
    out.area = String(out.area || "");
    return out;
  }

  async function loadMacrosIndexSafe(signal) {
    try {
      MACROS_INDEX = await fetchJson(MACROS_INDEX_URL, { signal });
    } catch {
      MACROS_INDEX = null;
    }
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

    const hit1 = MACROS_INDEX.items.find(x =>
      String(x.id || "") === `euuk_country_${c.toLowerCase()}` ||
      String(x.path || "").includes(`euuk_country_${c.toLowerCase()}.json`)
    );
    if (hit1?.path) return hit1.path;

    return null;
  }

  function pickRegionIdFromOrigin(origin) {
    const lat = Number(origin?.lat);
    const lon = Number(origin?.lon);
    const cc = String(origin?.country_code || "").toUpperCase();

    const saved = localStorage.getItem("jamo_region_id");
    if (saved && REGIONAL_POIS_BY_ID[saved] && withinBBox(lat, lon, REGION_BBOX[saved])) return saved;

    if (cc === "IT" && withinBBox(lat, lon, REGION_BBOX["it-veneto"])) return "it-veneto";
    return "";
  }

  async function ensureDatasetLoaded(origin, { signal } = {}) {
    if (DATASET?.places?.length) return DATASET;

    await loadMacrosIndexSafe(signal);

    const candidates = [];

    // 0) regione (solo se dentro bbox)
    const regionId = pickRegionIdFromOrigin(origin);
    if (regionId && REGIONAL_POIS_BY_ID[regionId]) {
      candidates.push(REGIONAL_POIS_BY_ID[regionId]);
    }

    // 1) macro country (se index disponibile)
    const cc = String(origin?.country_code || "").toUpperCase();
    const countryMacro = findCountryMacroPath(cc);
    if (countryMacro) candidates.push(countryMacro);

    // 2) fallback macro hardcoded
    for (const u of FALLBACK_MACRO_URLS) candidates.push(u);

    // 3) eventuale macro salvato
    const savedMacro = localStorage.getItem("jamo_macro_url");
    if (savedMacro) candidates.push(savedMacro);

    // dedup
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

    throw new Error("Nessun dataset offline valido disponibile (POI regionali o macro).");
  }

  // -------------------- GEOCODING --------------------
  async function geocodeLabel(label) {
    const q = String(label || "").trim();
    if (!q) throw new Error("Scrivi un luogo (es: Venezia, Verona, Padova...)");
    const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { method: "GET", cache: "no-store" });
    const j = await r.json().catch(() => null);
    if (!j) throw new Error("Geocoding fallito (risposta vuota)");
    if (!j.ok) throw new Error(j.error || "Geocoding fallito");
    if (!j.result || !Number.isFinite(Number(j.result.lat)) || !Number.isFinite(Number(j.result.lon))) {
      throw new Error("Geocoding fallito (coordinate non valide)");
    }
    return j.result;
  }

  // -------------------- TAGS / CATEGORY (REAL TAG-ONLY) --------------------
  function placeTags(place) { return (place.tags || []).map(t => String(t).toLowerCase()); }
  function tagsStr(place) { return placeTags(place).join(" "); }

  // ✅ anti-sporco globale: niente hotel/ristoranti ecc.
  function isLodgingOrFood(place) {
    const t = tagsStr(place);

    // lodging
    if (t.includes("tourism=hotel")) return true;
    if (t.includes("tourism=hostel")) return true;
    if (t.includes("tourism=guest_house")) return true;
    if (t.includes("tourism=apartment")) return true;
    if (t.includes("tourism=camp_site")) return true;
    if (t.includes("tourism=caravan_site")) return true;
    if (t.includes("tourism=chalet")) return true;
    if (t.includes("tourism=motel")) return true;

    // food & drink
    if (t.includes("amenity=restaurant")) return true;
    if (t.includes("amenity=fast_food")) return true;
    if (t.includes("amenity=cafe")) return true;
    if (t.includes("amenity=bar")) return true;
    if (t.includes("amenity=pub")) return true;
    if (t.includes("amenity=ice_cream")) return true;

    return false;
  }

  function isSpaPlace(place) {
    const t = tagsStr(place);
    const type = normalizeType(place?.type);
    return (
      type === "relax" ||
      t.includes("amenity=spa") ||
      t.includes("leisure=spa") ||
      t.includes("tourism=spa") ||
      t.includes("natural=hot_spring") ||
      t.includes("amenity=public_bath") ||
      t.includes("leisure=swimming_pool") ||
      t.includes("amenity=sauna") ||
      t.includes("leisure=sauna") ||
      t.includes("thermal=yes")
    );
  }

  // family tag-only
  function isThemePark(place) { return tagsStr(place).includes("tourism=theme_park"); }
  function isWaterPark(place) { return tagsStr(place).includes("leisure=water_park"); }
  function isZooOrAquarium(place) {
    const t = tagsStr(place);
    return t.includes("tourism=zoo") || t.includes("tourism=aquarium") || t.includes("amenity=aquarium");
  }
  function isPlaygroundLike(place) { return tagsStr(place).includes("leisure=playground"); }

  // ✅ panorami REALI
  function isRealViewpoint(place) {
    const t = tagsStr(place);
    return t.includes("tourism=viewpoint") || t.includes("man_made=observation_tower") || t.includes("tower:type=observation");
  }

  // ✅ hiking “pulito”
  function isHiking(place) {
    const t = tagsStr(place);
    const type = normalizeType(place?.type);

    if (type === "hiking") return !isLodgingOrFood(place);

    if (t.includes("amenity=shelter")) return true;
    if (t.includes("tourism=alpine_hut")) return true;

    if (t.includes("information=guidepost")) {
      const n = String(place?.name || "").trim();
      if (!n || n.length < 6) return false;
      const nn = normName(n);
      return (nn.includes("sentier") || nn.includes("cai") || nn.includes("anello") || nn.includes("trail"));
    }
    return false;
  }

  // ✅ NATURA “vera” (laghi/cascate/fiumi/parchi/riserve)
  function isNature(place) {
    const t = tagsStr(place);
    const type = normalizeType(place?.type);

    // no place=*
    if (t.includes("place=city") || t.includes("place=town") || t.includes("place=village") || t.includes("place=hamlet")) return false;

    return (
      type === "natura" ||
      t.includes("natural=waterfall") ||
      t.includes("natural=spring") ||
      t.includes("natural=water") ||           // laghi, bacini, fiumi (spesso area)
      t.includes("water=lake") ||
      t.includes("water=reservoir") ||
      t.includes("waterway=river") ||
      t.includes("waterway=stream") ||
      t.includes("waterway=canal") ||
      t.includes("waterway=riverbank") ||
      t.includes("leisure=park") ||
      t.includes("leisure=nature_reserve") ||
      t.includes("boundary=national_park") ||
      t.includes("boundary=protected_area") ||
      t.includes("natural=wood")
    );
  }

  // montagna “vera”
  function isMountain(place) {
    const t = tagsStr(place);
    const type = normalizeType(place?.type);

    if (t.includes("place=city") || t.includes("place=town") || t.includes("place=village") || t.includes("place=hamlet")) return false;

    return (
      type === "montagna" ||
      t.includes("natural=peak") ||
      t.includes("natural=saddle") ||
      t.includes("natural=waterfall") ||
      t.includes("natural=spring") ||
      t.includes("natural=cave_entrance") ||
      t.includes("leisure=nature_reserve") ||
      t.includes("boundary=national_park") ||
      t.includes("amenity=shelter") ||
      t.includes("tourism=alpine_hut") ||
      t.includes("aerialway=") ||
      // tag “invernali”
      t.includes("piste:type=downhill") ||
      t.includes("sport=skiing")
    );
  }

  function isBorgo(place) {
    const type = normalizeType(place?.type);
    const t = tagsStr(place);
    return type === "borghi" || t.includes("place=village") || t.includes("place=hamlet");
  }

  function isCity(place) {
    const type = normalizeType(place?.type);
    const t = tagsStr(place);
    return type === "citta" || t.includes("place=city") || t.includes("place=town");
  }

  function matchesCategoryStrict(place, cat) {
    if (!cat || cat === "ovunque") return true;

    const type = normalizeType(place?.type);
    const t = tagsStr(place);

    if (cat === "mare") {
      return type === "mare" || t.includes("natural=beach") || t.includes("leisure=marina") || t.includes("natural=coastline");
    }

    if (cat === "storia") {
      return (
        type === "storia" ||
        t.includes("historic=castle") ||
        t.includes("historic=fort") ||
        t.includes("historic=ruins") ||
        t.includes("historic=archaeological_site") ||
        t.includes("historic=monument") ||
        t.includes("historic=memorial") ||
        t.includes("tourism=museum")
      );
    }

    if (cat === "natura") return isNature(place);
    if (cat === "relax") return isSpaPlace(place);
    if (cat === "borghi") return isBorgo(place);
    if (cat === "citta") return isCity(place);
    if (cat === "montagna") return isMountain(place);

    if (cat === "viewpoints") return isRealViewpoint(place);
    if (cat === "hiking") return isHiking(place);

    if (cat === "family") {
      return (
        type === "family" ||
        isThemePark(place) ||
        isWaterPark(place) ||
        isZooOrAquarium(place) ||
        isPlaygroundLike(place) ||
        // indoor family “reali”
        t.includes("leisure=trampoline_park") ||
        t.includes("leisure=miniature_golf") ||
        t.includes("leisure=ice_rink") ||
        t.includes("leisure=bowling_alley") ||
        t.includes("amenity=cinema")
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

  // -------------------- SEASON BOOST (OFFLINE) --------------------
  function isWinterAttraction(place) {
    const t = tagsStr(place);
    return (
      t.includes("piste:type=downhill") ||
      t.includes("sport=skiing") ||
      t.includes("aerialway=") ||
      t.includes("leisure=ice_rink")
    );
  }
  function isSummerAttraction(place) {
    const t = tagsStr(place);
    return (
      t.includes("natural=beach") ||
      t.includes("leisure=marina") ||
      t.includes("leisure=water_park") ||
      t.includes("natural=water") ||
      t.includes("water=lake") ||
      t.includes("natural=waterfall")
    );
  }

  function seasonBoost(place, category, season) {
    // solo piccoli boost, non stravolge
    let b = 0;
    if (season === "summer") {
      if (category === "mare") b += 0.10;
      if (category === "natura" && isSummerAttraction(place)) b += 0.08;
      if (category === "family" && isWaterPark(place)) b += 0.08;
      if (category === "viewpoints") b += 0.05;
      if (category === "hiking") b += 0.04;
    } else if (season === "winter") {
      if (category === "montagna" && isWinterAttraction(place)) b += 0.10;
      if (category === "relax") b += 0.08;
      if (category === "storia") b += 0.04; // spesso indoor
      if (category === "family" && tagsStr(place).includes("leisure=ice_rink")) b += 0.06;
    } else {
      // mid season: trekking + storia + borghi
      if (category === "hiking") b += 0.05;
      if (category === "storia") b += 0.04;
      if (category === "borghi") b += 0.04;
      if (category === "natura") b += 0.03;
    }
    return b;
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

  function familyBoost(place, category) {
    if (category !== "family") return 0;
    if (isThemePark(place)) return 0.26;
    if (isWaterPark(place)) return 0.24;
    if (isZooOrAquarium(place)) return 0.22;
    if (isPlaygroundLike(place)) return 0.12;
    return 0;
  }

  // -------------------- TIME WIDEN --------------------
  function widenMinutesSteps(m, category) {
    const base = clamp(Number(m) || 120, 10, 600);
    const steps = [base];

    const muls =
      category === "family" ? [1.15, 1.30, 1.50] :
      category === "mare" ?   [1.20, 1.40, 1.65] :
      category === "storia" ? [1.20, 1.40, 1.60] :
                              [1.20, 1.40, 1.60];

    for (const k of muls) steps.push(clamp(Math.round(base * k), base, 600));
    steps.push(clamp(Math.max(240, base), base, 600));

    return Array.from(new Set(steps)).sort((a, b) => a - b);
  }

  // -------------------- CANDIDATES / PICK --------------------
  function buildCandidatesFromPool(
    pool,
    origin,
    maxMinutes,
    category,
    styles,
    {
      ignoreVisited = false,
      ignoreRotation = false,
      allowSpaInFamily = false,
    } = {}
  ) {
    const visited = getVisitedSet();
    const recentSet = getRecentSet();
    const target = Number(maxMinutes);

    const oLat = Number(origin.lat);
    const oLon = Number(origin.lon);

    const season = getSeason();
    const candidates = [];

    for (const raw of pool) {
      const p = normalizePlace(raw);
      if (!p) continue;

      const nm = String(p.name || "").trim();
      if (!nm || nm.length < 2 || normName(nm) === "meta") continue;

      // ✅ anti-sporco
      if (isLodgingOrFood(p)) continue;

      const okCat = matchesCategoryStrict(p, category) || (
        category === "family" && allowSpaInFamily && isSpaPlace(p)
      );
      if (!okCat) continue;

      if (!matchesStyle(p, styles)) continue;

      const pid = safeIdFromPlace(p);
      if (!ignoreVisited && visited.has(pid)) continue;

      const km = haversineKm(oLat, oLon, p.lat, p.lon);
      const driveMin = estCarMinutesFromKm(km);

      if (!Number.isFinite(driveMin)) continue;
      if (driveMin > target) continue;

      if (km < (category === "family" ? 0.8 : 1.2)) continue;

      const isChicca = normalizeVisibility(p.visibility) === "chicca";

      let s = baseScorePlace({
        driveMin,
        targetMin: target,
        beautyScore: p.beauty_score,
        isChicca
      });

      s += familyBoost(p, category);
      s += seasonBoost(p, category, season);

      if (category === "family" && isSpaPlace(p) && !allowSpaInFamily) s -= 0.35;
      if (!ignoreRotation) s -= rotationPenalty(pid, recentSet);

      candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
    }

    candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
    return candidates;
  }

  function pickBest(pool, origin, minutes, category, styles) {
    let c = buildCandidatesFromPool(pool, origin, minutes, category, styles, {
      ignoreVisited: false,
      ignoreRotation: false,
      allowSpaInFamily: false,
    });
    if (c.length) return { chosen: c[0], alternatives: c.slice(1, 3), total: c.length, spaFallback: false };

    if (category === "family") {
      c = buildCandidatesFromPool(pool, origin, minutes, category, styles, {
        ignoreVisited: false,
        ignoreRotation: true,
        allowSpaInFamily: true,
      });
      if (c.length) return { chosen: c[0], alternatives: c.slice(1, 3), total: c.length, spaFallback: true };
    }

    c = buildCandidatesFromPool(pool, origin, minutes, category, styles, {
      ignoreVisited: false,
      ignoreRotation: true,
      allowSpaInFamily: false,
    });
    if (c.length) return { chosen: c[0], alternatives: c.slice(1, 3), total: c.length, spaFallback: false };

    c = buildCandidatesFromPool(pool, origin, minutes, category, styles, {
      ignoreVisited: true,
      ignoreRotation: true,
      allowSpaInFamily: category === "family",
    });

    return { chosen: c[0] || null, alternatives: c.slice(1, 3), total: c.length, spaFallback: category === "family" };
  }

  // -------------------- MONETIZATION (solo tuo link) --------------------
  function monetizationUrlFromPlace(p) {
    // Supporta entrambe: monetization.url oppure monetization_url
    const u1 = p?.monetization?.url;
    const u2 = p?.monetization_url;
    const u = String(u1 || u2 || "").trim();
    if (!u) return "";
    // minimo controllo
    if (!/^https?:\/\//i.test(u)) return "";
    return u;
  }
  function monetizationLabelFromPlace(p) {
    const l1 = p?.monetization?.label;
    const l2 = p?.monetization_label;
    const l = String(l1 || l2 || "").trim();
    return l || "🎟️ Prenota";
  }

  // -------------------- CARD HELPERS --------------------
  function typeBadge(category) {
    const map = {
      family: { emoji: "👨‍👩‍👧‍👦", label: "Family" },
      storia: { emoji: "🏛️", label: "Storia" },
      borghi: { emoji: "🏘️", label: "Borghi" },
      citta:  { emoji: "🏙️", label: "Città" },
      mare:   { emoji: "🌊", label: "Mare" },
      natura: { emoji: "🌿", label: "Natura" },
      montagna:{emoji:"🏔️",label:"Montagna"},
      relax:  { emoji: "🧖", label: "Relax" },
      viewpoints:{ emoji:"🌅", label:"Panorami" },
      hiking:{ emoji:"🥾", label:"Trekking" },
      ovunque:{ emoji: "🎲", label: "Meta" },
    };
    return map[category] || { emoji: "📍", label: "Meta" };
  }

  function microWhatToDo(place, category) {
    if (category === "family") {
      if (isThemePark(place)) return "Parco divertimenti: controlla orari e biglietti.";
      if (isWaterPark(place)) return "Acquapark: spesso stagionale — verifica apertura.";
      if (isZooOrAquarium(place)) return "Zoo/acquario: percorsi e tanto da vedere.";
      if (isPlaygroundLike(place)) return "Parco giochi: perfetto con bimbi.";
      if (tagsStr(place).includes("leisure=ice_rink")) return "Pista di ghiaccio: perfetta in inverno.";
      if (isSpaPlace(place)) return "Terme/piscine: verifica accesso bimbi e orari.";
      return "Attività family: foto e dintorni.";
    }
    if (category === "viewpoints") return "Punto panoramico vero: foto, tramonto e passeggiata breve.";
    if (category === "hiking") return "Trekking: scarpe buone e controlla meteo/tempo.";
    if (category === "relax") return "Relax: terme/spa/piscine o pausa tranquilla.";
    if (category === "storia") return "Visita culturale: museo/castello/sito storico.";
    if (category === "mare") return "Mare: spiaggia o marina, passeggiata e tramonto.";
    if (category === "natura") return "Natura: lago/cascata/fiume/parco o riserva.";
    if (category === "borghi") return "Borgo: vicoli, punti carini, foto.";
    if (category === "citta") return "Città: centro, monumenti e piazze.";
    if (category === "montagna") return "Montagna: cima/cascata/riserva o panorama naturale.";
    return "Esplora, foto, e cose da fare nei dintorni.";
  }

  // -------------------- RENDER --------------------
  function renderNoResultFinal(maxMinutesShown, category, datasetInfo) {
    const area = $("resultArea");
    if (!area) return;

    area.innerHTML = `
      <div class="card errbox">
        <div class="small">❌ Nessuna meta trovata entro ${maxMinutesShown} min per la categoria <b>${category}</b>.</div>
        <div class="small muted" style="margin-top:6px;">
          Suggerimento: aumenta minuti oppure cambia categoria.
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
      showStatus("ok", "Reset fatto ✅");
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

    const badge = normalizeVisibility(p.visibility) === "chicca" ? "✨ chicca" : "✅ classica";
    const tb = typeBadge(category);
    const what = microWhatToDo(p, category);

    const lat = Number(p.lat);
    const lon = Number(p.lon);
    const zoom = chosen.km < 20 ? 12 : chosen.km < 60 ? 10 : 8;

    const img1 = osmStaticImgPrimary(lat, lon, zoom);
    const img2 = osmStaticImgFallback(lat, lon, zoom);

    const areaLabel = (p.area || p.country || "").trim();
    const name = p.name || "";
    const linkArea = areaLabel || (origin?.country_code || "");

    // ✅ monetizzazione: solo se tuo link esiste
    const bookUrl = monetizationUrlFromPlace(p);
    const bookLabel = monetizationLabelFromPlace(p);

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
            📍 ${name}
          </div>

          <div style="position:absolute; left:12px; top:12px; display:flex; gap:8px; flex-wrap:wrap; max-width: calc(100% - 24px);">
            <div class="pill">${tb.emoji} ${tb.label}</div>
            <div class="pill">🚗 ~${chosen.driveMin} min • ${fmtKm(chosen.km)}</div>
            <div class="pill">${badge}</div>
          </div>
        </div>

        <div style="padding:14px;">
          <div style="font-weight:950; font-size:28px; line-height:1.12; margin:0;">
            ${name} <span class="small muted" style="font-weight:700;">(${areaLabel || "—"})</span>
          </div>

          <div class="small muted" style="margin-top:8px; line-height:1.35;">
            Dataset: ${meta.datasetInfo || "—"} • score: ${chosen.score}
            ${meta.usedMinutes && meta.usedMinutes !== maxMinutesShown ? ` • widen: ${meta.usedMinutes} min` : ""}
          </div>

          <div style="margin-top:12px; font-weight:900;">Cosa si fa</div>
          <div class="small muted" style="margin-top:6px; line-height:1.45;">${what}</div>

          <div class="row wrap gap" style="margin-top:14px;">
            ${bookUrl ? `<a class="btn" target="_blank" rel="noopener" href="${bookUrl}">${bookLabel}</a>` : ""}
            <a class="btn" target="_blank" rel="noopener" href="${mapsPlaceUrl(lat, lon)}">🗺️ Maps</a>
            <a class="btn" target="_blank" rel="noopener" href="${mapsDirUrl(origin.lat, origin.lon, lat, lon)}">🚗 Percorso</a>
            <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleImagesUrl(name, linkArea, lat, lon)}">📸 Foto</a>
            <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleThingsToDoUrl(name, linkArea, lat, lon)}">👀 Cosa vedere</a>
            <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleDoUrl(name, linkArea, lat, lon)}">🎯 Cosa fare</a>
            <a class="btn btn-ghost" target="_blank" rel="noopener" href="${wikiUrl(name, linkArea)}">📚 Wiki</a>
            <a class="btn btn-ghost" target="_blank" rel="noopener" href="${eventsUrl(name, linkArea, lat, lon)}">📅 Eventi</a>
            <a class="btn btn-ghost" target="_blank" rel="noopener" href="${restaurantsUrl(name, linkArea, lat, lon)}">🍝 Ristoranti (solo link)</a>
          </div>

          <div class="row wrap gap" style="margin-top:14px;">
            <button class="btn btn-ghost" id="btnVisited">✅ Già visitato</button>
            <button class="btn" id="btnChange">🔁 Cambia meta</button>
            <button class="btn btn-ghost" id="btnResetRotation">🧽 Reset “oggi”</button>
          </div>
        </div>
      </div>
    `;

    LAST_SHOWN_PID = pid;
    SESSION_SEEN.add(pid);
    addRecent(pid);

    $("btnVisited")?.addEventListener("click", () => {
      markVisited(pid);
      showStatus("ok", "Segnato come visitato ✅");
    });

    $("btnChange")?.addEventListener("click", () => {
      runSearch({ silent: true, forbidPid: pid });
    });

    $("btnResetRotation")?.addEventListener("click", () => {
      resetRotation();
      showStatus("ok", "Reset fatto ✅");
      runSearch({ silent: true });
    });
  }

  // -------------------- MAIN SEARCH (OFFLINE-ONLY) --------------------
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
        showStatus("err", "Scrivi un luogo e premi “Usa questo luogo”. (GPS disattivato)");
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

      let chosen = null;
      let alternatives = [];
      let usedMinutes = steps[0];

      for (const mins of steps) {
        usedMinutes = mins;

        const picked = pickBest(basePool, origin, mins, category, styles);
        chosen = picked.chosen;
        alternatives = picked.alternatives;

        if (forcePid) {
          const all = buildCandidatesFromPool(basePool, origin, mins, category, styles, {
            ignoreVisited: true, ignoreRotation: true, allowSpaInFamily: true
          });
          const forced = all.find(x => x.pid === forcePid);
          if (forced) {
            chosen = forced;
            alternatives = all.filter(x => x.pid !== forcePid).slice(0, 2);
          }
        } else if (forbidPid && chosen?.pid === forbidPid) {
          const all = buildCandidatesFromPool(basePool, origin, mins, category, styles, {
            ignoreVisited: true, ignoreRotation: true, allowSpaInFamily: true
          }).filter(x => x.pid !== forbidPid);
          chosen = all[0] || null;
          alternatives = all.slice(1, 3);
        }

        if (chosen) break;
        if (token !== SEARCH_TOKEN) return;
      }

      if (token !== SEARCH_TOKEN) return;

      if (!chosen && LIVE_ENABLED) {
        // intentionally disabled
      }

      renderResult(origin, maxMinutesInput, chosen, alternatives, {
        category,
        datasetInfo,
        usedMinutes,
        liveUsed: false,
      });

      if (!chosen) {
        showStatus("warn", `Nessuna meta entro ${maxMinutesInput} min per "${category}". Prova ad aumentare i minuti o cambia categoria.`);
      } else if (!silent) {
        const extra = usedMinutes !== maxMinutesInput ? ` (ho allargato a ${usedMinutes} min)` : "";
        showStatus("ok", `Meta trovata ✅ (~${chosen.driveMin} min) • categoria: ${category}${extra}`);
      }

    } catch (e) {
      if (String(e?.name || "").includes("Abort")) return;
      console.error(e);
      showStatus("err", `Errore: ${String(e.message || e)}`);
    }
  }

  // -------------------- INIT helpers --------------------
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
          country_code: result.country_code || ""
        });

        showStatus("ok", "Partenza impostata ✅");

        DATASET = { kind: null, source: null, places: [], meta: {} };
        await ensureDatasetLoaded(getOrigin(), { signal: undefined }).catch(() => {});
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

    (async () => {
      try {
        const origin = getOrigin();
        if (origin) await ensureDatasetLoaded(origin, { signal: undefined });
      } catch {}
    })();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  window.__jamo = {
    runSearch,
    resetRotation,
    resetVisited,
    getOrigin,
    getDataset: () => DATASET,
    forceRegion: (id) => { localStorage.setItem("jamo_region_id", id); DATASET = { kind:null, source:null, places:[], meta:{} }; },
    clearRegion: () => { localStorage.removeItem("jamo_region_id"); DATASET = { kind:null, source:null, places:[], meta:{} }; },
  };
})();
