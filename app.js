/* Jamo app.js — v0.3 (luoghi + cosa fare lì) */

const VERSION = "0.3";
const $ = (id) => document.getElementById(id);

// IDs che devono esistere in index.html
const btnTrip = $("btnTrip");     // DOVE ANDIAMO?
const btnLocal = $("btnLocal");   // COSA FACCIO QUI VICINO? (extra)
const slot = $("slot");
const meta = $("meta");
const cta = $("cta");
const mapsLink = $("mapsLink");
const ticketsLink = $("ticketsLink");
const installBtn = $("installBtn");
const ver = $("ver");

if (ver) ver.textContent = VERSION;

/* ---------- DATI: DESTINAZIONI (ESMPIO ITALIA GENERICA) ---------- */
/**
 * range: near | mid | far
 * vibe: natura | borghi | cibo | cultura | relax | party
 * modes: car | train | bus | plane
 * coords: lat/lng (per link Maps)
 */
const DESTINATIONS = [
  {
    id: "roma",
    name: "Roma",
    range: "far",
    vibe: ["cultura", "cibo", "party", "relax"],
    modes: ["train", "bus", "plane", "car"],
    coords: { lat: 41.9028, lng: 12.4964 },
    times: { car: "~2–5h", train: "~1–4h", bus: "~2–6h", plane: "~1h + transfer" },
    why: "Classico intramontabile: arte, passeggiate e cibo.",
    todo: ["Pantheon + Centro", "Trastevere al tramonto", "Fori/Colosseo", "Gelato + Tevere"],
    tickets: "/go?type=city&dest=roma"
  },
  {
    id: "firenze",
    name: "Firenze",
    range: "far",
    vibe: ["cultura", "cibo", "relax"],
    modes: ["train", "bus", "car"],
    coords: { lat: 43.7696, lng: 11.2558 },
    times: { car: "~2–5h", train: "~1–4h", bus: "~2–5h" },
    why: "Centro compatto e bellissimo, perfetto anche in giornata.",
    todo: ["Duomo + centro", "Ponte Vecchio", "Piazzale Michelangelo", "Uffizi/Accademia"],
    tickets: "/go?type=city&dest=firenze"
  },
  {
    id: "napoli",
    name: "Napoli",
    range: "far",
    vibe: ["cibo", "cultura", "party"],
    modes: ["train", "bus", "plane", "car"],
    coords: { lat: 40.8518, lng: 14.2681 },
    times: { car: "~2–6h", train: "~1–4h", bus: "~2–7h", plane: "~1h + transfer" },
    why: "Energia pazzesca e cibo leggendario.",
    todo: ["Spaccanapoli", "Lungomare", "Pizza seria", "Museo Archeologico"],
    tickets: "/go?type=city&dest=napoli"
  },
  {
    id: "bologna",
    name: "Bologna",
    range: "mid",
    vibe: ["cibo", "cultura", "party"],
    modes: ["train", "bus", "car"],
    coords: { lat: 44.4949, lng: 11.3426 },
    times: { car: "~2–4h", train: "~1–3h", bus: "~2–4h" },
    why: "Portici, cibo top, serata facile.",
    todo: ["Due Torri", "Portici + centro", "Mercato/osteria", "San Luca (se hai tempo)"],
    tickets: "/go?type=city&dest=bologna"
  },
  {
    id: "venezia",
    name: "Venezia",
    range: "far",
    vibe: ["cultura", "relax"],
    modes: ["train", "bus", "plane", "car"],
    coords: { lat: 45.4408, lng: 12.3155 },
    times: { car: "~3–7h", train: "~2–6h", bus: "~3–7h", plane: "~1h + transfer" },
    why: "Unica al mondo: cammini e ti perdi (in senso buono).",
    todo: ["Rialto", "San Marco", "Bacari & cicchetti", "Murano/Burano se hai tempo"],
    tickets: "/go?type=city&dest=venezia"
  },
  {
    id: "perugia",
    name: "Perugia",
    range: "mid",
    vibe: ["borghi", "cultura", "cibo", "relax"],
    modes: ["train", "bus", "car"],
    coords: { lat: 43.1107, lng: 12.3908 },
    times: { car: "~1–3h", train: "~1–3h", bus: "~1–3h" },
    why: "Centro storico e vibe tranquilla: perfetta per staccare.",
    todo: ["Centro + corso", "Panorama", "Aperitivo", "Musei/mostre"],
    tickets: "/go?type=city&dest=perugia"
  },
];

/* ---------- EXTRA: IDEE VICINO CASA (opzionale) ---------- */
const LOCAL_IDEAS = [
  { text: "Passeggiata 20 minuti: scegli una direzione e non cambiare finché suona il timer.", vibe:["relax"], budget:0, time:30 },
  { text: "Vai in un bar nuovo a 10–15 minuti e prenditi un caffè/gelato.", vibe:["cibo"], budget:10, time:60 },
  { text: "Micro-giro panoramico: punto alto vicino + foto obbligatoria.", vibe:["natura","relax"], budget:0, time:120 },
  { text: "Serata evento: cinema/mostra/live. Scegli il primo che ti ispira.", vibe:["cultura","party"], budget:30, time:240 }
];

/* ---------- FILTRI (dal tuo index.html) ---------- */
function readFilters() {
  const time = $("f_time")?.value ?? "any";     // any | 30 | 120 | 240 | 480
  const mode = $("f_mode")?.value ?? "any";     // any | car | train | bus | plane
  const vibe = $("f_vibe")?.value ?? "any";     // any | natura | borghi | cibo | cultura | relax | party
  const budget = $("f_budget")?.value ?? "any"; // any | 0 | 10 | 30 | 100
  return { time, mode, vibe, budget };
}

/* ---------- UTILS ---------- */
function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function setCTA({ show, mapsUrl, ticketsUrl }) {
  if (!cta) return;
  if (!show) {
    cta.hidden = true;
    if (mapsLink) mapsLink.href = "#";
    if (ticketsLink) ticketsLink.href = "#";
    return;
  }
  cta.hidden = false;
  if (mapsLink) mapsLink.href = mapsUrl || "#";
  if (ticketsLink) ticketsLink.href = ticketsUrl || "#";
}

function disableButtons(disabled) {
  if (btnTrip) btnTrip.disabled = disabled;
  if (btnLocal) btnLocal.disabled = disabled;
}

/* ---------- SLOT EFFECT ---------- */
async function spin(poolTexts, finalText, finalMeta) {
  disableButtons(true);
  setCTA({ show: false });

  const ticks = 18;
  for (let i = 0; i < ticks; i++) {
    slot.textContent = pickOne(poolTexts);
    meta.textContent = "Jamo sta scegliendo…";
    navigator.vibrate?.(10);
    await new Promise((r) => setTimeout(r, 40 + i * i * 6));
  }

  slot.textContent = finalText;
  meta.textContent = finalMeta || "";
  disableButtons(false);
}

/* ---------- CORE: DOVE ANDIAMO? ---------- */
function filterDestinations(f) {
  let pool = [...DESTINATIONS];

  // filtro per mezzo
  if (f.mode !== "any") {
    pool = pool.filter(d => d.modes.includes(f.mode));
  }

  // filtro vibe
  if (f.vibe !== "any") {
    pool = pool.filter(d => d.vibe.includes(f.vibe));
  }

  // filtro tempo (semplice, per range)
  // 30 => niente far (solo near/mid), 120 => mid ok, 240/480 => tutto
  if (f.time !== "any") {
    const t = Number(f.time);
    if (t <= 60) pool = pool.filter(d => d.range !== "far");
    else if (t <= 120) pool = pool.filter(d => d.range !== "far" || d.range === "mid");
    // sopra 240 lasciamo tutto
  }

  return pool;
}

function buildMetaForDestination(dest, mode) {
  const times = dest.times || {};
  const parts = [];

  // mostra tempo sul mezzo scelto (se selezionato), altrimenti car+train
  if (mode !== "any" && times[mode]) {
    const emoji = mode === "car" ? "🚗" : mode === "train" ? "🚆" : mode === "bus" ? "🚌" : "✈️";
    parts.push(`${emoji} ${mode}: ${times[mode]}`);
  } else {
    if (times.car) parts.push(`🚗 ${times.car}`);
    if (times.train) parts.push(`🚆 ${times.train}`);
    if (parts.length === 0) parts.push("Tempi: da stimare");
  }

  const todoTop = dest.todo?.slice(0, 3)?.join(" • ") || "Idee: da aggiungere";
  return `${dest.why}  •  ${parts.join("  •  ")}\nCosa fare lì: ${todoTop}`;
}

function mapsUrlFor(dest) {
  const { lat, lng } = dest.coords || {};
  if (lat == null || lng == null) return "#";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lng)}`;
}

async function decideWhere() {
  const f = readFilters();
  const pool = filterDestinations(f);

  if (!pool.length) {
    slot.textContent = "Non trovo mete con questi filtri 😅 Prova a mettere “Qualsiasi”.";
    meta.textContent = "";
    setCTA({ show: false });
    return;
  }

  const chosen = pickOne(pool);

  // slot text list (nomi città)
  const poolTexts = pool.map(d => `📍 ${d.name}`);

  const finalText = `📍 Vai a ${chosen.name}`;
  const finalMeta = buildMetaForDestination(chosen, f.mode);

  await spin(poolTexts, finalText, finalMeta);

  // CTA: Maps + Biglietti (placeholder /go)
  setCTA({
    show: true,
    mapsUrl: mapsUrlFor(chosen),
    ticketsUrl: chosen.tickets || `/go?type=tickets&dest=${encodeURIComponent(chosen.id)}`
  });
}

/* ---------- EXTRA: COSA FACCIO QUI VICINO? (opzionale) ---------- */
function filterLocalIdeas(f) {
  let pool = [...LOCAL_IDEAS];

  if (f.time !== "any") {
    const t = Number(f.time);
    pool = pool.filter(x => x.time <= t);
  }
  if (f.vibe !== "any") {
    pool = pool.filter(x => x.vibe.includes(f.vibe));
  }
  if (f.budget !== "any") {
    const b = Number(f.budget);
    pool = pool.filter(x => x.budget <= b);
  }
  return pool;
}

async function decideLocal() {
  const f = readFilters();
  const pool = filterLocalIdeas(f);

  if (!pool.length) {
    slot.textContent = "Con questi filtri non trovo un’idea vicino casa 😅 Metti “Qualsiasi”.";
    meta.textContent = "";
    setCTA({ show: false });
    return;
  }

  const chosen = pickOne(pool);
  const poolTexts = pool.map(x => `🏠 ${x.text}`);

  await spin(
    poolTexts,
    `🏠 Idea vicino casa`,
    `${chosen.text}  •  ⏱️ ${chosen.time} min  •  💶 €${chosen.budget}`
  );

  // CTA nascosta per idee locali
  setCTA({ show: false });
}

/* ---------- EVENTI ---------- */
btnTrip?.addEventListener("click", decideWhere);
btnLocal?.addEventListener("click", decideLocal);

/* ---------- PWA INSTALL ---------- */
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (installBtn) installBtn.hidden = false;
});

installBtn?.addEventListener("click", async () => {
  if (!deferredPrompt) {
    alert("Su Android: menu ⋮ del browser → 'Aggiungi a schermata Home'.");
    return;
  }
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  if (installBtn) installBtn.hidden = true;
});

/* ---------- SERVICE WORKER ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
