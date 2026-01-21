/* public/events.js — JAMO_EVENTS bridge (MAI FATTO / Idee offline)
 * Compatibile con app.js v22.2 (chiama window.JAMO_EVENTS.run)
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

  // Quante idee mostrare (alza pure: 12 / 18 / 24)
  const SHOW_LIMIT = 18;

  // ---------- helpers ----------
  const esc = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  function norm(s) {
    return String(s ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function normalizeCategory(s) {
    const k = norm(s);
    if (!k) return "";
    // normalizzazioni utili
    if (k === "family") return "famiglia";
    if (k === "kids") return "famiglia";
    if (k === "bambini") return "famiglia";
    if (k === "bike") return "bici";
    if (k === "cycling") return "bici";
    if (k === "motorbike") return "moto";
    if (k === "motorcycle") return "moto";
    if (k === "food") return "mangiare";
    if (k === "cibo") return "mangiare";
    if (k === "rain") return "pioggia";
    if (k === "sunset") return "tramonto";
    if (k === "wellness") return "relax";
    if (k === "spa") return "relax";
    return k;
  }

  function fmtDateShort(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  function fmtUpdated(iso) {
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
    const place = (e.place || "").trim();
    const city = (e.city || "").trim();
    const region = (e.region || "").trim();

    // preferisci: place • city • region
    if (place && city) {
      if (norm(place) !== norm(city)) return `${place} • ${city}${region ? " • " + region : ""}`;
      return `${city}${region ? " • " + region : ""}`;
    }
    if (city) return `${city}${region ? " • " + region : ""}`;
    if (place) return `${place}${region ? " • " + region : ""}`;
    return region || "";
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

  function googleSearchUrl(q) {
    return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  }

  // ---------- dataset cache ----------
  let DATASET = null;

  async function loadDataset() {
    const r = await fetch(`${EVENTS_URL}?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} loading ${EVENTS_URL}`);
    return await r.json();
  }

  // ---------- distance ----------
  function approxMinutesFromKm(km, estCarMinutesFromKm) {
    if (typeof estCarMinutesFromKm === "function") return estCarMinutesFromKm(km);
    return Math.round((km / 60) * 60 + 8);
  }

  // ---------- category mapping (UI sottocategorie -> dataset) ----------
  // Qui decidiamo cosa significa ogni chip “Mai fatto”
  const UI_ALIASES = {
    tutti: ["tutti"],

    relax: ["relax", "spa", "wellness", "terme", "benessere"],
    famiglia: ["famiglia", "family", "kids", "bambini", "bimbo", "child", "children"],
    bici: ["bici", "bike", "cycling", "ciclabile"],
    moto: ["moto", "motorbike", "motorcycle"],
    natura: ["natura", "nature", "bosco", "parco", "sentiero"],
    pioggia: ["pioggia", "rain", "coperto", "indoor"],
    tramonto: ["tramonto", "sunset", "belvedere", "panorama"],
    mangiare: ["mangiare", "food", "osteria", "ristorante", "cantina", "degustazione", "enoteca"],

    "1ora": ["1h", "1 ora", "1ora", "onehour"],
    "2ore": ["2h", "2 ore", "2ore", "twohours"],
  };

  function matchEventToUIType(e, uiType) {
    const t = normalizeCategory(uiType || "tutti");
    if (!t || t === "tutti") return true;

    const allowed = UI_ALIASES[t] || [t];

    const c = normalizeCategory(e.category || "");
    const title = String(e.title || "").toLowerCase();
    const why = String(e.why || "").toLowerCase();

    // match:
    // 1) category (se coerente)
    // 2) testo (title/why) per casi reali “misti”
    // 3) durata per 1h/2h (se presente)
    if (t === "1ora") {
      const dur = Number(e.duration_min);
      if (Number.isFinite(dur)) return dur >= 35 && dur <= 95;
      // se non c’è durata, prova testo
      return title.includes("1 ora") || why.includes("1 ora");
    }
    if (t === "2ore") {
      const dur = Number(e.duration_min);
      if (Number.isFinite(dur)) return dur >= 96 && dur <= 170;
      return title.includes("2 ore") || why.includes("2 ore");
    }

    return allowed.some((k) => {
      const kk = normalizeCategory(k);
      return c === kk || title.includes(k) || why.includes(k);
    });
  }

  // ---------- selection: “tantissime idee” con widen automatico ----------
  // window.__JAMO_MAIFATTO_WIDEN = { baseMM, chosenMM }
  function pickIdeas({
    all,
    origin,
    maxMinutes,
    eventType,
    haversineKm,
    estCarMinutesFromKm
  }) {
    let list = Array.isArray(all) ? all.slice() : [];
    const baseMM = Number(maxMinutes) || 30;

    // 1) filtro sottocategoria “Mai fatto”
    list = list.filter((e) => matchEventToUIType(e, eventType));

    const oOk = origin && typeof origin.lat === "number" && typeof origin.lon === "number";
    if (!oOk) {
      window.__JAMO_MAIFATTO_WIDEN = { baseMM, chosenMM: baseMM };
      return list.slice(0, SHOW_LIMIT);
    }

    // 2) calcolo minuti e ordino per vicinanza
    const withMins = list
      .map((e) => {
        if (typeof e.lat !== "number" || typeof e.lon !== "number") return null;
        const km = typeof haversineKm === "function"
          ? haversineKm(origin.lat, origin.lon, e.lat, e.lon)
          : null;
        const mins = km == null ? null : approxMinutesFromKm(km, estCarMinutesFromKm);
        if (!Number.isFinite(mins)) return null;
        return { e, mins };
      })
      .filter(Boolean)
      .sort((a, b) => a.mins - b.mins);

    // 3) widen steps (riempi sempre)
    const steps = [
      baseMM,
      Math.min(45, Math.round(baseMM * 1.5)),
      Math.min(60, Math.round(baseMM * 2)),
      90,
      120,
      180
    ].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);

    let chosenMM = steps[0];

    const withinBase = withMins.filter(x => x.mins <= baseMM);
    if (withinBase.length >= SHOW_LIMIT) {
      window.__JAMO_MAIFATTO_WIDEN = { baseMM, chosenMM: baseMM };
      return withinBase.slice(0, SHOW_LIMIT).map(x => x.e);
    }

    for (const mm of steps) {
      const within = withMins.filter(x => x.mins <= mm);
      if (within.length >= Math.max(10, Math.min(SHOW_LIMIT, 18))) {
        chosenMM = mm;
        break;
      }
      // se non arriva mai, rimane l’ultimo step
      chosenMM = mm;
    }

    window.__JAMO_MAIFATTO_WIDEN = { baseMM, chosenMM };

    const withinChosen = withMins.filter(x => x.mins <= chosenMM);

    // Ordine: prima entro baseMM, poi “riempimento”
    const ordered = [
      ...withinChosen.filter(x => x.mins <= baseMM),
      ...withinChosen.filter(x => x.mins > baseMM)
    ];

    return ordered.slice(0, SHOW_LIMIT).map(x => x.e);
  }

  // ---------- render ----------
  function renderIntoResultArea({ items, origin, meta, maxMinutes }) {
    const area = document.getElementById("resultArea");
    if (!area) return;

    const updated = meta?.updated_at ? fmtUpdated(meta.updated_at) : "";
    const total = meta?.count ?? (Array.isArray(meta?.events) ? meta.events.length : 0);

    const widen = window.__JAMO_MAIFATTO_WIDEN || { baseMM: maxMinutes, chosenMM: maxMinutes };
    const extra =
      Number(widen.chosenMM) > Number(widen.baseMM)
        ? ` • incluso fino a ~${esc(widen.chosenMM)} min (per riempire)`
        : "";

    if (!items || !items.length) {
      area.innerHTML = `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
          <div style="font-weight:950; font-size:18px;">😕 Nessuna idea trovata</div>
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
      const placeLine = nicePlaceLine(e);
      const when = e.start ? fmtDateShort(e.start) : "";
      const why = e.why || "";
      const howArr = Array.isArray(e.how) ? e.how : [];

      const howHtml =
        howArr.length > 0
          ? `<ul class="how" style="margin:10px 0 0; padding-left:18px; color:rgba(255,255,255,.82);">
              ${howArr.slice(0, 5).map((x) => `<li style="margin:6px 0;">${esc(x)}</li>`).join("")}
            </ul>`
          : "";

      const cat = String(e.category || "").trim() || "idea";
      const catNice = cat ? cat.charAt(0).toUpperCase() + cat.slice(1) : "Idea";

      const dur = e.duration_min ? `• ~${esc(e.duration_min)} min` : "";
      const urlInfo = e.url ? String(e.url) : "";

      const lat = e.lat;
      const lon = e.lon;

      const mapsAuto = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "driving") : "";
      const mapsWalk = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "walking") : "";
      const mapsBike = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "bicycling") : "";

      // Info fallback: se manca url, fai google search su titolo + città
      const fallbackInfo = !urlInfo
        ? googleSearchUrl(`${title} ${e.city || ""} ${e.region || ""}`.trim())
        : "";

      const infoHref = urlInfo || fallbackInfo;

      return `
        <div class="card clickSafe" style="margin-top:12px; border-color:rgba(0,224,255,.14);">
          <div style="font-weight:950; font-size:20px; line-height:1.1;">${esc(title)}</div>

          <!-- ✅ LUOGO IN EVIDENZA -->
          ${
            placeLine
              ? `<div style="margin-top:8px; font-weight:900; font-size:14px; color:rgba(255,255,255,.90);">
                   📍 ${esc(placeLine)}
                 </div>`
              : ""
          }

          <div class="small muted" style="margin-top:6px; line-height:1.35;">
            ${when ? `🗓️ ${esc(when)} ` : ""}
            ${dur ? ` ${dur}` : ""}
          </div>

          <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
            ${badge("Mai fatto")}
            ${badge(catNice)}
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
              infoHref
                ? `<a class="btnGhost" href="${esc(infoHref)}" target="_blank" rel="noopener">🔎 Info</a>`
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
          Mostrate: ${esc(items.length)} • entro ~${esc(widen.baseMM)} min${extra}
        </div>
      </div>
      ${cards}
    `;
  }

  // ---------- public API ----------
  async function run({
    origin,
    maxMinutes,
    eventType,
    eventWhen, // ignorato per ora (Mai fatto)
    haversineKm,
    estCarMinutesFromKm,
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

      const items = pickIdeas({
        all,
        origin,
        maxMinutes,
        eventType,
        haversineKm,
        estCarMinutesFromKm
      });

      renderIntoResultArea({ items, origin, meta: DATASET, maxMinutes });

      showStatus?.("ok", `Mai fatto: trovate ${items.length} idee ✅`);
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

  // ✅ app.js trova questo
  window.JAMO_EVENTS = { run };

})();
