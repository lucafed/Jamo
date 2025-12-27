const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const resultsEl = $("results");
const btnGo = $("btnGo");

const radiusEl = $("radiusKm");
const modeEl = $("mode");
const budgetEl = $("budget");
const maxTimeEl = $("maxTime");
const activityEl = $("activity");

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
    const maxTime = parseOptionalNumber(maxTimeEl.value);
    const activity = activityEl.value;

    setStatus(`Ok. Cerco mete entro ${radiusEl.value} km…`);
    const destinations = await fetchDestinations(user.lat, user.lon, radiusMeters, activity);

    if (!destinations.length) {
      setStatus("Non ho trovato mete. Prova ad aumentare il raggio o cambia attività.", true);
      return;
    }

    // Score + stime
    let scored = destinations
      .map((d) => ({
        ...d,
        distanceKm: haversineKm(user.lat, user.lon, d.lat, d.lon),
      }))
      .map((d) => ({
        ...d,
        score: scoreDestination(d, activity),
        est: estimateTrip(d.distanceKm, mode),
      }))
      .sort((a, b) => b.score - a.score);

    // Applico filtri
    const filtered = applyFilters(scored, { budget, maxTime });

    // Fallback intelligente se filtri tagliano tutto
    if (!filtered.length) {
      setStatus("Con questi filtri non esce nulla: ti mostro risultati ignorando budget/tempo (puoi regolarli).", true);
    }

    const finalList = filtered.length ? filtered : scored;

    const main = finalList[0];
    const alternatives = finalList.slice(1, 4);

    renderSuggestions(main, alternatives);

    setStatus("Fatto ✅ Scegli una meta o apri Maps. Vuoi vedere cosa fare lì?");

  } catch (err) {
    console.error(err);
    if (String(err).includes("denied")) setStatus("GPS negato. Attiva la posizione e consenti l’accesso al sito.", true);
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

function applyFilters(list, { budget, maxTime }) {
  return list.filter((d) => {
    if (budget != null && d.est.cost > budget) return false;
    if (maxTime != null && d.est.minutes > maxTime) return false;
    return true;
  });
}

/* ===================== DESTINATIONS (Overpass) ===================== */

async function fetchDestinations(lat, lon, radiusMeters, activity) {
  const overpassUrl = "https://overpass-api.de/api/interpreter";

  // Base query a seconda dell’attività
  const block = buildActivityQuery(activity, lat, lon, radiusMeters);

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

function buildActivityQuery(activity, lat, lon, r) {
  // nwr = node/way/relation
  if (activity === "culture") {
    return `
nwr(around:${r},${lat},${lon})["tourism"~"museum|gallery|attraction|information"];
nwr(around:${r},${lat},${lon})["historic"];
`;
  }
  if (activity === "nature") {
    return `
nwr(around:${r},${lat},${lon})["natural"~"peak|beach|spring|wood|cave|waterfall|bay"];
nwr(around:${r},${lat},${lon})["leisure"~"park|nature_reserve|garden"];
nwr(around:${r},${lat},${lon})["tourism"~"viewpoint"];
`;
  }
  if (activity === "food") {
    return `
nwr(around:${r},${lat},${lon})["amenity"~"cafe|bar|restaurant|pub"];
`;
  }
  if (activity === "mix") {
    return `
nwr(around:${r},${lat},${lon})["tourism"~"attraction|museum|gallery|zoo|theme_park|viewpoint|information"];
nwr(around:${r},${lat},${lon})["historic"];
nwr(around:${r},${lat},${lon})["natural"~"peak|beach|spring|wood|cave|waterfall|bay"];
nwr(around:${r},${lat},${lon})["leisure"~"park|nature_reserve|garden"];
nwr(around:${r},${lat},${lon})["amenity"~"cafe|bar|restaurant|pub"];
`;
  }
  // any
  return `
nwr(around:${r},${lat},${lon})["tourism"~"attraction|museum|gallery|zoo|theme_park|viewpoint|information"];
nwr(around:${r},${lat},${lon})["historic"];
nwr(around:${r},${lat},${lon})["natural"~"peak|beach|spring|wood|cave|waterfall|bay"];
nwr(around:${r},${lat},${lon})["leisure"~"park|nature_reserve|garden"];
nwr(around:${r},${lat},${lon})["amenity"~"cafe|bar|restaurant|pub"];
`;
}

function inferType(tags) {
  const t = tags.tourism;
  const n = tags.natural;
  const h = tags.historic;
  const l = tags.leisure;
  const a = tags.amenity;

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
  return "Luogo da visitare";
}

/* ===================== SCORE + ESTIMATES ===================== */

function scoreDestination(d, activity) {
  let s = 0;
  const km = d.distanceKm ?? 0;

  // preferenze distanza
  if (km <= 5) s += 9;
  else if (km <= 15) s += 10;
  else if (km <= 40) s += 7;
  else if (km <= 150) s += 5;
  else s += 3;

  const tags = d.tags || {};
  if (tags.wikipedia) s += 4;
  if (tags.website) s += 2;
  if (tags.opening_hours) s += 1;

  // boost per coerenza attività
  if (activity === "culture" && (tags.tourism === "museum" || tags.historic)) s += 5;
  if (activity === "nature" && (tags.natural || tags.leisure)) s += 5;
  if (activity === "food" && tags.amenity) s += 5;

  if (d.name && d.name !== d.typeLabel) s += 2;
  s += Math.random() * 1.2;

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
    // overhead aeroporto + volo
    const flightMinutes = Math.round((distanceKm / speeds.plane) * 60);
    const minutes = 120 + flightMinutes; // check-in + security + transfer
    const cost = Math.round((30 + distanceKm * 0.12) * 100) / 100; // stima
    return { minutes, cost };
  }

  const speed = speeds[mode] || 50;
  const minutes = Math.round((distanceKm / speed) * 60);

  let cost = 0;
  if (mode === "car") cost = distanceKm * 0.20;
  else if (mode === "train") cost = 3 + distanceKm * 0.10;
  else if (mode === "bus") cost = 2.2 + distanceKm * 0.06;
  else cost = 0;

  cost = Math.round(cost * 100) / 100;
  return { minutes, cost };
}

/* ===================== RENDER ===================== */

function renderSuggestions(main, alternatives) {
  resultsEl.innerHTML = "";
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
  meta.textContent = `${d.typeLabel} • ${d.distanceKm.toFixed(1)} km • ~${d.est.minutes} min • ~€${d.est.cost}`;
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
    hint.textContent = "Tip: se non ti piace, scegli una alternativa 👇";
    wrap.appendChild(hint);
  }

  return wrap;
}

function openInMaps(d) {
  const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.lat + "," + d.lon)}`;
  window.open(url, "_blank");
}

/* ===================== POI “cosa fare lì” ===================== */

async function showThingsToDoNear(dest) {
  try {
    setStatus(`Cerco cosa fare vicino a “${dest.name}”…`);
    const items = await fetchNearbyPOI(dest.lat, dest.lon, 1500);

    const section = document.createElement("div");
    section.className = "panel";
    section.style.marginTop = "12px";

    const h3 = document.createElement("h3");
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
  nwr(around:${radiusMeters},${lat},${lon})["amenity"~"cafe|bar|restaurant|pub"];
  nwr(around:${radiusMeters},${lat},${lon})["tourism"~"attraction|museum|viewpoint"];
  nwr(around:${radiusMeters},${lat},${lon})["leisure"~"park|garden"];
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

  // dedup
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
