/* /public/wow/wow_bridge.js — WOW Finder bridge (CURATED • REGION → NEIGHBORS → IT ALL)
 * ✅ Dataset curati senza lat/lon (sicuro) → geocode runtime via /api/geocode
 * ✅ Cache coords (localStorage) per velocità
 * ✅ Anti-spazzatura forte (borghi non = cantine/hotel/etc)
 * ✅ Mare fallback: se vuoi mare ma non c'è mare, pesca comunque "spiaggia/cala/baia..."
 * ✅ Widening soft: non blocca sotto 2h
 */

(() => {
  "use strict";

  const WOW_INDEX_URL = "/data/wow/wow_it_index.json";
  const GEOCODE_URL = "/api/geocode?q=";

  const CACHE_KEY = "jamo_wow_geocode_cache_v1";
  const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 60; // 60 giorni

  const NEIGHBORS = {
    veneto: ["trentino-alto-adige", "lombardia", "emilia-romagna", "friuli-venezia-giulia"],
    lombardia: ["piemonte", "veneto", "trentino-alto-adige", "emilia-romagna", "liguria"],
    lazio: ["toscana", "umbria", "marche", "abruzzo", "campania", "molise"],
    toscana: ["liguria", "emilia-romagna", "umbria", "lazio"],
    sicilia: ["calabria"]
  };

  const CATEGORY_RULES = {
    borghi: {
      denyName: [
        "cantina", "enoteca", "wine", "azienda agricola", "agritur",
        "ristor", "hotel", "b&b", "resort", "spa", "terme",
        "rifugio", "bivacco",
        "parco", "lago", "cascata",
        "museo", "galleria", "mostra"
      ],
      allowIfLooksLikeTown: true
    },
    mare: { includeName: ["spiaggia","cala","lido","baia","scogl","faragl","mare","costa"] },
    lago: { includeName: ["lago","laghetto"] },
    relax: { includeName: ["terme","spa","sauna","bagni","wellness"] },
    storia: { includeName: ["castello","rocca","forte","mura","abbazia","duomo","cattedrale","anfiteatro","tempio","villa"] },
    family: { includeName: ["parco","zoo","acquario","avventura","giochi","bioparco"] },
    cantine: { includeName: ["cantina","enoteca","wine","vini","degust","vigna"] },
    natura: { /* ok */ },
    trekking: { /* ok */ },
    montagna: { /* ok */ }
  };

  function norm(s) { return String(s || "").trim().toLowerCase(); }
  function nameHasAny(name, arr) {
    const n = norm(name);
    return (arr || []).some(k => n.includes(norm(k)));
  }

  function looksLikeTownName(name) {
    const n = norm(name);
    if (!n) return false;
    const bad = [
      "cantina","enoteca","wine","azienda","agritur","hotel","b&b","spa","terme",
      "ristor","locanda","osteria","bar","rifugio","bivacco","museo"
    ];
    if (bad.some(x => n.includes(x))) return false;
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
    if (rules.includeName && !nameHasAny(name, rules.includeName)) return false;
    return true;
  }

  async function fetchJson(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`Fetch failed: ${url}`);
    return await r.json();
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return {};
      const j = JSON.parse(raw);
      return j && typeof j === "object" ? j : {};
    } catch {
      return {};
    }
  }
  function saveCache(c) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch {}
  }

  function cacheKeyForQuery(q) {
    return norm(q).replace(/\s+/g, " ").slice(0, 160);
  }

  async function geocodeCached(query) {
    const q = String(query || "").trim();
    if (!q) return null;

    const ck = cacheKeyForQuery(q);
    const cache = loadCache();
    const hit = cache[ck];
    const now = Date.now();

    if (hit && hit.ts && (now - hit.ts) < CACHE_TTL_MS && Number.isFinite(hit.lat) && Number.isFinite(hit.lon)) {
      return { lat: hit.lat, lon: hit.lon, label: hit.label || q, country_code: hit.country_code || "" };
    }

    const r = await fetch(`${GEOCODE_URL}${encodeURIComponent(q)}`, { cache: "no-store" });
    const j = await r.json().catch(() => null);
    if (!j || !j.ok || !j.result) return null;

    const lat = Number(j.result.lat);
    const lon = Number(j.result.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    cache[ck] = { ts: now, lat, lon, label: j.result.label || q, country_code: j.result.country_code || "" };
    saveCache(cache);

    return { lat, lon, label: j.result.label || q, country_code: j.result.country_code || "" };
  }

  function desiredMinutesToRange(minutes) {
    if (minutes <= 75) return ["45-90","60-120"];
    if (minutes <= 135) return ["60-120","120-180"];
    if (minutes <= 210) return ["120-180","180-240"];
    if (minutes <= 270) return ["180-240","240-360"];
    return ["240-360","360+"];
  }

  function scoreItem(item, category, targetMin) {
    const wl = Number(item.wow_level || 0);
    const bt = Array.isArray(item.best_time) ? item.best_time : [];
    const wanted = desiredMinutesToRange(targetMin);
    const timeBonus = bt.some(x => wanted.includes(x)) ? 0.7 : 0;
    const base = wl + timeBonus;

    const why = norm(item.why_wow || "");
    const vaguePenalty = (why.length < 16) ? -0.4 : 0;

    const name = item.title || item.name || "";
    const seaBonus = (category === "mare" && nameHasAny(name, CATEGORY_RULES.mare.includeName)) ? 0.6 : 0;

    return base + vaguePenalty + seaBonus;
  }

  function uniqById(items) {
    const seen = new Set();
    const out = [];
    for (const it of items) {
      const id = it.id || `${it.title || it.name}-${it.query || ""}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(it);
    }
    return out;
  }

  function getRegionSlugFromApp(appState) {
    return String(appState?.origin_region_slug || appState?.regionSlug || "").trim().toLowerCase();
  }

  async function loadDatasetForRegion(index, slug) {
    const entry = (index.regions || []).find(r => r.slug === slug);
    if (!entry) return null;
    try { return await fetchJson(entry.url); } catch { return null; }
  }

  async function loadFallbackAll(index) {
    try { return await fetchJson(index.fallback_all); } catch { return null; }
  }

  // ----------- MAIN: candidates + geocode runtime -----------
  async function getWowCandidates({ appState, category, targetMinutes, limit = 18 }) {
    const idx = await fetchJson(WOW_INDEX_URL);
    const region = getRegionSlugFromApp(appState);
    const neighborSlugs = (NEIGHBORS[region] || []).filter(Boolean);

    const packs = [];

    if (region) {
      const ds = await loadDatasetForRegion(idx, region);
      if (ds?.items?.length) packs.push({ slug: region, ds });
    }
    for (const ns of neighborSlugs) {
      const ds = await loadDatasetForRegion(idx, ns);
      if (ds?.items?.length) packs.push({ slug: ns, ds });
    }
    const all = await loadFallbackAll(idx);
    if (all?.items?.length) packs.push({ slug: "it", ds: all });

    let items = [];
    for (const p of packs) {
      for (const it of (p.ds.items || [])) {
        items.push({ ...it, _wow_src: p.slug });
      }
    }

    // filtra per categoria (pulizia)
    items = items.filter(it => passCategoryGuards(it, category));

    // score
    items.sort((a, b) => scoreItem(b, category, targetMinutes) - scoreItem(a, category, targetMinutes));
    items = uniqById(items);

    // geocode solo dei primi (performance)
    const out = [];
    for (const it of items) {
      if (out.length >= limit) break;

      // query geocode: se c'è query usala, altrimenti title + region_hint
      const q = String(it.query || it.title || "").trim();
      const geo = await geocodeCached(q);
      if (!geo) continue;

      out.push({
        ...it,
        lat: geo.lat,
        lon: geo.lon,
        geo_label: geo.label || q,
        country_code: geo.country_code || it.country_code || "IT"
      });
    }

    return {
      items: out,
      meta: {
        region,
        category,
        targetMinutes,
        total: out.length,
        showDatasetCounts: !!idx.settings?.showDatasetCounts
      }
    };
  }

  // export globale
  window.JAMO_WOW = { getWowCandidates };
})();
