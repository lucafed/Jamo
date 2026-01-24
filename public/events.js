/* public/events.js — JAMO_MAIFATTO bridge (offline, idee REALI, WOW-first)
 * Compatibile con app.js v22.2 (runEventsSearchBridge)
 *
 * ✅ UI: "Eventi" => "✨ Mai fatto"
 * ✅ Sottocategorie (key): relax, famiglia, bici, moto, natura, pioggia, tramonto, mangiare, 1h, 2h
 * ✅ Cards: SOLO "Perché te lo propongo" (niente "cosa fare")
 * ✅ Bottone "Cosa c'è" (info_url o Google Maps search)
 * ✅ Google Maps "Vai" mantiene la PARTENZA impostata in app (origin=lat,lon)
 * ✅ Anti-ovvio: filtra luoghi troppo noti (soft)
 *
 * Dataset:
 *  /data/mai_fatto/mai_fatto_it_abruzzo.json
 *  /data/mai_fatto/mai_fatto_it_verona.json
 *  /data/mai_fatto/mai_fatto_it_all.json
 *
 * Fallback:
 *  /data/events/events_all.json
 */

(() => {
  "use strict";

  // --- DATASETS (scegliamo in base alla regione origin) ---
  const DS = {
    abruzzo: "/data/mai_fatto/mai_fatto_it_abruzzo.json",
    verona:  "/data/mai_fatto/mai_fatto_it_verona.json",
    all:     "/data/mai_fatto/mai_fatto_it_all.json",
  };

  const FALLBACK_URL = "/data/events/events_all.json";
  const SHOW_LIMIT = 18;

  // Anti-ovvio soft (puoi estendere/limitare)
  const TOO_FAMOUS_WORDS = [
    "lazise","sirmione","gardaland","lungolago","piazza bra","via mazzini","piazza erbe",
    "arena di verona","juliet","giulietta","casa di giulietta","centro verona",
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

  // Link “cosa c’è”: se c’è info_url lo usiamo, altrimenti facciamo una ricerca su Maps
  function infoUrlFor(e) {
    const u = (e.info_url || e.url || "").trim();
    if (u) return u;
    const q = [e.title, e.place, e.city].filter(Boolean).join(" ");
    if (!q.trim()) return "";
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
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
    // IMPORTANT: se l'app manda "food", nel dataset usiamo "mangiare"
    if (k === "food") return "mangiare";
    return k;
  }

  function normalizeDurationBucket(x) {
    const k = String(x || "").toLowerCase().trim();
    if (!k) return "";
    if (k.includes("1")) return "1h";
    if (k.includes("2")) return "2h";
    return k;
  }

  // ✅ NOMI WOW (solo per le SOTTOCATEGORIE di Mai fatto)
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
    const hay = `${e.title || ""} ${e.place || ""} ${e.city || ""}`.toLowerCase();
    return TOO_FAMOUS_WORDS.some(w => hay.includes(w));
  }

  function safePatchUI() {
    try {
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
      if (info) info.textContent = "Offline: idee WOW • regione → Italia • anti-famoso soft (non blocca).";
    } catch (e) {
      console.warn("patchUI warning:", e);
    }
  }

  safePatchUI();
  setTimeout(safePatchUI, 50);

  // ---------- dataset cache ----------
  const CACHE = new Map(); // url -> { ideas, meta }
  let LAST_META = { updated_at: "", count: 0, source: "", area: "" };

  async function fetchJson(url) {
    const r = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} loading ${url}`);
    return await r.json();
  }

  function regionKeyFromOrigin(origin) {
    const r = String(origin?.region || "").toLowerCase().trim();
    if (!r) return "";
    if (r.includes("abruzzo")) return "abruzzo";
    if (r.includes("veneto") || r.includes("verona")) return "verona";
    return "all";
  }

  function datasetOrder(origin) {
    const k = regionKeyFromOrigin(origin);
    if (k === "abruzzo") return [DS.abruzzo, DS.all, DS.verona];
    if (k === "verona")  return [DS.verona, DS.all, DS.abruzzo];
    return [DS.all, DS.verona, DS.abruzzo];
  }

  async function loadDatasetForOrigin(origin) {
    const urls = datasetOrder(origin);

    for (const url of urls) {
      try {
        if (CACHE.has(url)) {
          const cached = CACHE.get(url);
          LAST_META = cached.meta;
          return cached.ideas;
        }

        const j = await fetchJson(url);
        const ideas = Array.isArray(j?.ideas) ? j.ideas : [];
        if (ideas.length) {
          const meta = {
            updated_at: j?.updated_at || "",
            count: j?.count ?? ideas.length,
            source: ideas[0]?.source || "curated_mai_fatto",
            area: j?.area || url.split("/").pop(),
          };
          CACHE.set(url, { ideas, meta });
          LAST_META = meta;
          return ideas;
        }
      } catch (_) {}
    }

    // fallback events (per non rompere)
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
      duration_bucket: e.duration_bucket,
      duration_min: e.duration_min,
      why: e.why,
      info_url: e.info_url || e.url || "",
      url: e.url,
      source: e.source || "events_fallback",
    }));

    LAST_META = {
      updated_at: j2?.updated_at || "",
      count: j2?.count ?? ideas.length,
      source: "fallback_events",
      area: "events_all.json",
    };
    return ideas;
  }

  // ---------- selection ----------
  function pickIdeas({ all, origin, maxMinutes, eventType, haversineKm, estCarMinutesFromKm }) {
    let list = Array.isArray(all) ? all.slice() : [];
    const mm = Math.max(15, Number(maxMinutes) || 120);
    const et = normalizeCategory(eventType || "tutti");

    // filtro categoria / durata
    if (et && et !== "tutti") {
      if (et === "1h" || et === "2h") {
        // FIX: in Abruzzo spesso è duration_bucket, NON category
        list = list.filter((e) => {
          const b = normalizeDurationBucket(e.duration_bucket);
          if (b) return b === et;

          const m = Number(e.duration_min);
          if (!Number.isFinite(m)) return false;
          // soglie soft
          return et === "1h" ? m <= 90 : m <= 150;
        });
      } else {
        list = list.filter((e) => normalizeCategory(e.category) === et);
      }
    }

    // anti-famoso soft: se dopo il filtro rimane troppo poco, lo disattiviamo automaticamente
    const pre = list.length;
    list = list.filter((e) => !isTooFamous(e));
    if (pre > 0 && list.length < Math.min(8, Math.round(pre * 0.15))) {
      list = Array.isArray(all) ? all.slice() : [];
      if (et && et !== "tutti") {
        if (et === "1h" || et === "2h") {
          list = list.filter((e) => {
            const b = normalizeDurationBucket(e.duration_bucket);
            if (b) return b === et;
            const m = Number(e.duration_min);
            if (!Number.isFinite(m)) return false;
            return et === "1h" ? m <= 90 : m <= 150;
          });
        } else {
          list = list.filter((e) => normalizeCategory(e.category) === et);
        }
      }
    }

    // distanza + minuti
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
        .filter((x) => (x.mins == null ? true : x.mins <= Math.round(mm * 1.35)))
        .sort((a, b) => (a.mins ?? 999999) - (b.mins ?? 999999) || (b.wow - a.wow))
        .map((x) => x.e);
    } else {
      list = list
        .map(e => ({ e, wow: typeof e.wow_score === "number" ? e.wow_score : 0 }))
        .sort((a,b)=> b.wow - a.wow)
        .map(x=>x.e);
    }

    return list.slice(0, SHOW_LIMIT);
  }

  // ---------- render ----------
  function renderIntoResultArea({ items, maxMinutes, origin }) {
    const area = document.getElementById("resultArea");
    if (!area) return;

    const updated = LAST_META.updated_at ? fmtDateShort(LAST_META.updated_at) : "";
    const total = LAST_META.count || (Array.isArray(items) ? items.length : 0);
    const areaName = LAST_META.area ? ` • ${esc(LAST_META.area)}` : "";
    const originReg = origin?.region ? ` • ${esc(origin.region)}` : "";

    if (!items || !items.length) {
      area.innerHTML = `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
          <div style="font-weight:950; font-size:18px;">😕 Nessuna idea trovata</div>
          <div class="small muted" style="margin-top:8px; line-height:1.45;">
            Aumenta i minuti (ora: <b>${esc(maxMinutes)}</b>) oppure cambia tipo di WOW.
          </div>
          <div class="small muted" style="margin-top:10px;">
            ${updated ? `Dataset aggiornato ${esc(updated)}` : "Dataset offline"} • totale ${esc(total)}${areaName}${originReg}
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
      const durKey = normalizeDurationBucket(e.duration_bucket);
      const badgeKey = (durKey === "1h" || durKey === "2h") ? durKey : catKey;
      const catLabel = labelCategory(badgeKey);

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
            Fonte: ${esc(e.source || LAST_META.source || "mai_fatto")}
          </div>
        </div>
      `;
    }).join("");

    area.innerHTML = `
      <div class="card clickSafe" style="box-shadow:none; border-color:rgba(0,224,255,.20); background:rgba(0,224,255,.05);">
        <div style="font-weight:950; font-size:18px;">✨ MAI FATTO — WOW vicini</div>
        <div class="small muted" style="margin-top:6px;">
          ${updated ? `Dataset aggiornato ${esc(updated)}` : "Dataset offline"} • totale ${esc(total)}${areaName}${originReg}
        </div>
        <div class="small muted" style="margin-top:6px;">
          Mostrate: ${esc(items.length)} • entro ~${esc(maxMinutes)} min (estensione soft inclusa)
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
    haversineKm,
    estCarMinutesFromKm,
    showStatus,
    scrollToId
  }) {
    try {
      safePatchUI();

      const all = await loadDatasetForOrigin(origin);

      if (!Array.isArray(all) || !all.length) {
        showStatus?.("warn", "Dataset MAI FATTO vuoto o mancante.");
        renderIntoResultArea({ items: [], maxMinutes, origin });
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
      showStatus?.("err", "Errore MAI FATTO: manca dataset oppure non è valido.");

      const area = document.getElementById("resultArea");
      if (area) {
        area.innerHTML = `
          <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
            <div style="font-weight:950; font-size:18px;">❌ MAI FATTO non disponibile</div>
            <div class="small muted" style="margin-top:8px; line-height:1.45;">
              Controlla che esista almeno uno tra:
              <br><b>${esc(DS.abruzzo)}</b>
              <br><b>${esc(DS.verona)}</b>
              <br><b>${esc(DS.all)}</b>
              <br>e che contenga <b>{ ideas: [...] }</b>.
            </div>
          </div>
        `;
      }
      scrollToId?.("resultCard");
    }
  }

  // IMPORTANTISSIMO: esporta SEMPRE il modulo
  window.JAMO_EVENTS = { run };
})();
