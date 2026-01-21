/* Jamo — app.js (FULL MINIMAL WORKING)
 * ✅ Offline search (macros) • ✅ No GPS • ✅ Buttons OK
 * ✅ Time + Category filter • ✅ Render result card + change meta
 */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // -------------------- CONFIG --------------------
  const CFG = {
    ROAD_FACTOR: 1.25,
    AVG_KMH: 72,
    FIXED_OVERHEAD_MIN: 8,

    // dataset offline (metti qui i file che ESISTONO davvero nel tuo repo)
    DATASET_URLS: [
      "/data/macros/euuk_country_it.json",
      "/data/macros/euuk_macro_all.json",
    ],

    MAX_OPTIONS: 30,
  };

  // -------------------- STATE --------------------
  const UI = {
    minutes: 120,
    category: "natura",
    styles: { chicche: true, classici: true }, // per ora non filtriamo davvero su visibility
  };

  let PLACES_CACHE = null; // { url, places }
  let LAST_RESULTS = [];
  let LAST_INDEX = 0;

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
    return String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function scrollToId(id) {
    const el = $(id);
    if (!el) return;
    setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "start" }), 20);
  }

  // -------------------- STATUS UI --------------------
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

  // -------------------- LINKS / MAP --------------------
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
  function googleImagesUrl(name, area) {
    return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(
      stableQuery(name, area)
    )}`;
  }
  function wikiUrl(name, area) {
    const q = area ? `${name} ${area}` : name;
    return `https://it.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`;
  }

  function osmStaticImg(lat, lon, z = 11) {
    const size = "720x360";
    const marker = `${lat},${lon},lightblue1`;
    return `https://staticmap.openstreetmap.de/staticmap.php?center=${encodeURIComponent(
      lat + "," + lon
    )}&zoom=${encodeURIComponent(z)}&size=${encodeURIComponent(
      size
    )}&maptype=mapnik&markers=${encodeURIComponent(marker)}`;
  }

  // -------------------- ORIGIN STORAGE --------------------
  function setOrigin({ label, lat, lon, country_code }) {
    $("originLabel") && ($("originLabel").value = label ?? "");
    $("originLat") && ($("originLat").value = String(lat));
    $("originLon") && ($("originLon").value = String(lon));
    $("originCC") && ($("originCC").value = String(country_code || "").toUpperCase());

    localStorage.setItem(
      "jamo_origin",
      JSON.stringify({
        label: label ?? "",
        lat: Number(lat),
        lon: Number(lon),
        country_code: String(country_code || "").toUpperCase(),
      })
    );

    if ($("originStatus")) {
      $("originStatus").textContent = `✅ Partenza impostata: ${label || "posizione"} (${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)})`;
    }

    collapseOriginCard(true);
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
    if (!raw) return null;
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
    return null;
  }

  function clearOrigin() {
    localStorage.removeItem("jamo_origin");
    $("originLat") && ($("originLat").value = "");
    $("originLon") && ($("originLon").value = "");
    $("originCC") && ($("originCC").value = "");
    $("originLabel") && ($("originLabel").value = "");
    if ($("originStatus")) {
      $("originStatus").textContent = "🧽 Partenza resettata. Inserisci un nuovo luogo e premi “Usa questo luogo”.";
    }
    collapseOriginCard(false);
    showStatus("ok", "Partenza resettata ✅");
    scrollToId("quickStartCard");
  }

  function restoreOrigin() {
    const o = getOrigin();
    if (!o) return;
    setOrigin(o);
    collapseOriginCard(true);
  }

  // Collasso card partenza (compatibile col tuo index)
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

    card.classList.toggle("collapsed", !!shouldCollapse);
    const icon = $("originToggleIcon");
    if (icon) icon.textContent = shouldCollapse ? "⬆️" : "⬇️";
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

  // -------------------- CHIPS --------------------
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
        if (Number.isFinite(v)) {
          UI.minutes = v;
          if ($("maxMinutes")) $("maxMinutes").value = String(v);
        }
      }

      if (containerId === "categoryChips") {
        const cat = String(chip.dataset.cat || "").toLowerCase().trim();
        UI.category = cat || "natura";
        // eventi subfilters nel tuo index, ma qui non li usiamo → comunque li nascondiamo/mostriamo
        const sub = $("eventsSubfilters");
        if (sub) sub.classList.toggle("active", UI.category === "eventi");
      }

      if (containerId === "styleChips") {
        const act = [...el.querySelectorAll(".chip.active")].map((x) => x.dataset.style);
        UI.styles.chicche = act.includes("chicche");
        UI.styles.classici = act.includes("classici");
      }
    });
  }

  function initTimeInputSync() {
    $("maxMinutes")?.addEventListener("input", () => {
      const v = clamp(Number($("maxMinutes").value) || 120, 10, 600);
      UI.minutes = v;

      const chipsEl = $("timeChips");
      if (!chipsEl) return;
      const chips = [...chipsEl.querySelectorAll(".chip")];
      chips.forEach((c) => c.classList.remove("active"));
      const match = chips.find((c) => Number(c.dataset.min) === v);
      if (match) match.classList.add("active");
    });
  }

  // -------------------- OFFLINE DATASET LOAD --------------------
  async function fetchJsonSafe(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} su ${url}`);
    return await r.json();
  }

  function normalizePlaceLite(p) {
    if (!p) return null;
    const lat = Number(p.lat);
    const lon = Number(p.lon ?? p.lng);
    const name = String(p.name || "").trim();
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !name) return null;

    const tags = Array.isArray(p.tags) ? p.tags.map((x) => String(x).toLowerCase()) : [];
    return {
      id: p.id ? String(p.id) : null,
      name,
      lat,
      lon,
      area: String(p.area || p.region || "").trim(),
      country: String(p.country || "").toUpperCase(),
      tags,
    };
  }

  async function loadOfflinePlacesOnce() {
    if (PLACES_CACHE) return PLACES_CACHE;

    let lastErr = null;

    for (const url of CFG.DATASET_URLS) {
      try {
        const j = await fetchJsonSafe(url);
        const arr = Array.isArray(j?.places) ? j.places : [];
        const places = arr.map(normalizePlaceLite).filter(Boolean);
        if (places.length) {
          PLACES_CACHE = { url, places };
          return PLACES_CACHE;
        }
      } catch (e) {
        lastErr = e;
      }
    }

    throw new Error(
      `Nessun dataset offline valido. Ultimo errore: ${String(lastErr?.message || lastErr || "unknown")}`
    );
  }

  // -------------------- CATEGORY MATCH (SIMPLE) --------------------
  const hasAny = (s, arr) => arr.some((x) => s.includes(x));
  function tagsStrLite(p) {
    return (p.tags || []).join(" ");
  }

  function canonicalCategory(cat) {
    const c = String(cat || "").toLowerCase().trim();
    if (c === "trekking" || c === "hiking") return "hiking";
    return c || "natura";
  }

  function matchCategoryLite(place, catUI) {
    const cat = canonicalCategory(catUI);
    const t = tagsStrLite(place);
    const n = normName(place.name);

    // eventi: non gestiti qui
    if (cat === "eventi") return false;

    if (cat === "relax") {
      return (
        hasAny(n, ["terme", "spa", "wellness", "benessere", "sauna", "hammam", "hamam", "termale", "thermal"]) ||
        t.includes("amenity=spa") ||
        t.includes("leisure=spa") ||
        t.includes("tourism=spa") ||
        t.includes("natural=hot_spring") ||
        t.includes("amenity=sauna") ||
        t.includes("amenity=public_bath")
      );
    }

    if (cat === "borghi") {
      // SOLO insediamenti o nomi tipici borgo
      return (
        t.includes("place=village") ||
        t.includes("place=hamlet") ||
        t.includes("place=town") ||
        hasAny(n, ["borgo", "centro storico", "frazione", "contrada"])
      );
    }

    if (cat === "mare") {
      return (
        t.includes("natural=beach") ||
        t.includes("leisure=marina") ||
        hasAny(n, ["spiaggia", "lido", "baia", "cala", "mare", "beach"])
      );
    }

    if (cat === "hiking") {
      return (
        t.includes("route=hiking") ||
        t.includes("highway=path") ||
        t.includes("highway=footway") ||
        t.includes("tourism=alpine_hut") ||
        hasAny(n, ["sentier", "cai", "trail", "anello", "trek", "ferrata"])
      );
    }

    if (cat === "montagna") {
      return (
        t.includes("natural=peak") ||
        t.includes("tourism=alpine_hut") ||
        t.includes("aerialway=") ||
        hasAny(n, ["monte", "cima", "passo", "rifugio", "malga", "alpe"])
      );
    }

    if (cat === "storia") {
      return (
        t.includes("historic=") ||
        t.includes("tourism=museum") ||
        t.includes("tourism=attraction") ||
        hasAny(n, ["castel", "rocca", "forte", "abbazia", "duomo", "cattedrale", "museo", "archeologic", "rovine"])
      );
    }

    if (cat === "family") {
      return (
        t.includes("tourism=theme_park") ||
        t.includes("leisure=water_park") ||
        t.includes("tourism=zoo") ||
        t.includes("tourism=aquarium") ||
        hasAny(n, ["parco avventura", "zoo", "acquario", "planetario", "children"])
      );
    }

    if (cat === "cantine") {
      return (
        t.includes("craft=winery") ||
        t.includes("shop=wine") ||
        t.includes("amenity=wine_bar") ||
        hasAny(n, ["cantina", "enoteca", "degustaz", "winery", "wine tasting"])
      );
    }

    // NATURA default: qualcosa di visitabile/naturale
    if (cat === "natura") {
      return (
        t.includes("natural=") ||
        t.includes("water=lake") ||
        t.includes("leisure=park") ||
        hasAny(n, ["cascat", "gola", "lago", "parco", "riserva", "oasi", "grotta", "sorgente", "belvedere"])
      );
    }

    // fallback: accetta
    return true;
  }

  // -------------------- RENDER --------------------
  function renderSearching(cat, maxMin) {
    const area = $("resultArea");
    if (!area) return;
    area.innerHTML = `
      <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,180,80,.35); background:rgba(255,180,80,.06);">
        <div style="font-weight:950; font-size:18px;">🔎 Sto cercando offline…</div>
        <div class="small muted" style="margin-top:8px;">Categoria: <b>${escapeHtml(cat)}</b> • Max: <b>${maxMin} min</b></div>
      </div>
    `;
  }

  function renderNoResult(cat, maxMin, datasetUrl) {
    const area = $("resultArea");
    if (!area) return;
    area.innerHTML = `
      <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
        <div style="font-weight:950; font-size:18px;">❌ Nessun risultato</div>
        <div class="small muted" style="margin-top:8px;">
          Nessuna meta per <b>${escapeHtml(cat)}</b> entro <b>${maxMin} min</b>.<br>
          Prova ad aumentare i minuti o cambiare categoria.
        </div>
        <div class="small muted" style="margin-top:10px;">
          Dataset: ${escapeHtml((datasetUrl||"").split("/").pop() || "offline")}
        </div>
      </div>
    `;
    scrollToId("resultCard");
  }

  function renderPlaceCard(origin, place, driveMin, km, datasetUrl) {
    const area = $("resultArea");
    if (!area) return;

    const lat = place.lat;
    const lon = place.lon;
    const zoom = km < 20 ? 12 : km < 60 ? 10 : 8;
    const areaLabel = (place.area || place.country || "—").trim();

    area.innerHTML = `
      <div class="clickSafe" style="border-radius:18px; overflow:hidden; border:1px solid rgba(0,224,255,.18);">
        <div style="position:relative; width:100%; aspect-ratio: 2 / 1; border-bottom:1px solid rgba(255,255,255,.10);">
          <img src="${osmStaticImg(lat, lon, zoom)}" alt="" loading="lazy" decoding="async"
               style="position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; opacity:.95;" />
          <div style="position:absolute; left:12px; top:12px; display:flex; gap:8px; flex-wrap:wrap; max-width: calc(100% - 24px);">
            <div class="pill acc">🚗 ~${driveMin} min • ${Math.round(km)} km</div>
            <div class="pill soft">📍 ${escapeHtml(areaLabel)}</div>
          </div>
        </div>

        <div style="padding:14px;">
          <div style="font-weight:1000; font-size:30px; line-height:1.08;">
            ${escapeHtml(place.name)}
          </div>

          <div class="small muted" style="margin-top:6px;">
            ${lat.toFixed(5)}, ${lon.toFixed(5)}
          </div>

          <div class="small muted" style="margin-top:8px;">
            Dataset: ${escapeHtml((datasetUrl||"").split("/").pop() || "offline")}
          </div>

          <div class="actionGrid" style="margin-top:12px;">
            <button class="btn btnPrimary" id="btnGo" type="button">🧭 Vai</button>
            <button class="btnGhost" id="btnPhotos" type="button">📸 Foto</button>
            <button class="btnGhost" id="btnWiki" type="button">📚 Wiki</button>
            <button class="btn" id="btnChangePlace" type="button">🔁 Cambia meta</button>
          </div>
        </div>
      </div>
    `;

    $("btnGo")?.addEventListener("click", () => {
      window.open(mapsDirUrl(origin.lat, origin.lon, lat, lon), "_blank", "noopener");
    });
    $("btnPhotos")?.addEventListener("click", () => {
      window.open(googleImagesUrl(place.name, areaLabel), "_blank", "noopener");
    });
    $("btnWiki")?.addEventListener("click", () => {
      window.open(wikiUrl(place.name, areaLabel), "_blank", "noopener");
    });
    $("btnChangePlace")?.addEventListener("click", () => {
      showAnotherFromLast(origin);
    });

    scrollToId("resultCard");
  }

  function showAnotherFromLast(origin) {
    if (!LAST_RESULTS.length) {
      showStatus("warn", "Non ho altre opzioni: premi CERCA.");
      return;
    }
    LAST_INDEX = (LAST_INDEX + 1) % LAST_RESULTS.length;
    const x = LAST_RESULTS[LAST_INDEX];
    renderPlaceCard(origin, x.place, x.driveMin, x.km, x.datasetUrl);
  }

  // -------------------- SEARCH --------------------
  async function runSearch() {
    const origin = getOrigin();
    if (!origin) {
      showStatus("err", "Prima imposta la partenza (Usa questo luogo).");
      scrollToId("quickStartCard");
      return;
    }

    const maxMin = clamp(Number($("maxMinutes")?.value) || UI.minutes || 120, 10, 600);
    UI.minutes = maxMin;

    const cat = canonicalCategory(UI.category || "natura");

    if (cat === "eventi") {
      // qui eventi non esistono → messaggio chiaro
      const area = $("resultArea");
      if (area) {
        area.innerHTML = `
          <div class="card clickSafe" style="box-shadow:none; border-color:rgba(0,224,255,.25); background:rgba(0,224,255,.06);">
            <div style="font-weight:950; font-size:18px;">🎉 Eventi (non ancora attivi)</div>
            <div class="small muted" style="margin-top:8px; line-height:1.45;">
              In questo file minimal stiamo testando la ricerca OFFLINE dei POI.<br>
              Cambia categoria (es. Natura/Relax/Borghi) e riprova.
            </div>
          </div>
        `;
      }
      showStatus("warn", "Eventi non attivi in questa versione minimal.");
      scrollToId("resultCard");
      return;
    }

    hideStatus();
    renderSearching(cat, maxMin);

    try {
      const { url: datasetUrl, places } = await loadOfflinePlacesOnce();

      const oLat = Number(origin.lat);
      const oLon = Number(origin.lon);

      const candidates = [];
      for (const p of places) {
        if (!matchCategoryLite(p, cat)) continue;

        const km = haversineKm(oLat, oLon, p.lat, p.lon);
        const driveMin = estCarMinutesFromKm(km);
        if (!Number.isFinite(driveMin) || driveMin > maxMin) continue;

        // score semplice: preferisci vicino al maxMin ma non troppo
        const diff = Math.abs(driveMin - maxMin);
        const score = 1 / (1 + diff);

        candidates.push({ place: p, km, driveMin, score, datasetUrl });
      }

      candidates.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin));

      if (!candidates.length) {
        renderNoResult(cat, maxMin, datasetUrl);
        showStatus("warn", "Nessuna meta trovata con questi filtri.");
        return;
      }

      LAST_RESULTS = candidates.slice(0, CFG.MAX_OPTIONS);
      LAST_INDEX = 0;

      const best = LAST_RESULTS[0];
      renderPlaceCard(origin, best.place, best.driveMin, best.km, best.datasetUrl);

      showStatus("ok", `Trovate ${LAST_RESULTS.length} opzioni ✅ (offline)`);
    } catch (e) {
      console.error(e);
      showStatus("err", `Errore ricerca: ${String(e.message || e)}`);

      const area = $("resultArea");
      if (area) {
        area.innerHTML = `
          <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
            <div style="font-weight:950; font-size:18px;">❌ Errore dataset</div>
            <div class="small muted" style="margin-top:8px; line-height:1.45;">
              ${escapeHtml(String(e.message || e))}
            </div>
            <div class="small muted" style="margin-top:10px;">
              Controlla che esista almeno uno tra:<br>
              <b>/data/macros/euuk_country_it.json</b><br>
              <b>/data/macros/euuk_macro_all.json</b>
            </div>
          </div>
        `;
      }
      scrollToId("resultCard");
    }
  }

  // -------------------- BUTTONS BIND --------------------
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

        showStatus("ok", "Partenza impostata ✅ Ora premi CERCA.");
        scrollToId("searchCard");
      } catch (e) {
        console.error(e);
        if ($("originStatus")) $("originStatus").textContent = `❌ ${String(e.message || e)}`;
        showStatus("err", `Geocoding fallito: ${String(e.message || e)}`);
        scrollToId("quickStartCard");
      }
    });

    $("btnResetOrigin")?.addEventListener("click", () => clearOrigin());
  }

  function bindMainButtons() {
    $("btnFind")?.addEventListener("click", () => runSearch());
    $("btnResetVisited")?.addEventListener("click", () => {
      // nel minimal non usiamo visited per filtrare, ma teniamo il tasto vivo
      localStorage.removeItem("jamo_visited");
      showStatus("ok", "Visitati resettati ✅");
    });
  }

  // -------------------- BOOT --------------------
  function boot() {
    // chips
    initChips("timeChips", { multi: false });
    initChips("categoryChips", { multi: false });
    initChips("styleChips", { multi: true });
    initTimeInputSync();

    // default categoria: chip attiva già in HTML, qui leggiamo e settiamo
    const catActive = $("categoryChips")?.querySelector(".chip.active");
    if (catActive?.dataset?.cat) UI.category = String(catActive.dataset.cat).toLowerCase();

    // minutes default
    UI.minutes = clamp(Number($("maxMinutes")?.value) || 120, 10, 600);

    restoreOrigin();
    bindOriginButtons();
    bindMainButtons();
    hideStatus();

    const origin = getOrigin();
    if (origin) collapseOriginCard(true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  // debug
  window.__jamo = { runSearch, loadOfflinePlacesOnce };
})();
