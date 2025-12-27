/* Jamo - app.js (v2.1)
   - Default: luoghi conosciuti (wiki/wikidata + città/town)
   - Chicche: meno noti ma validati con POI (cosa vedere)
   - POI sempre (main + alternatives)
   - ORS isochrone via /api/isochrone (POST) solo fino a 60min, altrimenti fallback
   - ORS directions via /api/directions (POST) per ETA più precisa (se disponibile)
*/

const UI = {
  timeSelect: document.getElementById("timeSelect"),
  modeSelect: document.getElementById("modeSelect"),
  styleSelect: document.getElementById("styleSelect"),
  goBtn: document.getElementById("goBtn"),
  status: document.getElementById("status"),
  result: document.getElementById("result"),
  placeName: document.getElementById("placeName"),
  placeMeta: document.getElementById("placeMeta"),
  mapsLink: document.getElementById("mapsLink"),
  visitedBtn: document.getElementById("visitedBtn"),
  altList: document.getElementById("altList"),
  footerInfo: document.getElementById("footerInfo"),
};

const APP_VERSION = "2.1";
const VISITED_KEY = "jamo_visited_v1";

// Overpass endpoints fallback
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];

// ORS constraints (common on free keys)
const ORS_MAX_RANGE_SEC = 3600;

const MODE_TO_ORS_PROFILE = {
  car: "driving-car",
  walk: "foot-walking",
  bike: "cycling-regular",
};

const MODE_LABEL = {
  car: "Auto",
  walk: "A piedi",
  bike: "Bici",
};

// fallback speed (km/h)
const MODE_SPEED_KMH = {
  car: 65,
  walk: 4.5,
  bike: 16,
};

function setStatus(msg, type = "") {
  UI.status.textContent = msg;
  UI.status.className = "status" + (type ? " " + type : "");
}

function showResult(show) {
  UI.result.classList.toggle("hidden", !show);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[m]));
}

function fmtMinutes(min) {
  if (!isFinite(min)) return "—";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

function formatDistanceKm(meters) {
  const km = meters / 1000;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

function googleMapsLink(lat, lon, label) {
  const q = encodeURIComponent(label ? `${label} (${lat},${lon})` : `${lat},${lon}`);
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const toRad = (x) => (x * Math.PI) / 180;
  const a =
    Math.sin((toRad(lat2 - lat1)) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin((toRad(lon2 - lon1)) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------------- Visited ----------------
function loadVisitedSet() {
  try {
    const raw = localStorage.getItem(VISITED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveVisitedSet(set) {
  try { localStorage.setItem(VISITED_KEY, JSON.stringify([...set])); } catch {}
}

function placeId(p) {
  return `${p.osmType}:${p.osmId}`;
}

// ---------------- Fetch helpers ----------------
async function fetchJson(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const txt = await res.text();
    let data;
    try { data = JSON.parse(txt); } catch { data = txt; }

    if (!res.ok) {
      const err = new Error(typeof data === "string" ? data : JSON.stringify(data));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

async function overpassQuery(query) {
  let lastErr = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const data = await fetchJson(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: "data=" + encodeURIComponent(query),
      }, 25000);
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Overpass failed");
}

// ---------------- GPS ----------------
function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocalizzazione non supportata"));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        acc: pos.coords.accuracy,
      }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  });
}

// ---------------- ORS via Vercel API ----------------
async function getIsochroneORS({ lat, lon, mode, minutes }) {
  const profile = MODE_TO_ORS_PROFILE[mode] || "driving-car";
  const seconds = Math.round(minutes * 60);
  const payload = {
    profile,
    locations: [[lon, lat]],
    range: [seconds],
  };
  return fetchJson("/api/isochrone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, 25000);
}

async function getDirectionsDurationSec({ from, to, mode }) {
  const profile = MODE_TO_ORS_PROFILE[mode] || "driving-car";
  try {
    const data = await fetchJson("/api/directions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile,
        coordinates: [
          [from.lon, from.lat],
          [to.lon, to.lat],
        ],
      }),
    }, 25000);

    const sec = data?.features?.[0]?.properties?.summary?.duration;
    return (typeof sec === "number" && isFinite(sec)) ? sec : null;
  } catch {
    return null;
  }
}

// ---------------- Isochrone helpers ----------------
function bboxFromGeoJSON(geojson) {
  const feat = geojson?.features?.[0];
  const geom = feat?.geometry;
  if (!geom) return null;

  const coords = geom.type === "Polygon"
    ? geom.coordinates
    : (geom.type === "MultiPolygon" ? geom.coordinates.flat() : null);

  if (!coords) return null;

  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const ring of coords) {
    for (const [lon, lat] of ring) {
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
    }
  }
  return { minLat, minLon, maxLat, maxLon };
}

function fallbackRadiusMeters(mode, minutes) {
  const km = (MODE_SPEED_KMH[mode] || 50) * (minutes / 60);
  const networkFactor = mode === "car" ? 0.62 : mode === "bike" ? 0.70 : 0.78;
  return Math.max(1500, km * 1000 * networkFactor);
}

// ---------------- Places (luoghi) ----------------
function isPlaceElement(el) {
  const place = el.tags?.place;
  if (!place) return false;
  return ["city", "town", "village", "hamlet", "suburb", "neighbourhood"].includes(place);
}

function elementToPlace(el) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags["int_name"];
  if (!name) return null;

  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return null;

  const pop = parseInt(tags.population || "0", 10);
  const isFamous = Boolean(tags.wikipedia || tags.wikidata);

  return {
    osmType: el.type,
    osmId: el.id,
    name,
    lat,
    lon,
    place: tags.place,
    population: Number.isFinite(pop) ? pop : 0,
    isFamous,
    tags,
  };
}

function dedupePlaces(arr) {
  const seen = new Set();
  const out = [];
  for (const p of arr) {
    const key = `${p.name.toLowerCase()}_${Math.round(p.lat*1000)}_${Math.round(p.lon*1000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function scorePlace(p, origin, style) {
  const d = haversineMeters(origin.lat, origin.lon, p.lat, p.lon);

  const famousBonus = p.isFamous ? 80 : 0;
  const pop = p.population || 0;
  const popBonus = Math.min(40, Math.log10(pop + 10) * 12);
  const tooClosePenalty = d < 3500 ? 45 : 0;
  const noise = Math.random() * 10;

  let styleBias = 0;
  if (style === "famous") styleBias = famousBonus + 8;       // spinge forte i noti
  if (style === "hidden") styleBias = p.isFamous ? -55 : 18; // penalizza noti, premia chicche
  if (style === "mix") styleBias = p.isFamous ? 30 : 12;

  return (famousBonus + popBonus + styleBias) - tooClosePenalty + noise;
}

function pickMainAndAlternatives(candidates, origin, visitedSet, style) {
  const filtered = candidates.filter(p => !visitedSet.has(placeId(p)));
  const pool = filtered.length ? filtered : candidates;

  const ranked = pool
    .map(p => ({ p, score: scorePlace(p, origin, style) }))
    .sort((a, b) => b.score - a.score)
    .map(x => x.p);

  const main = ranked[0] || null;
  const alts = ranked.slice(1, 4);
  return { main, alts };
}

// ---------------- POI (cosa vedere/fare) ----------------
function classifyPoi(tags) {
  const t = tags || {};
  if (t.tourism === "museum") return 9;
  if (t.historic) return 8;
  if (t.tourism === "attraction") return 7;
  if (t.natural) return 7;
  if (t.leisure) return 6;
  if (t.tourism) return 5;
  return 3;
}

async function getThingsToDo(lat, lon) {
  const radius = 6000;

  const query = `
  [out:json][timeout:18];
  (
    node(around:${radius},${lat},${lon})["tourism"];
    node(around:${radius},${lat},${lon})["historic"];
    node(around:${radius},${lat},${lon})["natural"];
    node(around:${radius},${lat},${lon})["leisure"];
    way(around:${radius},${lat},${lon})["tourism"];
    way(around:${radius},${lat},${lon})["historic"];
    way(around:${radius},${lat},${lon})["natural"];
    way(around:${radius},${lat},${lon})["leisure"];
    relation(around:${radius},${lat},${lon})["tourism"];
    relation(around:${radius},${lat},${lon})["historic"];
    relation(around:${radius},${lat},${lon})["natural"];
  );
  out tags center 80;
  `;

  const data = await overpassQuery(query);
  const els = data?.elements || [];

  const list = [];
  for (const el of els) {
    const tags = el.tags || {};
    const name = tags.name || tags["name:it"] || tags["int_name"];
    if (!name) continue;

    const lat2 = el.lat ?? el.center?.lat;
    const lon2 = el.lon ?? el.center?.lon;
    if (typeof lat2 !== "number" || typeof lon2 !== "number") continue;

    list.push({
      name,
      rank: classifyPoi(tags),
      dist: haversineMeters(lat, lon, lat2, lon2),
    });
  }

  list.sort((a, b) => (b.rank - a.rank) || (a.dist - b.dist));

  // dedupe by name
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const k = p.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
    if (out.length >= 8) break;
  }
  return out;
}

// ---------------- Find places flow ----------------
async function findPlaces({ origin, mode, minutes, style }) {
  const visited = loadVisitedSet();
  let candidates = [];
  let used = "RADIUS_FALLBACK";

  const seconds = Math.round(minutes * 60);

  // 1) ORS isochrone solo se <= 60 min
  if (seconds <= ORS_MAX_RANGE_SEC) {
    try {
      used = "ORS_ISOCHRONE";
      const geo = await getIsochroneORS({ lat: origin.lat, lon: origin.lon, mode, minutes });
      const bbox = bboxFromGeoJSON(geo);
      if (!bbox) throw new Error("No bbox");

      const query = `
      [out:json][timeout:22];
      (
        node(${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon})["place"~"city|town|village|hamlet|suburb|neighbourhood"];
        way(${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon})["place"~"city|town|village|hamlet|suburb|neighbourhood"];
        relation(${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon})["place"~"city|town|village|hamlet|suburb|neighbourhood"];
      );
      out tags center 140;
      `;

      const data = await overpassQuery(query);
      candidates = (data?.elements || [])
        .filter(isPlaceElement)
        .map(elementToPlace)
        .filter(Boolean);

    } catch {
      used = "RADIUS_FALLBACK";
      candidates = [];
    }
  }

  // 2) fallback radius
  if (!candidates.length) {
    const r = fallbackRadiusMeters(mode, minutes);
    const query = `
    [out:json][timeout:22];
    (
      node(around:${Math.round(r)},${origin.lat},${origin.lon})["place"~"city|town|village|hamlet|suburb|neighbourhood"];
      way(around:${Math.round(r)},${origin.lat},${origin.lon})["place"~"city|town|village|hamlet|suburb|neighbourhood"];
      relation(around:${Math.round(r)},${origin.lat},${origin.lon})["place"~"city|town|village|hamlet|suburb|neighbourhood"];
    );
    out tags center 160;
    `;

    const data = await overpassQuery(query);
    candidates = (data?.elements || [])
      .filter(isPlaceElement)
      .map(elementToPlace)
      .filter(Boolean);
  }

  candidates = dedupePlaces(candidates).slice(0, 90);

  // 3) Filtro qualità chicche/mix: per i non famosi, deve esserci almeno 2 POI (best effort)
  if (style === "hidden" || style === "mix") {
    const sample = candidates.slice(0, 28);
    const checked = [];
    for (const p of sample) {
      if (p.isFamous) { checked.push(p); continue; }
      try {
        const pois = await getThingsToDo(p.lat, p.lon);
        if (pois.length >= 2) checked.push(p);
      } catch {
        checked.push(p);
      }
    }
    if (checked.length >= 8) candidates = checked;
  }

  const { main, alts } = pickMainAndAlternatives(candidates, origin, visited, style);
  return { used, main, alts, visited };
}

// ---------------- Rendering ----------------
async function renderMain(main, origin, mode, minutes, used, style, visitedSet) {
  if (!main) {
    showResult(false);
    setStatus("❌ Non trovo mete. Prova a cambiare tempo o mezzo e riprova.", "err");
    return;
  }

  showResult(true);

  const d = haversineMeters(origin.lat, origin.lon, main.lat, main.lon);

  // ETA: directions ORS (se disponibile), altrimenti stima
  let etaMin = null;
  const sec = await getDirectionsDurationSec({ from: origin, to: main, mode });
  if (typeof sec === "number") etaMin = sec / 60;
  else {
    const speed = MODE_SPEED_KMH[mode] || 50;
    const factor = mode === "car" ? 1.25 : mode === "bike" ? 1.18 : 1.10;
    etaMin = (d / 1000) / speed * 60 * factor;
  }

  UI.placeName.textContent = main.name;
  UI.mapsLink.href = googleMapsLink(main.lat, main.lon, main.name);

  const famous = main.isFamous ? "⭐ famoso" : "✨ chicca";
  const within = etaMin <= minutes + 10 ? "✅" : "⚠️";
  UI.placeMeta.textContent =
    `${within} ${famous}\nTipo: ${main.place}\nDistanza ~ ${formatDistanceKm(d)}\nTempo stimato: ${fmtMinutes(etaMin)} (tempo scelto: ${fmtMinutes(minutes)})`;

  // visited btn toggle
  const id = placeId(main);
  const already = visitedSet.has(id);
  UI.visitedBtn.textContent = already ? "✅ Già visitato (clicca per togliere)" : "✅ Segna come “già visitato”";
  UI.visitedBtn.onclick = () => {
    const v = loadVisitedSet();
    if (v.has(id)) v.delete(id); else v.add(id);
    saveVisitedSet(v);
    const now = v.has(id);
    UI.visitedBtn.textContent = now ? "✅ Già visitato (clicca per togliere)" : "✅ Segna come “già visitato”";
    setStatus(now ? "Salvato: verrà evitato in futuro." : "Ok: rimosso dai visitati.", "ok");
  };

  // POI main
  setStatus(`✅ Trovato: ${main.name}\nCarico “cosa vedere”…`, "ok");
  try {
    const pois = await getThingsToDo(main.lat, main.lon);
    if (pois.length) {
      UI.placeMeta.textContent += `\n\nCosa vedere / fare:\n` + pois.slice(0, 6).map(p => `• ${p.name}`).join("\n");
    } else {
      UI.placeMeta.textContent += `\n\nCosa vedere / fare:\n• Centro storico\n• Passeggiata / belvedere\n• Bar / piazza principale`;
    }
  } catch {
    UI.placeMeta.textContent += `\n\nCosa vedere / fare:\n• Centro storico\n• Passeggiata / belvedere\n• Bar / piazza principale`;
  }

  const styleLabel = style === "famous" ? "Famosi" : style === "mix" ? "Mix" : "Chicche";
  UI.footerInfo.textContent = `Versione ${APP_VERSION} • ${MODE_LABEL[mode]} • ${styleLabel} • ${used}`;
}

async function renderAlternatives(alts, origin) {
  UI.altList.innerHTML = "";
  if (!alts || !alts.length) {
    UI.altList.innerHTML = `<div class="alt-item">Nessuna alternativa trovata.</div>`;
    return;
  }

  for (let i = 0; i < alts.length; i++) {
    const a = alts[i];
    const d = haversineMeters(origin.lat, origin.lon, a.lat, a.lon);

    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `
      <div class="name">${escapeHtml(a.name)} ${a.isFamous ? "⭐" : "✨"}</div>
      <div class="mini">Tipo: ${escapeHtml(a.place)} • distanza ~ ${formatDistanceKm(d)}</div>
      <div style="margin-top:8px">
        <a class="linkbtn" href="${googleMapsLink(a.lat, a.lon, a.name)}" target="_blank" rel="noopener">Apri</a>
      </div>
      <div id="altPoi${i}" class="mini" style="margin-top:10px">Carico cosa vedere…</div>
    `;

    UI.altList.appendChild(div);

    // POI per alternative (solo top 3, best effort)
    try {
      const pois = await getThingsToDo(a.lat, a.lon);
      const el = document.getElementById(`altPoi${i}`);
      if (el) {
        if (pois.length) {
          el.innerHTML = `<b>Cosa vedere:</b><br>` + pois.slice(0, 3).map(p => `• ${escapeHtml(p.name)}`).join("<br>");
        } else {
          el.textContent = "Cosa vedere: centro / belvedere / passeggiata.";
        }
      }
    } catch {
      const el = document.getElementById(`altPoi${i}`);
      if (el) el.textContent = "Cosa vedere: (non disponibile ora, riprova).";
    }
  }
}

// ---------------- Main button ----------------
UI.goBtn.addEventListener("click", async () => {
  UI.goBtn.disabled = true;
  showResult(false);

  const minutes = parseInt(UI.timeSelect.value, 10) || 60;
  const mode = UI.modeSelect.value || "car";
  const style = UI.styleSelect ? UI.styleSelect.value : "famous";

  setStatus("📍 Prendo la posizione GPS…");

  try {
    const origin = await getCurrentPosition();
    setStatus("🔎 Cerco mete reali (OSM)…");

    const { used, main, alts, visited } = await findPlaces({ origin, mode, minutes, style });

    await renderMain(main, origin, mode, minutes, used, style, visited);
    await renderAlternatives(alts, origin);

    setStatus("✅ Fatto. Premi di nuovo per un’altra idea.", "ok");
  } catch (e) {
    const msg = e?.data?.error || e?.message || String(e);
    setStatus(`❌ Errore: ${msg}`, "err");
  } finally {
    UI.goBtn.disabled = false;
  }
});

// init
setStatus("Pronto. Premi il bottone: Jamo userà il GPS.");
UI.footerInfo.textContent = `Versione ${APP_VERSION} • Luoghi (OSM) + POI • ORS quando possibile`;
