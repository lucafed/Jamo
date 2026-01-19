/* Jamo — events.js v1.3 (SAFE + OFFLINE FIRST + MANY RESULTS + LOAD MORE)
 * - Legge: /data/events/events_all.json
 * - Filtra: tipo + quando (oggi/weekend/7giorni/30giorni)
 * - Ordina: distanza + data (eventi senza data vanno in fondo, ma in dataset ci saranno quasi sempre date)
 * - Render in #resultArea con paginazione: 12 + "Carica altri"
 * - Espone: window.JAMO_EVENTS.run(...)
 */

(() => {
  "use strict";

  const EVENTS_URL = "/data/events/events_all.json";
  const $ = (id) => document.getElementById(id);

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

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

  function normalizeType(t) {
    const s = String(t || "").toLowerCase().trim();
    if (!s) return "tutti";

    if (/(sagra|street\s*food|degust|vino|enogastr|food|taste|beer|birra)/.test(s)) return "sagre";
    if (/(concert|live|music|dj|spettacol)/.test(s)) return "concerti";
    if (/(mostr|museum|exhibit|arte|galleria)/.test(s)) return "mostre";
    if (/(fiera|festival|fair|expo|mercatin)/.test(s)) return "fiere";
    if (/(family|kids|child|bambin|ragazz)/.test(s)) return "family";
    if (/(sport|corsa|maratona|trail|run|bike|bici|cycling|mtb|moto|motor|raduno|enduro)/.test(s)) return "sport";

    return s;
  }

  function pickEventDate(ev) {
    return (
      parseDateSafe(ev.start) ||
      parseDateSafe(ev.start_date) ||
      parseDateSafe(ev.date) ||
      parseDateSafe(ev.dt_start) ||
      parseDateSafe(ev.when)
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
    return true;
  }

  function filterByType(ev, typeKey) {
    if (!typeKey || typeKey === "tutti") return true;

    const t =
      normalizeType(ev.category) ||
      normalizeType(ev.kind) ||
      normalizeType(ev.type) ||
      normalizeType(Array.isArray(ev.tags) ? ev.tags.join(" ") : "") ||
      normalizeType(ev.title);

    return t === typeKey;
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

  function render(origin, rows, meta, helpers, state) {
    const area = $("resultArea");
    if (!area) return;

    const escapeHtml = helpers.escapeHtml || ((x) => String(x || ""));

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
      moreBtn.addEventListener("click", () => {
        state.shown = Math.min(rows.length, state.shown + state.page);
        render(origin, rows, meta, helpers, state);
        setTimeout(() => moreBtn.scrollIntoView({ behavior: "smooth", block: "center" }), 20);
      }, { once: true });
    }
  }

  async function run(args) {
    const origin = args?.origin;
    const maxMinutes = args?.maxMinutes;
    const eventType = String(args?.eventType || "tutti");
    const eventWhen = String(args?.eventWhen || "oggi");

    const haversineKm = args?.haversineKm;
    const estCarMinutesFromKm = args?.estCarMinutesFromKm;
    const escapeHtml = args?.escapeHtml || ((x) => String(x || ""));
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

      const typeLabel = normalizeType(ev.category || ev.kind || ev.type || ev.title) || "tutti";

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

    const state = { shown: pageSize, page: pageSize };
    render(origin, rows, payload, { escapeHtml }, state);

    showStatus?.("ok", `Eventi: trovati ${rows.length} ✅`);
    scrollToId?.("resultCard");
  }

  window.JAMO_EVENTS = { run };
})();
