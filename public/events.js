/* public/events.js — JAMO_MAIFATTO bridge (IT ALL • WOW • food ricchissimo)
 * Compatibile con app.js v22.2 (runEventsSearchBridge)
 *
 * ✅ UI: "Eventi" => "MAI FATTO"
 * ✅ Sottocategorie: Relax, Famiglia, Bici, Moto, Natura, Pioggia, Tramonto, Mangiare, 1h, 2h
 * ✅ Dataset IT ALL: /data/mai_fatto/mai_fatto_it_all.json
 * ✅ Filtra per origin+minuti: così NON torna più sempre Verona
 * ✅ "Vai" mantiene la partenza impostata in app (origin=lat,lon su Google Maps)
 * ✅ NO "cosa fare" (mostra solo Perché te lo propongo)
 * ✅ Link "Vedi cosa c’è" (Maps search) + link OSM (se id OSM)
 */

(() => {
  "use strict";

  const PRIMARY_URL = "/data/mai_fatto/mai_fatto_it_all.json";
  const FALLBACK_URL = "/data/mai_fatto/mai_fatto_it_verona.json"; // opzionale: se lo tieni
  const EVENTS_FALLBACK_URL = "/data/events/events_all.json"; // ultima spiaggia, se esiste

  // --- risultati: aumentano coi minuti (30 min deve dare tante idee) ---
  function limitForMinutes(mm) {
    const m = Number(mm) || 120;
    if (m <= 30) return 20;
    if (m <= 60) return 28;
    if (m <= 90) return 34;
    if (m <= 120) return 40;
    if (m <= 180) return 52;
    return 64;
  }

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

  function nicePlaceLine(e) {
    const city = (e.city || "").trim();
    const place = (e.place || "").trim();
    const region = (e.region || "").trim();

    if (place && city) {
      if (place.toLowerCase() !== city.toLowerCase()) {
        return `${place} • ${city}${region ? " • " + region : ""}`;
      }
      return `${city}${region ? " • " + region : ""}`;
    }

    if (place && region) return `${place} • ${region}`;
    return place || city || region || "";
  }

  function pill(label, soft = true) {
    return `<span class="pill ${soft ? "soft" : ""}">${esc(label)}</span>`;
  }

  function approxMinutesFromKm(km, estCarMinutesFromKm) {
    if (typeof estCarMinutesFromKm === "function") return estCarMinutesFromKm(km);
    return Math.round((km / 60) * 60 + 8);
  }

  // Google Maps directions: mantiene ORIGIN dell’app
  function mapsDirUrlWithOrigin(origin, destLat, destLon, mode = "driving") {
    const o =
      origin && typeof origin.lat === "number" && typeof origin.lon === "number"
        ? `${origin.lat},${origin.lon}`
        : "";
    const d = `${destLat},${destLon}`;
    const base = "https://www.google.com/maps/dir/?api=1";
    const qs = [
      o ? `origin=${encodeURIComponent(o)}` : null,
      `destination=${encodeURIComponent(d)}`,
      `travelmode=${encodeURIComponent(mode)}`,
    ].filter(Boolean);
    return `${base}&${qs.join("&")}`;
  }

  // Google Maps search “cosa c’è lì”
  function mapsSearchUrl(query, lat, lon) {
    // Se ho lat/lon, centro la ricerca lì
    const q = query || "cosa vedere";
    const base = "https://www.google.com/maps/search/?api=1";
    const parts = [
      `query=${encodeURIComponent(q)}`,
      (typeof lat === "number" && typeof lon === "number")
        ? `query_place_id=${encodeURIComponent("")}` // non serve, ma lo lasciamo vuoto
        : null,
      (typeof lat === "number" && typeof lon === "number")
        ? `center=${encodeURIComponent(`${lat},${lon}`)}`
        : null
    ].filter(Boolean);
    return `${base}&${parts.join("&")}`;
  }

  // OSM link se id è nel formato it_node_123 / it_way_123 / it_relation_123
  function osmUrlFromId(id) {
    const s = String(id || "");
    const m = s.match(/^it_(node|way|relation)_(\d+)$/i);
    if (!m) return "";
    const type = m[1].toLowerCase();
    const num = m[2];
    return `https://www.openstreetmap.org/${type}/${num}`;
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

    // “Quando” non serve per mai-fatto
    const whenRow = document.getElementById("eventWhenChips");
    if (whenRow) {
      const parent = whenRow.closest("div");
      if (parent) parent.style.display = "none";
    }

    const info = document.querySelector("#eventsSubfilters .small.muted");
    if (info) info.textContent = "Offline: idee WOW curate (Italia intera). Cambiano con minuti + partenza.";
  }

  patchUI();
  setTimeout(patchUI, 50);

  // ---------- dataset cache ----------
  let DATASET = null;
  let META = { updated_at: "", count: 0, area: "", source: "" };

  async function fetchJson(url) {
    const r = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} loading ${url}`);
    return await r.json();
  }

  function normalizeIdea(x) {
    // normalizza i campi minimi
    if (!x || typeof x !== "object") return null;
    const lat = Number(x.lat);
    const lon = Number(x.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const id = x.id || "";
    const title = x.title || x.place || "Idea";
    const place = x.place || x.title || "";
    const city = x.city || "";
    const region = x.region || "";
    const category = normalizeCategory(x.category || "");
    const duration_min = x.duration_min ? Number(x.duration_min) : null;
    const why = x.why || "";
    const source = x.source || "mai_fatto";

    return {
      id, title, place, city, region,
      lat, lon, category,
      duration_min: Number.isFinite(duration_min) ? duration_min : null,
      why, source
    };
  }

  async function loadDataset() {
    // 1) IT ALL
    try {
      const j = await fetchJson(PRIMARY_URL);
      const ideas = Array.isArray(j?.ideas) ? j.ideas.map(normalizeIdea).filter(Boolean) : [];
      META = {
        updated_at: j?.updated_at || "",
        count: j?.count ?? ideas.length,
        area: j?.area || "Italia",
        source: "mai_fatto_it_all",
      };
      if (ideas.length) return ideas;
      throw new Error("Empty ideas in primary");
    } catch (e1) {
      // 2) fallback verona
      try {
        const j = await fetchJson(FALLBACK_URL);
        const ideas = Array.isArray(j?.ideas) ? j.ideas.map(normalizeIdea).filter(Boolean) : [];
        META = {
          updated_at: j?.updated_at || "",
          count: j?.count ?? ideas.length,
          area: j?.area || "Fallback",
          source: "mai_fatto_fallback",
        };
        if (ideas.length) return ideas;
        throw new Error("Empty ideas in fallback");
      } catch (e2) {
        // 3) events all (ultima spiaggia)
        const j2 = await fetchJson(EVENTS_FALLBACK_URL);
        const ev = Array.isArray(j2?.events) ? j2.events : [];
        const ideas = ev.map((x) => normalizeIdea({
          id: x.id,
          title: x.title,
          place: x.place,
          city: x.city,
          region: x.region,
          lat: x.lat,
          lon: x.lon,
          category: x.category,
          duration_min: x.duration_min,
          why: x.why,
          source: x.source || "events_fallback"
        })).filter(Boolean);

        META = {
          updated_at: j2?.updated_at || "",
          count: j2?.count ?? ideas.length,
          area: "events_fallback",
          source: "events_fallback",
        };
        return ideas;
      }
    }
  }

  // ---------- selection ----------
  function pickIdeas({ all, origin, maxMinutes, eventType, haversineKm, estCarMinutesFromKm }) {
    let list = Array.isArray(all) ? all.slice() : [];

    const mm = Number(maxMinutes) || 120;
    const limit = limitForMinutes(mm);
    const et = normalizeCategory(eventType || "tutti");

    // filtro categoria selezionata
    if (et && et !== "tutti") {
      list = list.filter((e) => normalizeCategory(e.category) === et);
    }

    // filtro distanza/tempo + sort
    if (origin && typeof origin.lat === "number" && typeof origin.lon === "number") {
      list = list
        .map((e) => {
          const km = typeof haversineKm === "function"
            ? haversineKm(origin.lat, origin.lon, e.lat, e.lon)
            : null;
          const mins = km == null ? null : approxMinutesFromKm(km, estCarMinutesFromKm);
          return { e, mins, km };
        })
        .filter((x) => (x.mins == null ? true : x.mins <= mm))
        .sort((a, b) => {
          // vicino prima
          const am = a.mins ?? 999999;
          const bm = b.mins ?? 999999;
          if (am !== bm) return am - bm;
          // poi un po’ di varietà: id
          return String(a.e.id).localeCompare(String(b.e.id));
        })
        .map((x) => {
          x.e._mins = x.mins;
          x.e._km = x.km;
          return x.e;
        });
    }

    // anti-duplicati per titolo simile
    const seen = new Set();
    const out = [];
    for (const e of list) {
      const k = String(e.title || "").toLowerCase().trim();
      if (!k) continue;
      const k2 = k.replace(/\s+/g, " ");
      if (seen.has(k2)) continue;
      seen.add(k2);
      out.push(e);
      if (out.length >= limit) break;
    }

    return out;
  }

  // ---------- render ----------
  function renderIntoResultArea({ items, origin, maxMinutes }) {
    const area = document.getElementById("resultArea");
    if (!area) return;

    const updated = META.updated_at ? fmtDateShort(META.updated_at) : "";
    const total = META.count || (Array.isArray(items) ? items.length : 0);

    if (!items || !items.length) {
      area.innerHTML = `
        <div class="card clickSafe" style="box-shadow:none; border-color:rgba(255,90,90,.40); background:rgba(255,90,90,.10);">
          <div style="font-weight:950; font-size:18px;">😕 Nessuna idea trovata</div>
          <div class="small muted" style="margin-top:8px; line-height:1.45;">
            Aumenta i minuti (ora: <b>${esc(maxMinutes)}</b>) oppure cambia categoria.
          </div>
          <div class="small muted" style="margin-top:10px;">
            ${updated ? `Dataset aggiornato ${esc(updated)}` : "Dataset offline"} • totale ${esc(total)} • ${esc(META.area || "")}
          </div>
        </div>
      `;
      return;
    }

    const header = `
      <div class="card clickSafe" style="box-shadow:none; border-color:rgba(0,224,255,.20); background:rgba(0,224,255,.05);">
        <div style="font-weight:950; font-size:18px;">✨ MAI FATTO — idee WOW</div>
        <div class="small muted" style="margin-top:6px;">
          ${updated ? `Aggiornato ${esc(updated)}` : "Offline"} • pool ${esc(total)} • ${esc(META.area || "Italia")}
        </div>
        <div class="small muted" style="margin-top:6px;">
          Mostrate: ${esc(items.length)} • entro ~${esc(maxMinutes)} min
        </div>
      </div>
    `;

    const cards = items.map((e) => {
      const title = e.title || "Idea";
      const where = nicePlaceLine(e);

      const catKey = normalizeCategory(e.category);
      const catLabel = labelCategory(catKey);

      const dur = e.duration_min ? `⏱️ ~${esc(e.duration_min)} min` : "";
      const mins = Number.isFinite(e._mins) ? ` • 🚗 ~${esc(Math.round(e._mins))} min` : "";

      // SOLO PERCHÉ LO PROPONGO (niente “cosa fare”)
      const why = (e.why || "").trim();

      const mapsAuto = mapsDirUrlWithOrigin(origin, e.lat, e.lon, "driving");
      const mapsWalk = mapsDirUrlWithOrigin(origin, e.lat, e.lon, "walking");
      const mapsBike = mapsDirUrlWithOrigin(origin, e.lat, e.lon, "bicycling");

      const searchQ = where ? `cosa vedere ${where}` : (e.place || e.title || "cosa vedere");
      const mapsSee = mapsSearchUrl(searchQ, e.lat, e.lon);

      const osm = osmUrlFromId(e.id);

      const placeBlock = where
        ? `<div style="margin-top:10px; font-weight:950; font-size:15px; letter-spacing:.2px;">
             📍 ${esc(where)}
           </div>`
        : "";

      const metaLine = (dur || mins)
        ? `<div class="small muted" style="margin-top:6px;">${dur}${mins}</div>`
        : "";

      return `
        <div class="card clickSafe" style="margin-top:12px; border-color:rgba(0,224,255,.14);">
          <div style="font-weight:950; font-size:20px; line-height:1.12;">${esc(title)}</div>

          ${placeBlock}
          ${metaLine}

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
            <a class="btn btnPrimary" href="${esc(mapsAuto)}" target="_blank" rel="noopener">🧭 Vai</a>
            <a class="btn" href="${esc(mapsWalk)}" target="_blank" rel="noopener">🚶 A piedi</a>
            <a class="btn" href="${esc(mapsBike)}" target="_blank" rel="noopener">🚴 Bici</a>
            <a class="btnGhost" href="${esc(mapsSee)}" target="_blank" rel="noopener">🔎 Vedi cosa c’è</a>
            ${osm ? `<a class="btnGhost" href="${esc(osm)}" target="_blank" rel="noopener">🗺️ OSM</a>` : ""}
          </div>

          <div class="small muted" style="margin-top:10px; opacity:.70;">
            Fonte: ${esc(e.source || META.source || "mai_fatto")}
          </div>
        </div>
      `;
    }).join("");

    area.innerHTML = `${header}${cards}`;
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
      showStatus?.("ok", `Mai fatto: trovate ${items.length} idee ✅`);
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
