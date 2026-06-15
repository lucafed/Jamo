/* public/events.js — JAMO_MAIFATTO bridge (OFFLINE • WOW-first • robust • SMART)
 * Compatibile con app.js (payload: origin/maxMinutes/eventType + helpers)
 *
 * OBIETTIVO:
 * ✅ "Eventi" => "✨ Mai fatto" (idee WOW offline)
 * ✅ Subcategorie: relax, famiglia, bici, moto, natura, pioggia, tramonto, mangiare, 1h, 2h
 * ✅ 1h/2h filtrano su duration_bucket (NON su category) + fallback su duration_min
 * ✅ Regione scelta da COORDINATE via it-regions-index.json (se presente) + fallback hardcoded
 * ✅ Anti-famoso SOFT
 * ✅ WIDEN SMART: se poche idee entro i minuti, aumenta tolleranza senza sparare roba random
 * ✅ FIX LINK:
 *    - "🧭 Vai" = directions con ORIGIN (coord) + DESTINAZIONE testuale (nome+luogo)
 *    - "📍 Apri posto" = Google Maps search con nome+luogo
 *    - "🧩 Info" = solo se info_url è un vero link informativo
 *
 * Dataset (attesi):
 *  /data/mai_fatto/mai_fatto_it_<slug>.json  (slug = id regione index, es: abruzzo, veneto, piemonte...)
 *  /data/mai_fatto/mai_fatto_it_all.json
 * Fallback:
 *  /data/events/events_all.json
 */

(() => {
  "use strict";

  // ------------------ CONFIG ------------------
  const SHOW_LIMIT = 18;

  const PATHS = {
    IT_REGIONS_INDEX_URL: "/data/pois/regions/it-regions-index.json",
    MAIFATTO_REGION_URL: (slug) => `/data/mai_fatto/mai_fatto_it_${slug}.json`,
    MAIFATTO_ALL_URL: "/data/mai_fatto/mai_fatto_it_all.json",
    FALLBACK_EVENTS_URL: "/data/events/events_all.json",
  };

  // Anti-ovvio SOFT (solo per non intasare di “postcard”. Non blocca mai al 100%)
  const TOO_FAMOUS_WORDS = [
    // VR/Garda
    "lazise","sirmione","gardaland","lungolago","piazza bra","via mazzini","piazza erbe",
    "arena di verona","juliet","giulietta","casa di giulietta","centro verona",
    // super generici (soft)
    "centro storico",
  ];

  // ------------------ HELPERS ------------------
  const esc = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const toRad = (x) => (x * Math.PI) / 180;
  function haversineKmFallback(aLat, aLon, bLat, bLon) {
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

  function fmtDateShort(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  function cleanJoin(parts) {
    return parts
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
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
    // fallback grezzo
    return Math.round((Number(km) || 0) + 8);
  }

  function placeQuery(e) {
    const place = (e.place || "").trim();
    const city = (e.city || "").trim();
    const region = (e.region || "").trim();
    const base = place || (e.title || "").trim();
    const q = cleanJoin([base, city, region, "Italia"]);
    return q || "";
  }

  function mapsSearchUrl(q) {
    if (!q) return "";
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  }

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

  function isProbablyInfoUrl(u) {
    const s = String(u || "").trim();
    if (!s) return false;
    if (!/^https?:\/\//i.test(s)) return false;
    if (s.includes("google.com/maps")) return false;
    if (s.includes("www.google.com/search")) return false;
    return true;
  }

  function normalizeKey(k) {
    const s = String(k || "").toLowerCase().trim();
    if (!s) return "tutti";
    if (["1 ora","1h","1_ora","1ora","60","60m"].includes(s)) return "1h";
    if (["2 ore","2h","2_ore","2ore","120","120m"].includes(s)) return "2h";
    if (s === "family") return "famiglia";
    if (s === "food") return "mangiare";
    if (["mangia","cibo"].includes(s)) return "mangiare";
    return s;
  }

  function normalizeCategoryFromData(cat) {
    const s = String(cat || "").toLowerCase().trim();
    if (!s) return "";
    if (s === "family") return "famiglia";
    if (s === "food") return "mangiare";
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

  // ------------------ UI PATCH (safe) ------------------
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
      if (info) info.textContent = "Offline: idee WOW • regione → Italia • filtri soft • widening automatico • link Maps precisi.";
    } catch (e) {
      console.warn("patchUI warning:", e);
    }
  }
  safePatchUI();
  setTimeout(safePatchUI, 50);

  // ------------------ WOW TAGS / FAMILY WOW (anti-playground) ------------------
  const TAG_RULES = [
    // FAMILY WOW
    { tag: "zoo", rx: /\b(zoo|parco faunistico|parco zoologico|bioparco|safari)\b/i },
    { tag: "acquario", rx: /\b(acquario|aquarium)\b/i },
    { tag: "parco_avventura", rx: /\b(parco avventura|percors[oi] sospes[oi]|zipline|tree\s*climbing)\b/i },
    { tag: "parco_divertimenti", rx: /\b(parco divertimenti|luna\s*park|giostre|theme\s*park)\b/i },
    { tag: "waterpark", rx: /\b(aquapark|water\s*park|scivoli|piscine\s*con\s*scivoli)\b/i },
    { tag: "fattoria_didattica", rx: /\b(fattoria didattica|agriturismo didattico|fattoria|parco agricolo)\b/i },
    { tag: "museo_bimbi", rx: /\b(museo.*bambin|museo.*ragazz|children.?s\s*museum)\b/i },

    // RELAX
    { tag: "spa", rx: /\b(spa|wellness|centro benessere|sauna|bagno turco|hammam)\b/i },
    { tag: "terme", rx: /\b(terme|termal|thermal)\b/i },

    // PIOGGIA / INDOOR
    { tag: "indoor", rx: /\b(indoor|al\s*coperto|coperto)\b/i },
    { tag: "museo", rx: /\b(museo|galleria|pinacoteca|mostra)\b/i },
    { tag: "grotta", rx: /\b(grotta|grotte|caverna)\b/i },

    // MANGIA WOW
    { tag: "degustazione", rx: /\b(degustazione|tasting|wine\s*tasting|frantoio|oleificio)\b/i },
    { tag: "street_food", rx: /\b(street\s*food|mercato\s*(coperto|storico)|food\s*market)\b/i },
    { tag: "birrificio", rx: /\b(birrificio|brewery)\b/i },
    { tag: "sagra", rx: /\b(sagra|festa\s+(della|del|dei|degli))\b/i },

    // TRAMONTO / PANORAMI
    { tag: "belvedere", rx: /\b(belvedere|punto panoramico|panoram|terrazza|vedetta)\b/i },
    { tag: "lago", rx: /\b(lago)\b/i },
    { tag: "mare", rx: /\b(mare|spiaggia|lido|baia|cala|faro|promontorio)\b/i },
  ];

  const NEG_RELAX = [
    /\b(bivacco|rifugio|vetta|cima|sentiero|trekking|arrampicata|via ferrata)\b/i,
  ];

  const NEG_FAMILY = [
    // no roba tecnica
    /\b(piazza|corso|viale|rotonda|svincolo|stazione|fermata|parcheggio)\b/i,
    // no chiese "a caso"
    /\b(chiesa|duomo|cattedrale|abbazia|monaster|convento|santuario|oratorio)\b/i,
    // no “family normale”
    /\b(giardini pubblici|parco pubblico|villa comunale|giardini comunali)\b/i,
    /\b(parco giochi|area giochi|playground|giochi per bambini|altalena|scivolo)\b/i,
  ];

  function inferTags(e) {
    const t = `${e.title || ""} ${e.place || ""} ${e.city || ""} ${e.region || ""}`.toLowerCase();
    const tags = new Set(Array.isArray(e.tags) ? e.tags.map((x) => String(x).toLowerCase().trim()) : []);
    for (const r of TAG_RULES) if (r.rx.test(t)) tags.add(r.tag);
    return [...tags];
  }

  function isTrueFamily(e) {
    const text = `${e.title || ""} ${e.place || ""} ${e.city || ""} ${e.region || ""}`.toLowerCase();
    if (NEG_FAMILY.some((rx) => rx.test(text))) return false;

    const tags = inferTags(e);
    const strong = ["zoo","acquario","parco_avventura","parco_divertimenti","waterpark","fattoria_didattica","museo_bimbi"];
    if (tags.some((t) => strong.includes(t))) return true;

    // fallback keyword WOW-only
    if (/\b(parco avventura|zipline|safari|parco faunistico|parco zoologico|zoo|acquario|luna\s*park|giostre|parco divertimenti|aquapark|acquapark|water\s*park|fattoria didattica|museo dei bambini|children museum)\b/i.test(text))
      return true;

    return false;
  }

  function scoreForEventType(e, etKey) {
    const tags = inferTags(e);
    const text = `${e.title || ""} ${e.place || ""} ${e.city || ""}`.toLowerCase();
    let s = (typeof e.wow_score === "number" ? e.wow_score : 0);

    if (etKey === "famiglia") {
      if (!isTrueFamily(e)) return -9999;
      if (tags.includes("zoo")) s += 12;
      if (tags.includes("parco_avventura")) s += 12;
      if (tags.includes("acquario")) s += 11;
      if (tags.includes("parco_divertimenti")) s += 9;
      if (tags.includes("waterpark")) s += 8;
      if (tags.includes("fattoria_didattica")) s += 7;
      if (tags.includes("museo_bimbi")) s += 7;
      if (/\bparco\b/i.test(text) && !tags.some((x) => ["zoo","parco_avventura","parco_divertimenti","acquario","waterpark","fattoria_didattica","museo_bimbi"].includes(x))) {
        s -= 10;
      }
    }

    if (etKey === "relax") {
      if (tags.includes("terme")) s += 12;
      if (tags.includes("spa")) s += 12;
      if (NEG_RELAX.some((rx) => rx.test(text))) s -= 10;
    }

    if (etKey === "pioggia") {
      if (tags.includes("spa") || tags.includes("terme")) s += 9;
      if (tags.includes("acquario")) s += 9;
      if (tags.includes("museo")) s += 8;
      if (tags.includes("indoor")) s += 6;
      if (tags.includes("grotta")) s += 4;
    }

    if (etKey === "mangiare") {
      if (tags.includes("degustazione")) s += 8;
      if (tags.includes("street_food")) s += 8;
      if (tags.includes("birrificio")) s += 7;
      if (tags.includes("sagra")) s += 7;
      if (/ristorant|trattoria|osteria|agritur/i.test(text)) s += 2;
    }

    if (etKey === "tramonto") {
      if (tags.includes("belvedere")) s += 10;
      if (tags.includes("mare")) s += 5;
      if (tags.includes("lago")) s += 3;
    }

    if (etKey === "natura") {
      if (tags.includes("belvedere")) s += 3;
      if (tags.includes("lago")) s += 3;
    }

    return s;
  }

  // ------------------ DATASET CACHE + REGION PICK ------------------
  const CACHE = new Map(); // url -> { ideas, meta }
  let IT_REGIONS_INDEX = null; // {items:[{id,name,bbox,...}]}
  let LAST_META = { updated_at: "", count: 0, source: "", area: "" };

  async function fetchJson(url) {
    const r = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} loading ${url}`);
    return await r.json();
  }

  async function loadItRegionsIndexSafe() {
    if (IT_REGIONS_INDEX?.items?.length) return IT_REGIONS_INDEX;
    try {
      IT_REGIONS_INDEX = await fetchJson(PATHS.IT_REGIONS_INDEX_URL);
    } catch {
      IT_REGIONS_INDEX = null;
    }
    return IT_REGIONS_INDEX;
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

  function pickRegionSlugByOrigin(origin) {
    const lat = Number(origin?.lat);
    const lon = Number(origin?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const items = IT_REGIONS_INDEX?.items;
    if (!Array.isArray(items) || !items.length) return null;

    let best = null;
    for (const r of items) {
      const bbox = r?.bbox;
      if (!bbox) continue;
      if (!withinBBox(lat, lon, bbox)) continue;
      // prefer smallest bbox (più specifico)
      const area = Math.abs((bbox.maxLat - bbox.minLat) * (bbox.maxLon - bbox.minLon));
      if (!best || area < best.area) best = { r, area };
    }
    return best?.r?.id ? String(best.r.id) : null; // id = slug (es: abruzzo, veneto...)
  }

  // fallback hardcoded (solo se manca index)
  function pickRegionSlugFallback(origin) {
    const lat = Number(origin?.lat);
    const lon = Number(origin?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const inBox = (w, s, e, n) => lon >= w && lon <= e && lat >= s && lat <= n;

    if (inBox(13.0, 41.65, 14.85, 42.95)) return "abruzzo";
    if (inBox(10.2, 44.7, 12.3, 46.2)) return "veneto"; // più corretto del vecchio "verona"
    return null;
  }

  function buildDatasetOrder(origin) {
    const order = [];

    const slug = pickRegionSlugByOrigin(origin) || pickRegionSlugFallback(origin);
    if (slug) order.push(PATHS.MAIFATTO_REGION_URL(slug));

    // “all” sempre
    order.push(PATHS.MAIFATTO_ALL_URL);


    // dedupe
    const seen = new Set();
    return order.filter((u) => {
      const s = String(u || "").trim();
      if (!s || seen.has(s)) return false;
      seen.add(s);
      return true;
    });
  }

  function normalizeIdeasPayload(j, url) {
    // accetta: {ideas:[...]} oppure {events:[...]} oppure array diretto
    let ideas = [];
    if (Array.isArray(j?.ideas)) ideas = j.ideas;
    else if (Array.isArray(j?.events)) {
      ideas = j.events.map((e) => ({
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
        tags: e.tags,
      }));
    } else if (Array.isArray(j)) ideas = j;

    const meta = {
      updated_at: j?.updated_at || j?.generated_at || "",
      count: j?.count ?? ideas.length,
      source: ideas?.[0]?.source || "curated_mai_fatto",
      area: j?.area || String(url || "").split("/").pop(),
    };
    return { ideas, meta };
  }

  async function loadDatasetForOrigin(origin) {
    await loadItRegionsIndexSafe();
    const urls = buildDatasetOrder(origin);

    for (const url of urls) {
      try {
        if (CACHE.has(url)) {
          const cached = CACHE.get(url);
          LAST_META = cached.meta;
          return cached.ideas;
        }
        const j = await fetchJson(url);
        const { ideas, meta } = normalizeIdeasPayload(j, url);
        if (ideas && ideas.length) {
          CACHE.set(url, { ideas, meta });
          LAST_META = meta;
          return ideas;
        }
      } catch (_) {}
    }

    // fallback ultimo: events_all
    const j2 = await fetchJson(PATHS.FALLBACK_EVENTS_URL);
    const { ideas, meta } = normalizeIdeasPayload(j2, PATHS.FALLBACK_EVENTS_URL);
    LAST_META = { ...meta, source: "fallback_events" };
    return ideas || [];
  }

  // ------------------ SELEZIONE (FIX: “solo da 2h” -> widen vero) ------------------
  function matchesDurationBucket(e, wantKey) {
    const b = normalizeKey(e.duration_bucket || "");
    const m = Number(e.duration_min);

    // Nota: 1h/2h QUI sono “durata esperienza”, NON “distanza”.
    // Non vogliamo uccidere troppo: fallback su duration_min.
    if (wantKey === "1h") {
      if (b === "1h") return true;
      if (Number.isFinite(m) && m > 0 && m <= 100) return true;
      return false;
    }
    if (wantKey === "2h") {
      if (b === "2h") return true;
      if (Number.isFinite(m) && m > 100 && m <= 190) return true;
      return false;
    }
    return true;
  }

  function pickIdeas({ all, origin, maxMinutes, eventType, haversineKm, estCarMinutesFromKm }) {
    const base = Array.isArray(all) ? all.slice() : [];
    const mm = Math.max(15, Number(maxMinutes) || 120);
    const et = normalizeKey(eventType || "tutti");

    // 0) pulizia minima: coordinate valide
    const baseValid = base.filter((e) => Number.isFinite(Number(e.lat)) && Number.isFinite(Number(e.lon)));

    // 1) filtro sottocategoria (strict)
    const filterStrict = (arr) => {
      let out = arr;

      if (et === "1h" || et === "2h") {
        out = out.filter((e) => matchesDurationBucket(e, et));
      } else if (et && et !== "tutti") {
        out = out.filter((e) => normalizeCategoryFromData(e.category) === et);
      }

      if (et === "famiglia") out = out.filter((e) => isTrueFamily(e));
      return out;
    };

    let list = filterStrict(baseValid);

    // 2) anti-famoso SOFT (mai “0 per colpa filtro”)
    const preAnti = list.length;
    if (preAnti > 10) {
      const tmp = list.filter((e) => !isTooFamous(e));
      // se taglia troppo, non applicare
      if (tmp.length >= Math.max(6, Math.round(preAnti * 0.35))) list = tmp;
    }

    // 3) se troppo poco, allenta SOLO per tipi non-family
    //    (family resta family WOW)
    if (list.length < 5) {
      if (et === "famiglia") {
        list = baseValid.filter((e) => isTrueFamily(e));
      } else if (et === "1h" || et === "2h") {
        // allenta duration filter
        list = baseValid.slice();
      } else if (et && et !== "tutti") {
        list = baseValid.slice();
      }
    }

    const hasOrigin = origin && Number.isFinite(Number(origin.lat)) && Number.isFinite(Number(origin.lon));
    const hKm = typeof haversineKm === "function" ? haversineKm : haversineKmFallback;

    // 4) Distanza/minuti: widen SMART
    //    Qui è il FIX che ti serve: non deve “partire da 2h”.
    //    - prima prova entro mm
    //    - poi mm*1.15 / 1.35 / 1.60 / 1.95 (soft)
    //    - se ancora poco, consenti “top wow” anche più lontano ma penalizzato
    const widenFactors = [1.00, 1.15, 1.35, 1.60, 1.95];

    function rank(arr, capMinutes, { allowOverCap = false } = {}) {
      const items = arr
        .map((e) => {
          const km = hasOrigin ? hKm(origin.lat, origin.lon, Number(e.lat), Number(e.lon)) : null;
          const mins = km == null ? null : approxMinutesFromKm(km, estCarMinutesFromKm);

          const s0 = scoreForEventType(e, et);

          // penalità distanza (leggera)
          let s = s0;
          if (mins != null && Number.isFinite(mins)) {
            const over = mins - capMinutes;
            if (over > 0) s -= Math.min(18, over / 10); // penalizza ma non elimina
            // bonus “vicino”
            s += Math.max(0, 6 - mins / 30);
          }

          // bonus qualità link/info
          const infoUrlRaw = (e.info_url || e.url || "").trim();
          if (isProbablyInfoUrl(infoUrlRaw)) s += 1.2;

          return { e, mins: mins ?? null, s };
        })
        .filter((x) => {
          if (!allowOverCap) {
            return x.mins == null ? true : x.mins <= capMinutes;
          }
          return true;
        })
        .sort((a, b) => {
          if (Math.abs(b.s - a.s) > 0.25) return b.s - a.s;
          return (a.mins ?? 999999) - (b.mins ?? 999999);
        })
        .map((x) => x.e);

      return items;
    }

    let picked = [];
    if (hasOrigin) {
      for (const f of widenFactors) {
        const cap = Math.round(mm * f);
        picked = rank(list, cap, { allowOverCap: false });
        if (picked.length >= 8) break;
      }
      // se ancora poco, prendi top WOW anche over-cap (penalizzati)
      if (picked.length < 6) {
        picked = rank(list, Math.round(mm * 1.35), { allowOverCap: true });
      }
    } else {
      picked = list
        .map((e) => ({ e, s: scoreForEventType(e, et) }))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.e);
    }

    // dedupe “titolo + luogo”
    const seen = new Set();
    const out = [];
    for (const e of picked) {
      const key = `${String(e.title || "").toLowerCase().trim()}|${String(e.place || "").toLowerCase().trim()}|${String(e.city || "").toLowerCase().trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
      if (out.length >= SHOW_LIMIT) break;
    }

    return out;
  }

  // ------------------ RENDER ------------------
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

    const oLat = Number(origin?.lat);
    const oLon = Number(origin?.lon);

    const cards = items
      .map((e) => {
        const title = e.title || "Idea WOW";
        const where = nicePlaceLine(e);
        const why = (e.why || "").trim();

        const catKey = normalizeKey(normalizeCategoryFromData(e.category));
        const catLabel = labelCategory(catKey);

        const durBucket = normalizeKey(e.duration_bucket || "");
        const durLine =
          durBucket === "1h" || durBucket === "2h"
            ? `⏱️ ${durBucket.toUpperCase()} • ~${esc(e.duration_min || "")} min`
            : (e.duration_min ? `⏱️ ~${esc(e.duration_min)} min` : "");

        const q = placeQuery(e);
        const openPlaceUrl = mapsSearchUrl(q);
        const goUrl = mapsDirUrlTextDest({ oLat, oLon, destQuery: q, mode: "driving" });

        const infoUrlRaw = (e.info_url || e.url || "").trim();
        const infoUrl = isProbablyInfoUrl(infoUrlRaw) ? infoUrlRaw : "";

        const placeBlock = where
          ? `<div style="margin-top:10px; font-weight:950; font-size:15px; letter-spacing:.2px;">📍 ${esc(where)}</div>`
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
      })
      .join("");

    area.innerHTML = `
      <div class="card clickSafe" style="box-shadow:none; border-color:rgba(0,224,255,.20); background:rgba(0,224,255,.05);">
        <div style="font-weight:950; font-size:18px;">✨ MAI FATTO — WOW vicini</div>
        <div class="small muted" style="margin-top:6px;">
          ${updated ? `Dataset aggiornato ${esc(updated)}` : "Dataset offline"} • totale ${esc(total)}${areaName}
        </div>
        <div class="small muted" style="margin-top:6px;">
          Mostrate: ${esc(items.length)} • entro ~${esc(maxMinutes)} min (widening smart incluso)
        </div>
      </div>
      ${cards}
    `;
  }

  // ------------------ PUBLIC API ------------------
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
              Controlla che esista almeno:
              <br><b>${esc(PATHS.MAIFATTO_ALL_URL)}</b>
              <br>oppure <b>/data/mai_fatto/mai_fatto_it_${esc("REGIONE")}.json</b>
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
