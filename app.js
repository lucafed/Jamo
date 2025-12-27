/* Jamo - app.js (v2)
   - GPS -> isochrone via /api/isochrone (ORS)
   - fallback Overpass radius-based when ORS limit/errors or >60min
   - place suggestions (city/town/village/hamlet/suburb)
   - prioritizes famous places (wikipedia/wikidata)
   - visited toggle stored in localStorage
   - shows alternatives + "cosa vedere lì"
*/

const UI = {
  timeSelect: document.getElementById("timeSelect"),
  modeSelect: document.getElementById("modeSelect"),
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

const VERSION = "2.1";
const VISITED_KEY = "jamo_visited_places_v1";

// Overpass endpoints (fallback if one is slow)
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];

// ORS supports these profiles for isochrones
function orsProfileForMode(mode) {
  // UI values: car, walk, bike
  if (mode === "car") return "driving-car";
  if (mode === "walk") return "foot-walking";
  if (mode === "bike") return "cycling-regular";
  return "driving-car";
}

// Fallback speed (km/h) for plausible radius when ORS not available / >60min
function speedForMode(mode) {
  if (mode === "car") return 70;   // average mixed roads
  if (mode === "bike") return 15;
  if (mode === "walk") return 5;
  return 60;
}

// Convert minutes -> radius meters (fallback)
function radiusMetersFallback(mode, minutes) {
  const km = (speedForMode(mode) * (minutes / 60));
  return Math.max(1000, Math.round(km * 1000));
}

function setStatus(text, type = "") {
  UI.status.classList.remove("err", "ok");
  if (type === "err") UI.status.classList.add("err");
  if (type === "ok") UI.status.classList.add("ok");
  UI.status.textContent = text;
}

function showResult(show) {
  UI.result.classList.toggle("hidden", !show);
}

function getVisitedSet() {
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
  localStorage.setItem(VISITED_KEY, JSON.stringify([...set]));
}

// Stable ID for a place
function placeId(p) {
  // Overpass elements have: type + id, OR sometimes "osm_id"
  return p?.idKey || `${p.type || "node"}:${p.id || p.osm_id || p.name || Math.random()}`;
}

function formatDistanceKm(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km`;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function googleMapsLink(lat, lon, name = "") {
  const q = encodeURIComponent(name ? `${name}` : `${lat},${lon}`);
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

// --- Fetch helpers with timeout ---
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const r = await fetchWithTimeout(url, options, timeoutMs);
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Bad JSON: ${text.slice(0, 400)}`);
  }
}

// --- GPS ---
function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("GPS non supportato dal browser."));
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 60000
    });
  });
}

// --- ORS Isochrone via Vercel API ---
async function getIsochroneGeoJSON({ lat, lon, mode, minutes }) {
  const profile = orsProfileForMode(mode);
  const r = await fetch("/api/isochrone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile, minutes, lat, lon, rangeType: "time" })
  });

  const txt = await r.text();
  if (!r.ok) {
    // Make it readable
    throw new Error(`Isochrone API error (${r.status}): ${txt.slice(0, 400)}`);
  }
  return JSON.parse(txt);
}

// --- Overpass queries ---
function buildOverpassPlacesInBBoxQuery(bbox) {
  // bbox: [south, west, north, east]
  const [s, w, n, e] = bbox;
  // Places, not attractions.
  // We prioritize famous ones later, but we fetch all place types.
  return `
    [out:json][timeout:25];
    (
      node["place"~"^(city|town|village|hamlet|suburb)$"](${s},${w},${n},${e});
      way["place"~"^(city|town|village|hamlet|suburb)$"](${s},${w},${n},${e});
      relation["place"~"^(city|town|village|hamlet|suburb)$"](${s},${w},${n},${e});
    );
    out center tags;
  `;
}

function buildOverpassPlacesAroundQuery(lat, lon, radiusMeters) {
  return `
    [out:json][timeout:25];
    (
      node["place"~"^(city|town|village|hamlet|suburb)$"](around:${radiusMeters},${lat},${lon});
      way["place"~"^(city|town|village|hamlet|suburb)$"](around:${radiusMeters},${lat},${lon});
      relation["place"~"^(city|town|village|hamlet|suburb)$"](around:${radiusMeters},${lat},${lon});
    );
    out center tags;
  `;
}

function buildOverpassThingsToDoAroundQuery(lat, lon, radiusMeters = 4000) {
  // “cosa vedere/fare” (POI): tourism/historic/natural + viewpoints + museums
  return `
    [out:json][timeout:25];
    (
      node["tourism"~"^(attraction|museum|viewpoint)$"](around:${radiusMeters},${lat},${lon});
      way["tourism"~"^(attraction|museum|viewpoint)$"](around:${radiusMeters},${lat},${lon});
      relation["tourism"~"^(attraction|museum|viewpoint)$"](around:${radiusMeters},${lat},${lon});

      node["historic"](around:${radiusMeters},${lat},${lon});
      way["historic"](around:${radiusMeters},${lat},${lon});
      relation["historic"](around:${radiusMeters},${lat},${lon});

      node["natural"~"^(peak|waterfall|spring|cave)$"](around:${radiusMeters},${lat},${lon});
      way["natural"~"^(peak|waterfall|spring|cave)$"](around:${radiusMeters},${lat},${lon});
      relation["natural"~"^(peak|waterfall|spring|cave)$"](around:${radiusMeters},${lat},${lon});
    );
    out center tags;
  `;
}

function elementToPlace(el) {
  const tags = el.tags || {};
  const name = tags.name || tags["name:it"] || tags["name:en"] || null;

  // center for ways/relations
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;

  if (!name || typeof lat !== "number" || typeof lon !== "number") return null;

  const isFamous = Boolean(tags.wikipedia || tags.wikidata);
  const population = tags.population ? parseInt(String(tags.population).replace(/\D/g, ""), 10) : 0;

  return {
    id: el.id,
    type: el.type,
    idKey: `${el.type}:${el.id}`,
    name,
    place: tags.place || "",
    lat,
    lon,
    tags,
    isFamous,
    population: Number.isFinite(population) ? population : 0,
  };
}

async function overpassRequest(query) {
  // Try endpoints one by one
  let lastErr = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const body = new URLSearchParams({ data: query });
      const r = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: body.toString(),
      }, 20000);

      const text = await r.text();
      if (!r.ok) throw new Error(`Overpass ${r.status}: ${text.slice(0, 200)}`);

      const json = JSON.parse(text);
      return json;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Overpass error");
}

// --- Isochrone geometry -> bbox ---
function bboxFromGeoJSON(geojson) {
  // expects FeatureCollection with Polygon/MultiPolygon in features[0].geometry
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
  return [minLat, minLon, maxLat, maxLon]; // [south, west, north, east]
}

// --- Pick best places ---
function scorePlace(p, origin) {
  // We want: famous + bigger + not too close + not too far
  const d = haversineMeters(origin.lat, origin.lon, p.lat, p.lon);
  const famousBonus = p.isFamous ? 50 : 0;
  const popBonus = Math.min(50, Math.log10((p.population || 1) + 1) * 12); // soft
  const distancePenalty = d < 3000 ? 30 : 0; // avoid super-near
  const nameLenPenalty = p.name.length < 3 ? 10 : 0;

  // small noise so it feels “random” but stable-ish
  const noise = Math.random() * 10;

  return famousBonus + popBonus - distancePenalty - nameLenPenalty + noise;
}

function pickMainAndAlternatives(candidates, origin, visitedSet, takeMain = 1, takeAlt = 3) {
  // filter visited
  const filtered = candidates.filter(p => !visitedSet.has(placeId(p)));

  // If everything visited, allow repeats but mark them
  const pool = filtered.length ? filtered : candidates;

  // Score + sort desc
  const ranked = pool
    .map(p => ({ p, score: scorePlace(p, origin) }))
    .sort((a, b) => b.score - a.score)
    .map(x => x.p);

  const main = ranked.slice(0, takeMain);
  const alts = ranked.slice(takeMain, takeMain + takeAlt);

  return { main: main[0] || null, alts };
}

function dedupePlaces(list) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    const key = placeId(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// --- "Cosa vedere lì" ---
function poiLabel(tags) {
  const n = tags.name || tags["name:it"] || tags["name:en"];
  if (!n) return null;

  if (tags.tourism) return `${n} (tourism: ${tags.tourism})`;
  if (tags.historic) return `${n} (storico)`;
  if (tags.natural) return `${n} (natura: ${tags.natural})`;
  return n;
}

async function getThingsToDo(placeLat, placeLon) {
  const q = buildOverpassThingsToDoAroundQuery(placeLat, placeLon, 5000);
  const json = await overpassRequest(q);

  const items = (json.elements || [])
    .map(el => {
      const tags = el.tags || {};
      const name = tags.name || tags["name:it"] || tags["name:en"];
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (!name || typeof lat !== "number" || typeof lon !== "number") return null;

      const isNice = Boolean(tags.wikipedia || tags.wikidata) ? 1 : 0;
      const score = isNice * 2 + (tags.tourism ? 1 : 0) + (tags.historic ? 1 : 0) + (tags.natural ? 1 : 0);

      return {
        name,
        lat,
        lon,
        label: poiLabel(tags),
        score,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.score - a.score));

  // dedupe by name
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = it.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
    if (out.length >= 6) break;
  }
  return out;
}

// --- Main flow ---
async function findPlaces({ origin, mode, minutes }) {
  const visited = getVisitedSet();

  // 1) Try ORS isochrone (only works reliably for <=60 min on many free keys)
  let geo = null;
  let used = "ORS";
  try {
    geo = await getIsochroneGeoJSON({ lat: origin.lat, lon: origin.lon, mode, minutes });
  } catch (e) {
    used = "FALLBACK";
  }

  // If ORS ok but bbox fails, fallback
  let candidates = [];
  if (geo) {
    const bbox = bboxFromGeoJSON(geo);
    if (!bbox) {
      used = "FALLBACK";
    } else {
      // Fetch places within bbox (fast)
      try {
        const q = buildOverpassPlacesInBBoxQuery(bbox);
        const json = await overpassRequest(q);
        candidates = (json.elements || []).map(elementToPlace).filter(Boolean);
      } catch (e) {
        used = "FALLBACK";
      }
    }
  }

  // 2) Fallback: radius around origin based on speed
  if (!candidates.length) {
    const radius = radiusMetersFallback(mode, minutes);
    const q = buildOverpassPlacesAroundQuery(origin.lat, origin.lon, radius);
    const json = await overpassRequest(q);
    candidates = (json.elements || []).map(elementToPlace).filter(Boolean);
    used = "OVERPASS_RADIUS";
  }

  candidates = dedupePlaces(candidates);

  // If still nothing, widen a bit
  if (!candidates.length) {
    const radius = Math.round(radiusMetersFallback(mode, minutes) * 1.5);
    const q = buildOverpassPlacesAroundQuery(origin.lat, origin.lon, radius);
    const json = await overpassRequest(q);
    candidates = (json.elements || []).map(elementToPlace).filter(Boolean);
    candidates = dedupePlaces(candidates);
    used = "OVERPASS_RADIUS_WIDE";
  }

  if (!candidates.length) {
    return { used, main: null, alts: [], visited };
  }

  const { main, alts } = pickMainAndAlternatives(candidates, origin, visited, 1, 3);

  return { used, main, alts, visited };
}

function renderAlternatives(alts, origin) {
  UI.altList.innerHTML = "";
  if (!alts.length) {
    UI.altList.innerHTML = `<div class="alt-item">Nessuna alternativa trovata.</div>`;
    return;
  }

  for (const a of alts) {
    const d = haversineMeters(origin.lat, origin.lon, a.lat, a.lon);
    const div = document.createElement("div");
    div.className = "alt-item";
    div.innerHTML = `
      <div class="name">${escapeHtml(a.name)}</div>
      <div style="color: var(--muted); font-size: 13px; margin-top:4px">
        Tipo: ${escapeHtml(a.place || "place")} • distanza ~ ${formatDistanceKm(d)}
      </div>
      <div style="margin-top:8px">
        <a class="linkbtn" href="${googleMapsLink(a.lat, a.lon, a.name)}" target="_blank" rel="noopener">Apri</a>
      </div>
    `;
    UI.altList.appendChild(div);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;"
  }[m]));
}

async function renderMain(main, origin, mode, minutes, used, visitedSet) {
  if (!main) {
    showResult(false);
    setStatus("Non ho trovato luoghi. Prova ad aumentare il tempo o riprova tra poco.", "err");
    UI.footerInfo.textContent = `Versione ${VERSION} • ${mode.toUpperCase()} • ${used}`;
    return;
  }

  showResult(true);

  const d = haversineMeters(origin.lat, origin.lon, main.lat, main.lon);

  UI.placeName.textContent = main.name;
  UI.placeMeta.textContent =
    `Tipo: ${main.place || "place"} • distanza ~ ${formatDistanceKm(d)} • tempo selezionato: ${minutes} min`;

  UI.mapsLink.href = googleMapsLink(main.lat, main.lon, main.name);

  // visited button state
  const id = placeId(main);
  const already = visitedSet.has(id);
  UI.visitedBtn.textContent = already ? "✅ Già visitato (clicca per annullare)" : "✅ Segna come “già visitato”";

  UI.visitedBtn.onclick = () => {
    const set = getVisitedSet();
    if (set.has(id)) set.delete(id);
    else set.add(id);
    saveVisitedSet(set);

    const now = set.has(id);
    UI.visitedBtn.textContent = now ? "✅ Già visitato (clicca per annullare)" : "✅ Segna come “già visitato”";
  };

  // Things to do (best-effort)
  const base = `Trovato con: ${used}`;
  setStatus(`Ok. ${base}\nCarico anche “cosa vedere lì”…`, "ok");

  try {
    const pois = await getThingsToDo(main.lat, main.lon);

    // add under meta (append)
    if (pois.length) {
      const lines = pois
        .slice(0, 6)
        .map(p => `• ${p.label || p.name}`)
        .join("\n");
      setStatus(`Ok. ${base}\nCosa vedere lì (≈5 km):\n${lines}`, "ok");
    } else {
      setStatus(`Ok. ${base}\nNon ho trovato POI vicini in OSM (può capitare).`, "ok");
    }
  } catch (e) {
    setStatus(`Ok. ${base}\nPOI non disponibili ora (Overpass lento).`, "ok");
  }

  UI.footerInfo.textContent = `Versione ${VERSION} • Luoghi reali (OSM) • Mezzo: ${mode} • ${used}`;
}

// --- UI handler ---
UI.goBtn.addEventListener("click", async () => {
  UI.goBtn.disabled = true;
  showResult(false);

  const minutes = parseInt(UI.timeSelect.value, 10);
  const mode = UI.modeSelect.value;

  setStatus("📍 Prendo la posizione GPS…");

  try {
    const pos = await getCurrentPosition();
    const origin = {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude
    };

    setStatus("🔎 Cerco luoghi coerenti col tempo/mezzo…");

    // ORS note: if minutes > 60, ORS likely fails -> fallback automatic
    const { used, main, alts, visited } = await findPlaces({ origin, mode, minutes });

    // render
    renderAlternatives(alts, origin);
    await renderMain(main, origin, mode, minutes, used, visited);

  } catch (e) {
    setStatus(`Errore: ${String(e.message || e)}`, "err");
  } finally {
    UI.goBtn.disabled = false;
  }
});

// Initial
setStatus("Pronto. Premi il bottone: Jamo userà il GPS.");
UI.footerInfo.textContent = `Versione ${VERSION} • Luoghi reali (OSM)`;
