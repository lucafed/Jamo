/* Jamo — app.js (MINIMAL UI TEST)
 * Scopo: verificare click/tap, chips, subfiltri eventi, bottoni.
 * Nessun fetch, nessun dataset.
 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // ---------- UI helpers ----------
  function showStatus(type, text) {
    const box = $("statusBox");
    const t = $("statusText");
    if (!box || !t) return;
    t.textContent = text;
    box.style.display = "block";
    box.style.borderColor =
      type === "ok"
        ? "rgba(26,255,213,.35)"
        : type === "err"
        ? "rgba(255,90,90,.40)"
        : "rgba(255,180,80,.40)";
  }

  function hideStatus() {
    const box = $("statusBox");
    const t = $("statusText");
    if (!box || !t) return;
    box.style.display = "none";
    t.textContent = "";
  }

  function setResult(html) {
    const area = $("resultArea");
    if (!area) return;
    area.innerHTML = html;
  }

  // ---------- Chips ----------
  function initChips(containerId, { multi = false } = {}) {
    const el = $(containerId);
    if (!el) return;

    el.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;

      if (!multi) {
        [...el.querySelectorAll(".chip")].forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
      } else {
        chip.classList.toggle("active");
      }

      // sync time chips -> maxMinutes
      if (containerId === "timeChips") {
        const v = Number(chip.dataset.min);
        if (Number.isFinite(v) && $("maxMinutes")) $("maxMinutes").value = String(v);
      }

      // eventi subfilters toggle
      if (containerId === "categoryChips") refreshEventsSubfiltersUI();

      // debug
      const label = chip.textContent?.trim() || "(chip)";
      showStatus("ok", `Chip premuto: ${label}`);
    });
  }

  function getActiveCategory() {
    const el = $("categoryChips");
    const active = el?.querySelector(".chip.active");
    return String(active?.dataset.cat || "").trim().toLowerCase() || "natura";
  }

  function refreshEventsSubfiltersUI() {
    const sub = $("eventsSubfilters");
    if (!sub) return;
    sub.classList.toggle("active", getActiveCategory() === "eventi");
  }

  function initTimeChipsSync() {
    $("maxMinutes")?.addEventListener("input", () => {
      const v = Number($("maxMinutes").value);
      const chipsEl = $("timeChips");
      if (!chipsEl) return;
      const chips = [...chipsEl.querySelectorAll(".chip")];
      chips.forEach((c) => c.classList.remove("active"));
      const match = chips.find((c) => Number(c.dataset.min) === v);
      if (match) match.classList.add("active");
      showStatus("ok", `Minuti impostati: ${v}`);
    });
  }

  // ---------- Origin (solo test) ----------
  function setOriginMock() {
    const label = ($("originLabel")?.value || "").trim() || "Luogo test";
    // valori finti per vedere che li scrive
    if ($("originLat")) $("originLat").value = "45.4400";
    if ($("originLon")) $("originLon").value = "11.0000";
    if ($("originCC")) $("originCC").value = "IT";
    if ($("originStatus")) $("originStatus").textContent = `✅ Partenza impostata (mock): ${label}`;
    showStatus("ok", "✅ Click OK: Usa questo luogo (mock)");
  }

  function resetOriginMock() {
    if ($("originLat")) $("originLat").value = "";
    if ($("originLon")) $("originLon").value = "";
    if ($("originCC")) $("originCC").value = "";
    if ($("originLabel")) $("originLabel").value = "";
    if ($("originStatus")) $("originStatus").textContent = "🧽 Partenza resettata (mock)";
    showStatus("ok", "✅ Click OK: Reset partenza");
  }

  // ---------- Buttons ----------
  function bindButtons() {
    // GPS: lo nascondiamo come prima
    const gps = $("btnUseGPS");
    if (gps) {
      gps.style.display = "none";
      gps.disabled = true;
      gps.setAttribute("aria-hidden", "true");
    }

    $("btnFindPlace")?.addEventListener("click", () => {
      setOriginMock();
      setResult(`
        <div class="card" style="box-shadow:none;">
          <div style="font-weight:950;">OK: bottone “Usa questo luogo”</div>
          <div class="small muted" style="margin-top:6px;">
            Se hai visto questo, il tap/click funziona.
          </div>
        </div>
      `);
    });

    $("btnResetOrigin")?.addEventListener("click", () => {
      resetOriginMock();
      setResult(`
        <div class="card" style="box-shadow:none;">
          <div style="font-weight:950;">OK: bottone “Cambia partenza (reset)”</div>
        </div>
      `);
    });

    $("btnFind")?.addEventListener("click", () => {
      const cat = getActiveCategory();
      const mins = Number($("maxMinutes")?.value || 120);
      setResult(`
        <div class="card" style="box-shadow:none;">
          <div style="font-weight:950;">OK: bottone “CERCA”</div>
          <div class="small muted" style="margin-top:6px;">
            Categoria: <b>${cat}</b> • Minuti: <b>${mins}</b>
          </div>
          <div class="small muted" style="margin-top:6px;">
            (Questa è solo una prova: niente dataset/caricamenti.)
          </div>
        </div>
      `);
      showStatus("ok", "✅ Click OK: CERCA");
    });

    $("btnResetVisited")?.addEventListener("click", () => {
      showStatus("ok", "✅ Click OK: Reset visitati (mock)");
      setResult(`
        <div class="card" style="box-shadow:none;">
          <div style="font-weight:950;">OK: bottone “Reset visitati”</div>
        </div>
      `);
    });
  }

  // ---------- Boot ----------
  function boot() {
    hideStatus();
    initChips("timeChips", { multi: false });
    initChips("categoryChips", { multi: false });
    initChips("styleChips", { multi: true });

    // se esistono, inizializziamo anche sub-chips eventi
    initChips("eventTypeChips", { multi: false });
    initChips("eventWhenChips", { multi: false });

    initTimeChipsSync();
    refreshEventsSubfiltersUI();
    bindButtons();

    setResult(`
      <div class="card" style="box-shadow:none;">
        <div style="font-weight:950;">🧪 Modalità TEST UI</div>
        <div class="small muted" style="margin-top:6px; line-height:1.4;">
          Premi i chip e i bottoni. Se vedi messaggi nello status e qui sotto, il tap funziona.
        </div>
      </div>
    `);

    showStatus("ok", "Test UI avviato ✅");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  // debug globale (opzionale)
  window.__jamo_test = { showStatus, getActiveCategory };
})();
