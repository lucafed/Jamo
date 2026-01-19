/* Jamo — events.js v1.0
 * Offline events loader + filter + render
 * Reads: /data/events/events_all.json
 * Exposes: window.__jamo_events.runEventSearch(...)
 */

(() => {
  "use strict";

  const EVENTS_URL = "/data/events/events_all.json";

  const $ = (id) => document.getElementById(id);
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

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function norm(s) {
    return String(s ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function parseDateMaybe(x) {
    if (!x) return null;
    if (typeof x === "number") {
      const d = new Date(x);
      return isNaN(d.getTime()) ? null : d;
    }
    const s = String(x).trim();
    if (!s) return null;
    // ISO / RFC / "YYYY-MM-DD"
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;

    // try YYYY-MM-DD HH:mm
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
    if (m) {
      const yy = Number(m[1]), mm = Number(m[2]) - 1, dd = Number(m[3]);
      const hh = Number(m[4] || 0), mi = Number(m[5] || 0);
      const d2 = new Date(yy, mm, dd, hh, mi, 0, 0);
      return isNaN(d2.getTime()) ? null : d2;
    }
    return null;
  }

  function guessCategory(ev) {
    // if already provided, keep it
    const c0 = String(ev.category || ev.cat || ev.type || "").toLowerCase().trim();
    if (c0) return c0;

    const hay = norm([ev.title, ev.name, ev.summary, ev.description, ev.place, ev.location].join(" "));
    // family
    if (/(bambin|family|kids|bimbi|bimbo|parco giochi|planetar|zoo|acquari|lunapark|circo)/.test(hay)) return "family";
    // moto / bici
    if (/(moto|motoclub|motoraduno|bike week|harley|vespa|enduro|cross|motocross)/.test(hay)) return "moto";
    if (/(bici|cicl|mtb|gravel|bike|pedalat|ciclotur|ciclist)/.test(hay)) return "bici";
    // sport
    if (/(gara|trail run|maraton|mezza maraton|triathlon|corsa|run|running|torneo|match|campionat|sport)/.test(hay)) return "sport";
    // music
    if (/(concerto|live|dj set|festival|musica|band|orchestra|opera|jazz|rock)/.test(hay)) return "music";
    // culture
    if (/(mostra|museo|teatro|spettacol|cinema|rassegna|cultur|visita guidata|tour)/.test(hay)) return "culture";
    // food / market
    if (/(sagra|degust|vino|cantin|street food|mercat|fiera|stand gastronom)/.test(hay)) return "food";

    return "other";
  }

  function normalizeEvent(raw, fallback = {}) {
    if (!raw || typeof raw !== "object") return null;

    const title = String(raw.title || raw.name || raw.summary || raw.event || "").trim();
    if (!title) return null;

    const lat = Number(raw.lat ?? raw.latitude ?? raw.geo?.lat ?? fallback.lat);
    const lon = Number(raw.lon ?? raw.lng ?? raw.longitude ?? raw.geo?.lon ?? raw.geo?.lng ?? fallback.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const start =
      parseDateMaybe(raw.start) ||
      parseDateMaybe(raw.start_at) ||
      parseDateMaybe(raw.start_ts) ||
      parseDateMaybe(raw.dtstart) ||
      parseDateMaybe(raw.date) ||
      parseDateMaybe(raw.begin) ||
      null;

    const end =
      parseDateMaybe(raw.end) ||
      parseDateMaybe(raw.end_at) ||
      parseDateMaybe(raw.end_ts) ||
      parseDateMaybe(raw.dtend) ||
      null;

    // if no start, discard (we can't filter "today/weekend")
    if (!start) return null;

    const url = String(raw.url || raw.link || raw.website || raw.source_url || "").trim();
    const place = String(raw.place || raw.venue || raw.location || raw.city || fallback.place || "").trim();
    const country = String(raw.country || raw.cc || raw.country_code || fallback.country || "").toUpperCase().trim();

    const category = guessCategory(raw);

    const id =
      String(raw.id || raw.uid || raw.guid || raw.event_id || "").trim() ||
      `ev_${norm(title).slice(0, 48)}_${start.getTime()}_${String(lat).slice(0, 8)}_${String(lon).slice(0, 8)}`;

    return { id, title, start, end, lat, lon, url, place, country, category, raw };
  }

  async function loadEventsAll() {
    const r = await fetch(EVENTS_URL, { cache: "no-store" });
    if (!r.ok) throw new Error(`Impossibile caricare eventi (HTTP ${r.status})`);
    const j = await r.json().catch(() => null);
    if (!j) throw new Error("events_all.json non è JSON valido");

    const list = Array.isArray(j.events) ? j.events : [];
    // Some builders may store per-source arrays, try flatten
    const alt =
      Array.isArray(j.items) ? j.items :
      (j.sources && Array.isArray(j.sources) ? j.sources.flatMap(s => s.events || []) : []);

    const eventsRaw = list.length ? list : (alt || []);
    return { meta: j, eventsRaw };
  }

  function isToday(d) {
    const now = new Date();
    return d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
  }

  function isWeekend(d) {
    const day = d.getDay();
    return day === 6 || day === 0;
  }

  function inNextDays(d, days) {
    const now = new Date();
    const start = now.getTime();
    const end = start + days * 24 * 60 * 60 * 1000;
    const t = d.getTime();
    return t >= start - 2 * 60 * 60 * 1000 && t <= end; // tiny grace
  }

  function matchesWhen(startDate, when) {
    const w = String(when || "oggi").toLowerCase();
    if (w === "oggi") return isToday(startDate);
    if (w === "weekend") return isWeekend(startDate) && inNextDays(startDate, 14);
    if (w === "7g" || w === "7" || w === "settimana") return inNextDays(startDate, 7);
    if (w === "30g" || w === "30") return inNextDays(startDate, 30);
    if (w === "60g" || w === "60") return inNextDays(startDate, 60);
    // fallback: show upcoming
    return inNextDays(startDate, 60);
  }

  function matchesType(category, type) {
    const t = String(type || "tutti").toLowerCase();
    if (t === "tutti" || t === "all") return true;
    const c = String(category || "other").toLowerCase();
    if (t === c) return true;

    // allow grouping: "sport" also includes moto/bici if you want
    if (t === "sport" && (c === "moto" || c === "bici")) return true;

    return false;
  }

  function fmtDateIt(d) {
    try {
      return d.toLocaleString("it-IT", {
        weekday: "short",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return d.toISOString();
    }
  }

  function mapsDirUrl(oLat, oLon, dLat, dLon) {
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
      oLat + "," + oLon
    )}&destination=${encodeURIComponent(
      dLat + "," + dLon
    )}&travelmode=driving`;
  }

  function scoreEvent({ driveMin, hoursToStart, targetMin }) {
    // closer to target minutes is better
    const t = clamp(1 - Math.abs(driveMin - targetMin) / Math.max(18, targetMin * 0.9), 0, 1);
    // sooner is better (but not past)
    const soon = clamp(1 - hoursToStart / 96, 0, 1); // 0..4 days
    return 0.62 * t + 0.33 * soon + (driveMin <= 45 ? 0.05 : 0);
  }

  function renderEventsUI({ origin, maxMinutes, etype, ewhen, events, updatedAt, showStatus }) {
    const area = $("resultArea");
    if (!area) return;

    if (!events.length) {
      area.innerHTML = `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
          <div style="font-weight:950; font-size:18px;">😕 Nessun evento trovato</div>
          <div class="small muted" style="margin-top:8px; line-height:1.45;">
            Filtri: <b>${escapeHtml(etype)}</b> • <b>${escapeHtml(ewhen)}</b> • entro <b>${escapeHtml(maxMinutes)} min</b><br>
            Prova: aumenta i minuti oppure cambia filtri “Tipo/Quando”.
          </div>
          <div class="small muted" style="margin-top:10px;">
            Dataset: ${updatedAt ? `aggiornato ${escapeHtml(updatedAt)}` : "non disponibile"}
          </div>
        </div>`;
      showStatus?.("warn", "Eventi: nessun risultato con questi filtri.");
      return;
    }

    const rows = events.map((ev) => {
      const km = ev.km;
      const min = ev.driveMin;

      const badge =
        ev.category === "family" ? "👨‍👩‍👧‍👦 Family" :
        ev.category === "moto" ? "🏍️ Moto" :
        ev.category === "bici" ? "🚴 Bici" :
        ev.category === "sport" ? "🏟️ Sport" :
        ev.category === "music" ? "🎵 Musica" :
        ev.category === "culture" ? "🏛️ Cultura" :
        ev.category === "food" ? "🍝 Food" :
        "🎉 Evento";

      const place = ev.place || ev.country || "—";

      const btnInfo = ev.url
        ? `<button class="btnGhost" data-ev-open="${escapeHtml(ev.url)}" type="button">🔗 Info</button>`
        : "";

      return `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(0,224,255,.14); background:rgba(255,255,255,.03);">
          <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start;">
            <div style="font-weight:1000; font-size:18px; line-height:1.15;">${escapeHtml(ev.title)}</div>
            <div class="pill soft" style="white-space:nowrap;">🚗 ~${escapeHtml(min)} min</div>
          </div>

          <div class="optMeta" style="margin-top:10px;">
            <span class="pill acc">${badge}</span>
            <span class="pill soft">📅 ${escapeHtml(fmtDateIt(ev.start))}</span>
            <span class="pill soft">📍 ${escapeHtml(place)}</span>
            <span class="pill soft">🗺️ ${escapeHtml(Math.round(km))} km</span>
          </div>

          <div class="row wraprow" style="gap:10px; margin-top:12px;">
            <button class="btn btnPrimary" data-ev-go="${escapeHtml(ev.id)}" type="button">🧭 Vai</button>
            ${btnInfo}
          </div>
        </div>
      `;
    }).join("");

    area.innerHTML = `
      <div class="card clickSafe" style="box-shadow:none; border-color:rgba(0,224,255,.25); background:rgba(0,224,255,.06);">
        <div style="font-weight:950; font-size:18px;">🎉 Eventi</div>
        <div class="small muted" style="margin-top:6px;">
          Filtri: <b>${escapeHtml(etype)}</b> • <b>${escapeHtml(ewhen)}</b> • entro <b>${escapeHtml(maxMinutes)} min</b>
          ${updatedAt ? `• dataset: ${escapeHtml(updatedAt)}` : ""}
        </div>
      </div>
      ${rows}
    `;

    // delegation for buttons
    area.addEventListener("click", (e) => {
      const go = e.target.closest("[data-ev-go]");
      if (go) {
        const id = go.getAttribute("data-ev-go");
        const ev = events.find(x => x.id === id);
        if (!ev) return;
        window.open(mapsDirUrl(origin.lat, origin.lon, ev.lat, ev.lon), "_blank", "noopener");
        return;
      }
      const open = e.target.closest("[data-ev-open]");
      if (open) {
        const url = open.getAttribute("data-ev-open");
        if (url) window.open(url, "_blank", "noopener");
      }
    }, { once: true });
  }

  async function runEventSearch(opts) {
    const origin = opts?.origin;
    const showStatus = opts?.showStatus;
    const scrollToId = opts?.scrollToId;

    if (!origin || !Number.isFinite(Number(origin.lat)) || !Number.isFinite(Number(origin.lon))) {
      showStatus?.("err", "Eventi: prima imposta la partenza.");
      scrollToId?.("quickStartCard");
      return;
    }

    const maxMinutes = clamp(Number(opts?.maxMinutesInput || 120), 10, 600);
    const etype = String(opts?.getEventType?.() || "tutti");
    const ewhen = String(opts?.getEventWhen?.() || "oggi");

    // progress
    const area = $("resultArea");
    if (area) {
      area.innerHTML = `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,180,80,.35); background:rgba(255,180,80,.06);">
          <div style="font-weight:950; font-size:18px;">🔎 Cerco eventi…</div>
          <div class="small muted" style="margin-top:8px;">Dataset offline: ${escapeHtml(EVENTS_URL)}</div>
        </div>`;
    }

    let meta = null, eventsRaw = [];
    try {
      const loaded = await loadEventsAll();
      meta = loaded.meta;
      eventsRaw = loaded.eventsRaw || [];
    } catch (e) {
      console.error(e);
      showStatus?.("err", `Eventi: ${String(e.message || e)}`);
      if (area) {
        area.innerHTML = `
          <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
            <div style="font-weight:950;">❌ Errore eventi</div>
            <div class="small muted" style="margin-top:8px; line-height:1.45;">
              ${escapeHtml(String(e.message || e))}
            </div>
          </div>`;
      }
      return;
    }

    const updatedAt = String(meta?.updated_at || meta?.updatedAt || "").trim();

    const fallback = { lat: null, lon: null, place: "", country: "" };

    const now = Date.now();
    const normalized = [];
    for (const raw of eventsRaw) {
      const ev = normalizeEvent(raw, fallback);
      if (!ev) continue;
      // discard past events (ended long ago)
      if (ev.end && ev.end.getTime() < now - 2 * 60 * 60 * 1000) continue;
      if (!ev.end && ev.start.getTime() < now - 6 * 60 * 60 * 1000) continue;
      normalized.push(ev);
    }

    // compute distance/minutes + filter
    const list = [];
    for (const ev of normalized) {
      const km = haversineKm(origin.lat, origin.lon, ev.lat, ev.lon);
      const driveMin = opts?.estCarMinutesFromKm ? opts.estCarMinutesFromKm(km) : Math.round((km * 1.25 / 72) * 60 + 8);
      if (!Number.isFinite(driveMin) || driveMin > maxMinutes) continue;
      if (!matchesType(ev.category, etype)) continue;
      if (!matchesWhen(ev.start, ewhen)) continue;

      const hoursToStart = (ev.start.getTime() - now) / (60 * 60 * 1000);
      if (hoursToStart < -6) continue;

      const score = scoreEvent({ driveMin, hoursToStart, targetMin: maxMinutes });

      list.push({ ...ev, km, driveMin, hoursToStart, score: Number(score.toFixed(4)) });
    }

    // dedupe by id + same title near same day
    const seen = new Set();
    const out = [];
    for (const ev of list.sort((a, b) => (b.score - a.score) || (a.driveMin - b.driveMin) || (a.start - b.start))) {
      if (seen.has(ev.id)) continue;
      const key = `${norm(ev.title).slice(0, 40)}_${ev.start.toDateString()}_${Math.round(ev.lat * 100)}_${Math.round(ev.lon * 100)}`;
      if (seen.has(key)) continue;
      seen.add(ev.id);
      seen.add(key);
      out.push(ev);
      if (out.length >= 40) break;
    }

    renderEventsUI({ origin, maxMinutes, etype, ewhen, events: out, updatedAt, showStatus });
    showStatus?.("ok", `Eventi: trovati ${out.length} risultati ✅`);
    scrollToId?.("resultCard");
  }

  window.__jamo_events = { runEventSearch };
})();
