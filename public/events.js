/* Jamo — events.js v1.4 (ROBUST + OFFLINE FIRST + MANY RESULTS + CHIP-COMPAT)
 * - Legge: /data/events/events_all.json
 * - Filtra: tipo + quando (oggi/weekend/7giorni/30giorni) con mapping robusto
 * - Fallback auto se 0 risultati: relax filtri (tipo -> quando -> entrambi)
 * - Ordina: minuti poi data
 * - Render in #resultArea con paginazione: 12 + "Carica altri"
 * - Espone: window.JAMO_EVENTS.run(...)
 */

(() => {
  "use strict";

  const EVENTS_URL = "/data/events/events_all.json";
  const $ = (id) => document.getElementById(id);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  // ---------- date helpers ----------
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

  // ---------- normalization ----------
  function normKey(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[_-]+/g, "");
  }

  function normalizeWhenKey(k) {
    const s = normKey(k);
    if (!s) return "oggi";
    if (s === "oggi" || s === "today") return "oggi";
    if (s === "weekend" || s === "fine" || s === "finesettimana") return "weekend";
    if (s === "7giorni" || s === "7days" || s === "7" || s === "settimana") return "7giorni";
    if (s === "30giorni" || s === "30days" || s === "30" || s === "mese") return "30giorni";
    return "oggi";
  }

  function normalizeTypeKey(k) {
    const s = normKey(k);
    if (!s || s === "tutti" || s === "all") return "tutti";

    // accetta tante varianti
    if (/(sport|sports|run|trail|bike|cycling|mtb|moto|maratona|corsa|gara|match)/.test(s)) return "sport";
    if (/(concert|music|live|dj|spettacol|show)/.test(s)) return "concerti";
    if (/(mostr|museum|exhibit|arte|gallery|galleria)/.test(s)) return "mostre";
    if (/(fiera|festival|fair|expo|mercatin|market)/.test(s)) return "fiere";
    if (/(family|kids|child|bambin|ragazz)/.test(s)) return "family";
    if (/(sagra|streetfood|degust|vino|enogastr|food|taste|beer|birra)/.test(s)) return "sagre";

    // se arriva "cultura/culture" lo trattiamo come "mostre" (per non tagliare via tutto)
    if (/(cultura|culture|cultural)/.test(s)) return "mostre";

    return s; // fallback
  }

  function normalizeEventTypeFromEvent(ev) {
    // prova su più campi, e fallback sul titolo
    const raw =
      ev.category ||
      ev.kind ||
      ev.type ||
      (Array.isArray(ev.tags) ? ev.tags.join(" ") : "") ||
      ev.title ||
      "";
    const s = String(raw || "").toLowerCase().trim();

    // mapping semantico (stesso di normalizeTypeKey ma su testo libero)
    if (/(sagra|street\s*food|degust|vino|enogastr|food|taste|beer|birra)/.test(s)) return "sagre";
    if (/(concert|live|music|dj|spettacol)/.test(s)) return "concerti";
    if (/(mostr|museum|exhibit|arte|galleria|gallery)/.test(s)) return "mostre";
    if (/(fiera|festival|fair|expo|mercatin|market)/.test(s)) return "fiere";
    if (/(family|kids|child|bambin|ragazz)/.test(s)) return "family";
    if (/(sport|corsa|maratona|trail|run|bike|bici|cycling|mtb|moto|motor|raduno|enduro)/.test(s)) return "sport";

    // se nel dataset c'è "culture", non vogliamo buttare via tutto
    if (/(culture|cultura)/.test(s)) return "mostre";

    return "other";
  }

  function pickEventDate(ev) {
    return (
      parseDateSafe(ev.start) ||
      parseDateSafe(ev.start_date) ||
      parseDateSafe(ev.date) ||
      parseDateSafe(ev.dt_start) ||
      parseDateSafe(ev.when) ||
      null
    );
  }

  function pickEventPlace(ev) {
    const lat = Number(ev.lat ?? ev.location?.lat ?? ev.venue?.lat);
    const lon = Number(ev.lon ?? ev.lng ?? ev.location?.lon ?? ev.location?.lng ?? ev.venue?.lon ?? ev.venue?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const name = String(ev.title ?? ev.name ?? "Evento").trim();
    const area = String(ev.city ?? ev.area ?? ev.place ?? ev.location?.city ?? ev.location?.name ?? "").trim();
    const country = String(ev.country_code ?? ev.country ?? ev.cc ?? ev.location?.country ?? "").trim().toUpperCase();

    return { lat, lon, name, area, country };
  }

  function filterByWhen(evDate, whenKey, now) {
    const wk = normalizeWhenKey(whenKey);

    const today0 = startOfDay(now);
    const todayEnd = endOfDay(now);

    if (wk === "oggi") {
      if (!evDate) return false;
      return withinRange(evDate, today0, todayEnd);
    }
    if (wk === "7giorni") {
      if (!evDate) return false;
      const to = endOfDay(new Date(today0.getTime() + 7 * 24 * 3600 * 1000));
      return withinRange(evDate, today0, to);
    }
    if (wk === "30giorni") {
      if (!evDate) return false;
      const to = endOfDay(new Date(today0.getTime() + 30 * 24 * 3600 * 1000));
      return withinRange(evDate, today0, to);
    }
    if (wk === "weekend") {
      if (!evDate) return false;
      const { from, to } = nextWeekendRange(now);
      return withinRange(evDate, from, to);
    }
    return true;
  }

  function filterByType(ev, typeKey) {
    const tk = normalizeTypeKey(typeKey);
    if (tk === "tutti") return true;

    const t = normalizeEventTypeFromEvent(ev);
    // match diretto
    if (t === tk) return true;

    // tolleranza: se tk è "mostre" e evento è "other" ma ha culture/cultura nel testo
    if (tk === "mostre") {
      const s = String(ev.category || ev.title || "").toLowerCase();
      if (s.includes("culture") || s.includes("cultura") || s.includes("mostra") || s.includes("museo")) return true;
    }

    return false;
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
    const s = String(q || "").trim();
    if (!s) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lon)}`;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s)}&center=${encodeURIComponent(lat + "," + lon)}`;
  }
  function googleUrl(q) {
    return `https://www.google.com/search?q=${encodeURIComponent(String(q || ""))}`;
  }

  async function fetchJsonNoStore(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }

  function setEventsCounter(n) {
    // prova più id possibili (per la tua UI)
    const ids = ["eventsCount", "eventsCounter", "eventsFound"];
    for (const id of ids) {
      const el = $(id);
      if (el) {
        el.textContent = `Eventi: trovati ${Number(n) || 0} ✅`;
        return;
      }
    }
  }

  function render(origin, rows, meta, helpers, state, debugNote = "") {
    const area = $("resultArea");
    if (!area) return;

    const escapeHtml = helpers.escapeHtml || ((x) => String(x || ""));

    const updated = meta?.updated_at ? String(meta.updated_at).replace("T", " ").slice(0, 16) : "—";
    const totalCount = Number(meta?.count ?? rows.length);

    setEventsCounter(rows.length);

    if (!rows.length) {
      area.innerHTML = `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
          <div style="font-weight:950; font-size:18px;">Nessun evento trovato</div>
          <div class="small muted" style="margin-top:8px; line-height:1.45;">
            Prova a cambiare sottocategoria oppure aumenta i minuti.
          </div>
          <div class="small muted" style="margin-top:10px;">
            Dataset: updated <b>${escapeHtml(updated)}</b> • count <b>${escapeHtml(totalCount)}</b>
            ${debugNote ? `<br><span class="small muted">${escapeHtml(debugNote)}</span>` : ""}
          </div>
        </div>
      `;
      return;
    }

    const head = rows[0];
    const shown = rows.slice(0, state.shown);

    const cards = shown.map((x) => {
      const title = escapeHtml(x.title);
      const areaLabel = escapeHtml(x.area || x.country || "—");
      const when = escapeHtml(fmtWhen(x.date));
      const km = Math.round(x.km);
      const mins = x.driveMin;
      const typeLabel = escapeHtml(x.typeLabel);

      const q = `${x.title}${x.area ? " " + x.area : ""}`;

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

    const canMore = state.shown < rows.length;

    area.innerHTML = `
      <div class="card clickSafe" style="box-shadow:none; border-color:rgba(0,224,255,.25); background:rgba(0,224,255,.06);">
        <div style="font-weight:950; font-size:18px;">Eventi trovati (${rows.length})</div>
        <div class="small muted" style="margin-top:8px; line-height:1.45;">
          Primo: <b>${escapeHtml(head.title)}</b> • ~${head.driveMin} min<br>
          Dataset: updated <b>${escapeHtml(updated)}</b> • totale <b>${escapeHtml(totalCount)}</b>
          ${debugNote ? `<br><span class="small muted">${escapeHtml(debugNote)}</span>` : ""}
        </div>
        <div class="small muted" style="margin-top:6px;">
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
          render(origin, rows, meta, helpers, state, debugNote);
          setTimeout(() => moreBtn.scrollIntoView({ behavior: "smooth", block: "center" }), 20);
        },
        { once: true }
      );
    }
  }

  function buildRows({ events, origin, maxM, eventType, eventWhen, haversineKm, estCarMinutesFromKm }) {
    const now = new Date();
    const rows = [];

    for (const ev of events) {
      const loc = pickEventPlace(ev);
      if (!loc) continue;

      const d = pickEventDate(ev);
      if (!filterByWhen(d, eventWhen, now)) continue;
      if (!filterByType(ev, eventType)) continue;

      const km = haversineKm(origin.lat, origin.lon, loc.lat, loc.lon);
      const driveMin = estCarMinutesFromKm(km);
      if (!Number.isFinite(driveMin) || driveMin > maxM) continue;

      const typeLabel = normalizeEventTypeFromEvent(ev) || "other";

      rows.push({
        title: loc.name,
        area: loc.area,
        country: loc.country,
        lat: loc.lat,
        lon: loc.lon,
        date: d,
        km,
        driveMin,
        typeLabel
      });
    }

    rows.sort((a, b) => {
      const da = a.date ? a.date.getTime() : 9e15;
      const db = b.date ? b.date.getTime() : 9e15;
      return (a.driveMin - b.driveMin) || (da - db);
    });

    return rows;
  }

  async function run(args) {
    const origin = args?.origin;
    const maxMinutes = args?.maxMinutes;
    const eventTypeRaw = String(args?.eventType || "tutti");
    const eventWhenRaw = String(args?.eventWhen || "oggi");

    const haversineKm = args?.haversineKm;
    const estCarMinutesFromKm = args?.estCarMinutesFromKm;
    const escapeHtml = args?.escapeHtml || ((x) => String(x || ""));
    const showStatus = args?.showStatus;
    const scrollToId = args?.scrollToId;

    const eventType = normalizeTypeKey(eventTypeRaw);
    const eventWhen = normalizeWhenKey(eventWhenRaw);

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
      setEventsCounter(0);
      scrollToId?.("resultCard");
      return;
    }

    const events = Array.isArray(payload?.events) ? payload.events : [];
    const maxM = clamp(Number(maxMinutes) || 120, 10, 600);

    // --- 3-step fallback per "MANY RESULTS"
    // step0: filtri richiesti
    let rows = buildRows({
      events, origin, maxM,
      eventType, eventWhen,
      haversineKm, estCarMinutesFromKm
    });
    let note = "";

    // step1: se 0 e tipo non è tutti -> togli tipo
    if (!rows.length && eventType !== "tutti") {
      rows = buildRows({
        events, origin, maxM,
        eventType: "tutti", eventWhen,
        haversineKm, estCarMinutesFromKm
      });
      note = "Fallback: ho tolto il filtro tipo per trovare più eventi.";
    }

    // step2: se ancora 0 -> allarga a 30 giorni
    if (!rows.length && eventWhen !== "30giorni") {
      rows = buildRows({
        events, origin, maxM,
        eventType: "tutti", eventWhen: "30giorni",
        haversineKm, estCarMinutesFromKm
      });
      note = "Fallback: ho allargato a 30 giorni per trovare più eventi.";
    }

    // step3: se ancora 0 -> togli anche filtro quando (ma sempre minuti)
    if (!rows.length) {
      rows = buildRows({
        events, origin, maxM,
        eventType: "tutti", eventWhen: "tutti",
        haversineKm, estCarMinutesFromKm
      });
      note = "Fallback: ho tolto anche il filtro quando (resta il limite minuti).";
    }

    const state = { shown: pageSize, page: pageSize };
    render(origin, rows, payload, { escapeHtml }, state, note);

    showStatus?.("ok", `Eventi: trovati ${rows.length} ✅`);
    scrollToId?.("resultCard");
  }

  window.JAMO_EVENTS = { run };
})();
