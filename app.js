/* Jamo app.js — v0.4 (GPS + distanza reale + mete demo) */

const VERSION = "0.4";
const $ = (id) => document.getElementById(id);

// IDs da index.html
const btnTrip = $("btnTrip");
const slot = $("slot");
const meta = $("meta");
const cta = $("cta");
const mapsLink = $("mapsLink");
const ticketsLink = $("ticketsLink");
const installBtn = $("installBtn");
const ver = $("ver");
if (ver) ver.textContent = VERSION;

// --- Filtri (se presenti in index.html) ---
function readFilters() {
  return {
    time: $("f_time")?.value ?? "any",
    mode: $("f_mode")?.value ?? "any",
    vibe: $("f_vibe")?.value ?? "any",
    budget: $("f_budget")?.value ?? "any",
  };
}

// --- Utility: Haversine distanza in km ---
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// --- GPS (salvato in localStorage) ---
const GEO_KEY = "jamo_geo_v1";

function getSavedGeo() {
  try {
    const raw = localStorage.getItem(GEO_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj?.lat || !obj?.lon) return null;
    return obj;
  } catch {
    return null;
  }
}

function saveGeo(lat, lon) {
  localStorage.setItem(GEO_KEY, JSON.stringify({ lat, lon, ts: Date.now() }));
}

function getGeoOnce() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocalizzazione non supportata."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        saveGeo(lat, lon);
        resolve({ lat, lon });
      },
      (err) => reject(err),
      {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 60_000,
      }
    );
  });
}

// --- CTA ---
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

function disable(disabled) {
  if (btnTrip) btnTrip.disabled = disabled;
}

// --- Effetto slot ---
function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function spin(poolTexts, finalText, finalMeta) {
  disable(true);
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
  disable(false);
}

// --- DESTINAZIONI DEMO (per test) ---
// Domani le sostituiamo con "tutte le mete" via API (OpenTripMap).
const DESTINATIONS = [
  {
    id: "roma",
    name: "Roma",
    range: "far",
    vibe: ["cultura", "cibo", "party", "relax"],
    modes: ["train", "bus", "plane", "car"],
    coords: { lat: 41.9028, lng: 12.4964 },
    why: "Arte, passeggiate infinite, cibo ovunque.",
    todo: ["Pantheon + Centro", "Trastevere", "Fori/Colosseo", "Tevere al tramonto"],
    tickets: "/go?type=city&dest=roma",
  },
  {
    id: "perugia",
    name: "Perugia",
    range: "mid",
    vibe: ["borghi", "cultura", "cibo", "relax"],
    modes: ["train", "bus", "car"],
    coords: { lat: 43.1107, lng: 12.3908 },
    why: "Centro storico e vibe tranquilla.",
    todo: ["Centro + corso", "Panorama", "Aperitivo", "Musei/mostre"],
    tickets: "/go?type=city&dest=perugia",
  },
  {
    id: "firenze",
    name: "Firenze",
    range: "far",
    vibe: ["cultura", "cibo", "relax"],
    modes: ["train", "bus", "car"],
    coords: { lat: 43.7696, lng: 11.2558 },
    why: "Centro compatto e bellissimo, perfetto anche in giornata.",
    todo: ["Duomo + centro", "Ponte Vecchio", "Piazzale Michelangelo", "Uffizi/Accademia"],
    tickets: "/go?type=city&dest=firenze",
  },
];

// --- Filtri meta (semplici) ---
function filterDestinations(f) {
  let pool = [...DESTINATIONS];

  if (f.mode !== "any") pool = pool.filter((d) => d.modes.includes(f.mode));
  if (f.vibe !== "any") pool = pool.filter((d) => d.vibe.includes(f.vibe));

  // tempo -> limita range (semplice)
  if (f.time !== "any") {
    const t = Number(f.time);
    if (t <= 60) pool = pool.filter((d) => d.range !== "far");
    // 120: ok mid, 240/480: tutto
  }

  return pool;
}

function mapsUrlFor(dest) {
  const { lat, lng } = dest.coords || {};
  if (lat == null || lng == null) return "#";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat + "," + lng)}`;
}

function buildMeta(dest, geo) {
  const todoTop = dest.todo?.slice(0, 3)?.join(" • ") || "";
  let distText = "";
  if (geo?.lat && geo?.lon) {
    const km = haversineKm(geo.lat, geo.lon, dest.coords.lat, dest.coords.lng);
    distText = `📏 Distanza: ~${km.toFixed(0)} km  •  `;
  }
  return `${distText}${dest.why}\nCosa fare lì: ${todoTop}`;
}

// --- CORE: DOVE ANDIAMO? (con GPS) ---
async function decideWhere() {
  const f = readFilters();

  // 1) prendi geo (da cache) oppure chiedi GPS
  let geo = getSavedGeo();
  if (!geo) {
    slot.textContent = "📍 Serve la tua posizione per consigliarti mete vicine. Consenti il GPS…";
    meta.textContent = "";
    try {
      geo = await getGeoOnce(); // richiede permesso (serve gesto: il click sul bottone)
    } catch (err) {
      // Se rifiuta, continuiamo comunque (ma avvisiamo)
      slot.textContent = "Ok, niente GPS. Ti propongo una meta comunque (meno precisa).";
      geo = null;
    }
  }

  // 2) filtra mete (demo) — domani qui chiameremo l’API “tutte le mete”
  let pool = filterDestinations(f);
  if (!pool.length) {
    slot.textContent = "Non trovo mete con questi filtri 😅 Metti “Qualsiasi”.";
    meta.textContent = "";
    setCTA({ show: false });
    return;
  }

  // 3) Se ho GPS, ordino per distanza (vicine prima)
  if (geo?.lat && geo?.lon) {
    pool.sort((a, b) => {
      const da = haversineKm(geo.lat, geo.lon, a.coords.lat, a.coords.lng);
      const db = haversineKm(geo.lat, geo.lon, b.coords.lat, b.coords.lng);
      return da - db;
    });
  }

  const chosen = pool[0]; // top pick (la più vicina tra le filtrate)
  const poolTexts = pool.slice(0, 10).map((d) => `📍 ${d.name}`);

  await spin(
    poolTexts,
    `📍 Vai a ${chosen.name}`,
    buildMeta(chosen, geo)
  );

  // CTA
  setCTA({
    show: true,
    mapsUrl: mapsUrlFor(chosen),
    ticketsUrl: chosen.tickets || `/go?type=tickets&dest=${encodeURIComponent(chosen.id)}`
  });
}

btnTrip?.addEventListener("click", decideWhere);

// --- PWA Install ---
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

// --- Service worker ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
