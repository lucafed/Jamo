/* public/events.js — MAI FATTO (offline suggestions UI)
 * Atteso dataset: /data/events/events_all.json
 * Campi usati:
 *  - title, start, end, lat, lon, place, city, region, country_code
 *  - category, kind ("mai_fatto"), why, how[], duration_min, url
 */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const EVENTS_URL = "/data/events/events_all.json";

  // ---------- helpers ----------
  const esc = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    // formato IT semplice
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
  }

  function kmBetween(aLat, aLon, bLat, bLon) {
    // Haversine
    const R = 6371;
    const toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLon - aLon);
    const lat1 = toRad(aLat);
    const lat2 = toRad(bLat);

    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function mapsDirUrl(lat, lon, mode) {
    // mode: driving | walking | bicycling | transit
    const m = mode || "driving";
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
      `${lat},${lon}`
    )}&travelmode=${encodeURIComponent(m)}`;
  }

  function nicePlaceLine(e) {
    const city = (e.city || "").trim();
    const place = (e.place || "").trim();
    const region = (e.region || "").trim();

    // se city è vuota, almeno place/region
    if (city) {
      // se place diverso da city, mostra entrambi
      if (place && place.toLowerCase() !== city.toLowerCase()) {
        return `${place} • ${city}${region ? " • " + region : ""}`;
      }
      return `${city}${region ? " • " + region : ""}`;
    }

    // no city
    if (place && region) return `${place} • ${region}`;
    return place || region || "";
  }

  function categoryLabel(cat) {
    const m = {
      relax: "relax",
      pioggia: "pioggia",
      family: "family",
      sagre: "sagre",
      culture: "cultura",
      music: "musica",
      sport: "sport",
      night: "sera",
      cantine: "cantine",
      borghi: "borghi",
      trekking: "trekking",
      mare: "mare",
      montagna: "montagna",
      storia: "storia",
      moto: "moto",
      bici: "bici",
    };
    const k = (cat || "").toLowerCase().trim();
    return m[k] || (k || "idea");
  }

  function badge(label) {
    return `<span class="chip">${esc(label)}</span>`;
  }

  // ---------- state ----------
  let DATASET = null;

  async function loadDataset() {
    const r = await fetch(`${EVENTS_URL}?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} loading ${EVENTS_URL}`);
    const json = await r.json();
    return json;
  }

  // ---------- render ----------
  function renderHeader(meta) {
    const el = $("eventsMeta");
    if (!el) return;

    const updated = meta?.updated_at ? fmtDate(meta.updated_at) : "";
    const total = meta?.count ?? 0;

    el.innerHTML = `
      <div class="events-meta">
        <div class="events-title">Mai fatto</div>
        <div class="events-sub">
          Dataset: ${updated ? `aggiornato ${esc(updated)}` : "offline"} • totale ${esc(total)}
        </div>
      </div>
    `;
  }

  function renderEmpty(msg) {
    const box = $("eventsResults");
    if (!box) return;
    box.innerHTML = `
      <div class="card soft">
        <div class="card-title">Nessuna proposta</div>
        <div class="card-sub">${esc(msg || "Prova ad allargare tempo/distanza o cambia categoria.")}</div>
      </div>
    `;
  }

  function renderList(items, origin) {
    const box = $("eventsResults");
    if (!box) return;

    const rows = items.map((e) => {
      const title = e.title || "Idea";
      const when = e.start ? fmtDate(e.start) : "";
      const where = nicePlaceLine(e);
      const why = e.why || "";
      const howArr = Array.isArray(e.how) ? e.how : [];
      const howHtml =
        howArr.length > 0
          ? `<ul class="how">${howArr
              .slice(0, 4)
              .map((x) => `<li>${esc(x)}</li>`)
              .join("")}</ul>`
          : "";

      const cat = categoryLabel(e.category);
      const kind = e.kind === "mai_fatto" ? "Mai fatto" : "Idea";

      let distKm = "";
      if (origin && typeof e.lat === "number" && typeof e.lon === "number") {
        const km = kmBetween(origin.lat, origin.lon, e.lat, e.lon);
        distKm = `• ~${Math.round(km)} km`;
      }

      const dur = e.duration_min ? `• ~${esc(e.duration_min)} min` : "";

      const urlInfo = e.url ? String(e.url) : "";
      const lat = e.lat;
      const lon = e.lon;

      const mapsAuto = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "driving") : "";
      const mapsWalk = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "walking") : "";
      const mapsBike = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "bicycling") : "";

      return `
        <div class="card result">
          <div class="card-head">
            <div class="card-title">${esc(title)}</div>
            <div class="card-sub">
              ${where ? `📍 ${esc(where)}` : ""}
              ${when ? ` • 🗓️ ${esc(when)}` : ""}
              ${dur} ${distKm}
            </div>
            <div class="chips">
              ${badge(kind)}
              ${badge(cat)}
            </div>
          </div>

          ${
            why
              ? `<div class="why"><strong>Perché vale:</strong> ${esc(why)}</div>`
              : ""
          }

          ${howHtml}

          <div class="actions">
            ${
              mapsAuto
                ? `<a class="btn primary" href="${esc(mapsAuto)}" target="_blank" rel="noopener">🚗 Auto</a>`
                : ""
            }
            ${
              mapsWalk
                ? `<a class="btn" href="${esc(mapsWalk)}" target="_blank" rel="noopener">🚶 A piedi</a>`
                : ""
            }
            ${
              mapsBike
                ? `<a class="btn" href="${esc(mapsBike)}" target="_blank" rel="noopener">🚴 Bici</a>`
                : ""
            }
            ${
              urlInfo
                ? `<a class="btn ghost" href="${esc(urlInfo)}" target="_blank" rel="noopener">🔎 Info</a>`
                : ""
            }
          </div>

          <div class="tiny">
            ${e.source ? `Fonte: ${esc(e.source)}` : ""}
          </div>
        </div>
      `;
    });

    box.innerHTML = rows.join("");
  }

  // ---------- selection logic ----------
  function getOriginFromUI() {
    // Se nella tua app c’è già una origin globale, usala.
    // Proviamo alcune variabili comuni senza rompere nulla.
    const w = window;

    // 1) window.JAMO_ORIGIN = {lat,lon} (se esiste)
    if (w.JAMO_ORIGIN && typeof w.JAMO_ORIGIN.lat === "number" && typeof w.JAMO_ORIGIN.lon === "number") {
      return { lat: w.JAMO_ORIGIN.lat, lon: w.JAMO_ORIGIN.lon };
    }

    // 2) window.__origin = {lat,lon}
    if (w.__origin && typeof w.__origin.lat === "number" && typeof w.__origin.lon === "number") {
      return { lat: w.__origin.lat, lon: w.__origin.lon };
    }

    // 3) input hidden/field (se li hai)
    const latEl = $("originLat");
    const lonEl = $("originLon");
    if (latEl && lonEl) {
      const lat = Number(latEl.value);
      const lon = Number(lonEl.value);
      if (!Number.isNaN(lat) && !Number.isNaN(lon)) return { lat, lon };
    }

    return null;
  }

  function currentCategoryFromUI() {
    // Prova a leggere una select/id standard.
    const sel = $("eventCategory") || $("eventsCategory") || $("category");
    if (sel && sel.value) return String(sel.value).toLowerCase().trim();
    // fallback: se hai una variabile globale
    if (window.__eventsCategory) return String(window.__eventsCategory).toLowerCase().trim();
    return "";
  }

  function maxMinutesFromUI() {
    const el = $("maxMinutes") || $("rangeMinutes") || $("minutes");
    if (el && el.value) {
      const n = Number(el.value);
      return Number.isFinite(n) ? n : 180;
    }
    if (window.__maxMinutes) return Number(window.__maxMinutes) || 180;
    return 180;
  }

  // Stima veloce minuti basata su distanza (senza routing vero)
  function approxMinutes(km) {
    // media 60 km/h + overhead
    return Math.round((km / 60) * 60 + 8);
  }

  function pickSuggestions(all, origin, category, maxMin) {
    // filtro categoria
    let list = all;
    if (category) {
      list = list.filter((e) => String(e.category || "").toLowerCase() === category);
    }

    // filtra raggio/tempo se origin presente
    if (origin) {
      list = list
        .map((e) => {
          if (typeof e.lat !== "number" || typeof e.lon !== "number") return null;
          const km = kmBetween(origin.lat, origin.lon, e.lat, e.lon);
          const mins = approxMinutes(km);
          return { e, km, mins };
        })
        .filter(Boolean)
        .filter((x) => x.mins <= (maxMin || 180))
        .sort((a, b) => a.mins - b.mins) // più vicino prima
        .map((x) => x.e);
    }

    // al massimo 6 (puoi aumentare)
    return list.slice(0, 6);
  }

  // ---------- public API ----------
  async function refreshMaiFatto() {
    try {
      if (!DATASET) DATASET = await loadDataset();
      renderHeader(DATASET);

      const origin = getOriginFromUI();
      const category = currentCategoryFromUI();
      const maxMin = maxMinutesFromUI();

      const all = Array.isArray(DATASET.events) ? DATASET.events : [];
      if (all.length === 0) return renderEmpty("Dataset vuoto.");

      const items = pickSuggestions(all, origin, category, maxMin);
      if (!items.length) {
        return renderEmpty("Niente di coerente entro il tempo scelto. Prova ad aumentare i minuti o cambia categoria.");
      }

      renderList(items, origin);
    } catch (err) {
      console.error(err);
      renderEmpty("Errore nel caricare ‘Mai fatto’. Controlla che esista /data/events/events_all.json.");
    }
  }

  // espongo una funzione globale che puoi chiamare dal bottone "CERCA"
  window.refreshMaiFatto = refreshMaiFatto;

  // auto-run se vuoi (se hai già un pannello aperto)
  // refreshMaiFatto();

})();
