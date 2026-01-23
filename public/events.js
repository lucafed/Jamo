/* public/events.js — JAMO_MAIFATTO bridge (OFFLINE • region-first • widen-by-distance)
 * Compatibile con app.js v22.2 (runEventsSearchBridge)
 *
 * FIX:
 * - Dataset scelto in base alla PARTENZA (origin) → regione → regioni vicine → Italia → fallback events
 * - Niente salto “a Verona” se sei in Abruzzo (Verona solo se sei in Veneto o ultimissimo fallback filtrato)
 * - Anti-famoso SOFT (se poche idee, si allenta)
 * - Robust: accetta JSON grossi con {ideas, stats, ...}
 */

(() => {
  "use strict";

  // ---------------- CONFIG ----------------
  const SHOW_LIMIT = 18;

  // Dataset “Italia intera” (quando lo avrai davvero pronto)
  const IT_ALL_URLS = [
    "/data/mai_fatto/mai_fatto_it_all.json",
  ];

  // Dataset regionali (se esistono nel repo li prende, altrimenti skip)
  // Nomi attesi (coerenti col tuo build): mai_fatto_it_<slug>.json
  const REGION_DATASET_BY_SLUG = (slug) => `/data/mai_fatto/mai_fatto_it_${slug}.json`;

  // Fallback “eventi” (non deve rompere nulla)
  const FALLBACK_EVENTS_URL = "/data/events/events_all.json";

  // Anti-ovvio (remember: SOFT)
  const TOO_FAMOUS_WORDS = [
    // Verona/Garda (esempio)
    "lazise",
    "sirmione",
    "gardaland",
    "lungolago",
    "piazza bra",
    "via mazzini",
    "piazza erbe",
    "arena di verona",
    "giulietta",
    "casa di giulietta",
    "centro verona",
    // “super noti” generici
    "colosseo",
    "fontana di trevi",
    "piazza san marco",
  ];

  // ---------------- helpers ----------------
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
    if (k === "food") return "mangiare";
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
    const hay = `${e.title || ""} ${e.place || ""} ${e.city || ""} ${e.region || ""}`.toLowerCase();
    return TOO_FAMOUS_WORDS.some((w) => hay.includes(w));
  }

  // Google Maps directions (mantieni origin dall’app)
  function mapsDirUrl({ oLat, oLon, dLat, dLon, mode }) {
    const m = mode || "driving";
    const base = `https://www.google.com/maps/dir/?api=1`;
    const originPart =
      (typeof oLat === "number" && typeof oLon === "number")
        ? `&origin=${encodeURIComponent(`${oLat},${oLon}`)}`
        : "";
    return `${base}${originPart}&destination=${encodeURIComponent(`${dLat},${dLon}`)}&travelmode=${encodeURIComponent(m)}`;
  }

  // Link “cosa c’è”: se c’è info_url lo usiamo, altrimenti ricerca su Maps
  function infoUrlFor(e) {
    const u = (e.info_url || e.url || "").trim();
    if (u) return u;
    const q = [e.title, e.place, e.city, e.region].filter(Boolean).join(" ");
    if (!q.trim()) return "";
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  }

  function approxMinutesFromKm(km, estCarMinutesFromKm) {
    if (typeof estCarMinutesFromKm === "function") return estCarMinutesFromKm(km);
    return Math.round(km + 8);
  }

  // ---------------- Region logic (Italia) ----------------
  // BBox approssimativi (sufficienti per capire la regione di partenza)
  const IT_REGIONS = [
    { name: "Abruzzo", slug: "abruzzo", w: 13.0, s: 41.6, e: 14.9, n: 43.0 },
    { name: "Molise", slug: "molise", w: 14.1, s: 41.4, e: 15.9, n: 42.1 },
    { name: "Lazio", slug: "lazio", w: 11.3, s: 40.7, e: 14.1, n: 42.9 },
    { name: "Marche", slug: "marche", w: 12.9, s: 42.6, e: 13.9, n: 43.8 },
    { name: "Umbria", slug: "umbria", w: 12.0, s: 42.2, e: 13.3, n: 43.6 },
    { name: "Toscana", slug: "toscana", w: 9.6, s: 42.2, e: 12.4, n: 44.6 },
    { name: "Campania", slug: "campania", w: 13.6, s: 39.9, e: 15.9, n: 41.5 },
    { name: "Puglia", slug: "puglia", w: 14.9, s: 39.8, e: 18.6, n: 42.2 },
    { name: "Basilicata", slug: "basilicata", w: 15.3, s: 39.9, e: 16.9, n: 41.2 },
    { name: "Calabria", slug: "calabria", w: 15.6, s: 37.9, e: 17.3, n: 40.2 },
    { name: "Emilia-Romagna", slug: "emilia_romagna", w: 9.2, s: 43.7, e: 12.9, n: 45.2 },
    { name: "Veneto", slug: "veneto", w: 10.6, s: 44.7, e: 13.1, n: 46.7 },
    { name: "Lombardia", slug: "lombardia", w: 8.4, s: 44.7, e: 11.4, n: 46.7 },
    { name: "Piemonte", slug: "piemonte", w: 6.6, s: 44.0, e: 9.2, n: 46.5 },
    { name: "Liguria", slug: "liguria", w: 7.5, s: 43.8, e: 10.1, n: 44.7 },
    { name: "Trentino-Alto Adige", slug: "trentino_alto_adige", w: 10.3, s: 45.6, e: 12.5, n: 47.2 },
    { name: "Friuli-Venezia Giulia", slug: "friuli_venezia_giulia", w: 12.3, s: 45.5, e: 13.9, n: 46.7 },
    { name: "Valle d'Aosta", slug: "valle_d_aosta", w: 6.8, s: 45.4, e: 7.9, n: 46.2 },
    { name: "Sardegna", slug: "sardegna", w: 8.0, s: 38.8, e: 9.8, n: 41.4 },
    { name: "Sicilia", slug: "sicilia", w: 12.3, s: 36.6, e: 15.7, n: 38.4 },
  ];

  // Vicinanze “ragionevoli” (basta per evitare salti assurdi)
  const NEIGHBORS = {
    abruzzo: ["lazio", "molise", "marche", "umbria"],
    molise: ["abruzzo", "campania", "puglia", "lazio"],
    lazio: ["abruzzo", "umbria", "toscana", "campania", "marche"],
    marche: ["umbria", "abruzzo", "emilia_romagna", "toscana", "lazio"],
    umbria: ["toscana", "marche", "lazio"],
    veneto: ["lombardia", "trentino_alto_adige", "friuli_venezia_giulia", "emilia_romagna"],
    emilia_romagna: ["veneto", "lombardia", "toscana", "marche", "piemonte", "liguria"],
    lombardia: ["piemonte", "veneto", "trentino_alto_adige", "emilia_romagna"],
    // fallback per regioni non elencate: nessuna
  };

  function regionFromOrigin(origin) {
    const lat = origin?.lat;
    const lon = origin?.lon;
    if (typeof lat !== "number" || typeof lon !== "number") return null;
    for (const r of IT_REGIONS) {
      if (lon >= r.w && lon <= r.e && lat >= r.s && lat <= r.n) return r;
    }
    return null;
  }

  // ---------------- UI patch ----------------
  function patchUI() {
    const catChip = document.querySelector('#categoryChips .chip[data-cat="eventi"]');
    if (catChip) catChip.textContent = "✨ Mai fatto";

    const box = document.getElementById("eventsSubfilters");
    if (box) {
      const smalls = box.querySelectorAll(".small");
      if (smalls && smalls[0]) smalls[0].textContent = "Mai fatto (scegli il tipo di WOW)";
      const info = box.querySelector(".small.muted");
      if (info) info.textContent = "Offline: idee WOW • regione → regioni vicine → Italia • anti-famoso soft.";
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
  }

  patchUI();
  setTimeout(patchUI, 50);

  // ---------------- dataset cache ----------------
  let DATASET = null;
  let DATASET_META = { updated_at: "", count: 0, source: "", area: "" };

  async function fetchJson(url) {
    const r = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} loading ${url}`);
    return await r.json();
  }

  function extractIdeasFromMaiFattoJson(j) {
    const ideas = Array.isArray(j?.ideas) ? j.ideas : [];
    const meta = {
      updated_at: j?.updated_at || "",
      count: j?.count ?? ideas.length,
      source: (ideas[0]?.source || "mai_fatto_offline_poi"),
      area: j?.area || "",
    };
    return { ideas, meta };
  }

  function mapEventsFallback(j2) {
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
      info_url: e.info_url || e.url || "",
      url: e.url,
      source: e.source || "fallback_events",
      wow_score: typeof e.wow_score === "number" ? e.wow_score : 0,
    }));
    const meta = {
      updated_at: j2?.updated_at || "",
      count: j2?.count ?? ideas.length,
      source: "fallback_events",
      area: "fallback_events • events_all.json",
    };
    return { ideas, meta };
  }

  // Costruisce lista URL da provare in base all’origin
  function buildUrlPlanForOrigin(origin) {
    const r = regionFromOrigin(origin);
    const plan = [];

    // 1) Regione dell’origin
    if (r?.slug) plan.push(REGION_DATASET_BY_SLUG(r.slug));

    // 2) Regioni vicine
    const neigh = (r?.slug && NEIGHBORS[r.slug]) ? NEIGHBORS[r.slug] : [];
    for (const s of neigh) plan.push(REGION_DATASET_BY_SLUG(s));

    // 3) Italia intera
    for (const u of IT_ALL_URLS) plan.push(u);

    // 4) SOLO se sei in Veneto: allow “verona” (file che tu hai)
    //    (così non ci finisci da Abruzzo)
    if (r?.slug === "veneto") {
      plan.push("/data/mai_fatto/mai_fatto_it_verona.json");
      plan.push("/data/mai_fatto/mai_fatto_it_veneto.json");
    }

    // 5) Ultimissimo fallback: verona (ma verrà filtrata per distanza, quindi non “ti ci porta” davvero)
    plan.push("/data/mai_fatto/mai_fatto_it_verona.json");

    // dedupe
    return Array.from(new Set(plan));
  }

  async function loadDatasetForOrigin(origin) {
    const urls = buildUrlPlanForOrigin(origin);

    for (const url of urls) {
      try {
        const j = await fetchJson(url);
        const { ideas, meta } = extractIdeasFromMaiFattoJson(j);
        if (ideas.length) {
          DATASET_META = meta;
          return { ideas, from: url, mode: "mai_fatto" };
        }
      } catch (_) {
        // next
      }
    }

    // Fallback eventi
    const j2 = await fetchJson(FALLBACK_EVENTS_URL);
    const { ideas, meta } = mapEventsFallback(j2);
    DATASET_META = meta;
    return { ideas, from: FALLBACK_EVENTS_URL, mode: "fallback_events" };
  }

  // ---------------- selection ----------------
  function pickIdeas({ all, origin, maxMinutes, eventType, haversineKm, estCarMinutesFromKm }) {
    let list = Array.isArray(all) ? all.slice() : [];

    const mm = Math.max(15, Number(maxMinutes) || 120);
    const et = normalizeCategory(eventType || "tutti");

    // filtro per categoria
    if (et && et !== "tutti") {
      list = list.filter((e) => normalizeCategory(e.category) === et);
    }

    // distanza + minuti (se origin presente)
    let withDist = list;

    if (origin && typeof origin.lat === "number" && typeof origin.lon === "number") {
      withDist = list
        .map((e) => {
          if (typeof e.lat !== "number" || typeof e.lon !== "number") return null;
          const km = typeof haversineKm === "function"
            ? haversineKm(origin.lat, origin.lon, e.lat, e.lon)
            : null;
          const mins = km == null ? null : approxMinutesFromKm(km, estCarMinutesFromKm);
          const wow = typeof e.wow_score === "number" ? e.wow_score : 0;
          return { e, mins, wow };
        })
        .filter(Boolean);
    } else {
      withDist = list.map((e) => ({ e, mins: null, wow: typeof e.wow_score === "number" ? e.wow_score : 0 }));
    }

    // 1) Anti-famoso SOFT (prima prova a toglierli, se rimane poco → si allenta)
    const softFiltered = withDist remindingAntiFamous(withDist);

    function remindingAntiFamous(arr) {
      const a = arr.filter((x) => !isTooFamous(x.e));
      // se dopo il filtro restano troppo pochi, non filtrare
      if (a.length >= Math.min(8, arr.length)) return a;
      return arr;
    }

    // 2) entro minuti (soft widen +30%)
    const maxSoft = Math.round(mm * 1.3);
    const inside = softFiltered.filter((x) => (x.mins == null ? true : x.mins <= maxSoft));

    // remind: se dentro rimane pochissimo, allenta ulteriormente fino a 2.1x (evita “0 risultati” assurdi)
    const widened = inside.length >= 6 ? inside : softFiltered.filter((x) => (x.mins == null ? true : x.mins <= Math.round(mm * 2.1)));

    // ordina: prima vicino, poi wow
    widened.sort((a, b) => (a.mins ?? 999999) - (b.mins ?? 999999) || (b.wow - a.wow));

    // dedupe by id/title
    const out = [];
    const seen = new Set();
    for (const x of widened) {
      const e = x.e;
      const k = (e.id || `${e.title}|${e.lat},${e.lon}`).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
      if (out.length >= SHOW_LIMIT) break;
    }

    return out;
  }

  // ---------------- render ----------------
  function renderIntoResultArea({ items, maxMinutes, origin, extraLine }) {
    const area = document.getElementById("resultArea");
    if (!area) return;

    const updated = DATASET_META.updated_at ? fmtDateShort(DATASET_META.updated_at) : "";
    const total = DATASET_META.count || (Array.isArray(items) ? items.length : 0);
    const areaName = DATASET_META.area ? ` • ${esc(DATASET_META.area)}` : "";

    if (!items || !items.length) {
      area.innerHTML = `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
          <div style="font-weight:950; font-size:18px;">😕 Nessuna idea trovata</div>
          <div class="small muted" style="margin-top:8px; line-height:1.45;">
            Aumenta i minuti (ora: <b>${esc(maxMinutes)}</b>) oppure cambia tipo di WOW.
          </div>
          <div class="small muted" style="margin-top:10px;">
            ${updated ? `Dataset aggiornato ${esc(updated)}` : "Dataset offline"} • totale ${esc(total)}${areaName}
          </div>
          ${extraLine ? `<div class="small muted" style="margin-top:6px;">${esc(extraLine)}</div>` : ""}
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
            Fonte: ${esc(e.source || DATASET_META.source || "mai_fatto")}
          </div>
        </div>
      `;
    }).join("");

    area.innerHTML = `
      <div class="card clickSafe" style="box-shadow:none; border-color:rgba(0,224,255,.20); background:rgba(0,224,255,.05);">
        <div style="font-weight:950; font-size:18px;">✨ MAI FATTO — WOW vicini</div>
        <div class="small muted" style="margin-top:6px;">
          ${updated ? `Dataset aggiornato ${esc(updated)}` : "Dataset offline"} • totale ${esc(total)}${areaName}
        </div>
        <div class="small muted" style="margin-top:6px;">
          Mostrate: ${esc(items.length)} • entro ~${esc(maxMinutes)} min (widen soft incluso)
        </div>
        ${extraLine ? `<div class="small muted" style="margin-top:6px;">${esc(extraLine)}</div>` : ""}
      </div>
      ${cards}
    `;
  }

  // ---------------- public API ----------------
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

      // carica dataset in base all’origin (region-first)
      if (!DATASET) {
        const pack = await loadDatasetForOrigin(origin);
        DATASET = pack.ideas;

        // arricchisci meta per debug leggibile
        const r = regionFromOrigin(origin);
        const rName = r?.name ? `origin=${r.name}` : "origin=?";

        const extra =
          pack.mode === "fallback_events"
            ? `fallback_events • widen-by-distance • ${rName}`
            : `region-first • ${rName}`;

        // metto una riga “extraLine” nel render (non rompe UI)
        DATASET_META.area = DATASET_META.area ? `${DATASET_META.area} • ${extra}` : extra;
      }

      const all = Array.isArray(DATASET) ? DATASET : [];
      if (!all.length) {
        showStatus?.("warn", "Dataset MAI FATTO vuoto o mancante.");
        renderIntoResultArea({
          items: [],
          maxMinutes,
          origin,
          extraLine: "Controlla che esista almeno un file /data/mai_fatto/mai_fatto_it_<regione>.json con { ideas: [...] }."
        });
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

      renderIntoResultArea({ items, maxMinutes, origin });
      showStatus?.("ok", `Mai fatto: trovate ${items.length} proposte ✅`);
      scrollToId?.("resultCard");
    } catch (err) {
      console.error(err);
      showStatus?.("err", "Errore MAI FATTO: modulo/dataset non valido.");
      const area = document.getElementById("resultArea");
      if (area) {
        area.innerHTML = `
          <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
            <div style="font-weight:950; font-size:18px;">❌ MAI FATTO non disponibile</div>
            <div class="small muted" style="margin-top:8px; line-height:1.45;">
              Controlla che esista almeno un file in <b>/public/data/mai_fatto/</b> con struttura:
              <br><b>{ "ideas": [ ... ] }</b>
              <br>e che i record abbiano <b>lat/lon</b>.
            </div>
          </div>
        `;
      }
      scrollToId?.("resultCard");
    }
  }

  window.JAMO_EVENTS = { run };
})();
