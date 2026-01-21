/* public/events.js — MAI FATTO (offline suggestions) — index.html compatible
 * Render target: #resultArea
 * Dataset: /data/events/events_all.json
 */

(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  const EVENTS_URL = "/data/events/events_all.json";

  // ---------------- helpers ----------------
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

  function approxMinutesFromKm(km) {
    // stima auto: 60 km/h + overhead 8 min
    return Math.round((km / 60) * 60 + 8);
  }

  function mapsDirUrl(lat, lon, mode) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
      `${lat},${lon}`
    )}&travelmode=${encodeURIComponent(mode || "driving")}`;
  }

  function getActiveChipValue(containerId, attr) {
    const box = $(containerId);
    if (!box) return "";
    const active = box.querySelector(".chip.active");
    if (!active) return "";
    return (active.getAttribute(attr) || "").trim();
  }

  function getOrigin() {
    const lat = Number($("originLat")?.value);
    const lon = Number($("originLon")?.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  }

  function getMaxMinutes() {
    const n = Number($("maxMinutes")?.value);
    return Number.isFinite(n) ? n : 120;
  }

  function getCategory() {
    return getActiveChipValue("categoryChips", "data-cat").toLowerCase();
  }

  // sottofiltri Eventi (se ti servono ancora)
  function getEventType() {
    return getActiveChipValue("eventTypeChips", "data-etype").toLowerCase() || "tutti";
  }
  function getEventWhen() {
    return getActiveChipValue("eventWhenChips", "data-ewhen").toLowerCase() || "oggi";
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

  function catLabel(cat) {
    const m = {
      natura: "natura",
      trekking: "trekking",
      borghi: "borghi",
      storia: "storia",
      montagna: "montagna",
      mare: "mare",
      relax: "relax",
      family: "family",
      cantine: "cantine",
      eventi: "mai fatto", // UI
      pioggia: "pioggia",
      sport: "sport",
      night: "sera",
      culture: "cultura",
      music: "musica",
      sagre: "sagre",
    };
    const k = String(cat || "").toLowerCase().trim();
    return m[k] || (k || "idea");
  }

  function badge(txt) {
    return `<span class="chip" style="cursor:default;">${esc(txt)}</span>`;
  }

  async function loadDataset() {
    const r = await fetch(`${EVENTS_URL}?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} loading ${EVENTS_URL}`);
    return await r.json();
  }

  // ---------------- render ----------------
  function renderHeader(meta) {
    const updated = meta?.updated_at ? fmtDate(meta.updated_at) : "";
    const total = meta?.count ?? 0;

    return `
      <div class="card" style="margin-bottom:12px;">
        <div class="hTitle">Mai fatto</div>
        <div class="small muted">
          Dataset: ${updated ? `aggiornato ${esc(updated)}` : "offline"} • totale ${esc(total)}
        </div>
      </div>
    `;
  }

  function renderEmpty(msg) {
    const area = $("resultArea");
    if (!area) return;
    area.innerHTML = `
      <div class="card">
        <div class="hTitle">Nessuna proposta</div>
        <div class="small muted">${esc(msg || "Prova ad aumentare i minuti o cambia categoria.")}</div>
      </div>
    `;
  }

  function renderItems(items, origin) {
    const area = $("resultArea");
    if (!area) return;

    const html = items
      .map((e) => {
        const title = e.title || "Idea";
        const where = nicePlaceLine(e);
        const when = e.start ? fmtDate(e.start) : "";
        const why = e.why || "";
        const howArr = Array.isArray(e.how) ? e.how : [];
        const howHtml =
          howArr.length > 0
            ? `<div class="hr"></div>
               <div class="small"><b>Come farla</b></div>
               <ul style="margin:8px 0 0 18px; padding:0;">
                 ${howArr.slice(0, 5).map((x) => `<li class="small muted" style="margin:6px 0;">${esc(x)}</li>`).join("")}
               </ul>`
            : "";

        const dur = e.duration_min ? `• ~${esc(e.duration_min)} min` : "";
        let distKm = "";
        if (origin && typeof e.lat === "number" && typeof e.lon === "number") {
          const km = haversineKm(origin.lat, origin.lon, e.lat, e.lon);
          distKm = `• ~${Math.round(km)} km`;
        }

        const lat = e.lat;
        const lon = e.lon;
        const mapsAuto = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "driving") : "";
        const mapsWalk = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "walking") : "";
        const mapsBike = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "bicycling") : "";

        const infoUrl = e.url ? String(e.url) : "";

        return `
          <div class="card resultCard" style="margin-top:12px;">
            <div class="hTitle" style="margin-bottom:6px;">${esc(title)}</div>
            <div class="small muted">${where ? `📍 ${esc(where)}` : ""}${when ? ` • 🗓️ ${esc(when)}` : ""} ${dur} ${distKm}</div>

            <div class="chiprow" style="margin-top:10px;">
              ${badge("Mai fatto")}
              ${badge(catLabel(e.category))}
            </div>

            ${why ? `<div class="hr"></div><div class="small"><b>Perché vale</b></div><div class="small muted" style="margin-top:6px;">${esc(why)}</div>` : ""}

            ${howHtml}

            <div class="actionGrid" style="margin-top:12px;">
              ${mapsAuto ? `<a class="btn btnPrimary" href="${esc(mapsAuto)}" target="_blank" rel="noopener">🚗 Auto</a>` : `<span></span>`}
              ${infoUrl ? `<a class="btnGhost" href="${esc(infoUrl)}" target="_blank" rel="noopener">🔎 Info</a>` : `<span></span>`}
              ${mapsWalk ? `<a class="btnGhost" href="${esc(mapsWalk)}" target="_blank" rel="noopener">🚶 A piedi</a>` : `<span></span>`}
              ${mapsBike ? `<a class="btnGhost" href="${esc(mapsBike)}" target="_blank" rel="noopener">🚴 Bici</a>` : `<span></span>`}
            </div>

            <div class="small muted" style="margin-top:10px; opacity:.8;">
              ${e.source ? `Fonte: ${esc(e.source)}` : ""}
            </div>
          </div>
        `;
      })
      .join("");

    area.innerHTML = html;
  }

  // ---------------- selection logic ----------------
  function pickSuggestions(datasetEvents, origin, maxMin, category) {
    let list = Array.isArray(datasetEvents) ? datasetEvents.slice() : [];

    // Normalizza categoria: nella UI hai "eventi" ma nel dataset può essere "pioggia/relax/..." ecc.
    // Qui: se non sei in "eventi", filtriamo per categoria uguale.
    // Se sei in "eventi", NON filtriamo "eventi" ma usiamo i sottofiltri come macro-tag.
    const cat = (category || "").toLowerCase().trim();

    if (cat && cat !== "eventi") {
      list = list.filter((e) => String(e.category || "").toLowerCase() === cat);
    } else if (cat === "eventi") {
      // Eventi = "Mai fatto": usiamo etype come filtro su category dove ha senso
      const etype = getEventType(); // tutti/sagre/concerti/mostre/fiere/family/sport
      if (etype && etype !== "tutti") {
        // mappa etype -> categories possibili del dataset
        const map = {
          sagre: ["sagre", "local"],
          concerti: ["music"],
          mostre: ["culture"],
          fiere: ["local", "culture"],
          family: ["family"],
          sport: ["sport"],
        };
        const allowed = map[etype] || [];
        if (allowed.length) {
          list = list.filter((e) => allowed.includes(String(e.category || "").toLowerCase()));
        }
      }

      // when: oggi/weekend/7giorni (filtra in base a start)
      const ewhen = getEventWhen();
      const now = new Date();
      const startOfDay = new Date(now); startOfDay.setHours(0,0,0,0);

      function isWeekend(d) {
        const day = d.getDay(); // 0 dom, 6 sab
        return day === 0 || day === 6;
      }

      if (ewhen === "oggi") {
        list = list.filter((e) => {
          const d = e.start ? new Date(e.start) : null;
          if (!d || Number.isNaN(d.getTime())) return false;
          return d >= startOfDay && d < new Date(startOfDay.getTime() + 24*3600*1000);
        });
      } else if (ewhen === "weekend") {
        list = list.filter((e) => {
          const d = e.start ? new Date(e.start) : null;
          if (!d || Number.isNaN(d.getTime())) return false;
          return isWeekend(d);
        });
      } else if (ewhen === "7giorni") {
        const limit = new Date(now.getTime() + 7*24*3600*1000);
        list = list.filter((e) => {
          const d = e.start ? new Date(e.start) : null;
          if (!d || Number.isNaN(d.getTime())) return false;
          return d >= now && d <= limit;
        });
      }
    }

    // distanza/tempo
    if (origin) {
      list = list
        .map((e) => {
          if (typeof e.lat !== "number" || typeof e.lon !== "number") return null;
          const km = haversineKm(origin.lat, origin.lon, e.lat, e.lon);
          const mins = approxMinutesFromKm(km);
          return { e, mins };
        })
        .filter(Boolean)
        .filter((x) => x.mins <= (maxMin || 120))
        .sort((a, b) => a.mins - b.mins)
        .map((x) => x.e);
    }

    // massimo 6
    return list.slice(0, 6);
  }

  // ---------------- main refresh ----------------
  let DATASET = null;

  async function refreshMaiFatto() {
    try {
      const area = $("resultArea");
      if (area) area.innerHTML = `<div class="small muted" style="padding:6px 2px;">Carico “Mai fatto”…</div>`;

      if (!DATASET) DATASET = await loadDataset();

      const origin = getOrigin();
      const maxMin = getMaxMinutes();
      const cat = getCategory();

      const events = Array.isArray(DATASET.events) ? DATASET.events : [];
      if (!events.length) return renderEmpty("Dataset vuoto.");

      const picked = pickSuggestions(events, origin, maxMin, cat);
      if (!picked.length) {
        return renderEmpty("Niente di coerente entro il tempo scelto. Aumenta i minuti o cambia categoria.");
      }

      const header = renderHeader(DATASET);
      $("resultArea").innerHTML = header; // header + cards sotto
      // poi append cards
      const tmp = document.createElement("div");
      tmp.innerHTML = "";
      $("resultArea").insertAdjacentHTML("beforeend", ""); // no-op

      // render cards
      // (renderItems sovrascrive: quindi uniamo header + items)
      const saved = $("resultArea").innerHTML;
      renderItems(picked, origin);
      $("resultArea").innerHTML = saved + $("resultArea").innerHTML;
    } catch (e) {
      console.error(e);
      renderEmpty("Errore nel caricare “Mai fatto”. Controlla che esista /data/events/events_all.json.");
    }
  }

  // expose
  window.refreshMaiFatto = refreshMaiFatto;

})();
