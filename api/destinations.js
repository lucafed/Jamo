// /api/destinations.js — Jamo LIVE destinations (Overpass) — v2.2 (RESILIENT)
// - Partial success: se 1 query fallisce, le altre contano
// - Concurrency limitata (per non far scattare rate/timeout)
// - Riduce payload: out tags qt + limiti
// - Fallback endpoint automatico
// Returns:
// { ok:true, data:{elements:[...]}, meta:{cat,radiusKm,count,fromCache,endpoint,elapsedMs,notes:[], errors:[] } }

const TTL_MS = 1000 * 60 * 15; // 15 min cache
const cache = new Map(); // key -> { ts, data, meta }

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

function now() { return Date.now(); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function asNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function normCat(c) {
  const s = String(c || "ovunque").toLowerCase().trim();
  const allowed = new Set(["ovunque","family","relax","natura","storia","mare","borghi","citta","montagna"]);
  return allowed.has(s) ? s : "ovunque";
}
function cacheKey({ lat, lon, radiusKm, cat }) {
  const la = Math.round(lat * 100) / 100; // ~1km
  const lo = Math.round(lon * 100) / 100;
  const rk = Math.round(radiusKm);
  return `${cat}:${rk}:${la}:${lo}`;
}

async function fetchWithTimeout(url, { method = "POST", body, headers = {} } = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", ...headers },
      body,
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json().catch(() => null);
    if (!j) throw new Error("Bad JSON");
    return j;
  } finally {
    clearTimeout(t);
  }
}

function overpassBody(query) {
  return `data=${encodeURIComponent(query)}`;
}
function buildAround(radiusM, lat, lon) {
  return `around:${radiusM},${lat},${lon}`;
}

/**
 * NOTE IMPORTANTI:
 * - Usiamo query più piccole e “node-first”
 * - Limitiamo i risultati per query (es: 250–450)
 * - timeout per query 10–12
 */
function buildQueries(cat, radiusM, lat, lon) {
  const A = buildAround(radiusM, lat, lon);

  const Q = (inner, limit = 350) => `
[out:json][timeout:12];
(
${inner}
);
out tags qt ${limit};
`.trim();

  const QW = (inner, limit = 250) => `
[out:json][timeout:12];
(
${inner}
);
out tags center qt ${limit};
`.trim();

  if (cat === "family") {
    return [
      Q(`
  node[tourism=theme_park](${A});
  node[leisure=water_park](${A});
  node[tourism=zoo](${A});
  node[tourism=aquarium](${A});
  node[tourism=attraction](${A});
  node[leisure=amusement_arcade](${A});
  node[leisure=trampoline_park](${A});
  node[leisure=playground](${A});
  node[amenity=swimming_pool](${A});
  node[leisure=swimming_pool](${A});
  node["name"~"parco divertimenti|parco acquatico|acquapark|aqua park|water park|luna park|zoo|acquario|parco giochi|area giochi|trampolin|kids|bambin",i](${A});
      `, 450),
      // grandi parchi/aree verdi (fallback family)
      QW(`
  way[leisure=park](${A});
  way[leisure=nature_reserve](${A});
  way[boundary=national_park](${A});
      `, 220),
      // terme consentite anche in family
      Q(`
  node[amenity=spa](${A});
  node[natural=hot_spring](${A});
  node[amenity=public_bath](${A});
  node["name"~"terme|spa|thermal",i](${A});
      `, 200),
    ];
  }

  if (cat === "relax") {
    return [
      Q(`
  node[amenity=spa](${A});
  node[leisure=spa](${A});
  node[natural=hot_spring](${A});
  node[amenity=public_bath](${A});
  node["healthcare"="sauna"](${A});
  node["sauna"="yes"](${A});
  node["thermal"="yes"](${A});
  node["name"~"terme|spa|thermal|benessere|wellness",i](${A});
      `, 450),
      Q(`
  node[amenity=swimming_pool](${A});
  node[leisure=swimming_pool](${A});
  node[leisure=fitness_centre](${A});
  node["tourism"="resort"](${A});
  node["tourism"="hotel"]["spa"="yes"](${A});
      `, 350),
      // viewpoint e parchi “relax”
      Q(`
  node[tourism=viewpoint](${A});
  node[leisure=park](${A});
  node[leisure=picnic_table](${A});
      `, 350),
    ];
  }

  if (cat === "natura") {
    return [
      Q(`
  node[tourism=viewpoint](${A});
  node[natural=waterfall](${A});
  node[natural=peak](${A});
  node[natural=spring](${A});
  node[leisure=park](${A});
  node[leisure=nature_reserve](${A});
  node["name"~"cascata|lago|gola|riserva|parco|sentiero|bosco",i](${A});
      `, 500),
      QW(`
  way[leisure=park](${A});
  way[leisure=nature_reserve](${A});
  way[boundary=national_park](${A});
      `, 220),
    ];
  }

  if (cat === "storia") {
    return [
      Q(`
  node[historic=castle](${A});
  node[historic=ruins](${A});
  node[historic=archaeological_site](${A});
  node[tourism=museum](${A});
  node[historic=monument](${A});
  node[historic=memorial](${A});
  node["name"~"castello|rocca|forte|abbazia|museo|anfiteatro|tempio|scavi|necropoli|basilica",i](${A});
      `, 650),
      QW(`
  way[historic=castle](${A});
  way[historic=ruins](${A});
      `, 220),
    ];
  }

  if (cat === "mare") {
    return [
      Q(`
  node[natural=beach](${A});
  node["name"~"spiaggia|lido|mare|beach",i](${A});
      `, 450),
      QW(`
  way[natural=beach](${A});
      `, 220),
      Q(`
  node[leisure=marina](${A});
  node[harbour=yes](${A});
  node[tourism=viewpoint](${A});
      `, 350),
    ];
  }

  if (cat === "borghi") {
    return [
      Q(`
  node[place=village](${A});
  node[place=hamlet](${A});
  node["name"~"borgo",i](${A});
      `, 450),
    ];
  }

  if (cat === "citta") {
    return [
      Q(`
  node[place=city](${A});
  node[place=town](${A});
  node[tourism=attraction](${A});
      `, 450),
    ];
  }

  if (cat === "montagna") {
    return [
      Q(`
  node[natural=peak](${A});
  node["name"~"monte|cima|rifugio|passo",i](${A});
  node[tourism=viewpoint](${A});
      `, 450),
    ];
  }

  // ovunque
  return [
    Q(`
  node[tourism=attraction](${A});
  node[tourism=viewpoint](${A});
  node[tourism=museum](${A});
  node[historic=castle](${A});
  node[leisure=park](${A});
  node[natural=waterfall](${A});
  node[natural=beach](${A});
  node[amenity=spa](${A});
  node["name"~"castello|rocca|museo|cascata|lago|parco|terme|spa|spiaggia",i](${A});
    `, 700),
    QW(`
  way[leisure=park](${A});
  way[natural=beach](${A});
    `, 220),
  ];
}

function mergeElements(results) {
  const seen = new Set();
  const out = [];
  for (const j of results) {
    const els = Array.isArray(j?.elements) ? j.elements : [];
    for (const el of els) {
      const key = `${el.type}:${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(el);
    }
  }
  return out;
}

// Concurrency limit semplice: esegue max 2 query alla volta
async function runWithConcurrency(items, worker, concurrency = 2) {
  const results = [];
  let idx = 0;

  async function runOne() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => runOne());
  await Promise.all(runners);
  return results;
}

async function runOverpassQueries(queries) {
  const notes = [];
  const errors = [];
  const started = now();

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      // Esegui tutte le query su questo endpoint con partial success
      const settled = await runWithConcurrency(
        queries,
        async (q, i) => {
          try {
            const j = await fetchWithTimeout(endpoint, { method: "POST", body: overpassBody(q) }, 12000);
            return { ok: true, j };
          } catch (e) {
            errors.push(`q${i}_fail:${String(e?.message || e)}`);
            return { ok: false, j: null };
          }
        },
        2
      );

      const okOnes = settled.filter(x => x && x.ok && x.j).map(x => x.j);
      const elements = mergeElements(okOnes);

      // Se abbiamo almeno un po’ di risultati -> success
      if (elements.length > 0) {
        return { ok: true, endpoint, elements, elapsedMs: now() - started, notes, errors };
      }

      // Se nessun risultato ma almeno una query è andata ok -> endpoint valido ma “vuoto”
      if (okOnes.length > 0) {
        notes.push("endpoint_ok_but_empty");
        return { ok: true, endpoint, elements: [], elapsedMs: now() - started, notes, errors };
      }

      // Altrimenti tutte fail -> prova prossimo endpoint
      notes.push("endpoint_all_queries_failed");
      continue;
    } catch (e) {
      notes.push(`endpoint_fail:${String(e?.message || e)}`);
      continue;
    }
  }

  return { ok: false, endpoint: "", elements: [], elapsedMs: now() - started, notes, errors };
}

export default async function handler(req, res) {
  try {
    const lat = asNum(req.query?.lat);
    const lon = asNum(req.query?.lon);

    // IMPORTANTE: radius troppo grande = timeout overpass
    // Lo cappiamo e lasciamo al client la logica di retry/estensione.
    const radiusKm = clamp(asNum(req.query?.radiusKm) ?? 60, 5, 180);

    const cat = normCat(req.query?.cat);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ ok: false, error: "Missing lat/lon" });
    }

    const radiusM = Math.round(radiusKm * 1000);

    const key = cacheKey({ lat, lon, radiusKm, cat });
    const hit = cache.get(key);
    if (hit && now() - hit.ts < TTL_MS) {
      return res.status(200).json({
        ok: true,
        data: hit.data,
        meta: { ...hit.meta, fromCache: true, elapsedMs: 0, notes: [...(hit.meta?.notes || []), "cache_hit"] }
      });
    }

    const queries = buildQueries(cat, radiusM, lat, lon);
    const r = await runOverpassQueries(queries);

    const data = { elements: r.elements || [] };
    const meta = {
      cat,
      radiusKm,
      count: data.elements.length,
      fromCache: false,
      endpoint: r.endpoint || "",
      elapsedMs: r.elapsedMs || 0,
      notes: r.notes || [],
      errors: r.errors || [],
    };

    cache.set(key, { ts: now(), data, meta });

    // Anche se Overpass fallisce del tutto, rispondiamo ok:true con meta.errors,
    // così il client può mostrare “timeout/errore” e fare fallback.
    if (!r.ok && data.elements.length === 0) {
      meta.notes = [...meta.notes, "overpass_total_fail"];
    }

    return res.status(200).json({ ok: true, data, meta });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
