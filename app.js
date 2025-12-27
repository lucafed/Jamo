/* app.js — Jamo v2 (destinazioni famose + cosa vedere + Overpass robusto)
   Richiede nel DOM:
   - #btnGo, #timeSelect, #modeSelect
   - #result, #alts, #things
   - #visitedCheck (checkbox), #mapsLink (a)
*/

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];

const VISITED_KEY = "jamo_visited_v1";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getVisitedSet() {
  try {
    const arr = JSON.parse(localStorage.getItem(VISITED_KEY) || "[]");
    return new Set(arr);
  } catch { return new Set(); }
}
function saveVisitedSet(set) {
  localStorage.setItem(VISITED_KEY, JSON.stringify([...set]));
}

function kmFromMeters(m) { return Math.round((m/1000) * 10) / 10; }
function minFromSeconds(s) { return Math.round((s/60)); }

function toGoogleMapsLink(lat, lon, label="") {
  const q = label ? `${lat},${lon} (${encodeURIComponent(label)})` : `${lat},${lon}`;
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

async function getUserLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocalizzazione non supportata"));
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      err => reject(err),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  });
}

/** ====== ORS ISOCHRONE (usa il tuo endpoint /api/isochrone se già l’hai) ======
 * Mi baso sul fatto che tu abbia già una serverless Vercel tipo /api/isochrone
 * che ritorna un GeoJSON polygon (o multipolygon) dell’area raggiungibile.
 */
async function fetchIsochroneGeoJSON({ lat, lon, mode, seconds }) {
  // ADATTA se il tuo endpoint è diverso
  const url = `/api/isochrone?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&mode=${encodeURIComponent(mode)}&seconds=${encodeURIComponent(seconds)}`;
  const r = await fetch(url);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Isochrone API error (${r.status}): ${t}`);
  }
  return r.json();
}

/** Calcola un bbox approssimato dal GeoJSON (per query Overpass più snelle) */
function bboxFromGeoJSON(geojson) {
  let minLat =  90, minLon =  180, maxLat = -90, maxLon = -180;

  const walkCoords = (coords) => {
    if (typeof coords[0] === "number") {
      const [lon, lat] = coords;
      minLat = Math.min(minLat, lat);
      minLon = Math.min(minLon, lon);
      maxLat = Math.max(maxLat, lat);
      maxLon = Math.max(maxLon, lon);
      return;
    }
    for (const c of coords) walkCoords(c);
  };

  if (geojson.type === "FeatureCollection") {
    geojson.features.forEach(f => walkCoords(f.geometry.coordinates));
  } else if (geojson.type === "Feature") {
    walkCoords(geojson.geometry.coordinates);
  } else {
    walkCoords(geojson.coordinates);
  }

  return { minLat, minLon, maxLat, maxLon };
}

/** Overpass robust: prova più endpoint + retry/backoff */
async function overpassQuery(query, { tries = 4 } = {}) {
  let lastErr = null;

  for (let attempt = 0; attempt < tries; attempt++) {
    const ep = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);

      const res = await fetch(ep, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: "data=" + encodeURIComponent(query),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Overpass ${res.status}: ${txt.slice(0,200)}`);
      }

      return await res.json();
    } catch (e) {
      lastErr = e;
      // backoff: 600ms, 1200ms, 2400ms...
      await sleep(600 * Math.pow(2, attempt));
    }
  }

  throw new Error(`Overpass error: ${lastErr?.message || "unknown"}`);
}

/**
 * DESTINAZIONI FAMOSE:
 * - place=city|town sempre OK
 * - place=village solo se ha wikipedia/wikidata
 * - + qualche “wow” naturale: waterfall/cave/peak/lake ecc (ma limitati e con wiki se possibile)
 */
function buildDestinationsQueryFromBbox(bbox) {
  const { minLat, minLon, maxLat, maxLon } = bbox;

  // Query volutamente “leggera”: max 25-40 elementi, prioritizza wiki tags.
  // NB: Overpass non ha vero ORDER BY; quindi prendiamo più risultati e filtriamo in JS.
  return `
[out:json][timeout:20];
(
  // Città e paesi principali
  node["place"~"^(city|town)$"](${minLat},${minLon},${maxLat},${maxLon});
  // Villaggi solo se “noti” (wiki)
  node["place"="village"]["wikipedia"](${minLat},${minLon},${maxLat},${maxLon});
  node["place"="village"]["wikidata"](${minLat},${minLon},${maxLat},${maxLon});

  // WOW naturali (solo se noti)
  node["natural"="waterfall"]["wikipedia"](${minLat},${minLon},${maxLat},${maxLon});
  node["natural"="waterfall"]["wikidata"](${minLat},${minLon},${maxLat},${maxLon});
  node["natural"="peak"]["wikipedia"](${minLat},${minLon},${maxLat},${maxLon});
  node["natural"="peak"]["wikidata"](${minLat},${minLon},${maxLat},${maxLon});
  node["natural"="cave_entrance"]["wikipedia"](${minLat},${minLon},${maxLat},${maxLon});
  node["natural"="cave_entrance"]["wikidata"](${minLat},${minLon},${maxLat},${maxLon});
);
out body;
`;
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI/180;
  const dLon = (b.lon - a.lon) * Math.PI/180;
  const lat1 = a.lat * Math.PI/180;
  const lat2 = b.lat * Math.PI/180;
  const x = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function normalizeDestinations(overpassJson, origin) {
  const visited = getVisitedSet();
  const nodes = (overpassJson.elements || []).filter(e => e.type === "node" && e.tags);

  // “Fama” euristica:
  // - se ha wikipedia -> +3
  // - se ha wikidata -> +2
  // - city -> +3, town -> +2, village -> +1
  // - natural feature -> +2
  // - più vicino -> leggero bonus
  const scored = nodes.map(n => {
    const tags = n.tags || {};
    const name = tags.name || tags["name:it"] || "Senza nome";
    const place = tags.place || "";
    const isNatural = !!tags.natural;
    const score =
      (tags.wikipedia ? 3 : 0) +
      (tags.wikidata ? 2 : 0) +
      (place === "city" ? 3 : place === "town" ? 2 : place === "village" ? 1 : 0) +
      (isNatural ? 2 : 0);

    const dist = haversineKm(origin, { lat: n.lat, lon: n.lon });
    const nearBonus = Math.max(0, 3 - dist / 50); // bonus fino a 50km
    const finalScore = score + nearBonus;

    const idKey = tags.wikidata ? `wd:${tags.wikidata}` : `osmnode:${n.id}`;

    return {
      idKey,
      name,
      lat: n.lat,
      lon: n.lon,
      tags,
      distKm: Math.round(dist*10)/10,
      score: finalScore,
      visited: visited.has(idKey)
    };
  });

  // Togli duplicati per nome+coordinate appross
  const uniq = [];
  const seen = new Set();
  for (const d of scored) {
    const k = `${d.name.toLowerCase()}_${d.lat.toFixed(3)}_${d.lon.toFixed(3)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(d);
  }

  // Ordina: non visitati prima, poi score desc
  uniq.sort((a,b) => {
    if (a.visited !== b.visited) return a.visited ? 1 : -1;
    return b.score - a.score;
  });

  // Limitiamo per UI
  return uniq.slice(0, 25);
}

/** POI “COSA VEDERE” attorno alla meta (top 8) */
function buildThingsToSeeQuery(lat, lon) {
  const R = 7000; // 7km attorno al centro: sufficiente per “cosa vedere”
  return `
[out:json][timeout:20];
(
  node["tourism"~"^(attraction|museum|gallery|viewpoint)$"](around:${R},${lat},${lon});
  node["historic"](around:${R},${lat},${lon});
  node["natural"~"^(waterfall|peak|cave_entrance|spring|bay|beach|wood)$"](around:${R},${lat},${lon});
  node["leisure"~"^(park|garden)$"](around:${R},${lat},${lon});
);
out body 80;
`;
}

function normalizeThings(overpassJson) {
  const nodes = (overpassJson.elements || []).filter(e => e.type === "node" && e.tags);
  const items = nodes.map(n => {
    const t = n.tags || {};
    const name = t.name || t["name:it"];
    if (!name) return null;

    // priorità: musei/attrazioni/viewpoint > natural wow > historic generico > parchi
    let p = 0;
    if (t.tourism === "museum" || t.tourism === "attraction" || t.tourism === "viewpoint") p += 4;
    if (t.natural) p += 3;
    if (t.historic) p += 2;
    if (t.leisure === "park" || t.leisure === "garden") p += 1;
    if (t.wikipedia) p += 2;
    if (t.wikidata) p += 1;

    return {
      name,
      lat: n.lat,
      lon: n.lon,
      tags: t,
      priority: p
    };
  }).filter(Boolean);

  // unici per nome
  const seen = new Set();
  const uniq = [];
  for (const it of items) {
    const k = it.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(it);
  }

  uniq.sort((a,b) => b.priority - a.priority);
  return uniq.slice(0, 8);
}

/** UI helpers */
function $(id) { return document.getElementById(id); }
function setText(id, txt) { const el=$(id); if(el) el.textContent = txt; }
function setHTML(id, html) { const el=$(id); if(el) el.innerHTML = html; }

function renderDestination(dest, travelMinutes, modeLabel) {
  const wiki = dest.tags.wikipedia ? ` · Wikipedia` : "";
  return `
    <div style="margin-top:10px">
      <div style="font-weight:700;font-size:18px">${dest.name}</div>
      <div style="opacity:.85">⏱️ ~${travelMinutes} min · 📍 ${dest.distKm} km (aria) · ${modeLabel}${wiki}</div>
    </div>
  `;
}

function renderAlternatives(list, travelMinutes, modeLabel) {
  if (!list.length) return `<div style="opacity:.8">Nessuna alternativa trovata.</div>`;
  return list.map(d => `
    <div style="margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,.08)">
      <div style="font-weight:650">${d.name}</div>
      <div style="opacity:.85">⏱️ ~${travelMinutes} min · 📍 ${d.distKm} km (aria) · ${modeLabel}</div>
      <a href="${toGoogleMapsLink(d.lat,d.lon,d.name)}" target="_blank" rel="noopener">Apri su Google Maps</a>
    </div>
  `).join("");
}

function renderThings(things) {
  if (!things.length) return `<div style="opacity:.8">Niente di rilevante trovato nelle vicinanze (OSM). Prova un raggio diverso più avanti.</div>`;
  return things.map(t => `
    <div style="margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,.08)">
      <div style="font-weight:650">${t.name}</div>
      <a href="${toGoogleMapsLink(t.lat,t.lon,t.name)}" target="_blank" rel="noopener">Apri</a>
    </div>
  `).join("");
}

/** Tempo massimo ORS: molti profili in isochrone hanno limiti (es: 3600s).
 * Per evitare errori: se selezioni 2-3 ore, facciamo fallback:
 * - usiamo ORS solo fino a 1h (3600s)
 * - poi “espandiamo” il bbox con un raggio euristico (gratis e veloce)
 */
function clampSecondsForORS(seconds) {
  return Math.min(seconds, 3600); // 1h
}

function expandBbox(bbox, factor = 1.8) {
  const latMid = (bbox.minLat + bbox.maxLat) / 2;
  const lonMid = (bbox.minLon + bbox.maxLon) / 2;
  const latHalf = (bbox.maxLat - bbox.minLat) / 2 * factor;
  const lonHalf = (bbox.maxLon - bbox.minLon) / 2 * factor;
  return {
    minLat: latMid - latHalf,
    maxLat: latMid + latHalf,
    minLon: lonMid - lonHalf,
    maxLon: lonMid + lonHalf
  };
}

/** Stima minuti in base al mezzo + distanza “in aria” (coerente e veloce) */
function estimateTravelMinutes(mode, distKm) {
  // velocità medie conservative
  const speed = {
    car: 70,        // media reale (strade)
    bike: 16,
    foot: 4.5
  }[mode] || 60;

  // fattore “strade vs aria”
  const roadFactor = mode === "car" ? 1.25 : mode === "bike" ? 1.15 : 1.10;
  const hours = (distKm * roadFactor) / speed;
  return Math.max(10, Math.round(hours * 60));
}

/** MAIN */
async function runJamo() {
  const btn = $("btnGo");
  const result = $("result");
  const alts = $("alts");
  const things = $("things");
  const visitedCheck = $("visitedCheck");
  const mapsLink = $("mapsLink");

  try {
    btn && (btn.disabled = true);

    setHTML("result", `<div style="opacity:.9">📍 Sto prendendo la posizione…</div>`);
    setHTML("alts", ``);
    setHTML("things", ``);

    const origin = await getUserLocation();

    const timeVal = ($("timeSelect")?.value || "120"); // minuti
    const totalMinutes = parseInt(timeVal, 10);
    const totalSeconds = totalMinutes * 60;

    const modeSel = ($("modeSelect")?.value || "car");
    const orsProfile = modeSel === "car" ? "driving-car" : modeSel === "bike" ? "cycling-regular" : "foot-walking";
    const modeLabel = modeSel === "car" ? "Auto" : modeSel === "bike" ? "Bici" : "A piedi";

    // 1) Isochrone “clamp” per non far esplodere ORS
    const orsSeconds = clampSecondsForORS(totalSeconds);

    setHTML("result", `<div style="opacity:.9">🧠 Calcolo area raggiungibile (${modeLabel})…</div>`);
    const iso = await fetchIsochroneGeoJSON({ lat: origin.lat, lon: origin.lon, mode: orsProfile, seconds: orsSeconds });

    let bbox = bboxFromGeoJSON(iso);

    // se il tempo totale richiesto è > ORS clamp, espandiamo bbox
    if (totalSeconds > orsSeconds) {
      // espansione moderata; per bici/piedi più prudente per evitare 504
      const factor = modeSel === "car" ? 2.2 : modeSel === "bike" ? 1.6 : 1.4;
      bbox = expandBbox(bbox, factor);
    }

    // 2) Destinazioni famose via Overpass (robusto)
    setHTML("result", `<div style="opacity:.9">🔎 Cerco mete “sensate” (non posti a caso)…</div>`);
    const q = buildDestinationsQueryFromBbox(bbox);
    const destJson = await overpassQuery(q);

    let dests = normalizeDestinations(destJson, origin);

    // se troppo poche, allarga un filo (ma senza uccidere Overpass)
    if (dests.length < 6) {
      const bbox2 = expandBbox(bbox, modeSel === "car" ? 1.35 : 1.20);
      const q2 = buildDestinationsQueryFromBbox(bbox2);
      const destJson2 = await overpassQuery(q2);
      dests = normalizeDestinations(destJson2, origin);
    }

    if (!dests.length) {
      setHTML("result", `<div style="color:#ffb3b3">❌ Non ho trovato mete “note” in quest’area. Prova ad aumentare il tempo o usare Auto.</div>`);
      return;
    }

    // 3) Scelta: prima non visitata e più “alta” di score
    const main = dests[0];
    const altList = dests.slice(1, 4);

    const estMin = estimateTravelMinutes(modeSel, main.distKm);

    setHTML("result", renderDestination(main, estMin, modeLabel));
    setHTML("alts", renderAlternatives(altList, estMin, modeLabel));

    // link Maps
    if (mapsLink) {
      mapsLink.href = toGoogleMapsLink(main.lat, main.lon, main.name);
      mapsLink.style.display = "inline-block";
    }

    // visited checkbox
    if (visitedCheck) {
      const visited = getVisitedSet();
      visitedCheck.checked = visited.has(main.idKey);
      visitedCheck.onchange = () => {
        const v = getVisitedSet();
        if (visitedCheck.checked) v.add(main.idKey);
        else v.delete(main.idKey);
        saveVisitedSet(v);
      };
    }

    // 4) Cosa vedere lì (POI)
    setHTML("things", `<div style="opacity:.9;margin-top:10px">✨ Cerco cosa vedere a ${main.name}…</div>`);
    const tq = buildThingsToSeeQuery(main.lat, main.lon);
    const thingJson = await overpassQuery(tq);
    const list = normalizeThings(thingJson);
    setHTML("things", `<h3 style="margin-top:14px">Cosa vedere a ${main.name}</h3>` + renderThings(list));

  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    // messaggio friendly
    setHTML("result", `<div style="color:#ffb3b3">❌ Errore: ${msg}<br><span style="opacity:.8">Suggerimento: riprova tra 10s (Overpass spesso è occupato).</span></div>`);
  } finally {
    const btn = $("btnGo");
    btn && (btn.disabled = false);
  }
}

/** Hook */
window.addEventListener("DOMContentLoaded", () => {
  const btn = $("btnGo");
  btn && btn.addEventListener("click", runJamo);
});
