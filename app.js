/**
 * JAMO v0.8 – DESTINAZIONI = BORGI + LUOGHI FAMOSI (naturali/landmark)
 *
 * 1) Trova DESTINAZIONI di due tipi:
 *    A) place: city/town/village/hamlet/locality/suburb
 *    B) landmark: waterfall/peak/cave/viewpoint/nature_reserve/attraction
 *
 * 2) Filtra per raggio km, tempo max, budget max e mezzo.
 * 3) Mostra 1 destinazione + alternative.
 * 4) Sotto alla destinazione: “Cosa vedere/fare” (POI) vicino al posto scelto.
 *
 * Nota: dipende dai dati su OpenStreetMap. Se un posto non è mappato/etichettato, non potrà uscire.
 */

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const resultsEl = $("results");
const btnGo = $("btnGo");

const radiusEl = $("radiusKm");
const modeEl = $("mode");
const timeEl = $("timeBudgetMin");
const budgetEl = $("budget");
const placeTypeEl = $("placeType");
const vibeEl = $("vibe");

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

btnGo.addEventListener("click", async () => {
  resultsEl.innerHTML = "";

  try {
    btnGo.disabled = true;
    setStatus("📍 Richiedo il GPS…");

    const pos = await getCurrentPosition({ enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
    const user = { lat: pos.coords.latitude, lon: pos.coords.longitude };

    let radiusKm = Number(radiusEl.value);
    let radiusMeters = radiusKm * 1000;

    const mode = modeEl.value;
    const timeBudgetMin = parseOptionalNumber(timeEl.value);
    const budgetMax = parseOptionalNumber(budgetEl.value);

    const placeType = placeTypeEl.value; // any/city/town/village/mix (non cambia molto qui)
    const vibe = vibeEl.value;

    // Aereo: raggio più grande e distanza minima
    if (mode === "plane" && radiusKm < 500) {
      radiusKm = 500;
      radiusMeters = 500 * 1000;
    }

    const minDistanceKm = (mode === "plane") ? 120 : 2.5;

    setStatus(`🔎 Cerco destinazioni (borghi + luoghi famosi) entro ${radiusKm} km…`);

    // 1) prendi BORGI + LANDMARK insieme
    let destinations = await fetchDestinations(user.lat, user.lon, radiusMeters);

    // fallback: se niente, aumenta raggio minimo 150km
    if (!destinations.length) {
      const emergencyKm = Math.max(radiusKm, 150);
      setStatus(`Ancora nulla. Aumento il raggio a ${emergencyKm} km…`);
      destinations = await fetchDestinations(user.lat, user.lon, emergencyKm * 1000);
      radiusKm = emergencyKm;
      radiusMeters = emergencyKm * 1000;
    }

    if (!destinations.length) {
      setStatus("Non trovo destinazioni (Overpass può essere lento). Riprova tra poco o aumenta il raggio.", true);
      return;
    }

    // 2) distanze + stime + score
    let scored = destinations
      .map((d) => ({
        ...d,
        distanceKm: haversineKm(user.lat, user.lon, d.lat, d.lon),
      }))
      .filter((d) => d.distanceKm >= minDistanceKm)
      .map((d) => {
        const est = estimateTrip(d.distanceKm, mode);
        const score = scoreDestination(d, vibe, mode);
        return { ...d, est, score };
      })
      .sort((a, b) => b.score - a.score);

    if (!scored.length) {
      setStatus("Tutto troppo vicino per i filtri scelti. Aumenta il raggio.", true);
      return;
    }

    // 3) filtri tempo/budget
    const filtered = scored.filter((d) => {
      if (timeBudgetMin != null && d.est.minutes > timeBudgetMin) return false;
      if (budgetMax != null && d.est.cost > budgetMax) return false;
      return true;
    });

    const finalList = filtered.length ? filtered : scored;

    if (!filtered.length) {
      setStatus("⚠️ Con tempo/budget scelti non esce nulla: ti mostro comunque le migliori destinazioni (aumenta tempo/budget).", true);
    } else {
      setStatus("✅ Fatto.");
    }

    const main = finalList[0];
    const alternatives = finalList.slice(1, 4);

    render(main, alternatives, {
      mode, radiusKm, placeType, vibe,
      timeBudgetMin, budgetMax, minDistanceKm
    });

    // Auto-show “cosa fare” sul principale
    await showThingsToDoForDestination(main);

  } catch (err) {
    console.error(err);
    if (String(err).includes("denied")) setStatus("GPS negato. Attiva la posizione e consenti l’accesso.", true);
    else setStatus("Errore: " + (err?.message || String(err)), true);
  } finally {
    btnGo.disabled = false;
  }
});

/* ===================== DESTINATIONS = places + landmarks ===================== */

async function fetchDestinations(lat, lon, radiusMeters) {
  const query = `
[out:json][timeout:25];
(
  // A) BORGI / CITTA' (aggiungo locality e suburb per non perdere roba)
  nwr(around:${radiusMeters},${lat},${lon})["place"~"city|town|village|hamlet|locality|suburb"];

  // B) LUOGHI FAMOSI / NATURALI (Gran Sasso, cascate, grotte, belvedere…)
  nwr(around:${radiusMeters},${lat},${lon})["natural"~"peak|waterfall|cave|bay|beach|wood"];
  nwr(around:${radiusMeters},${lat},${lon})["tourism"~"attraction|viewpoint"];
  nwr(around:${radiusMeters},${lat},${lon})["leisure"~"nature_reserve|park"];
  nwr(around:${radiusMeters},${lat},${lon})["historic"~"castle|ruins|monument|archaeological_site"];
);
out center tags;
`;

  const json = await fetchOverpass(query);
  const els = Array.isArray(json.elements) ? json.elements : [];

  const parsed = els.map((e) => {
    const tags = e.tags || {};
    const name = tags.name || tags["name:it"] || null;
    const cLat = e.lat ?? e.center?.lat;
    const cLon = e.lon ?? e.center?.lon;
    if (!cLat || !cLon) return null;

    const kind = inferDestinationKind(tags);
    const typeLabel = inferDestinationLabel(tags);

    // Se NON ha nome e sembra troppo generico, lo scarto per evitare roba inutile
    if (!name && kind === "landmark" && typeLabel === "Luogo") return null;

    return {
      id: `${e.type}/${e.id}`,
      name: name || typeLabel,
      kind,       // "place" o "landmark"
      typeLabel,  // "Borgo", "Cascata", "Vetta", ecc.
      lat: cLat,
      lon: cLon,
      tags
    };
  }).filter(Boolean);

  // dedup forte
  const seen = new Set();
  const out = [];
  for (const d of parsed) {
    const key = `${d.name}|${d.lat.toFixed(4)}|${d.lon.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }

  // limite per performance
  return out.slice(0, 600);
}

function inferDestinationKind(tags) {
  if (tags.place) return "place";
  return "landmark";
}

function inferDestinationLabel(tags) {
  // places
  if (tags.place === "city") return "Città";
  if (tags.place === "town") return "Paese";
  if (tags.place === "village") return "Borgo";
  if (tags.place === "hamlet") return "Località";
  if (tags.place === "locality") return "Località";
  if (tags.place === "suburb") return "Zona";

  // landmarks
  if (tags.natural === "waterfall") return "Cascata";
  if (tags.natural === "peak") return "Vetta";
  if (tags.natural === "cave") return "Grotta";
  if (tags.natural === "beach") return "Spiaggia";
  if (tags.tourism === "viewpoint") return "Belvedere";
  if (tags.tourism === "attraction") return "Luogo famoso";
  if (tags.leisure === "nature_reserve") return "Riserva naturale";
  if (tags.leisure === "park") return "Parco";
  if (tags.historic) return "Luogo storico";

  return "Luogo";
}

/* ===================== POI = cosa vedere/fare vicino alla destinazione ===================== */

async function fetchThingsToDo(lat, lon, radiusMeters) {
  const query = `
[out:json][timeout:25];
(
  nwr(around:${radiusMeters},${lat},${lon})["tourism"~"attraction|museum|gallery|viewpoint|zoo|theme_park"];
  nwr(around:${radiusMeters},${lat},${lon})["historic"];
  nwr(around:${radiusMeters},${lat},${lon})["leisure"~"park|garden|nature_reserve"];
  nwr(around:${radiusMeters},${lat},${lon})["natural"~"beach|peak|waterfall|cave|spring|wood"];
  nwr(around:${radiusMeters},${lat},${lon})["amenity"~"restaurant|cafe|bar|pub"];
);
out center tags;
`;
  const json = await fetchOverpass(query);
  const els = Array.isArray(json.elements) ? json.elements : [];

  const parsed = els.map((e) => {
    const tags = e.tags || {};
    const name = tags.name || tags["name:it"] || null;
    const cLat = e.lat ?? e.center?.lat;
    const cLon = e.lon ?? e.center?.lon;
    if (!cLat || !cLon) return null;

    return {
      id: `${e.type}/${e.id}`,
      name: name || inferPoiType(tags),
      typeLabel: inferPoiType(tags),
      lat: cLat,
      lon: cLon,
      tags
    };
  }).filter(Boolean);

  const seen = new Set();
  const out = [];
  for (const p of parsed) {
    const key = `${p.name}|${p.lat.toFixed(5)}|${p.lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }

  out.sort((a, b) => poiRank(b.tags) - poiRank(a.tags));
  return out.slice(0, 15);
}

function inferPoiType(tags) {
  const t = tags.tourism;
  const h = tags.historic;
  const l = tags.leisure;
  const n = tags.natural;
  const a = tags.amenity;

  if (t === "museum") return "Museo";
  if (t === "gallery") return "Galleria";
  if (t === "viewpoint") return "Belvedere";
  if (t === "attraction") return "Attrazione";
  if (t === "zoo") return "Zoo";
  if (t === "theme_park") return "Parco divertimenti";
  if (h) return "Luogo storico";
  if (l === "park") return "Parco";
  if (l === "garden") return "Giardino";
  if (l === "nature_reserve") return "Riserva naturale";
  if (n === "beach") return "Spiaggia";
  if (n === "peak") return "Vetta";
  if (n === "waterfall") return "Cascata";
  if (n === "cave") return "Grotta";
  if (a === "restaurant") return "Ristorante";
  if (a === "cafe") return "Caffè";
  if (a === "bar") return "Bar";
  if (a === "pub") return "Pub";
  return "Punto d’interesse";
}

function poiRank(tags) {
  if (tags.tourism === "attraction" || tags.tourism === "museum" || tags.historic) return 5;
  if (tags.tourism === "viewpoint" || tags.natural) return 4;
  if (tags.leisure) return 3;
  if (tags.amenity) return 2;
  return 1;
}

/* ===================== Overpass with fallback ===================== */

async function fetchOverpass(query) {
  let lastErr = null;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: "data=" + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`Overpass ${url} status ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Overpass non disponibile");
}

/* ===================== Estimates + scoring ===================== */

function estimateTrip(distanceKm, mode) {
  const speeds = { car:55, train:75, bus:40, walk:4.5, bike:14, plane:650 };

  if (mode === "plane") {
    const flightMinutes = Math.round((distanceKm / speeds.plane) * 60);
    const overhead = 120;
    const minutes = overhead + flightMinutes;
    const cost = round2(35 + distanceKm * 0.12);
    return { minutes, cost, flightMinutes };
  }

  const speed = speeds[mode] || 50;
  const minutes = Math.round((distanceKm / speed) * 60);

  let cost = 0;
  if (mode === "car") cost = distanceKm * 0.20;
  else if (mode === "train") cost = 3 + distanceKm * 0.10;
  else if (mode === "bus") cost = 2.2 + distanceKm * 0.06;
  else cost = 0;

  return { minutes, cost: round2(cost) };
}

function scoreDestination(d, vibe, mode) {
  let s = 0;
  const km = d.distanceKm ?? 0;

  // boost “luogo famoso”
  if (d.kind === "landmark") s += 4;

  // boost se ha nome vero
  if (d.name && d.name.length >= 4) s += 2;

  // bilanciamento distanza
  if (mode === "plane") {
    if (km < 150) s -= 20;
    else if (km <= 400) s += 10;
    else if (km <= 900) s += 7;
    else s += 3;
  } else {
    if (km <= 20) s += 9;
    else if (km <= 60) s += 7;
    else if (km <= 150) s += 5;
    else s += 2;
  }

  // vibe
  if (vibe === "quick") { if (km <= 40) s += 4; else s -= 2; }
  if (vibe === "chill") { if (km <= 120) s += 2; }
  if (vibe === "adventure") { if (km >= 20 && km <= 200) s += 3; }
  if (vibe === "romantic") {
    if (d.typeLabel === "Borgo" || d.typeLabel === "Paese") s += 2;
    if (d.typeLabel === "Belvedere") s += 2;
  }

  s += Math.random() * 1.1;
  return s;
}

function round2(x){ return Math.round(x * 100) / 100; }

/* ===================== UI ===================== */

function render(main, alternatives, ctx) {
  resultsEl.innerHTML = "";

  const summary = document.createElement("div");
  summary.className = "pill";
  const timeTxt = ctx.timeBudgetMin ? `⏱ ${ctx.timeBudgetMin} min` : "⏱ no limite";
  const budTxt = ctx.budgetMax ? `💶 €${ctx.budgetMax}` : "💶 no limite";
  summary.textContent = `${labelMode(ctx.mode)} • ${timeTxt} • ${budTxt} • raggio ${ctx.radiusKm}km • min dist ${ctx.minDistanceKm}km • ${labelVibe(ctx.vibe)}`;
  resultsEl.appendChild(summary);

  resultsEl.appendChild(destCard("Meta consigliata", main, true));

  if (alternatives.length) {
    const div = document.createElement("div");
    div.className = "divider";
    resultsEl.appendChild(div);

    const pill = document.createElement("div");
    pill.className = "pill";
    pill.textContent = "Alternative";
    resultsEl.appendChild(pill);

    alternatives.forEach((a) => resultsEl.appendChild(destCard("", a, false)));
  }
}

function destCard(title, d, isMain) {
  const wrap = document.createElement("div");
  wrap.className = "dest";
  wrap.dataset.destId = d.id;

  if (title) {
    const pill = document.createElement("div");
    pill.className = "pill";
    pill.textContent = title;
    wrap.appendChild(pill);
  }

  const name = document.createElement("p");
  name.className = "name";
  name.textContent = d.name;
  wrap.appendChild(name);

  const meta = document.createElement("p");
  meta.className = "meta";
  const extraPlane = d.est.flightMinutes != null ? ` (volo ~${d.est.flightMinutes} min)` : "";
  meta.textContent = `${d.typeLabel} • ${d.distanceKm.toFixed(1)} km • ~${d.est.minutes} min${extraPlane} • ~€${d.est.cost}`;
  wrap.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "actions";

  const btnMaps = document.createElement("button");
  btnMaps.className = "smallbtn";
  btnMaps.textContent = "Apri in Maps";
  btnMaps.onclick = () => openInMaps(d.lat, d.lon);
  actions.appendChild(btnMaps);

  const btnThings = document.createElement("button");
  btnThings.className = "smallbtn";
  btnThings.textContent = "Cosa vedere/fare";
  btnThings.onclick = async () => showThingsToDoForDestination(d, wrap);
  actions.appendChild(btnThings);

  wrap.appendChild(actions);

  // box POI
  const box = document.createElement("div");
  box.className = "panel";
  box.style.marginTop = "10px";
  box.style.display = "none";
  box.dataset.poiBox = "1";
  wrap.appendChild(box);

  if (isMain) {
    const hint = document.createElement("div");
    hint.className = "pill";
    hint.textContent = "Sotto trovi cosa vedere/fare. Se non ti convince, prova una alternativa 👇";
    wrap.appendChild(hint);
  }

  return wrap;
}

async function showThingsToDoForDestination(dest, cardEl = null) {
  const wrap = cardEl || findCard(dest.id);
  if (!wrap) return;

  const box = wrap.querySelector('[data-poi-box="1"]');
  if (!box) return;

  box.style.display = "block";
  box.innerHTML = `<div class="muted">🔎 Cerco cosa vedere/fare vicino a <b>${escapeHtml(dest.name)}</b>…</div>`;

  try {
    const poiRadius = (dest.typeLabel === "Città" || dest.typeLabel === "Paese") ? 5000 : 4000;
    const items = await fetchThingsToDo(dest.lat, dest.lon, poiRadius);

    if (!items.length) {
      box.innerHTML = `<div class="muted">Non ho trovato molto vicino a ${escapeHtml(dest.name)}. (Dipende dai dati OSM)</div>`;
      return;
    }

    box.innerHTML = "";
    const header = document.createElement("div");
    header.className = "pill";
    header.textContent = `Cosa vedere/fare vicino a ${dest.name}`;
    box.appendChild(header);

    items.forEach((it) => {
      const row = document.createElement("div");
      row.className = "dest";
      row.style.marginTop = "10px";

      const nm = document.createElement("p");
      nm.className = "name";
      nm.style.fontSize = "16px";
      nm.textContent = it.name;
      row.appendChild(nm);

      const mt = document.createElement("p");
      mt.className = "meta";
      mt.textContent = it.typeLabel;
      row.appendChild(mt);

      const act = document.createElement("div");
      act.className = "actions";

      const b = document.createElement("button");
      b.className = "smallbtn";
      b.textContent = "Apri in Maps";
      b.onclick = () => openInMaps(it.lat, it.lon);
      act.appendChild(b);

      row.appendChild(act);
      box.appendChild(row);
    });

  } catch (e) {
    console.error(e);
    box.innerHTML = `<div class="error">Errore nel cercare cosa vedere/fare. Riprova tra poco.</div>`;
  }
}

function findCard(id) {
  const cards = resultsEl.querySelectorAll(".dest");
  for (const c of cards) if (c.dataset.destId === id) return c;
  return null;
}

function openInMaps(lat, lon) {
  const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lon)}`;
  window.open(url, "_blank");
}

function labelMode(m){
  return ({car:"🚗 Auto",train:"🚆 Treno",bus:"🚌 Bus",bike:"🚲 Bici",walk:"🚶 A piedi",plane:"✈️ Aereo"})[m] || m;
}
function labelVibe(v){
  return ({any:"✨ Qualsiasi",quick:"⚡ Vicino e veloce",chill:"🧘 Tranquillo",adventure:"🧗 Fuori porta",romantic:"💘 Romantico"})[v] || v;
}

/* ===================== Utils ===================== */

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? "error" : "muted";
}

function parseOptionalNumber(v) {
  const n = Number(String(v || "").trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function getCurrentPosition(options) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}
function deg2rad(deg) { return deg * (Math.PI / 180); }

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
