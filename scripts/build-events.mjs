/* Jamo — events.js v1.5 (MAX RESULTS • OFFLINE-FIRST • SMART FALLBACKS)
 * - Input: /data/events/events_all.json
 * - Filtri: tipo + quando (oggi/weekend/7giorni/30giorni)
 * - Fallback automatici se troppo pochi risultati
 * - Ordina: driveMin ASC, poi data ASC (date mancanti in fondo)
 * - Render in #resultArea con paginazione: 12 + "Carica altri"
 * - API: window.JAMO_EVENTS.run({ origin, maxMinutes, eventType, eventWhen, ...helpers })
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
    const day = d.getDay(); // 0 dom .. 6 sab
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

  // --- TYPE NORMALIZATION (soft matching) ---
  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function detectTypeKeyFromText(text) {
    const s = norm(text);
    if (!s) return "";

    if (/(sagra|street food|degust|vino|enogastr|food|taste|beer|birra|mercato|mercatino)/.test(s))
      return "sagre";
    if (/(concert|live|music|dj|spettacol|teatro|opera|festival musicale)/.test(s))
      return "concerti";
    if (/(mostr|exhibit|arte|galleria|vernissage|museo)/.test(s))
      return "mostre";
    if (/(fiera|festival|fair|expo|salone|stand)/.test(s))
      return "fiere";
    if (/(family|kids|child|bambin|ragazz|laboratorio|animazione)/.test(s))
      return "family";
    if (/(sport|corsa|maratona|trail|run|bike|bici|cycling|mtb|moto|raduno|enduro|gara|torneo)/.test(s))
      return "sport";

    return "";
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

  function pickEventCoords(ev) {
    const lat = Number(ev.lat ?? ev.location?.lat ?? ev.venue?.lat);
    const lon = Number(ev.lon ?? ev.lng ?? ev.location?.lon ?? ev.location?.lng ?? ev.venue?.lon ?? ev.venue?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  }

  function pickEventTitle(ev) {
    return String(ev.title ?? ev.name ?? "Evento").trim() || "Evento";
  }

  function pickEventArea(ev) {
    return String(ev.city ?? ev.area ?? ev.place ?? ev.location?.city ?? ev.location?.name ?? "")
      .trim();
  }

  function pickEventCountry(ev) {
    return String(ev.country_code ?? ev.country ?? ev.cc ?? ev.location?.country ?? "")
      .trim()
      .toUpperCase();
  }

  function pickEventUrl(ev) {
    return String(ev.url ?? ev.link ?? ev.website ?? "").trim();
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

  function filterByTypeSoft(ev, typeKey) {
    if (!typeKey || typeKey === "tutti") return true;

    // prova a dedurre il tipo da più campi
    const hay = [
      ev.category,
      ev.kind,
      ev.type,
      Array.isArray(ev.tags) ? ev.tags.join(" ") : "",
      ev.title,
      ev.name
    ].join(" ");

    const detected = detectTypeKeyFromText(hay);
    if (!detected) return false;

    // soft: “sport” matcha anche “trail/run/bike…”
    return detected === typeKey;
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
    // cache-bust per Vercel + SW
    const u = `${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}`;
    const r = await fetch(u, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }

  function render(origin, rows, meta, helpers, state, note) {
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

    const shown = rows.slice(0, state.shown);
    const cards = shown.map((x) => {
      const title = escapeHtml(x.title);
      const areaLabel = escapeHtml(x.area || x.country || "—");
      const when = escapeHtml(fmtWhen(x.date));
      const km = Math
