/* Jamo — app.js (MONETIZABLE ONLY, CLICK-SAFE)
 * ✅ SOLO POI turistici monetizzabili
 * ✅ OFFLINE datasets /public/data/...
 * ✅ Region-first (IT bbox) + fallback macro
 * ✅ CLICK FIX: event delegation + pointer-events hardening
 */

(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // -------------------- CONFIG --------------------
  const CFG = {
    ROAD_FACTOR: 1.25,
    AVG_KMH: 72,
    FIXED_OVERHEAD_MIN: 8,

    IT_REGIONS_INDEX_URL: "/data/pois/regions/it-regions-index.json",
    MACROS_INDEX_URL: "/data/macros/macros_index.json",
    FALLBACK_MACRO_URLS: [
      "/data/macros/euuk_country_it.json",
      "/data/macros/euuk_macro_all.json",
    ],

    AFFILIATE: {
      BOOKING_AID: "",
      GYG_PARTNER_ID: "",
      THEFORK_AFFID: "",
    },

    MIN_SCORE: 0.55,
    MAX_RESULTS: 30,
  };

  // -------------------- CLICK HARDENING CSS --------------------
  function injectClickSafeCssOnce() {
    if (document.getElementById("jamo-clicksafe-css")) return;
    const st = document.createElement("style");
    st.id = "jamo-clicksafe-css";
    st.textContent = `
      /* Ensure clicks reach buttons */
      #resultArea, #resultArea * { -webkit-tap-highlight-color: transparent; }
      #resultArea button { pointer-events: auto !important; }
      #resultArea .card { position: relative; }
      /* If any overlay exists inside cards, prevent it from stealing taps */
      #resultArea .card::before,
      #resultArea .card::after { pointer-events: none !important; }
    `;
    document.head.appendChild(st);
  }

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

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
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

  function withinBBox(lat, lon, bbox) {
    if (!bbox) return false;
    return lat >= bbox.minLat && lat <= bbox.maxLat && lon >= bbox.minLon && lon <= bbox.maxLon;
  }

  // -------------------- LINKS --------------------
  function mapsDirUrl(oLat, oLon, dLat, dLon) {
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
      oLat + "," + oLon
    )}&destination=${encodeURIComponent(dLat + "," + dLon)}&travelmode=driving`;
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
    return `https://www.booking.com/searchresults.it.html?aid=${encodeURIComponent(aid)}&ss=${encodeURIComponent(
      `${name} ${area || ""}`
    )}`;
  }

  function gygSearchUrl(name, area) {
    const pid = CFG.AFFILIATE.GYG_PARTNER_ID?.trim();
    if (!pid) return googleSearchUrl(`${stableQuery(name, area)} biglietti prenota tour`);
    return `https://www.getyourguide.com/s/?partner_id=${encodeURIComponent(pid)}&q=${encodeURIComponent(
      `${name} ${area || ""}`
    )}`;
  }

  function foodSearchUrl(name, area, lat, lon) {
    const q = `ristoranti vicino ${name} ${area || ""}`.trim();
    const aff = CFG.AFFILIATE.THEFORK_AFFID?.trim();
    if (!aff) {
      return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}&center=${encodeURIComponent(
        lat + "," + lon
      )}`;
    }
    return googleSearchUrl(q);
  }

  // -------------------- FETCH JSON --------------------
  async function fetchJson(url, { signal } = {}) {
    const r = await fetch(url, { cache: "no-store", signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
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

  // -------------------- NORMALIZATION --------------------
  function normalizePlace(p) {
    if (!p) return null;
    const lat = Number(p.lat);
    const lon = Number(p.lon ?? p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const out = { ...p };
    out.lat = lat;
    out.lon = lon;
    out.name = String(out.name || "").trim();
    out.country = String(out.country || "").toUpperCase();
    out.area = String(out.area || "");
    out.tags = Array.isArray(out.tags) ? out.tags.map((x) => String(x).toLowerCase()) : [];
    return out;
  }

  function tagsStr(place) {
    return (place?.tags || []).map((t) => String(t).toLowerCase()).join(" ");
  }

  function hasAny(str, arr) {
    for (const k of arr) if (str.includes(k)) return true;
    return false;
  }

  function hasQualitySignals(place) {
    const t = tagsStr(place);
    return (
      t.includes("wikipedia=") ||
      t.includes("wikidata=") ||
      t.includes("website=") ||
      t.includes("opening_hours=") ||
      t.includes("contact:website=")
    );
  }

  // -------------------- IRRELEVANT FILTER --------------------
  function isClearlyIrrelevantPlace(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");

    if (hasAny(t, ["highway=", "railway=", "public_transport=", "route=", "junction="])) return true;
    if (hasAny(t, ["amenity=bus_station", "highway=bus_stop", "highway=platform"])) return true;

    if (hasAny(t, ["amenity=parking", "amenity=parking_entrance", "amenity=fuel", "amenity=charging_station", "highway=rest_area"])) return true;

    if (hasAny(t, ["landuse=industrial", "landuse=commercial", "building=industrial", "building=warehouse", "man_made=works"])) return true;

    if (hasAny(t, ["power=", "telecom=", "pipeline=", "man_made=survey_point"])) return true;

    if (hasAny(n, ["parcheggio", "stazione", "fermata", "svincolo", "uscita", "km "])) return true;

    return false;
  }

  // -------------------- MONETIZABLE GATE --------------------
  function isSpa(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    return (
      t.includes("amenity=spa") || t.includes("leisure=spa") || t.includes("tourism=spa") ||
      t.includes("natural=hot_spring") || t.includes("amenity=public_bath") ||
      t.includes("bath:type=thermal") || t.includes("thermal") || t.includes("terme") ||
      hasAny(n, ["terme", "termale", "thermal", "spa", "wellness", "benessere", "hammam", "sauna"])
    );
  }

  function isWinery(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");
    return (
      t.includes("craft=winery") || t.includes("shop=wine") || t.includes("amenity=wine_bar") ||
      hasAny(n, ["cantina", "winery", "vino", "vini", "enoteca", "degustaz", "wine tasting", "wine tour"])
    );
  }

  function isTicketAttraction(place) {
    const t = tagsStr(place);
    const n = normName(place?.name || "");

    const strong =
      t.includes("tourism=attraction") ||
      t.includes("tourism=museum") ||
      t.includes("tourism=gallery") ||
      t.includes("tourism=viewpoint") ||
      t.includes("tourism=theme_park") ||
      t.includes("tourism=zoo") ||
      t.includes("tourism=aquarium") ||
      t.includes("historic=castle") ||
      t.includes("historic=fort") ||
      t.includes("historic=archaeological_site") ||
      t.includes("historic=ruins") ||
      t.includes("historic=monument") ||
      t.includes("historic=memorial") ||
      t.includes("historic=palace") ||
      t.includes("heritage=");

    if (strong) return true;

    const quality = hasQualitySignals(place);
    if (!quality) return false;

    return hasAny(n, [
      "castell", "abbazi", "duomo", "cattedral", "museo", "teatro",
      "belvedere", "panorama", "gole", "cascat", "parco", "riserva",
      "oasi", "lago", "santuar", "tempio"
    ]);
  }

  function isStay(place) {
    const t = tagsStr(place);
    return (
      t.includes("tourism=hotel") || t.includes("tourism=hostel") || t.includes("tourism=guest_house") ||
      t.includes("tourism=apartment") || t.includes("tourism=camp_site") || t.includes("tourism=caravan_site") ||
      t.includes("tourism=chalet") || t.includes("tourism=motel") || t.includes("tourism=resort")
    );
  }

  function isFood(place) {
    const t = tagsStr(place);
    return (
      t.includes("amenity=restaurant") || t.includes("amenity=fast_food") || t.includes("amenity=cafe") ||
      t.includes("amenity=bar") || t.includes("amenity=pub") || t.includes("amenity=ice_cream")
    );
  }

  function isMonetizableTouristic(place) {
    if (!place?.name || place.name.length < 2) return false;
    if (isClearlyIrrelevantPlace(place)) return false;

    const n = normName(place?.name || "");
    if (hasAny(n, ["spazio espositivo", "centro espositivo", "lanificio", "opificio", "fabbrica", "ex "])) {
      const t = tagsStr(place);
      const ok = t.includes("tourism=museum") || t.includes("tourism=attraction");
      if (!ok) return false;
    }

    return isTicketAttraction(place) || isSpa(place) || isWinery(place) || isStay(place) || isFood(place);
  }

  function monetizationKind(place) {
    if (isTicketAttraction(place) || isWinery(place)) return "ticket";
    if (isSpa(place) || isStay(place)) return "stay";
    if (isFood(place)) return "food";
    return "ticket";
  }

  // -------------------- SCORING --------------------
  function scorePlace({ driveMin, targetMin, place }) {
    const t = clamp(1 - Math.abs(driveMin - targetMin) / Math.max(20, targetMin * 0.9), 0, 1);

    let bonus = 0;
    const ts = tagsStr(place);

    if (hasQualitySignals(place)) bonus += 0.10;
    if (ts.includes("wikipedia=") || ts.includes("wikidata=")) bonus += 0.08;

    if (isTicketAttraction(place)) bonus += 0.18;
    if (isSpa(place)) bonus += 0.14;
    if (isWinery(place)) bonus += 0.14;
    if (isStay(place)) bonus += 0.10;
    if (isFood(place)) bonus += 0.06;

    return Number((0.70 * t + bonus).toFixed(4));
  }

  // -------------------- DATASET INDEXES --------------------
  let IT_REGIONS_INDEX = null;
  let MACROS_INDEX = null;

  async function loadItalyRegionsIndexSafe(signal) {
    if (IT_REGIONS_INDEX?.items?.length) return IT_REGIONS_INDEX;
    try { IT_REGIONS_INDEX = await fetchJson(CFG.IT_REGIONS_INDEX_URL, { signal }); }
    catch { IT_REGIONS_INDEX = null; }
    return IT_REGIONS_INDEX;
  }

  async function loadMacrosIndexSafe(signal) {
    if (MACROS_INDEX?.items?.length) return MACROS_INDEX;
    try { MACROS_INDEX = await fetchJson(CFG.MACROS_INDEX_URL, { signal }); }
    catch { MACROS_INDEX = null; }
    return MACROS_INDEX;
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

  async function loadPoolsRegionFirst(origin, { signal } = {}) {
    await loadItalyRegionsIndexSafe(signal);
    await loadMacrosIndexSafe(signal);

    const cc = String(origin?.country_code || "").toUpperCase();
    const region = pickItalyRegionByOrigin(origin);
    const isItaly = (cc === "IT") || !!region;

    const pools = [];

    if (isItaly && region?.id) {
      const rid = String(region.id);
      const p2 = region.paths?.core || `/data/pois/regions/${rid}.json`;
      const loaded = await tryLoadPlacesFile(p2, signal);
      if (loaded) pools.push({ kind: "region", source: p2, places: loaded.places, bbox: region.bbox || null });
    }

    const countryMacro = findCountryMacroPathRobust(cc || (isItaly ? "IT" : ""));
    const macroUrls = [];
    if (countryMacro) macroUrls.push(countryMacro);
    for (const u of CFG.FALLBACK_MACRO_URLS) macroUrls.push(u);

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
      break;
    }

    if (!pools.length) throw new Error("Nessun dataset offline valido disponibile.");
    return { pools, region };
  }

  // -------------------- ORIGIN --------------------
  function setOrigin({ label, lat, lon, country_code }) {
    $("originLabel") && ($("originLabel").value = label ?? "");
    $("originLat") && ($("originLat").value = String(lat));
    $("originLon") && ($("originLon").value = String(lon));
    $("originCC") && ($("originCC").value = String(country_code || "").toUpperCase());
    localStorage.setItem("jamo_origin", JSON.stringify({
      label, lat, lon, country_code: String(country_code || "").toUpperCase()
    }));
    if ($("originStatus")) {
      $("originStatus").textContent =
        `✅ Partenza: ${label || "posizione"} (${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)})`;
    }
  }

  function getOrigin() {
    const lat = Number($("originLat")?.value);
    const lon = Number($("originLon")?.value);
    const label = ($("originLabel")?.value || "").trim();
    const ccDom = String($("originCC")?.value || "").toUpperCase();

    if (Number.isFinite(lat) && Number.isFinite(lon)) return { label, lat, lon, country_code: ccDom };

    const raw = localStorage.getItem("jamo_origin");
    if (!raw) return null;
    try {
      const o = JSON.parse(raw);
      if (Number.isFinite(Number(o?.lat)) && Number.isFinite(Number(o?.lon))) {
        return { label: String(o.label || ""), lat: Number(o.lat), lon: Number(o.lon), country_code: String(o.country_code || "").toUpperCase() };
      }
    } catch {}
    return null;
  }

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

  // -------------------- SEARCH --------------------
  function buildCandidates(places, origin, maxMinutes) {
    const oLat = Number(origin.lat);
    const oLon = Number(origin.lon);
    const target = clamp(Number(maxMinutes) || 120, 10, 600);

    const out = [];
    for (const raw of places) {
      const p = normalizePlace(raw);
      if (!p) continue;

      if (!isMonetizableTouristic(p)) continue;

      const km = haversineKm(oLat, oLon, p.lat, p.lon);
      const driveMin = estCarMinutesFromKm(km);
      if (!Number.isFinite(driveMin) || driveMin > target) continue;
      if (km < 1.2) continue;

      const score = scorePlace({ driveMin, targetMin: target, place: p });
      if (score < CFG.MIN_SCORE) continue;

      out.push({ place: p, pid: safeIdFromPlace(p), km, driveMin, score });
    }

    out.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));
    return out.slice(0, CFG.MAX_RESULTS);
  }

  function renderResults(origin, region, list, datasetLabel) {
    const area = $("resultArea");
    if (!area) return;

    if (!list.length) {
      area.innerHTML = `
        <div class="card" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
          <div style="font-weight:950;">❌ Nessun luogo monetizzabile trovato nei minuti scelti.</div>
          <div class="small muted" style="margin-top:8px;">Aumenta i minuti o cambia partenza.</div>
          <div class="small muted" style="margin-top:10px;">Dataset: ${escapeHtml(datasetLabel || "offline")}</div>
        </div>
      `;
      return;
    }

    const reg = region?.name ? ` • regione: ${escapeHtml(region.name)}` : "";

    const items = list.map((x) => {
      const p = x.place;
      const name = escapeHtml(p.name || "");
      const areaLabel = escapeHtml((p.area || p.country || "—").trim());

      const kind = monetizationKind(p);

      const go = mapsDirUrl(origin.lat, origin.lon, p.lat, p.lon);
      const book = (kind === "ticket")
        ? gygSearchUrl(p.name, p.area || p.country)
        : bookingSearchUrl(p.name, p.area || p.country);
      const eat = foodSearchUrl(p.name, p.area || p.country, p.lat, p.lon);
      const photos = googleImagesUrl(p.name, p.area || p.country);
      const wiki = wikiUrl(p.name, p.area || p.country);

      const badge =
        isTicketAttraction(p) ? "🎟️ ticket" :
        isSpa(p) ? "🧖 spa" :
        isWinery(p) ? "🍷 wine" :
        isStay(p) ? "🏨 stay" :
        isFood(p) ? "🍝 food" : "⭐";

      return `
        <div class="card" style="box-shadow:none; border-color:rgba(0,224,255,.18);">
          <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
            <div style="font-weight:1000; font-size:20px; line-height:1.15;">${name}</div>
            <div class="pill">${badge}</div>
          </div>

          <div class="small muted" style="margin-top:6px;">
            🚗 ~${x.driveMin} min • ${Math.round(x.km)} km • 📍 ${areaLabel}
          </div>
          <div class="small muted" style="margin-top:6px;">score: ${x.score}</div>

          <div class="row wraprow" style="gap:10px; margin-top:12px;">
            <button type="button" class="btn btnPrimary" data-open="${escapeHtml(go)}">🧭 Vai</button>
            <button type="button" class="btn" data-open="${escapeHtml(book)}">🎟️ Prenota</button>
            <button type="button" class="btnGhost" data-open="${escapeHtml(eat)}">🍝 Mangia</button>
            <button type="button" class="btnGhost" data-open="${escapeHtml(photos)}">📸 Foto</button>
            <button type="button" class="btnGhost" data-open="${escapeHtml(wiki)}">📚 Wiki</button>
          </div>
        </div>
      `;
    }).join("");

    area.innerHTML = `
      <div class="small muted" style="margin-bottom:10px;">
        Dataset: ${escapeHtml(datasetLabel || "offline")}${reg}
      </div>
      ${items}
    `;
  }

  async function runSearchMonetizable() {
    const origin = getOrigin();
    if (!origin) throw new Error("Imposta prima la partenza.");
    const maxMinutes = clamp(Number($("maxMinutes")?.value) || 120, 10, 600);

    const ac = new AbortController();
    const { pools, region } = await loadPoolsRegionFirst(origin, { signal: ac.signal });

    let datasetLabel = "";
    let list = [];

    const regionPool = pools.find((p) => p.kind === "region");
    if (regionPool) {
      datasetLabel = `REGION:${String(regionPool.source).split("/").pop()}`;
      list = buildCandidates(regionPool.places, origin, maxMinutes);
    }

    if (!list.length) {
      const macroPool = pools.find((p) => p.kind === "macro");
      if (macroPool) {
        datasetLabel = `MACRO:${String(macroPool.source).split("/").pop()}`;
        list = buildCandidates(macroPool.places, origin, maxMinutes);
      }
    }

    renderResults(origin, region, list, datasetLabel);
    return list.length;
  }

  // -------------------- STATUS --------------------
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

  // -------------------- CLICK: EVENT DELEGATION (FIX) --------------------
  function bindResultAreaDelegation() {
    const area = $("resultArea");
    if (!area || area.dataset.boundClicks) return;
    area.dataset.boundClicks = "1";

    // capture = true: prende il tap prima di overlay/listener strani
    area.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-open]");
      if (!btn) return;

      e.preventDefault();
      e.stopPropagation();

      const url = btn.getAttribute("data-open");
      if (!url) return;

      // apri in modo sicuro
      window.open(url, "_blank", "noopener");
    }, true);
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

  // -------------------- BOOT --------------------
  function boot() {
    injectClickSafeCssOnce();
    bindResultAreaDelegation();
    disableGPS();
    hideStatus();

    // restore origin
    const raw = localStorage.getItem("jamo_origin");
    if (raw) {
      try {
        const o = JSON.parse(raw);
        if (Number.isFinite(Number(o?.lat)) && Number.isFinite(Number(o?.lon))) setOrigin(o);
      } catch {}
    }

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
      } catch (e) {
        showStatus("err", `Geocoding fallito: ${String(e.message || e)}`);
      }
    });

    $("btnFind")?.addEventListener("click", async () => {
      try {
        hideStatus();
        showStatus("ok", "🔎 Cerco solo POI monetizzabili…");
        const n = await runSearchMonetizable();
        showStatus("ok", n ? "✅ Trovati POI monetizzabili." : "⚠️ Nessun POI monetizzabile nei minuti scelti.");
      } catch (e) {
        showStatus("err", `Errore: ${String(e.message || e)}`);
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();

  window.__jamoMonetizable = { runSearchMonetizable };
})();
