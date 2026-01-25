/* public/place_info_patch.js
 * Aggiunge un bottone "🧩 Cosa c’è" (Google Maps search) alle schede standard di app.js
 * - Non tocca app.js
 * - Usa NOME + AREA (non coordinate) per evitare risultati sbagliati
 * - Non interferisce con MaiFatto (events.js già ha "Cosa c’è")
 */

(() => {
  "use strict";

  const BTN_ID = "btnWhatThereIs";
  const RESULT_AREA_ID = "resultArea";

  const esc = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  function mapsSearchUrlByName(name, area) {
    const n = String(name || "").trim();
    const a = String(area || "").trim();
    const q = a ? `"${n}" ${a}` : `"${n}"`;
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  }

  function extractNameAreaFromCard(root) {
    // app.js renderChosenCard mette:
    // - il nome in un div grande (font-size:30px; font-weight:1000)
    // - l'area nella riga: "📍 AREA • lat, lon"
    let name = "";
    let area = "";

    // 1) nome: prendo il testo più "forte" dentro la card
    // (cerco un div con font-weight:1000 oppure font-size:30)
    const nameEl =
      root.querySelector('div[style*="font-weight:1000"]') ||
      root.querySelector('div[style*="font-size:30px"]');

    if (nameEl) name = (nameEl.textContent || "").trim();

    // 2) area: cerco la riga con "📍"
    const lines = [...root.querySelectorAll(".small.muted")];
    const locLine = lines.find((el) => (el.textContent || "").includes("📍"));
    if (locLine) {
      const txt = (locLine.textContent || "").trim();
      // formato: "📍 AREA • 45.00000, 11.00000"
      // prendo tra "📍" e "•"
      const afterPin = txt.split("📍")[1] ? txt.split("📍")[1].trim() : "";
      area = afterPin.includes("•") ? afterPin.split("•")[0].trim() : afterPin.trim();
    }

    // pulizie
    name = name.replace(/\s+/g, " ").trim();
    area = area.replace(/\s+/g, " ").trim();

    if (!name) return null;
    return { name, area };
  }

  function isMaiFattoCard(root) {
    // Se è MaiFatto, events.js renderizza card con titolo "✨ MAI FATTO"
    // ma la scheda standard di app.js non ha quel testo.
    const t = (root.textContent || "").toLowerCase();
    return t.includes("mai fatto") && t.includes("wow");
  }

  function ensureButton() {
    const area = document.getElementById(RESULT_AREA_ID);
    if (!area) return;

    // cerco la "card grande" (quella con actionGrid)
    const grid = area.querySelector(".actionGrid");
    if (!grid) return;

    // se già inserito, stop
    if (grid.querySelector(`#${BTN_ID}`)) return;

    // non mettiamolo sulle card di MaiFatto (che hanno già "Cosa c’è")
    if (isMaiFattoCard(area)) return;

    // estrai nome + area
    const data = extractNameAreaFromCard(area);
    if (!data) return;

    const url = mapsSearchUrlByName(data.name, data.area);

    // creo un bottone stile app.js: "btnGhost"
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = BTN_ID;
    btn.className = "btnGhost";
    btn.innerHTML = `🧩 ${esc("Cosa c’è")}`;

    btn.addEventListener("click", () => {
      window.open(url, "_blank", "noopener");
    });

    // Inserimento: in actionGrid, subito dopo "🧭 Vai" se esiste
    const goBtn = grid.querySelector("#btnGo");
    if (goBtn && goBtn.parentElement === grid) {
      // inserisci dopo goBtn
      if (goBtn.nextSibling) grid.insertBefore(btn, goBtn.nextSibling);
      else grid.appendChild(btn);
    } else {
      grid.appendChild(btn);
    }
  }

  function startObserver() {
    const area = document.getElementById(RESULT_AREA_ID);
    if (!area) return false;

    // prova subito
    ensureButton();

    // osserva cambi (quando l’utente fa CERCA / Cambia meta / Altre destinazioni)
    const obs = new MutationObserver(() => ensureButton());
    obs.observe(area, { childList: true, subtree: true });
    return true;
  }

  // boot robusto
  const boot = () => {
    if (startObserver()) return;
    // se resultArea non c'è ancora
    const t = setInterval(() => {
      if (startObserver()) clearInterval(t);
    }, 120);
    setTimeout(() => clearInterval(t), 8000);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
