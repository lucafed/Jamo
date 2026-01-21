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
 *       category, kind, why, how[], duration_min, url, source, tags[] }
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

  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  const hasAny = (hay, arr) => {
    for (const k of arr) if (hay.includes(k)) return true;
    return false;
  };

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

  function prettyCategoryLabel(cat) {
    // ✅ mai "eventi"
    const k = norm(cat);
    if (!k) return "Idea";
    const map = {
      relax: "Relax",
      family: "Famiglia",
      bici: "Bici",
      moto: "Moto",
      natura: "Natura",
      pioggia: "Pioggia",
      tramonto: "Tramonto",
      mangiare: "Mangiare",
      "1ora": "1 ora",
      "2ore": "2 ore",
      // compat vecchie
      sagre: "Mangiare",
      concerti: "Tramonto",
      mostre: "Natura",
      fiere: "Mangiare",
      sport: "Bici",
      culture: "Natura",
      music: "Tramonto",
      night: "Tramonto",
      market: "Mangiare",
    };
    return map[k] || (k.length <= 18 ? k : "Idea");
  }

  function badge(label) {
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
    if (typeof estCarMinutesFromKm === "function") return estCarMinutesFromKm(km);
    return Math.round((km / 60) * 60 + 8);
  }

  function eventTextBlob(e) {
    const title = norm(e.title);
    const why = norm(e.why);
    const how = Array.isArray(e.how) ? norm(e.how.join(" ")) : "";
    const place = norm(e.place);
    const city = norm(e.city);
    const region = norm(e.region);
    const cat = norm(e.category);
    const kind = norm(e.kind);
    const tags = Array.isArray(e.tags) ? norm(e.tags.join(" ")) : "";
    return `${title} ${why} ${how} ${place} ${city} ${region} ${cat} ${kind} ${tags}`.trim();
  }

  function normalizeEventCategory(e) {
    // categoria "reale" per filtrare meglio, anche se dataset è sporco
    const blob = eventTextBlob(e);
    const cat = norm(e.category);

    // se già è una delle nuove, ok
    if (["relax","family","bici","moto","natura","pioggia","tramonto","mangiare"].includes(cat)) return cat;

    // sinonimi / dataset vecchio
    if (hasAny(blob, ["spa","terme","wellness","sauna","hammam","hamam","benessere","termale"])) return "relax";
    if (hasAny(blob, ["bambin","kids","family","parco giochi","zoo","acquario","fattoria","agriturismo"])) return "family";
    if (hasAny(blob, ["bici","bike","ciclab","cycle","mtb","gravel","pedala","pedal"])) return "bici";
    if (hasAny(blob, ["moto","motor","sella","curve","passo","giro in moto"])) return "moto";
    if (hasAny(blob, ["pioggia","rain","coperto","al coperto","vetrata","cioccolata calda","biblioteca"])) return "pioggia";
    if (hasAny(blob, ["tramonto","sunset","golden hour","belvedere","panorama","vista","alba"])) return "tramonto";
    if (hasAny(blob, ["osteria","trattoria","ristorante","mangiare","cibo","degusta","cantina","enoteca","wine","food","sagra","market","fiera"])) return "mangiare";
    if (hasAny(blob, ["bosco","sentier","parco","riserva","oasi","lago","cascat","natura","valle"])) return "natura";

    // fallback: prova a mappare alcune categorie dataset
    if (["market","sagre","food","local","fiera","fiere"].includes(cat)) return "mangiare";
    if (["concert","concerti","music","musica","night","sera"].includes(cat)) return "tramonto";
    if (["culture","cultura","mostre","mostra","museum","museo"].includes(cat)) return "pioggia";
    if (["sport"].includes(cat)) return "bici";

    return "natura";
  }

  function filterByEventType(list, eventType) {
    const et = norm(eventType || "tutti");
    if (!et || et === "tutti") return list;

    // ✅ supporta nuove sottocategorie + compat vecchie
    const newCats = {
      relax: "relax",
      famiglia: "family",
      family: "family",
      bici: "bici",
      moto: "moto",
      natura: "natura",
      pioggia: "pioggia",
      tramonto: "tramonto",
      mangiare: "mangiare",
      "1ora": "1ora",
      "2ore": "2ore",

      // vecchie (se l’HTML ancora le manda)
      sagre: "mangiare",
      concerti: "tramonto",
      mostre: "pioggia",
      fiere: "mangiare",
      sport: "bici",
    };

    const key = newCats[et] || et;

    // filtri durata (1 ora / 2 ore)
    if (key === "1ora") {
      return list.filter((e) => {
        const d = Number(e.duration_min);
        return Number.isFinite(d) ? d <= 90 : true; // se manca durata, non bloccare
      });
    }
    if (key === "2ore") {
      return list.filter((e) => {
        const d = Number(e.duration_min);
        return Number.isFinite(d) ? d <= 150 : true;
      });
    }

    return list.filter((e) => normalizeEventCategory(e) === key);
  }

  function filterByWhen(list, eventWhen) {
    // ✅ compat: se l’HTML manda ancora oggi/weekend/7giorni, li supportiamo
    const ew = norm(eventWhen || "");
    if (!ew) return list;

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const endOfDay = startOfDay + 24 * 60 * 60 * 1000 - 1;

    function isWeekend(ts) {
      const d = new Date(ts);
      const day = d.getDay();
      return day === 0 || day === 6;
    }

    if (ew === "oggi" || ew === "weekend" || ew === "7giorni") {
      return list.filter((e) => {
        const ts = e.start ? new Date(e.start).getTime() : NaN;
        if (!Number.isFinite(ts)) return true; // se manca data, non bloccare
        if (ew === "oggi") return ts >= startOfDay && ts <= endOfDay;
        if (ew === "weekend") return isWeekend(ts);
        if (ew === "7giorni") return ts >= startOfDay && ts <= startOfDay + 7 * 24 * 60 * 60 * 1000;
        return true;
      });
    }

    // se eventWhen è roba nuova tipo "1 ora / 2 ore", non facciamo nulla qui
    return list;
  }

  function pickSuggestions({ all, origin, maxMinutes, eventType, eventWhen, haversineKm, estCarMinutesFromKm }) {
    let list = Array.isArray(all) ? all.slice() : [];

    // 1) sottocategoria (nuova + compat vecchia)
    list = filterByEventType(list, eventType);

    // 2) quando (compat vecchia)
    list = filterByWhen(list, eventWhen);

    // 3) distanza/tempo + ordinamento
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
          const am = a.mins ?? 9999;
          const bm = b.mins ?? 9999;
          if (am !== bm) return am - bm;

          // se hanno data, più vicino nel tempo
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

      // ✅ sempre "Mai fatto", niente "eventi"
      const kind = "Mai fatto";
      const cat = prettyCategoryLabel(normalizeEventCategory(e));

      const dur = Number.isFinite(Number(e.duration_min)) ? `• ~${esc(e.duration_min)} min` : "";
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
            ${dur}
          </div>

          <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
            ${badge(kind)}
            ${badge(cat)}
          </div>

          ${
            why
              ? `<div class="small muted" style="margin-top:10px; line-height:1.45;">
                   <b style="color:#fff;">Perché è speciale:</b> ${esc(why)}
                 </div>`
              : ""
          }

          ${howHtml}

          <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:12px;">
            ${
              mapsAuto
                ? `<a class="btn btnPrimary" href="${esc(mapsAuto)}" target="_blank" rel="noopener">🧭 Vai</a>`
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
        <div style="font-weight:950; font-size:18px;">✨ MAI FATTO — idee vicine</div>
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
    escapeHtml, // unused (ok)
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
