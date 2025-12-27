/**
 * JAMO v0.2 – Gratis, GPS, 1 meta + alternative
 * Dati luoghi: OpenStreetMap via Overpass API
 *
 * Nota: Overpass è pubblico → usalo “gentilmente” (non fare 50 richieste al secondo).
 */

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const resultsEl = $("results");
const btnGo = $("btnGo");
const radiusEl = $("radiusKm");
const modeEl = $("mode");
const budgetEl = $("budget");

let lastPosition = null;
let lastSuggestions = [];

btnGo.addEventListener("click", async () => {
  try {
    resultsEl.innerHTML = "";
    setStatus("Richiedo il GPS…");

    btnGo.disabled = true;

    const pos = await getCurrentPosition({ enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
    lastPosition = { lat: pos.coords.latitude, lon: pos.coords.longitude };

    setStatus(`Ok. Posizione acquisita. Cerco mete entro ${radiusEl.value} km…`);

    const radiusMeters = Number(radiusEl.value) * 1000;
    const mode = modeEl.value;
    const budget = parseBudget(budgetEl.value);

    // 1) Trova mete "destinazione"
    const destinations = await fetchDestinations(lastPosition.lat, lastPosition.lon, radiusMeters);

    if (!destinations.length) {
      setStatus("Non ho trovato mete. Prova ad aumentare il raggio.", true);
      return;
    }

    // 2) Punteggio + filtro budget (stimato)
    const scored = destinations
      .map((d) => ({
        ...d,
        distanceKm: haversineKm(lastPosition.lat, lastPosition.lon, d.lat, d.lon),
      }))
      .map((d) => ({
        ...d,
        score: scoreDestination(d),
        est: estimateTrip(d.distanceKm, mode),
      }))
      .filter((d) => (budget == null ? true : d.est.cost <= budget))
      .sort((a, b) => b.score - a.score);

    if (!scored.length) {
      setStatus("Trovate mete, ma nessuna rientra nel budget impostato. Aumenta il budget o cambia mezzo.", true);
      return;
    }

    // 3) Seleziona 1 principale + 3 alternative
    const main = scored[0];
    const alternatives = scored.slice(1, 4);

    lastSuggestions = [main, ...alternatives];

    renderSuggestions(main, alternatives);

    setStatus("Fatto ✅ Scegli una meta o apri Maps. Vuoi che Jamo ti dica cosa fare lì?");

  } catch (err) {
    console.error(err);
    if (String(err).includes("denied")) {
      setStatus("GPS negato. Attiva la posizione e consenti l’accesso al sito.", true);
    } else {
      setStatus("Errore: " + (err?.message || String(err)), true);
    }
  } finally {
    btnGo.disabled = false;
  }
});

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.className = isError ? "error" : "muted";
}

function parseBudget(value) {
  const v = Number(String(value || "").trim());
  if (!Number.isFinite(v) || v <= 0) return null;
  return v;
}

/**
 * Overpass: cerchiamo mete “da visitare”
 * (tourism, natural, historic, leisure, viewpoint, beach ecc.)
 */
async function fetchDestinations(lat, lon, radiusMeters) {
  const overpassUrl = "https://overpass-api.de/api/interpreter";

  // Query: prendo nodi+way+relation, poi centroide
  // Se vuoi “più città” possiamo aggiungere place=town/village ma rischi di spammare.
  const query = `
[out:json][timeout:25];
(
  nwr(around:${radiusMeters},${lat},${lon})["tourism"~"attraction|museum|gallery|zoo|theme_park|viewpoint|information"];
  nwr(around:${radiusMeters},${lat},${lon})["historic"];
  nwr(around:${radiusMeters},${lat},${lon})["natural"~"peak|beach|spring|wood|cave|waterfall|bay"];
  nwr(around:${radiusMeters},${lat},${lon})["leisure"~"park|nature_reserve|garden"];
);
out center tags;
`;

  const res = await fetch(overpassUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
    },
    body: "data=" + encodeURIComponent(query),
  });

  if (!res.ok) throw new Error("Overpass non risponde (" + res.status + ")");

  const json = await res.json();
  const els = Array.isArray(json.elements) ? json.elements : [];

  // Normalizza in {name, typeLabel, lat, lon}
  const parsed = els
    .map((e) => {
      const tags = e.tags || {};
      const name = tags.name || tags["name:it"] || null;

      const cLat = e.lat ?? e.center?.lat;
      const cLon = e.lon ?? e.center?.lon;
      if (!cLat || !cLon) return null;

      const typeLabel = inferType(tags);
      const id = `${e.type}/${e.id}`;

      return {
        id,
        name: name || typeLabel, // se manca nome, usa il tipo
        typeLabel,
        lat: cLat,
        lon: cLon,
        tags
      };
    })
    .filter(Boolean);

  // De-dup basico per coordinate + nome
  const seen = new Set();
  const dedup = [];
  for (const d of parsed) {
    const key = `${d.name}|${d.lat.toFixed(5)}|${d.lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(d);
  }

  return dedup;
}

function inferType(tags) {
  const t = tags.tourism;
  const n = tags.natural;
  const h = tags.historic;
  const l = tags.leisure;

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
  if (n === "wood") return "Bosco";
  if (n === "cave") return "Grotta";
  return "Luogo da visitare";
}

/**
 * Punteggio: un mix di “vicino ma non troppo”, interesse, presenza di tag utili.
 * (Regole semplici, ma già buone per V2)
 */
function scoreDestination(d) {
  let s = 0;

  // base: preferisci 2–25km (dipende da radius), ma non scartare
  const km = d.distanceKm ?? 0;
  if (km < 1) s += 2;
  else if (km <= 5) s += 8;
  else if (km <= 15) s += 10;
  else if (km <= 40) s += 7;
  else s += 4;

  const tags = d.tags || {};
  if (tags.wikipedia) s += 4;
  if (tags.website) s += 2;
  if (tags.opening_hours) s += 1;

  // interessi
  if (tags.tourism === "museum") s += 5;
  if (tags.tourism === "viewpoint") s += 4;
  if (tags.natural) s += 3;
  if (tags.historic) s += 3;
  if (tags.leisure === "park" || tags.leisure === "nature_reserve") s += 3;

  // “nome vero” (non generico)
  if (d.name && d.name !== d.typeLabel) s += 2;

  // un pizzico di random controllato per effetto sorpresa
  s += Math.random() * 1.2;

  return s;
}

/**
 * Stima tempo/costo (GRATIS) – senza API a pagamento.
 * È una stima: per costi reali al 100% servirebbero API trasporti (spesso a pagamento).
 */
function estimateTrip(distanceKm, mode) {
  // velocità medie
  const speeds = {
    car: 55,    // km/h medio
    train: 70,
    bus: 40,
    walk: 4.5,
    bike: 14
  };
  const speed = speeds[mode] || 50;
  const hours = distanceKm / speed;
  const minutes = Math.round(hours * 60);

  // costo stimato
  let cost = 0;

  if (mode === "car") {
    // stima “tutto incluso” (carburante+usura) molto indicativa
    // 0.20 €/km è prudente ma realistico come ordine di grandezza
    cost = distanceKm * 0.20;
  } else if (mode === "train") {
    // stima: base + €/km (indicativa)
    cost = 3 + distanceKm * 0.10;
  } else if (mode === "bus") {
    cost = 2.2 + distanceKm * 0.06;
  } else if (mode === "walk") {
    cost = 0;
  } else if (mode === "bike") {
    cost = 0;
  }

  // arrotonda
  cost = Math.round(cost * 100) / 100;

  return { minutes, cost };
}

function renderSuggestions(main, alternatives) {
  resultsEl.innerHTML = "";

  const top = buildDestinationCard("Meta consigliata", main, true);
  resultsEl.appendChild(top);

  if (alternatives.length) {
    const div = document.createElement("div");
    div.className = "divider";
    resultsEl.appendChild(div);

    const h = document.createElement("div");
    h.className = "pill";
    h.textContent = "Alternative";
    resultsEl.appendChild(h);

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

  const btnWhatToDo = document.createElement("button");
  btnWhatToDo.className = "smallbtn";
  btnWhatToDo.textContent = "Cosa fare lì";
  btnWhatToDo.onclick = async () => {
    await showThingsToDoNear(d);
  };
  actions.appendChild(btnWhatToDo);

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
  const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.lat + "," + d.lon)}&query_place_id=`;
  window.open(url, "_blank");
}

/**
 * Cosa fare lì: usiamo Overpass di nuovo, ma con raggio piccolo (es. 1200m)
 * cerchiamo: bar/ristoranti/attrazioni/parchi
 */
async function showThingsToDoNear(dest) {
  try {
    setStatus(`Cerco cosa fare vicino a “${dest.name}”…`);

    const items = await fetchNearbyPOI(dest.lat, dest.lon, 1200);

    const section = document.createElement("div");
    section.className = "panel";
    section.style.marginTop = "12px";

    const h3 = document.createElement("h3");
    h3.textContent = `Cosa fare vicino a ${dest.name}`;
    section.appendChild(h3);

    if (!items.length) {
      const p = document.createElement("div");
      p.className = "muted";
      p.textContent = "Non ho trovato POI vicini (o Overpass è lento). Prova di nuovo.";
      section.appendChild(p);
    } else {
      const ul = document.createElement("div");
      ul.className = "muted";
      ul.style.display = "grid";
      ul.style.gap = "10px";

      items.slice(0, 8).forEach((it) => {
        const box = document.createElement("div");
        box.className = "dest";
        box.style.marginTop = "0";

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

        ul.appendChild(box);
      });

      section.appendChild(ul);
    }

    // Inserisci sotto i risultati
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

  const parsed = els
    .map((e) => {
      const tags = e.tags || {};
      const name = tags.name || tags["name:it"] || null;
      const cLat = e.lat ?? e.center?.lat;
      const cLon = e.lon ?? e.center?.lon;
      if (!cLat || !cLon) return null;

      const typeLabel = inferPOIType(tags);
      return {
        id: `${e.type}/${e.id}`,
        name: name || typeLabel,
        typeLabel,
        lat: cLat,
        lon: cLon,
        tags
      };
    })
    .filter(Boolean);

  // dedup
  const seen = new Set();
  const out = [];
  for (const p of parsed) {
    const key = `${p.name}|${p.lat.toFixed(5)}|${p.lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }

  // un po' di ordine: priorità attrazioni/musei, poi cibo, poi parchi
  out.sort((a, b) => poiRank(b.tags) - poiRank(a.tags));

  return out;
}

function inferPOIType(tags) {
  const a = tags.amenity;
  const t = tags.tourism;
  const l = tags.leisure;

  if (t === "museum") return "Museo";
  if (t === "viewpoint") return "Belvedere";
  if (t === "attraction") return "Attrazione";
  if (a === "restaurant") return "Ristorante";
  if (a === "cafe") return "Caffè";
  if (a === "bar") return "Bar";
  if (a === "pub") return "Pub";
  if (l === "park") return "Parco";
  if (l === "garden") return "Giardino";
  return "Punto d’interesse";
}

function poiRank(tags) {
  if (tags.tourism === "attraction") return 5;
  if (tags.tourism === "museum") return 5;
  if (tags.tourism === "viewpoint") return 4;
  if (tags.amenity) return 3;
  if (tags.leisure) return 2;
  return 1;
}

/** Geolocation Promise wrapper */
function getCurrentPosition(options) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

/** Haversine km */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
function deg2rad(deg) {
  return deg * (Math.PI / 180);
}
