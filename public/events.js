/* public/events.js — JAMO_MAIFATTO bridge (offline, idee REALI + WOW)
 * Compatibile con app.js v22.2 (runEventsSearchBridge)
 *
 * ✅ UI: "Eventi" => "✨ Mai fatto"
 * ✅ Sottocategorie WOW (nomi = categorie)
 * ✅ Match ESATTO categoria (no mapping ambiguo)
 * ✅ "Quando" nascosto (non serve per Mai fatto)
 * ✅ Tante idee + "Altre idee" + rotazione settimanale
 *
 * Dataset preferito:
 *  /data/mai_fatto/mai_fatto_it_verona.json
 *  { updated_at, count, ideas:[ { id?, title, lat, lon, place, city, region, category, duration_min, why, how[] , url?, source? } ] }
 *
 * Fallback (se esiste, per non rompere):
 *  /data/events/events_all.json
 */

(() => {
  "use strict";

  const PRIMARY_URL = "/data/mai_fatto/mai_fatto_it_verona.json";
  const FALLBACK_URL = "/data/events/events_all.json";

  // quante ne mostriamo subito + step "altre"
  const SHOW_INITIAL = 10;
  const SHOW_STEP = 10;
  const SHOW_MAX = 60;

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

  function approxMinutesFromKm(km, estCarMinutesFromKm) {
    if (typeof estCarMinutesFromKm === "function") return estCarMinutesFromKm(km);
    return Math.round((km / 60) * 60 + 8);
  }

  // ---------- categorie (NORMALIZZATE) ----------
  // Nota: qui NON “invento” mapping strani: normalizzo solo formati equivalenti.
  function normalizeCategory(c) {
    const k = String(c || "").toLowerCase().trim();
    if (!k) return "";
    if (k === "1 ora" || k === "1h" || k === "1_ora" || k === "1ora") return "1h";
    if (k === "2 ore" || k === "2h" || k === "2_ore" || k === "2ore") return "2h";
    if (k === "family") return "famiglia";
    return k;
  }

  // ✅ NOMI WOW = le categorie che vede l’utente (come hai chiesto)
  // Se vuoi cambiare i testi WOW, li cambi QUI e basta.
  const WOW = {
    relax:   "🧖 Stacca davvero",
    famiglia:"👨‍👩‍👧‍👦 Posti che i bambini ricordano",
    bici:    "🚴 Giro in bici che vale",
    moto:    "🏍️ Due curve e sorridi",
    natura:  "🌿 Natura wow vicino",
    pioggia: "🌧️ Quando piove è meglio",
    tramonto:"🌅 Tramonto da far foto",
    mangiare:"🍝 Mangiare con gusto",
    "1h":    "🕐 1 ora fatta bene",
    "2h":    "🕑 2 ore memorabili",
  };

  function wowLabelForKey(k) {
    return WOW[k] || (k ? k : "Idea");
  }

  // ---------- UI patch (solo DOM, non rompe app.js) ----------
  function patchUI() {
    // chip categoria "eventi" -> "Mai fatto"
    const catChip = document.querySelector('#categoryChips .chip[data-cat="eventi"]');
    if (catChip) catChip.textContent = "✨ Mai fatto";

    // titolo box subfiltri
    const box = document.getElementById("eventsSubfilters");
    if (box) {
      const smalls = box.querySelectorAll(".small");
      if (smalls && smalls[0]) smalls[0].textContent = "Mai fatto (categoria)";
    }

    // sostituisce i chip sottocategoria (eventTypeChips) con le WOW
    const row = document.getElementById("eventTypeChips");
    if (row) {
      row.innerHTML = `
        <div class="chip active" data-etype="tutti">⭐ Tutti</div>
        <div class="chip" data-etype="relax">${esc(wowLabelForKey("relax"))}</div>
        <div class="chip" data-etype="famiglia">${esc(wowLabelForKey("famiglia"))}</div>
        <div class="chip" data-etype="bici">${esc(wowLabelForKey("bici"))}</div>
        <div class="chip" data-etype="moto">${esc(wowLabelForKey("moto"))}</div>
        <div class="chip" data-etype="natura">${esc(wowLabelForKey("natura"))}</div>
        <div class="chip" data-etype="pioggia">${esc(wowLabelForKey("pioggia"))}</div>
        <div class="chip" data-etype="tramonto">${esc(wowLabelForKey("tramonto"))}</div>
        <div class="chip" data-etype="mangiare">${esc(wowLabelForKey("mangiare"))}</div>
        <div class="chip" data-etype="1h">${esc(wowLabelForKey("1h"))}</div>
        <div class="chip" data-etype="2h">${esc(wowLabelForKey("2h"))}</div>
      `;
    }

    // nasconde "quando"
    const whenRow = document.getElementById("eventWhenChips");
    if (whenRow) {
      const parent = whenRow.closest("div");
      if (parent) parent.style.display = "none";
    }

    // testo info
    const info = document.querySelector("#eventsSubfilters .small.muted");
    if (info) info.textContent = "Offline: idee reali curate. Cambiano nel tempo (rotazione automatica).";
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
        how: e.how,
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

  // ---------- stable id (per rotazione / no-dup) ----------
  function stableIdeaId(e) {
    if (e?.id) return String(e.id);
    const t = String(e?.title || "").toLowerCase().trim();
    const p = String(e?.place || "").toLowerCase().trim();
    const c = String(e?.city || "").toLowerCase().trim();
    const la = Number(e?.lat);
    const lo = Number(e?.lon);
    const ll = Number.isFinite(la) && Number.isFinite(lo) ? `${la.toFixed(4)},${lo.toFixed(4)}` : "";
    return `i_${t}|${p}|${c}|${ll}`.slice(0, 180);
  }

  // ---------- seed / rotazione ----------
  function weekKey(d = new Date()) {
    // chiave “anno-settimana ISO” semplificata (abbastanza stabile per ruotare)
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
  }

  function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
      t += 0x6D2B79F5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashStr(s) {
    // hash veloce deterministico
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function shuffleDeterministic(arr, seedStr) {
    const a = arr.slice();
    const rnd = mulberry32(hashStr(seedStr));
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------- “non ripetere sempre” (memoria leggera) ----------
  function seenKey({ et, mm, origin }) {
    const o = origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lon)
      ? `${origin.lat.toFixed(2)},${origin.lon.toFixed(2)}`
      : "no_origin";
    return `jamo_maifatto_seen:${o}:${et}:${mm}`;
  }

  function loadSeen(key) {
    try {
      const raw = localStorage.getItem(key);
      const j = raw ? JSON.parse(raw) : null;
      const list = Array.isArray(j?.list) ? j.list : [];
      const ts = Number(j?.ts) || 0;
      // scadenza: 10 giorni
      if (!ts || (Date.now() - ts) > 10 * 24 * 60 * 60 * 1000) return [];
      return list;
    } catch { return []; }
  }

  function saveSeen(key, ids) {
    try {
      localStorage.setItem(key, JSON.stringify({ ts: Date.now(), list: ids.slice(0, 120) }));
    } catch {}
  }

  // ---------- selection ----------
  function filterByCategoryExact(list, et) {
    const want = normalizeCategory(et || "tutti");
    if (!want || want === "tutti") return list;
    return list.filter((e) => normalizeCategory(e.category) === want);
  }

  function addMinutesInfo(list, origin, haversineKm, estCarMinutesFromKm) {
    if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lon)) {
      return list.map((e) => ({ e, mins: null }));
    }
    return list
      .map((e) => {
        if (typeof e.lat !== "number" || typeof e.lon !== "number") return null;
        const km = typeof haversineKm === "function"
          ? haversineKm(origin.lat, origin.lon, e.lat, e.lon)
          : null;
        const mins = km == null ? null : approxMinutesFromKm(km, estCarMinutesFromKm);
        return { e, mins };
      })
      .filter(Boolean);
  }

  function pickIdeas({
    all,
    origin,
    maxMinutes,
    eventType,
    haversineKm,
    estCarMinutesFromKm,
  }) {
    const mmInput = Number(maxMinutes) || 120;
    const et = normalizeCategory(eventType || "tutti");

    // 1) categoria esatta
    let list = filterByCategoryExact(all, et);

    // 2) calcola mins e ordina per vicinanza (ma poi ruotiamo)
    const withMins = addMinutesInfo(list, origin, haversineKm, estCarMinutesFromKm);

    // 3) se pochi entro mm, widen “gentile” (soprattutto per 30–60)
    const widenSteps =
      mmInput <= 45 ? [mmInput, 45, 60, 90] :
      mmInput <= 60 ? [mmInput, 75, 90, 120] :
      mmInput <= 120 ? [mmInput, 140, 160, 180] :
      [mmInput, Math.min(240, mmInput + 40), Math.min(300, mmInput + 80)];

    let usedMM = widenSteps[0];
    let within = [];

    for (const mm of widenSteps) {
      usedMM = mm;
      within = withMins
        .filter((x) => (x.mins == null ? true : x.mins <= mm))
        .sort((a, b) => (a.mins ?? 9999) - (b.mins ?? 9999));
      if (within.length >= 6) break;
    }

    // 4) rotazione + anti-dup
    const wk = weekKey(new Date());
    const day = new Date().getDay(); // 0..6
    const oKey = origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lon)
      ? `${origin.lat.toFixed(2)},${origin.lon.toFixed(2)}`
      : "no_origin";

    const seed = `wk:${wk}|d:${day}|et:${et}|mm:${mmInput}|o:${oKey}|src:${DATASET_META.source}`;
    let rotated = shuffleDeterministic(within, seed);

    // togli quelli visti di recente (per categoria+minuti+zona)
    const sk = seenKey({ et, mm: mmInput, origin });
    const seen = new Set(loadSeen(sk));
    rotated = rotated.filter((x) => !seen.has(stableIdeaId(x.e)));

    // se diventano troppo pochi, rimetti anche “visti” ma dopo
    if (rotated.length < 6) {
      const rest = within.filter((x) => !rotated.includes(x));
      rotated = rotated.concat(rest);
    }

    // output finale (fino a SHOW_MAX)
    const out = rotated.slice(0, SHOW_MAX).map((x) => x.e);

    return { items: out, usedMinutes: usedMM, inputMinutes: mmInput, totalPool: within.length };
  }

  // ---------- render (paginazione locale) ----------
  let CURRENT_ALL = [];
  let CURRENT_VISIBLE = 0;
  let CURRENT_META = { usedMinutes: null, inputMinutes: null, et: "tutti" };

  function renderHeader(maxMinutes) {
    const updated = DATASET_META.updated_at ? fmtDateShort(DATASET_META.updated_at) : "";
    const total = DATASET_META.count || (Array.isArray(CURRENT_ALL) ? CURRENT_ALL.length : 0);

    const widenNote =
      (CURRENT_META.usedMinutes && CURRENT_META.inputMinutes && CURRENT_META.usedMinutes !== CURRENT_META.inputMinutes)
        ? ` • widen: ${esc(CURRENT_META.inputMinutes)}→${esc(CURRENT_META.usedMinutes)} min`
        : "";

    return `
      <div class="card clickSafe" style="box-shadow:none; border-color:rgba(0,224,255,.20); background:rgba(0,224,255,.05);">
        <div style="font-weight:950; font-size:18px;">✨ MAI FATTO — idee vicine</div>
        <div class="small muted" style="margin-top:6px;">
          ${updated ? `Dataset aggiornato ${esc(updated)}` : "Dataset offline"} • totale ${esc(total)}${widenNote}
        </div>
        <div class="small muted" style="margin-top:6px;">
          Mostrate: ${esc(Math.min(CURRENT_VISIBLE, CURRENT_ALL.length))} • entro ~${esc(CURRENT_META.usedMinutes ?? maxMinutes)} min
        </div>
      </div>
    `;
  }

  function renderCardsSlice(from, to) {
    const slice = CURRENT_ALL.slice(from, to);

    return slice
      .map((e) => {
        const title = e.title || "Idea";
        const where = nicePlaceLine(e);
        const why = e.why || "";
        const howArr = Array.isArray(e.how) ? e.how : [];
        const howHtml =
          howArr.length > 0
            ? `<ul class="how" style="margin:10px 0 0; padding-left:18px; color:rgba(255,255,255,.82);">
                ${howArr.slice(0, 4).map((x) => `<li style="margin:6px 0;">${esc(x)}</li>`).join("")}
              </ul>`
            : "";

        const catKey = normalizeCategory(e.category);
        const catLabel = wowLabelForKey(catKey) || catKey;

        const durLine = e.duration_min ? `⏱️ ~${esc(e.duration_min)} min` : "";

        const lat = e.lat;
        const lon = e.lon;

        const mapsAuto = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "driving") : "";
        const mapsWalk = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "walking") : "";
        const mapsBike = typeof lat === "number" && typeof lon === "number" ? mapsDirUrl(lat, lon, "bicycling") : "";

        const infoUrl = e.url ? String(e.url) : "";

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
                     <b style="color:#fff;">Perché è speciale:</b> ${esc(why)}
                   </div>`
                : ""
            }

            ${howHtml}

            <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px;">
              ${mapsAuto ? `<a class="btn btnPrimary" href="${esc(mapsAuto)}" target="_blank" rel="noopener">🧭 Vai</a>` : ""}
              ${mapsWalk ? `<a class="btn" href="${esc(mapsWalk)}" target="_blank" rel="noopener">🚶 A piedi</a>` : ""}
              ${mapsBike ? `<a class="btn" href="${esc(mapsBike)}" target="_blank" rel="noopener">🚴 Bici</a>` : ""}
              ${infoUrl ? `<a class="btnGhost" href="${esc(infoUrl)}" target="_blank" rel="noopener">🔎 Info</a>` : ""}
            </div>

            <div class="small muted" style="margin-top:10px; opacity:.70;">
              Fonte: ${esc(e.source || DATASET_META.source || "mai_fatto")}
            </div>
          </div>
        `;
      })
      .join("");
  }

  function renderIntoResultArea({ maxMinutes }) {
    const area = document.getElementById("resultArea");
    if (!area) return;

    if (!CURRENT_ALL || !CURRENT_ALL.length) {
      const updated = DATASET_META.updated_at ? fmtDateShort(DATASET_META.updated_at) : "";
      const total = DATASET_META.count || 0;
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

    const header = renderHeader(maxMinutes);

    const visible = Math.min(CURRENT_VISIBLE, CURRENT_ALL.length);
    const cards = renderCardsSlice(0, visible);

    const canMore = visible < CURRENT_ALL.length;
    const moreBtn = canMore
      ? `<button class="moreBtn clickSafe" id="btnMoreIdeas" type="button" style="margin-top:12px;">⬇️ Altre idee</button>`
      : "";

    area.innerHTML = `${header}${cards}${moreBtn}`;
  }

  function bindResultAreaMoreButton() {
    const area = document.getElementById("resultArea");
    if (!area) return;

    area.addEventListener("click", (e) => {
      const btn = e.target.closest("#btnMoreIdeas");
      if (!btn) return;

      const before = CURRENT_VISIBLE;
      CURRENT_VISIBLE = Math.min(CURRENT_ALL.length, CURRENT_VISIBLE + SHOW_STEP);
      if (CURRENT_VISIBLE !== before) {
        renderIntoResultArea({ maxMinutes: CURRENT_META.usedMinutes ?? CURRENT_META.inputMinutes ?? 120 });
        setTimeout(() => {
          const b = document.getElementById("btnMoreIdeas");
          (b || btn)?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 20);
      }
    });
  }

  bindResultAreaMoreButton();

  // ---------- public API ----------
  async function run({
    origin,
    maxMinutes,
    eventType,
    eventWhen, // ignorato (tenuto per compatibilità)
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
        CURRENT_ALL = [];
        CURRENT_VISIBLE = 0;
        renderIntoResultArea({ maxMinutes });
        scrollToId?.("resultCard");
        return;
      }

      const { items, usedMinutes, inputMinutes } = pickIdeas({
        all,
        origin,
        maxMinutes,
        eventType,
        haversineKm,
        estCarMinutesFromKm
      });

      CURRENT_ALL = items;
      CURRENT_VISIBLE = Math.min(SHOW_INITIAL, CURRENT_ALL.length);
      CURRENT_META = {
        usedMinutes,
        inputMinutes,
        et: normalizeCategory(eventType || "tutti"),
      };

      renderIntoResultArea({ maxMinutes: inputMinutes });

      // salva “visti” (così la prossima volta ruota)
      try {
        const sk = seenKey({ et: CURRENT_META.et, mm: inputMinutes, origin });
        const prev = loadSeen(sk);
        const add = CURRENT_ALL.slice(0, Math.min(18, CURRENT_ALL.length)).map((e) => stableIdeaId(e));
        const merged = Array.from(new Set(add.concat(prev)));
        saveSeen(sk, merged);
      } catch {}

      showStatus?.("ok", `Mai fatto: ${items.length} idee disponibili ✅`);
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
