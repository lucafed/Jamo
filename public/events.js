/* public/events.js — JAMO_MAIFATTO bridge (offline, idee REALI)
 * Compatibile con app.js v22.2 (runEventsSearchBridge)
 *
 * ✅ UI: "Eventi" => "MAI FATTO"
 * ✅ Sottocategorie: Relax, Famiglia, Bici, Moto, Natura, Pioggia, Tramonto, Mangiare, 1h, 2h
 * ✅ Match ESATTO categoria (niente mapping ambiguo)
 * ✅ Niente "quando" (non serve per mai-fatto)
 * ✅ "Vai" su Google Maps mantiene la PARTENZA impostata in app (origin=...)
 *
 * Dataset preferito:
 *  /data/mai_fatto/mai_fatto_it_verona.json
 *  { updated_at, count, ideas:[ { title, lat, lon, place, city, region, category, duration_min, why } ] }
 *
 * Fallback (se esiste, per non rompere):
 *  /data/events/events_all.json
 */

(() => {
  "use strict";

  const PRIMARY_URL = "/data/mai_fatto/mai_fatto_it_verona.json";
  const FALLBACK_URL = "/data/events/events_all.json";

  const SHOW_LIMIT = 12;

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

  // ✅ Google Maps: mantiene origin della app (coordinate o testo)
  function mapsDirUrl(origin, destLat, destLon, mode) {
    const m = mode || "driving";
    const dest = `${destLat},${destLon}`;

    // Origin preferito: lat/lon
    let org = "";
    if (origin && typeof origin.lat === "number" && typeof origin.lon === "number") {
      org = `${origin.lat},${origin.lon}`;
    } else {
      // fallback: prova a usare label inserita dall'utente
      const lbl = (document.getElementById("originLabel")?.value || "").trim();
      if (lbl) org = lbl;
    }

    const base = `https://www.google.com/maps/dir/?api=1`;
    const originPart = org ? `&origin=${encodeURIComponent(org)}` : "";
    const destPart = `&destination=${encodeURIComponent(dest)}`;
    return `${base}${originPart}${destPart}&travelmode=${encodeURIComponent(m)}`;
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

  function labelCategory(k) {
    const m = {
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

    // nascondi "quando"
    const whenRow = document.getElementById("eventWhenChips");
    if (whenRow) {
      const parent = whenRow.closest("div");
      if (parent) parent.style.display = "none";
    }

    const info = document.querySelector("#eventsSubfilters .small.muted");
    if (info) info.textContent = "Offline: idee reali curate. (Niente date, niente confusione).";
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

  // ---------- selection ----------
  function pickIdeas({ all, origin, maxMinutes, eventType, haversineKm, estCarMinutesFromKm }) {
    let list = Array.isArray(all) ? all.slice() : [];

    const mm = Number(maxMinutes) || 120;
    const et = normalizeCategory(eventType || "tutti");

    if (et && et !== "tutti") {
      list = list.filter((e) => normalizeCategory(e.category) === et);
    }

    if (origin && typeof origin.lat === "number" && typeof origin.lon === "number") {
      list = list
        .map((e) => {
          if (typeof e.lat !== "number" || typeof e.lon !== "number") return null;
          const km =
            typeof haversineKm === "function"
              ? haversineKm(origin.lat, origin.lon, e.lat, e.lon)
              : null;
          const mins = km == null ? null : approxMinutesFromKm(km, estCarMinutesFromKm);
          return { e, mins };
        })
        .filter(Boolean)
        .filter((x) => (x.mins == null ? true : x.mins <= mm))
        .sort((a, b) => (a.mins ?? 9999) - (b.mins ?? 9999))
        .map((x) => x.e);
    }

    return list.slice(0, SHOW_LIMIT);
  }

  // ---------- render ----------
  function renderIntoResultArea({ items, origin, maxMinutes }) {
    const area = document.getElementById("resultArea");
    if (!area) return;

    const updated = DATASET_META.updated_at ? fmtDateShort(DATASET_META.updated_at) : "";
    const total = DATASET_META.count || (Array.isArray(items) ? items.length : 0);

    if (!items || !items.length) {
      area.innerHTML = `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
          <div style="font-weight:950; font-size:18px;">😕 Nessuna idea trovata</div>
          <div class="small muted" style="margin-top:8px; line-height:1.45;">
            Aumenta i minuti (ora: <b>${esc(maxMinutes)}</b>) oppure cambia categoria Mai fatto.
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
        const why = e.why || "";

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

        const infoUrl = e.url ? String(e.url) : "";
        const wiki =
          where
            ? `https://www.google.com/search?q=${encodeURIComponent(where + " cosa vedere")}`
            : "";

        // ✅ LUOGO IN EVIDENZA: subito sotto il titolo
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
              ${mapsWalk ? `<a class="btn" href="${esc(mapsWalk)}" target="_blank" rel="noopener">🚶 A piedi</a>` : ""}
              ${mapsBike ? `<a class="btn" href="${esc(mapsBike)}" target="_blank" rel="noopener">🚴 Bici</a>` : ""}
              ${infoUrl ? `<a class="btnGhost" href="${esc(infoUrl)}" target="_blank" rel="noopener">🔎 Cosa c’è</a>` : ""}
              ${!infoUrl && wiki ? `<a class="btnGhost" href="${esc(wiki)}" target="_blank" rel="noopener">🔎 Cosa c’è</a>` : ""}
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

      // salva origin per eventuali usi futuri (debug ecc.)
      window.__JAMO_ORIGIN__ = origin || null;

      if (!DATASET) DATASET = await loadDataset();
      const all = Array.isArray(DATASET) ? DATASET : [];

      if (!all.length) {
        showStatus?.("warn", "Dataset MAI FATTO vuoto.");
        renderIntoResultArea({ items: [], origin, maxMinutes });
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

      renderIntoResultArea({ items, origin, maxMinutes });
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
```0
