/* public/place_info_patch.js — adds "🧩 Cosa c’è" button for ALL categories (non-events)
 * ✅ No changes to app.js
 * ✅ Uses NAME + AREA (not coordinates)
 * ✅ Works every time result card is re-rendered
 */

(() => {
  "use strict";

  const RESULT_AREA_ID = "resultArea";

  function esc(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function stableQuery(name, area) {
    const n = String(name || "").trim();
    const a = String(area || "").trim();
    if (!n && !a) return "";
    // nome tra virgolette = più preciso
    return a ? `"${n}" ${a}` : `"${n}"`;
  }

  function googleMapsSearchUrl(q) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  }

  function googleSearchUrl(q) {
    return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  }

  function readTitleFromCard(card) {
    // Nel tuo renderChosenCard il titolo è un div grande con font-weight:1000; font-size:30px
    // Prendiamo il primo blocco "grande" dentro il body della card.
    const titleEl =
      card.querySelector('div[style*="font-weight:1000"][style*="font-size:30px"]') ||
      card.querySelector("div[style*='font-size:30px']") ||
      card.querySelector("div");

    const t = (titleEl?.textContent || "").trim();
    return t;
  }

  function readAreaLine(card) {
    // Riga: "📍 AREA • lat, lon"
    const lines = [...card.querySelectorAll(".small.muted")].map(x => (x.textContent || "").trim());
    const loc = lines.find(s => s.startsWith("📍")) || "";
    // togli "📍"
    const clean = loc.replace(/^📍\s*/,"");
    // prima del "• lat"
    const area = clean.split("•")[0]?.trim() || "";
    return area;
  }

  function ensureInfoButton(card) {
    // Se la card è quella di MaiFatto, ha già i bottoni suoi in events.js
    // (e spesso il titolo è "✨ MAI FATTO — ..."). Non tocchiamo.
    const header = (card.textContent || "").toLowerCase();
    if (header.includes("mai fatto") && card.querySelector('a.btn')) {
      return;
    }

    const grid = card.querySelector(".actionGrid");
    if (!grid) return;

    // evita duplicati
    if (grid.querySelector("[data-jamo-info='1']")) return;

    const name = readTitleFromCard(card);
    const area = readAreaLine(card);

    const q = stableQuery(name, area);
    if (!q) return;

    // crea bottone
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn";
    btn.setAttribute("data-jamo-info", "1");
    btn.textContent = "🧩 Cosa c’è";

    btn.addEventListener("click", () => {
      // Preferisco Maps search perché è più “posto-esatto”
      const url = googleMapsSearchUrl(q);
      // fallback: se vuoi anche Google web, basta cambiare qui
      window.open(url, "_blank", "noopener");
    });

    // Inseriscilo subito dopo "🧭 Vai" se c’è, altrimenti in testa
    const goBtn = grid.querySelector("#btnGo");
    if (goBtn && goBtn.nextSibling) grid.insertBefore(btn, goBtn.nextSibling);
    else grid.insertBefore(btn, grid.firstChild);
  }

  function scanAndPatch() {
    const area = document.getElementById(RESULT_AREA_ID);
    if (!area) return;

    // La tua card principale è il primo container con border-radius:18px ecc.
    // Patcheremo qualsiasi card che contenga .actionGrid
    const candidates = area.querySelectorAll(".actionGrid");
    candidates.forEach((grid) => {
      const card = grid.closest("div");
      if (card) ensureInfoButton(card);
    });
  }

  function boot() {
    scanAndPatch();

    // Observer: ogni volta che app.js riscrive resultArea, reiniettiamo il bottone
    const area = document.getElementById(RESULT_AREA_ID);
    if (!area) return;

    const obs = new MutationObserver(() => scanAndPatch());
    obs.observe(area, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
