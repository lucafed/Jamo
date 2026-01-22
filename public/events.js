/* public/events.js — JAMO_MAIFATTO bridge (offline, IDEE WOW + SCONOSCIUTE)
 * Compatibile con app.js v22.2 (runEventsSearchBridge)
 *
 * ✅ UI: "Eventi" => "MAI FATTO"
 * ✅ Sottocategorie WOW: Relax/Famiglia/Bici/Moto/Natura/Pioggia/Tramonto/Mangiare/1h/2h
 * ✅ SOLO "Perché te lo propongo" (NO "cosa fare")
 * ✅ Link SEMPRE: "Vedi cosa c'è" (Google Maps place/search)
 * ✅ Anti-ovvio SEMPRE ON (niente fallback a Lazise/Sirmione ecc.)
 * ✅ Se pochi risultati: allarga minuti (fino a 240) MA mantiene anti-ovvio
 * ✅ Filtro qualità: scarta "perché" troppo generici
 */

(() => {
  "use strict";

  const PRIMARY_URL = "/data/mai_fatto/mai_fatto_it_verona.json";
  const FALLBACK_URL = "/data/events/events_all.json";

  // Quante card mostrare
  const SHOW_LIMIT = 14;

  // Quanto può “allargare” i minuti per trovare roba WOW (senza diventare ovvio)
  const MAX_WIDEN_MINUTES = 240;

  // Anti-ovvio: se contiene queste parole, è “troppo noto” per Mai fatto
  // (personalizzabile: aggiungi TUTTO ciò che vuoi bannare)
  const OVB_CITY_BLACKLIST = [
    "lazise", "sirmione", "bardolino", "garda", "peschiera",
    "verona", "arena", "piazza bra", "centro storico",
  ];
  const OVB_PLACE_BLACKLIST = [
    "lungolago", "centro storico", "piazza", "duomo",
    "gardaland", "movieland", "sigurtà", "parco sigurtà",
  ];

  // Filtro qualità sul "perché": se troppo “genericone”, scartiamo l’idea
  const GENERIC_WHY_PHRASES = [
    "è semplice", "lineare", "senza complicazioni", "senza stress",
    "perfetto per", "ideale per", "la solita cosa", "niente di che",
    "ti rilassi", "staccare la spina", "aria buona", "silenzio",
  ];
  const MIN_WHY_LEN = 38; // sotto questa lunghezza spesso è “piatto” (tarabile)

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

  function mapsDirUrl(lat, lon, mode) {
    const m = mode || "driving";
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
      `${lat},${lon}`
    )}&travelmode=${encodeURIComponent(m)}`;
  }

  // ✅ SEMPRE "Vedi cosa c'è": apre scheda/ricerca su Maps anche senza url
  function mapsSearchUrl(e) {
    const q = [
      e.place || "",
      e.city || "",
      e.region || "",
      e.country_code || "",
    ].filter(Boolean).join(" ").trim();

    if (q) {
      return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
    }

    if (typeof e.lat === "number" && typeof e.lon === "number") {
      return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${e.lat},${e.lon}`)}`;
    }
    return "";
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

  // NOMI WOW (chip + pill)
  const WOW = {
    relax:   "🧖 Stacca davvero",
    famiglia:"👨‍👩‍👧‍👦 Posti che i bambini ricordano",
    bici:    "🚴 Giro in bici che vale",
    moto:    "🏍️ Due curve e sorridi",
    natura:  "🌿 Natura wow vicino",
    pioggia: "🌧️ Quando piove è meglio",
    tramonto:"🌅 Tramonto da far foto",
    mangiare:"🍝 Mangiare con gusto",
    "1h":    "🕐 1 ora fatta bene",
    "2h":    "🕑 2 ore memorabili",
  };
  const wowLabelForKey = (k) => WOW[k] || (k ? k : "Idea");

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
        <div class="chip" data-etype="relax">${esc(WOW.relax)}</div>
        <div class="chip" data-etype="famiglia">${esc(WOW.famiglia)}</div>
        <div class="chip" data-etype="bici">${esc(WOW.bici)}</div>
        <div class="chip" data-etype="moto">${esc(WOW.moto)}</div>
        <div class="chip" data-etype="natura">${esc(WOW.natura)}</div>
        <div class="chip" data-etype="pioggia">${esc(WOW.pioggia)}</div>
        <div class="chip" data-etype="tramonto">${esc(WOW.tramonto)}</div>
        <div class="chip" data-etype="mangiare">${esc(WOW.mangiare)}</div>
        <div class="chip" data-etype="1h">${esc(WOW["1h"])}</div>
        <div class="chip" data-etype="2h">${esc(WOW["2h"])}</div>
      `;
    }

    const whenRow = document.getElementById("eventWhenChips");
    if (whenRow) {
      const parent = whenRow.closest("div");
      if (parent) parent.style.display = "none";
    }

    const info = document.querySelector("#eventsSubfilters .small.muted");
    if (info) info.textContent = "Solo idee WOW e poco ovvie. Se non ci sono vicino, te lo diciamo (non ti buttiamo Lazise).";
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

  async function loadDataset() {
    try {
      const j = await fetchJson(PRIMARY_URL);
      const ideas = Array.isArray(j?.ideas) ? j.ideas : [];
      DATASET_META = {
        updated_at: j?.updated_at || "",
        count: j?.count ?? ideas.length,
        source: "curated_mai_fatto",
      };
      return ideas;
    } catch (_) {
      // fallback: NON perfetto per "mai fatto", ma non deve rompere
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

  // ---------- quality + anti-obvious ----------
  function normTxt(s) {
    return String(s || "").toLowerCase().trim();
  }

  function isObvious(e) {
    const city = normTxt(e.city);
    const place = normTxt(e.place);
    const title = normTxt(e.title);

    const hitCity = OVB_CITY_BLACKLIST.some((x) => city.includes(x) || title.includes(x));
    const hitPlace = OVB_PLACE_BLACKLIST.some((x) => place.includes(x) || title.includes(x));
    return hitCity || hitPlace;
  }

  function isGenericWhy(why) {
    const w = normTxt(why);
    if (!w) return true;
    if (w.length < MIN_WHY_LEN) return true;

    // se contiene troppe frasi "piatte"
    let hits = 0;
    for (const p of GENERIC_WHY_PHRASES) {
      if (w.includes(p)) hits++;
      if (hits >= 2) return true;
    }
    return false;
  }

  // ---------- selection ----------
  function pickIdeas({ all, origin, maxMinutes, eventType, haversineKm, estCarMinutesFromKm }) {
    let list = Array.isArray(all) ? all.slice() : [];

    // 1) match ESATTO categoria
    const et = normalizeCategory(eventType || "tutti");
    if (et && et !== "tutti") {
      list = list.filter((e) => normalizeCategory(e.category) === et);
    }

    // 2) qualità: solo idee con "perché" buono
    list = list.filter((e) => !isGenericWhy(e.why));

    // 3) anti-ovvio SEMPRE
    list = list.filter((e) => !isObvious(e));

    // 4) distanza: se non basta, allarghiamo minuti (MAI togliere anti-ovvio)
    const mmIn = Number(maxMinutes) || 120;
    const widen = [];
    if (mmIn <= 45) widen.push(mmIn, 60, 90, 120, 160, 200, 240);
    else if (mmIn <= 60) widen.push(mmIn, 90, 120, 160, 200, 240);
    else if (mmIn <= 120) widen.push(mmIn, 140, 160, 180, 200, 240);
    else widen.push(mmIn, Math.min(MAX_WIDEN_MINUTES, mmIn + 30), Math.min(MAX_WIDEN_MINUTES, mmIn + 60), MAX_WIDEN_MINUTES);

    const maxWiden = widen.filter((x) => x <= MAX_WIDEN_MINUTES);

    let chosenMinutes = mmIn;

    if (origin && typeof origin.lat === "number" && typeof origin.lon === "number") {
      const enriched = list
        .map((e) => {
          if (typeof e.lat !== "number" || typeof e.lon !== "number") return null;
          const km = typeof haversineKm === "function"
            ? haversineKm(origin.lat, origin.lon, e.lat, e.lon)
            : null;
          const mins = km == null ? null : approxMinutesFromKm(km, estCarMinutesFromKm);
          return { e, mins };
        })
        .filter(Boolean)
        .sort((a, b) => (a.mins ?? 9999) - (b.mins ?? 9999));

      let within = [];
      for (const mm of maxWiden) {
        chosenMinutes = mm;
        within = enriched.filter((x) => (x.mins == null ? true : x.mins <= mm));
        if (within.length >= Math.min(8, SHOW_LIMIT)) break; // obiettivo: tante idee
      }

      return {
        items: within.map((x) => x.e).slice(0, SHOW_LIMIT),
        usedMinutes: chosenMinutes,
        widened: chosenMinutes !== mmIn
      };
    }

    // senza origin: almeno restituisci qualcosa
    return { items: list.slice(0, SHOW_LIMIT), usedMinutes: mmIn, widened: false };
  }

  // ---------- render ----------
  function renderIntoResultArea({ items, maxMinutes, usedMinutes, widened }) {
    const area = document.getElementById("resultArea");
    if (!area) return;

    const updated = DATASET_META.updated_at ? fmtDateShort(DATASET_META.updated_at) : "";
    const total = DATASET_META.count || (Array.isArray(items) ? items.length : 0);

    if (!items || !items.length) {
      area.innerHTML = `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
          <div style="font-weight:950; font-size:18px;">😕 Zero WOW qui vicino</div>
          <div class="small muted" style="margin-top:8px; line-height:1.45;">
            In “Mai fatto” mostriamo solo idee <b>poco ovvie</b> e con un “perché” forte.
            <br/>Prova ad alzare i minuti (ora: <b>${esc(maxMinutes)}</b>) oppure cambia sottocategoria.
          </div>
          <div class="small muted" style="margin-top:10px;">
            ${updated ? `Dataset aggiornato ${esc(updated)}` : "Dataset offline"} • totale ${esc(total)}
          </div>
        </div>
      `;
      return;
    }

    const headerNote = widened
      ? `<div class="small muted" style="margin-top:6px;">Ho allargato la ricerca: ${esc(maxMinutes)} → ${esc(usedMinutes)} min (sempre anti-ovvio).</div>`
      : "";

    const cards = items.map((e) => {
      const title = e.title || "Idea";
      const where = nicePlaceLine(e);
      const why = (e.why || "").trim();

      const catKey = normalizeCategory(e.category);
      const catLabel = wowLabelForKey(catKey);

      const durLine = e.duration_min ? `⏱️ ~${esc(e.duration_min)} min` : "";

      const lat = e.lat;
      const lon = e.lon;

      const mapsAuto = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "driving") : "";
      const mapsWalk = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "walking") : "";
      const mapsBike = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "bicycling") : "";

      // ✅ SEMPRE presente
      const seeUrl = mapsSearchUrl(e) || e.url || "";

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

          <div class="small muted" style="margin-top:12px; line-height:1.55;">
            <b style="color:#fff;">Perché te lo propongo:</b> ${esc(why)}
          </div>

          <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px;">
            ${mapsAuto ? `<a class="btn btnPrimary" href="${esc(mapsAuto)}" target="_blank" rel="noopener">🧭 Vai</a>` : ""}
            ${mapsWalk ? `<a class="btn" href="${esc(mapsWalk)}" target="_blank" rel="noopener">🚶 A piedi</a>` : ""}
            ${mapsBike ? `<a class="btn" href="${esc(mapsBike)}" target="_blank" rel="noopener">🚴 Bici</a>` : ""}
            ${seeUrl ? `<a class="btnGhost" href="${esc(seeUrl)}" target="_blank" rel="noopener">👀 Vedi cosa c’è</a>` : ""}
          </div>

          <div class="small muted" style="margin-top:10px; opacity:.70;">
            Fonte: ${esc(e.source || DATASET_META.source || "mai_fatto")}
          </div>
        </div>
      `;
    }).join("");

    area.innerHTML = `
      <div class="card clickSafe" style="box-shadow:none; border-color:rgba(0,224,255,.20); background:rgba(0,224,255,.05);">
        <div style="font-weight:950; font-size:18px;">✨ MAI FATTO — idee WOW (poco ovvie)</div>
        <div class="small muted" style="margin-top:6px;">
          ${updated ? `Dataset aggiornato ${esc(updated)}` : "Dataset offline"} • totale ${esc(total)}
        </div>
        <div class="small muted" style="margin-top:6px;">
          Mostrate: ${esc(items.length)} • entro ~${esc(usedMinutes || maxMinutes)} min
        </div>
        ${headerNote}
      </div>
      ${cards}
    `;
  }

  // ---------- public API ----------
  async function run({
    origin,
    maxMinutes,
    eventType,
    eventWhen, // ignored
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
        renderIntoResultArea({ items: [], maxMinutes, usedMinutes: maxMinutes, widened: false });
        scrollToId?.("resultCard");
        return;
      }

      const { items, usedMinutes, widened } = pickIdeas({
        all,
        origin,
        maxMinutes,
        eventType,
        haversineKm,
        estCarMinutesFromKm
      });

      renderIntoResultArea({ items, maxMinutes, usedMinutes, widened });

      if (!items.length) {
        showStatus?.("warn", "Mai fatto: zero WOW qui vicino. Alza minuti o cambia categoria.");
      } else {
        showStatus?.("ok", `Mai fatto: trovate ${items.length} idee WOW ✅`);
      }
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

  window.JAMO_EVENTS = { run };
})();
