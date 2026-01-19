/* Jamo — public/events.js v1.6 (ROBUST + OFFLINE FIRST + NO-ZERO FALLBACK)
 * - Input:  /data/events/events_all.json
 * - Output UI: #resultArea
 * - API: window.JAMO_EVENTS.run({ origin, maxMinutes, eventType, eventWhen, ...helpers })
 *
 * FIX:
 *  ✅ Supporta schema eventi builder:s (start/end/lat/lon/title/place/city/region/country_code/category/url)
 *  ✅ Filtri quando: oggi/weekend/7giorni/30giorni
 *  ✅ Tipo: usa category + fallback su title/place
 *  ✅ Se 0 risultati col filtro quando -> fallback "prossimi eventi" (resta limite minuti)
 *  ✅ Carica altri (12 a pagina)
 */

(() => {
  "use strict";

  const EVENTS_URL = "/data/events/events_all.json";
  const $ = (id) => document.getElementById(id);

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function safeText(x) {
    return String(x ?? "").replace(/\s+/g, " ").trim();
  }

  function parseDateSafe(x) {
    if (!x) return null;
    const d = new Date(x);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }
  function endOfDay(d) {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
  }

  function nextWeekendRange(now) {
    const d = startOfDay(now);
    const day = d.getDay(); // 0 dom, 6 sab
    const saturday = new Date(d);
    const sunday = new Date(d);

    if (day === 6) {
      sunday.setDate(sunday.getDate() + 1);
      return { from: saturday, to: endOfDay(sunday) };
    }
    if (day === 0) {
      return { from: d, to: endOfDay(d) };
    }
    const deltaToSat = 6 - day;
    saturday.setDate(saturday.getDate() + deltaToSat);
    sunday.setDate(sunday.getDate() + deltaToSat + 1);
    return { from: saturday, to: endOfDay(sunday) };
  }

  function withinRange(dateObj, from, to) {
    if (!dateObj) return false;
    const t = dateObj.getTime();
    return t >= from.getTime() && t <= to.getTime();
  }

  // Normalizza tipo (UI -> dataset)
  function normalizeTypeUI(x) {
    const s = safeText(x).toLowerCase();
    if (!s) return "tutti";
    // la UI potrebbe mandare: "tutti" / "sport" / "cultura" ecc.
    // teniamo valori "base"
    if (s === "tutti") return "tutti";
    if (/(cultura|culture|mostre|musei|arte)/.test(s)) return "culture";
    if (/(sport|corsa|run|trail|bike|bici|cycling|maratona|mtb)/.test(s)) return "sport";
    if (/(sagre|vino|food|street\s*food|degust|beer|birra)/.test(s)) return "sagre";
    if (/(concerti|concert|music|live|dj)/.test(s)) return "concerti";
    if (/(fiere|fiera|festival|expo|mercatini|market)/.test(s)) return "fiere";
    if (/(family|bimbi|kids|bambini)/.test(s)) return "family";
    return s;
  }

  function inferTypeFromEvent(ev) {
    const cat = safeText(ev.category).toLowerCase();
    const blob = (cat + " " + safeText(ev.title) + " " + safeText(ev.place) + " " + safeText(ev.url)).toLowerCase();

    // mappa “larga” (serve a far trovare MOLTO)
    if (/(sport|trail|run|corsa|maratona|bike|bici|cycling|mtb|gara|raduno)/.test(blob)) return "sport";
    if (/(concert|music|live|dj|spettacol|teatro)/.test(blob)) return "concerti";
    if (/(mostra|museum|museo|arte|galleria|exhibit|cultura|culture)/.test(blob)) return "culture";
    if (/(sagra|street\s*food|degust|vino|enogastr|food|beer|birra)/.test(blob)) return "sagre";
    if (/(fiera|festival|expo|mercatin|market|fair)/.test(blob)) return "fiere";
    if (/(family|kids|bambin|ragazz)/.test(blob)) return "family";

    // se category già “pulita”
    if (["sport", "culture", "sagre", "concerti", "fiere", "family"].includes(cat)) return cat;

    // fallback generico
    return cat || "other";
  }

  function pickEventDate(ev) {
    // builder usa start/end
    return (
      parseDateSafe(ev.start) ||
      parseDateSafe(ev.start_date) ||
      parseDateSafe(ev.date) ||
      parseDateSafe(ev.dt_start) ||
      parseDateSafe(ev.when)
    );
  }

  function pickCoords(ev) {
    const lat = Number(ev.lat ?? ev.location?.lat ?? ev.venue?.lat);
    const lon = Number(ev.lon ?? ev.lng ?? ev.location?.lon ?? ev.location?.lng ?? ev.venue?.lon ?? ev.venue?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  }

  function pickTitle(ev) {
    return safeText(ev.title ?? ev.name ?? "Evento");
  }

  function pickAreaLabel(ev) {
    const city = safeText(ev.city);
    const place = safeText(ev.place);
    const region = safeText(ev.region);
    const cc = safeText(ev.country_code || ev.cc || "").toUpperCase();
    // preferenza: city -> place -> region -> cc
    return city || place || region || cc || "—";
  }

  function fmtWhen(d) {
    if (!d) return "Data da confermare";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    if (hh === "00" && mi === "00") return `${dd}/${mm}/${yyyy}`;
    return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
  }

  function mapsSearchUrl(q, lat, lon) {
    const s = safeText(q);
    if (!s) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lon)}`;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s)}&center=${encodeURIComponent(lat + "," + lon)}`;
  }
  function googleUrl(q) {
    return `https://www.google.com/search?q=${encodeURIComponent(safeText(q))}`;
  }

  async function fetchJsonNoStore(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }

  function filterByWhen(evDate, whenKey, now) {
    const today0 = startOfDay(now);
    const todayEnd = endOfDay(now);

    if (whenKey === "oggi") {
      if (!evDate) return false;
      return withinRange(evDate, today0, todayEnd);
    }
    if (whenKey === "7giorni") {
      if (!evDate) return false;
      const to = endOfDay(new Date(today0.getTime() + 7 * 24 * 3600 * 1000));
      return withinRange(evDate, today0, to);
    }
    if (whenKey === "30giorni") {
      if (!evDate) return false;
      const to = endOfDay(new Date(today0.getTime() + 30 * 24 * 3600 * 1000));
      return withinRange(evDate, today0, to);
    }
    if (whenKey === "weekend") {
      if (!evDate) return false;
      const { from, to } = nextWeekendRange(now);
      return withinRange(evDate, from, to);
    }
    // "tutti" o sconosciuto
    return true;
  }

  function filterByType(ev, typeKeyUI) {
    const key = normalizeTypeUI(typeKeyUI);
    if (!key || key === "tutti") return true;

    const t = inferTypeFromEvent(ev);
    // match diretto
    if (t === key) return true;

    // match “vicino” (culture include mostre ecc.)
    if (key === "culture" && /culture|mostre|arte|museum|museo/.test(t)) return true;

    return false;
  }

  function render(rows, meta, helpers, state) {
    const area = $("resultArea");
    if (!area) return;

    const escapeHtml = helpers.escapeHtml || ((x) => String(x ?? ""));
    const updated = meta?.updated_at ? String(meta.updated_at).replace("T", " ").slice(0, 16) : "—";
    const totalCount = Number(meta?.count ?? rows.length);

    if (!rows.length) {
      area.innerHTML = `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
          <div style="font-weight:950; font-size:18px;">Nessun evento trovato</div>
          <div class="small muted" style="margin-top:8px; line-height:1.45;">
            Prova a cambiare sottocategoria oppure aumenta i minuti.
          </div>
          <div class="small muted" style="margin-top:10px;">
            Dataset: updated <b>${escapeHtml(updated)}</b> • count <b>${escapeHtml(totalCount)}</b>
          </div>
        </div>
      `;
      return;
    }

    const shown = rows.slice(0, state.shown);
    const canMore = state.shown < rows.length;

    const cards = shown.map((x) => {
      const title = escapeHtml(x.title);
      const areaLabel = escapeHtml(x.areaLabel || "—");
      const when = escapeHtml(fmtWhen(x.date));
      const km = Math.round(x.km);
      const mins = x.driveMin;
      const typeLabel = escapeHtml(x.typeLabel);

      const q = `${x.title}${x.areaLabel ? " " + x.areaLabel : ""}`;

      return `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(0,224,255,.14); background:rgba(255,255,255,.03);">
          <div style="font-weight:950; font-size:18px; line-height:1.2;">${title}</div>
          <div class="small muted" style="margin-top:6px;">
            📍 ${areaLabel} • 🗓️ ${when}
          </div>
          <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">
            <span class="pill acc">🎉 Eventi</span>
            <span class="pill soft">🏷️ ${typeLabel}</span>
            <span class="pill soft">🚗 ~${mins} min • ${km} km</span>
          </div>

          <div class="row wraprow" style="gap:10px; margin-top:12px;">
            <button class="btn btnPrimary" type="button"
              data-open="maps"
              data-q="${escapeHtml(q)}"
              data-lat="${x.lat}"
              data-lon="${x.lon}"
              style="flex:1; min-width:180px;"
            >🧭 Vai / Mappa</button>

            <button class="btnGhost" type="button"
              data-open="google"
              data-q="${escapeHtml(q)}"
            >🔎 Info</button>
          </div>
        </div>
      `;
    }).join("");

    area.innerHTML = `
      <div class="card clickSafe" style="box-shadow:none; border-color:rgba(0,224,255,.25); background:rgba(0,224,255,.06);">
        <div style="font-weight:950; font-size:18px;">Eventi trovati (${rows.length})</div>
        <div class="small muted" style="margin-top:8px; line-height:1.45;">
          Dataset: updated <b>${escapeHtml(updated)}</b> • totale dataset <b>${escapeHtml(totalCount)}</b><br>
          Mostrati: <b>${shown.length}</b> / <b>${rows.length}</b>
        </div>
      </div>

      <div style="margin-top:12px; display:flex; flex-direction:column; gap:10px;">
        ${cards}
      </div>

      ${canMore ? `
        <div style="margin-top:12px;">
          <button class="moreBtn clickSafe" id="btnMoreEvents" type="button">⬇️ Carica altri</button>
        </div>
      ` : ""}
    `;

    // delegation click
    const handler = (e) => {
      const btn = e.target.closest("button[data-open]");
      if (!btn) return;

      const kind = btn.getAttribute("data-open");
      const q = btn.getAttribute("data-q") || "";
      const lat = Number(btn.getAttribute("data-lat"));
      const lon = Number(btn.getAttribute("data-lon"));

      if (kind === "maps" && Number.isFinite(lat) && Number.isFinite(lon)) {
        window.open(mapsSearchUrl(q, lat, lon), "_blank", "noopener");
        return;
      }
      if (kind === "google") {
        window.open(googleUrl(q), "_blank", "noopener");
        return;
      }
    };

    area.__jamoEventsHandler && area.removeEventListener("click", area.__jamoEventsHandler);
    area.__jamoEventsHandler = handler;
    area.addEventListener("click", handler);

    const moreBtn = $("btnMoreEvents");
    if (moreBtn) {
      moreBtn.addEventListener(
        "click",
        () => {
          state.shown = Math.min(rows.length, state.shown + state.page);
          render(rows, meta, helpers, state);
          setTimeout(() => moreBtn.scrollIntoView({ behavior: "smooth", block: "center" }), 20);
        },
        { once: true }
      );
    }
  }

  async function run(args) {
    const origin = args?.origin;
    const maxMinutes = args?.maxMinutes;

    // UI keys
    const eventType = safeText(args?.eventType || "tutti");     // es: "sport" / "culture" / "tutti"
    const eventWhen = safeText(args?.eventWhen || "oggi");      // "oggi" | "weekend" | "7giorni" | "30giorni"

    // helpers from app.js
    const haversineKm = args?.haversineKm;
    const estCarMinutesFromKm = args?.estCarMinutesFromKm;
    const escapeHtml = args?.escapeHtml || ((x) => String(x ?? ""));
    const showStatus = args?.showStatus;
    const scrollToId = args?.scrollToId;

    const pageSize = clamp(Number(args?.pageSize) || 12, 6, 30);

    const area = $("resultArea");
    if (area) {
      area.innerHTML = `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,180,80,.35); background:rgba(255,180,80,.06);">
          <div style="font-weight:950; font-size:18px;">Cerco eventi…</div>
          <div class="small muted" style="margin-top:8px; line-height:1.45;">
            Tipo: <b>${escapeHtml(eventType)}</b> • Quando: <b>${escapeHtml(eventWhen)}</b>
          </div>
        </div>
      `;
    }

    if (!origin || !Number.isFinite(Number(origin.lat)) || !Number.isFinite(Number(origin.lon))) {
      showStatus?.("err", "Eventi: partenza non valida.");
      scrollToId?.("quickStartCard");
      return;
    }
    if (typeof haversineKm !== "function" || typeof estCarMinutesFromKm !== "function") {
      showStatus?.("err", "Eventi: helper mancanti (haversine/minuti).");
      scrollToId?.("resultCard");
      return;
    }

    let payload;
    try {
      payload = await fetchJsonNoStore(EVENTS_URL);
    } catch {
      showStatus?.("err", `Eventi: impossibile caricare ${EVENTS_URL}`);
      if (area) {
        area.innerHTML = `
          <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
            <div style="font-weight:950; font-size:18px;">Eventi offline non disponibili</div>
            <div class="small muted" style="margin-top:8px; line-height:1.45;">
              Manca <b>${escapeHtml(EVENTS_URL)}</b> oppure non e' stato committato.
            </div>
          </div>
        `;
      }
      scrollToId?.("resultCard");
      return;
    }

    const events = Array.isArray(payload?.events) ? payload.events : [];
    const now = new Date();
    const maxM = clamp(Number(maxMinutes) || 120, 10, 600);

    function buildRows({ ignoreWhen = false } = {}) {
      const rows = [];
      for (const ev of events) {
        const coords = pickCoords(ev);
        if (!coords) continue;

        const d = pickEventDate(ev);
        if (!ignoreWhen && !filterByWhen(d, eventWhen, now)) continue;
        if (!filterByType(ev, eventType)) continue;

        const km = haversineKm(origin.lat, origin.lon, coords.lat, coords.lon);
        const driveMin = estCarMinutesFromKm(km);
        if (!Number.isFinite(driveMin) || driveMin > maxM) continue;

        const typeLabel = inferTypeFromEvent(ev) || "other";

        rows.push({
          title: pickTitle(ev),
          areaLabel: pickAreaLabel(ev),
          lat: coords.lat,
          lon: coords.lon,
          date: d,
          km,
          driveMin,
          typeLabel,
        });
      }

      rows.sort((a, b) => {
        const da = a.date ? a.date.getTime() : 9e15;
        const db = b.date ? b.date.getTime() : 9e15;
        // distanza prima, poi data
        return (a.driveMin - b.driveMin) || (da - db);
      });

      return rows;
    }

    // 1) prova con quando
    let rows = buildRows({ ignoreWhen: false });

    // 2) fallback: se 0, togli filtro quando e mostra “prossimi”
    let usedFallback = false;
    if (!rows.length) {
      rows = buildRows({ ignoreWhen: true }).slice(0, 80);
      usedFallback = true;
    }

    // render
    const state = { shown: pageSize, page: pageSize };
    render(rows, payload, { escapeHtml }, state);

    if (usedFallback) {
      showStatus?.("ok", `Eventi: 0 con filtro quando → mostro prossimi (${rows.length}) ✅`);
    } else {
      showStatus?.("ok", `Eventi: trovati ${rows.length} ✅`);
    }
    scrollToId?.("resultCard");
  }

  window.JAMO_EVENTS = { run };
})();
