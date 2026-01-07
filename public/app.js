/* Jamo — app.js v13 (Mobile WOW + Alternatives FIX + Sticky Dock + Readable Cards)
 * ✅ Alternative NON duplicate (chiave unica + diversità)
 * ✅ Card leggibili (contrasto alto)
 * ✅ Dock bottom senza testi tagliati (safe-area + layout)
 * ✅ Flusso: Cerca → Risultato → Alternative (tap = cambia scheda) → Cerca nuova meta
 * ✅ “Cerca” sempre disponibile (sticky CTA)
 */

(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // -------------------- CONFIG --------------------
  const ROAD_FACTOR = 1.25;
  const AVG_KMH = 72;
  const FIXED_OVERHEAD_MIN = 8;

  const REGIONAL_POIS_BY_ID = { "it-veneto": "/data/pois/regions/it-veneto.json" };

  // -------------------- CSS (inject) --------------------
  // Fix contrast + dock safe-area + truncation
  const CSS = `
  :root{
    --bg:#071017;
    --surface:#0f1c23;
    --card:#10242c;
    --text:#ffffff;
    --muted:rgba(255,255,255,.75);
    --muted2:rgba(255,255,255,.60);
    --border:rgba(255,255,255,.10);
    --acc:#00E0FF;
    --acc2:#1AFFD5;
  }

  /* Better readability for result cards */
  .jamo-card{
    background: linear-gradient(180deg, rgba(0,224,255,.08), rgba(16,36,44,.0));
    border:1px solid var(--border);
    border-radius:18px;
    padding:14px;
    color:var(--text);
  }
  .jamo-title{font-weight:950; font-size:28px; line-height:1.12; margin:0;}
  .jamo-meta{margin-top:8px; color:var(--muted); font-size:13px; line-height:1.35;}
  .jamo-desc{margin-top:10px; color:rgba(255,255,255,.88); font-size:14px; line-height:1.45;}
  .jamo-badges{display:flex; flex-wrap:wrap; gap:8px; margin-top:10px;}
  .jamo-pill{
    display:inline-flex; align-items:center; gap:8px;
    padding:7px 10px; border-radius:999px;
    border:1px solid rgba(255,255,255,.12);
    background:rgba(0,0,0,.18);
    color:rgba(255,255,255,.9);
    font-size:12px;
  }

  /* Actions grid: big + clear */
  .jamo-actions{
    display:grid;
    grid-template-columns:1fr 1fr;
    gap:10px;
    margin-top:14px;
  }
  .jamo-btn{
    display:flex; align-items:center; justify-content:center; gap:8px;
    padding:12px 12px;
    border-radius:16px;
    border:1px solid rgba(255,255,255,.12);
    background:rgba(255,255,255,.05);
    color:var(--text);
    font-weight:850;
    text-decoration:none;
    user-select:none;
  }
  .jamo-btn.primary{
    border-color:rgba(0,224,255,.45);
    background:linear-gradient(90deg, rgba(0,224,255,.22), rgba(26,255,213,.12));
  }
  .jamo-btn:active{transform:scale(.99);}

  /* Alternatives: readable, no weird gray text */
  .jamo-alt-wrap{margin-top:16px;}
  .jamo-alt-title{font-size:20px; font-weight:950; margin:0 0 10px;}
  .jamo-alt{
    display:flex;
    flex-direction:column;
    gap:10px;
  }
  .jamo-alt-card{
    border-radius:18px;
    border:1px solid rgba(255,255,255,.10);
    background:rgba(255,255,255,.04);
    padding:12px 12px;
    color:var(--text);
    cursor:pointer;
  }
  .jamo-alt-card.active{
    border-color:rgba(0,224,255,.50);
    box-shadow:0 0 0 3px rgba(0,224,255,.10);
    background:rgba(0,224,255,.08);
  }
  .jamo-alt-row{display:flex; align-items:flex-start; justify-content:space-between; gap:12px;}
  .jamo-alt-name{font-weight:950; font-size:16px; line-height:1.15;}
  .jamo-alt-sub{margin-top:6px; color:var(--muted); font-size:13px;}
  .jamo-alt-right{color:rgba(255,255,255,.92); font-weight:900; white-space:nowrap;}

  /* Sticky CTA "TROVAMI LA META" */
  .jamo-sticky-find{
    position:sticky;
    bottom: calc(86px + env(safe-area-inset-bottom));
    z-index:40;
    padding-top:10px;
  }

  /* Bottom Dock: safe area + no cut text */
  .jamo-dock{
    position:fixed;
    left:0; right:0;
    bottom:0;
    z-index:80;
    padding:10px 10px calc(10px + env(safe-area-inset-bottom));
    background:linear-gradient(180deg, rgba(7,16,23,.0), rgba(7,16,23,.85) 30%, rgba(7,16,23,.95));
    backdrop-filter: blur(10px);
  }
  .jamo-dock-inner{
    max-width:980px;
    margin:0 auto;
    display:grid;
    grid-template-columns: 1.15fr 1fr 1fr 1fr;
    gap:10px;
  }
  .jamo-dock-btn{
    display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px;
    padding:10px 8px;
    border-radius:18px;
    border:1px solid rgba(255,255,255,.10);
    background:rgba(255,255,255,.04);
    color:rgba(255,255,255,.92);
    font-weight:900;
    text-decoration:none;
    min-height:54px;
  }
  .jamo-dock-btn .lab{
    font-size:12px;
    line-height:1;
    max-width:100%;
    overflow:hidden;
    text-overflow:ellipsis;
    white-space:nowrap;
  }
  .jamo-dock-btn.primary{
    border-color:rgba(0,224,255,.55);
    background:linear-gradient(90deg, rgba(0,224,255,.22), rgba(26,255,213,.12));
  }
  body{ padding-bottom: 96px; } /* space for dock */
  `;
  (function injectCss() {
    const s = document.createElement("style");
    s.textContent = CSS;
    document.head.appendChild(s);
  })();

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
    const roadKm = km * ROAD_FACTOR;
    const driveMin = (roadKm / AVG_KMH) * 60;
    return Math.round(clamp(driveMin + FIXED_OVERHEAD_MIN, 6, 900));
  }

  function normName(s) {
    return String(s ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  // ✅ KEY UNICA: se hai id nel dataset usiamola, altrimenti name+latlon
  function placeKey(p) {
    if (p?.id) return String(p.id);
    const n = normName(p?.name || "x");
    return `${n}__${Number(p.lat).toFixed(5)}__${Number(p.lon).toFixed(5)}`;
  }

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
  function googleImagesUrl(name, area) {
    return `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(stableQuery(name, area))}`;
  }
  function wikiUrl(name, area) {
    const q = area ? `${name} ${area}` : name;
    return `https://it.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}`;
  }

  // -------------------- CHIPS --------------------
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

      // UX: dopo aver scelto stile/categoria, porta subito al pulsante Cerca
      if (containerId === "styleChips" || containerId === "categoryChips") {
        $("btnFind")?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }

  function getActiveCategory() {
    return document.querySelector("#categoryChips .chip.active")?.dataset.cat || "ovunque";
  }
  function getActiveStyles() {
    const actives = [...document.querySelectorAll("#styleChips .chip.active")].map(c => c.dataset.style);
    return { wantChicche: actives.includes("chicche"), wantClassici: actives.includes("classici") };
  }

  // -------------------- ORIGIN --------------------
  function setOrigin({ label, lat, lon, country_code }) {
    $("originLabel") && ($("originLabel").value = label ?? "");
    $("originLat") && ($("originLat").value = String(lat));
    $("originLon") && ($("originLon").value = String(lon));
    $("originCC") && ($("originCC").value = String(country_code || "").toUpperCase());

    localStorage.setItem("jamo_origin", JSON.stringify({ label, lat, lon, country_code }));
    if ($("originStatus")) $("originStatus").textContent = `✅ Partenza impostata: ${label || ""}`;
  }

  function getOrigin() {
    const lat = Number($("originLat")?.value);
    const lon = Number($("originLon")?.value);
    const label = ($("originLabel")?.value || "").trim();

    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon, label, country_code: String($("originCC")?.value || "").toUpperCase() };

    const raw = localStorage.getItem("jamo_origin");
    if (!raw) return null;
    try {
      const o = JSON.parse(raw);
      if (Number.isFinite(Number(o?.lat)) && Number.isFinite(Number(o?.lon))) {
        return { lat: Number(o.lat), lon: Number(o.lon), label: String(o.label || ""), country_code: String(o.country_code || "").toUpperCase() };
      }
    } catch {}
    return null;
  }

  async function geocodeLabel(label) {
    const q = String(label || "").trim();
    if (!q) throw new Error("Scrivi un luogo (es: Verona, Padova, Venezia...)");
    const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { cache: "no-store" });
    const j = await r.json().catch(() => null);
    if (!j?.ok) throw new Error(j?.error || "Geocoding fallito");
    return j.result;
  }

  // -------------------- DATASET --------------------
  let DATASET = { places: [], meta: {} };

  function normalizePlace(p) {
    if (!p) return null;
    const lat = Number(p.lat);
    const lon = Number(p.lon ?? p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    return {
      ...p,
      lat, lon,
      name: String(p.name || "").trim(),
      type: String(p.type || p.primary_category || "").toLowerCase().trim(),
      visibility: String(p.visibility || "classica").toLowerCase().trim(),
      tags: Array.isArray(p.tags) ? p.tags.map(x => String(x).toLowerCase()) : [],
      area: String(p.area || ""),
      country: String(p.country || "Italia"),
    };
  }

  async function loadDataset() {
    const url = REGIONAL_POIS_BY_ID["it-veneto"];
    const r = await fetch(url, { cache: "no-store" });
    const j = await r.json();
    const placesRaw = Array.isArray(j?.places) ? j.places : [];
    DATASET = {
      places: placesRaw.map(normalizePlace).filter(Boolean),
      meta: j?.meta || {},
    };
  }

  // -------------------- FILTERS --------------------
  function tagsStr(p) { return (p.tags || []).join(" "); }

  function isRelaxGood(p) {
    // ✅ Relax: NO valanga di piscine. Preferisci spa/terme/sauna/hot_spring.
    const t = tagsStr(p);
    if (t.includes("natural=hot_spring")) return true;
    if (t.includes("amenity=spa") || t.includes("leisure=spa") || t.includes("tourism=spa")) return true;
    if (t.includes("amenity=sauna") || t.includes("leisure=sauna")) return true;
    if (t.includes("amenity=public_bath")) return true;

    // piscine solo se “forti”: nome contiene terme/spa o tag spa
    if (t.includes("leisure=swimming_pool")) {
      const n = normName(p.name);
      if (n.includes("terme") || n.includes("spa") || n.includes("thermal")) return true;
      return false;
    }
    return false;
  }

  function matchesCategory(p, cat) {
    if (!cat || cat === "ovunque") return true;
    const t = tagsStr(p);

    if (cat === "natura") return p.type === "natura" || t.includes("natural=") || t.includes("waterway=");
    if (cat === "relax") return isRelaxGood(p);
    if (cat === "viewpoints") return p.type === "viewpoints" || t.includes("tourism=viewpoint") || t.includes("observation");
    if (cat === "hiking") return p.type === "hiking" || t.includes("alpine_hut") || t.includes("shelter") || t.includes("guidepost");
    if (cat === "storia") return p.type === "storia" || t.includes("historic=") || t.includes("tourism=museum");
    if (cat === "mare") return p.type === "mare" || t.includes("natural=beach") || t.includes("marina");
    if (cat === "montagna") return p.type === "montagna" || t.includes("natural=peak") || t.includes("aerialway") || t.includes("piste:type");
    if (cat === "borghi") return p.type === "borghi" || t.includes("place=village") || t.includes("place=hamlet");
    if (cat === "citta") return p.type === "citta" || t.includes("place=city") || t.includes("place=town");
    if (cat === "family") return p.type === "family" || t.includes("theme_park") || t.includes("zoo") || t.includes("aquarium") || t.includes("water_park");
    return true;
  }

  function matchesStyle(p, styles) {
    const vis = (p.visibility === "chicca") ? "chicca" : "classica";
    if (!styles.wantChicche && !styles.wantClassici) return true;
    if (vis === "chicca") return !!styles.wantChicche;
    return !!styles.wantClassici;
  }

  // -------------------- CANDIDATES + ALTERNATIVES FIX --------------------
  function buildCandidates(origin, maxMinutes, category, styles) {
    const oLat = Number(origin.lat), oLon = Number(origin.lon);

    const c = [];
    for (const p0 of DATASET.places) {
      const p = normalizePlace(p0);
      if (!p || !p.name) continue;
      if (!matchesCategory(p, category)) continue;
      if (!matchesStyle(p, styles)) continue;

      const d = haversineKm(oLat, oLon, p.lat, p.lon);
      const m = estCarMinutesFromKm(d);
      if (!Number.isFinite(m) || m > maxMinutes) continue;

      c.push({ p, km: d, min: m, key: placeKey(p) });
    }
    c.sort((a, b) => (a.min - b.min) || (a.km - b.km));
    return c;
  }

  function pickWithDiversity(cands, howMany = 6) {
    // ✅ Diversità: non ripetere stesso nome e non prendere punti troppo vicini tra loro
    const out = [];
    const usedName = new Set();

    for (const x of cands) {
      if (out.length >= howMany) break;

      const n = normName(x.p.name);
      if (usedName.has(n)) continue;

      let tooClose = false;
      for (const y of out) {
        const d = haversineKm(x.p.lat, x.p.lon, y.p.lat, y.p.lon);
        if (d < 1.2) { tooClose = true; break; } // evita 5 “Risorgiva” attaccate
      }
      if (tooClose) continue;

      usedName.add(n);
      out.push(x);
    }

    // fallback se troppo restrittivo
    if (out.length < Math.min(3, howMany)) {
      const seenKey = new Set(out.map(z => z.key));
      for (const x of cands) {
        if (out.length >= howMany) break;
        if (seenKey.has(x.key)) continue;
        seenKey.add(x.key);
        out.push(x);
      }
    }
    return out;
  }

  // -------------------- RENDER --------------------
  function setStatus(msg) {
    if (!$("statusBox") || !$("statusText")) return;
    $("statusBox").style.display = "block";
    $("statusText").textContent = msg;
  }

  function ensureDock() {
    if (document.querySelector(".jamo-dock")) return;

    const dock = document.createElement("div");
    dock.className = "jamo-dock";
    dock.innerHTML = `
      <div class="jamo-dock-inner">
        <button class="jamo-dock-btn primary" id="dockSearch" type="button">
          <div style="font-size:18px;">🎯</div>
          <div class="lab">Cerca</div>
        </button>

        <a class="jamo-dock-btn" id="dockNav" target="_blank" rel="noopener">
          <div style="font-size:18px;">🧭</div>
          <div class="lab">Naviga</div>
        </a>

        <a class="jamo-dock-btn" id="dockBook" target="_blank" rel="noopener">
          <div style="font-size:18px;">🎟️</div>
          <div class="lab">Prenota</div>
        </a>

        <a class="jamo-dock-btn" id="dockEat" target="_blank" rel="noopener">
          <div style="font-size:18px;">🍽️</div>
          <div class="lab">Mangia</div>
        </a>
      </div>
    `;
    document.body.appendChild(dock);

    $("dockSearch")?.addEventListener("click", () => {
      // flusso: quando premi Cerca dal dock, vai al bottone e fai ricerca
      $("btnFind")?.scrollIntoView({ behavior: "smooth", block: "center" });
      runSearch({ silent: true });
    });
  }

  function updateDockLinks(origin, place) {
    ensureDock();
    const nav = $("dockNav");
    const book = $("dockBook");
    const eat = $("dockEat");

    if (!place || !origin) {
      if (nav) nav.href = "#";
      if (book) book.href = "#";
      if (eat) eat.href = "#";
      return;
    }

    nav.href = mapsDirUrl(origin.lat, origin.lon, place.lat, place.lon);

    // Placeholder monetizzazione: poi ci mettiamo affiliazioni vere
    book.href = `https://www.google.com/search?q=${encodeURIComponent(stableQuery(place.name, "Italia") + " biglietti prenotazione")}`;
    eat.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("ristoranti vicino " + place.name)}&center=${encodeURIComponent(place.lat + "," + place.lon)}`;
  }

  function renderResult(origin, chosen, alternatives, meta) {
    const area = $("resultArea");
    if (!area) return;

    if (!chosen) {
      area.innerHTML = `
        <div class="jamo-card">
          <div class="jamo-title" style="font-size:22px;">Nessuna meta trovata</div>
          <div class="jamo-meta">Prova ad aumentare i minuti o cambia categoria/stile.</div>
        </div>
      `;
      updateDockLinks(null, null);
      return;
    }

    const p = chosen.p;
    const areaLabel = "Italia";
    const catLabel = meta.category || "ovunque";

    // “cos’è” semplice, ma utile (senza AI esterna)
    const what =
      catLabel === "natura" ? "Natura: risorgiva/lago/cascata/fiume o area verde. Scarpe comode e foto." :
      catLabel === "relax" ? "Relax: terme/spa/sauna. Spesso serve prenotazione." :
      catLabel === "storia" ? "Storia: luogo storico o museo. Controlla orari e biglietti." :
      catLabel === "mare" ? "Mare: spiaggia/marina. Ideale in stagione." :
      catLabel === "montagna" ? "Montagna: cime/rifugi/impianti. Controlla meteo." :
      catLabel === "hiking" ? "Trekking: sentiero/rifugio. Controlla percorso e meteo." :
      catLabel === "viewpoints" ? "Panorama: viewpoint reale. Tramonto e foto garantiti." :
      catLabel === "family" ? "Family: attrazione per famiglie (zoo/acquapark/theme park/rope)." :
      "Meta selezionata in base a tempo e categoria.";

    const visBadge = (p.visibility === "chicca") ? "✨ Chicca" : "✅ Classica";
    const pid = placeKey(p);

    area.innerHTML = `
      <div class="jamo-card" id="jamoResultTop">
        <div class="jamo-title">${p.name}</div>

        <div class="jamo-meta">
          📍 ${areaLabel} · 🚗 ~${chosen.min} min · ${chosen.km.toFixed(0)} km · <b>${visBadge}</b>
        </div>

        <div class="jamo-desc">${what}</div>

        <div class="jamo-badges">
          <span class="jamo-pill">🏷️ ${catLabel}</span>
          <span class="jamo-pill">🗺️ apri Maps</span>
          <span class="jamo-pill">🎟️ prenota / idee</span>
        </div>

        <div class="jamo-actions">
          <a class="jamo-btn primary" target="_blank" rel="noopener" href="${mapsDirUrl(origin.lat, origin.lon, p.lat, p.lon)}">🧭 Naviga</a>
          <a class="jamo-btn" target="_blank" rel="noopener" href="${mapsPlaceUrl(p.lat, p.lon)}">🗺️ Maps</a>
          <a class="jamo-btn" target="_blank" rel="noopener" href="${googleImagesUrl(p.name, areaLabel)}">📸 Foto</a>
          <a class="jamo-btn" target="_blank" rel="noopener" href="${wikiUrl(p.name, areaLabel)}">📚 Wiki</a>
        </div>

        <div class="jamo-actions" style="margin-top:10px;">
          <a class="jamo-btn primary" target="_blank" rel="noopener"
             href="https://www.google.com/search?q=${encodeURIComponent(stableQuery(p.name, areaLabel) + " biglietti prenotazione")}">🎟️ Prenota</a>
          <a class="jamo-btn primary" target="_blank" rel="noopener"
             href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("ristoranti vicino " + p.name)}&center=${encodeURIComponent(p.lat + "," + p.lon)}">🍽️ Mangia</a>
        </div>

        <div class="jamo-actions" style="margin-top:10px;">
          <button class="jamo-btn" id="btnChange" type="button">🔁 Cambia meta</button>
          <button class="jamo-btn" id="btnScrollTop" type="button">⬆️ Su</button>
        </div>
      </div>

      <div class="jamo-alt-wrap">
        <div class="jamo-alt-title">Altre opzioni</div>
        <div class="jamo-alt" id="altList">
          ${alternatives.map(a => {
            const ap = a.p;
            const aKey = placeKey(ap);
            const badge = ap.visibility === "chicca" ? "✨ chicca" : "✅ classica";
            return `
              <div class="jamo-alt-card ${aKey===pid ? "active" : ""}" data-key="${aKey}">
                <div class="jamo-alt-row">
                  <div>
                    <div class="jamo-alt-name">${ap.name}</div>
                    <div class="jamo-alt-sub">${badge} · Italia</div>
                  </div>
                  <div class="jamo-alt-right">~${a.min} min</div>
                </div>
              </div>
            `;
          }).join("")}
        </div>

        <div class="jamo-meta" style="margin-top:10px;">
          Tocca un’opzione per aprire la scheda (senza rifare la ricerca).
        </div>
      </div>
    `;

    updateDockLinks(origin, p);

    $("btnScrollTop")?.addEventListener("click", () => {
      $("jamoResultTop")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    $("btnChange")?.addEventListener("click", () => {
      runSearch({ silent: true, forbidKey: pid });
    });

    document.querySelectorAll("#altList .jamo-alt-card").forEach(el => {
      el.addEventListener("click", () => {
        const k = el.getAttribute("data-key");
        if (!k) return;
        const found = alternatives.find(x => placeKey(x.p) === k);
        if (!found) return;
        // render immediato della scheda selezionata (NO jump a partenza)
        renderResult(origin, found, alternatives, meta);
        $("jamoResultTop")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  // -------------------- SEARCH --------------------
  function showProgress() {
    const area = $("resultArea");
    if (!area) return;
    area.innerHTML = `
      <div class="jamo-card">
        <div class="jamo-title" style="font-size:22px;">🔎 Cerco la meta…</div>
        <div class="jamo-meta">Filtro categoria + tempo. Ti mostro anche alternative diverse.</div>
      </div>
    `;
  }

  function widenMinutesSteps(m) {
    const base = clamp(Number(m) || 120, 10, 600);
    return Array.from(new Set([base, Math.min(600, Math.round(base*1.25)), Math.min(600, Math.round(base*1.5)), 240, 360].filter(x=>x>=base))).sort((a,b)=>a-b);
  }

  async function runSearch({ silent = false, forbidKey = null } = {}) {
    try {
      if (!silent) setStatus("🔎 Cerco nel dataset…");
      showProgress();

      const origin = getOrigin();
      if (!origin) {
        setStatus("❌ Imposta partenza (GPS disattivato).");
        return;
      }

      if (!DATASET.places.length) await loadDataset();

      const maxMinutesInput = clamp(Number($("maxMinutes")?.value) || 120, 10, 600);
      const category = getActiveCategory();
      const styles = getActiveStyles();

      const steps = widenMinutesSteps(maxMinutesInput);

      let chosen = null;
      let alternatives = [];

      for (const mins of steps) {
        const cands = buildCandidates(origin, mins, category, styles);

        // se devo evitare lo stesso risultato (cambia meta)
        const cFiltered = forbidKey ? cands.filter(x => x.key !== forbidKey) : cands;

        if (!cFiltered.length) continue;

        // scelgo la prima “buona”
        chosen = cFiltered[0];

        // alternative DIVERSE (no 5 risorgive)
        alternatives = pickWithDiversity(cFiltered, 6);

        // assicurati che la chosen sia inclusa e in cima
        const ck = chosen.key;
        alternatives = [chosen, ...alternatives.filter(x => x.key !== ck)].slice(0, 6);

        break;
      }

      renderResult(origin, chosen, alternatives, { category });

      if (chosen) {
        setStatus(`✅ Trovata meta (~${chosen.min} min) · categoria: ${category}`);
        // UX: appena trovata, vai al risultato (non a partenza)
        $("resultArea")?.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        setStatus(`⚠️ Nessuna meta entro ${maxMinutesInput} min. Aumenta minuti o cambia categoria.`);
      }
    } catch (e) {
      console.error(e);
      setStatus(`❌ Errore: ${String(e.message || e)}`);
    }
  }

  // -------------------- BIND UI --------------------
  function disableGPS() {
    const b = $("btnUseGPS");
    if (b) { b.style.display = "none"; b.disabled = true; }
  }

  function restoreOrigin() {
    const raw = localStorage.getItem("jamo_origin");
    if (!raw) return;
    try {
      const o = JSON.parse(raw);
      if (Number.isFinite(Number(o?.lat)) && Number.isFinite(Number(o?.lon))) {
        setOrigin({ label: o.label, lat: o.lat, lon: o.lon, country_code: o.country_code || "" });
      }
    } catch {}
  }

  function initTimeChipsSync() {
    $("maxMinutes")?.addEventListener("input", () => {
      const v = Number($("maxMinutes").value);
      const chipsEl = $("timeChips");
      if (!chipsEl) return;
      [...chipsEl.querySelectorAll(".chip")].forEach(c => c.classList.remove("active"));
      const match = [...chipsEl.querySelectorAll(".chip")].find(c => Number(c.dataset.min) === v);
      if (match) match.classList.add("active");
    });
  }

  function bindOriginButtons() {
    disableGPS();

    $("btnFindPlace")?.addEventListener("click", async () => {
      try {
        const label = $("originLabel")?.value || "";
        if ($("originStatus")) $("originStatus").textContent = "🔎 Cerco il luogo…";
        const result = await geocodeLabel(label);
        setOrigin({ label: result.label || label, lat: result.lat, lon: result.lon, country_code: result.country_code || "" });
        setStatus("✅ Partenza impostata");
      } catch (e) {
        console.error(e);
        if ($("originStatus")) $("originStatus").textContent = `❌ ${String(e.message || e)}`;
        setStatus(`❌ Geocoding fallito: ${String(e.message || e)}`);
      }
    });
  }

  function bindMainButtons() {
    // ✅ Sticky wrapper per il tasto Cerca (se esiste il container card)
    const btn = $("btnFind");
    if (btn) {
      // se siamo su mobile, rendilo sticky in fondo al pannello filtri
      btn.parentElement?.classList?.add("jamo-sticky-find");
    }

    $("btnFind")?.addEventListener("click", () => runSearch());
    $("btnResetVisited")?.addEventListener("click", () => {
      localStorage.removeItem("jamo_visited");
      setStatus("✅ Visitati resettati");
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
    ensureDock();

    // preload dataset “best effort”
    loadDataset().catch(() => {});
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();

  // debug
  window.__jamo = { runSearch };
})();
