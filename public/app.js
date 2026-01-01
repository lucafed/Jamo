// app.js — UI controller (Auto-only) — v1.0

const QUICK_TIMES = [30, 60, 90, 120, 180, 240];

const CATEGORIES = [
  { id: "ovunque", label: "Ovunque 🎲" },
  { id: "chicca", label: "Chicche ✨" },
  { id: "borgo", label: "Borghi 🏘️" },
  { id: "mare", label: "Mare 🌊" },
  { id: "montagna", label: "Montagna 🏔️" },
  { id: "natura", label: "Natura 🌿" },
  { id: "storia", label: "Storia 🏛️" },
  { id: "relax", label: "Relax 🧖" },
  { id: "bambini", label: "Family 👨‍👩‍👧‍👦" },
];

let state = {
  category: "ovunque",
  style: "gems", // gems|known
};

const $ = (id) => document.getElementById(id);

function showMsg(text) {
  const el = $("msg");
  if (!text) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  el.style.display = "block";
  el.textContent = text;
}

function renderQuickTimes() {
  const host = $("quickTimes");
  host.innerHTML = "";
  QUICK_TIMES.forEach((t) => {
    const b = document.createElement("button");
    b.className = "pill";
    b.textContent = `${t} min`;
    b.onclick = () => {
      $("minutes").value = String(t);
      document.querySelectorAll(".pill").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
    };
    if (Number($("minutes").value) === t) b.classList.add("active");
    host.appendChild(b);
  });
}

function renderCats() {
  const host = $("cats");
  host.innerHTML = "";
  CATEGORIES.forEach((c) => {
    const b = document.createElement("button");
    b.className = "cat";
    b.textContent = c.label;
    if (state.category === c.id) b.classList.add("active");
    b.onclick = () => {
      state.category = c.id;
      renderCats();
    };
    host.appendChild(b);
  });
}

function setStyle(style) {
  state.style = style;
  $("styleGems").classList.toggle("active", style === "gems");
  $("styleKnown").classList.toggle("active", style === "known");
}

async function findPlace() {
  showMsg("");

  const originLabel = $("originLabel").value.trim();
  const lat = Number($("originLat").value);
  const lon = Number($("originLon").value);
  const minutes = Number($("minutes").value);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return showMsg("Lat/Lon non validi.");
  if (!Number.isFinite(minutes) || minutes <= 0) return showMsg("Minuti non validi.");

  $("goBtn").disabled = true;
  $("goBtn").textContent = "Sto scegliendo…";

  try {
    const r = await fetch("/api/jamo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        origin: { lat, lon, label: originLabel },
        minutes,
        mode: "car",
        category: state.category,
        style: state.style,
        visitedIds: [],
        weekIds: [],
      }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error || "Errore API");

    if (!data?.top) {
      $("result").style.display = "none";
      showMsg(data?.message || "Nessuna meta trovata.");
      return;
    }

    renderResult(data.top, data.alternatives || []);
  } catch (e) {
    $("result").style.display = "none";
    showMsg(String(e?.message || e));
  } finally {
    $("goBtn").disabled = false;
    $("goBtn").textContent = "🎯 TROVAMI LA META";
  }
}

function renderResult(top, alts) {
  $("result").style.display = "block";

  $("topCard").innerHTML = `
    <div class="top-title">${escapeHtml(top.name)}</div>
    <div class="badges">
      <span class="badge">🚗 ~${Math.round(top.eta_min)} min</span>
      <span class="badge">📏 ~${Math.round(top.distance_km)} km</span>
      <span class="badge">✨ ${escapeHtml(top.visibility || "bella")}</span>
    </div>
    <ul class="why">
      ${(top.why || []).slice(0,4).map(x => `<li>${escapeHtml(x)}</li>`).join("")}
    </ul>
  `;

  const altsHost = $("alts");
  altsHost.innerHTML = "";
  $("altTitle").style.display = alts.length ? "block" : "none";

  alts.slice(0,3).forEach(a => {
    const card = document.createElement("article");
    card.className = "alt";
    card.innerHTML = `
      <div class="alt-title">${escapeHtml(a.name)}</div>
      <div class="alt-meta">🚗 ~${Math.round(a.eta_min)} min • 📏 ~${Math.round(a.distance_km)} km</div>
    `;
    altsHost.appendChild(card);
  });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function useGeo() {
  if (!navigator.geolocation) return showMsg("Geolocalizzazione non supportata.");
  showMsg("");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $("originLabel").value = "La mia posizione";
      $("originLat").value = String(pos.coords.latitude);
      $("originLon").value = String(pos.coords.longitude);
    },
    () => showMsg("Impossibile ottenere la posizione. Inserisci lat/lon.")
  );
}

// init
renderQuickTimes();
renderCats();
setStyle("gems");

$("styleGems").onclick = () => setStyle("gems");
$("styleKnown").onclick = () => setStyle("known");
$("goBtn").onclick = findPlace;
$("geoBtn").onclick = useGeo;
