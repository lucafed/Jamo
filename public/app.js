/* app.js — Jamo PWA
   Obiettivo: far funzionare Family / Borghi / Storia + link utili + fallback macro
   Compatibile con macro arricchite (family_level / ideal_for / story_score / borgho / primary_category)
*/

const DATA = {
  macrosIndex: "/data/macros/macros_index.json",
  areas: "/data/areas.json",
};

const LS = {
  visited: "jamo_visited_v1",
  lastMacroId: "jamo_last_macro_id_v1",
  lastMacroPath: "jamo_last_macro_path_v1",
  lastCategory: "jamo_last_category_v1",
  lastStyleClassic: "jamo_last_style_classic_v1",
  lastStyleChicca: "jamo_last_style_chicca_v1",
  lastMinutes: "jamo_last_minutes_v1",
};

const state = {
  macrosIndex: null,      // { items: [...] } oppure array
  macro: null,            // macro json
  macroMeta: null,        // item da macros_index
  userPos: null,          // {lat,lng}
  category: "ovunque",
  wantClassic: true,
  wantChicca: false,
  minutes: 120,
};

// ---------- utils ----------
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function safeArr(x) { return Array.isArray(x) ? x : []; }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  return 2 * R * Math.asin(Math.sqrt(
    Math.sin(dLat/2)**2 +
    Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2
  ));
}

// stima “auto-only” semplice: media 55 km/h (più realistica di 60)
function kmToDriveMinutes(km) {
  const speed = 55;
  return Math.round((km / speed) * 60);
}

function getVisitedSet() {
  try {
    const raw = localStorage.getItem(LS.visited);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

function saveVisitedSet(set) {
  localStorage.setItem(LS.visited, JSON.stringify(Array.from(set)));
}

function setError(msg) {
  const box = $("#errorBox") || findBoxByText("Errore:");
  if (box) {
    box.style.display = "block";
    box.textContent = msg;
  } else {
    console.error(msg);
    alert(msg);
  }
}

function clearError() {
  const box = $("#errorBox") || findBoxByText("Errore:");
  if (box) box.style.display = "none";
}

function findButtonByText(needle) {
  const n = norm(needle);
  const btns = $all("button, a");
  return btns.find(b => norm(b.textContent).includes(n)) || null;
}

function findBoxByText(needle) {
  const n = norm(needle);
  const divs = $all("div, p, span");
  return divs.find(d => norm(d.textContent).includes(n)) || null;
}

function setResultHTML(html) {
  const out =
    $("#result") ||
    $("#risultato") ||
    findBoxByText("Risultato") ||
    document.body;
  // se è un contenitore generico (tipo card), cerchiamo un child dove mettere
  if (out && out !== document.body) {
    out.innerHTML = html;
    return;
  }
  // fallback: crea un contenitore
  let c = $("#_jamo_result");
  if (!c) {
    c = document.createElement("div");
    c.id = "_jamo_result";
    c.style.padding = "12px";
    document.body.appendChild(c);
  }
  c.innerHTML = html;
}

function getMinutesFromUI() {
  // prova input numerico comune
  const input =
    $("#minutes") ||
    $("#minuti") ||
    $("input[type='number']") ||
    $("input");
  const v = Number(input?.value || state.minutes);
  return clamp(Number.isFinite(v) ? v : state.minutes, 10, 480);
}

function readStyleFromUI() {
  // prova bottoni “Voglio classici / Voglio chicche”
  const classicBtn = findButtonByText("voglio classici");
  const chiccaBtn = findButtonByText("voglio chicche");

  // fallback su localStorage se non ci sono
  if (!classicBtn && !chiccaBtn) {
    state.wantClassic = localStorage.getItem(LS.lastStyleClassic) !== "0";
    state.wantChicca = localStorage.getItem(LS.lastStyleChicca) === "1";
    return;
  }

  // determiniamo “attivo” da classList/aria-pressed
  const classicOn =
    classicBtn?.classList?.contains("active") ||
    classicBtn?.getAttribute("aria-pressed") === "true" ||
    classicBtn?.classList?.contains("selected") ||
    true; // default

  const chiccaOn =
    chiccaBtn?.classList?.contains("active") ||
    chiccaBtn?.getAttribute("aria-pressed") === "true" ||
    chiccaBtn?.classList?.contains("selected") ||
    false;

  state.wantClassic = !!classicOn;
  state.wantChicca = !!chiccaOn;

  localStorage.setItem(LS.lastStyleClassic, state.wantClassic ? "1" : "0");
  localStorage.setItem(LS.lastStyleChicca, state.wantChicca ? "1" : "0");
}

function detectCategoryFromUI() {
  // Se c’è un gruppo di chip/bottoni, prendiamo quello “active”
  const chips = $all("button, .chip, .pill, a").filter(x => {
    const t = norm(x.textContent);
    return ["ovunque","borghi","mare","montagna","natura","storia","relax","family","citta"].some(k => t.includes(k));
  });

  const active = chips.find(c =>
    c.classList.contains("active") ||
    c.classList.contains("selected") ||
    c.getAttribute("aria-pressed") === "true"
  );

  if (active) {
    const t = norm(active.textContent);
    if (t.includes("borgh")) return "borghi";
    if (t.includes("mare")) return "mare";
    if (t.includes("montagn")) return "montagna";
    if (t.includes("natura")) return "natura";
    if (t.includes("storia")) return "storia";
    if (t.includes("relax")) return "relax";
    if (t.includes("family")) return "family";
    if (t.includes("citta")) return "citta";
    return "ovunque";
  }

  // fallback: localStorage
  const last = localStorage.getItem(LS.lastCategory);
  return last || state.category;
}

function saveCategory(cat) {
  state.category = cat;
  localStorage.setItem(LS.lastCategory, cat);
}

// ---------- data loading ----------
async function fetchJson(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return await r.json();
}

async function loadMacrosIndex() {
  const mi = await fetchJson(DATA.macrosIndex);
  const items = Array.isArray(mi) ? mi : (mi.items || mi.areas || mi.macros || []);
  state.macrosIndex = { raw: mi, items };
  return state.macrosIndex;
}

function pickBestExistingMacro(items) {
  // Priorità: euuk_macro_all -> euuk_country_it -> it_abruzzo -> primo che esiste
  const priority = [
    "euuk_macro_all",
    "euuk_country_it",
    "it_abruzzo",
  ];

  for (const id of priority) {
    const m = items.find(x => x.id === id);
    if (m?.path) return m;
  }
  // fallback: primo con path
  return items.find(x => x?.path) || null;
}

async function loadMacroWithFallback(preferred) {
  const items = state.macrosIndex?.items || [];
  const tries = [];

  if (preferred?.path) tries.push(preferred);
  // prova anche ultimo usato
  const lastPath = localStorage.getItem(LS.lastMacroPath);
  const lastId = localStorage.getItem(LS.lastMacroId);
  if (lastPath) tries.push({ id: lastId || "last", path: lastPath });

  // poi prova “best”
  const best = pickBestExistingMacro(items);
  if (best) tries.push(best);

  // poi prova tutti finché non trova uno che risponde 200
  for (const m of items) tries.push(m);

  const seen = new Set();
  for (const m of tries) {
    if (!m?.path) continue;
    if (seen.has(m.path)) continue;
    seen.add(m.path);

    try {
      const json = await fetchJson(m.path);
      state.macro = json;
      state.macroMeta = m;
      localStorage.setItem(LS.lastMacroPath, m.path);
      if (m.id) localStorage.setItem(LS.lastMacroId, m.id);
      return json;
    } catch (e) {
      // continua
    }
  }

  throw new Error("Nessuna macro caricabile. Controlla che i JSON esistano in public/data/macros/");
}

// ---------- category logic ----------
function placeVisibility(place) {
  const v = norm(place.visibility || place.visibilita || "");
  if (v.includes("conosci")) return "conosciuta";
  if (v.includes("chic")) return "chicca";
  // fallback con population o score
  const pop = Number(place.population || 0);
  if (pop > 60000) return "conosciuta";
  return "chicca";
}

function tagsSet(place) {
  const t = new Set();
  safeArr(place.tags).forEach(x => t.add(norm(x)));
  safeArr(place.types).forEach(x => t.add(norm(x)));
  if (place.type) t.add(norm(place.type));
  if (place.primary_category) t.add(norm(place.primary_category));
  return t;
}

function isFamily(place) {
  const tags = tagsSet(place);
  const ideal = safeArr(place.ideal_for).map(norm);
  const fl = norm(place.family_level || "");
  return (
    fl === "high" || fl === "medium" ||
    ideal.includes("famiglie") || ideal.includes("bambini") || ideal.includes("ragazzi") ||
    tags.has("family") || tags.has("famiglie") || tags.has("bambini") ||
    tags.has("parco") || tags.has("zoo") || tags.has("acquario") ||
    tags.has("divertimento") || tags.has("giochi") ||
    norm(place.name).includes("parco") || norm(place.name).includes("zoo") || norm(place.name).includes("aquarium")
  );
}

function isBorghi(place) {
  const tags = tagsSet(place);
  return (
    place.borgho === true ||
    tags.has("borghi") || tags.has("borgo") ||
    norm(place.name).includes("borgo") ||
    norm(place.name).includes("villaggio") ||
    norm(place.name).includes("old town")
  );
}

function isStoria(place) {
  const tags = tagsSet(place);
  const ss = Number(place.story_score || 0);
  const name = norm(place.name);
  return (
    ss >= 0.35 ||
    tags.has("storia") || tags.has("storico") ||
    tags.has("museo") || tags.has("museum") ||
    name.includes("castello") || name.includes("fortezza") || name.includes("abbazia") ||
    name.includes("duomo") || name.includes("cattedrale") ||
    name.includes("archeolog") || name.includes("roman") || name.includes("medieval")
  );
}

function matchesCategory(place, cat) {
  const tags = tagsSet(place);
  const pc = norm(place.primary_category || "");
  const tp = norm(place.type || "");

  if (cat === "ovunque") return true;

  if (cat === "family") return isFamily(place);
  if (cat === "borghi") return isBorghi(place);
  if (cat === "storia") return isStoria(place);

  // categorie “classiche”
  if (cat === "mare") return tags.has("mare") || pc === "mare" || tp === "mare" || norm(place.name).includes("spiaggia") || norm(place.name).includes("beach");
  if (cat === "montagna") return tags.has("montagna") || pc === "montagna" || tp === "montagna" || norm(place.name).includes("monte") || norm(place.name).includes("mount");
  if (cat === "natura") return tags.has("natura") || pc === "natura" || tp === "natura" || norm(place.name).includes("parco") || norm(place.name).includes("park");
  if (cat === "relax") return tags.has("relax") || pc === "relax" || tp === "relax" || norm(place.name).includes("terme") || norm(place.name).includes("spa");
  if (cat === "citta") return tags.has("citta") || pc === "citta" || tp === "citta" || norm(place.name).includes("city");

  return true;
}

function rankPlace(place, cat) {
  const score = Number(place.beauty_score || place.score || 0.5);
  const v = placeVisibility(place);
  const tags = tagsSet(place);

  let bonus = 0;
  // boost matching
  if (cat !== "ovunque") bonus += 0.08;

  // family boost
  if (cat === "family") {
    const fl = norm(place.family_level || "");
    if (fl === "high") bonus += 0.12;
    if (fl === "medium") bonus += 0.08;
  }

  // borghi boost
  if (cat === "borghi" && (place.borgho === true || tags.has("borgo") || tags.has("borghi"))) bonus += 0.10;

  // storia boost
  if (cat === "storia") {
    const ss = Number(place.story_score || 0);
    bonus += clamp(ss, 0, 1) * 0.12;
  }

  // preferenze stile
  if (state.wantClassic && v === "conosciuta") bonus += 0.06;
  if (state.wantChicca && v === "chicca") bonus += 0.06;

  // se vogliono solo uno stile, penalizza l’altro
  if (state.wantClassic && !state.wantChicca && v === "chicca") bonus -= 0.05;
  if (state.wantChicca && !state.wantClassic && v === "conosciuta") bonus -= 0.05;

  return score + bonus;
}

// ---------- links ----------
function enc(s) { return encodeURIComponent(String(s || "")); }

function linksFor(place) {
  const name = place.name || "";
  const lat = Number(place.lat ?? place.latitude ?? place.lonlat?.[0]);
  const lng = Number(place.lon ?? place.lng ?? place.longitude ?? place.lonlat?.[1]);

  const q = `${name}`;
  const qNear = lat && lng ? `${name} ${lat},${lng}` : name;

  const googleSearch = `https://www.google.com/search?q=${enc(q)}`;
  const wiki = `https://it.wikipedia.org/wiki/${enc(name.replace(/\s+/g, "_"))}`;
  const images = `https://www.google.com/search?tbm=isch&q=${enc(q)}`;

  // Maps
  const mapsPlace = lat && lng
    ? `https://www.google.com/maps/search/?api=1&query=${enc(lat + "," + lng)}`
    : `https://www.google.com/maps/search/?api=1&query=${enc(q)}`;

  const mapsDirections = lat && lng
    ? `https://www.google.com/maps/dir/?api=1&destination=${enc(lat + "," + lng)}&travelmode=driving`
    : `https://www.google.com/maps/dir/?api=1&destination=${enc(q)}&travelmode=driving`;

  // Attrazioni / ticketing (sempre su pagine “search” che non vanno in 404)
  const tiqets = `https://www.tiqets.com/en/search/?query=${enc(q)}`;
  const gyg = `https://www.getyourguide.com/s/?q=${enc(q)}`;

  // Ristoranti vicino (Google Maps search)
  const restaurants = lat && lng
    ? `https://www.google.com/maps/search/${enc("ristoranti")}/@${lat},${lng},14z`
    : `https://www.google.com/maps/search/?api=1&query=${enc("ristoranti " + q)}`;

  // Eventi (senza API): Google + Eventbrite
  const eventsGoogle = `https://www.google.com/search?q=${enc("eventi vicino " + q)}`;
  const eventbrite = `https://www.eventbrite.com/d/italy--${enc(name.toLowerCase().replace(/\s+/g, "-"))}/events/`;

  // Trasporti monetizzabili (sempre link “generici” con query)
  const flights = `https://www.google.com/search?q=${enc("voli per " + q)}`;
  const trains = `https://www.google.com/search?q=${enc("treni per " + q)}`;
  const bus = `https://www.google.com/search?q=${enc("bus per " + q)}`;

  // WhatsApp share
  const shareText = `Hai visto questa meta su Jamo: ${name} — ${mapsPlace}`;
  const whatsapp = `https://wa.me/?text=${enc(shareText)}`;

  return {
    googleSearch, wiki, images,
    mapsPlace, mapsDirections,
    tiqets, gyg,
    restaurants,
    eventsGoogle, eventbrite,
    flights, trains, bus,
    whatsapp
  };
}

// ---------- render ----------
function pill(text, href) {
  return `<a class="jamo-pill" href="${href}" target="_blank" rel="noopener">${text}</a>`;
}

function renderPlace(place, km, mins) {
  const L = linksFor(place);
  const v = placeVisibility(place);
  const tags = safeArr(place.tags).slice(0, 10);

  const fam = isFamily(place);
  const bor = isBorghi(place);
  const sto = isStoria(place);

  const familyLine = fam ? `👨‍👩‍👧‍👦 Consigliato per famiglie` : `👤 Adatto a tutti`;
  const extraFlags = [
    bor ? "🏘️ borgo" : null,
    sto ? "🏛️ storia" : null,
  ].filter(Boolean).join(" • ");

  return `
  <div class="jamo-card">
    <div class="jamo-title">${place.name || "Meta"}</div>
    <div class="jamo-sub">
      🚗 ${mins} min • ${km.toFixed(1)} km • ${v}${extraFlags ? " • " + extraFlags : ""}
    </div>

    <div class="jamo-why">
      ${familyLine}
      ${place.why ? `<div style="opacity:.9;margin-top:6px;">${safeArr(place.why).slice(0,3).map(x=>`• ${x}`).join("<br>")}</div>` : ""}
    </div>

    <div class="jamo-pills">
      ${pill("👀 Cosa vedere", L.googleSearch)}
      ${pill("🎯 Cosa fare", L.gyg)}
      ${pill("📷 Foto", L.images)}
      ${pill("🍝 Ristoranti", L.restaurants)}
      ${pill("📚 Wiki", L.wiki)}
    </div>

    <div class="jamo-pills">
      ${pill("🗺️ Maps", L.mapsPlace)}
      ${pill("🧭 Percorso", L.mapsDirections)}
      ${pill("🎟️ Biglietti", L.tiqets)}
      ${pill("🎪 Eventi", L.eventsGoogle)}
    </div>

    <div class="jamo-pills">
      ${pill("✈️ Voli", L.flights)}
      ${pill("🚆 Treni", L.trains)}
      ${pill("🚌 Bus", L.bus)}
      ${pill("🟢 WhatsApp", L.whatsapp)}
    </div>

    ${tags.length ? `<div class="jamo-tags"># ${tags.join(" • ")}</div>` : ""}
    <button id="btnVisited" class="jamo-visited">✅ Segna come visitato</button>
  </div>
  `;
}

// inject minimal css if missing
function ensureCss() {
  if ($("#_jamo_css")) return;
  const s = document.createElement("style");
  s.id = "_jamo_css";
  s.textContent = `
    .jamo-card{background:#141C22;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:14px;margin-top:12px}
    .jamo-title{font-size:20px;font-weight:700;color:#fff}
    .jamo-sub{margin-top:6px;color:#A0B2BA;font-size:14px}
    .jamo-why{margin-top:10px;color:#fff;font-size:14px;opacity:.95}
    .jamo-pills{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
    .jamo-pill{display:inline-flex;align-items:center;justify-content:center;padding:10px 12px;border-radius:12px;
      background:rgba(0,224,255,.10);border:1px solid rgba(0,224,255,.35);color:#fff;text-decoration:none;font-weight:700}
    .jamo-pill:active{transform:scale(.98)}
    .jamo-tags{margin-top:10px;color:#A0B2BA;font-size:12px}
    .jamo-visited{margin-top:12px;width:100%;padding:12px;border-radius:12px;border:0;background:#00B5CC;color:#001015;font-weight:900}
  `;
  document.head.appendChild(s);
}

// ---------- main logic ----------
async function getUserLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 60000 }
    );
  });
}

function extractPlacesFromMacro(m) {
  // support diversi formati
  if (!m) return [];
  if (Array.isArray(m.places)) return m.places;
  if (Array.isArray(m.items)) return m.items;
  if (m.data && Array.isArray(m.data.places)) return m.data.places;
  return [];
}

async function ensureMacroLoaded() {
  clearError();
  if (!state.macrosIndex) await loadMacrosIndex();
  if (!state.macro) {
    // prova macro dal select (se esiste)
    const preferredId = localStorage.getItem(LS.lastMacroId);
    const preferred = state.macrosIndex.items.find(x => x.id === preferredId) || null;

    try {
      await loadMacroWithFallback(preferred);
    } catch (e) {
      setError(`Errore: impossibile caricare una macro. (${e.message})`);
      throw e;
    }
  }
}

function pickCandidate(places, cat) {
  const visited = getVisitedSet();

  // serve posizione per calcolo km/min
  const up = state.userPos;

  const filtered = [];
  for (const p of places) {
    if (!p || !p.name) continue;

    const lat = Number(p.lat ?? p.latitude);
    const lng = Number(p.lon ?? p.lng ?? p.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    if (visited.has(p.id)) continue;

    if (!matchesCategory(p, cat)) continue;

    let km = 0;
    let mins = 9999;
    if (up) {
      km = haversineKm(up.lat, up.lng, lat, lng);
      mins = kmToDriveMinutes(km);
      if (mins > state.minutes) continue;
    } else {
      // se non abbiamo posizione: non filtriamo per minuti, ma mettiamo mins 0
      mins = 0;
      km = 0;
    }

    filtered.push({ place: p, km, mins, r: rankPlace(p, cat) });
  }

  // se Family / Borghi / Storia non trova nulla, fallback soft su “ovunque” ma con preferenze
  if (!filtered.length && (cat === "family" || cat === "borghi" || cat === "storia")) {
    for (const p of places) {
      if (!p || !p.name) continue;

      const lat = Number(p.lat ?? p.latitude);
      const lng = Number(p.lon ?? p.lng ?? p.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      if (visited.has(p.id)) continue;

      // fallback “simili”: usa tags/score
      const ok =
        (cat === "family" && (isFamily(p) || tagsSet(p).has("parco") || tagsSet(p).has("bambini"))) ||
        (cat === "borghi" && (isBorghi(p) || norm(p.name).includes("centro storico"))) ||
        (cat === "storia" && (isStoria(p) || tagsSet(p).has("museo")));

      if (!ok) continue;

      let km = 0;
      let mins = 9999;
      if (up) {
        km = haversineKm(up.lat, up.lng, lat, lng);
        mins = kmToDriveMinutes(km);
        if (mins > state.minutes) continue;
      } else {
        mins = 0; km = 0;
      }

      filtered.push({ place: p, km, mins, r: rankPlace(p, cat) - 0.05 });
    }
  }

  filtered.sort((a,b) => b.r - a.r);
  return filtered[0] || null;
}

async function onFind() {
  ensureCss();

  // aggiorna stato da UI
  state.minutes = getMinutesFromUI();
  localStorage.setItem(LS.lastMinutes, String(state.minutes));

  readStyleFromUI();
  const cat = detectCategoryFromUI();
  saveCategory(cat);

  // posizione
  state.userPos = await getUserLocation();

  // macro
  await ensureMacroLoaded();

  const places = extractPlacesFromMacro(state.macro);

  if (!places.length) {
    setError("Errore: la macro caricata non contiene places.");
    return;
  }

  const cand = pickCandidate(places, state.category);

  if (!cand) {
    setResultHTML(`
      <div class="jamo-card">
        <div class="jamo-title">Nessuna meta trovata</div>
        <div class="jamo-sub">Prova ad aumentare i minuti o scegliere “Ovunque”.</div>
      </div>
    `);
    return;
  }

  setResultHTML(renderPlace(cand.place, cand.km, cand.mins));

  // visited button
  const btn = $("#btnVisited");
  if (btn) {
    btn.onclick = () => {
      const s = getVisitedSet();
      s.add(cand.place.id);
      saveVisitedSet(s);
      btn.textContent = "✅ Salvato tra i visitati";
      btn.disabled = true;
    };
  }
}

function onResetVisited() {
  localStorage.removeItem(LS.visited);
  clearError();
  setResultHTML(`
    <div class="jamo-card">
      <div class="jamo-title">Visitati resettati ✅</div>
      <div class="jamo-sub">Ora puoi rivedere tutte le mete.</div>
    </div>
  `);
}

function wireUI() {
  // Bottone TROVAMI LA META
  const findBtn =
    $("#btnFind") ||
    $("#trovaMeta") ||
    findButtonByText("trovami la meta") ||
    findButtonByText("trova") ||
    null;

  if (findBtn) findBtn.addEventListener("click", onFind);

  // Reset visitati
  const resetBtn =
    $("#btnReset") ||
    findButtonByText("reset visitati") ||
    findButtonByText("reset") ||
    null;

  if (resetBtn) resetBtn.addEventListener("click", onResetVisited);

  // categoria chip -> salva in localStorage e trigger find
  const cats = [
    { key:"ovunque",  match:["ovunque"] },
    { key:"borghi",   match:["borghi","borg"] },
    { key:"mare",     match:["mare","spiaggia"] },
    { key:"montagna", match:["montagna","monte"] },
    { key:"natura",   match:["natura","parchi","parco"] },
    { key:"storia",   match:["storia"] },
    { key:"relax",    match:["relax","terme","spa"] },
    { key:"family",   match:["family","fam"] },
    { key:"citta",    match:["citta","città","city"] },
  ];

  const btns = $all("button, .chip, .pill, a");
  btns.forEach(b => {
    const t = norm(b.textContent);
    const hit = cats.find(c => c.match.some(m => t.includes(norm(m))));
    if (!hit) return;

    b.addEventListener("click", () => {
      saveCategory(hit.key);
      // non forziamo il find automatico, ma lo puoi attivare se vuoi:
      // onFind();
    });
  });

  // ripristina minutes se possibile
  const m = Number(localStorage.getItem(LS.lastMinutes));
  if (Number.isFinite(m)) {
    const input =
      $("#minutes") || $("#minuti") || $("input[type='number']");
    if (input) input.value = String(m);
    state.minutes = clamp(m, 10, 480);
  }

  // cat restore
  const lastCat = localStorage.getItem(LS.lastCategory);
  if (lastCat) state.category = lastCat;
}

// bootstrap
(async function init() {
  try {
    wireUI();
    await loadMacrosIndex(); // non blocca, ma prepara
  } catch (e) {
    console.error(e);
  }
})();
