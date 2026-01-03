/* app.js — Jamo PWA (SAFE UI)
   - Non sovrascrive mai contenitori grandi: usa un mount dedicato per i risultati.
   - Family / Borghi / Storia con fallback robusti.
*/

const DATA = {
  macrosIndex: "/data/macros/macros_index.json",
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
  macrosIndex: null, // { items: [...] }
  macro: null,
  macroMeta: null,
  userPos: null,
  category: "ovunque",
  wantClassic: true,
  wantChicca: false,
  minutes: 120,
};

// ---------------- utils ----------------
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

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  return 2 * R * Math.asin(Math.sqrt(
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  ));
}

function kmToDriveMinutes(km) {
  const speed = 55;
  return Math.round((km / speed) * 60);
}

function getVisitedSet() {
  try {
    const raw = localStorage.getItem(LS.visited);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveVisitedSet(set) {
  localStorage.setItem(LS.visited, JSON.stringify(Array.from(set)));
}

function findButtonByText(needle) {
  const n = norm(needle);
  const btns = $all("button, a");
  return btns.find(b => norm(b.textContent).includes(n)) || null;
}

// ---------------- UI: result mount (NO BREAK) ----------------
function ensureResultMount() {
  // se esiste già, perfetto
  let mount = $("#jamoResultMount");
  if (mount) return mount;

  // prova id “result” classici (ma NON sostituiamo mai il contenitore, solo appendiamo dentro un mount)
  const existing =
    $("#resultMount") ||
    $("#result-mount") ||
    $("#result_content") ||
    $("#resultContent");

  if (existing) {
    mount = existing;
    mount.id = "jamoResultMount";
    return mount;
  }

  // prova a trovare la sezione “Risultato” e inserire sotto (senza toccare bottoni sopra)
  const allEls = $all("h1,h2,h3,div,p,span");
  const header = allEls.find(el => norm(el.textContent) === "risultato") || null;

  mount = document.createElement("div");
  mount.id = "jamoResultMount";
  mount.style.marginTop = "12px";

  if (header && header.parentElement) {
    // inseriamo DOPO il blocco "Risultato" senza distruggere nulla
    header.parentElement.appendChild(mount);
  } else {
    // fallback: metti in fondo alla pagina
    document.body.appendChild(mount);
  }

  return mount;
}

function setResultHTML(html) {
  const mount = ensureResultMount();
  mount.innerHTML = html;
}

function setError(msg) {
  // se hai già una box errore, usala
  const box = $("#errorBox") || $("#error") || null;
  if (box) {
    box.style.display = "block";
    box.textContent = msg;
    return;
  }
  console.error(msg);
  // non alertare sempre: meglio log
}

function clearError() {
  const box = $("#errorBox") || $("#error") || null;
  if (box) box.style.display = "none";
}

// ---------------- CSS (solo classi Jamo, non tocca i tuoi bottoni) ----------------
function ensureCss() {
  if ($("#_jamo_css_safe")) return;
  const s = document.createElement("style");
  s.id = "_jamo_css_safe";
  s.textContent = `
    .jamo-card{background:#141C22;border:1px solid rgba(255,255,255,.10);border-radius:16px;padding:14px}
    .jamo-title{font-size:20px;font-weight:800;color:#fff}
    .jamo-sub{margin-top:6px;color:#A0B2BA;font-size:14px}
    .jamo-why{margin-top:10px;color:#fff;font-size:14px;opacity:.95}
    .jamo-pills{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
    .jamo-pill{display:inline-flex;align-items:center;justify-content:center;padding:10px 12px;border-radius:12px;
      background:rgba(0,224,255,.10);border:1px solid rgba(0,224,255,.35);color:#fff;text-decoration:none;font-weight:800}
    .jamo-tags{margin-top:10px;color:#A0B2BA;font-size:12px}
    .jamo-visited{margin-top:12px;width:100%;padding:12px;border-radius:12px;border:0;background:#00B5CC;color:#001015;font-weight:900}
    .jamo-muted{color:#A0B2BA}
  `;
  document.head.appendChild(s);
}

// ---------------- data loading ----------------
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

function pickBestMacro(items) {
  const priority = ["euuk_macro_all", "euuk_country_it", "it_abruzzo"];
  for (const id of priority) {
    const m = items.find(x => x.id === id);
    if (m?.path) return m;
  }
  return items.find(x => x?.path) || null;
}

async function loadMacroWithFallback() {
  const items = state.macrosIndex?.items || [];
  const tries = [];

  const lastPath = localStorage.getItem(LS.lastMacroPath);
  const lastId = localStorage.getItem(LS.lastMacroId);
  if (lastPath) tries.push({ id: lastId || "last", path: lastPath });

  const best = pickBestMacro(items);
  if (best) tries.push(best);

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
    } catch (_) {
      // continua
    }
  }
  throw new Error("Nessuna macro caricabile.");
}

function extractPlacesFromMacro(m) {
  if (!m) return [];
  if (Array.isArray(m.places)) return m.places;
  if (Array.isArray(m.items)) return m.items;
  if (m.data && Array.isArray(m.data.places)) return m.data.places;
  return [];
}

// ---------------- category logic ----------------
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
  const n = norm(place.name);
  return (
    fl === "high" || fl === "medium" ||
    ideal.includes("famiglie") || ideal.includes("bambini") || ideal.includes("ragazzi") ||
    tags.has("family") || tags.has("famiglie") || tags.has("bambini") ||
    tags.has("parco") || tags.has("zoo") || tags.has("acquario") ||
    n.includes("parco") || n.includes("zoo") || n.includes("aquarium")
  );
}

function isBorghi(place) {
  const tags = tagsSet(place);
  const n = norm(place.name);
  return (
    place.borgho === true ||
    tags.has("borgo") || tags.has("borghi") ||
    n.includes("borgo") || n.includes("centro storico") || n.includes("old town")
  );
}

function isStoria(place) {
  const tags = tagsSet(place);
  const ss = Number(place.story_score || 0);
  const n = norm(place.name);
  return (
    ss >= 0.35 ||
    tags.has("storia") || tags.has("storico") ||
    tags.has("museo") || tags.has("museum") ||
    n.includes("castello") || n.includes("abbazia") || n.includes("duomo") ||
    n.includes("archeolog") || n.includes("roman") || n.includes("medieval")
  );
}

function matchesCategory(place, cat) {
  const tags = tagsSet(place);
  const pc = norm(place.primary_category || "");
  const tp = norm(place.type || "");
  const n = norm(place.name);

  if (cat === "ovunque") return true;
  if (cat === "family") return isFamily(place);
  if (cat === "borghi") return isBorghi(place);
  if (cat === "storia") return isStoria(place);

  if (cat === "mare") return tags.has("mare") || pc === "mare" || tp === "mare" || n.includes("spiaggia") || n.includes("beach");
  if (cat === "montagna") return tags.has("montagna") || pc === "montagna" || tp === "montagna" || n.includes("monte") || n.includes("mount");
  if (cat === "natura") return tags.has("natura") || pc === "natura" || tp === "natura" || n.includes("parco") || n.includes("park");
  if (cat === "relax") return tags.has("relax") || pc === "relax" || tp === "relax" || n.includes("terme") || n.includes("spa");
  if (cat === "citta") return tags.has("citta") || pc === "citta" || tp === "citta" || n.includes("city");

  return true;
}

function placeVisibility(place) {
  const v = norm(place.visibility || place.visibilita || "");
  if (v.includes("conosci")) return "conosciuta";
  if (v.includes("chic")) return "chicca";
  const pop = Number(place.population || 0);
  if (pop > 60000) return "conosciuta";
  return "chicca";
}

function rankPlace(place, cat) {
  const base = Number(place.beauty_score || place.score || 0.55);
  const v = placeVisibility(place);
  const tags = tagsSet(place);

  let bonus = 0;

  // preferenze stile
  if (state.wantClassic && v === "conosciuta") bonus += 0.06;
  if (state.wantChicca && v === "chicca") bonus += 0.06;

  // categoria bonus
  if (cat === "family") {
    const fl = norm(place.family_level || "");
    if (fl === "high") bonus += 0.14;
    if (fl === "medium") bonus += 0.09;
    if (tags.has("bambini") || tags.has("famiglie")) bonus += 0.05;
  }
  if (cat === "borghi" && (place.borgho === true || tags.has("borgo") || tags.has("borghi"))) bonus += 0.10;
  if (cat === "storia") bonus += clamp(Number(place.story_score || 0), 0, 1) * 0.12;

  return base + bonus;
}

// ---------------- links ----------------
function enc(s) { return encodeURIComponent(String(s || "")); }

function linksFor(place) {
  const name = place.name || "";
  const lat = Number(place.lat ?? place.latitude);
  const lng = Number(place.lon ?? place.lng ?? place.longitude);

  const q = name;

  const mapsPlace = (Number.isFinite(lat) && Number.isFinite(lng))
    ? `https://www.google.com/maps/search/?api=1&query=${enc(lat + "," + lng)}`
    : `https://www.google.com/maps/search/?api=1&query=${enc(q)}`;

  const mapsDirections = (Number.isFinite(lat) && Number.isFinite(lng))
    ? `https://www.google.com/maps/dir/?api=1&destination=${enc(lat + "," + lng)}&travelmode=driving`
    : `https://www.google.com/maps/dir/?api=1&destination=${enc(q)}&travelmode=driving`;

  const images = `https://www.google.com/search?tbm=isch&q=${enc(q)}`;
  const gyg = `https://www.getyourguide.com/s/?q=${enc(q)}`;
  const tiqets = `https://www.tiqets.com/en/search/?query=${enc(q)}`;
  const restaurants = `https://www.google.com/maps/search/?api=1&query=${enc("ristoranti " + q)}`;
  const eventsGoogle = `https://www.google.com/search?q=${enc("eventi vicino " + q)}`;

  return { mapsPlace, mapsDirections, images, gyg, tiqets, restaurants, eventsGoogle };
}

function pill(text, href) {
  return `<a class="jamo-pill" href="${href}" target="_blank" rel="noopener">${text}</a>`;
}

function renderPlace(place, km, mins) {
  const L = linksFor(place);
  const v = placeVisibility(place);
  const tags = safeArr(place.tags).slice(0, 10);

  const extra = [
    isFamily(place) ? "👨‍👩‍👧‍👦 family" : null,
    isBorghi(place) ? "🏘️ borghi" : null,
    isStoria(place) ? "🏛️ storia" : null,
  ].filter(Boolean).join(" • ");

  return `
    <div class="jamo-card">
      <div class="jamo-title">${place.name || "Meta"}</div>
      <div class="jamo-sub">🚗 ${mins} min • ${km.toFixed(1)} km • ${v}${extra ? " • " + extra : ""}</div>

      <div class="jamo-why">
        ${safeArr(place.why).length ? safeArr(place.why).slice(0,3).map(x=>`• ${x}`).join("<br>") : `<span class="jamo-muted">Suggerimento rapido: apri Maps e guarda “Cosa fare nei dintorni”.</span>`}
      </div>

      <div class="jamo-pills">
        ${pill("🗺️ Maps", L.mapsPlace)}
        ${pill("🧭 Percorso", L.mapsDirections)}
        ${pill("🎯 Cosa fare", L.gyg)}
        ${pill("🎟️ Biglietti", L.tiqets)}
        ${pill("🍝 Ristoranti", L.restaurants)}
        ${pill("🎪 Eventi", L.eventsGoogle)}
        ${pill("📷 Foto", L.images)}
      </div>

      ${tags.length ? `<div class="jamo-tags"># ${tags.join(" • ")}</div>` : ""}

      <button id="btnVisited" class="jamo-visited">✅ Segna come visitato</button>
    </div>
  `;
}

// ---------------- read UI safely ----------------
function getMinutesFromUI() {
  const input = $("#minutes") || $("#minuti") || $("input[type='number']");
  const v = Number(input?.value || localStorage.getItem(LS.lastMinutes) || state.minutes);
  return clamp(Number.isFinite(v) ? v : state.minutes, 10, 480);
}

function readStyleFromUI() {
  // prova a capire se hai bottoni “classici/chicche”, altrimenti usa localStorage
  const classicBtn = findButtonByText("voglio classici");
  const chiccaBtn = findButtonByText("voglio chicche");

  const classicOn = localStorage.getItem(LS.lastStyleClassic);
  const chiccaOn = localStorage.getItem(LS.lastStyleChicca);

  state.wantClassic = classicOn === null ? true : classicOn === "1";
  state.wantChicca = chiccaOn === "1";

  // se ci sono i bottoni, prova a leggere “active/selected”
  if (classicBtn) {
    const on =
      classicBtn.classList.contains("active") ||
      classicBtn.classList.contains("selected") ||
      classicBtn.getAttribute("aria-pressed") === "true";
    // se non troviamo indicatori, non sovrascriviamo
    if (classicBtn.classList.contains("active") || classicBtn.classList.contains("selected") || classicBtn.getAttribute("aria-pressed") !== null) {
      state.wantClassic = !!on;
      localStorage.setItem(LS.lastStyleClassic, state.wantClassic ? "1" : "0");
    }
  }

  if (chiccaBtn) {
    const on =
      chiccaBtn.classList.contains("active") ||
      chiccaBtn.classList.contains("selected") ||
      chiccaBtn.getAttribute("aria-pressed") === "true";
    if (chiccaBtn.classList.contains("active") || chiccaBtn.classList.contains("selected") || chiccaBtn.getAttribute("aria-pressed") !== null) {
      state.wantChicca = !!on;
      localStorage.setItem(LS.lastStyleChicca, state.wantChicca ? "1" : "0");
    }
  }
}

function detectCategoryFromUI() {
  // 1) se già salvata
  const last = localStorage.getItem(LS.lastCategory);
  if (last) state.category = last;

  // 2) prova a leggere da chip “active/selected” senza forzare nulla
  const candidates = $all("button, a, .chip, .pill");
  const active = candidates.find(el =>
    el.classList.contains("active") ||
    el.classList.contains("selected") ||
    el.getAttribute("aria-pressed") === "true"
  );

  if (!active) return state.category;

  const t = norm(active.textContent);
  if (t.includes("borgh")) return "borghi";
  if (t.includes("mare")) return "mare";
  if (t.includes("montagn")) return "montagna";
  if (t.includes("natura")) return "natura";
  if (t.includes("storia")) return "storia";
  if (t.includes("relax")) return "relax";
  if (t.includes("family")) return "family";
  if (t.includes("citta") || t.includes("città")) return "citta";
  return "ovunque";
}

function saveCategory(cat) {
  state.category = cat;
  localStorage.setItem(LS.lastCategory, cat);
}

// ---------------- location ----------------
async function getUserLocation() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 6500, maximumAge: 60000 }
    );
  });
}

// ---------------- main find ----------------
function pickCandidate(places, cat) {
  const visited = getVisitedSet();
  const up = state.userPos;

  const scored = [];

  for (const p of places) {
    if (!p?.name) continue;

    const lat = Number(p.lat ?? p.latitude);
    const lng = Number(p.lon ?? p.lng ?? p.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    if (visited.has(p.id)) continue;
    if (!matchesCategory(p, cat)) continue;

    let km = 0;
    let mins = 0;

    if (up) {
      km = haversineKm(up.lat, up.lng, lat, lng);
      mins = kmToDriveMinutes(km);
      if (mins > state.minutes) continue;
    }

    scored.push({ place: p, km, mins, r: rankPlace(p, cat) });
  }

  // fallback soft: se family/borghi/storia vuoto, prova “ovunque ma con indizi”
  if (!scored.length && (cat === "family" || cat === "borghi" || cat === "storia")) {
    for (const p of places) {
      if (!p?.name) continue;

      const lat = Number(p.lat ?? p.latitude);
      const lng = Number(p.lon ?? p.lng ?? p.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      if (visited.has(p.id)) continue;

      const ok =
        (cat === "family" && isFamily(p)) ||
        (cat === "borghi" && isBorghi(p)) ||
        (cat === "storia" && isStoria(p));

      if (!ok) continue;

      let km = 0;
      let mins = 0;
      if (up) {
        km = haversineKm(up.lat, up.lng, lat, lng);
        mins = kmToDriveMinutes(km);
        if (mins > state.minutes) continue;
      }

      scored.push({ place: p, km, mins, r: rankPlace(p, cat) - 0.03 });
    }
  }

  scored.sort((a, b) => b.r - a.r);
  return scored[0] || null;
}

async function onFind() {
  ensureCss();
  clearError();

  state.minutes = getMinutesFromUI();
  localStorage.setItem(LS.lastMinutes, String(state.minutes));

  readStyleFromUI();
  saveCategory(detectCategoryFromUI());

  state.userPos = await getUserLocation();

  if (!state.macrosIndex) await loadMacrosIndex();
  if (!state.macro) await loadMacroWithFallback();

  const places = extractPlacesFromMacro(state.macro);
  if (!places.length) {
    setError("Errore: la macro caricata non contiene places.");
    setResultHTML(`<div class="jamo-card"><div class="jamo-title">Nessuna meta</div><div class="jamo-sub">Macro vuota o formato non supportato.</div></div>`);
    return;
  }

  const cand = pickCandidate(places, state.category);

  if (!cand) {
    setResultHTML(`
      <div class="jamo-card">
        <div class="jamo-title">Nessuna meta trovata</div>
        <div class="jamo-sub">Prova ad aumentare i minuti o mettere “Ovunque”.</div>
      </div>
    `);
    return;
  }

  setResultHTML(renderPlace(cand.place, cand.km, cand.mins));

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
  setResultHTML(`
    <div class="jamo-card">
      <div class="jamo-title">Visitati resettati ✅</div>
      <div class="jamo-sub">Ora puoi rivedere tutte le mete.</div>
    </div>
  `);
}

// ---------------- wire UI (solo click, non modifica layout) ----------------
function wireUI() {
  // trova bottone “TROVAMI LA META”
  const findBtn =
    $("#btnFind") ||
    $("#trovaMeta") ||
    findButtonByText("trovami la meta") ||
    null;

  if (findBtn) findBtn.addEventListener("click", onFind);

  // reset
  const resetBtn =
    $("#btnReset") ||
    findButtonByText("reset visitati") ||
    null;

  if (resetBtn) resetBtn.addEventListener("click", onResetVisited);

  // salva categoria al click (non forza find)
  const cats = [
    { key: "ovunque",  match: ["ovunque"] },
    { key: "borghi",   match: ["borghi","borg"] },
    { key: "mare",     match: ["mare","spiaggia"] },
    { key: "montagna", match: ["montagna","monte"] },
    { key: "natura",   match: ["natura","parco","parchi"] },
    { key: "storia",   match: ["storia"] },
    { key: "relax",    match: ["relax","terme","spa"] },
    { key: "family",   match: ["family","fam"] },
    { key: "citta",    match: ["citta","città","city"] },
  ];

  const clickables = $all("button, a, .chip, .pill");
  clickables.forEach(el => {
    const t = norm(el.textContent);
    const hit = cats.find(c => c.match.some(m => t.includes(norm(m))));
    if (!hit) return;
    el.addEventListener("click", () => saveCategory(hit.key));
  });
}

// bootstrap
(function init() {
  try {
    wireUI();
    // preload index (non blocca)
    loadMacrosIndex().catch(()=>{});
    // prepara il mount senza rompere niente
    ensureResultMount();
  } catch (e) {
    console.error(e);
  }
})();
