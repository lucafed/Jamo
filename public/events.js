/* public/events.js — JAMO_MAIFATTO bridge (offline, WOW, REALI)
 * Compatibile con app.js v22.2 (runEventsSearchBridge)
 *
 * ✅ UI: "Eventi" => "✨ Mai fatto"
 * ✅ Sottocategorie (WOW labels) ma filtri = data-etype originali:
 *    relax, famiglia, bici, moto, natura, pioggia, tramonto, mangiare, 1h, 2h
 * ✅ Card nuove: titolo + luogo in evidenza + solo "Perché te lo propongo"
 * ✅ Link "Cosa c'è" (Google Maps search) + "Vai" mantiene partenza della app
 * ✅ Più risultati: limit alto + widening automatico (mm +15/+30/+60 se poche idee)
 *
 * Dataset preferito:
 *  /data/mai_fatto/mai_fatto_it_verona.json
 *  { updated_at, count, ideas:[ { title, lat, lon, place, city, region, category, duration_min, why, url? } ] }
 *
 * Fallback: (solo se NON esiste il dataset curated)
 *  /data/events/events_all.json
 */

(() => {
  "use strict";

  const PRIMARY_URL = "/data/mai_fatto/mai_fatto_it_verona.json";
  const FALLBACK_URL = "/data/events/events_all.json";

  // quante card mostrare
  const SHOW_LIMIT = 24;

  // se entro i minuti scelti trovi meno di questo, widen automatico
  const MIN_GOOD = 10;
  const WIDEN_STEPS = [0, 15, 30, 60]; // minuti extra

  // ---------- helpers ----------
  const esc = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  function fmtDateShort(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  function nicePlaceLine(e) {
    const place = (e.place || "").trim();
    const city = (e.city || "").trim();
    const region = (e.region || "").trim();

    // formato: "Place • City • Region"
    const parts = [];
    if (place) parts.push(place);
    if (city) parts.push(city);
    if (region) parts.push(region);
    return parts.join(" • ");
  }

  function pill(label, soft = true) {
    return `<span class="pill ${soft ? "soft" : ""}">${esc(label)}</span>`;
  }

  function approxMinutesFromKm(km, estCarMinutesFromKm) {
    if (typeof estCarMinutesFromKm === "function") return estCarMinutesFromKm(km);
    return Math.round((km / 60) * 60 + 8);
  }

  function normalizeCategory(c) {
    const k = String(c || "").toLowerCase().trim();
    if (!k) return "";
    if (k === "1 ora" || k === "1h" || k === "1_ora" || k === "1ora") return "1h";
    if (k === "2 ore" || k === "2h" || k === "2_ore" || k === "2ore") return "2h";
    if (k === "family") return "famiglia";
    return k;
  }

  // LABEL WOW (solo UI)
  function wowLabelForType(typeKey) {
    const m = {
      tutti: "⭐ Tutti (wow)",
      relax: "🧖 Reset totale",
      famiglia: "👨‍👩‍👧‍👦 Posti che i bimbi ricordano",
      bici: "🚴 Giro che cambia aria",
      moto: "🏍️ Due curve e sorridi",
      natura: "🌿 Natura che fa scena",
      pioggia: "🌧️ Quando piove è meglio",
      tramonto: "🌅 Tramonto che spacca",
      mangiare: "🍝 Da raccontare dopo",
      "1h": "🕐 1 ora: micro-fuga",
      "2h": "🕑 2 ore: fuori dal mondo",
    };
    return m[typeKey] || typeKey;
  }

  // Badge categoria (pill) nelle card
  function wowPillForCategory(catKey) {
    const m = {
      relax: "Reset totale",
      famiglia: "Posti che i bimbi ricordano",
      bici: "Giro che cambia aria",
      moto: "Due curve e sorridi",
      natura: "Natura che fa scena",
      pioggia: "Quando piove è meglio",
      tramonto: "Tramonto che spacca",
      mangiare: "Da raccontare dopo",
      "1h": "1 ora: micro-fuga",
      "2h": "2 ore: fuori dal mondo",
    };
    return m[catKey] || (catKey ? catKey : "Wow");
  }

  // Google Maps: preserva ORIGIN
  function mapsDirUrlWithOrigin(origin, lat, lon, mode) {
    const m = mode || "driving";
    const dest = `${lat},${lon}`;
    const base = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=${encodeURIComponent(m)}`;

    if (origin && typeof origin.lat === "number" && typeof origin.lon === "number") {
      const o = `${origin.lat},${origin.lon}`;
      return `${base}&origin=${encodeURIComponent(o)}`;
    }
    return base;
  }

  // Link “Cosa c’è” (scheda / ricerca luogo su Maps)
  function mapsSearchUrl(e) {
    const q = [e.place, e.city, e.region].filter(Boolean).join(" ");
    if (!q) return "";
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  }

  // ---------- UI patch ----------
  function patchUI() {
    // chip categoria "eventi" -> "✨ Mai fatto"
    const catChip = document.querySelector('#categoryChips .chip[data-cat="eventi"]');
    if (catChip) catChip.textContent = "✨ Mai fatto";

    // titolo box subfilters
    const box = document.getElementById("eventsSubfilters");
    if (box) {
      box.classList.add("active"); // mostrato solo quando app.js attiva eventi; qui non forziamo oltre
      const smalls = box.querySelectorAll(".small");
      if (smalls && smalls[0]) smalls[0].textContent = "Mai fatto (categoria)";
    }

    // sostituisci i chip dentro eventTypeChips ma con LABEL WOW
    const row = document.getElementById("eventTypeChips");
    if (row) {
      row.innerHTML = `
        <div class="chip active" data-etype="tutti">${wowLabelForType("tutti")}</div>
        <div class="chip" data-etype="relax">${wowLabelForType("relax")}</div>
        <div class="chip" data-etype="famiglia">${wowLabelForType("famiglia")}</div>
        <div class="chip" data-etype="bici">${wowLabelForType("bici")}</div>
        <div class="chip" data-etype="moto">${wowLabelForType("moto")}</div>
        <div class="chip" data-etype="natura">${wowLabelForType("natura")}</div>
        <div class="chip" data-etype="pioggia">${wowLabelForType("pioggia")}</div>
        <div class="chip" data-etype="tramonto">${wowLabelForType("tramonto")}</div>
        <div class="chip" data-etype="mangiare">${wowLabelForType("mangiare")}</div>
        <div class="chip" data-etype="1h">${wowLabelForType("1h")}</div>
        <div class="chip" data-etype="2h">${wowLabelForType("2h")}</div>
      `;
    }

    // NASCONDI "Quando" (eventWhenChips)
    const whenRow = document.getElementById("eventWhenChips");
    if (whenRow) {
      const parent = whenRow.closest("div");
      if (parent) parent.style.display = "none";
    }

    // testo tip
    const info = document.querySelector("#eventsSubfilters .small.muted");
    if (info) info.textContent = "Idee WOW curate (non eventi datati).";
  }

  patchUI();
  setTimeout(patchUI, 50);
  setTimeout(patchUI, 250);

  // ---------- dataset cache ----------
  let DATASET = null;
  let DATASET_META = { updated_at: "", count: 0, source: "" };

  async function fetchJson(url) {
    const r = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} loading ${url}`);
    return await r.json();
  }

  async function loadDataset() {
    // 1) prova curated
    try {
      const j = await fetchJson(PRIMARY_URL);
      const ideas = Array.isArray(j?.ideas) ? j.ideas : [];
      DATASET_META = {
        updated_at: j?.updated_at || "",
        count: j?.count ?? ideas.length,
        source: "curated_mai_fatto",
      };
      return ideas.map((e) => ({
        ...e,
        category: normalizeCategory(e.category),
        source: e.source || "curated_mai_fatto",
      }));
    } catch (_) {
      // 2) fallback solo se manca curated
      const j2 = await fetchJson(FALLBACK_URL);
      const ev = Array.isArray(j2?.events) ? j2.events : [];
      const ideas = ev.map((e) => ({
        id: e.id,
        title: e.title,
        place: e.place,
        city: e.city,
        region: e.region,
        country_code: e.country_code,
        lat: e.lat,
        lon: e.lon,
        category: normalizeCategory(e.category),
        duration_min: e.duration_min,
        why: e.why,
        url: e.url,
        source: e.source || "events_fallback",
      }));
      DATASET_META = {
        updated_at: j2?.updated_at || "",
        count: j2?.count ?? ideas.length,
        source: "events_fallback",
      };
      return ideas;
    }
  }

  // ---------- selection ----------
  function computeMins(origin, e, haversineKm, estCarMinutesFromKm) {
    if (!origin || typeof origin.lat !== "number" || typeof origin.lon !== "number") return null;
    if (typeof e.lat !== "number" || typeof e.lon !== "number") return null;
    const km = typeof haversineKm === "function" ? haversineKm(origin.lat, origin.lon, e.lat, e.lon) : null;
    if (km == null) return null;
    return approxMinutesFromKm(km, estCarMinutesFromKm);
  }

  function pickIdeasOnce({ all, origin, maxMinutes, eventType, haversineKm, estCarMinutesFromKm }) {
    let list = Array.isArray(all) ? all.slice() : [];
    const mm = Number(maxMinutes) || 120;
    const et = normalizeCategory(eventType || "tutti");

    // filtro categoria (solo se specifica)
    if (et && et !== "tutti") {
      list = list.filter((e) => normalizeCategory(e.category) === et);
    }

    // filtro tempo + sort
    if (origin && typeof origin.lat === "number" && typeof origin.lon === "number") {
      list = list
        .map((e) => {
          const mins = computeMins(origin, e, haversineKm, estCarMinutesFromKm);
          return { e, mins };
        })
        .filter((x) => x && x.e)
        .filter((x) => (x.mins == null ? true : x.mins <= mm))
        .sort((a, b) => (a.mins ?? 9999) - (b.mins ?? 9999))
        .map((x) => x.e);
    }

    return list.slice(0, SHOW_LIMIT);
  }

  function pickIdeasWidened(args) {
    const baseMm = Number(args.maxMinutes) || 120;

    for (const plus of WIDEN_STEPS) {
      const items = pickIdeasOnce({ ...args, maxMinutes: baseMm + plus });
      if (items.length >= MIN_GOOD || plus === WIDEN_STEPS[WIDEN_STEPS.length - 1]) {
        return { items, usedMax: baseMm + plus };
      }
    }
    return { items: [], usedMax: baseMm };
  }

  // ---------- render ----------
  function renderIntoResultArea({ items, origin, maxMinutes, usedMax }) {
    const area = document.getElementById("resultArea");
    if (!area) return;

    const updated = DATASET_META.updated_at ? fmtDateShort(DATASET_META.updated_at) : "";
    const total = DATASET_META.count || (Array.isArray(items) ? items.length : 0);

    if (!items || !items.length) {
      area.innerHTML = `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
          <div style="font-weight:950; font-size:18px;">😕 Nessuna idea WOW trovata</div>
          <div class="small muted" style="margin-top:8px; line-height:1.45;">
            Aumenta i minuti (ora: <b>${esc(maxMinutes)}</b>) oppure cambia categoria.
          </div>
          <div class="small muted" style="margin-top:10px;">
            ${updated ? `Dataset aggiornato ${esc(updated)}` : "Dataset offline"} • totale ${esc(total)}
          </div>
        </div>
      `;
      return;
    }

    const cards = items
      .map((e) => {
        const title = e.title || "Idea WOW";
        const where = nicePlaceLine(e);
        const why = (e.why || "").trim();
        const catKey = normalizeCategory(e.category);
        const catPill = wowPillForCategory(catKey);

        const mins = computeMins(origin, e, window.haversineKm, window.estCarMinutesFromKm); // fallback se app non passa; ok se null
        const durLine = e.duration_min ? `⏱️ ~${esc(e.duration_min)} min` : "";

        const lat = e.lat;
        const lon = e.lon;

        const mapsAuto = (typeof lat === "number" && typeof lon === "number")
          ? mapsDirUrlWithOrigin(origin, lat, lon, "driving")
          : "";
        const mapsWalk = (typeof lat === "number" && typeof lon === "number")
          ? mapsDirUrlWithOrigin(origin, lat, lon, "walking")
          : "";
        const mapsBike = (typeof lat === "number" && typeof lon === "number")
          ? mapsDirUrlWithOrigin(origin, lat, lon, "bicycling")
          : "";

        const seeUrl = mapsSearchUrl(e); // “Cosa c’è”
        const infoUrl = e.url ? String(e.url) : "";

        const placeBlock = where
          ? `<div style="margin-top:10px; font-weight:950; font-size:15px; letter-spacing:.2px;">
               📍 ${esc(where)}
             </div>`
          : "";

        const metaLineParts = [];
        if (durLine) metaLineParts.push(durLine);
        // se vuoi mostrare anche stima “entro X min”, aggiungo solo se abbiamo mins
        if (origin && typeof origin.lat === "number" && typeof origin.lon === "number" && typeof lat === "number" && typeof lon === "number") {
          const mm = computeMins(origin, e, window.haversineKm, window.estCarMinutesFromKm);
          if (Number.isFinite(mm)) metaLineParts.push(`🚗 ~${Math.round(mm)} min`);
        }
        const metaLine = metaLineParts.length
          ? `<div class="small muted" style="margin-top:6px;">${esc(metaLineParts.join(" • "))}</div>`
          : "";

        return `
          <div class="card clickSafe" style="margin-top:12px; border-color:rgba(0,224,255,.14);">
            <div style="font-weight:950; font-size:20px; line-height:1.12;">${esc(title)}</div>

            ${placeBlock}
            ${metaLine}

            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px;">
              ${pill("Mai fatto")}
              ${pill(catPill)}
            </div>

            ${
              why
                ? `<div class="small muted" style="margin-top:12px; line-height:1.55;">
                     <b style="color:#fff;">Perché te lo propongo:</b> ${esc(why)}
                   </div>`
                : ""
            }

            <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px;">
              ${mapsAuto ? `<a class="btn btnPrimary" href="${esc(mapsAuto)}" target="_blank" rel="noopener">🧭 Vai</a>` : ""}
              ${mapsWalk ? `<a class="btn" href="${esc(mapsWalk)}" target="_blank" rel="noopener">🚶 A piedi</a>` : ""}
              ${mapsBike ? `<a class="btn" href="${esc(mapsBike)}" target="_blank" rel="noopener">🚴 Bici</a>` : ""}
              ${seeUrl ? `<a class="btnGhost" href="${esc(seeUrl)}" target="_blank" rel="noopener">👀 Cosa c’è</a>` : ""}
              ${infoUrl ? `<a class="btnGhost" href="${esc(infoUrl)}" target="_blank" rel="noopener">🔎 Info</a>` : ""}
            </div>

            <div class="small muted" style="margin-top:10px; opacity:.70;">
              Fonte: ${esc(e.source || DATASET_META.source || "mai_fatto")}
            </div>
          </div>
        `;
      })
      .join("");

    const widenNote =
      (usedMax && Number(usedMax) > Number(maxMinutes))
        ? `<div class="small muted" style="margin-top:6px; opacity:.85;">
             Nota: per riempire la lista ho considerato anche idee fino a ~${esc(usedMax)} min.
           </div>`
        : "";

    area.innerHTML = `
      <div class="card clickSafe" style="box-shadow:none; border-color:rgba(0,224,255,.20); background:rgba(0,224,255,.05);">
        <div style="font-weight:950; font-size:18px;">✨ MAI FATTO — idee WOW vicine</div>
        <div class="small muted" style="margin-top:6px;">
          ${updated ? `Dataset aggiornato ${esc(updated)}` : "Dataset offline"} • totale ${esc(total)}
        </div>
        <div class="small muted" style="margin-top:6px;">
          Mostrate: ${esc(items.length)} • impostato: ~${esc(maxMinutes)} min
        </div>
        ${widenNote}
      </div>
      ${cards}
    `;
  }

  // ---------- public API ----------
  async function run({
    origin,
    maxMinutes,
    eventType,
    haversineKm,
    estCarMinutesFromKm,
    showStatus,
    scrollToId
  }) {
    try {
      patchUI();

      if (!DATASET) DATASET = await loadDataset();
      const all = Array.isArray(DATASET) ? DATASET : [];

      if (!all.length) {
        showStatus?.("warn", "Dataset MAI FATTO vuoto.");
        renderIntoResultArea({ items: [], origin, maxMinutes, usedMax: maxMinutes });
        scrollToId?.("resultCard");
        return;
      }

      const { items, usedMax } = pickIdeasWidened({
        all,
        origin,
        maxMinutes,
        eventType,
        haversineKm,
        estCarMinutesFromKm,
      });

      renderIntoResultArea({ items, origin, maxMinutes, usedMax });

      showStatus?.("ok", `Mai fatto: ${items.length} idee WOW ✅`);
      scrollToId?.("resultCard");
    } catch (err) {
      console.error(err);
      showStatus?.("err", "Errore MAI FATTO: manca dataset oppure non è valido.");
      const area = document.getElementById("resultArea");
      if (area) {
        area.innerHTML = `
          <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
            <div style="font-weight:950; font-size:18px;">❌ MAI FATTO non disponibile</div>
            <div class="small muted" style="margin-top:8px; line-height:1.45;">
              Controlla che esista <b>${esc(PRIMARY_URL)}</b> e che contenga <b>{ ideas: [...] }</b>.
            </div>
          </div>
        `;
      }
      scrollToId?.("resultCard");
    }
  }

  // ✅ hook richiesto da app.js
  window.JAMO_EVENTS = { run };
})();
