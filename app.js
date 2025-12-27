// ======= Helpers DOM =======
const $ = (id) => document.getElementById(id);

function setStatus(msg, type = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (type ? " " + type : "");
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const x = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function choiceWeighted(items) {
  // items: [{score,...}]
  const total = items.reduce((s,i)=>s+Math.max(0.01,i.score),0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= Math.max(0.01,it.score);
    if (r <= 0) return it;
  }
  return items[0];
}

// ======= Visited (localStorage) =======
const VISITED_KEY = "jamo_visited_v2";

function getVisitedSet() {
  try {
    const arr = JSON.parse(localStorage.getItem(VISITED_KEY) || "[]");
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function saveVisitedSet(set) {
  localStorage.setItem(VISITED_KEY, JSON.stringify([...set]));
}

function markVisited(idKey) {
  const s = getVisitedSet();
  s.add(idKey);
  saveVisitedSet(s);
}

// ======= Geo =======
function getGPS() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocalizzazione non supportata"));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    );
  });
}

// ======= Routing / Isochrone strategy =======
// ORS time range spesso max 60 min. Quindi:
// - fino a 60 min: ORS Isochrone TIME
// - sopra 60 min: fallback veloce a "bbox da velocità media" (molto stabile)
// Inoltre: per bici a volte ORS ok, ma Overpass può crollare se bbox enorme.
const SPEED_KMH = {
  car: 70,   // media “reale” includendo semafori
  bike: 16,
  walk: 4.5,
};

function estimateMaxDistanceKm(mode, minutes) {
  const kmh = SPEED_KMH[mode] || 50;
  return (kmh * minutes) / 60;
}

function bboxFromCircle(origin, radiusKm) {
  // approx (ok per ricerca luoghi)
  const lat = origin.lat;
  const lon = origin.lon;
  const dLat = radiusKm / 110.574;
  const dLon = radiusKm / (111.320 * Math.cos(lat * Math.PI / 180));
  return {
    minLat: lat - dLat,
    maxLat: lat + dLat,
    minLon: lon - dLon,
    maxLon: lon + dLon,
  };
}

// ======= Overpass Query: luoghi + borghi + natura + parchi + punti famosi =======
function buildDestinationsQueryFromBbox(b) {
  const { minLat, minLon, maxLat, maxLon } = b;

  return `
[out:json][timeout:25];
(
  // --- Borghi / città ---
  node["place"~"^(city|town|village)$"]["name"](${minLat},${minLon},${maxLat},${maxLon});
  way ["place"~"^(city|town|village)$"]["name"](${minLat},${minLon},${maxLat},${maxLon});
  rel ["place"~"^(city|town|village)$"]["name"](${minLat},${minLon},${maxLat},${maxLon});

  // --- Natura da gita ---
  node["natural"~"^(waterfall|peak|cave_entrance|spring|beach)$"]["name"](${minLat},${minLon},${maxLat},${maxLon});
  way ["natural"~"^(waterfall|peak|cave_entrance|spring|beach)$"]["name"](${minLat},${minLon},${maxLat},${maxLon});
  rel ["natural"~"^(waterfall|peak|cave_entrance|spring|beach)$"]["name"](${minLat},${minLon},${maxLat},${maxLon});

  // --- Laghi / fiumi / riserve ---
  node["water"~"^(lake|reservoir)$"]["name"](${minLat},${minLon},${maxLat},${maxLon});
  way ["water"~"^(lake|reservoir)$"]["name"](${minLat},${minLon},${maxLat},${maxLon});
  rel ["water"~"^(lake|reservoir)$"]["name"](${minLat},${minLon},${maxLat},${maxLon});

  // --- Parchi / aree protette ---
  node["boundary"="national_park"]["name"](${minLat},${minLon},${maxLat},${maxLon});
  way ["boundary"="national_park"]["name"](${minLat},${minLon},${maxLat},${maxLon});
  rel ["boundary"="national_park"]["name"](${minLat},${minLon},${maxLat},${maxLon});

  node["leisure"~"^(park|nature_reserve|garden)$"]["name"](${minLat},${minLon},${maxLat},${maxLon});
  way ["leisure"~"^(park|nature_reserve|garden)$"]["name"](${minLat},${minLon},${maxLat},${maxLon});
  rel ["leisure"~"^(park|nature_reserve|garden)$"]["name"](${minLat},${minLon},${maxLat},${maxLon});

  // --- Famosi / turistici / storici ---
  node["tourism"~"^(attraction|viewpoint|museum)$"]["name"](${minLat},${minLon},${maxLat},${maxLon});
  way ["tourism"~"^(attraction|viewpoint|museum)$"]["name"](${minLat},${minLon},${maxLat},${maxLon});
  rel ["tourism"~"^(attraction|viewpoint|museum)$"]["name"](${minLat},${minLon},${maxLat},${maxLon});

  node["historic"]["name"](${minLat},${minLon},${maxLat},${maxLon});
  way ["historic"]["name"](${minLat},${minLon},${maxLat},${maxLon});
  rel ["historic"]["name"](${minLat},${minLon},${maxLat},${maxLon});
);
out center;
`;
}

function normalizeDestinations(overpassJson, origin) {
  const visited = getVisitedSet();
  const els = (overpassJson.elements || []).filter(e => e.tags);

  function getLatLon(e){
    if (e.type === "node") return { lat: e.lat, lon: e.lon };
    if (e.center && typeof e.center.lat === "number") return { lat: e.center.lat, lon: e.center.lon };
    return null;
  }

  function isBadCandidate(tags){
    if (tags.place === "suburb" || tags.place === "neighbourhood" || tags.place === "hamlet") return true;
    if (tags.highway || tags.railway || tags.aeroway) return true;
    if (tags.amenity === "parking") return true;
    return false;
  }

  const scored = els.map(e => {
    const t = e.tags || {};
    if (isBadCandidate(t)) return null;

    const ll = getLatLon(e);
    if (!ll) return null;

    const name = t.name || t["name:it"];
    if (!name) return null;

    const kind =
      t.place ? "Borgo/Città" :
      t.natural ? "Natura" :
      t.water ? "Lago" :
      t.boundary === "national_park" ? "Parco" :
      t.leisure ? "Parco" :
      t.historic ? "Storico" :
      t.tourism ? "Da vedere" : "Luogo";

    // "Famosità": wikipedia/wikidata + categorie
    let score = 0;
    if (t.wikipedia) score += 6;
    if (t.wikidata) score += 4;

    if (t.place === "city") score += 4;
    if (t.place === "town") score += 3;
    if (t.place === "village") score += 2;

    if (t.natural === "waterfall") score += 6;
    if (t.natural === "peak") score += 4;
    if (t.natural === "cave_entrance") score += 5;
    if (t.boundary === "national_park") score += 4;
    if (t.tourism === "attraction") score += 4;
    if (t.tourism === "viewpoint") score += 3;
    if (t.historic) score += 3;

    const dist = haversineKm(origin, ll);
    // troppo vicino spesso è “a caso”
    if (dist < 2) score -= 2;
    // un po’ di bonus per vicino, ma non troppo
    score += Math.max(0, 3 - dist / 50);

    const idKey = t.wikidata ? `wd:${t.wikidata}` : `${e.type}:${e.id}`;

    return {
      idKey,
      name,
      lat: ll.lat,
      lon: ll.lon,
      tags: t,
      kind,
      distKm: Math.round(dist * 10) / 10,
      score,
      visited: visited.has(idKey)
    };
  }).filter(Boolean);

  // dedupe
  const uniq = [];
  const seen = new Set();
  for (const d of scored) {
    const k = `${d.name.toLowerCase()}_${d.lat.toFixed(3)}_${d.lon.toFixed(3)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(d);
  }

  // ordina: non visitati prima, poi score
  uniq.sort((a,b) => {
    if (a.visited !== b.visited) return a.visited ? 1 : -1;
    return b.score - a.score;
  });

  return uniq;
}

// ======= API Calls =======
async function fetchOverpass(query) {
  const r = await fetch("/api/overpass", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Overpass error (${r.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function fetchIsochroneORS(profile, minutes, origin) {
  // ORS Isochrone time: max 60 min
  const r = await fetch("/api/ors-isochrone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profile,
      minutes,
      lat: origin.lat,
      lon: origin.lon,
      rangeType: "time"
    })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Isochrone API error (${r.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function bboxFromORSGeojson(geojson) {
  const feat = geojson.features && geojson.features[0];
  const coords = feat && feat.geometry && feat.geometry.coordinates;
  if (!coords) return null;

  // ORS polygon: [ [ [lon,lat], ... ] ] oppure MultiPolygon
  const flat = [];
  const dig = (arr) => {
    if (!Array.isArray(arr)) return;
    if (arr.length === 2 && typeof arr[0] === "number") {
      flat.push(arr);
      return;
    }
    for (const x of arr) dig(x);
  };
  dig(coords);

  if (!flat.length) return null;

  let minLat=  90, maxLat=-90, minLon= 180, maxLon=-180;
  for (const [lon, lat] of flat) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { minLat, minLon, maxLat, maxLon };
}

// ======= UI render =======
function renderResult(main, alts, modeLabel, minutes) {
  $("result").classList.remove("hidden");
  $("placeName").textContent = main.name;

  const wikiBadge = main.tags.wikipedia || main.tags.wikidata ? " • ⭐ famoso" : "";
  $("placeMeta").textContent =
    `🏷️ ${main.kind}${wikiBadge} • 📍 ~${main.distKm} km (aria) • ⏱️ entro ~${minutes} min (${modeLabel})`;

  $("mapsLink").href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(main.name)}&query_place_id=`;

  $("visitedBtn").onclick = () => {
    markVisited(main.idKey);
    setStatus(`Segnato come già visitato: ${main.name}`, "ok");
  };

  const list = $("altList");
  list.innerHTML = "";
  for (const a of alts) {
    const div = document.createElement("div");
    div.className = "alt-item";
    const wiki = a.tags.wikipedia || a.tags.wikidata ? " ⭐" : "";
    div.innerHTML = `<div class="name">${a.name}${wiki}</div>
                     <div style="color:var(--muted);font-size:13px;margin-top:4px">
                       ${a.kind} • ~${a.distKm} km
                     </div>`;
    div.onclick = () => {
      renderResult(a, alts.filter(x=>x.idKey!==a.idKey).slice(0,3), modeLabel, minutes);
    };
    list.appendChild(div);
  }
}

// ======= Main flow =======
async function runJamo() {
  $("goBtn").disabled = true;
  $("result").classList.add("hidden");

  try {
    setStatus("📍 Sto leggendo il GPS…");
    const origin = await getGPS();

    const minutes = Number($("timeSelect").value);
    const mode = $("modeSelect").value;

    // Limiti pratici per non far esplodere Overpass:
    // camminata e bici oltre certi minuti spesso = 504
    let safeMinutes = minutes;
    if (mode === "walk") safeMinutes = Math.min(minutes, 120);
    if (mode === "bike") safeMinutes = Math.min(minutes, 180);

    const modeLabel = mode === "car" ? "Auto" : mode === "bike" ? "Bici" : "A piedi";

    // 1) bbox: ORS se possibile (solo <=60), altrimenti fallback veloce
    let bbox = null;

    if (safeMinutes <= 60) {
      setStatus("🧭 Calcolo area raggiungibile (ORS)…");
      const profile = mode === "car" ? "driving-car" : mode === "bike" ? "cycling-regular" : "foot-walking";

      const ors = await fetchIsochroneORS(profile, safeMinutes, origin);
      bbox = bboxFromORSGeojson(ors);
      if (!bbox) throw new Error("Isochrone OK ma bbox non trovata");
    } else {
      // fallback veloce e stabile
      const radiusKm = estimateMaxDistanceKm(mode, safeMinutes);
      bbox = bboxFromCircle(origin, radiusKm);
    }

    // 2) Overpass: prendo luoghi
    setStatus("🗺️ Cerco luoghi reali (OSM)…");
    const q = buildDestinationsQueryFromBbox(bbox);
    const data = await fetchOverpass(q);

    const all = normalizeDestinations(data, origin);

    // filtro per distanza plausibile (aria) rispetto al tempo scelto
    const maxKm = estimateMaxDistanceKm(mode, safeMinutes) * 1.15; // tolleranza
    const candidates = all.filter(x => x.distKm <= maxKm);

    if (candidates.length < 5) {
      // fallback: allarga un pelo (solo se pochi)
      const wider = all.filter(x => x.distKm <= maxKm * 1.5);
      if (wider.length < 3) {
        throw new Error("Non trovo abbastanza mete. Prova ad aumentare tempo o cambia mezzo.");
      }
      candidates.length = 0;
      candidates.push(...wider);
    }

    // 3) scegli meta: prendi top 40, poi scegli random pesato
    const top = candidates.slice(0, 40);

    // preferisci non visitati, ma se tutti visitati ok lo stesso
    const nonVisited = top.filter(x => !x.visited);
    const pool = nonVisited.length >= 5 ? nonVisited : top;

    const main = choiceWeighted(pool);
    const alts = pool.filter(x => x.idKey !== main.idKey).slice(0, 6);

    setStatus(`✅ Trovato: ${main.name}`, "ok");
    renderResult(main, alts, modeLabel, safeMinutes);

  } catch (e) {
    setStatus(`❌ Errore: ${String(e.message || e)}`, "err");
  } finally {
    $("goBtn").disabled = false;
  }
}

$("goBtn").addEventListener("click", runJamo);

// SW
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(()=>{});
}
