/* app.js — Jamo v2 (compatibile con il tuo index.html)
   IDs usati:
   - #goBtn, #timeSelect, #modeSelect
   - #status, #result (hidden), #placeName, #placeMeta
   - #mapsLink, #visitedBtn, #altList
*/

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];

const VISITED_KEY = "jamo_visited_v1";

function $(id){ return document.getElementById(id); }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function setStatus(msg, kind="") {
  const el = $("status");
  if (!el) return;
  el.classList.remove("err","ok");
  if (kind) el.classList.add(kind);
  el.textContent = msg;
}

function showResult(show=true){
  const el = $("result");
  if (!el) return;
  el.classList.toggle("hidden", !show);
}

function getVisitedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(VISITED_KEY) || "[]")); }
  catch { return new Set(); }
}
function saveVisitedSet(set) {
  localStorage.setItem(VISITED_KEY, JSON.stringify([...set]));
}

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

/** ===== Isochrone API (Vercel) =====
 * Adatta questo endpoint se il tuo file serverless ha un path diverso.
 * Deve tornare un GeoJSON FeatureCollection.
 */
async function fetchIsochroneGeoJSON({ lat, lon, mode, seconds }) {
  const url = `/api/isochrone?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&mode=${encodeURIComponent(mode)}&seconds=${encodeURIComponent(seconds)}`;
  const r = await fetch(url);
  const t = await r.text();
  if (!r.ok) throw new Error(`Isochrone API error (${r.status}): ${t.slice(0,220)}`);
  try { return JSON.parse(t); } catch { throw new Error("Isochrone: risposta non JSON"); }
}

function bboxFromGeoJSON(geojson) {
  let minLat =  90, minLon =  180, maxLat = -90, maxLon = -180;

  const walkCoords = (coords) => {
    if (!coords) return;
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
    geojson.features.forEach(f => walkCoords(f.geometry?.coordinates));
  } else if (geojson.type === "Feature") {
    walkCoords(geojson.geometry?.coordinates);
  } else {
    walkCoords(geojson.coordinates);
  }

  return { minLat, minLon, maxLat, maxLon };
}

function expandBbox(b, factor = 1.6) {
  const latMid = (b.minLat + b.maxLat) / 2;
  const lonMid = (b.minLon + b.maxLon) / 2;
  const latHalf = (b.maxLat - b.minLat) / 2 * factor;
  const lonHalf = (b.maxLon - b.minLon) / 2 * factor;
  return {
    minLat: latMid - latHalf,
    maxLat: latMid + latHalf,
    minLon: lonMid - lonHalf,
    maxLon: lonMid + lonHalf
  };
}

/** Overpass robust (multi-endpoint + retry) */
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
      await sleep(700 * Math.pow(2, attempt)); // backoff
    }
  }

  throw lastErr || new Error("Overpass error");
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

/** Mete “sensate”: città/paesi + villaggi SOLO se noti (wiki/wd) + wow naturali con wiki/wd */
function buildDestinationsQueryFromBbox(b) {
  const { minLat, minLon, maxLat, maxLon } = b;
  return `
[out:json][timeout:20];
(
  node["place"~"^(city|town)$"](${minLat},${minLon},${maxLat},${maxLon});
  node["place"="village"]["wikipedia"](${minLat},${minLon},${maxLat},${maxLon});
  node["place"="village"]["wikidata"](${minLat},${minLon},${maxLat},${maxLon});

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

function normalizeDestinations(overpassJson, origin) {
  const visited = getVisitedSet();
  const nodes = (overpassJson.elements || []).filter(e => e.type === "node" && e.tags);

  const scored = nodes.map(n => {
    const t = n.tags || {};
    const name = t.name || t["name:it"] || "Senza nome";
    const place = t.place || "";
    const isNatural = !!t.natural;

    // punteggio “fama”
    const base =
      (t.wikipedia ? 3 : 0) +
      (t.wikidata ? 2 : 0) +
      (place === "city" ? 3 : place === "town" ? 2 : place === "village" ? 1 : 0) +
      (isNatural ? 2 : 0);

    const dist = haversineKm(origin, { lat: n.lat, lon: n.lon });
    const nearBonus = Math.max(0, 3 - dist / 50);
    const score = base + nearBonus;

    const idKey = t.wikidata ? `wd:${t.wikidata}` : `osmnode:${n.id}`;

    return {
      idKey,
      name,
      lat: n.lat,
      lon: n.lon,
      tags: t,
      distKm: Math.round(dist * 10) / 10,
      score,
      visited: visited.has(idKey)
    };
  });

  // dedupe
  const uniq = [];
  const seen = new Set();
  for (const d of scored) {
    const k = `${d.name.toLowerCase()}_${d.lat.toFixed(3)}_${d.lon.toFixed(3)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(d);
  }

  uniq.sort((a,b) => {
    if (a.visited !== b.visited) return a.visited ? 1 : -1;
    return b.score - a.score;
  });

  return uniq.slice(0, 25);
}

/** “Cosa vedere” vicino alla meta */
function buildThingsToSeeQuery(lat, lon) {
  const R = 7000;
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

    let p = 0;
    if (t.tourism === "museum" || t.tourism === "attraction" || t.tourism === "viewpoint") p += 4;
    if (t.natural) p += 3;
    if (t.historic) p += 2;
    if (t.leisure === "park" || t.leisure === "garden") p += 1;
    if (t.wikipedia) p += 2;
    if (t.wikidata) p += 1;

    return { name, lat: n.lat, lon: n.lon, priority: p };
  }).filter(Boolean);

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

/** Stima minuti coerente (veloce, senza prezzi) */
function estimateTravelMinutes(mode, distKm) {
  const speed = { car: 70, bike: 16, walk: 4.5 }[mode] || 60;
  const roadFactor = mode === "car" ? 1.25 : mode === "bike" ? 1.15 : 1.10;
  const hours = (distKm * roadFactor) / speed;
  return Math.max(10, Math.round(hours * 60));
}

/** ORS spesso limita isochrones a 3600s: clamp */
function clampSecondsForORS(seconds) {
  return Math.min(seconds, 3600);
}

/** Crea sezione “Cosa vedere” se manca nel tuo HTML */
function ensureThingsSection() {
  const result = $("result");
  if (!result) return;

  let sec = $("thingsSection");
  if (sec) return;

  sec = document.createElement("div");
  sec.id = "thingsSection";
  sec.style.marginTop = "14px";
  sec.innerHTML = `
    <div style="font-weight:800; font-size:18px; margin:10px 0 8px">Cosa vedere lì</div>
    <div id="thingsList"></div>
  `;

  // Inseriscilo prima del blocco Alternative, così resta ordinato
  const altsBlock = result.querySelector(".alts");
  if (altsBlock) result.insertBefore(sec, altsBlock);
  else result.appendChild(sec);
}

function renderAltItem(d, minutes) {
  const link = toGoogleMapsLink(d.lat, d.lon, d.name);
  return `
    <div class="alt-item">
      <div class="name">${d.name}</div>
      <div class="meta">⏱️ ~${minutes} min · 📍 ${d.distKm} km</div>
      <a class="linkbtn" href="${link}" target="_blank" rel="noopener">Apri su Maps</a>
    </div>
  `;
}

function renderThingsList(things) {
  const el = $("thingsList");
  if (!el) return;
  if (!things.length) {
    el.innerHTML = `<div style="color:rgba(160,178,186,.9)">Niente di rilevante trovato nelle vicinanze (OSM). Riprova o cambia meta.</div>`;
    return;
  }
  el.innerHTML = things.map(t => `
    <div class="alt-item">
      <div class="name">${t.name}</div>
      <a class="linkbtn" href="${toGoogleMapsLink(t.lat,t.lon,t.name)}" target="_blank" rel="noopener">Apri</a>
    </div>
  `).join("");
}

/** ===== MAIN ===== */
async function runJamo() {
  const btn = $("goBtn");
  try {
    btn && (btn.disabled = true);
    showResult(false);
    setStatus("📍 Sto prendendo la posizione…");

    const origin = await getUserLocation();

    const minutes = parseInt($("timeSelect")?.value || "60", 10);
    const totalSeconds = minutes * 60;

    const modeSel = $("modeSelect")?.value || "car";
    const orsProfile = modeSel === "car" ? "driving-car" : modeSel === "bike" ? "cycling-regular" : "foot-walking";
    const modeLabel = modeSel === "car" ? "Auto" : modeSel === "bike" ? "Bici" : "A piedi";

    // 1) Isochrone clamp per evitare errori tipo "range out of range"
    const orsSeconds = clampSecondsForORS(totalSeconds);

    setStatus(`🧠 Calcolo area raggiungibile (${modeLabel})…`);
    const iso = await fetchIsochroneGeoJSON({
      lat: origin.lat, lon: origin.lon, mode: orsProfile, seconds: orsSeconds
    });

    let bbox = bboxFromGeoJSON(iso);

    // se utente chiede più di 1h, espandi bbox (moderato per non far esplodere Overpass)
    if (totalSeconds > orsSeconds) {
      const factor = modeSel === "car" ? 2.2 : modeSel === "bike" ? 1.45 : 1.35;
      bbox = expandBbox(bbox, factor);
    }

    // 2) Query mete “sensate”
    setStatus("🔎 Cerco mete reali e interessanti (non posti a caso)…");
    const q = buildDestinationsQueryFromBbox(bbox);
    let destJson = await overpassQuery(q);
    let dests = normalizeDestinations(destJson, origin);

    // fallback se poche mete
    if (dests.length < 6) {
      const bbox2 = expandBbox(bbox, modeSel === "car" ? 1.35 : 1.18);
      const q2 = buildDestinationsQueryFromBbox(bbox2);
      destJson = await overpassQuery(q2);
      dests = normalizeDestinations(destJson, origin);
    }

    if (!dests.length) {
      setStatus("❌ Non ho trovato mete “note” in quest’area. Aumenta il tempo o usa Auto.", "err");
      return;
    }

    // 3) Selezione meta + alternative
    const main = dests[0];
    const alternatives = dests.slice(1, 4);

    const estMin = estimateTravelMinutes(modeSel, main.distKm);

    $("placeName").textContent = main.name;

    const wikiBadge = (main.tags.wikipedia || main.tags.wikidata) ? " · 📚 luogo noto" : "";
    $("placeMeta").textContent = `⏱️ ~${estMin} min · 📍 ${main.distKm} km (aria) · ${modeLabel}${wikiBadge}`;

    const maps = $("mapsLink");
    if (maps) maps.href = toGoogleMapsLink(main.lat, main.lon, main.name);

    // visited toggle
    const visitedBtn = $("visitedBtn");
    const visited = getVisitedSet();
    const isVisited = visited.has(main.idKey);

    if (visitedBtn) {
      visitedBtn.textContent = isVisited ? "✅ Già visitato (tocca per annullare)" : "✅ Segna come “già visitato”";
      visitedBtn.onclick = () => {
        const v = getVisitedSet();
        const nowVisited = v.has(main.idKey);
        if (nowVisited) v.delete(main.idKey);
        else v.add(main.idKey);
        saveVisitedSet(v);
        const after = v.has(main.idKey);
        visitedBtn.textContent = after ? "✅ Già visitato (tocca per annullare)" : "✅ Segna come “già visitato”";
        setStatus(after ? "Salvato: verrà evitato nelle prossime proposte." : "Ok: rimosso dai visitati.", "ok");
      };
    }

    // alternatives UI
    const altList = $("altList");
    if (altList) {
      altList.innerHTML = alternatives.map(d => renderAltItem(d, estimateTravelMinutes(modeSel, d.distKm))).join("");
    }

    // show result
    showResult(true);
    setStatus("✅ Fatto. Se vuoi, ripremi per un’altra proposta.", "ok");

    // 4) Cosa vedere lì
    ensureThingsSection();
    setStatus(`✨ Cerco cosa vedere a ${main.name}… (OSM)`);
    const tq = buildThingsToSeeQuery(main.lat, main.lon);
    const thingJson = await overpassQuery(tq);
    const things = normalizeThings(thingJson);
    renderThingsList(things);
    setStatus("✅ Pronto: meta + cosa vedere.", "ok");

  } catch (e) {
    const msg = e?.message ? e.message : String(e);

    // error friendly: evidenzia Overpass
    if (/Overpass/i.test(msg) || /504/.test(msg)) {
      setStatus("❌ Overpass è occupato (server OSM). Riprova tra 10–20 secondi.", "err");
    } else {
      setStatus(`❌ Errore: ${msg}`, "err");
    }
    showResult(false);
  } finally {
    const btn = $("goBtn");
    btn && (btn.disabled = false);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const btn = $("goBtn");
  if (btn) btn.addEventListener("click", runJamo);
  setStatus("Pronto. Premi il bottone: Jamo userà il GPS.");
});
