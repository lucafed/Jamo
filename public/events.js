/* public/events.js — JAMO_MAIFATTO bridge (ITALIA-WIDE + ROTAZIONE su minuti + widen)
 * Compatibile con app.js v22.2 (runEventsSearchBridge)
 *
 * ✅ UI: "Eventi" => "✨ Mai fatto"
 * ✅ Sottocategorie: Tutti, Relax, Famiglia, Bici, Moto, Natura, Pioggia, Tramonto, Mangiare, 1h, 2h
 * ✅ Card: LUOGO sotto titolo + SOLO "Perché te lo propongo"
 * ✅ Link: "🔎 Cosa c’è" (Google Maps search)
 * ✅ Direzioni: mantiene ORIGINE impostata in app (origin=lat,lon)
 * ✅ Dataset: Verona (se c'è) + fallback IT all + widen automatico
 * ✅ Se cambi minuti → cambiano anche i posti (rotazione deterministica)
 */

(() => {
  "use strict";

  const PRIMARY_URL = "/data/mai_fatto/mai_fatto_it_verona.json"; // opzionale
  const IT_ALL_URL = "/data/mai_fatto/mai_fatto_it_all.json";     // FONDAMENTALE per Italia intera
  const FALLBACK_EVENTS_URL = "/data/events/events_all.json";     // non rompere

  const SHOW_LIMIT = 24;

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

  function pill(label, soft = true) {
    return `<span class="pill ${soft ? "soft" : ""}">${esc(label)}</span>`;
  }

  function normalizeCategory(c) {
    const k = String(c || "").toLowerCase().trim();
    if (!k) return "";
    if (k === "1 ora" || k === "1h" || k === "1_ora" || k === "1ora") return "1h";
    if (k === "2 ore" || k === "2h" || k === "2_ore" || k === "2ore") return "2h";
    if (k === "family") return "famiglia";
    return k;
  }

  function labelCategory(k) {
    const m = {
      tutti: "Tutti",
      relax: "Relax",
      famiglia: "Famiglia",
      bici: "Bici",
      moto: "Moto",
      natura: "Natura",
      pioggia: "Pioggia",
      tramonto: "Tramonto",
      mangiare: "Mangiare",
      "1h": "1 ora",
      "2h": "2 ore",
    };
    return m[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : "Idea");
  }

  // Google maps directions with origin pinned to app origin
  function mapsDirUrl(origin, lat, lon, mode) {
    const m = mode || "driving";
    const dest = `${lat},${lon}`;
    let url =
      `https://www.google.com/maps/dir/?api=1` +
      `&destination=${encodeURIComponent(dest)}` +
      `&travelmode=${encodeURIComponent(m)}`;

    if (origin && typeof origin.lat === "number" && typeof origin.lon === "number") {
      url += `&origin=${encodeURIComponent(`${origin.lat},${origin.lon}`)}`;
    }
    return url;
  }

  function mapsSearchUrl(e) {
    const q = [e.title, e.place, e.city, e.region].filter(Boolean).join(" ");
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  }

  // fallback distance calc if app doesn't provide
  function toRad(x) { return (x * Math.PI) / 180; }
  function haversineKmFallback(aLat, aLon, bLat, bLon) {
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

  function approxMinutesFromKm(km, estCarMinutesFromKm) {
    if (typeof estCarMinutesFromKm === "function") return estCarMinutesFromKm(km);
    // 60 km/h + overhead
    return Math.round(km + 8);
  }

  // ---------- ROTAZIONE (PRNG deterministico) ----------
  // hash string -> uint32
  function hash32(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffleInPlace(arr, rand) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function isoWeekKey(d = new Date()) {
    // week-of-year (rough but stable enough)
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
    return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }

  function originCellKey(origin) {
    // griglia ~5km (0.05 deg) per stabilizzare
    if (!origin || typeof origin.lat !== "number" || typeof origin.lon !== "number") return "no-origin";
    const latc = Math.round(origin.lat / 0.05) * 0.05;
    const lonc = Math.round(origin.lon / 0.05) * 0.05;
    return `${latc.toFixed(2)},${lonc.toFixed(2)}`;
  }

  // ---------- UI patch ----------
  function patchUI() {
    const catChip = document.querySelector('#categoryChips .chip[data-cat="eventi"]');
    if (catChip) catChip.textContent = "✨ Mai fatto";

    const box = document.getElementById("eventsSubfilters");
    if (box) {
      const smalls = box.querySelectorAll(".small");
      if (smalls && smalls[0]) smalls[0].textContent = "Mai fatto (categoria)";
    }

    const row = document.getElementById("eventTypeChips");
    if (row) {
      row.innerHTML = `
        <div class="chip active" data-etype="tutti">⭐ Tutti</div>
        <div class="chip" data-etype="relax">🧖 Relax</div>
        <div class="chip" data-etype="famiglia">👨‍👩‍👧‍👦 Famiglia</div>
        <div class="chip" data-etype="bici">🚴 Bici</div>
        <div class="chip" data-etype="moto">🏍️ Moto</div>
        <div class="chip" data-etype="natura">🌿 Natura</div>
        <div class="chip" data-etype="pioggia">🌧️ Pioggia</div>
        <div class="chip" data-etype="tramonto">🌅 Tramonto</div>
        <div class="chip" data-etype="mangiare">🍝 Mangiare</div>
        <div class="chip" data-etype="1h">🕐 1 ora</div>
        <div class="chip" data-etype="2h">🕑 2 ore</div>
      `;
    }

    // hide "Quando" row (date-based)
    const whenRow = document.getElementById("eventWhenChips");
    if (whenRow) {
      const parent = whenRow.closest("div");
      if (parent) parent.style.display = "none";
    }

    const info = document.querySelector("#eventsSubfilters .small.muted");
    if (info) info.textContent = "Offline: idee curate (luoghi reali). Cambia minuti = cambia proposte.";
  }

  patchUI();
  setTimeout(patchUI, 50);

  // ---------- dataset cache ----------
  let DATASET = null;
  let DATASET_META = { updated_at: "", count: 0, source: "" };

  async function fetchJson(url) {
    const r = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} loading ${url}`);
    return await r.json();
  }

  function normalizeIdeasPayload(j) {
    const ideas = Array.isArray(j?.ideas) ? j.ideas : [];
    return {
      ideas,
      meta: {
        updated_at: j?.updated_at || "",
        count: j?.count ?? ideas.length,
        source: "curated_mai_fatto",
      },
    };
  }

  async function loadDataset() {
    // 1) try local Verona (non deve rompere se manca)
    try {
      const j = await fetchJson(PRIMARY_URL);
      const p = normalizeIdeasPayload(j);
      if (p.ideas.length) {
        DATASET_META = { ...p.meta, source: "curated_mai_fatto_verona" };
        return p.ideas;
      }
    } catch (_) {}

    // 2) Italia intera
    try {
      const j = await fetchJson(IT_ALL_URL);
      const p = normalizeIdeasPayload(j);
      DATASET_META = { ...p.meta, source: "curated_mai_fatto_it_all" };
      return p.ideas;
    } catch (_) {}

    // 3) fallback events old
    const j2 = await fetchJson(FALLBACK_EVENTS_URL);
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
      category: e.category,
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

  // ---------- selection (widen + rotazione + diversità) ----------
  function scoreByDistance(all, origin, haversineKmFn, estCarMinutesFromKm) {
    const hk = typeof haversineKmFn === "function" ? haversineKmFn : haversineKmFallback;
    return all
      .map((e) => {
        if (typeof e.lat !== "number" || typeof e.lon !== "number") return null;
        const km = hk(origin.lat, origin.lon, e.lat, e.lon);
        const mins = approxMinutesFromKm(km, estCarMinutesFromKm);
        return { e, mins };
      })
      .filter(Boolean)
      .sort((a, b) => a.mins - b.mins);
  }

  // pick diverse across distance bands
  function pickDiverse(scored, limit, rand) {
    // bande: 0-20%, 20-40%, 40-60%, 60-80%, 80-100% del max mins presente
    const maxM = Math.max(1, scored[scored.length - 1]?.mins ?? 1);
    const bands = [[], [], [], [], []];
    for (const x of scored) {
      const r = x.mins / maxM;
      const idx = r < 0.2 ? 0 : r < 0.4 ? 1 : r < 0.6 ? 2 : r < 0.8 ? 3 : 4;
      bands[idx].push(x.e);
    }
    for (const b of bands) shuffleInPlace(b, rand);

    const out = [];
    // round-robin: prende 1 per banda a giro
    while (out.length < limit) {
      let pushed = false;
      for (const b of bands) {
        if (b.length && out.length < limit) {
          out.push(b.pop());
          pushed = true;
        }
      }
      if (!pushed) break;
    }
    return out;
  }

  function pickIdeas({ all, origin, maxMinutes, eventType, styleKey, haversineKm, estCarMinutesFromKm }) {
    let list = Array.isArray(all) ? all.slice() : [];
    const et = normalizeCategory(eventType || "tutti");

    if (et && et !== "tutti") {
      list = list.filter((e) => normalizeCategory(e.category) === et);
    }

    if (!origin || typeof origin.lat !== "number" || typeof origin.lon !== "number") {
      // senza origine: ruota solo su minuti+settimana
      const mm0 = Math.max(5, Number(maxMinutes) || 120);
      const mmKey = Math.round(mm0 / 10) * 10; // cambia output al cambio minuti
      const seed = hash32(`no-origin|${et}|${mmKey}|${isoWeekKey()}|${styleKey || ""}`);
      const rand = mulberry32(seed);
      shuffleInPlace(list, rand);
      return { items: list.slice(0, SHOW_LIMIT), note: "" };
    }

    const mm = Math.max(5, Number(maxMinutes) || 120);
    const mmKey = Math.round(mm / 10) * 10; // cambia output al cambio minuti
    const seed = hash32(`${originCellKey(origin)}|${et}|${mmKey}|${isoWeekKey()}|${styleKey || ""}`);
    const rand = mulberry32(seed);

    const scoredAll = scoreByDistance(list, origin, haversineKm, estCarMinutesFromKm);

    // widen steps: se non trovi, allarghi automaticamente
    const steps = [mm, Math.min(360, Math.round(mm * 1.6)), Math.min(420, Math.round(mm * 2.2)), Math.min(600, Math.round(mm * 3))];

    for (let i = 0; i < steps.length; i++) {
      const cap = steps[i];
      const scored = scoredAll.filter((x) => x.mins <= cap);
      if (scored.length) {
        const items = pickDiverse(scored, SHOW_LIMIT, rand);
        if (i === 0) return { items, note: "" };
        return { items, note: `Non abbastanza entro ${mm} min: ho esteso a ~${cap} min.` };
      }
    }

    // ultima spiaggia: più vicini comunque (ma ruotati)
    const nearest = scoredAll.slice(0, Math.max(1, SHOW_LIMIT * 2)).map((x) => x.e);
    shuffleInPlace(nearest, rand);
    return { items: nearest.slice(0, SHOW_LIMIT), note: `In zona ho poche idee: ti mostro le più vicine disponibili.` };
  }

  // ---------- render ----------
  function renderIntoResultArea({ items, maxMinutes, origin, note }) {
    const area = document.getElementById("resultArea");
    if (!area) return;

    const updated = DATASET_META.updated_at ? fmtDateShort(DATASET_META.updated_at) : "";
    const total = DATASET_META.count || 0;

    if (!items || !items.length) {
      area.innerHTML = `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
          <div style="font-weight:950; font-size:18px;">😕 Nessuna idea trovata</div>
          <div class="small muted" style="margin-top:8px; line-height:1.45;">
            Aumenta i minuti (ora: <b>${esc(maxMinutes)}</b>) oppure cambia sottocategoria.
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
        const title = e.title || "Idea";
        const where = nicePlaceLine(e);
        const why = (e.why || "").trim();

        const catKey = normalizeCategory(e.category);
        const catLabel = labelCategory(catKey);

        const durLine = e.duration_min ? `⏱️ ~${esc(e.duration_min)} min` : "";
        const lat = e.lat;
        const lon = e.lon;

        const mapsAuto =
          typeof lat === "number" && typeof lon === "number"
            ? mapsDirUrl(origin, lat, lon, "driving")
            : "";
        const mapsWalk =
          typeof lat === "number" && typeof lon === "number"
            ? mapsDirUrl(origin, lat, lon, "walking")
            : "";
        const mapsBike =
          typeof lat === "number" && typeof lon === "number"
            ? mapsDirUrl(origin, lat, lon, "bicycling")
            : "";

        const mapsInfo = mapsSearchUrl(e);
        const infoUrl = e.url ? String(e.url) : "";

        const placeBlock = where
          ? `<div style="margin-top:10px; font-weight:950; font-size:15px; letter-spacing:.2px;">
               📍 ${esc(where)}
             </div>`
          : "";

        const durBlock = durLine ? `<div class="small muted" style="margin-top:6px;">${esc(durLine)}</div>` : "";

        return `
          <div class="card clickSafe" style="margin-top:12px; border-color:rgba(0,224,255,.14);">
            <div style="font-weight:950; font-size:20px; line-height:1.12;">${esc(title)}</div>
            ${placeBlock}
            ${durBlock}

            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px;">
              ${pill("Mai fatto")}
              ${pill(catLabel)}
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
              ${mapsInfo ? `<a class="btnGhost" href="${esc(mapsInfo)}" target="_blank" rel="noopener">🔎 Cosa c’è</a>` : ""}
              ${infoUrl ? `<a class="btnGhost" href="${esc(infoUrl)}" target="_blank" rel="noopener">ℹ️ Info</a>` : ""}
            </div>

            <div class="small muted" style="margin-top:10px; opacity:.70;">
              Fonte: ${esc(e.source || DATASET_META.source || "mai_fatto")}
            </div>
          </div>
        `;
      })
      .join("");

    area.innerHTML = `
      <div class="card clickSafe" style="box-shadow:none; border-color:rgba(0,224,255,.20); background:rgba(0,224,255,.05);">
        <div style="font-weight:950; font-size:18px;">✨ MAI FATTO — idee vicine</div>
        <div class="small muted" style="margin-top:6px;">
          ${updated ? `Dataset aggiornato ${esc(updated)}` : "Dataset offline"} • totale ${esc(total)}
        </div>
        <div class="small muted" style="margin-top:6px;">
          Mostrate: ${esc(items.length)} • entro ~${esc(maxMinutes)} min
        </div>
        ${
          note
            ? `<div class="small muted" style="margin-top:8px; line-height:1.35; opacity:.9;">
                 ${esc(note)}
               </div>`
            : ""
        }
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

      // salva origine per uso futuro
      if (origin && typeof origin.lat === "number" && typeof origin.lon === "number") {
        window.__JAMO_ORIGIN__ = origin;
      }

      // style: se vuoi usarlo per variare output (Chicche/Classici)
      const styleKey = (document.querySelector(".chip.active[data-style]")?.getAttribute("data-style") || "").trim();

      if (!DATASET) DATASET = await loadDataset();
      const all = Array.isArray(DATASET) ? DATASET : [];

      if (!all.length) {
        showStatus?.("warn", "Dataset MAI FATTO vuoto.");
        renderIntoResultArea({ items: [], maxMinutes, origin, note: "" });
        scrollToId?.("resultCard");
        return;
      }

      const picked = pickIdeas({
        all,
        origin,
        maxMinutes,
        eventType,
        styleKey,
        haversineKm,
        estCarMinutesFromKm
      });

      renderIntoResultArea({ items: picked.items, maxMinutes, origin, note: picked.note });
      showStatus?.("ok", `Mai fatto: trovate ${picked.items.length} proposte ✅`);
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
              Serve almeno <b>${esc(IT_ALL_URL)}</b> con <b>{ ideas: [...] }</b>.
            </div>
          </div>
        `;
      }
      scrollToId?.("resultCard");
    }
  }

  window.JAMO_EVENTS = { run };
})();
