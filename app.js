const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const resultsEl = $("results");
const btnGo = $("btnGo");

const radiusEl = $("radiusKm");
const modeEl = $("mode");
const budgetEl = $("budget");
const maxTravelEl = $("maxTravelMin");
const placeTypeEl = $("placeType");
const vibeEl = $("vibe");

btnGo.addEventListener("click", async () => {
  try {
    resultsEl.innerHTML = "";
    setStatus("Richiedo il GPS…");
    btnGo.disabled = true;

    const pos = await getCurrentPosition({ enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
    const user = { lat: pos.coords.latitude, lon: pos.coords.longitude };

    const radiusMeters = Number(radiusEl.value) * 1000;
    const mode = modeEl.value;

    const budget = parseOptionalNumber(budgetEl.value);
    const maxTravelMin = parseOptionalNumber(maxTravelEl.value); // qui è il “max 2h volo” ecc.
    const placeType = placeTypeEl.value;
    const vibe = vibeEl.value;

    setStatus(`Cerco mete (${placeType}) entro ${radiusEl.value} km…`);
    const destinations = await fetchDestinations(user.lat, user.lon, radiusMeters, placeType);

    if (!destinations.length) {
      setStatus("Non ho trovato mete. Aumenta il raggio o cambia tipo meta.", true);
      return;
    }

    // stime + score
    let scored = destinations
      .map((d) => ({
        ...d,
        distanceKm: haversineKm(user.lat, user.lon, d.lat, d.lon),
      }))
      .map((d) => {
        const est = estimateTrip(d.distanceKm, mode); // minuti/costo stimati per mezzo
        return {
          ...d,
          est,
          score: scoreDestination(d, placeType, vibe),
        };
      })
      .sort((a, b) => b.score - a.score);

    // filtri “intelligenti”:
    // 1) max tempo di viaggio (in min) -> vale per ogni mezzo
    // 2) budget
    const filtered = scored.filter((d) => {
      if (maxTravelMin != null && d.est.minutes > maxTravelMin) return false;
      if (budget != null && d.est.cost > budget) return false;
      return true;
    });

    // fallback se tagli tutto
    const finalList = filtered.length ? filtered : scored;

    if (!filtered.length) {
      setStatus("Con questi filtri non esce nulla: ti mostro comunque le migliori mete (prova ad aumentare max tempo o raggio).", true);
    } else {
      setStatus("Fatto ✅");
    }

    const main = finalList[0];
    const alternatives = finalList.slice(1, 4);

    renderSuggestions(main, alternatives, { mode, maxTravelMin, budget, placeType, vibe });

  } catch (err) {
    console.error(err);
    if (String(err).includes("denied")) setStatus("GPS negato. Attiva la posizione e consenti l’accesso.", true);
    else setStatus("Errore: " + (err?.message || String(err)), true);
  } finally {
    btnGo.disabled = false;
  }
});

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? "error" : "muted";
}

function parseOptionalNumber(v) {
  const n = Number(String(v || "").trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/* ===================== DESTINATIONS (Overpass) ===================== */

async function fetchDestinations(lat, lon, radiusMeters, placeType) {
  const overpassUrl = "https://overpass-api.de/api/interpreter";
  const block = buildPlaceTypeQuery(placeType, lat, lon, radiusMeters);

  const query = `
[out:json][timeout:25];
(
  ${block}
);
out center tags;
`;

  const res = await fetch(overpassUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error("Overpass non risponde (" + res.status + ")");

  const json = await res.json();
  const els = Array.isArray(json.elements) ? json.elements : [];

  const parsed = els.map((e) => {
    const tags = e.tags || {};
    const name = tags.name || tags["name:it"] || null;
    const cLat = e.lat ?? e.center?.lat;
    const cLon = e.lon ?? e.center?.lon;
    if (!cLat || !cLon) return null;

    const typeLabel = inferType(tags);
    return {
      id: `${e.type}/${e.id}`,
      name: name || typeLabel,
      typeLabel,
      lat: cLat,
      lon: cLon,
      tags
    };
  }).filter(Boolean);

  // dedup
  const seen = new Set();
  const out = [];
  for (const d of parsed) {
    const key = `${d.name}|${d.lat.toFixed(5)}|${d.lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

function buildPlaceTypeQuery(placeType, lat, lon, r) {
  // NB: “events” è beta: OSM non è perfetto per eventi live. Per eventi veri servirà un’API (Ticketmaster ecc.)
  if (placeType === "city") {
    return `
nwr(around:${r},${lat},${lon})["place"~"city|town|village"];
nwr(around:${r},${lat},${lon})["tourism"~"attraction|museum|gallery"];
nwr(around:${r},${lat},${lon})["historic"];
`;
  }
  if (placeType === "sea") {
    return `
nwr(around:${r},${lat},${lon})["natural"="beach"];
nwr(around:${r},${lat},${lon})["tourism"="viewpoint"];
`;
  }
  if (placeType === "mountain") {
    return `
nwr(around:${r},${lat},${lon})["natural"="peak"];
nwr(around:${r},${lat},${lon})["route"="hiking"];
nwr(around:${r},${lat},${lon})["tourism"="viewpoint"];
`;
  }
  if (placeType === "nature") {
    return `
nwr(around:${r},${lat},${lon})["leisure"~"park|nature_reserve|garden"];
nwr(around:${r},${lat},${lon})["natural"~"peak|wood|spring|cave|waterfall|bay|beach"];
nwr(around:${r},${lat},${lon})["tourism"="viewpoint"];
`;
  }
  if (placeType === "culture") {
    return `
nwr(around:${r},${lat},${lon})["tourism"~"museum|gallery|attraction"];
nwr(around:${r},${lat},${lon})["historic"];
`;
  }
  if (placeType === "food") {
    return `
nwr(around:${r},${lat},${lon})["amenity"~"cafe|bar|restaurant|pub"];
`;
  }
  if (placeType === "relax") {
    return `
nwr(around:${r},${lat},${lon})["amenity"="spa"];
nwr(around:${r},${lat},${lon})["leisure"="spa"];
nwr(around:${r},${lat},${lon})["amenity"="sauna"];
nwr(around:${r},${lat},${lon})["tourism"="hotel"];
`;
  }
  if (placeType === "family") {
    return `
nwr(around:${r},${lat},${lon})["tourism"~"zoo|theme_park"];
nwr(around:${r},${lat},${lon})["leisure"="park"];
`;
  }
  if (placeType === "night") {
    return `
nwr(around:${r},${lat},${lon})["amenity"~"bar|pub|nightclub"];
`;
  }
  if (placeType === "events") {
    return `
nwr(around:${r},${lat},${lon})["amenity"~"theatre|cinema"];
nwr(around:${r},${lat},${lon})["tourism"="attraction"];
`;
  }

  // any
  return `
nwr(around:${r},${lat},${lon})["place"~"city|town|village"];
nwr(around:${r},${lat},${lon})["tourism"~"attraction|museum|gallery|zoo|theme_park|viewpoint"];
nwr(around:${r},${lat},${lon})["historic"];
nwr(around:${r},${lat},${lon})["natural"~"peak|beach|spring|wood|cave|waterfall|bay"];
nwr(around:${r},${lat},${lon})["leisure"~"park|nature_reserve|garden"];
nwr(around:${r},${lat},${lon})["amenity"~"cafe|bar|restaurant|pub|nightclub"];
`;
}

function inferType(tags) {
  const t = tags.tourism;
  const n = tags.natural;
  const h = tags.historic;
  const l = tags.leisure;
  const a = tags.amenity;
  const p = tags.place;

  if (p === "city") return "Città";
  if (p === "town") return "Cittadina";
  if (p === "village") return "Borgo";
  if (t === "museum") return "Museo";
  if (t === "gallery") return "Galleria";
  if (t === "zoo") return "Zoo";
  if (t === "theme_park") return "Parco divertimenti";
  if (t === "viewpoint") return "Belvedere";
  if (t === "attraction") return "Attrazione";
  if (h) return "Luogo storico";
  if (l === "park") return "Parco";
  if (l === "garden") return "Giardino";
  if (l === "nature_reserve") return "Riserva naturale";
  if (n === "beach") return "Spiaggia";
  if (n === "waterfall") return "Cascata";
  if (n === "peak") return "Vetta";
  if (a === "restaurant") return "Ristorante";
  if (a === "cafe") return "Caffè";
  if (a === "bar") return "Bar";
  if (a === "pub") return "Pub";
  if (a === "nightclub") return "Locale";
  if (a === "spa") return "Spa";
  return "Meta";
}

/* ===================== SCORE + ESTIMATES ===================== */

function scoreDestination(d, placeType, vibe) {
  let s = 0;
  const km = d.distanceKm ?? 0;
  const tags = d.tags || {};

  // Qualità info
  if (tags.wikipedia) s += 4;
  if (tags.website) s += 2;
  if (tags.opening_hours) s += 1;
  if (d.name && d.name !== d.typeLabel) s += 2;

  // Preferenze “vibe”
  if (vibe === "quick") {
    if (km <= 20) s += 9; else if (km <= 80) s += 5; else s += 1;
  } else if (vibe === "chill") {
    if (km <= 80) s += 7; else s += 3;
  } else if (vibe === "adventure") {
    if (tags.natural || tags.route === "hiking" || tags.tourism === "viewpoint") s += 6;
    s += km <= 150 ? 3 : 5;
  } else if (vibe === "romantic") {
    if (tags.tourism === "viewpoint" || tags.place === "village" || tags.place === "town") s += 6;
  } else {
    // default: leggero bias per non troppo lontano
    if (km <= 15) s += 7; else if (km <= 80) s += 5; else s += 2;
  }

  // Coerenza “tipo meta”
  if (placeType === "sea" && tags.natural === "beach") s += 8;
  if (placeType === "mountain" && (tags.natural === "peak" || tags.route === "hiking")) s += 8;
  if (placeType === "culture" && (tags.tourism === "museum" || tags.historic)) s += 8;
  if (placeType === "food" && tags.amenity) s += 8;
  if (placeType === "night" && (tags.amenity === "nightclub" || tags.amenity === "pub" || tags.amenity === "bar")) s += 8;

  s += Math.random() * 1.1;
  return s;
}

function estimateTrip(distanceKm, mode) {
  const speeds = {
    car: 55,
    train: 75,
    bus: 40,
    walk: 4.5,
    bike: 14,
    plane: 650
  };

  if (mode === "plane") {
    // “max 2h di volo” -> noi stimiamo volo + overhead
    const flightMinutes = Math.round((distanceKm / speeds.plane) * 60);
    const minutes = 120 + flightMinutes; // overhead aeroporto (indicativo)
    const cost = round2(30 + distanceKm * 0.12);
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

function round2(x){ return Math.round(x * 100) / 100; }

/* ===================== RENDER ===================== */

function renderSuggestions(main, alternatives, ctx) {
  resultsEl.innerHTML = "";

  const summary = document.createElement("div");
  summary.className = "pill";
  const timeTxt = ctx.maxTravelMin ? `⏱ max ${ctx.maxTravelMin} min` : "⏱ senza max tempo";
  const budTxt = ctx.budget ? `€ max ${ctx.budget}` : "€ senza budget";
  summary.textContent = `${modeLabel(ctx.mode)} • ${timeTxt} • ${budTxt} • ${typeLabel(ctx.placeType)} • ${vibeLabel(ctx.vibe)}`;
  resultsEl.appendChild(summary);

  resultsEl.appendChild(buildDestinationCard("Meta consigliata", main, true));

  if (alternatives.length) {
    const div = document.createElement("div");
    div.className = "divider";
    resultsEl.appendChild(div);

    const pill = document.createElement("div");
    pill.className = "pill";
    pill.textContent = "Alternative";
    resultsEl.appendChild(pill);

    alternatives.forEach((a) => resultsEl.appendChild(buildDestinationCard("", a, false)));
  }
}

function buildDestinationCard(title, d, isMain) {
  const wrap = document.createElement("div");
  wrap.className = "dest";

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
  btnMaps.onclick = () => openInMaps(d);
  actions.appendChild(btnMaps);

  const btnWhat = document.createElement("button");
  btnWhat.className = "smallbtn";
  btnWhat.textContent = "Cosa fare lì";
  btnWhat.onclick = async () => showThingsToDoNear(d);
  actions.appendChild(btnWhat);

  wrap.appendChild(actions);

  if (isMain) {
    const hint = document.createElement("div");
    hint.className = "pill";
    hint.textContent = "Se non ti convince, prova una alternativa 👇";
    wrap.appendChild(hint);
  }

  return wrap;
}

function modeLabel(m){
  return ({
    car:"🚗 Auto", train:"🚆 Treno", bus:"🚌 Bus", bike:"🚲 Bici", walk:"🚶 A piedi", plane:"✈️ Aereo"
  })[m] || m;
}
function typeLabel(t){
  return ({
    any:"🎯 Tutto", city:"🏙️ Città", sea:"🏖️ Mare", mountain:"🏔️ Montagna", nature:"🌿 Natura", culture:"🏛️ Cultura",
    food:"🍝 Cibo", relax:"🧖 Relax", family:"👨‍👩‍👧 Famiglia", night:"🌙 Notte", events:"🎫 Eventi"
  })[t] || t;
}
function vibeLabel(v){
  return ({ any:"✨ Qualsiasi", quick:"⚡ Mordi e fuggi", chill:"🧘 Chill", adventure:"🧗 Avventura", romantic:"💘 Romantica" })[v] || v;
}

function openInMaps(d) {
  const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.lat + "," + d.lon)}`;
  window.open(url, "_blank");
}

/* ===================== POI “cosa fare lì” ===================== */

async function showThingsToDoNear(dest) {
  try {
    setStatus(`Cerco cosa fare vicino a “${dest.name}”…`);
    const items = await fetchNearbyPOI(dest.lat, dest.lon, 2000);

    const section = document.createElement("div");
    section.className = "panel";
    section.style.marginTop = "12px";

    const h3 = document.createElement("div");
    h3.className = "pill";
    h3.textContent = `Cosa fare vicino a ${dest.name}`;
    section.appendChild(h3);

    if (!items.length) {
      const p = document.createElement("div");
      p.className = "muted";
      p.textContent = "Non ho trovato POI vicini (o Overpass è lento). Riprova.";
      section.appendChild(p);
    } else {
      items.slice(0, 10).forEach((it) => {
        const box = document.createElement("div");
        box.className = "dest";
        box.style.marginTop = "10px";

        const nm = document.createElement("p");
        nm.className = "name";
        nm.style.fontSize = "16px";
        nm.textContent = it.name;
        box.appendChild(nm);

        const mt = document.createElement("p");
        mt.className = "meta";
        mt.textContent = `${it.typeLabel}`;
        box.appendChild(mt);

        const btn = document.createElement("button");
        btn.className = "smallbtn";
        btn.textContent = "Apri";
        btn.onclick = () => openInMaps(it);
        box.appendChild(btn);

        section.appendChild(box);
      });
    }

    resultsEl.appendChild(section);
    setStatus("Ecco alcune idee ✅");
  } catch (e) {
    console.error(e);
    setStatus("Errore nel cercare cosa fare lì: " + (e.message || e), true);
  }
}

async function fetchNearbyPOI(lat, lon, radiusMeters) {
  const overpassUrl = "https://overpass-api.de/api/interpreter";
  const query = `
[out:json][timeout:25];
(
  nwr(around:${radiusMeters},${lat},${lon})["amenity"~"cafe|bar|restaurant|pub|nightclub"];
  nwr(around:${radiusMeters},${lat},${lon})["tourism"~"attraction|museum|viewpoint|gallery|zoo|theme_park"];
  nwr(around:${radiusMeters},${lat},${lon})["leisure"~"park|garden|spa"];
);
out center tags;
`;
  const res = await fetch(overpassUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error("Overpass POI non risponde (" + res.status + ")");

  const json = await res.json();
  const els = Array.isArray(json.elements) ? json.elements : [];

  const parsed = els.map((e) => {
    const tags = e.tags || {};
    const name = tags.name || tags["name:it"] || null;
    const cLat = e.lat ?? e.center?.lat;
    const cLon = e.lon ?? e.center?.lon;
    if (!cLat || !cLon) return null;

    return {
      id: `${e.type}/${e.id}`,
      name: name || inferType(tags),
      typeLabel: inferType(tags),
      lat: cLat, lon: cLon, tags
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
  return out;
}

/* ===================== UTILS ===================== */

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
