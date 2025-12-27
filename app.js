/**
 * JAMO v0.4 (GRATIS)
 * - GPS
 * - Overpass OSM (2 endpoint con fallback)
 * - Filtri: mezzo, tempo (select), budget (select), raggio fino 2000km, tipo meta, vibe
 * - Treno/Aereo: cerca hub vicino (stazione/aeroporto) + stima "arrivo al hub"
 * - Se non esiste hub: fallback automatico a Auto (con avviso)
 * - 1 meta + 3 alternative
 * - "Cosa fare lì" (POI vicino alla meta)
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

// Overpass endpoints (fallback)
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

    const radiusKm = Number(radiusEl.value);
    const radiusMeters = radiusKm * 1000;
    let mode = modeEl.value;

    const timeBudgetMin = parseOptionalNumber(timeEl.value); // min
    const budgetMax = parseOptionalNumber(budgetEl.value);   // €
    const placeType = placeTypeEl.value;
    const vibe = vibeEl.value;

    // 1) Hub handling per treno/aereo
    let hub = null;
    let hubNote = "";

    if (mode === "train") {
      setStatus("🚆 Cerco una stazione vicina…");
      hub = await findNearestHub(user.lat, user.lon, "train");
      if (!hub) {
        hubNote = "⚠️ Nessuna stazione vicina: uso AUTO come fallback.";
        mode = "car";
      }
    }

    if (mode === "plane") {
      setStatus("✈️ Cerco un aeroporto vicino…");
      hub = await findNearestHub(user.lat, user.lon, "plane");
      if (!hub) {
        hubNote = "⚠️ Nessun aeroporto vicino: uso AUTO come fallback.";
        mode = "car";
      }
    }

    // 2) Destinazioni
    setStatus(`🔎 Cerco mete (${labelType(placeType)}) entro ${radiusKm} km…`);
    const destinations = await fetchDestinations(user.lat, user.lon, radiusMeters, placeType, radiusKm);

    if (!destinations.length) {
      setStatus("Non ho trovato mete. Aumenta il raggio o cambia tipo meta.", true);
      return;
    }

    // 3) Score + stime
    let scored = destinations
      .map((d) => ({
        ...d,
        distanceKm: haversineKm(user.lat, user.lon, d.lat, d.lon),
      }))
      .map((d) => {
        const est = estimateTrip(d.distanceKm, mode, hub);
        const score = scoreDestination(d, placeType, vibe);
        return { ...d, est, score };
      })
      .sort((a, b) => b.score - a.score);

    // 4) Filtri: tempo e budget
    const filtered = scored.filter((d) => {
      if (timeBudgetMin != null && d.est.minutes > timeBudgetMin) return false;
      if (budgetMax != null && d.est.cost > budgetMax) return false;
      return true;
    });

    const finalList = filtered.length ? filtered : scored;

    if (!filtered.length) {
      setStatus("⚠️ Con questi filtri non esce nulla: ti mostro comunque le migliori mete (prova ad aumentare tempo/budget o raggio).", true);
    } else {
      setStatus("✅ Fatto.");
    }

    // 5) Output: 1 + 3 alternative
    const main = finalList[0];
    const alternatives = finalList.slice(1, 4);

    renderSuggestions(main, alternatives, {
      mode,
      hub,
      hubNote,
      timeBudgetMin,
      budgetMax,
      placeType,
      vibe,
      radiusKm
    });

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

/* ===================== OVERPASS: DESTINATIONS ===================== */

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

async function fetchDestinations(lat, lon, radiusMeters, placeType, radiusKm) {
  // Se il raggio è enorme, restringiamo un po' le query per evitare timeout:
  const huge = radiusKm >= 500;

  const block = buildPlaceTypeQuery(placeType, lat, lon, radiusMeters, huge);

  const query = `
[out:json][timeout:25];
(
  ${block}
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

  // per performance: se sono troppi, ne teniamo una quantità gestibile
  // (poi la scelta la fa lo scoring)
  return out.slice(0, 250);
}

function buildPlaceTypeQuery(placeType, lat, lon, r, huge) {
  // huge=true -> query più leggera
  const basePlaces = `
nwr(around:${r},${lat},${lon})["place"~"city|town|village"];
`;

  const culture = `
nwr(around:${r},${lat},${lon})["tourism"~"museum|gallery|attraction|viewpoint"];
nwr(around:${r},${lat},${lon})["historic"];
`;

  const nature = `
nwr(around:${r},${lat},${lon})["leisure"~"park|nature_reserve|garden"];
nwr(around:${r},${lat},${lon})["natural"~"peak|beach|spring|wood|cave|waterfall|bay"];
nwr(around:${r},${lat},${lon})["tourism"="viewpoint"];
`;

  const food = `
nwr(around:${r},${lat},${lon})["amenity"~"cafe|bar|restaurant|pub"];
`;

  const night = `
nwr(around:${r},${lat},${lon})["amenity"~"bar|pub|nightclub"];
`;

  const sea = `
nwr(around:${r},${lat},${lon})["natural"="beach"];
nwr(around:${r},${lat},${lon})["tourism"="viewpoint"];
`;

  const mountain = `
nwr(around:${r},${lat},${lon})["natural"="peak"];
nwr(around:${r},${lat},${lon})["route"="hiking"];
nwr(around:${r},${lat},${lon})["tourism"="viewpoint"];
`;

  const relax = `
nwr(around:${r},${lat},${lon})["amenity"="spa"];
nwr(around:${r},${lat},${lon})["leisure"="spa"];
nwr(around:${r},${lat},${lon})["amenity"="sauna"];
`;

  const family = `
nwr(around:${r},${lat},${lon})["tourism"~"zoo|theme_park"];
nwr(around:${r},${lat},${lon})["leisure"="park"];
`;

  const events = `
nwr(around:${r},${lat},${lon})["amenity"~"theatre|cinema"];
nwr(around:${r},${lat},${lon})["tourism"="attraction"];
`;

  // Se huge, evitiamo food+night (troppi risultati) e teniamo soprattutto città+cultura+natura
  if (huge) {
    if (placeType === "food") return `${basePlaces}\n${food}`; // ok, ma può essere tanto
    if (placeType === "night") return `${basePlaces}\n${night}`;
    if (placeType === "sea") return `${basePlaces}\n${sea}`;
    if (placeType === "mountain") return `${basePlaces}\n${mountain}`;
    if (placeType === "relax") return `${basePlaces}\n${relax}`;
    if (placeType === "family") return `${basePlaces}\n${family}`;
    if (placeType === "events") return `${basePlaces}\n${events}`;
    if (placeType === "culture") return `${basePlaces}\n${culture}`;
    if (placeType === "nature") return `${basePlaces}\n${nature}`;
    if (placeType === "city") return `${basePlaces}\n${culture}`;
    return `${basePlaces}\n${culture}\n${nature}`;
  }

  // normale (non huge)
  if (placeType === "city") return `${basePlaces}\n${culture}`;
  if (placeType === "sea") return sea;
  if (placeType === "mountain") return mountain;
  if (placeType === "nature") return nature;
  if (placeType === "culture") return culture;
  if (placeType === "food") return food;
  if (placeType === "relax") return relax;
  if (placeType === "family") return family;
  if (placeType === "night") return night;
  if (placeType === "events") return events;

  // any
  return `${basePlaces}\n${culture}\n${nature}\n${food}\n${night}`;
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

/* ===================== HUB: TRAIN / PLANE ===================== */

async function findNearestHub(lat, lon, hubType) {
  // hubType: "train" | "plane"
  const searchRadiusKm = hubType === "plane" ? 250 : 120;
  const r = searchRadiusKm * 1000;

  const hubQuery = hubType === "plane"
    ? `nwr(around:${r},${lat},${lon})["aeroway"~"aerodrome|airport"];`
    : `nwr(around:${r},${lat},${lon})["railway"="station"];`;

  const query = `
[out:json][timeout:25];
(
  ${hubQuery}
);
out center tags;
`;

  const json = await fetchOverpass(query);
  const els = Array.isArray(json.elements) ? json.elements : [];
  if (!els.length) return null;

  let best = null;
  let bestKm = Infinity;

  for (const e of els) {
    const cLat = e.lat ?? e.center?.lat;
    const cLon = e.lon ?? e.center?.lon;
    if (!cLat || !cLon) continue;

    const km = haversineKm(lat, lon, cLat, cLon);
    if (km < bestKm) {
      bestKm = km;
      const tags = e.tags || {};
      best = {
        name: tags.name || tags["name:it"] || (hubType === "plane" ? "Aeroporto" : "Stazione"),
        lat: cLat,
        lon: cLon,
        distanceKm: km,
        type: hubType
      };
    }
  }

  return best;
}

function estimateAccessToHub(kmToHub) {
  // stima gratuita per “arrivo al hub”
  if (kmToHub <= 1.5) {
    const minutes = Math.round((kmToHub / 4.5) * 60);
    return { mode: "walk", minutes, cost: 0 };
  }
  // trasferimento medio 30 km/h
  const minutes = Math.round((kmToHub / 30) * 60);
  const cost = round2(kmToHub * 0.20);
  return { mode: "transfer", minutes, cost };
}

/* ===================== SCORE + ESTIMATES ===================== */

function scoreDestination(d, placeType, vibe) {
  let s = 0;
  const km = d.distanceKm ?? 0;
  const tags = d.tags || {};

  if (tags.wikipedia) s += 4;
  if (tags.website) s += 2;
  if (tags.opening_hours) s += 1;
  if (d.name && d.name !== d.typeLabel) s += 2;

  // vibe
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
    if (km <= 15) s += 7; else if (km <= 80) s += 5; else s += 2;
  }

  // coerenza tipo meta
  if (placeType === "sea" && tags.natural === "beach") s += 8;
  if (placeType === "mountain" && (tags.natural === "peak" || tags.route === "hiking")) s += 8;
  if (placeType === "culture" && (tags.tourism === "museum" || tags.historic)) s += 8;
  if (placeType === "food" && tags.amenity) s += 8;
  if (placeType === "night" && (tags.amenity === "nightclub" || tags.amenity === "pub" || tags.amenity === "bar")) s += 8;

  s += Math.random() * 1.1;
  return s;
}

function estimateTrip(distanceKm, mode, hubInfo = null) {
  const speeds = {
    car: 55,
    train: 75,
    bus: 40,
    walk: 4.5,
    bike: 14,
    plane: 650
  };

  let access = { minutes: 0, cost: 0, label: "" };

  // accesso al hub (se presente)
  if ((mode === "train" || mode === "plane") && hubInfo) {
    const a = estimateAccessToHub(hubInfo.distanceKm);
    access.minutes = a.minutes + (mode === "train" ? 10 : 30); // attesa media
    access.cost = a.cost;
    access.label = mode === "plane"
      ? `Trasferimento a ${hubInfo.name} (~${hubInfo.distanceKm.toFixed(1)} km)`
      : `Verso ${hubInfo.name} (~${hubInfo.distanceKm.toFixed(1)} km)`;
  }

  if (mode === "plane") {
    const flightMinutes = Math.round((distanceKm / speeds.plane) * 60);
    const overhead = 120; // check-in, controlli, boarding ecc.
    const minutes = access.minutes + overhead + flightMinutes;
    const cost = round2(access.cost + 35 + distanceKm * 0.12);
    return { minutes, cost, flightMinutes, access };
  }

  const speed = speeds[mode] || 50;
  const rideMinutes = Math.round((distanceKm / speed) * 60);
  const minutes = access.minutes + rideMinutes;

  let cost = 0;
  if (mode === "car") cost = distanceKm * 0.20;
  else if (mode === "train") cost = 3 + distanceKm * 0.10;
  else if (mode === "bus") cost = 2.2 + distanceKm * 0.06;
  else cost = 0;

  cost = round2(cost + access.cost);
  return { minutes, cost, access };
}

function round2(x){ return Math.round(x * 100) / 100; }

/* ===================== RENDER ===================== */

function renderSuggestions(main, alternatives, ctx) {
  resultsEl.innerHTML = "";

  const summary = document.createElement("div");
  summary.className = "pill";
  const timeTxt = ctx.timeBudgetMin ? `⏱ ${ctx.timeBudgetMin} min` : "⏱ no limite";
  const budTxt = ctx.budgetMax ? `💶 €${ctx.budgetMax}` : "💶 no limite";
  summary.textContent = `${labelMode(ctx.mode)} • ${timeTxt} • ${budTxt} • ${labelType(ctx.placeType)} • ${labelVibe(ctx.vibe)} • raggio ${ctx.radiusKm}km`;
  resultsEl.appendChild(summary);

  if (ctx.hubNote) {
    const warn = document.createElement("div");
    warn.className = "pill";
    warn.textContent = ctx.hubNote;
    resultsEl.appendChild(warn);
  }

  if (ctx.hub && (ctx.mode === "train" || ctx.mode === "plane")) {
    const hubPill = document.createElement("div");
    hubPill.className = "pill";
    hubPill.textContent = `${ctx.mode === "plane" ? "✈️ Hub" : "🚆 Hub"}: ${ctx.hub.name} (~${ctx.hub.distanceKm.toFixed(1)} km)`;
    resultsEl.appendChild(hubPill);
  }

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
  const accessLine = d.est.access?.label ? `\n${d.est.access.label} • +${d.est.access.minutes} min • ~€${round2(d.est.access.cost)}` : "";

  meta.textContent =
    `${d.typeLabel} • ${d.distanceKm.toFixed(1)} km • ~${d.est.minutes} min${extraPlane} • ~€${round2(d.est.cost)}`
    + accessLine;

  wrap.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "actions";

  const btnMaps = document.createElement("button");
  btnMaps.className = "smallbtn";
  btnMaps.textContent = "Apri in Maps";
  btnMaps.onclick = () => openInMaps(d.lat, d.lon);
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
    hint.textContent = "Se non ti convince, scegli una alternativa 👇";
    wrap.appendChild(hint);
  }

  return wrap;
}

function openInMaps(lat, lon) {
  const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lon)}`;
  window.open(url, "_blank");
}

function labelMode(m){
  return ({car:"🚗 Auto",train:"🚆 Treno",bus:"🚌 Bus",bike:"🚲 Bici",walk:"🚶 A piedi",plane:"✈️ Aereo"})[m] || m;
}
function labelType(t){
  return ({any:"🎯 Tutto",city:"🏙️ Città",sea:"🏖️ Mare",mountain:"🏔️ Montagna",nature:"🌿 Natura",culture:"🏛️ Cultura",food:"🍝 Cibo",relax:"🧖 Relax",family:"👨‍👩‍👧 Famiglia",night:"🌙 Notte",events:"🎫 Eventi"})[t] || t;
}
function labelVibe(v){
  return ({any:"✨ Qualsiasi",quick:"⚡ Mordi e fuggi",chill:"🧘 Chill",adventure:"🧗 Avventura",romantic:"💘 Romantica"})[v] || v;
}

/* ===================== POI: COSA FARE LI' ===================== */

async function showThingsToDoNear(dest) {
  try {
    setStatus(`🔎 Cerco cosa fare vicino a “${dest.name}”…`);
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
        btn.onclick = () => openInMaps(it.lat, it.lon);
        box.appendChild(btn);

        section.appendChild(box);
      });
    }

    resultsEl.appendChild(section);
    setStatus("✅ Ecco alcune idee.");
  } catch (e) {
    console.error(e);
    setStatus("Errore nel cercare cosa fare lì: " + (e.message || e), true);
  }
}

async function fetchNearbyPOI(lat, lon, radiusMeters) {
  const query = `
[out:json][timeout:25];
(
  nwr(around:${radiusMeters},${lat},${lon})["tourism"~"attraction|museum|viewpoint|gallery|zoo|theme_park"];
  nwr(around:${radiusMeters},${lat},${lon})["amenity"~"cafe|bar|restaurant|pub|nightclub|spa"];
  nwr(around:${radiusMeters},${lat},${lon})["leisure"~"park|garden|spa"];
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
      name: name || inferType(tags),
      typeLabel: inferType(tags),
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

  return out.slice(0, 120);
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
