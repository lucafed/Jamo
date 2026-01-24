/* public/events.js — JAMO_MAIFATTO bridge (offline, idee REALI, WOW-first)
 * Compatibile con app.js v22.2 (window.JAMO_EVENTS.run)
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
    "lazise","sirmione","gardaland","lungolago","piazza bra","via mazzini","piazza erbe",
    "arena di verona","juliet","giulietta","casa di giulietta","centro verona",
  ];

  const esc = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const toNum = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    const n = Number.parseFloat(String(v ?? "").trim().replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };

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
      (toNum(oLat) != null && toNum(oLon) != null)
        ? `&origin=${encodeURIComponent(`${toNum(oLat)},${toNum(oLon)}`)}`
        : "";
    return `${base}${originPart}&destination=${encodeURIComponent(`${dLat},${dLon}`)}&travelmode=${encodeURIComponent(m)}`;
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
    // fallback: ~72km/h + overhead (molto grezzo, ma non deve mai “tagliare tutto”)
    const mins = Math.round((km / 72) * 60 + 8);
    return Math.max(5, mins);
  }

  function normalizeCategory(c) {
    const k = String(c || "").toLowerCase().trim();
    if (!k) return "";

    if (["1 ora","1h","1_ora","1ora","60","60m","60min","1hour"].includes(k)) return "1h";
    if (["2 ore","2h","2_ore","2ore","120","120m","120min","2hours","2hour"].includes(k)) return "2h";

    if (["family","famiglia","bimbi","bambini","kids","children"].includes(k)) return "famiglia";
    if (["food","mangiare","cibo","eat"].includes(k)) return "mangiare";
    if (["bike","bici","ciclismo","cycling","mtb","gravel"].includes(k)) return "bici";
    if (["moto","motorbike","motorcycle"].includes(k)) return "moto";
    if (["rain","pioggia","maltempo","badweather"].includes(k)) return "pioggia";
    if (["sunset","tramonto","goldenhour"].includes(k)) return "tramonto";
    if (["nature","natura","outdoor","bosco","montagna"].includes(k)) return "natura";
    if (["relax","wellness","spa","terme","reset"].includes(k)) return "relax";

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
    const hay = `${e.title || ""} ${e.place || ""} ${e.city || ""}`.toLowerCase();
    return TOO_FAMOUS_WORDS.some((w) => hay.includes(w));
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
  setTimeout(safePatchUI, 60);

  // ---------------- CACHE ----------------
  const CACHE = new Map();
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

  function extractIdeasFromDataset(j) {
    if (!j) return [];
    if (Array.isArray(j.ideas)) return j.ideas;
    if (Array.isArray(j.items)) return j.items;
    if (Array.isArray(j)) return j;
    return [];
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
        const ideas = extractIdeasFromDataset(j);
        if (ideas.length) {
          const meta = {
            updated_at: j?.updated_at || j?.updatedAt || "",
            count: j?.count ?? ideas.length,
            source: ideas[0]?.source || "curated_mai_fatto",
            area: j?.area || j?.title || url.split("/").pop(),
          };
          CACHE.set(url, { ideas, meta });
          LAST_META = meta;
          return ideas;
        }
      } catch (_) {}
    }

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
      tags: e.tags,
      topics: e.topics,
      type: e.type,
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

  function ideaKeys(e) {
    const keys = new Set();
    keys.add(normalizeCategory(e?.category));
    keys.add(normalizeCategory(e?.duration_bucket));
    keys.add(normalizeCategory(e?.type));

    const tags = Array.isArray(e?.tags) ? e.tags : [];
    const topics = Array.isArray(e?.topics) ? e.topics : [];
    for (const t of tags) keys.add(normalizeCategory(t));
    for (const t of topics) keys.add(normalizeCategory(t));

    const dm = Number(e?.duration_min);
    if (Number.isFinite(dm)) {
      if (dm <= 75) keys.add("1h");
      else if (dm <= 150) keys.add("2h");
    }

    keys.delete("");
    return keys;
  }

  // ✅ FAIL-SAFE: non deve mai tornare 0 “a caso”
  function pickIdeas({ all, origin, maxMinutes, eventType, haversineKm, estCarMinutesFromKm }) {
    const mm = Math.max(15, Number(maxMinutes) || 120);
    const et = normalizeCategory(eventType || "tutti");

    let list = Array.isArray(all) ? all.slice() : [];

    if (et && et !== "tutti") {
      list = list.filter((e) => ideaKeys(e).has(et));
    }

    // anti-famoso soft
    const pre = list.length;
    const filtered = list.filter((e) => !isTooFamous(e));
    if (pre > 0 && filtered.length >= Math.min(8, Math.round(pre * 0.15))) {
      list = filtered;
    }

    const oLat = toNum(origin?.lat);
    const oLon = toNum(origin?.lon);

    // se non ho origin valido, ordino solo per wow
    if (oLat == null || oLon == null) {
      return list
        .map((e) => ({ e, wow: typeof e.wow_score === "number" ? e.wow_score : 0 }))
        .sort((a, b) => b.wow - a.wow)
        .map((x) => x.e)
        .slice(0, SHOW_LIMIT);
    }

    // compute mins (accetta lat/lon stringhe)
    let scored = list.map((e) => {
      const dLat = toNum(e?.lat);
      const dLon = toNum(e?.lon);

      // se manca coords: NON buttare via, lascio mins null (finirà in fondo)
      if (dLat == null || dLon == null) {
        return { e, mins: null, wow: typeof e.wow_score === "number" ? e.wow_score : 0 };
      }

      const km = typeof haversineKm === "function" ? haversineKm(oLat, oLon, dLat, dLon) : null;
      const mins = (km == null) ? null : approxMinutesFromKm(km, estCarMinutesFromKm);
      const wow = typeof e.wow_score === "number" ? e.wow_score : 0;
      return { e, mins, wow };
    });

    // filtro minuti con widen automatico
    const byMins = (limit) => scored.filter(x => x.mins == null || x.mins <= limit);
    let kept = byMins(Math.round(mm * 1.35));

    if (kept.length === 0) kept = byMins(Math.round(mm * 3));     // widen forte
    if (kept.length === 0) kept = scored;                         // ultimo fallback: nessun filtro minuti

    kept.sort((a, b) => (a.mins ?? 999999) - (b.mins ?? 999999) || (b.wow - a.wow));

    return kept.map(x => x.e).slice(0, SHOW_LIMIT);
  }

  function renderIntoResultArea({ items, maxMinutes, origin }) {
    const area = document.getElementById("resultArea");
    if (!area) return;

    const updated = LAST_META.updated_at ? fmtDateShort(LAST_META.updated_at) : "";
    const total = LAST_META.count || (Array.isArray(items) ? items.length : 0);
    const areaName = LAST_META.area ? ` • ${esc(LAST_META.area)}` : "";
    const originReg = origin?.region ? ` • origin=${esc(origin.region)}` : "";

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

    const oLat = toNum(origin?.lat);
    const oLon = toNum(origin?.lon);

    const cards = items.map((e) => {
      const title = e.title || "Idea WOW";
      const where = nicePlaceLine(e);
      const why = (e.why || "").trim();

      const catKey = normalizeCategory(e.category) || normalizeCategory(e.duration_bucket);
      const catLabel = labelCategory(catKey);

      const durLine = e.duration_min ? `⏱️ ~${esc(e.duration_min)} min` : "";

      const dLat = toNum(e?.lat);
      const dLon = toNum(e?.lon);

      const mapsAuto =
        (dLat != null && dLon != null)
          ? mapsDirUrl({ oLat, oLon, dLat, dLon, mode: "driving" })
          : "";

      const infoUrl = infoUrlFor(e);

      return `
        <div class="card clickSafe" style="margin-top:12px; border-color:rgba(0,224,255,.14);">
          <div style="font-weight:950; font-size:20px; line-height:1.12;">${esc(title)}</div>

          ${where ? `<div style="margin-top:10px; font-weight:950; font-size:15px; letter-spacing:.2px;">📍 ${esc(where)}</div>` : ""}
          ${durLine ? `<div class="small muted" style="margin-top:6px;">${esc(durLine)}</div>` : ""}

          <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px;">
            ${pill("Mai fatto")}
            ${pill(catLabel)}
          </div>

          ${why ? `<div class="small muted" style="margin-top:12px; line-height:1.55;"><b style="color:#fff;">Perché te lo propongo:</b> ${esc(why)}</div>` : ""}

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
          Mostrate: ${esc(items.length)} • entro ~${esc(maxMinutes)} min (widen automatico incluso)
        </div>
      </div>
      ${cards}
    `;
  }

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
