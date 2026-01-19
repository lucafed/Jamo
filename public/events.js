/* Jamo — events.js v1.0 (OFFLINE-FIRST + UI RENDER)
 * - Usa dataset: /data/events/events_all.json
 * - Filtri: tipo (sagre/concerti/mostre/fiere/family/sport/tutti) + quando (oggi/weekend/7giorni)
 * - Ordina per distanza + data
 * - Render dentro #resultArea (stile coerente con app.js)
 *
 * Dipendenze (passate da app.js tramite runEventsSearchBridge):
 * - origin, maxMinutes, eventType, eventWhen
 * - haversineKm, estCarMinutesFromKm, escapeHtml, showStatus, scrollToId
 */

(() => {
  "use strict";

  const EVENTS_URL = "/data/events/events_all.json";

  const $ = (id) => document.getElementById(id);

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const toISODate = (d) => {
    try { return new Date(d).toISOString().slice(0, 10); } catch { return ""; }
  };

  function parseDateSafe(x) {
    if (!x) return null;
    const d = new Date(x);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
           a.getMonth() === b.getMonth() &&
           a.getDate() === b.getDate();
  }

  function nextWeekendRange(now) {
    // weekend = sab+dom prossimi (o corrente)
    const d = startOfDay(now);
    const day = d.getDay(); // 0 dom, 6 sab
    const saturday = new Date(d);
    const sunday = new Date(d);

    // se oggi è sabato: saturday=today; sunday=tomorrow
    // se oggi è domenica: weekend = oggi (solo domenica) + (opz) ieri? no. prendiamo oggi.
    if (day === 6) {
      sunday.setDate(sunday.getDate() + 1);
      return { from: saturday, to: endOfDay(sunday) };
    }
    if (day === 0) {
      return { from: d, to: endOfDay(d) };
    }

    const deltaToSat = (6 - day);
    saturday.setDate(saturday.getDate() + deltaToSat);
    sunday.setDate(sunday.getDate() + deltaToSat + 1);
    return { from: saturday, to: endOfDay(sunday) };
  }

  function endOfDay(d) {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
  }

  function withinRange(dateObj, from, to) {
    if (!dateObj) return false;
    const t = dateObj.getTime();
    return t >= from.getTime() && t <= to.getTime();
  }

  function normalizeType(t) {
    const s = String(t || "").toLowerCase().trim();
    if (!s) return "tutti";
    // accetta varie forme
    if (s.includes("sagra") || s.includes("food") || s.includes("vino") || s.includes("beer")) return "sagre";
    if (s.includes("concert") || s.includes("live") || s.includes("music") || s.includes("dj")) return "concerti";
    if (s.includes("mostr") || s.includes("museum") || s.includes("exhibit") || s.includes("arte")) return "mostre";
    if (s.includes("fiera") || s.includes("festival") || s.includes("fair")) return "fiere";
    if (s.includes("family") || s.includes("kids") || s.includes("bambin")) return "family";
    if (s.includes("sport") || s.includes("corsa") || s.includes("run") || s.includes("bike") || s.includes("cycling") || s.includes("moto") || s.includes("motor")) return "sport";
    return s;
  }

  function pickEventDate(ev) {
    // supporta vari campi possibili
    // preferenza: start_date / start / date
    const d =
      parseDateSafe(ev.start_date) ||
      parseDateSafe(ev.start) ||
      parseDateSafe(ev.date) ||
      parseDateSafe(ev.dt_start) ||
      parseDateSafe(ev.when);
    return d;
  }

  function pickEventPlace(ev) {
    const lat = Number(ev.lat ?? ev.location?.lat ?? ev.venue?.lat);
    const lon = Number(ev.lon ?? ev.lng ?? ev.location?.lon ?? ev.location?.lng ?? ev.venue?.lon ?? ev.venue?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const name = String(ev.title ?? ev.name ?? "Evento").trim();
    const area = String(ev.city ?? ev.area ?? ev.place ?? ev.location?.city ?? ev.location?.name ?? "").trim();
    const country = String(ev.country ?? ev.cc ?? ev.location?.country ?? "").trim().toUpperCase();

    return { lat, lon, name, area, country };
  }

  function mapsSearchUrl(q, lat, lon) {
    const s = String(q || "").trim();
    if (!s) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lon)}`;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s)}&center=${encodeURIComponent(lat + "," + lon)}`;
  }

  function googleUrl(q) {
    return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  }

  function formatWhen(d) {
    if (!d) return "Data da confermare";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    // se ora è 00:00, meglio solo data
    if (hh === "00" && mi === "00") return `${dd}/${mm}/${yyyy}`;
    return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
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
      return withinRange(evDate, today0, todayEnd) || isSameDay(evDate, now);
    }

    if (whenKey === "7giorni") {
      if (!evDate) return false;
      const to = endOfDay(new Date(today0.getTime() + 7 * 24 * 3600 * 1000));
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
      normalizeType(ev.type) ||
      normalizeType(ev.category) ||
      normalizeType(ev.kind) ||
      normalizeType(ev.tags?.join?.(" ")) ||
      normalizeType(ev.title);

    if (typeKey === "sagre") return t === "sagre";
    if (typeKey === "concerti") return t === "concerti";
    if (typeKey === "mostre") return t === "mostre";
    if (typeKey === "fiere") return t === "fiere";
    if (typeKey === "family") return t === "family";
    if (typeKey === "sport") return t === "sport";

    return t === typeKey;
  }

  function renderEvents(origin, rows, meta, helpers) {
    const area = $("resultArea");
    if (!area) return;

    const { escapeHtml } = helpers;

    const updated = meta?.updated_at ? String(meta.updated_at).replace("T", " ").slice(0, 16) : "—";
    const totalCount = Number(meta?.count ?? rows.length);

    if (!rows.length) {
      area.innerHTML = `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
          <div style="font-weight:950; font-size:18px;">❌ Nessun evento trovato</div>
          <div class="small muted" style="margin-top:8px; line-height:1.45;">
            Prova a cambiare <b>sottocategoria</b> o aumentare i minuti.
          </div>
          <div class="small muted" style="margin-top:10px;">
            Dataset eventi: updated <b>${escapeHtml(updated)}</b> • count <b>${escapeHtml(totalCount)}</b>
          </div>
        </div>
      `;
      return;
    }

    const top = rows[0];
    const cards = rows.slice(0, 20).map((x) => {
      const title = escapeHtml(x.title);
      const areaLabel = escapeHtml(x.area || x.country || "—");
      const when = escapeHtml(formatWhen(x.date));
      const km = Math.round(x.km);
      const mins = x.driveMin;

      const pillType = escapeHtml(x.typeLabel);

      return `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(0,224,255,.14); background:rgba(255,255,255,.03);">
          <div style="font-weight:950; font-size:18px; line-height:1.2;">${title}</div>
          <div class="small muted" style="margin-top:6px;">
            📍 ${areaLabel} • 🗓️ ${when}
          </div>
          <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">
            <span class="pill acc">🎉 Eventi</span>
            <span class="pill soft">🏷️ ${pillType}</span>
            <span class="pill soft">🚗 ~${mins} min • ${km} km</span>
          </div>

          <div class="row wraprow" style="gap:10px; margin-top:12px;">
            <button class="btn btnPrimary" type="button"
              data-open="maps"
              data-q="${escapeHtml(title + (x.area ? " " + x.area : ""))}"
              data-lat="${x.lat}"
              data-lon="${x.lon}"
              style="flex:1; min-width:180px;"
            >🧭 Vai / Mappa</button>

            <button class="btnGhost" type="button"
              data-open="google"
              data-q="${escapeHtml(title + (x.area ? " " + x.area : ""))}"
            >🔎 Info</button>
          </div>
        </div>
      `;
    }).join("");

    area.innerHTML = `
      <div class="card clickSafe" style="box-shadow:none; border-color:rgba(0,224,255,.25); background:rgba(0,224,255,.06);">
        <div style="font-weight:950; font-size:18px;">🎉 Eventi trovati (${rows.length})</div>
        <div class="small muted" style="margin-top:8px; line-height:1.45;">
          Primo: <b>${escapeHtml(top.title)}</b> • ~${top.driveMin} min<br>
          Dataset: updated <b>${escapeHtml(updated)}</b> • totale <b>${escapeHtml(totalCount)}</b>
        </div>
      </div>

      <div style="margin-top:12px; display:flex; flex-direction:column; gap:10px;">
        ${cards}
      </div>
    `;

    // delegation click
    area.addEventListener("click", (e) => {
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
    }, { once: true });
  }

  async function run(args) {
    const {
      origin,
      maxMinutes,
      eventType,
      eventWhen,
      haversineKm,
      estCarMinutesFromKm,
      escapeHtml,
      showStatus,
      scrollToId
    } = args || {};

    const area = $("resultArea");
    if (area) {
      area.innerHTML = `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,180,80,.35); background:rgba(255,180,80,.06);">
          <div style="font-weight:950; font-size:18px;">🔎 Cerco eventi…</div>
          <div class="small muted" style="margin-top:8px; line-height:1.45;">
            Tipo: <b>${escapeHtml(eventType || "tutti")}</b> • Quando: <b>${escapeHtml(eventWhen || "oggi")}</b>
          </div>
        </div>
      `;
    }

    let payload;
    try {
      payload = await fetchJsonNoStore(EVENTS_URL);
    } catch (e) {
      showStatus?.("err", `Eventi: impossibile caricare ${EVENTS_URL}`);
      if (area) {
        area.innerHTML = `
          <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
            <div style="font-weight:950; font-size:18px;">❌ Eventi offline non disponibili</div>
            <div class="small muted" style="margin-top:8px; line-height:1.45;">
              Manca <b>${escapeHtml(EVENTS_URL)}</b> oppure non è stato committato.
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
      if (!filterByWhen(d, String(eventWhen || "oggi"), now)) continue;
      if (!filterByType(ev, String(eventType || "tutti"))) continue;

      const km = haversineKm(origin.lat, origin.lon, loc.lat, loc.lon);
      const driveMin = estCarMinutesFromKm(km);
      if (!Number.isFinite(driveMin) || driveMin > maxM) continue;

      const typeLabel = normalizeType(ev.type || ev.category || ev.kind || ev.title) || "tutti";

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

    renderEvents(origin, rows, payload, {
      escapeHtml
    });

    showStatus?.("ok", `Eventi: trovati ${rows.length} ✅`);
    scrollToId?.("resultCard");
  }

  window.JAMO_EVENTS = { run };
})();
