/* public/events.js — JAMO_EVENTS bridge (MAI FATTO / Suggerimenti offline)
 * Compatibile con app.js v22.2 (runEventsSearchBridge)
 *
 * Dataset atteso: /data/events/events_all.json
 * Struttura minima:
 * {
 *   updated_at: "...",
 *   count: 123,
 *   events: [
 *     { title, start, end, lat, lon, place, city, region, country_code,
 *       category, kind, why, how[], duration_min, url, source }
 *   ]
 * }
 */

(() => {
  "use strict";

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
      concerti: "concerti",
      mostre: "mostre",
      fiere: "fiere",
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
      natura: "natura",
      eventi: "eventi",
    };
    const k = (cat || "").toLowerCase().trim();
    return m[k] || (k || "idea");
  }

  function badge(label) {
    // usa la classe .pill del tuo app.js (mini css)
    return `<span class="pill soft">${esc(label)}</span>`;
  }

  function mapsDirUrl(lat, lon, mode) {
    const m = mode || "driving";
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
      `${lat},${lon}`
    )}&travelmode=${encodeURIComponent(m)}`;
  }

  // ---------- dataset cache ----------
  let DATASET = null;

  async function loadDataset() {
    const r = await fetch(`${EVENTS_URL}?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} loading ${EVENTS_URL}`);
    return await r.json();
  }

  // ---------- selection ----------
  function approxMinutesFromKm(km, estCarMinutesFromKm) {
    // Se app.js passa estCarMinutesFromKm, usiamolo (più coerente)
    if (typeof estCarMinutesFromKm === "function") return estCarMinutesFromKm(km);
    // fallback semplice
    return Math.round((km / 60) * 60 + 8);
  }

  function pickSuggestions({ all, origin, maxMinutes, eventType, eventWhen, haversineKm, estCarMinutesFromKm }) {
    let list = Array.isArray(all) ? all.slice() : [];

    // 1) filtro "tipo" (sottocategoria UI)
    // Mappiamo eventType -> categorie del dataset (che tu stai usando: sagre/music/culture/sport/family ecc.)
    const et = String(eventType || "tutti").toLowerCase();
    if (et && et !== "tutti") {
      const map = {
        sagre: ["sagre", "food", "local"],
        concerti: ["music"],
        mostre: ["culture"],
        fiere: ["festival", "fiere", "market"],
        family: ["family"],
        sport: ["sport"],
      };
      const allowed = map[et] || [et];
      list = list.filter((e) => allowed.includes(String(e.category || "").toLowerCase()));
    }

    // 2) filtro "quando" (oggi / weekend / 7 giorni) — SOLO se l’evento ha start reale
    // Se sono “idee” senza data, le lasciamo comunque (ma nel tuo dataset ora c’è start)
    const ew = String(eventWhen || "oggi").toLowerCase();
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endOfDay = startOfDay + 24 * 60 * 60 * 1000 - 1;

    function isWeekend(ts) {
      const d = new Date(ts);
      const day = d.getDay(); // 0 dom, 6 sab
      return day === 0 || day === 6;
    }

    if (ew === "oggi" || ew === "weekend" || ew === "7giorni") {
      list = list.filter((e) => {
        const ts = e.start ? new Date(e.start).getTime() : NaN;
        if (!Number.isFinite(ts)) return true; // se manca data, non bloccare
        if (ew === "oggi") return ts >= startOfDay && ts <= endOfDay;
        if (ew === "weekend") return isWeekend(ts);
        if (ew === "7giorni") return ts >= startOfDay && ts <= startOfDay + 7 * 24 * 60 * 60 * 1000;
        return true;
      });
    }

    // 3) filtro distanza/tempo (entro maxMinutes) + ordinamento
    const mm = Number(maxMinutes) || 180;

    if (origin && typeof origin.lat === "number" && typeof origin.lon === "number") {
      list = list
        .map((e) => {
          if (typeof e.lat !== "number" || typeof e.lon !== "number") return null;
          const km = typeof haversineKm === "function"
            ? haversineKm(origin.lat, origin.lon, e.lat, e.lon)
            : null;
          const mins = (km == null) ? null : approxMinutesFromKm(km, estCarMinutesFromKm);
          return { e, km, mins };
        })
        .filter(Boolean)
        .filter((x) => (x.mins == null ? true : x.mins <= mm))
        .sort((a, b) => {
          // prima i più vicini, poi quelli con data più prossima
          const am = a.mins ?? 9999;
          const bm = b.mins ?? 9999;
          if (am !== bm) return am - bm;

          const at = a.e.start ? new Date(a.e.start).getTime() : 9e15;
          const bt = b.e.start ? new Date(b.e.start).getTime() : 9e15;
          return at - bt;
        })
        .map((x) => x.e);
    }

    return list.slice(0, 6);
  }

  // ---------- render ----------
  function renderIntoResultArea({ items, origin, meta, maxMinutes }) {
    const area = document.getElementById("resultArea");
    if (!area) return;

    const updated = meta?.updated_at ? fmtDate(meta.updated_at) : "";
    const total = meta?.count ?? (Array.isArray(meta?.events) ? meta.events.length : 0);

    if (!items || !items.length) {
      area.innerHTML = `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
          <div style="font-weight:950; font-size:18px;">😕 Nessuna proposta</div>
          <div class="small muted" style="margin-top:8px; line-height:1.45;">
            Prova ad aumentare i minuti (ora: <b>${esc(maxMinutes)}</b>) oppure cambia sottocategoria.
          </div>
          <div class="small muted" style="margin-top:10px;">
            Dataset: ${updated ? `aggiornato ${esc(updated)}` : "offline"} • totale ${esc(total)}
          </div>
        </div>
      `;
      return;
    }

    const cards = items.map((e) => {
      const title = e.title || "Idea";
      const when = e.start ? fmtDate(e.start) : "";
      const where = nicePlaceLine(e);
      const why = e.why || "";
      const howArr = Array.isArray(e.how) ? e.how : [];
      const howHtml =
        howArr.length > 0
          ? `<ul class="how" style="margin:10px 0 0; padding-left:18px; color:rgba(255,255,255,.82);">
              ${howArr.slice(0, 4).map((x) => `<li style="margin:6px 0;">${esc(x)}</li>`).join("")}
            </ul>`
          : "";

      const kind = e.kind === "mai_fatto" ? "Mai fatto" : "Suggerimento";
      const cat = categoryLabel(e.category);

      let distKm = "";
      if (origin && typeof e.lat === "number" && typeof e.lon === "number") {
        // distanza approssimata (non ripassiamo km qui, ok)
        distKm = "";
      }

      const dur = e.duration_min ? `• ~${esc(e.duration_min)} min` : "";
      const urlInfo = e.url ? String(e.url) : "";

      const lat = e.lat;
      const lon = e.lon;

      const mapsAuto = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "driving") : "";
      const mapsWalk = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "walking") : "";
      const mapsBike = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "bicycling") : "";

      return `
        <div class="card clickSafe" style="margin-top:12px; border-color:rgba(0,224,255,.14);">
          <div style="font-weight:950; font-size:18px; line-height:1.15;">${esc(title)}</div>

          <div class="small muted" style="margin-top:6px; line-height:1.35;">
            ${where ? `📍 ${esc(where)}` : ""}
            ${when ? ` • 🗓️ ${esc(when)}` : ""}
            ${dur} ${distKm}
          </div>

          <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
            ${badge(kind)}
            ${badge(cat)}
          </div>

          ${
            why
              ? `<div class="small muted" style="margin-top:10px; line-height:1.45;">
                   <b style="color:#fff;">Perché vale:</b> ${esc(why)}
                 </div>`
              : ""
          }

          ${howHtml}

          <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:12px;">
            ${
              mapsAuto
                ? `<a class="btn btnPrimary" href="${esc(mapsAuto)}" target="_blank" rel="noopener">🧭 Vai (auto)</a>`
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
                ? `<a class="btnGhost" href="${esc(urlInfo)}" target="_blank" rel="noopener">🔎 Info</a>`
                : ""
            }
          </div>

          <div class="small muted" style="margin-top:10px; opacity:.7;">
            ${e.source ? `Fonte: ${esc(e.source)}` : ""}
          </div>
        </div>
      `;
    }).join("");

    area.innerHTML = `
      <div class="card clickSafe" style="box-shadow:none; border-color:rgba(0,224,255,.20); background:rgba(0,224,255,.05);">
        <div style="font-weight:950; font-size:18px;">✨ Mai fatto — proposte</div>
        <div class="small muted" style="margin-top:6px;">
          ${updated ? `Dataset aggiornato ${esc(updated)}` : "Dataset offline"} • totale ${esc(total)}
        </div>
        <div class="small muted" style="margin-top:6px;">
          Mostrate: ${esc(items.length)} • entro ~${esc(maxMinutes)} min
        </div>
      </div>
      ${cards}
    `;
  }

  // ---------- public API expected by app.js ----------
  async function run({
    origin,
    maxMinutes,
    eventType,
    eventWhen,
    haversineKm,
    estCarMinutesFromKm,
    escapeHtml, // (non necessario, ma app.js lo passa)
    showStatus,
    scrollToId
  }) {
    try {
      if (!DATASET) DATASET = await loadDataset();

      const all = Array.isArray(DATASET?.events) ? DATASET.events : [];
      if (!all.length) {
        showStatus?.("warn", "Dataset ‘Mai fatto’ vuoto.");
        renderIntoResultArea({ items: [], origin, meta: DATASET, maxMinutes });
        scrollToId?.("resultCard");
        return;
      }

      const items = pickSuggestions({
        all,
        origin,
        maxMinutes,
        eventType,
        eventWhen,
        haversineKm,
        estCarMinutesFromKm
      });

      renderIntoResultArea({ items, origin, meta: DATASET, maxMinutes });

      showStatus?.("ok", `Mai fatto: trovate ${items.length} proposte ✅`);
      scrollToId?.("resultCard");
    } catch (err) {
      console.error(err);
      showStatus?.("err", "Errore: manca /data/events/events_all.json oppure non è valido.");
      const area = document.getElementById("resultArea");
      if (area) {
        area.innerHTML = `
          <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
            <div style="font-weight:950; font-size:18px;">❌ Mai fatto non disponibile</div>
            <div class="small muted" style="margin-top:8px; line-height:1.45;">
              Controlla che esista <b>${esc(EVENTS_URL)}</b> e che contenga <b>{ events: [...] }</b>.
            </div>
          </div>
        `;
      }
      scrollToId?.("resultCard");
    }
  }

  // ✅ Questo è ciò che app.js vuole trovare
  window.JAMO_EVENTS = { run };

})();
