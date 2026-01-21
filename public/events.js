/* public/events.js — MAI FATTO (offline suggestions for Jamo UI v22.x)
 * Dataset: /data/events/events_all.json
 * RENDER: dentro #resultArea (così non servono eventsMeta/eventsResults)
 * API: window.refreshMaiFatto()
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
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
  }

  function kmBetween(aLat, aLon, bLat, bLon) {
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
    const m = mode || "driving";
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
      `${lat},${lon}`
    )}&travelmode=${encodeURIComponent(m)}`;
  }

  function nicePlaceLine(e) {
    const city = (e.city || "").trim();
    const place = (e.place || "").trim();
    const region = (e.region || "").trim();

    if (city) {
      if (place && place.toLowerCase() !== city.toLowerCase()) {
        return `${place} • ${city}${region ? " • " + region : ""}`;
      }
      return `${city}${region ? " • " + region : ""}`;
    }
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
      eventi: "eventi",
      natura: "natura",
    };
    const k = (cat || "").toLowerCase().trim();
    return m[k] || (k || "idea");
  }

  function badge(label) {
    // stesso look dei chip in index (riuso classe "chip")
    return `<span class="chip" style="display:inline-flex;align-items:center;gap:6px;padding:8px 10px;font-size:12px;font-weight:850;border-radius:999px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.04);">${esc(label)}</span>`;
  }

  // ---------- state ----------
  let DATASET = null;

  async function loadDataset() {
    const r = await fetch(`${EVENTS_URL}?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} loading ${EVENTS_URL}`);
    return await r.json();
  }

  // ---------- UI readers (match your index.html) ----------
  function getOriginFromUI() {
    const latEl = $("originLat");
    const lonEl = $("originLon");
    if (!latEl || !lonEl) return null;
    const lat = Number(latEl.value);
    const lon = Number(lonEl.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  }

  function getMaxMinutesFromUI() {
    const el = $("maxMinutes");
    const n = el ? Number(el.value) : 180;
    return Number.isFinite(n) ? n : 180;
  }

  function getActiveChipValue(containerId, attr) {
    const box = $(containerId);
    if (!box) return "";
    const active = box.querySelector(".chip.active");
    if (!active) return "";
    const v = active.getAttribute(attr);
    return (v || "").toLowerCase().trim();
  }

  function getCategoryFromUI() {
    // categorie principali: data-cat
    return getActiveChipValue("categoryChips", "data-cat");
  }

  function approxMinutes(km) {
    // ~60 km/h + overhead (auto-only)
    return Math.round((km / 60) * 60 + 8);
  }

  // ---------- selection logic ----------
  function pickSuggestions(all, origin, category, maxMin) {
    let list = all;

    // il dataset usa category tipo "relax", "pioggia", "cantine"... ecc.
    // se in UI selezioni "eventi" ma dataset ora è "mai fatto", trattiamo "eventi" come categorie del dataset stesso.
    if (category) {
      list = list.filter((e) => String(e.category || "").toLowerCase().trim() === category);
    }

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
        .sort((a, b) => a.mins - b.mins)
        .map((x) => x.e);
    }

    return list.slice(0, 6);
  }

  // ---------- render into #resultArea ----------
  function renderIntoResultArea(html) {
    const area = $("resultArea");
    if (!area) return;
    area.innerHTML = html;
  }

  function renderEmpty(msg) {
    renderIntoResultArea(`
      <div class="card" style="border:1px solid rgba(255,80,80,.35);background:rgba(255,80,80,.08)">
        <div class="hTitle" style="margin:0 0 6px;">❌ Nessuna proposta</div>
        <div class="small muted">${esc(msg || "Prova ad aumentare i minuti o cambia categoria.")}</div>
      </div>
    `);
  }

  function renderList(items, origin, meta) {
    const updated = meta?.updated_at ? fmtDate(meta.updated_at) : "";
    const total = meta?.count ?? 0;

    const header = `
      <div class="card" style="margin-bottom:12px;">
        <div class="hTitle" style="margin:0 0 6px;">Mai fatto — proposte</div>
        <div class="small muted">Dataset: ${updated ? `aggiornato ${esc(updated)}` : "offline"} • totale ${esc(total)} • mostrati ${items.length}</div>
      </div>
    `;

    const cards = items
      .map((e) => {
        const title = e.title || "Idea";
        const when = e.start ? fmtDate(e.start) : "";
        const where = nicePlaceLine(e);
        const why = e.why || "";
        const howArr = Array.isArray(e.how) ? e.how : [];

        let distKm = "";
        if (origin && typeof e.lat === "number" && typeof e.lon === "number") {
          const km = kmBetween(origin.lat, origin.lon, e.lat, e.lon);
          distKm = ` • ~${Math.round(km)} km`;
        }

        const dur = e.duration_min ? ` • ~${esc(e.duration_min)} min` : "";

        const lat = e.lat;
        const lon = e.lon;

        const mapsAuto = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "driving") : "";
        const mapsWalk = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "walking") : "";
        const mapsBike = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "bicycling") : "";

        const urlInfo = e.url ? String(e.url) : "";

        const howHtml =
          howArr.length > 0
            ? `<div style="margin-top:10px;">
                 <div class="small" style="font-weight:900;margin-bottom:6px;">Come farlo</div>
                 <ul style="margin:0;padding-left:18px;" class="small">
                   ${howArr.slice(0, 4).map((x) => `<li style="margin:4px 0;">${esc(x)}</li>`).join("")}
                 </ul>
               </div>`
            : "";

        return `
          <div class="card" style="border:1px solid rgba(0,224,255,.18);">
            <div class="hTitle" style="margin:0 0 6px;">${esc(title)}</div>
            <div class="small muted">
              ${where ? `📍 ${esc(where)}` : ""}
              ${when ? ` • 🗓️ ${esc(when)}` : ""}
              ${dur}${distKm}
            </div>

            <div style="margin-top:10px; display:flex; flex-wrap:wrap; gap:8px;">
              ${badge("Mai fatto")}
              ${badge(categoryLabel(e.category))}
            </div>

            ${
              why
                ? `<div class="small" style="margin-top:10px;">
                     <b>Perché vale:</b> ${esc(why)}
                   </div>`
                : ""
            }

            ${howHtml}

            <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
              ${mapsAuto ? `<a class="btn btnPrimary" style="flex:1; min-width:140px;" href="${esc(mapsAuto)}" target="_blank" rel="noopener">🚗 Auto</a>` : ""}
              ${mapsWalk ? `<a class="btnGhost" style="flex:1; min-width:140px;" href="${esc(mapsWalk)}" target="_blank" rel="noopener">🚶 A piedi</a>` : ""}
              ${mapsBike ? `<a class="btnGhost" style="flex:1; min-width:140px;" href="${esc(mapsBike)}" target="_blank" rel="noopener">🚴 Bici</a>` : ""}
              ${urlInfo ? `<a class="btnGhost" style="min-width:110px;" href="${esc(urlInfo)}" target="_blank" rel="noopener">🔎 Info</a>` : ""}
            </div>

            <div class="small muted" style="margin-top:10px; opacity:.75;">
              ${e.source ? `Fonte: ${esc(e.source)}` : ""}
            </div>
          </div>
        `;
      })
      .join("");

    renderIntoResultArea(header + cards);
  }

  // ---------- public API ----------
  async function refreshMaiFatto() {
    try {
      if (!DATASET) DATASET = await loadDataset();

      const origin = getOriginFromUI();
      const category = getCategoryFromUI(); // prende il chip selezionato
      const maxMin = getMaxMinutesFromUI();

      const all = Array.isArray(DATASET.events) ? DATASET.events : [];
      if (!all.length) return renderEmpty("Dataset vuoto.");

      const items = pickSuggestions(all, origin, category, maxMin);
      if (!items.length) {
        return renderEmpty("Niente di coerente entro il tempo scelto. Prova ad aumentare i minuti o cambia categoria.");
      }

      renderList(items, origin, DATASET);
    } catch (err) {
      console.error(err);
      renderEmpty("Errore nel caricare ‘Mai fatto’. Controlla che esista /data/events/events_all.json.");
    }
  }

  window.refreshMaiFatto = refreshMaiFatto;

})();
