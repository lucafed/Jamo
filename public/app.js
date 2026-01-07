/* Jamo — app.js v11.3
 * UX sequenziale + alternative leggibili + dedup alternative + CTA monetizzazione pulita
 * ✅ NO GPS
 * ✅ OFFLINE ONLY
 * ✅ Categorie hard (tag OSM)
 * ✅ NATURA inclusa
 */

(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // -------------------- ROUTE ESTIMATOR --------------------
  const ROAD_FACTOR = 1.25;
  const AVG_KMH = 72;
  const FIXED_OVERHEAD_MIN = 8;

  // -------------------- ROTATION --------------------
  const RECENT_TTL_MS = 1000 * 60 * 60 * 20;
  const RECENT_MAX = 160;
  let SESSION_SEEN = new Set();
  let LAST_SHOWN_PID = null;

  let SEARCH_TOKEN = 0;
  let SEARCH_ABORT = null;

  // -------------------- OFFLINE DATA --------------------
  const MACROS_INDEX_URL = "/data/macros/macros_index.json";
  const FALLBACK_MACRO_URLS = [
    "/data/macros/euuk_country_it.json",
    "/data/macros/euuk_macro_all.json",
  ];

  const REGIONAL_POIS_BY_ID = {
    "it-veneto": "/data/pois/regions/it-veneto.json",
  };

  const REGION_BBOX = {
    "it-veneto": { minLat: 44.70, maxLat: 46.70, minLon: 10.20, maxLon: 13.20 },
  };

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

  // -------------------- SEASON --------------------
  function isWinterNow() {
    const m = new Date().getMonth() + 1;
    return (m === 11 || m === 12 || m === 1 || m === 2 || m === 3);
  }
  function isSummerNow() {
    const m = new Date().getMonth() + 1;
    return (m === 6 || m === 7 || m === 8 || m === 9);
  }

  // -------------------- STATIC MAP --------------------
  function osmStaticImgPrimary(lat, lon, z = 12) {
    const size = "900x450";
    const marker = `${lat},${lon},lightblue1`;
    return `https://staticmap.openstreetmap.de/staticmap.php?center=${encodeURIComponent(lat + "," + lon)}&zoom=${encodeURIComponent(z)}&size=${encodeURIComponent(size)}&maptype=mapnik&markers=${encodeURIComponent(marker)}`;
  }
  function osmStaticImgFallback(lat, lon, z = 12) {
    const size = "900x450";
    const marker = `color:blue|${lat},${lon}`;
    return `https://staticmap.openstreetmap.fr/osmfr/staticmap.php?center=${encodeURIComponent(lat + "," + lon)}&zoom=${encodeURIComponent(z)}&size=${encodeURIComponent(size)}&markers=${encodeURIComponent(marker)}`;
  }

  // -------------------- LINKS --------------------
  function mapsPlaceUrl(lat, lon, name) {
    const q = name ? `${name} ${lat},${lon}` : `${lat},${lon}`;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  }
  function mapsDirUrl(oLat, oLon, dLat, dLon) {
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(oLat + "," + oLon)}&destination=${encodeURIComponent(dLat + "," + dLon)}&travelmode=driving`;
  }

  function stableQuery(name, area) {
    const n = String(name || "").trim();
    const a = String(area || "").trim();
    return a ? `"${n}" ${a}` : `"${n}"`;
  }

  function googleImagesUrl(name, area) {
    return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(stableQuery(name, area))}`;
  }
  function googleInfoUrl(name, area) {
    const q = `${stableQuery(name, area)} cos'è`;
    return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  }
  function restaurantsUrl(name, area, lat, lon) {
    const q = area ? `ristoranti vicino ${name} ${area}` : `ristoranti vicino ${name}`;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}&center=${encodeURIComponent(lat + "," + lon)}`;
  }

  // monetizzazione placeholder (poi lo mettiamo su /go/*)
  function ticketsUrl(place, category) {
    const area = (place.area || place.country || "Italia").trim();
    const name = place.name || "";
    const kind = kindLabel(place, category);
    const q = `"${name}" ${area} ${kind} biglietti prenota`;
    return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  }
  function hotelsNearUrl(place) {
    const area = (place.area || place.country || "Italia").trim();
    const name = place.name || "";
    const q = `hotel vicino ${name} ${area}`;
    return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
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
  function saveRecent(list) { localStorage.setItem("jamo_recent", JSON.stringify(list.slice(0, RECENT_MAX))); }
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
    return { wantChicche: actives.includes("chicche"), wantClassici: actives.includes("classici") };
  }

  function showStatus(type, text) {
    const box = $("statusBox");
    const t = $("statusText");
    if (!box || !t) return;

    box.classList.remove("okbox", "warnbox", "errbox");
    box.classList.add(type === "ok" ? "okbox" : type === "err" ? "errbox" : "warnbox");
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

  function showResultProgress(msg = "Sto cercando nel dataset offline…") {
    const area = $("resultArea");
    if (!area) return;
    area.innerHTML = `
      <div class="card warnbox">
        <div style="font-weight:950; font-size:18px;">🔎 Cerco…</div>
        <div class="small muted" style="margin-top:8px; line-height:1.4;">${msg}</div>
      </div>
    `;
  }

  // -------------------- DATASET --------------------
  let MACROS_INDEX = null;
  let DATASET = { kind: null, source: null, places: [], meta: {} };

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

  async function fetchJson(url, { signal } = {}) {
    const r = await fetch(url, { cache: "no-store", signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }

  async function loadMacrosIndexSafe(signal) {
    try { MACROS_INDEX = await fetchJson(MACROS_INDEX_URL, { signal }); }
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
    if (saved && REGIONAL_POIS_BY_ID[saved] && withinBBox(lat, lon, REGION_BBOX[saved])) return saved;

    if (cc === "IT" && withinBBox(lat, lon, REGION_BBOX["it-veneto"])) return "it-veneto";
    return "";
  }

  async function ensureDatasetLoaded(origin, { signal } = {}) {
    if (DATASET?.places?.length) return DATASET;

    await loadMacrosIndexSafe(signal);

    const candidates = [];
    const regionId = pickRegionIdFromOrigin(origin);
    if (regionId && REGIONAL_POIS_BY_ID[regionId]) candidates.push(REGIONAL_POIS_BY_ID[regionId]);

    const cc = String(origin?.country_code || "").toUpperCase();
    const countryMacro = findCountryMacroPath(cc);
    if (countryMacro) candidates.push(countryMacro);

    for (const u of FALLBACK_MACRO_URLS) candidates.push(u);

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

  // -------------------- TAG HELPERS --------------------
  function placeTags(place) { return (place.tags || []).map(t => String(t).toLowerCase()); }
  function tagsStr(place) { return placeTags(place).join(" "); }

  function isLodgingOrFood(place) {
    const t = tagsStr(place);
    if (t.includes("tourism=hotel") || t.includes("tourism=hostel") || t.includes("tourism=guest_house") ||
        t.includes("tourism=apartment") || t.includes("tourism=camp_site") || t.includes("tourism=caravan_site") ||
        t.includes("tourism=chalet") || t.includes("tourism=motel")) return true;

    if (t.includes("amenity=restaurant") || t.includes("amenity=fast_food") || t.includes("amenity=cafe") ||
        t.includes("amenity=bar") || t.includes("amenity=pub") || t.includes("amenity=ice_cream")) return true;

    return false;
  }

  function isSpaPlace(place) {
    const t = tagsStr(place);
    const type = normalizeType(place?.type);
    return (
      type === "relax" ||
      t.includes("amenity=spa") || t.includes("leisure=spa") || t.includes("tourism=spa") ||
      t.includes("natural=hot_spring") || t.includes("amenity=public_bath") ||
      t.includes("amenity=sauna") || t.includes("leisure=sauna") ||
      t.includes("leisure=swimming_pool")
    );
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

  // ✅ NATURA completo
  function isNature(place) {
    const t = tagsStr(place);
    const type = normalizeType(place?.type);
    return (
      type === "natura" ||
      t.includes("natural=waterfall") ||
      t.includes("natural=spring") ||
      t.includes("natural=cave_entrance") ||
      t.includes("natural=water") ||
      t.includes("water=lake") || t.includes("water=reservoir") ||
      t.includes("waterway=river") || t.includes("waterway=stream") || t.includes("waterway=riverbank") ||
      t.includes("leisure=nature_reserve") || t.includes("boundary=national_park")
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

  function matchesCategoryStrict(place, cat) {
    if (!cat || cat === "ovunque") return true;

    const type = normalizeType(place?.type);
    const t = tagsStr(place);

    if (cat === "mare") return type === "mare" || t.includes("natural=beach") || t.includes("leisure=marina") || t.includes("natural=coastline");
    if (cat === "storia") {
      return (
        type === "storia" ||
        t.includes("historic=castle") || t.includes("historic=fort") ||
        t.includes("historic=citywalls") || t.includes("historic=archaeological_site") ||
        t.includes("historic=ruins") ||
        t.includes("tourism=museum") || t.includes("tourism=attraction")
      );
    }
    if (cat === "relax") return isSpaPlace(place);
    if (cat === "borghi") return isBorgo(place);
    if (cat === "citta") return isCity(place);
    if (cat === "montagna") return isMountain(place);
    if (cat === "natura") return isNature(place);
    if (cat === "viewpoints") return isRealViewpoint(place);
    if (cat === "hiking") return isHiking(place);

    if (cat === "family") {
      const ok =
        type === "family" ||
        isThemePark(place) || isWaterPark(place) || isZooOrAquarium(place) ||
        t.includes("leisure=high_ropes_course") || t.includes("leisure=rope_course") ||
        t.includes("leisure=miniature_golf") || t.includes("leisure=trampoline_park") ||
        t.includes("leisure=bowling_alley") || t.includes("leisure=ice_rink");
      return ok;
    }

    return true;
  }

  function matchesStyle(place, { wantChicche, wantClassici }) {
    const vis = normalizeVisibility(place?.visibility);
    if (!wantChicche && !wantClassici) return true;
    if (vis === "chicca") return !!wantChicche;
    return !!wantClassici;
  }

  // -------------------- LABELS (per capire COS'È) --------------------
  function kindLabel(place, category) {
    const t = tagsStr(place);

    if (category === "natura") {
      if (t.includes("natural=waterfall")) return "Cascata";
      if (t.includes("natural=cave_entrance")) return "Grotta";
      if (t.includes("natural=spring")) return "Sorgente";
      if (t.includes("natural=water") || t.includes("water=lake") || t.includes("water=reservoir")) return "Lago";
      if (t.includes("waterway=river") || t.includes("waterway=stream") || t.includes("waterway=riverbank")) return "Fiume";
      if (t.includes("leisure=nature_reserve") || t.includes("boundary=national_park")) return "Parco / Riserva";
      return "Natura";
    }

    if (category === "family") {
      if (t.includes("tourism=theme_park")) return "Parco divertimenti";
      if (t.includes("leisure=water_park")) return "Acquapark";
      if (t.includes("tourism=zoo")) return "Zoo";
      if (t.includes("tourism=aquarium") || t.includes("amenity=aquarium")) return "Acquario";
      if (t.includes("leisure=high_ropes_course") || t.includes("leisure=rope_course")) return "Parco avventura";
      return "Family";
    }

    if (category === "storia") {
      if (t.includes("historic=castle")) return "Castello";
      if (t.includes("historic=fort")) return "Forte";
      if (t.includes("tourism=museum")) return "Museo";
      if (t.includes("historic=archaeological_site")) return "Sito archeologico";
      if (t.includes("historic=citywalls")) return "Mura storiche";
      if (t.includes("historic=ruins")) return "Rovine";
      return "Storia";
    }

    if (category === "relax") return "Terme / Spa";
    if (category === "mare") return "Mare / Spiaggia";
    if (category === "montagna") return "Montagna";
    if (category === "viewpoints") return "Panorama";
    if (category === "hiking") return "Trekking";
    if (category === "borghi") return "Borgo";
    if (category === "citta") return "Città";
    return "Meta";
  }

  function isBookable(place, category) {
    const t = tagsStr(place);
    if (category === "family") return true;
    if (category === "relax") return true;
    if (category === "storia" && (t.includes("tourism=museum") || t.includes("tourism=attraction"))) return true;
    if (t.includes("aerialway=") || t.includes("piste:type=")) return true;
    return false;
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
    if (isThemePark(place)) return 0.22;
    if (isWaterPark(place)) return 0.18;
    if (isZooOrAquarium(place)) return 0.16;
    return 0;
  }

  function isSummerThing(place) {
    const t = tagsStr(place);
    return t.includes("leisure=water_park") || t.includes("natural=beach") || t.includes("leisure=marina");
  }
  function isWinterThing(place) {
    const t = tagsStr(place);
    return t.includes("piste:type=") || t.includes("sport=skiing") || t.includes("aerialway=");
  }

  function seasonAdjust(place) {
    if (isWinterNow() && isSummerThing(place)) return -0.18;
    if (isSummerNow() && isWinterThing(place)) return -0.18;

    if (isWinterNow() && isSpaPlace(place)) return +0.08;
    if (isSummerNow() && (isSummerThing(place) || normalizeType(place?.type) === "mare")) return +0.06;
    return 0;
  }

  // -------------------- WIDEN --------------------
  function widenMinutesSteps(m, category) {
    const base = clamp(Number(m) || 120, 10, 600);
    const steps = [base];

    const muls =
      category === "family" ? [1.15, 1.30, 1.50] :
      category === "mare"   ? [1.20, 1.40, 1.65] :
      category === "storia" ? [1.20, 1.40, 1.60] :
                              [1.20, 1.40, 1.60];

    for (const k of muls) steps.push(clamp(Math.round(base * k), base, 600));
    steps.push(clamp(Math.max(240, base), base, 600));
    return Array.from(new Set(steps)).sort((a, b) => a - b);
  }

  // -------------------- CANDIDATES --------------------
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

      if (!ignoreRotation) s -= rotationPenalty(pid, recentSet);

      candidates.push({ place: p, pid, km, driveMin, score: Number(s.toFixed(4)) });
    }

    candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
    return candidates;
  }

  // ✅ DEDUP ALTERNATIVE: evita 5 “Risorgiva”
  function uniqueTop(cands, maxN = 5) {
    const out = [];
    const seenName = new Set();
    const seenCoord = new Set();

    for (const x of cands) {
      const p = x.place;
      const nKey = normName(p.name);
      const cKey = `${p.lat.toFixed(4)}_${p.lon.toFixed(4)}`;

      // dedup più aggressivo sul nome
      if (nKey && seenName.has(nKey)) continue;
      if (seenCoord.has(cKey)) continue;

      seenName.add(nKey);
      seenCoord.add(cKey);
      out.push(x);

      if (out.length >= maxN) break;
    }
    return out;
  }

  function pickTop(pool, origin, minutes, category, styles, topN = 5) {
    let c = buildCandidatesFromPool(pool, origin, minutes, category, styles, { ignoreVisited:false, ignoreRotation:false });
    let list = uniqueTop(c, topN);
    if (list.length) return { list, total: c.length };

    c = buildCandidatesFromPool(pool, origin, minutes, category, styles, { ignoreVisited:false, ignoreRotation:true });
    list = uniqueTop(c, topN);
    if (list.length) return { list, total: c.length };

    c = buildCandidatesFromPool(pool, origin, minutes, category, styles, { ignoreVisited:true, ignoreRotation:true });
    list = uniqueTop(c, topN);
    return { list, total: c.length };
  }

  // -------------------- RENDER HELPERS --------------------
  function badgeVis(p) {
    return normalizeVisibility(p.visibility) === "chicca" ? "✨ Chicca" : "✅ Classica";
  }

  function typeTitle(cat) {
    const map = {
      ovunque: "🎲 Meta",
      natura: "🌿 Natura",
      mare: "🌊 Mare",
      montagna: "🏔️ Montagna",
      storia: "🏛️ Storia",
      relax: "🧖 Relax",
      viewpoints: "🌅 Panorami",
      hiking: "🥾 Trekking",
      family: "👨‍👩‍👧‍👦 Family",
      borghi: "🏘️ Borghi",
      citta: "🏙️ Città",
    };
    return map[cat] || "📍 Meta";
  }

  function copyToClipboard(text) {
    try { navigator.clipboard.writeText(String(text)); return true; }
    catch { return false; }
  }

  function renderNoResultFinal(maxMinutesShown, category, datasetInfo) {
    const area = $("resultArea");
    if (!area) return;

    area.innerHTML = `
      <div class="card errbox">
        <div class="small">❌ Nessuna meta trovata entro ${maxMinutesShown} min per <b>${category}</b>.</div>
        <div class="small muted" style="margin-top:6px;">Prova ad aumentare i minuti o cambia categoria/stile.</div>
        <div class="small muted" style="margin-top:10px;">Dataset: ${datasetInfo}</div>
        <div style="margin-top:12px;">
          <button class="btn btn-ghost" id="btnResetRotation">🧽 Reset “oggi”</button>
        </div>
      </div>
    `;

    $("btnResetRotation")?.addEventListener("click", () => {
      resetRotation();
      showStatus("ok", "Reset fatto ✅");
      runSearch({ silent: true });
    });
  }

  // ✅ Alternative in card grandi e leggibili
  function renderOptionsList(list, selectedPid, category) {
    if (!list?.length) return "";
    const items = list.map((x, idx) => {
      const p = x.place;
      const sel = x.pid === selectedPid;
      const area = (p.area || p.country || "Italia").trim();
      const kind = kindLabel(p, category);
      const coords = `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`;

      return `
        <button type="button" data-pid="${x.pid}"
          style="
            width:100%;
            text-align:left;
            border-radius:16px;
            padding:12px 12px;
            border:1px solid rgba(255,255,255,.10);
            background:${sel ? "linear-gradient(90deg, rgba(0,224,255,.22), rgba(26,255,213,.10))" : "rgba(255,255,255,.05)"};
            color:#fff;
            cursor:pointer;
          ">
          <div style="display:flex; justify-content:space-between; gap:10px; align-items:center;">
            <div style="font-weight:900; font-size:15px; line-height:1.1;">
              ${idx === 0 ? "⭐ " : ""}${p.name}
            </div>
            <div style="font-weight:800; opacity:.92;">~${x.driveMin} min</div>
          </div>
          <div style="margin-top:6px; opacity:.82; font-size:12px;">
            ${kind} • ${area} • ${coords}
          </div>
        </button>
      `;
    }).join("");

    return `
      <div style="margin-top:14px; border-top:1px solid rgba(255,255,255,.08); padding-top:12px;">
        <div style="font-weight:950; font-size:16px; margin-bottom:10px;">Altre opzioni</div>
        <div id="topOptions" style="display:flex; flex-direction:column; gap:10px;">
          ${items}
        </div>
        <div class="small muted" style="margin-top:10px;">Tocca un’opzione e la scheda si aggiorna subito (senza rifare ricerca).</div>
      </div>
    `;
  }

  // ✅ Sequenza “Step” + CTA pulite
  function renderResult(origin, maxMinutesShown, topList, meta = {}, selectedPid = null) {
    const area = $("resultArea");
    if (!area) return;

    const category = meta.category || "ovunque";
    if (!topList?.length) {
      renderNoResultFinal(maxMinutesShown, category, meta.datasetInfo || "—");
      return;
    }

    const chosen = selectedPid ? topList.find(x => x.pid === selectedPid) : topList[0];
    const c = chosen || topList[0];
    const p = c.place;

    const lat = Number(p.lat);
    const lon = Number(p.lon);
    const zoom = c.km < 18 ? 13 : c.km < 55 ? 11 : 9;

    const img1 = osmStaticImgPrimary(lat, lon, zoom);
    const img2 = osmStaticImgFallback(lat, lon, zoom);

    const areaLabel = (p.area || p.country || "").trim() || "Italia";
    const name = p.name || "";
    const kind = kindLabel(p, category);
    const coordsText = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    const bookable = isBookable(p, category);

    area.innerHTML = `
      <div class="card okbox" style="overflow:hidden; padding:0; border-radius:18px;">
        <div style="position:relative; width:100%; aspect-ratio: 2 / 1; border-bottom:1px solid rgba(255,255,255,.08);">
          <img src="${img1}" alt="" loading="lazy" decoding="async"
               style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; opacity:.95;"
               onerror="(function(img){
                 if(!img.dataset.fallbackTried){ img.dataset.fallbackTried='1'; img.src='${img2}'; return; }
                 img.style.display='none';
                 var ph = img.parentElement.querySelector('.heroPlaceholder');
                 if(ph) ph.style.display='flex';
               })(this)"
          />
          <div class="heroPlaceholder"
               style="position:absolute; inset:0; display:none; align-items:center; justify-content:center;
                      background: linear-gradient(135deg, rgba(0,224,255,.18), rgba(26,255,213,.08));
                      color: rgba(255,255,255,.92); font-weight:950;">
            📍 ${name}
          </div>

          <div style="position:absolute; left:12px; top:12px; display:flex; gap:8px; flex-wrap:wrap; max-width: calc(100% - 24px);">
            <div class="pill">${typeTitle(category)}</div>
            <div class="pill">🏷️ ${kind}</div>
            <div class="pill">🚗 ~${c.driveMin} min • ${fmtKm(c.km)}</div>
            <div class="pill">${badgeVis(p)}</div>
          </div>
        </div>

        <div style="padding:14px;">
          <div style="font-weight:980; font-size:28px; line-height:1.12;">
            ${name} <span class="small muted" style="font-weight:700;">(${areaLabel})</span>
          </div>

          <div class="small muted" style="margin-top:8px; line-height:1.35;">
            Dataset: ${meta.datasetInfo || "—"} ${meta.usedMinutes && meta.usedMinutes !== maxMinutesShown ? ` • widen: ${meta.usedMinutes} min` : ""}
          </div>

          <!-- STEP 1 -->
          <div style="margin-top:14px; padding:12px; border-radius:16px; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.08);">
            <div style="font-weight:950;">1) Cos’è</div>
            <div class="small muted" style="margin-top:6px; line-height:1.45;">
              <b>${kind}</b>. Se vuoi capire subito: apri “Cos’è” o guarda le “Foto”.
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:10px;">
              <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleInfoUrl(name, areaLabel)}">ℹ️ Cos’è</a>
              <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleImagesUrl(name, areaLabel)}">📸 Foto</a>
            </div>
          </div>

          <!-- STEP 2 -->
          <div style="margin-top:12px; padding:12px; border-radius:16px; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.08);">
            <div style="font-weight:950;">2) Dove sta</div>
            <div class="small muted" style="margin-top:6px; line-height:1.45;">
              <b>${areaLabel}</b> • <span style="opacity:.9;">${coordsText}</span>
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:10px;">
              <button class="btn btn-ghost" id="btnCopyCoords" type="button">📋 Copia coordinate</button>
              <a class="btn btn-ghost" target="_blank" rel="noopener" href="${mapsPlaceUrl(lat, lon, name)}">🗺️ Apri su Maps</a>
            </div>
          </div>

          <!-- STEP 3 -->
          <div style="margin-top:12px; padding:12px; border-radius:16px; background:linear-gradient(90deg, rgba(0,224,255,.18), rgba(26,255,213,.08)); border:1px solid rgba(0,224,255,.35);">
            <div style="font-weight:980;">3) Vai (auto)</div>
            <div class="small" style="margin-top:6px; opacity:.92; line-height:1.45;">
              Premi <b>Naviga</b> e parti. È la cosa più importante.
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:10px;">
              <a class="btn" target="_blank" rel="noopener" href="${mapsDirUrl(origin.lat, origin.lon, lat, lon)}">🧭 NAVIGA</a>
              ${bookable ? `<a class="btn" target="_blank" rel="noopener" href="${ticketsUrl(p, category)}">🎟️ Prenota / Biglietti</a>` : ``}
            </div>
          </div>

          <!-- STEP 4 -->
          <div style="margin-top:12px; padding:12px; border-radius:16px; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.08);">
            <div style="font-weight:950;">4) Organizza</div>
            <div class="small muted" style="margin-top:6px; line-height:1.45;">
              Una volta deciso: mangiare e (se serve) dormire vicino.
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:10px;">
              <a class="btn btn-ghost" target="_blank" rel="noopener" href="${restaurantsUrl(name, areaLabel, lat, lon)}">🍝 Mangia vicino</a>
              <a class="btn btn-ghost" target="_blank" rel="noopener" href="${hotelsNearUrl(p)}">🏨 Hotel vicino</a>
            </div>

            <details style="margin-top:12px;">
              <summary style="cursor:pointer; font-weight:850; opacity:.92;">Altri link</summary>
              <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:10px;">
                <a class="btn btn-ghost" target="_blank" rel="noopener" href="${mapsPlaceUrl(lat, lon, name)}">📍 Luogo</a>
                <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleImagesUrl(name, areaLabel)}">📸 Foto</a>
                <a class="btn btn-ghost" target="_blank" rel="noopener" href="${googleInfoUrl(name, areaLabel)}">ℹ️ Cos’è</a>
              </div>
            </details>
          </div>

          <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px;">
            <button class="btn btn-ghost" id="btnVisited">✅ Già visitato</button>
            <button class="btn" id="btnChange">🔁 Cambia meta</button>
            <button class="btn btn-ghost" id="btnResetRotation">🧽 Reset “oggi”</button>
          </div>

          ${renderOptionsList(topList, c.pid, category)}
        </div>
      </div>
    `;

    // bookkeeping
    LAST_SHOWN_PID = c.pid;
    SESSION_SEEN.add(c.pid);
    addRecent(c.pid);

    // bindings
    $("btnCopyCoords")?.addEventListener("click", () => {
      const ok = copyToClipboard(coordsText);
      showStatus(ok ? "ok" : "warn", ok ? "Coordinate copiate ✅" : "Non riesco a copiare: copia manualmente.");
    });

    $("btnVisited")?.addEventListener("click", () => { markVisited(c.pid); showStatus("ok", "Segnato come visitato ✅"); });
    $("btnChange")?.addEventListener("click", () => { runSearch({ silent: true, forbidPid: c.pid }); });
    $("btnResetRotation")?.addEventListener("click", () => { resetRotation(); showStatus("ok", "Reset fatto ✅"); runSearch({ silent: true }); });

    // click options
    $("topOptions")?.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-pid]");
      if (!b) return;
      const newPid = b.getAttribute("data-pid");
      if (!newPid) return;
      renderResult(origin, maxMinutesShown, topList, meta, newPid);
      $("resultCard")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
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

      let topList = [];
      let usedMinutes = steps[0];

      for (const mins of steps) {
        usedMinutes = mins;
        const picked = pickTop(basePool, origin, mins, category, styles, 5);
        topList = picked.list || [];

        if (forbidPid && topList.length) topList = topList.filter(x => x.pid !== forbidPid);

        if (topList.length) break;
        if (token !== SEARCH_TOKEN) return;
      }

      if (token !== SEARCH_TOKEN) return;

      if (!topList.length && LIVE_ENABLED) {
        // intentionally disabled
      }

      renderResult(origin, maxMinutesInput, topList, { category, datasetInfo, usedMinutes, liveUsed:false });

      if (!topList.length) showStatus("warn", `Nessuna meta entro ${maxMinutesInput} min per "${category}". Aumenta minuti o cambia categoria.`);
      else if (!silent) showStatus("ok", `Trovate ${topList.length} opzioni ✅ • categoria: ${category}`);

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
          setOrigin({ label: o.label, lat: o.lat, lon: o.lon, country_code: o.country_code || "" });
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
        setOrigin({ label: result.label || label, lat: result.lat, lon: result.lon, country_code: result.country_code || "" });

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
    $("btnResetVisited")?.addEventListener("click", () => { resetVisited(); showStatus("ok", "Visitati resettati ✅"); });
  }

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
      try { const origin = getOrigin(); if (origin) await ensureDatasetLoaded(origin, { signal: undefined }); }
      catch {}
    })();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();

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
