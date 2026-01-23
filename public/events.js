/* public/events.js — JAMO_MAIFATTO bridge (offline, idee REALI, WOW-first)
 * Compatibile con app.js v22.2 (runEventsSearchBridge)
 *
 * ✅ UI: "Eventi" => "✨ Mai fatto"
 * ✅ Sottocategorie (key): relax, famiglia, bici, moto, natura, pioggia, tramonto, mangiare, 1h, 2h
 * ✅ Cards: SOLO "Perché te lo propongo" (niente "cosa fare")
 * ✅ Bottone "Cosa c'è" (info_url o Google Maps search)
 * ✅ Google Maps "Vai" mantiene la PARTENZA impostata in app (origin=lat,lon)
 *
 * ✅ FIX importanti (quelli che ti servono):
 * - MAI più “salto a Verona”: selezione sempre per distanza/tempo dall’origin
 * - Niente fallback_events finché esiste QUALSIASI idea Mai-Fatto in Italia
 * - Widen progressivo: entro minuti → regioni vicine (di fatto: più km) → Italia (ancora per distanza)
 * - Anti-famoso SOFT: se filtra troppo, si disattiva automaticamente
 *
 * Dataset preferiti (in ordine):
 *  /data/mai_fatto/mai_fatto_it_all.json
 *  /data/mai_fatto/mai_fatto_it_abruzzo.json
 *  /data/mai_fatto/mai_fatto_it_verona.json
 *
 * Fallback (ultima spiaggia):
 *  /data/events/events_all.json
 */

(() => {
  "use strict";

  // ✅ Ordine: prima “Italia”, poi regioni specifiche (se manca it_all, almeno Abruzzo/Verona)
  const PRIMARY_URLS = [
    "/data/mai_fatto/mai_fatto_it_all.json",
    "/data/mai_fatto/mai_fatto_it_abruzzo.json",
    "/data/mai_fatto/mai_fatto_it_verona.json",
  ];

  const FALLBACK_URL = "/data/events/events_all.json";
  const SHOW_LIMIT = 18;

  // Anti-ovvio: SOFT (si applica solo se restano abbastanza risultati)
  const TOO_FAMOUS_WORDS = [
    "lazise",
    "sirmione",
    "gardaland",
    "garda (lungolago)",
    "lungolago garda",
    "lago di garda (lungolago)",
    "piazza bra",
    "via mazzini",
    "piazza erbe",
    "arena di verona",
    "juliet",
    "giulietta",
    "casa di giulietta",
    "centro verona",
  ];

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

  function infoUrlFor(e) {
    const u = (e.info_url || e.url || "").trim();
    if (u) return u;
    const q = [e.title, e.place, e.city, e.region].filter(Boolean).join(" ");
    if (!q.trim()) return "";
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      q
    )}`;
  }

  function approxMinutesFromKm(km, estCarMinutesFromKm) {
    if (typeof estCarMinutesFromKm === "function") return estCarMinutesFromKm(km);
    return Math.round(km + 8);
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

  // ---------- UI patch ----------
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
    if (info) info.textContent = "Offline: idee WOW • regione → regioni vicine → Italia • anti-famoso soft.";
  }

  patchUI();
  setTimeout(patchUI, 50);

  // ---------- dataset cache ----------
  let MAI_FATTO = null; // array idee (unione)
  let MAI_META = { updated_at: "", count: 0, source: "mai_fatto", area: "Italia" };

  async function fetchJson(url) {
    const r = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} loading ${url}`);
    return await r.json();
  }

  function toIdeaShape(x, fallbackSource) {
    // Normalizza sia “ideas” sia eventi fallback mappati
    return {
      id: x.id,
      title: x.title,
      place: x.place || x.title,
      city: x.city || "",
      region: x.region || "",
      country_code: x.country_code || "IT",
      lat: typeof x.lat === "number" ? x.lat : null,
      lon: typeof x.lon === "number" ? x.lon : null,
      category: normalizeCategory(x.category),
      duration_min: x.duration_min,
      why: x.why,
      info_url: x.info_url || x.url || "",
      url: x.url || "",
      wow_score: typeof x.wow_score === "number" ? x.wow_score : 0,
      source: x.source || fallbackSource || "mai_fatto",
    };
  }

  async function loadMaiFattoUnion() {
    const union = [];
    let updated = "";
    let total = 0;

    for (const url of PRIMARY_URLS) {
      try {
        const j = await fetchJson(url);
        const ideas = Array.isArray(j?.ideas) ? j.ideas : [];
        if (!ideas.length) continue;

        // meta: prendiamo la più recente (solo per UI)
        const u = j?.updated_at || "";
        if (u && (!updated || new Date(u).getTime() > new Date(updated).getTime())) updated = u;

        total += (j?.count ?? ideas.length);

        for (const it of ideas) {
          const e = toIdeaShape(it, (it?.source || "mai_fatto_offline_poi"));
          if (typeof e.lat !== "number" || typeof e.lon !== "number") continue;
          if (!e.title) continue;
          union.push(e);
        }
      } catch (_) {
        // ignora, continua
      }
    }

    // dedupe su id
    const seen = new Set();
    const out = [];
    for (const e of union) {
      const k = String(e.id || `${e.title}|${e.lat}|${e.lon}`);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }

    MAI_META = {
      updated_at: updated || "",
      count: total || out.length,
      source: "mai_fatto_offline_poi",
      area: "Italia (union)",
    };

    return out;
  }

  async function loadFallbackEventsAsIdeas() {
    const j2 = await fetchJson(FALLBACK_URL);
    const ev = Array.isArray(j2?.events) ? j2.events : [];
    const ideas = ev
      .map((e) => ({
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
      }))
      .map((x) => toIdeaShape(x, "fallback_events"))
      .filter((x) => typeof x.lat === "number" && typeof x.lon === "number" && x.title);

    return {
      meta: {
        updated_at: j2?.updated_at || "",
        count: j2?.count ?? ideas.length,
        source: "fallback_events",
        area: "events_all.json",
      },
      ideas,
    };
  }

  // ---------- selection ----------
  function pickMaiFatto({
    all,
    origin,
    maxMinutes,
    eventType,
    haversineKm,
    estCarMinutesFromKm,
  }) {
    const mmBase = Math.max(15, Number(maxMinutes) || 120);
    const et = normalizeCategory(eventType || "tutti");

    let list = Array.isArray(all) ? all.slice() : [];

    // Se non ho origin: prendo per wow_score (e basta)
    const hasOrigin = origin && typeof origin.lat === "number" && typeof origin.lon === "number";

    // helper: calcola mins
    const withMetrics = (arr) => {
      if (!hasOrigin) {
        return arr.map((e) => ({ e, mins: null, wow: typeof e.wow_score === "number" ? e.wow_score : 0 }));
      }
      return arr
        .map((e) => {
          const km =
            typeof haversineKm === "function"
              ? haversineKm(origin.lat, origin.lon, e.lat, e.lon)
              : null;
          const mins = km == null ? null : approxMinutesFromKm(km, estCarMinutesFromKm);
          const wow = typeof e.wow_score === "number" ? e.wow_score : 0;
          return { e, mins, wow };
        })
        .filter((x) => x.e && typeof x.e.lat === "number" && typeof x.e.lon === "number");
    };

    // Widen progressivo SOLO su Mai-Fatto (mai saltare in un’altra regione “a caso”)
    const widenSteps = hasOrigin
      ? [
          { label: `entro ${mmBase} min`, factor: 1.05 },
          { label: `widen → ${Math.round(mmBase * 1.6)} min`, factor: 1.6 },
          { label: `widen → ${Math.round(mmBase * 2.2)} min`, factor: 2.2 },
        ]
      : [{ label: "no-origin", factor: 999 }];

    let chosen = [];
    let debugWidenLabel = "";

    for (const step of widenSteps) {
      debugWidenLabel = step.label;

      // 1) filtro per distanza/minuti del passo
      let pool = list;
      if (hasOrigin) {
        const lim = Math.round(mmBase * step.factor);
        pool = withMetrics(pool)
          .filter((x) => (x.mins == null ? true : x.mins <= lim))
          .sort(
            (a, b) =>
              (a.mins ?? 999999) - (b.mins ?? 999999) ||
              (b.wow - a.wow)
          )
          .map((x) => x.e);
      } else {
        pool = withMetrics(pool)
          .sort((a, b) => (b.wow - a.wow))
          .map((x) => x.e);
      }

      // 2) applica categoria DOPO widen (questa era la tua richiesta pratica)
      if (et && et !== "tutti") {
        pool = pool.filter((e) => normalizeCategory(e.category) === et);
      }

      // 3) anti-famoso SOFT: solo se non ammazza tutto
      const anti = pool.filter((e) => !isTooFamous(e));
      // Se anti-famoso lascia almeno 40% o almeno 10 risultati, usalo; altrimenti disattivalo
      if (anti.length >= Math.min(10, Math.ceil(pool.length * 0.4))) {
        pool = anti;
      }

      // 4) se ho risultati “sufficienti”, stop
      if (pool.length) {
        chosen = pool.slice(0, SHOW_LIMIT);
        break;
      }
    }

    return { items: chosen, widenLabel: debugWidenLabel };
  }

  // ---------- render ----------
  function renderIntoResultArea({ items, maxMinutes, origin, metaLine }) {
    const area = document.getElementById("resultArea");
    if (!area) return;

    const updated = MAI_META.updated_at ? fmtDateShort(MAI_META.updated_at) : "";
    const total = MAI_META.count || (Array.isArray(items) ? items.length : 0);

    if (!items || !items.length) {
      area.innerHTML = `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
          <div style="font-weight:950; font-size:18px;">😕 Nessuna idea trovata</div>
          <div class="small muted" style="margin-top:8px; line-height:1.45;">
            Aumenta i minuti (ora: <b>${esc(maxMinutes)}</b>) oppure cambia tipo di WOW.
          </div>
          <div class="small muted" style="margin-top:10px;">
            ${updated ? `Dataset aggiornato ${esc(updated)}` : "Dataset offline"} • totale ${esc(total)} • ${esc(MAI_META.source)} • ${esc(MAI_META.area)}
          </div>
          ${metaLine ? `<div class="small muted" style="margin-top:6px;">${esc(metaLine)}</div>` : ""}
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
        const catLabel = labelCategory(catKey);
        const durLine = e.duration_min ? `⏱️ ~${esc(e.duration_min)} min` : "";

        const lat = e.lat;
        const lon = e.lon;
        const oLat = origin?.lat;
        const oLon = origin?.lon;

        const mapsAuto =
          typeof lat === "number" && typeof lon === "number"
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
              Fonte: ${esc(e.source || MAI_META.source || "mai_fatto")}
            </div>
          </div>
        `;
      })
      .join("");

    area.innerHTML = `
      <div class="card clickSafe" style="box-shadow:none; border-color:rgba(0,224,255,.20); background:rgba(0,224,255,.05);">
        <div style="font-weight:950; font-size:18px;">✨ MAI FATTO — WOW vicini</div>
        <div class="small muted" style="margin-top:6px;">
          ${updated ? `Dataset aggiornato ${esc(updated)}` : "Dataset offline"} • totale ${esc(total)} • ${esc(MAI_META.source)} • ${esc(MAI_META.area)}
        </div>
        <div class="small muted" style="margin-top:6px;">
          Mostrate: ${esc(items.length)} • entro ~${esc(maxMinutes)} min
        </div>
        ${metaLine ? `<div class="small muted" style="margin-top:6px;">${esc(metaLine)}</div>` : ""}
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
    scrollToId,
  }) {
    try {
      patchUI();

      // 1) Carica UNION Mai-Fatto (Italia) — se esiste, non usare fallback_events
      if (!MAI_FATTO) MAI_FATTO = await loadMaiFattoUnion();

      const allMai = Array.isArray(MAI_FATTO) ? MAI_FATTO : [];
      const hasAnyMai = allMai.length > 0;

      if (!hasAnyMai) {
        // Solo se non esiste proprio mai-fatto da nessuna parte → fallback
        const fb = await loadFallbackEventsAsIdeas();
        MAI_META = fb.meta;
        const sel = pickMaiFatto({
          all: fb.ideas,
          origin,
          maxMinutes,
          eventType,
          haversineKm,
          estCarMinutesFromKm,
        });
        renderIntoResultArea({
          items: sel.items,
          maxMinutes,
          origin,
          metaLine: `fallback_events • ${MAI_META.area} • ${sel.widenLabel}`,
        });
        showStatus?.("warn", `Mai fatto: 0 proposte (fallback).`);
        scrollToId?.("resultCard");
        return;
      }

      // 2) Se ho Mai-Fatto, selezione SEMPRE per distanza/tempo (mai “Verona a caso”)
      MAI_META.source = "mai_fatto_offline_poi";
      MAI_META.area = "mai_fatto (Italia)";

      const sel = pickMaiFatto({
        all: allMai,
        origin,
        maxMinutes,
        eventType,
        haversineKm,
        estCarMinutesFromKm,
      });

      // 3) Se per quella categoria non c’è nulla nemmeno dopo widen → (ultima spiaggia) fallback_events
      if (!sel.items.length) {
        const fb = await loadFallbackEventsAsIdeas();

        // meta UI: facciamo capire che è fallback, ma solo qui
        const sel2 = pickMaiFatto({
          all: fb.ideas,
          origin,
          maxMinutes: Math.round(Math.max(30, Number(maxMinutes) || 120) * 2.05),
          eventType,
          haversineKm,
          estCarMinutesFromKm,
        });

        MAI_META = fb.meta;
        renderIntoResultArea({
          items: sel2.items,
          maxMinutes: Math.round(Math.max(30, Number(maxMinutes) || 120) * 2.05),
          origin,
          metaLine: `fallback_events • ${MAI_META.area} • ${sel2.widenLabel}`,
        });

        showStatus?.("warn", `Mai fatto: 0 proposte (fallback).`);
        scrollToId?.("resultCard");
        return;
      }

      renderIntoResultArea({
        items: sel.items,
        maxMinutes,
        origin,
        metaLine: sel.widenLabel,
      });

      showStatus?.("ok", `Mai fatto: trovate ${sel.items.length} proposte ✅`);
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
              Controlla che esista almeno uno tra:
              <br><b>${esc(PRIMARY_URLS[0])}</b>
              <br><b>${esc(PRIMARY_URLS[1])}</b>
              <br><b>${esc(PRIMARY_URLS[2])}</b>
              <br>e che contenga <b>{ ideas: [...] }</b>.
            </div>
          </div>
        `;
      }
      scrollToId?.("resultCard");
    }
  }

  window.JAMO_EVENTS = { run };
})();
```0
