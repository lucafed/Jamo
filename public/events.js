/* public/events.js — JAMO_MAIFATTO bridge (offline, idee REALI + WOW)
 * Compatibile con app.js v22.2 (runEventsSearchBridge)
 *
 * ✅ UI: "Eventi" => "MAI FATTO"
 * ✅ Sottocategorie: Relax, Famiglia, Bici, Moto, Natura, Pioggia, Tramonto, Mangiare, 1h, 2h
 * ✅ Match ESATTO categoria (niente mapping ambiguo)
 * ✅ Niente "quando"
 *
 * ✅ FIX richiesti:
 * - NO "cosa fare": mostra solo "Perché te lo propongo"
 * - Link "👀 Cosa c’è" (Google Maps place)
 * - Filtro WOW: penalizza posti troppo noti (Lazise/Sirmione ecc.)
 * - Varietà: shuffle stabile per query + anti-duplicati recenti
 *
 * Dataset preferito:
 *  /data/mai_fatto/mai_fatto_it_verona.json
 *  { updated_at, count, ideas:[ { id,title,lat,lon,place,city,region,category,duration_min,why,url? } ] }
 *
 * Fallback (se esiste, per non rompere):
 *  /data/events/events_all.json
 */

(() => {
  "use strict";

  const PRIMARY_URL = "/data/mai_fatto/mai_fatto_it_verona.json";
  const FALLBACK_URL = "/data/events/events_all.json";

  // quante card mostrare
  const SHOW_LIMIT = 14;

  // memoria locale per evitare ripetizioni tra ricerche
  const RECENT_KEY = "jamo_mai_fatto_recent_ids_v1";
  const RECENT_MAX = 40;

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

  // 👀 “Cosa c’è” → apre Maps sul posto (pin) invece della navigazione
  function mapsPlaceUrl(lat, lon, q) {
    const query = q ? String(q) : `${lat},${lon}`;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
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
      famiglia: "Posti che i bambini ricordano",
      bici: "Giro in bici (scoperta)",
      moto: "Due curve e sorridi",
      natura: "Natura wow",
      pioggia: "Quando piove è meglio",
      tramonto: "Tramonto da raccontare",
      mangiare: "Mangiare (posto vero)",
      "1h": "1 ora",
      "2h": "2 ore",
    };
    return m[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : "Idea");
  }

  // ---------- WOW filter (penalizza posti mainstream) ----------
  // Non è “geografia inventata”: è solo un filtro per NON proporre mete ovvie.
  function wowPenalty(e) {
    const city = String(e.city || "").toLowerCase();
    const place = String(e.place || "").toLowerCase();
    const title = String(e.title || "").toLowerCase();

    // parole/mete troppo mainstream per il tuo obiettivo
    const tooFamous = [
      "sirmione", "lazise", "bardolino", "peschiera", "garda",
      "piazza erbe", "via mazzini", "ponte pietra",
      "sigurt", "borghetto sul mincio"
    ];

    let p = 0;

    // città turistiche “ovvie”
    for (const t of tooFamous) {
      if (city.includes(t) || place.includes(t) || title.includes(t)) p += 6;
    }

    // se mancano why/title “wow”, penalizza un po'
    const why = String(e.why || "");
    if (why.trim().length < 18) p += 2;

    return p; // più alto = peggio
  }

  // ---------- shuffle deterministico ----------
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffleInPlace(arr, seed) {
    const rnd = mulberry32(seed);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ---------- recent ids ----------
  function loadRecent() {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const a = JSON.parse(raw || "[]");
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
  }

  function saveRecent(list) {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
    } catch {}
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

    const whenRow = document.getElementById("eventWhenChips");
    if (whenRow) {
      const parent = whenRow.closest("div");
      if (parent) parent.style.display = "none";
    }

    const info = document.querySelector("#eventsSubfilters .small.muted");
    if (info) info.textContent = "Offline: idee reali curate (wow > ovvio).";
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

    // categoria esatta
    if (et && et !== "tutti") {
      list = list.filter((e) => normalizeCategory(e.category) === et);
    }

    // entro minuti
    if (origin && typeof origin.lat === "number" && typeof origin.lon === "number") {
      list = list
        .map((e) => {
          if (typeof e.lat !== "number" || typeof e.lon !== "number") return null;
          const km = typeof haversineKm === "function"
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

    // WOW: preferisci non-ovvio
    // 1) separa wow vs “ovvio”
    const scored = list.map((e) => ({ e, p: wowPenalty(e) }));
    const wow = scored.filter(x => x.p <= 3).map(x => x.e);
    const meh = scored.filter(x => x.p > 3).map(x => x.e);

    // 2) anti-duplicati: prova a evitare quelli già mostrati di recente
    const recent = loadRecent();
    const isRecent = (e) => recent.includes(String(e.id || `${e.title}|${e.lat}|${e.lon}`));

    const wowFresh = wow.filter(e => !isRecent(e));
    const mehFresh = meh.filter(e => !isRecent(e));

    // 3) shuffle deterministico per variare ad ogni ricerca (dipende da origin/minuti/cat + tempo)
    // cambia ogni ~6 ore
    const slot = Math.floor(Date.now() / (6 * 60 * 60 * 1000));
    const seedBase = `${origin?.lat ?? ""}|${origin?.lon ?? ""}|${mm}|${et}|${slot}`;
    const seed = hashStr(seedBase);

    shuffleInPlace(wowFresh, seed);
    shuffleInPlace(mehFresh, seed ^ 0x9e3779b9);

    // 4) compone: prima wow, poi eventualmente riempi con meh
    const out = [];
    for (const e of wowFresh) { out.push(e); if (out.length >= SHOW_LIMIT) break; }
    if (out.length < SHOW_LIMIT) {
      for (const e of mehFresh) { out.push(e); if (out.length >= SHOW_LIMIT) break; }
    }

    // se ancora poco, usa anche recenti ma sempre wow prima
    if (out.length < SHOW_LIMIT) {
      const wowAny = shuffleInPlace(wow.slice(), seed ^ 123);
      for (const e of wowAny) { if (!out.includes(e)) out.push(e); if (out.length >= SHOW_LIMIT) break; }
    }
    if (out.length < SHOW_LIMIT) {
      const mehAny = shuffleInPlace(meh.slice(), seed ^ 456);
      for (const e of mehAny) { if (!out.includes(e)) out.push(e); if (out.length >= SHOW_LIMIT) break; }
    }

    // salva recent
    const newIds = out.map(e => String(e.id || `${e.title}|${e.lat}|${e.lon}`));
    saveRecent([...newIds, ...recent].slice(0, RECENT_MAX));

    return out.slice(0, SHOW_LIMIT);
  }

  // ---------- render ----------
  function renderIntoResultArea({ items, maxMinutes }) {
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

    const cards = items.map((e) => {
      const title = e.title || "Idea";
      const where = nicePlaceLine(e);

      const catKey = normalizeCategory(e.category);
      const catLabel = labelCategory(catKey);

      const durLine = e.duration_min ? `⏱️ ~${esc(e.duration_min)} min` : "";
      const why = (e.why || "").trim();

      const lat = e.lat;
      const lon = e.lon;

      const mapsAuto = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "driving") : "";
      const mapsWalk = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "walking") : "";
      const mapsBike = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "bicycling") : "";
      const mapsSee = typeof lat === "number" && typeof lon === "number"
        ? mapsPlaceUrl(lat, lon, where || `${lat},${lon}`)
        : "";

      // se il dataset include un url "info", lo usiamo, altrimenti Maps search
      const infoUrl = e.url ? String(e.url) : mapsSee;

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
            ${infoUrl ? `<a class="btnGhost" href="${esc(infoUrl)}" target="_blank" rel="noopener">👀 Cosa c’è</a>` : ""}
            ${mapsWalk ? `<a class="btn" href="${esc(mapsWalk)}" target="_blank" rel="noopener">🚶 A piedi</a>` : ""}
            ${mapsBike ? `<a class="btn" href="${esc(mapsBike)}" target="_blank" rel="noopener">🚴 Bici</a>` : ""}
          </div>

          <div class="small muted" style="margin-top:10px; opacity:.70;">
            Fonte: ${esc(e.source || DATASET_META.source || "mai_fatto")}
          </div>
        </div>
      `;
    }).join("");

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

      if (!DATASET) DATASET = await loadDataset();
      const all = Array.isArray(DATASET) ? DATASET : [];

      if (!all.length) {
        showStatus?.("warn", "Dataset MAI FATTO vuoto.");
        renderIntoResultArea({ items: [], maxMinutes });
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

      renderIntoResultArea({ items, maxMinutes });
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
