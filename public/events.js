/* public/events.js — JAMO_MAIFATTO (region-first • no Verona fallback • widen by time)
 * Compatibile con app.js v22.2 (cat "eventi" -> window.JAMO_EVENTS.run)
 *
 * ✅ Region-first: /data/mai_fatto/mai_fatto_it_<region>.json
 * ✅ If low results: widen minutes (soft) step-by-step
 * ✅ If still low: fallback to /data/mai_fatto/mai_fatto_it_all.json (if exists)
 * ✅ Ultimate fallback: /data/events/events_all.json
 * ❌ NO hardcoded Verona fallback
 */

(() => {
  "use strict";

  // ------- CONFIG -------
  const BASE_DIR = "/data/mai_fatto";
  const ALL_ITALY_URL = `${BASE_DIR}/mai_fatto_it_all.json`;
  const FALLBACK_URL = "/data/events/events_all.json";

  const SHOW_LIMIT = 18;

  // Se dopo filtri trovi meno di questo numero, allarga i minuti
  const MIN_RESULTS_OK = 6;

  // Step di widening (moltiplicatori + cap)
  const WIDEN_MULTS = [1.0, 1.35, 1.70, 2.10];
  const WIDEN_CAP_MIN = 360;

  // Anti-ovvio (LEGGERO, non aggressivo) — puoi svuotarlo quando vuoi
  const TOO_FAMOUS_WORDS = [
    "gardaland",
    "piazza bra",
    "via mazzini",
    "piazza erbe",
    "arena di verona",
    "casa di giulietta",
    "lungolago",
  ];

  // ------- HELPERS -------
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

  function norm(s) {
    return String(s ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
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
      relax: "Reset mentale",
      famiglia: "Posti che i bimbi ricordano",
      bici: "Giro in bici WOW",
      moto: "Giro in moto WOW",
      natura: "Magia naturale",
      pioggia: "Quando piove è meglio",
      tramonto: "Luce che resta",
      mangiare: "Cibo WOW",
      "1h": "WOW in 1 ora",
      "2h": "WOW in 2 ore",
    };
    return m[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : "Idea");
  }

  function isTooFamous(e) {
    const hay = norm(`${e.title || ""} ${e.place || ""} ${e.city || ""}`);
    if (!hay) return false;
    return TOO_FAMOUS_WORDS.some((w) => hay.includes(norm(w)));
  }

  // Google Maps directions (mantieni origin dall’app)
  function mapsDirUrl({ oLat, oLon, dLat, dLon, mode }) {
    const m = mode || "driving";
    const base = `https://www.google.com/maps/dir/?api=1`;
    const originPart =
      (typeof oLat === "number" && typeof oLon === "number")
        ? `&origin=${encodeURIComponent(`${oLat},${oLon}`)}`
        : "";
    return `${base}${originPart}&destination=${encodeURIComponent(
      `${dLat},${dLon}`
    )}&travelmode=${encodeURIComponent(m)}`;
  }

  // Link “cosa c’è”: se c’è info_url lo usiamo, altrimenti ricerca su Maps
  function infoUrlFor(e) {
    const u = (e.info_url || e.url || "").trim();
    if (u) return u;
    const q = [e.title, e.place, e.city].filter(Boolean).join(" ");
    if (!q.trim()) return "";
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  }

  // ------- UI PATCH (Mai fatto) -------
  function patchUI() {
    const catChip = document.querySelector('#categoryChips .chip[data-cat="eventi"]');
    if (catChip) catChip.textContent = "✨ Mai fatto";

    const box = document.getElementById("eventsSubfilters");
    if (box) {
      const smalls = box.querySelectorAll(".small");
      if (smalls && smalls[0]) smalls[0].textContent = "Mai fatto (scegli il tipo di WOW)";
    }

    const row = document.getElementById("eventTypeChips");
    if (row) {
      row.innerHTML = `
        <div class="chip active" data-etype="tutti">⭐ Tutti</div>
        <div class="chip" data-etype="relax">🧠 Reset</div>
        <div class="chip" data-etype="famiglia">👨‍👩‍👧‍👦 Family</div>
        <div class="chip" data-etype="bici">🚴 Bici</div>
        <div class="chip" data-etype="moto">🏍️ Moto</div>
        <div class="chip" data-etype="natura">🌿 Natura</div>
        <div class="chip" data-etype="pioggia">🌧️ Pioggia</div>
        <div class="chip" data-etype="tramonto">🌅 Tramonto</div>
        <div class="chip" data-etype="mangiare">🍝 Food</div>
        <div class="chip" data-etype="1h">🕐 1h</div>
        <div class="chip" data-etype="2h">🕑 2h</div>
      `;
    }

    // nascondi "Quando" (non serve per Mai fatto)
    const whenRow = document.getElementById("eventWhenChips");
    if (whenRow) {
      const parent = whenRow.closest("div");
      if (parent) parent.style.display = "none";
    }

    const info = document.querySelector("#eventsSubfilters .small.muted");
    if (info) info.textContent = "Offline: idee WOW • region-first • se non basta allarga in automatico.";
  }

  patchUI();
  setTimeout(patchUI, 50);

  // ------- DATASET CACHE -------
  let CACHE = new Map(); // url -> { ideas, meta }
  let LAST_META = { updated_at: "", count: 0, source: "", area: "", used_url: "" };

  async function fetchJson(url) {
    const r = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} loading ${url}`);
    return await r.json();
  }

  async function loadIdeasFromUrl(url) {
    if (CACHE.has(url)) return CACHE.get(url);

    const j = await fetchJson(url);
    const ideas = Array.isArray(j?.ideas) ? j.ideas : [];
    const meta = {
      updated_at: j?.updated_at || "",
      count: j?.count ?? ideas.length,
      source: (ideas[0]?.source || "mai_fatto"),
      area: j?.area || "",
      used_url: url,
    };
    const pack = { ideas, meta };
    CACHE.set(url, pack);
    return pack;
  }

  function makeRegionSlug(regionName) {
    const r = norm(regionName);
    if (!r) return "";
    // gestisci casi tipo "Valle d'Aosta" -> "valle_daosta"
    return r.replaceAll(" ", "_").replaceAll("'", "");
  }

  function regionDatasetUrl(regionName) {
    const slug = makeRegionSlug(regionName);
    if (!slug) return "";
    return `${BASE_DIR}/mai_fatto_it_${slug}.json`;
  }

  // ------- FALLBACK EVENTS (convert) -------
  async function loadFallbackEventsAsIdeas() {
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
      category: e.category,
      duration_min: e.duration_min,
      why: e.why,
      info_url: e.info_url || e.url || "",
      url: e.url,
      source: e.source || "events_fallback",
    }));
    const meta = {
      updated_at: j2?.updated_at || "",
      count: j2?.count ?? ideas.length,
      source: "events_fallback",
      area: "fallback_events",
      used_url: FALLBACK_URL,
    };
    return { ideas, meta };
  }

  // ------- FILTER + PICK -------
  function approxMinutesFromKm(km, estCarMinutesFromKm) {
    if (typeof estCarMinutesFromKm === "function") return estCarMinutesFromKm(km);
    return Math.round(km + 8);
  }

  function pickIdeasOnce({ all, origin, maxMinutes, eventType, haversineKm, estCarMinutesFromKm }) {
    let list = Array.isArray(all) ? all.slice() : [];
    const mm = Math.max(15, Number(maxMinutes) || 120);
    const et = normalizeCategory(eventType || "tutti");

    if (et && et !== "tutti") {
      list = list.filter((e) => normalizeCategory(e.category) === et);
    }

    // anti-ovvio leggero (NON bloccare tutto)
    list = list.filter((e) => !isTooFamous(e));

    if (origin && typeof origin.lat === "number" && typeof origin.lon === "number") {
      list = list
        .map((e) => {
          if (typeof e.lat !== "number" || typeof e.lon !== "number") return null;
          const km = typeof haversineKm === "function"
            ? haversineKm(origin.lat, origin.lon, e.lat, e.lon)
            : null;
          const mins = km == null ? null : approxMinutesFromKm(km, estCarMinutesFromKm);
          const wow = typeof e.wow_score === "number" ? e.wow_score : 0;
          return { e, mins, wow };
        })
        .filter(Boolean)
        .filter((x) => (x.mins == null ? true : x.mins <= mm))
        .sort((a, b) => (a.mins ?? 999999) - (b.mins ?? 999999) || (b.wow - a.wow))
        .map((x) => x.e);
    } else {
      list = list
        .map((e) => ({ e, wow: typeof e.wow_score === "number" ? e.wow_score : 0 }))
        .sort((a, b) => b.wow - a.wow)
        .map((x) => x.e);
    }

    return list.slice(0, SHOW_LIMIT);
  }

  function widenSteps(baseMin) {
    const base = Math.max(15, Number(baseMin) || 120);
    const steps = [];
    for (const m of WIDEN_MULTS) {
      steps.push(Math.min(WIDEN_CAP_MIN, Math.round(base * m)));
    }
    // uniq + sorted
    return Array.from(new Set(steps)).sort((a, b) => a - b);
  }

  // ------- RENDER -------
  function renderIntoResultArea({ items, maxMinutes, origin, meta, usedMinutes }) {
    const area = document.getElementById("resultArea");
    if (!area) return;

    const updated = meta?.updated_at ? fmtDateShort(meta.updated_at) : "";
    const total = meta?.count || (Array.isArray(items) ? items.length : 0);
    const areaName = meta?.area ? ` • ${esc(meta.area)}` : "";
    const usedUrl = meta?.used_url ? ` • ${esc(meta.used_url.split("/").pop())}` : "";
    const widenLine =
      usedMinutes && Number(usedMinutes) !== Number(maxMinutes)
        ? ` • widen → ${esc(usedMinutes)} min`
        : "";

    if (!items || !items.length) {
      area.innerHTML = `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
          <div style="font-weight:950; font-size:18px;">😕 Nessuna idea trovata</div>
          <div class="small muted" style="margin-top:8px; line-height:1.45;">
            Aumenta i minuti (ora: <b>${esc(maxMinutes)}</b>) oppure cambia tipo di WOW.
          </div>
          <div class="small muted" style="margin-top:10px;">
            ${updated ? `Dataset aggiornato ${esc(updated)}` : "Dataset offline"} • totale ${esc(total)}${areaName}${usedUrl}${widenLine}
          </div>
        </div>
      `;
      return;
    }

    const cards = items.map((e) => {
      const title = e.title || "Idea WOW";
      const where = nicePlaceLine(e);
      const why = (e.why || "").trim();
      const catKey = normalizeCategory(e.category);
      const catLabel = labelCategory(catKey);

      const durLine = e.duration_min ? `⏱️ ~${esc(e.duration_min)} min` : "";

      const lat = e.lat;
      const lon = e.lon;
      const oLat = origin?.lat;
      const oLon = origin?.lon;

      const mapsAuto =
        (typeof lat === "number" && typeof lon === "number")
          ? mapsDirUrl({ oLat, oLon, dLat: lat, dLon: lon, mode: "driving" })
          : "";

      const infoUrl = infoUrlFor(e);

      const placeBlock = where
        ? `<div style="margin-top:10px; font-weight:950; font-size:15px; letter-spacing:.2px;">
             📍 ${esc(where)}
           </div>`
        : "";

      const durBlock = durLine
        ? `<div class="small muted" style="margin-top:6px;">${esc(durLine)}</div>`
        : "";

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
            ${infoUrl ? `<a class="btn" href="${esc(infoUrl)}" target="_blank" rel="noopener">🧩 Cosa c’è</a>` : ""}
          </div>

          <div class="small muted" style="margin-top:10px; opacity:.70;">
            Fonte: ${esc(e.source || meta?.source || "mai_fatto")}
          </div>
        </div>
      `;
    }).join("");

    area.innerHTML = `
      <div class="card clickSafe" style="box-shadow:none; border-color:rgba(0,224,255,.20); background:rgba(0,224,255,.05);">
        <div style="font-weight:950; font-size:18px;">✨ MAI FATTO — WOW vicini</div>
        <div class="small muted" style="margin-top:6px;">
          ${updated ? `Dataset aggiornato ${esc(updated)}` : "Dataset offline"} • totale ${esc(total)}${areaName}${usedUrl}${widenLine}
        </div>
        <div class="small muted" style="margin-top:6px;">
          Mostrate: ${esc(items.length)} • entro ~${esc(usedMinutes || maxMinutes)} min
        </div>
      </div>
      ${cards}
    `;
  }

  // ------- PUBLIC API -------
  async function run({
    origin,
    maxMinutes,
    eventType,
    eventWhen, // ignorato (UI nascosta), tenuto per compat
    haversineKm,
    estCarMinutesFromKm,
    showStatus,
    scrollToId,
  }) {
    try {
      patchUI();

      const baseMinutes = Math.max(15, Number(maxMinutes) || 120);
      const steps = widenSteps(baseMinutes);

      // 1) prova dataset regione (se riesco a capire la regione)
      // Prendo regione da origin.label se presente, altrimenti dal dataset stesso non posso.
      // Heuristica: cerca una parola di regione italiana nel label.
      const label = String(origin?.label || "").toLowerCase();

      const IT_REGIONS = [
        "abruzzo","basilicata","calabria","campania","emilia romagna","friuli venezia giulia",
        "lazio","liguria","lombardia","marche","molise","piemonte","puglia","sardegna","sicilia",
        "toscana","trentino alto adige","umbria","valle d aosta","veneto"
      ];

      let regionName = "";
      for (const r of IT_REGIONS) {
        if (label.includes(r)) { regionName = r; break; }
      }
      // normalizza alcune
      if (regionName === "emilia romagna") regionName = "Emilia-Romagna";
      else if (regionName === "friuli venezia giulia") regionName = "Friuli-Venezia Giulia";
      else if (regionName === "trentino alto adige") regionName = "Trentino-Alto Adige";
      else if (regionName === "valle d aosta") regionName = "Valle d'Aosta";
      else if (regionName) regionName = regionName.split(" ").map(x=>x.charAt(0).toUpperCase()+x.slice(1)).join(" ");

      // Se label non contiene regione (es: "Sassa Scalo") facciamo fallback “intelligente”:
      // proviamo comunque Abruzzo se origin.country_code=IT e lat/lon in area Abruzzo? (Non abbiamo bbox qui)
      // Quindi: se non so la regione, salto direttamente ad ALL_ITALY (ma NON Verona).
      let regionUrl = regionName ? regionDatasetUrl(regionName) : "";

      let lastMeta = null;
      let lastTried = "";

      // Helper: tenta una fonte con widening minuti
      async function trySource(url, tag) {
        if (!url) return { items: [], usedMinutes: steps[0], meta: null };

        let pack;
        try {
          pack = await loadIdeasFromUrl(url);
        } catch (e) {
          return { items: [], usedMinutes: steps[0], meta: null };
        }

        for (const m of steps) {
          const items = pickIdeasOnce({
            all: pack.ideas,
            origin,
            maxMinutes: m,
            eventType,
            haversineKm,
            estCarMinutesFromKm,
          });

          lastMeta = pack.meta;
          lastTried = tag;

          if (items.length >= MIN_RESULTS_OK || m === steps[steps.length - 1]) {
            return { items, usedMinutes: m, meta: pack.meta };
          }
        }

        return { items: [], usedMinutes: steps[0], meta: pack.meta };
      }

      // A) Regione (se disponibile)
      let res = await trySource(regionUrl, "region");
      if (res.items.length) {
        LAST_META = res.meta || LAST_META;
        renderIntoResultArea({ items: res.items, maxMinutes: baseMinutes, origin, meta: res.meta, usedMinutes: res.usedMinutes });
        showStatus?.("ok", `Mai fatto: ${res.items.length} proposte ✅`);
        scrollToId?.("resultCard");
        return;
      }

      // B) Italia intera (se esiste)
      res = await trySource(ALL_ITALY_URL, "all_it");
      if (res.items.length) {
        LAST_META = res.meta || LAST_META;
        renderIntoResultArea({ items: res.items, maxMinutes: baseMinutes, origin, meta: res.meta, usedMinutes: res.usedMinutes });
        showStatus?.("ok", `Mai fatto: ${res.items.length} proposte ✅`);
        scrollToId?.("resultCard");
        return;
      }

      // C) Fallback eventi
      const fb = await loadFallbackEventsAsIdeas();
      const fbItems = pickIdeasOnce({
        all: fb.ideas,
        origin,
        maxMinutes: steps[steps.length - 1],
        eventType,
        haversineKm,
        estCarMinutesFromKm,
      });

      LAST_META = fb.meta || LAST_META;
      renderIntoResultArea({ items: fbItems, maxMinutes: baseMinutes, origin, meta: fb.meta, usedMinutes: steps[steps.length - 1] });
      showStatus?.(fbItems.length ? "ok" : "warn", fbItems.length ? `Mai fatto: ${fbItems.length} proposte ✅` : "Mai fatto: 0 proposte (fallback).");
      scrollToId?.("resultCard");
    } catch (err) {
      console.error(err);
      showStatus?.("err", "Errore MAI FATTO: dataset mancante o non valido.");
      const area = document.getElementById("resultArea");
      if (area) {
        area.innerHTML = `
          <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
            <div style="font-weight:950; font-size:18px;">❌ MAI FATTO non disponibile</div>
            <div class="small muted" style="margin-top:8px; line-height:1.45;">
              Controlla che esista almeno uno tra:
              <br><b>${esc(ALL_ITALY_URL)}</b>
              <br>oppure dataset regionali <b>${esc(BASE_DIR)}/mai_fatto_it_*.json</b>
              <br>e che contengano <b>{ ideas: [...] }</b>.
            </div>
          </div>
        `;
      }
    }
  }

  window.JAMO_EVENTS = { run };
})();
