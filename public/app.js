/* app.js — Jamo (REGION-OFFLINE FIRST) — v5.2 FULL
   - REGION offline first: /data/pois/regions/<region_id>.json
   - LIVE (Overpass) second: /api/destinations?lat&lon&radiusKm&cat
   - MACRO fallback: /data/macros/euk_country_<cc>.json
   - Robust: never crash if DOM IDs differ
   - Weekly rotation + avoid visited
*/

(() => {
  "use strict";

  // -----------------------------
  // Helpers
  // -----------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function asNum(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
  function normStr(s) { return String(s || "").trim(); }
  function lower(s) { return normStr(s).toLowerCase(); }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function safeSetText(el, txt) { if (el) el.textContent = String(txt ?? ""); }
  function safeSetHTML(el, html) { if (el) el.innerHTML = String(html ?? ""); }

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

  // -----------------------------
  // Weekly rotation RNG
  // -----------------------------
  function weekKeyUTC() {
    const d = new Date();
    const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const day = new Date(t).getUTCDay() || 7; // 1..7
    const thursday = new Date(t + (4 - day) * 86400000);
    const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
    const week = Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7);
    return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }

  function hashStringToSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // -----------------------------
  // Fetch JSON (timeout)
  // -----------------------------
  async function fetchJson(url, { timeoutMs = 12000 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  // -----------------------------
  // Storage: visited
  // -----------------------------
  const VISITED_KEY = "jamo_visited_ids_v1";

  function getVisitedSet() {
    try {
      const raw = localStorage.getItem(VISITED_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  }
  function saveVisitedSet(set) {
    try {
      localStorage.setItem(VISITED_KEY, JSON.stringify(Array.from(set).slice(0, 5000)));
    } catch {}
  }
  function markVisited(id) {
    const s = getVisitedSet();
    s.add(String(id));
    saveVisitedSet(s);
  }
  function resetVisited() {
    try { localStorage.removeItem(VISITED_KEY); } catch {}
  }

  // -----------------------------
  // Categories
  // -----------------------------
  const UI_CATS = new Set([
    "ovunque", "family", "parchi",
    "relax", "natura", "storia",
    "mare", "borghi", "citta", "montagna"
  ]);

  const FAMILY_TYPES = new Set([
    "family", "theme_park", "kids_museum", "playground", "water_park",
    "zoo", "aquarium", "ice_rink", "adventure_park", "snow_family",
    "cinema", "bowling"
  ]);

  function normCat(c) {
    const s = lower(c || "ovunque");
    return UI_CATS.has(s) ? s : "ovunque";
  }

  function placeTypeCandidates(p) {
    const out = [];
    if (!p || typeof p !== "object") return out;
    if (p.type) out.push(String(p.type));
    if (p.primary_category) out.push(String(p.primary_category));
    if (p.subtype) out.push(String(p.subtype));
    if (Array.isArray(p.types)) out.push(...p.types.map(String));
    return out.map(lower).filter(Boolean);
  }

  function categoryMatches(place, cat) {
    const c = normCat(cat);
    if (c === "ovunque") return true;

    const types = new Set(placeTypeCandidates(place));
    const tags = Array.isArray(place?.tags) ? place.tags.join(" ").toLowerCase() : "";
    const name = lower(place?.name);

    if (c === "family" || c === "parchi") {
      for (const t of types) if (FAMILY_TYPES.has(t)) return true;

      // tag-based inference
      if (tags.includes("tourism=theme_park")) return true;
      if (tags.includes("leisure=water_park")) return true;
      if (tags.includes("leisure=playground")) return true;
      if (tags.includes("tourism=zoo") || tags.includes("tourism=aquarium")) return true;

      // exclude spa/terme
      if (tags.includes("amenity=spa") || tags.includes("leisure=spa") || tags.includes("natural=hot_spring") || tags.includes("thermal=yes")) return false;
      if (name.includes("terme") || name.includes("spa") || name.includes("thermal") || name.includes("benessere")) return false;

      return false;
    }

    if (c === "montagna") {
      if (types.has("montagna")) return true;
      if (tags.includes("natural=peak") || tags.includes("aerialway=")) return true;
      if (name.includes("rifugio") || name.includes("cima") || name.includes("vetta") || name.includes("passo") || name.includes("funivia") || name.includes("seggiovia")) return true;
      return false;
    }

    if (types.has(c)) return true;

    if (c === "borghi" && (types.has("borgo") || tags.includes("place=village") || tags.includes("place=hamlet"))) return true;

    return false;
  }

  // -----------------------------
  // Normalize place (multi-dataset)
  // -----------------------------
  function normalizePlace(raw) {
    if (!raw || typeof raw !== "object") return null;

    const name = normStr(raw.name || raw.title || raw.label);
    const lat = asNum(raw.lat ?? raw.latitude);
    const lon = asNum(raw.lon ?? raw.lng ?? raw.longitude);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const id = normStr(raw.id || raw._id || `${name}_${lat.toFixed(5)}_${lon.toFixed(5)}`);

    const type = normStr(
      raw.type ||
      raw.primary_category ||
      (Array.isArray(raw.types) ? raw.types[0] : "ovunque")
    ) || "ovunque";

    const visibility = normStr(raw.visibility || raw.level || "classica");
    const beauty_score = asNum(raw.beauty_score) ?? 0.7;

    const tags =
      Array.isArray(raw.tags) ? raw.tags.map(String) :
      Array.isArray(raw.tagList) ? raw.tagList.map(String) :
      [];

    return {
      id,
      name,
      lat,
      lon,
      type: lower(type),
      primary_category: lower(raw.primary_category || type),
      subtype: lower(raw.subtype || ""),
      visibility: lower(visibility),
      beauty_score: clamp(beauty_score, 0, 1),
      tags,
      live: Boolean(raw.live),
      source: normStr(raw.source || raw.dataset || ""),
      _km: asNum(raw._km),
      _score: asNum(raw._score),
      _raw: raw
    };
  }

  // -----------------------------
  // Region detect via areas.json bbox
  // -----------------------------
  function pointInBbox(lat, lon, bbox) {
    if (!bbox || typeof bbox !== "object") return false;
    const minLat = asNum(bbox.min_lat ?? bbox.minLat ?? bbox.south ?? bbox.minlat);
    const maxLat = asNum(bbox.max_lat ?? bbox.maxLat ?? bbox.north ?? bbox.maxlat);
    const minLon = asNum(bbox.min_lon ?? bbox.minLon ?? bbox.west ?? bbox.minlng ?? bbox.min_lng);
    const maxLon = asNum(bbox.max_lon ?? bbox.maxLon ?? bbox.east ?? bbox.maxlng ?? bbox.max_lng);
    if (![minLat, maxLat, minLon, maxLon].every(Number.isFinite)) return false;
    return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
  }

  async function detectRegionId(lat, lon) {
    try {
      const j = await fetchJson("/data/areas.json", { timeoutMs: 8000 });
      const regions = Array.isArray(j?.regions) ? j.regions : Array.isArray(j) ? j : [];
      const hits = regions.filter(r => pointInBbox(lat, lon, r.bbox || r.bbox_hint || r.bboxHint));
      if (!hits.length) return null;

      // Choose most specific by bbox area
      const scored = hits.map(r => {
        const b = r.bbox || r.bbox_hint || r.bboxHint || {};
        const minLat = asNum(b.min_lat ?? b.minLat ?? b.south);
        const maxLat = asNum(b.max_lat ?? b.maxLat ?? b.north);
        const minLon = asNum(b.min_lon ?? b.minLon ?? b.west);
        const maxLon = asNum(b.max_lon ?? b.maxLon ?? b.east);
        const area = (Number.isFinite(minLat) && Number.isFinite(maxLat) && Number.isFinite(minLon) && Number.isFinite(maxLon))
          ? Math.abs((maxLat - minLat) * (maxLon - minLon))
          : 999999;
        return { r, area };
      }).sort((a, b) => a.area - b.area);

      const preferIT = scored.find(x => String(x.r.id || x.r.region_id || "").startsWith("it-")) || scored[0];
      const rid = String(preferIT.r.id || preferIT.r.region_id || preferIT.r.regionId || "").trim();
      return rid || null;
    } catch {
      return null;
    }
  }

  function countryCodeFromRegionId(regionId) {
    const s = lower(regionId);
    const cc = s.split("-")[0];
    return (cc && cc.length === 2) ? cc : "it";
  }

  // -----------------------------
  // Load sources: REGION -> LIVE -> MACRO
  // -----------------------------
  async function loadRegionPlaces(regionId) {
    if (!regionId) return { ok: false, places: [], meta: { dataset: "" } };
    const url = `/data/pois/regions/${regionId}.json`;
    try {
      const j = await fetchJson(url, { timeoutMs: 12000 });
      const rawPlaces =
        Array.isArray(j?.places) ? j.places :
        Array.isArray(j?.data?.places) ? j.data.places :
        [];
      const places = rawPlaces.map(normalizePlace).filter(Boolean);
      return { ok: true, places, meta: { dataset: `REGION:${regionId}.json`, url, regionId, rawMeta: j?.meta || null } };
    } catch (e) {
      return { ok: false, places: [], meta: { dataset: "", error: String(e?.message || e), url, regionId } };
    }
  }

  async function loadLivePlaces({ lat, lon, radiusKm, cat }) {
    const c = normCat(cat);
    const rk = clamp(asNum(radiusKm) ?? 60, 5, 140);
    const url = `/api/destinations?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&radiusKm=${encodeURIComponent(rk)}&cat=${encodeURIComponent(c)}`;
    try {
      const j = await fetchJson(url, { timeoutMs: 22000 });
      const els = Array.isArray(j?.data?.elements) ? j.data.elements : [];
      const places = els.map(normalizePlace).filter(Boolean);
      return { ok: true, places, meta: { dataset: "LIVE:Overpass", url, rawMeta: j?.meta || null } };
    } catch (e) {
      return { ok: false, places: [], meta: { dataset: "", url, error: String(e?.message || e) } };
    }
  }

  async function loadMacroPlaces(countryCode = "it") {
    const cc = lower(countryCode);
    const url = `/data/macros/euk_country_${cc}.json`;
    try {
      const j = await fetchJson(url, { timeoutMs: 12000 });
      const rawPlaces =
        Array.isArray(j?.places) ? j.places :
        Array.isArray(j?.data?.places) ? j.data.places :
        [];
      const places = rawPlaces.map(normalizePlace).filter(Boolean);
      return { ok: true, places, meta: { dataset: `MACRO:euk_country_${cc}.json`, url } };
    } catch (e) {
      return { ok: false, places: [], meta: { dataset: "", url, error: String(e?.message || e) } };
    }
  }

  // -----------------------------
  // State
  // -----------------------------
  const state = {
    userLat: null,
    userLon: null,
    cat: "ovunque",
    radiusKm: 60,
    lastPick: null,
    lastDataset: "",
    lastMeta: null,
    regionId: null,
  };

  // -----------------------------
  // UI: read category & radius (robust)
  // -----------------------------
  function getCatFromUI() {
    const sel =
      $("#category") ||
      $("#cat") ||
      $("select[name='category']") ||
      $("select[data-role='category']");

    if (sel && sel.value) return normCat(sel.value);

    const activeBtn = $("[data-cat].active") || $("[data-category].active");
    if (activeBtn) return normCat(activeBtn.dataset.cat || activeBtn.dataset.category);

    return state.cat || "ovunque";
  }

  function getRadiusFromUI() {
    const inp =
      $("#radiusKm") ||
      $("#radius") ||
      $("input[name='radiusKm']") ||
      $("input[data-role='radius']");

    if (inp && inp.value != null) {
      const v = asNum(inp.value);
      if (Number.isFinite(v)) return clamp(v, 5, 140);
    }
    return state.radiusKm || 60;
  }

  function setStatusLine({ found = null, minutes = null, cat = null, dataset = null } = {}) {
    const el =
      $("#statusLine") ||
      $("#status") ||
      $("[data-role='status']") ||
      $("[data-ui='status']");

    if (!el) return;

    const parts = [];
    if (found === true) parts.push("Meta trovata ✅");
    if (found === false) parts.push("Nessuna meta ❌");
    if (minutes != null) parts.push(`(~${minutes} min)`);
    if (cat) parts.push(`categoria: ${cat}`);
    if (dataset) parts.push(`${dataset}`);
    safeSetText(el, parts.join(" • "));
  }

  // -----------------------------
  // Actions (buttons)
  // -----------------------------
  function openMaps(p) {
    const q = encodeURIComponent(`${p.name}`);
    const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.lat + "," + p.lon)}(${q})`;
    window.open(url, "_blank");
  }
  function openRoute(p) {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(p.lat + "," + p.lon)}&travelmode=driving`;
    window.open(url, "_blank");
  }
  function openPhoto(p) {
    const q = encodeURIComponent(p.name);
    window.open(`https://www.google.com/search?tbm=isch&q=${q}`, "_blank");
  }
  function openThingsToSee(p) {
    const q = encodeURIComponent(`${p.name} cosa vedere`);
    window.open(`https://www.google.com/search?q=${q}`, "_blank");
  }
  function openThingsToDo(p) {
    const q = encodeURIComponent(`${p.name} cosa fare`);
    window.open(`https://www.google.com/search?q=${q}`, "_blank");
  }

  // -----------------------------
  // Render result card (self-contained)
  // -----------------------------
  function renderResultCard(place, datasetLabel) {
    const container =
      $("#result") ||
      $("#resultCard") ||
      $("[data-role='result']") ||
      $("[data-ui='result']");

    if (!container) return;

    if (!place) {
      safeSetHTML(container, `<div style="padding:12px">Nessuna meta trovata.</div>`);
      return;
    }

    const km =
      Number.isFinite(place._km) ? place._km :
      (Number.isFinite(state.userLat) ? haversineKm(state.userLat, state.userLon, place.lat, place.lon) : null);

    const minutes = km != null ? Math.round(km * 1.15) : null;

    const visLabel =
      place.visibility === "conosciuta" ? "conosciuta" :
      place.visibility === "chicca" ? "chicca" : "classica";

    const catLabel = state.cat || "ovunque";
    const datasetLine = datasetLabel ? `Dataset: ${datasetLabel}` : "";
    const scoreLine = (place._score != null) ? ` • score: ${place._score}` : "";

    safeSetHTML(container, `
      <div class="jamo-card">
        <div class="jamo-card-top">
          <div class="jamo-pill">${escapeHtml(catLabel)}</div>
          ${minutes != null ? `<div class="jamo-pill">🚗 ~${minutes} min • ${Number(km).toFixed(0)} km</div>` : ""}
          <div class="jamo-pill">✨ ${escapeHtml(visLabel)}</div>
        </div>

        <h2 class="jamo-title">${escapeHtml(place.name)}</h2>
        <div class="jamo-sub">${escapeHtml(datasetLine)}${escapeHtml(scoreLine)}</div>

        <div class="jamo-actions" style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
          <button type="button" class="jamo-btn" data-action="maps">🗺️ Maps</button>
          <button type="button" class="jamo-btn" data-action="route">🚗 Percorso</button>
          <button type="button" class="jamo-btn" data-action="photo">📸 Foto</button>
          <button type="button" class="jamo-btn" data-action="see">👀 Cosa vedere</button>
          <button type="button" class="jamo-btn" data-action="do">🎯 Cosa fare</button>
        </div>
      </div>
    `);

    // Bind buttons inside card
    $$(".jamo-btn", container).forEach(btn => {
      btn.addEventListener("click", () => {
        const a = btn.dataset.action;
        if (a === "maps") openMaps(place);
        if (a === "route") openRoute(place);
        if (a === "photo") openPhoto(place);
        if (a === "see") openThingsToSee(place);
        if (a === "do") openThingsToDo(place);
      }, { passive: true });
    });

    setStatusLine({ found: true, minutes, cat: catLabel, dataset: datasetLabel });
  }

  // -----------------------------
  // Pick logic (weekly rotation + avoid visited)
  // -----------------------------
  function pickPlace(places, { cat, lat, lon, datasetLabel } = {}) {
    const visited = getVisitedSet();
    const c = normCat(cat);

    // Filter by category
    const filtered = places.filter(p => categoryMatches(p, c));

    // Enrich with distance + score
    const enriched = filtered.map(p => {
      const km = (Number.isFinite(lat) && Number.isFinite(lon))
        ? haversineKm(lat, lon, p.lat, p.lon)
        : null;

      let s = (p.beauty_score ?? 0.7) * 1.8;
      if (km != null) s += clamp(1.6 - (km / 60), -0.6, 1.6);

      if (p.visibility === "conosciuta") s += 0.25;
      if (p.visibility === "chicca") s += 0.35;

      const tags = Array.isArray(p.tags) ? p.tags.join(" ").toLowerCase() : "";
      if (tags.includes("place=")) s -= 0.6; // avoid generic cities

      return { ...p, _km: km != null ? Number(km.toFixed(3)) : p._km, _pickScore: Number(s.toFixed(4)) };
    });

    enriched.sort((a, b) => (b._pickScore - a._pickScore) || ((a._km ?? 9999) - (b._km ?? 9999)));

    const pool = enriched.slice(0, 220);
    const unvisited = pool.filter(p => !visited.has(String(p.id)));
    const finalPool = unvisited.length >= 20 ? unvisited : pool;

    if (!finalPool.length) return null;

    const wk = weekKeyUTC();
    const seedStr = `${wk}|${datasetLabel}|${c}|${Math.round((lat ?? 0) * 100)}|${Math.round((lon ?? 0) * 100)}`;
    const rng = mulberry32(hashStringToSeed(seedStr));

    const top = finalPool.slice(0, Math.min(35, finalPool.length));
    const idx = Math.floor(rng() * top.length);
    return top[idx] || top[0] || null;
  }

  // -----------------------------
  // Location
  // -----------------------------
  async function getUserLocation() {
    if (Number.isFinite(state.userLat) && Number.isFinite(state.userLon)) {
      return { lat: state.userLat, lon: state.userLon };
    }

    // Try preset values
    const latEl = $("#userLat") || $("[data-user-lat]");
    const lonEl = $("#userLon") || $("[data-user-lon]");
    const preLat = asNum(latEl?.value ?? latEl?.dataset?.userLat);
    const preLon = asNum(lonEl?.value ?? lonEl?.dataset?.userLon);
    if (Number.isFinite(preLat) && Number.isFinite(preLon)) {
      state.userLat = preLat;
      state.userLon = preLon;
      return { lat: preLat, lon: preLon };
    }

    // Geolocation
    return await new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("Geolocation not supported"));
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = pos?.coords?.latitude;
          const lon = pos?.coords?.longitude;
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return reject(new Error("Bad coords"));
          state.userLat = lat;
          state.userLon = lon;
          resolve({ lat, lon });
        },
        (err) => reject(err || new Error("Geolocation denied")),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
      );
    });
  }

  // -----------------------------
  // Main: find destination
  // -----------------------------
  async function findDestination() {
    try {
      const cat = getCatFromUI();
      const radiusKm = getRadiusFromUI();
      state.cat = cat;
      state.radiusKm = radiusKm;

      setStatusLine({ found: null, minutes: null, cat, dataset: "carico dati…" });

      const { lat, lon } = await getUserLocation();

      // detect region once
      if (!state.regionId) {
        state.regionId = await detectRegionId(lat, lon);
      }

      // 1) REGION FIRST
      if (state.regionId) {
        const regionRes = await loadRegionPlaces(state.regionId);
        if (regionRes.ok && regionRes.places.length) {
          const pick = pickPlace(regionRes.places, { cat, lat, lon, datasetLabel: regionRes.meta.dataset });
          if (pick) {
            state.lastPick = pick;
            state.lastDataset = regionRes.meta.dataset;
            state.lastMeta = regionRes.meta;
            markVisited(pick.id);
            renderResultCard(pick, regionRes.meta.dataset);
            return;
          }
        }
      }

      // 2) LIVE SECOND (online)
      const liveRes = await loadLivePlaces({ lat, lon, radiusKm, cat });
      if (liveRes.ok && liveRes.places.length) {
        const pick = pickPlace(liveRes.places, { cat, lat, lon, datasetLabel: liveRes.meta.dataset });
        if (pick) {
          state.lastPick = pick;
          state.lastDataset = liveRes.meta.dataset;
          state.lastMeta = liveRes.meta;
          markVisited(pick.id);
          renderResultCard(pick, liveRes.meta.dataset);
          return;
        }
      }

      // 3) MACRO fallback
      const cc = state.regionId ? countryCodeFromRegionId(state.regionId) : "it";
      const macroRes = await loadMacroPlaces(cc);
      if (macroRes.ok && macroRes.places.length) {
        const pick = pickPlace(macroRes.places, { cat, lat, lon, datasetLabel: macroRes.meta.dataset });
        if (pick) {
          state.lastPick = pick;
          state.lastDataset = macroRes.meta.dataset;
          state.lastMeta = macroRes.meta;
          markVisited(pick.id);
          renderResultCard(pick, macroRes.meta.dataset);
          return;
        }
      }

      // nothing
      setStatusLine({ found: false, minutes: null, cat, dataset: "nessun dataset utile" });
      renderResultCard(null, "");
    } catch (e) {
      console.error("[Jamo] findDestination error:", e);
      setStatusLine({ found: false, minutes: null, cat: state.cat || "ovunque", dataset: "errore" });

      const container =
        $("#result") ||
        $("#resultCard") ||
        $("[data-role='result']") ||
        $("[data-ui='result']");

      if (container) safeSetHTML(container, `<div style="padding:12px">Errore: ${escapeHtml(String(e?.message || e))}</div>`);
    }
  }

  // -----------------------------
  // Bind UI (robust)
  // -----------------------------
  function bindUI() {
    // Find button
    const btnFind =
      $("#btnFind") ||
      $("#findBtn") ||
      $("#trovaMeta") ||
      $("[data-action='find']") ||
      $("[data-ui='find']");

    // Reset visited
    const btnReset =
      $("#btnResetVisited") ||
      $("#resetVisited") ||
      $("[data-action='resetVisited']") ||
      $("[data-ui='resetVisited']");

    if (btnFind) {
      btnFind.addEventListener("click", (ev) => {
        ev.preventDefault();
        findDestination();
      }, { passive: false });
    }

    if (btnReset) {
      btnReset.addEventListener("click", (ev) => {
        ev.preventDefault();
        resetVisited();
        setStatusLine({ found: null, minutes: null, cat: state.cat || "ovunque", dataset: "visitati resettati" });
      }, { passive: false });
    }

    // Category buttons
    $$("[data-cat], [data-category]").forEach(btn => {
      btn.addEventListener("click", () => {
        const c = normCat(btn.dataset.cat || btn.dataset.category);
        state.cat = c;
        $$("[data-cat].active,[data-category].active").forEach(x => x.classList.remove("active"));
        btn.classList.add("active");
      }, { passive: true });
    });

    // Category select
    const sel =
      $("#category") ||
      $("#cat") ||
      $("select[name='category']") ||
      $("select[data-role='category']");
    if (sel) {
      sel.addEventListener("change", () => {
        state.cat = normCat(sel.value);
      }, { passive: true });
    }

    // Radius input
    const rad =
      $("#radiusKm") ||
      $("#radius") ||
      $("input[name='radiusKm']") ||
      $("input[data-role='radius']");
    if (rad) {
      rad.addEventListener("change", () => {
        const v = asNum(rad.value);
        if (Number.isFinite(v)) state.radiusKm = clamp(v, 5, 140);
      }, { passive: true });
    }

    // Expose functions for inline HTML onclick (if present)
    window.Jamo = window.Jamo || {};
    window.Jamo.findDestination = findDestination;
    window.Jamo.resetVisited = () => { resetVisited(); setStatusLine({ dataset: "visitati resettati" }); };
    window.Jamo.openMaps = () => state.lastPick && openMaps(state.lastPick);
    window.Jamo.openRoute = () => state.lastPick && openRoute(state.lastPick);
    window.Jamo.openPhoto = () => state.lastPick && openPhoto(state.lastPick);
    window.Jamo.openThingsToSee = () => state.lastPick && openThingsToSee(state.lastPick);
    window.Jamo.openThingsToDo = () => state.lastPick && openThingsToDo(state.lastPick);

    // Legacy aliases
    window.findDestination = findDestination;
    window.resetVisited = () => { resetVisited(); setStatusLine({ dataset: "visitati resettati" }); };
  }

  // -----------------------------
  // Boot
  // -----------------------------
  document.addEventListener("DOMContentLoaded", () => {
    try {
      bindUI();
      setStatusLine({ found: null, minutes: null, cat: state.cat, dataset: "pronto" });
    } catch (e) {
      console.error("[Jamo] boot error:", e);
    }
  });

})();
