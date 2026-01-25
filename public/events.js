/* public/events.js — JAMO_MAIFATTO bridge (OFFLINE • WOW-first • robust)
 * Compatibile con app.js v22.2
 *
 * ✅ "Eventi" => "✨ Mai fatto"
 * ✅ Subcategorie: relax, famiglia, bici, moto, natura, pioggia, tramonto, mangiare, 1h, 2h
 * ✅ 1h/2h filtrano su duration_bucket (NON su category) + fallback su duration_min
 * ✅ Regione scelta da COORDINATE (bbox), non da origin.region
 * ✅ Anti-famoso SOFT (non blocca)
 * ✅ Mai 0 “per colpa del filtro”: se il filtro è troppo stretto, si allenta
 *
 * ✅ FIX LINK:
 *    - "🧭 Vai" = directions con ORIGIN (coord) ma DESTINAZIONE testuale (nome+luogo), no coord che sballano
 *    - "📍 Apri posto" = Google Maps search con nome+luogo (sempre preciso)
 *    - "🧩 Info" = solo se info_url è un vero link informativo (non una search generica)
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

  const DS = {
    abruzzo: "/data/mai_fatto/mai_fatto_it_abruzzo.json",
    verona:  "/data/mai_fatto/mai_fatto_it_verona.json",
    all:     "/data/mai_fatto/mai_fatto_it_all.json",
  };

  const FALLBACK_URL = "/data/events/events_all.json";
  const SHOW_LIMIT = 18;

  // anti-ovvio soft (solo per zona VR, puoi estendere)
  const TOO_FAMOUS_WORDS = [
    "lazise","sirmione","gardaland","lungolago","piazza bra","via mazzini","piazza erbe",
    "arena di verona","juliet","giulietta","casa di giulietta","centro verona",
  ];

  // ------------------ helpers ------------------
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

  function approxMinutesFromKm(km, estCarMinutesFromKm) {
    if (typeof estCarMinutesFromKm === "function") return estCarMinutesFromKm(km);
    return Math.round(km + 8);
  }

  // ------------------ query/link builders (TESTO, non coord) ------------------
  function cleanJoin(parts) {
    return parts
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Query "precisa": meglio usare place + city + region (title a volte è “narrativa”)
  function placeQuery(e) {
    const place = (e.place || "").trim();
    const city = (e.city || "").trim();
    const region = (e.region || "").trim();

    // fallback: se place manca, usa title
    const base = place || (e.title || "").trim();
    const q = cleanJoin([base, city, region, "Italia"]);
    return q || "";
  }

  function mapsSearchUrl(q) {
    if (!q) return "";
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  }

  // Directions: origin coord (ok), destination TESTO (nome+luogo) => più affidabile delle coord che “sballano”
  function mapsDirUrlTextDest({ oLat, oLon, destQuery, mode }) {
    const m = mode || "driving";
    const base = `https://www.google.com/maps/dir/?api=1`;
    const originPart =
      (Number.isFinite(oLat) && Number.isFinite(oLon))
        ? `&origin=${encodeURIComponent(`${oLat},${oLon}`)}`
        : "";
    const dest = destQuery ? `&destination=${encodeURIComponent(destQuery)}` : "";
    if (!dest) return "";
    return `${base}${originPart}${dest}&travelmode=${encodeURIComponent(m)}`;
  }

  // Info URL: lo mostriamo SOLO se sembra una pagina “info” vera (non una search maps che già facciamo)
  function isProbablyInfoUrl(u) {
    const s = String(u || "").trim();
    if (!s) return false;
    if (!/^https?:\/\//i.test(s)) return false;
    // se è già una maps search generica, non serve
    if (s.includes("google.com/maps/search")) return false;
    return true;
  }

  // ------------------ Normalizzazione chiavi ------------------
  function normalizeKey(k) {
    const s = String(k || "").toLowerCase().trim();
    if (!s) return "tutti";
    if (s === "1 ora" || s === "1h" || s === "1_ora" || s === "1ora") return "1h";
    if (s === "2 ore" || s === "2h" || s === "2_ore" || s === "2ore") return "2h";
    if (s === "family") return "famiglia";
    if (s === "food") return "mangiare";
    if (s === "mangia" || s === "cibo") return "mangiare";
    return s;
  }

  function normalizeCategoryFromData(cat) {
    const s = String(cat || "").toLowerCase().trim();
    if (!s) return "";
    if (s === "family") return "famiglia";
    if (s === "food") return "mangiare";
    if (s === "mangiare" || s === "food") return "mangiare";
    return s;
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
      tutti: "Tutti",
    };
    return m[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : "Idea");
  }

  function isTooFamous(e) {
    const hay = `${e.title || ""} ${e.place || ""} ${e.city || ""}`.toLowerCase();
    return TOO_FAMOUS_WORDS.some((w) => hay.includes(w));
  }

  // ------------------ UI patch (safe) ------------------
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

      const whenRow = document.getElementById("eventWhenChips");
      if (whenRow) {
        const parent = whenRow.closest("div");
        if (parent) parent.style.display = "none";
      }

      const info = document.querySelector("#eventsSubfilters .small.muted");
      if (info) info.textContent = "Offline: idee WOW • regione → Italia • filtri soft • link precisi su Maps.";
    } catch (e) {
      console.warn("patchUI warning:", e);
    }
  }

  safePatchUI();
  setTimeout(safePatchUI, 50);

  // ------------------ cache dataset ------------------
  const CACHE = new Map(); // url -> { ideas, meta }
  let LAST_META = { updated_at: "", count: 0, source: "", area: "" };

  async function fetchJson(url) {
    const r = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} loading ${url}`);
    return await r.json();
  }

  // ✅ regione da coordinate (bbox)
  function regionKeyFromLatLon(origin) {
    const lat = Number(origin?.lat);
    const lon = Number(origin?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "all";

    const inBox = (w, s, e, n) => lon >= w && lon <= e && lat >= s && lat <= n;

    if (inBox(13.0, 41.65, 14.85, 42.95)) return "abruzzo";

    // Veneto/Verona proxy (larga, volutamente)
    if (inBox(10.2, 44.7, 12.3, 46.2)) return "verona";

    return "all";
  }

  function datasetOrder(origin) {
    const k = regionKeyFromLatLon(origin);
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
      wow_score: e.wow_score,
    }));

    LAST_META = {
      updated_at: j2?.updated_at || "",
      count: j2?.count ?? ideas.length,
      source: "fallback_events",
      area: "events_all.json",
    };
    return ideas;
  }

  // ------------------ selection ------------------
  function matchesDurationBucket(e, wantKey) {
    const b = normalizeKey(e.duration_bucket || "");
    if (wantKey === "1h") {
      if (b === "1h") return true;
      const m = Number(e.duration_min);
      if (Number.isFinite(m) && m <= 100) return true;
      return false;
    }
    if (wantKey === "2h") {
      if (b === "2h") return true;
      const m = Number(e.duration_min);
      if (Number.isFinite(m) && m > 100 && m <= 170) return true;
      return false;
    }
    return true;
  }

  function pickIdeas({ all, origin, maxMinutes, eventType, haversineKm, estCarMinutesFromKm }) {
    let list = Array.isArray(all) ? all.slice() : [];
    const mm = Math.max(15, Number(maxMinutes) || 120);
    const et = normalizeKey(eventType || "tutti");

    const filterStrict = (arr) => {
      let out = arr;

      if (et === "1h" || et === "2h") {
        out = out.filter((e) => matchesDurationBucket(e, et));
      } else if (et && et !== "tutti") {
        out = out.filter((e) => normalizeCategoryFromData(e.category) === et);
      }

      return out;
    };

    const beforeStrict = list.length;
    list = filterStrict(list);

    // anti-famoso soft
    const preAnti = list.length;
    list = list.filter((e) => !isTooFamous(e));
    if (preAnti > 0 && list.length < Math.min(8, Math.round(preAnti * 0.15))) {
      list = filterStrict(Array.isArray(all) ? all.slice() : []);
    }

    // allenta se troppo poco
    if (beforeStrict > 0 && list.length < 4) {
      if (et === "1h" || et === "2h") {
        list = Array.isArray(all) ? all.slice() : [];
      } else if (et && et !== "tutti") {
        list = (Array.isArray(all) ? all.slice() : []).filter((e) => {
          const c = normalizeCategoryFromData(e.category);
          if (c === et) return true;
          if (et === "famiglia" && c === "family") return true;
          if (et === "mangiare" && c === "food") return true;
          return false;
        });
      }
    }

    // distanza + minuti (filtra SOLO per minuti impostati)
    if (origin && typeof origin.lat === "number" && typeof origin.lon === "number") {
      list = list
        .map((e) => {
          const lat = Number(e.lat);
          const lon = Number(e.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

          const km = typeof haversineKm === "function"
            ? haversineKm(origin.lat, origin.lon, lat, lon)
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
        .map((e) => ({ e, wow: typeof e.wow_score === "number" ? e.wow_score : 0 }))
        .sort((a, b) => b.wow - a.wow)
        .map((x) => x.e);
    }

    return list.slice(0, SHOW_LIMIT);
  }

  // ------------------ render ------------------
  function renderIntoResultArea({ items, maxMinutes, origin }) {
    const area = document.getElementById("resultArea");
    if (!area) return;

    const updated = LAST_META.updated_at ? fmtDateShort(LAST_META.updated_at) : "";
    const total = LAST_META.count || (Array.isArray(items) ? items.length : 0);
    const areaName = LAST_META.area ? ` • ${esc(LAST_META.area)}` : "";

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
        </div>
      `;
      return;
    }

    const cards = items.map((e) => {
      const title = e.title || "Idea WOW";
      const where = nicePlaceLine(e);
      const why = (e.why || "").trim();

      const catKey = normalizeKey(normalizeCategoryFromData(e.category));
      const catLabel = labelCategory(catKey);

      const durBucket = normalizeKey(e.duration_bucket || "");
      const durLine =
        (durBucket === "1h" || durBucket === "2h")
          ? `⏱️ ${durBucket.toUpperCase()} • ~${esc(e.duration_min || "")} min`
          : (e.duration_min ? `⏱️ ~${esc(e.duration_min)} min` : "");

      const oLat = Number(origin?.lat);
      const oLon = Number(origin?.lon);

      // ✅ link precisi
      const q = placeQuery(e);
      const openPlaceUrl = mapsSearchUrl(q); // sempre
      const goUrl = mapsDirUrlTextDest({ oLat, oLon, destQuery: q, mode: "driving" }); // directions, dest testuale

      const infoUrlRaw = (e.info_url || e.url || "").trim();
      const infoUrl = isProbablyInfoUrl(infoUrlRaw) ? infoUrlRaw : "";

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
            ${(durBucket === "1h" || durBucket === "2h") ? pill(labelCategory(durBucket)) : ""}
          </div>

          ${
            why
              ? `<div class="small muted" style="margin-top:12px; line-height:1.55;">
                   <b style="color:#fff;">Perché te lo propongo:</b> ${esc(why)}
                 </div>`
              : ""
          }

          <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px;">
            ${goUrl ? `<a class="btn btnPrimary" href="${esc(goUrl)}" target="_blank" rel="noopener">🧭 Vai</a>` : ""}
            ${openPlaceUrl ? `<a class="btn" href="${esc(openPlaceUrl)}" target="_blank" rel="noopener">📍 Apri posto</a>` : ""}
            ${infoUrl ? `<a class="btn" href="${esc(infoUrl)}" target="_blank" rel="noopener">🧩 Info</a>` : ""}
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
          ${updated ? `Dataset aggiornato ${esc(updated)}` : "Dataset offline"} • totale ${esc(total)}${areaName}
        </div>
        <div class="small muted" style="margin-top:6px;">
          Mostrate: ${esc(items.length)} • entro ~${esc(maxMinutes)} min (estensione soft inclusa)
        </div>
      </div>
      ${cards}
    `;
  }

  // ------------------ public API ------------------
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

  window.JAMO_EVENTS = { run };
})();
