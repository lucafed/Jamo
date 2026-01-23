/* public/events.js — JAMO_MAIFATTO (bbox region detect • nearby regions • balanced categories • no Verona fallback)
 * Compatibile con app.js v22.2 (cat "eventi" -> window.JAMO_EVENTS.run)
 *
 * ✅ Regione da BBOX (it-regions-index.json) => Sassa Scalo = Abruzzo (sempre)
 * ✅ Region-first, poi regioni vicine (per distanza) se pochi risultati
 * ✅ Poi Italia intera (mai_fatto_it_all.json) se esiste
 * ✅ Ultimo fallback: /data/events/events_all.json
 * ✅ "Tutti" = mix categorie (non solo family)
 * ✅ Anti-famoso = penalità (NON filtro duro) => non svuota Food/Tramonto
 */

(() => {
  "use strict";

  // ---------------- CONFIG ----------------
  const BASE_DIR = "/data/mai_fatto";
  const ALL_ITALY_URL = `${BASE_DIR}/mai_fatto_it_all.json`;
  const FALLBACK_URL = "/data/events/events_all.json";

  const IT_REGIONS_INDEX_URL = "/data/pois/regions/it-regions-index.json";

  const SHOW_LIMIT = 18;
  const MIN_RESULTS_OK = 8;     // “abbastanza” per fermarsi su una regione
  const SOFT_MIN_RESULTS = 3;   // sotto, proviamo regioni vicine

  const WIDEN_MULTS = [1.0, 1.25, 1.45, 1.70, 2.05];
  const WIDEN_CAP_MIN = 420;

  // Penalità soft se “troppo famoso” (non filter!)
  const TOO_FAMOUS_WORDS = [
    "gardaland",
    "piazza bra",
    "via mazzini",
    "piazza erbe",
    "arena di verona",
    "casa di giulietta",
    "lungolago",
    "colosseo",
    "fontana di trevi",
    "piazza san marco",
  ];
  const FAMOUS_PENALTY = 18; // punti wow_score sottratti

  // mix categories when "tutti"
  const CATEGORY_ORDER = ["tramonto","natura","relax","mangiare","famiglia","bici","moto","pioggia","1h","2h"];
  const CATEGORY_QUOTAS = {
    // quote massime per "tutti" (poi riempiamo con i restanti)
    tramonto: 3,
    natura: 4,
    relax: 2,
    mangiare: 3,
    famiglia: 3,
    bici: 1,
    moto: 1,
    pioggia: 1,
    "1h": 1,
    "2h": 2,
  };

  // ---------------- HELPERS ----------------
  const esc = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  function norm(s) {
    return String(s ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

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

  function isTooFamousIdea(e) {
    const hay = norm(`${e.title || ""} ${e.place || ""} ${e.city || ""} ${e.region || ""}`);
    if (!hay) return false;
    return TOO_FAMOUS_WORDS.some((w) => hay.includes(norm(w)));
  }

  function haversineKm(aLat, aLon, bLat, bLon) {
    const toRad = (x) => (x * Math.PI) / 180;
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

  function withinBBox(lat, lon, bbox) {
    if (!bbox) return false;
    return (
      lat >= bbox.minLat &&
      lat <= bbox.maxLat &&
      lon >= bbox.minLon &&
      lon <= bbox.maxLon
    );
  }

  function bboxCenter(bbox) {
    return {
      lat: (bbox.minLat + bbox.maxLat) / 2,
      lon: (bbox.minLon + bbox.maxLon) / 2,
    };
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

  function widenSteps(baseMin) {
    const base = Math.max(15, Number(baseMin) || 120);
    const steps = [];
    for (const m of WIDEN_MULTS) steps.push(Math.min(WIDEN_CAP_MIN, Math.round(base * m)));
    return Array.from(new Set(steps)).sort((a, b) => a - b);
  }

  // ---------------- UI PATCH ----------------
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

  // ---------------- DATA CACHE ----------------
  const CACHE = new Map(); // url -> { ideas, meta }
  let IT_REGIONS_INDEX = null;

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

  async function loadItalyRegionsIndexSafe() {
    if (IT_REGIONS_INDEX?.items?.length) return IT_REGIONS_INDEX;
    try {
      IT_REGIONS_INDEX = await fetchJson(IT_REGIONS_INDEX_URL);
    } catch {
      IT_REGIONS_INDEX = null;
    }
    return IT_REGIONS_INDEX;
  }

  function pickItalyRegionByOrigin(origin) {
    const lat = Number(origin?.lat);
    const lon = Number(origin?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const items = IT_REGIONS_INDEX?.items;
    if (!Array.isArray(items) || !items.length) return null;

    let best = null;
    for (const r of items) {
      if (!r?.bbox) continue;
      if (!withinBBox(lat, lon, r.bbox)) continue;
      const area = Math.abs((r.bbox.maxLat - r.bbox.minLat) * (r.bbox.maxLon - r.bbox.minLon));
      if (!best || area < best.area) best = { r, area };
    }
    return best?.r || null;
  }

  function regionDatasetUrlById(regionId) {
    // convenzione file: mai_fatto_it_<regionId>.json
    // es: it_abruzzo -> mai_fatto_it_it_abruzzo.json? NO.
    // Tu stai usando: mai_fatto_it_abruzzo.json (senza "it_").
    // Quindi: togli prefisso "it_" se presente.
    const id = String(regionId || "").trim();
    if (!id) return "";
    const slug = id.startsWith("it_") ? id.slice(3) : id;
    return `${BASE_DIR}/mai_fatto_it_${slug}.json`;
  }

  function sortNearbyRegions(origin, allRegions, currentId) {
    const lat = Number(origin?.lat);
    const lon = Number(origin?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];

    const list = [];
    for (const r of allRegions) {
      if (!r?.bbox || !r?.id) continue;
      if (String(r.id) === String(currentId)) continue;
      const c = bboxCenter(r.bbox);
      const d = haversineKm(lat, lon, c.lat, c.lon);
      list.push({ r, d });
    }
    list.sort((a, b) => a.d - b.d);
    return list.map(x => x.r);
  }

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

  // ---------------- SELECTION ----------------
  function scoreIdea(e) {
    // base wow_score + bonus micro + penalità famosi
    const base = (typeof e.wow_score === "number" ? e.wow_score : 0);
    const hasWhy = (e.why && String(e.why).trim().length > 20) ? 4 : 0;
    const famousPenalty = isTooFamousIdea(e) ? -FAMOUS_PENALTY : 0;
    const jitter = (Math.random() - 0.5) * 2;
    return base + hasWhy + famousPenalty + jitter;
  }

  function filterByType(all, eventType) {
    const et = normalizeCategory(eventType || "tutti");
    if (!et || et === "tutti") return all.slice();
    return all.filter((e) => normalizeCategory(e.category) === et);
  }

  function pickIdeasBalanced({ all, origin, maxMinutes, eventType, haversineKmFn, estCarMinutesFromKm }) {
    const mm = Math.max(15, Number(maxMinutes) || 120);
    let list = filterByType(Array.isArray(all) ? all : [], eventType);

    // calcola mins/distanza + score
    const haveOrigin = origin && Number.isFinite(Number(origin.lat)) && Number.isFinite(Number(origin.lon));

    const scored = list.map((e) => {
      let mins = null;
      if (haveOrigin && typeof e.lat === "number" && typeof e.lon === "number") {
        const km = typeof haversineKmFn === "function"
          ? haversineKmFn(origin.lat, origin.lon, e.lat, e.lon)
          : null;
        mins = (km == null ? null : approxMinutesFromKm(km, estCarMinutesFromKm));
      }
      return { e, mins, s: scoreIdea(e) };
    });

    // filtro minuti (se ho origin)
    const within = scored
      .filter(x => !haveOrigin || x.mins == null || x.mins <= mm)
      .sort((a,b) => (a.mins ?? 999999) - (b.mins ?? 999999) || (b.s - a.s));

    const et = normalizeCategory(eventType || "tutti");

    // se non è "tutti": prendi top semplice
    if (et && et !== "tutti") {
      return within.slice(0, SHOW_LIMIT).map(x => x.e);
    }

    // "tutti": fai mix per categorie
    const byCat = new Map();
    for (const x of within) {
      const c = normalizeCategory(x.e.category) || "natura";
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(x);
    }

    const out = [];
    const usedIds = new Set();

    // quota per categoria in ordine
    for (const c of CATEGORY_ORDER) {
      const quota = CATEGORY_QUOTAS[c] || 0;
      const arr = byCat.get(c) || [];
      let taken = 0;
      for (const x of arr) {
        if (out.length >= SHOW_LIMIT) break;
        if (taken >= quota) break;
        const id = String(x.e.id || `${x.e.title}_${x.e.lat}_${x.e.lon}`);
        if (usedIds.has(id)) continue;
        usedIds.add(id);
        out.push(x.e);
        taken++;
      }
    }

    // riempi con il resto (qualsiasi categoria) se manca
    if (out.length < SHOW_LIMIT) {
      for (const x of within) {
        if (out.length >= SHOW_LIMIT) break;
        const id = String(x.e.id || `${x.e.title}_${x.e.lat}_${x.e.lon}`);
        if (usedIds.has(id)) continue;
        usedIds.add(id);
        out.push(x.e);
      }
    }

    return out.slice(0, SHOW_LIMIT);
  }

  // ---------------- RENDER ----------------
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

      return `
        <div class="card clickSafe" style="margin-top:12px; border-color:rgba(0,224,255,.14);">
          <div style="font-weight:950; font-size:20px; line-height:1.12;">${esc(title)}</div>

          ${where ? `<div style="margin-top:10px; font-weight:950; font-size:15px;">📍 ${esc(where)}</div>` : ""}
          ${durLine ? `<div class="small muted" style="margin-top:6px;">${esc(durLine)}</div>` : ""}

          <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px;">
            ${pill("Mai fatto")}
            ${pill(catLabel)}
          </div>

          ${why ? `<div class="small muted" style="margin-top:12px; line-height:1.55;">
            <b style="color:#fff;">Perché te lo propongo:</b> ${esc(why)}
          </div>` : ""}

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

  // ---------------- MAIN RUN ----------------
  async function run({
    origin,
    maxMinutes,
    eventType,
    eventWhen, // compat, non usato
    haversineKm: havFnFromApp,
    estCarMinutesFromKm,
    showStatus,
    scrollToId,
  }) {
    try {
      patchUI();

      const baseMinutes = Math.max(15, Number(maxMinutes) || 120);
      const steps = widenSteps(baseMinutes);

      await loadItalyRegionsIndexSafe();
      const region = pickItalyRegionByOrigin(origin);

      const allRegions = Array.isArray(IT_REGIONS_INDEX?.items) ? IT_REGIONS_INDEX.items : [];
      const nearby = region ? sortNearbyRegions(origin, allRegions, region.id) : sortNearbyRegions(origin, allRegions, "");

      // prova fonti in ordine: regione -> vicine -> Italia -> fallback eventi
      const sources = [];

      if (region?.id) sources.push(regionDatasetUrlById(region.id));
      // prime 5 regioni vicine (basta)
      for (const r of nearby.slice(0, 5)) {
        if (r?.id) sources.push(regionDatasetUrlById(r.id));
      }
      sources.push(ALL_ITALY_URL);

      // uniq
      const uniq = [];
      const seen = new Set();
      for (const u of sources) {
        const s = String(u || "").trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        uniq.push(s);
      }

      const havFn = (typeof havFnFromApp === "function") ? havFnFromApp : haversineKm;

      // tenta dataset MAI FATTO (regione/vicine/italia) con widening minuti
      for (const url of uniq) {
        let pack;
        try {
          pack = await loadIdeasFromUrl(url);
        } catch {
          continue;
        }

        // se dataset vuoto, passa oltre
        if (!Array.isArray(pack.ideas) || !pack.ideas.length) continue;

        let bestItems = [];
        let usedMinutes = steps[0];

        for (const m of steps) {
          const items = pickIdeasBalanced({
            all: pack.ideas,
            origin,
            maxMinutes: m,
            eventType,
            haversineKmFn: havFn,
            estCarMinutesFromKm,
          });

          bestItems = items;
          usedMinutes = m;

          if (items.length >= MIN_RESULTS_OK) break;
        }

        if (bestItems.length >= SOFT_MIN_RESULTS) {
          renderIntoResultArea({
            items: bestItems,
            maxMinutes: baseMinutes,
            origin,
            meta: pack.meta,
            usedMinutes
          });
          showStatus?.("ok", `Mai fatto: trovate ${bestItems.length} proposte ✅`);
          scrollToId?.("resultCard");
          return;
        }
      }

      // fallback eventi (ultimo)
      const fb = await loadFallbackEventsAsIdeas();
      const itemsFb = pickIdeasBalanced({
        all: fb.ideas,
        origin,
        maxMinutes: steps[steps.length - 1],
        eventType,
        haversineKmFn: havFn,
        estCarMinutesFromKm,
      });

      renderIntoResultArea({
        items: itemsFb,
        maxMinutes: baseMinutes,
        origin,
        meta: fb.meta,
        usedMinutes: steps[steps.length - 1],
      });
      showStatus?.(itemsFb.length ? "ok" : "warn", itemsFb.length ? `Mai fatto: ${itemsFb.length} proposte ✅` : "Mai fatto: 0 proposte (fallback).");
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
              Controlla che esista:
              <br><b>${esc(IT_REGIONS_INDEX_URL)}</b>
              <br>e dataset <b>${esc(BASE_DIR)}/mai_fatto_it_*.json</b> con <b>{ ideas: [...] }</b>.
            </div>
          </div>
        `;
      }
    }
  }

  window.JAMO_EVENTS = { run };
})();
