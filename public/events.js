/* public/events.js — JAMO_MAIFATTO bridge (offline, idee REALI, WOW-first)
 * Compatibile con app.js v22.2 (JAMO_EVENTS.run)
 *
 * ✅ UI: "Eventi" => "✨ Mai fatto"
 * ✅ Sottocategorie (key): relax, famiglia, bici, moto, natura, pioggia, tramonto, mangiare, 1h, 2h
 * ✅ Cards: SOLO "Perché te lo propongo"
 * ✅ Bottone "Cosa c'è" (info_url o Google Maps search)
 * ✅ Google Maps "Vai" mantiene origin=lat,lon
 * ✅ Anti-ovvio SOFT
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

  const TOO_FAMOUS_WORDS = [
    "lazise","sirmione","gardaland","lungolago",
    "piazza bra","via mazzini","piazza erbe",
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

  function mapsDirUrl({ oLat, oLon, dLat, dLon, mode }) {
    const m = mode || "driving";
    const base = `https://www.google.com/maps/dir/?api=1`;
    const originPart =
      (Number.isFinite(oLat) && Number.isFinite(oLon))
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

  // ✅ SUPER-ROBUST LAT/LON: accetta lat/latitude, lon/lng/long/longitude, stringhe, ecc.
  function num(x) {
    const n = Number(String(x ?? "").replace(",", "."));
    return Number.isFinite(n) ? n : NaN;
  }
  function getLatLon(e) {
    if (!e || typeof e !== "object") return { lat: NaN, lon: NaN };

    // 1) top-level comuni
    let lat = num(e.lat ?? e.latitude);
    let lon = num(e.lon ?? e.lng ?? e.long ?? e.longitude);

    // 2) nested comuni (location/coords/center)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const cand = e.location || e.coords || e.center || e.point || null;
      if (cand && typeof cand === "object") {
        lat = Number.isFinite(lat) ? lat : num(cand.lat ?? cand.latitude);
        lon = Number.isFinite(lon) ? lon : num(cand.lon ?? cand.lng ?? cand.long ?? cand.longitude);
      }
    }

    // 3) array [lon, lat] (molto comune in geojson)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const a = e.coordinates || e.coord || e.coords_array || null;
      if (Array.isArray(a) && a.length >= 2) {
        const lon2 = num(a[0]);
        const lat2 = num(a[1]);
        if (Number.isFinite(lat2) && Number.isFinite(lon2)) {
          lat = lat2;
          lon = lon2;
        }
      }
    }

    return { lat, lon };
  }

  // ---------- UI patch ----------
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
      if (info) info.textContent = "Offline: regione → Italia • anti-famoso soft (non blocca).";
    } catch (e) {
      console.warn("events.js patchUI warning:", e);
    }
  }

  safePatchUI();
  setTimeout(safePatchUI, 50);

  // ---------- dataset cache ----------
  const CACHE = new Map(); // url -> { ideas, meta }
  let LAST_META = { updated_at: "", count: 0, source: "", area: "", bbox: null };

  async function fetchJson(url) {
    const r = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} loading ${url}`);
    return await r.json();
  }

  function inBBox(lat, lon, bb) {
    if (!bb) return false;
    return lat >= bb.s && lat <= bb.n && lon >= bb.w && lon <= bb.e;
  }

  async function loadDatasetForOrigin(origin) {
    const oLat = num(origin?.lat);
    const oLon = num(origin?.lon);

    const urls = [DS.abruzzo, DS.verona, DS.all];
    const loaded = [];

    for (const url of urls) {
      try {
        if (CACHE.has(url)) {
          const c = CACHE.get(url);
          loaded.push({ url, ideas: c.ideas, meta: c.meta, bbox: c.meta?.bbox || null });
          continue;
        }

        const j = await fetchJson(url);
        const ideas = Array.isArray(j?.ideas) ? j.ideas : [];
        if (!ideas.length) continue;

        const bbox = j?.stats?.bbox || null;

        const meta = {
          updated_at: j?.updated_at || "",
          count: j?.count ?? ideas.length,
          source: ideas[0]?.source || "curated_mai_fatto",
          area: j?.area || url.split("/").pop(),
          bbox,
        };

        CACHE.set(url, { ideas, meta });
        loaded.push({ url, ideas, meta, bbox });
      } catch (_) {}
    }

    if (Number.isFinite(oLat) && Number.isFinite(oLon)) {
      const hit = loaded.find((d) => d.bbox && inBBox(oLat, oLon, d.bbox));
      if (hit) {
        LAST_META = hit.meta;
        return hit.ideas;
      }
    }

    const all = loaded.find((d) => d.url === DS.all);
    if (all) {
      LAST_META = all.meta;
      return all.ideas;
    }

    loaded.sort((a, b) => (b.ideas?.length || 0) - (a.ideas?.length || 0));
    if (loaded[0]) {
      LAST_META = loaded[0].meta;
      return loaded[0].ideas;
    }

    const j2 = await fetchJson(FALLBACK_URL);
    const ev = Array.isArray(j2?.events) ? j2.events : [];
    const ideas = ev.map((e) => {
      const ll = getLatLon(e);
      return ({
        id: e.id,
        title: e.title,
        place: e.place,
        city: e.city,
        region: e.region,
        country_code: e.country_code,
        lat: ll.lat,
        lon: ll.lon,
        category: e.category,
        duration_min: e.duration_min,
        why: e.why,
        info_url: e.info_url || e.url || "",
        url: e.url,
        source: e.source || "events_fallback",
      });
    });

    LAST_META = {
      updated_at: j2?.updated_at || "",
      count: j2?.count ?? ideas.length,
      source: "fallback_events",
      area: "events_all.json",
      bbox: null,
    };
    return ideas;
  }

  // ---------- selection ----------
  function pickIdeas({ all, origin, maxMinutes, eventType, haversineKm, estCarMinutesFromKm }) {
    let list = Array.isArray(all) ? all.slice() : [];
    const mm = Math.max(15, Number(maxMinutes) || 120);
    const et = normalizeCategory(eventType || "tutti");

    if (et && et !== "tutti") {
      list = list.filter((e) => normalizeCategory(e.category) === et);
    }

    // anti-famoso soft (auto-disattiva se taglia troppo)
    const pre = list.length;
    const filteredAnti = list.filter((e) => !isTooFamous(e));
    if (pre > 0 && filteredAnti.length >= Math.min(8, Math.round(pre * 0.20))) {
      list = filteredAnti;
    }

    const oLat = num(origin?.lat);
    const oLon = num(origin?.lon);

    if (Number.isFinite(oLat) && Number.isFinite(oLon)) {
      list = list
        .map((e) => {
          const { lat, lon } = getLatLon(e);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

          const km = typeof haversineKm === "function"
            ? haversineKm(oLat, oLon, lat, lon)
            : null;

          const mins = km == null ? null : approxMinutesFromKm(km, estCarMinutesFromKm);
          const wow = typeof e.wow_score === "number" ? e.wow_score : 0;

          // scrivi normalizzato (così anche render/maps è coerente)
          e.lat = lat;
          e.lon = lon;

          return { e, mins, wow };
        })
        .filter(Boolean)
        // estensione soft fino a 1.35×
        .filter((x) => (x.mins == null ? true : x.mins <= Math.round(mm * 1.35)))
        // ordina: vicino, poi wow
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

  // ---------- render ----------
  function renderIntoResultArea({ items, maxMinutes, origin }) {
    const area = document.getElementById("resultArea");
    if (!area) return;

    const updated = LAST_META.updated_at ? fmtDateShort(LAST_META.updated_at) : "";
    const total = LAST_META.count || (Array.isArray(items) ? items.length : 0);
    const areaName = LAST_META.area ? ` • ${esc(LAST_META.area)}` : "";
    const originLine = origin?.label ? ` • da ${esc(origin.label)}` : "";

    if (!items || !items.length) {
      area.innerHTML = `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
          <div style="font-weight:950; font-size:18px;">😕 Nessuna idea trovata</div>
          <div class="small muted" style="margin-top:8px; line-height:1.45;">
            Aumenta i minuti (ora: <b>${esc(maxMinutes)}</b>) oppure cambia tipo di WOW.
          </div>
          <div class="small muted" style="margin-top:10px;">
            ${updated ? `Dataset aggiornato ${esc(updated)}` : "Dataset offline"} • totale ${esc(total)}${areaName}${originLine}
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

      const lat = num(e.lat);
      const lon = num(e.lon ?? e.lng);

      const oLat = num(origin?.lat);
      const oLon = num(origin?.lon);

      const mapsAuto =
        (Number.isFinite(lat) && Number.isFinite(lon))
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
          ${updated ? `Dataset aggiornato ${esc(updated)}` : "Dataset offline"} • totale ${esc(total)}${areaName}${originLine}
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
        estCarMinutesFromKm,
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
