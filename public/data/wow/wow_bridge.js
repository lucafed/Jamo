/* /public/wow/wow_bridge.js — WOW Finder bridge (REGION → NEIGHBORS → IT ALL)
 * ✅ Anti-spazzatura forte (borghi puliti)
 * ✅ Mare fallback (anche se non hai dataset mare dedicato)
 * ✅ Widening soft (non blocca a 2h)
 * ✅ Nessun numero “(9959)” in UI (opzionale via setting)
 */

(() => {
  "use strict";

  const WOW_INDEX_URL = "/data/wow/wow_it_index.json";

  // Neighbors minimale (si può migliorare leggendo un index regioni)
  const NEIGHBORS = {
    veneto: ["trentino-alto-adige", "lombardia", "emilia-romagna", "friuli-venezia-giulia"],
    lombardia: ["piemonte", "veneto", "trentino-alto-adige", "emilia-romagna", "liguria"],
    lazio: ["toscana", "umbria", "marche", "abruzzo", "campania", "molise"],
    toscana: ["liguria", "emilia-romagna", "umbria", "lazio"],
    sicilia: ["calabria"]
  };

  const CATEGORY_RULES = {
    borghi: {
      // “Borgo” vero = insediamento, centro abitato, frazione, paese, città.
      // Se il dataset è sporco, qui lo ripuliamo con denylist aggressiva.
      denyName: [
        "cantina", "enoteca", "wine", "azienda agricola", "agritur", "ristor",
        "hotel", "b&b", "resort", "spa", "terme", "rifugio", "bivacco",
        "parco", "lago", "cascata", "torre", "castello", "forte", "museo",
        "case sparse", "casa", "locanda", "osteria", "bar"
      ],
      allowIfLooksLikeTown: true
    },

    mare: {
      // Se non hai dataset mare: pesca per keyword dai POI generali.
      // (spiaggia/cala/lido/scogliera/trabocco/belvedere mare…)
      includeName: ["spiaggia", "cala", "lido", "baia", "scogl", "trabocc", "faragl", "mare", "costa"]
    },

    natura: { /* ok */ },
    trekking: { /* ok */ },
    lago: { includeName: ["lago", "laghetto"] },
    relax: { includeName: ["terme", "spa", "sauna", "bagni", "sorgente calda"] },
    storia: { includeName: ["castello", "rocca", "torre", "forte", "museo", "anfiteatro", "templi", "abbazia"] },
    family: { includeName: ["parco", "zoo", "acquario", "gardaland", "avventura", "natura viva"] },
    cantine: { includeName: ["cantina", "enoteca", "wine", "vign", "azienda agricola"] }
  };

  function norm(s) {
    return String(s || "").trim().toLowerCase();
  }

  function nameHasAny(name, arr) {
    const n = norm(name);
    return arr.some(k => n.includes(norm(k)));
  }

  function looksLikeTownName(name) {
    // euristica: se sembra proprio un comune/frazione (no parole “commerciali”)
    const n = norm(name);
    if (!n) return false;
    const bad = ["cantina","enoteca","wine","azienda","agritur","hotel","b&b","spa","terme","rifugio","bivacco","parco","lago","cascata","ristor","locanda"];
    if (bad.some(x => n.includes(x))) return false;
    // se contiene “borgo” ma poi parole commerciali → NO
    if (n.includes("borgo") && bad.some(x => n.includes(x))) return false;
    return true;
  }

  function passCategoryGuards(item, category) {
    const name = item.title || item.name || "";
    const rules = CATEGORY_RULES[category] || {};
    if (category === "borghi") {
      if (rules.denyName && nameHasAny(name, rules.denyName)) return false;
      if (rules.allowIfLooksLikeTown && !looksLikeTownName(name)) return false;
      return true;
    }
    if (rules.includeName && !nameHasAny(name, rules.includeName)) {
      // per categorie “a keyword” (lago/relax/storia/family/cantine/mare)
      return false;
    }
    return true;
  }

  async function fetchJson(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`Fetch failed: ${url}`);
    return await r.json();
  }

  async function loadWowIndex() {
    return await fetchJson(WOW_INDEX_URL);
  }

  function getRegionSlugFromApp(appState) {
    // prova a leggere da dove lo tieni già (origin / regione)
    return appState?.origin_region_slug || appState?.regionSlug || "";
  }

  function desiredMinutesToRange(minutes) {
    // esempio: 90 -> include [60-120] e [120-180] soft
    if (minutes <= 75) return ["60-120"];
    if (minutes <= 135) return ["60-120", "120-180"];
    if (minutes <= 210) return ["120-180", "180-240"];
    if (minutes <= 270) return ["180-240", "240-360"];
    return ["240-360"];
  }

  function scoreItem(item, category, targetMin) {
    // punteggio semplice: wow_level + match best_time
    const wl = Number(item.wow_level || 0);
    const bt = Array.isArray(item.best_time) ? item.best_time : [];
    const wanted = desiredMinutesToRange(targetMin);
    const timeBonus = bt.some(x => wanted.includes(x)) ? 0.6 : 0;
    const base = wl + timeBonus;

    // penalizza “vago”
    const why = norm(item.why_wow || "");
    const vaguePenalty = why.includes("meta selezionata") ? -0.8 : 0;

    // bonus mare se contiene keyword mare e stai cercando mare
    const name = item.title || item.name || "";
    const seaBonus = (category === "mare" && nameHasAny(name, CATEGORY_RULES.mare.includeName || [])) ? 0.5 : 0;

    return base + vaguePenalty + seaBonus;
  }

  function uniqById(items) {
    const seen = new Set();
    const out = [];
    for (const it of items) {
      const id = it.id || `${it.title || it.name}-${it.lat}-${it.lon}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(it);
    }
    return out;
  }

  async function loadDatasetForRegion(index, slug) {
    const entry = (index.regions || []).find(r => r.slug === slug);
    if (!entry) return null;
    try {
      return await fetchJson(entry.url);
    } catch (_) {
      return null;
    }
  }

  async function loadFallbackAll(index) {
    return await fetchJson(index.fallback_all);
  }

  async function getWowCandidates({ appState, category, targetMinutes }) {
    const idx = await loadWowIndex();
    const region = getRegionSlugFromApp(appState);
    const neighborSlugs = (NEIGHBORS[region] || []).filter(Boolean);

    const datasets = [];

    // 1) regione
    if (region) {
      const ds = await loadDatasetForRegion(idx, region);
      if (ds?.items?.length) datasets.push({ slug: region, ds });
    }

    // 2) vicine (soft widening)
    for (const ns of neighborSlugs) {
      const ds = await loadDatasetForRegion(idx, ns);
      if (ds?.items?.length) datasets.push({ slug: ns, ds });
    }

    // 3) fallback Italia
    const all = await loadFallbackAll(idx);
    if (all?.items?.length) datasets.push({ slug: "it", ds: all });

    // raccogli items
    let items = [];
    for (const pack of datasets) {
      const arr = pack.ds.items || [];
      for (const it of arr) {
        items.push({ ...it, _wow_src: pack.slug });
      }
    }

    // filtri categoria (anti-spazzatura)
    items = items.filter(it => passCategoryGuards(it, category));

    // ordinamento per score
    items.sort((a, b) => scoreItem(b, category, targetMinutes) - scoreItem(a, category, targetMinutes));

    // dedup + limit
    items = uniqById(items).slice(0, 18);

    return { items, meta: { region, category, targetMinutes, total: items.length, showDatasetCounts: !!idx.settings?.showDatasetCounts } };
  }

  // Expose globale (aggancia questo a app.js dove fai WOW Finder)
  window.JAMO_WOW = {
    getWowCandidates
  };
})();
