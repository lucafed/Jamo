const VERSION = "0.1";

const activities = [
  // FREE / CHILL
  { text:"Fai una passeggiata di 15 minuti e ascolta 3 canzoni nuove.", time:30, mood:"chill", budget:0, place:"outdoor", aff:"" },
  { text:"Riordina 10 minuti: scrivania o camera. Stop quando suona il timer.", time:20, mood:"focus", budget:0, place:"indoor", aff:"" },
  { text:"Doccia + outfit migliore che hai. Anche se non esci.", time:30, mood:"chill", budget:0, place:"indoor", aff:"" },

  // SOCIAL
  { text:"Scrivi a una persona: ‘Caffè tra 30 min?’", time:60, mood:"social", budget:10, place:"any", aff:"coffee" },
  { text:"Esci e fai una foto ‘bella’ a qualcosa di banale (e mandala a qualcuno).", time:30, mood:"social", budget:0, place:"outdoor", aff:"" },

  // ACTIVE
  { text:"Allenamento lampo: 3 giri (10 squat, 10 piegamenti, 20'' plank).", time:20, mood:"active", budget:0, place:"indoor", aff:"" },
  { text:"Vai a correre/camminare e torna con una strada diversa.", time:60, mood:"active", budget:0, place:"outdoor", aff:"" },

  // ROMANTIC
  { text:"Crea una playlist ‘stasera’ da 10 tracce e condividila.", time:30, mood:"romantic", budget:0, place:"indoor", aff:"" },

  // WILD / CAOTICO (ma safe)
  { text:"Sfida: scegli un bar a caso entro 10 minuti da te e vacci.", time:120, mood:"wild", budget:10, place:"outdoor", aff:"maps" },
  { text:"Compra un ‘ingrediente misterioso’ e improvvisa una ricetta.", time:120, mood:"wild", budget:30, place:"indoor", aff:"delivery" },

  // “Giornata”
  { text:"Gita breve: trova un posto nuovo entro 1 ora di distanza e vai.", time:480, mood:"active", budget:30, place:"outdoor", aff:"travel" },
];

const $ = (id) => document.getElementById(id);

const btn = $("btn");
const slot = $("slot");
const meta = $("meta");
$("ver").textContent = VERSION;

function readFilters(){
  return {
    time: $("f_time").value,
    mood: $("f_mood").value,
    budget: $("f_budget").value,
    place: $("f_place").value,
  };
}

function matches(a, f){
  // time
  if (f.time !== "any"){
    const t = Number(f.time);
    if (a.time > t) return false;
  }
  // mood
  if (f.mood !== "any" && a.mood !== f.mood) return false;
  // budget
  if (f.budget !== "any"){
    const b = Number(f.budget);
    if (a.budget > b) return false;
  }
  // place
  if (f.place !== "any" && a.place !== "any" && a.place !== f.place) return false;

  return true;
}

function pickOne(list){
  return list[Math.floor(Math.random() * list.length)];
}

async function spinAndPick(){
  const f = readFilters();
  const pool = activities.filter(a => matches(a, f));

  if (pool.length === 0){
    slot.textContent = "Nessuna idea con questi filtri 😅 Prova ad allentarli.";
    meta.textContent = "";
    return;
  }

  btn.disabled = true;

  // slot animation: 18 “tick” con velocità che rallenta
  let ticks = 18;
  let current = pickOne(pool);
  for (let i = 0; i < ticks; i++){
    current = pickOne(pool);
    slot.textContent = current.text;
    meta.textContent = "Jamo sta scegliendo…";
    const delay = 40 + i*i*6; // rallenta
    await new Promise(r => setTimeout(r, delay));
  }

  // final
  slot.textContent = current.text;

  // meta + affiliazione placeholder (noi dopo la colleghiamo davvero)
  const tags = [
    `⏱️ ${current.time} min`,
    `🧠 ${current.mood}`,
    `💶 €${current.budget}`,
    current.place === "indoor" ? "🏠 indoor" : current.place === "outdoor" ? "🌤️ outdoor" : "📍 ovunque"
  ].join("  •  ");

  let aff = "";
  if (current.aff){
    // Placeholder: noi qui sostituiamo con veri link affiliati (es. booking, amazon, maps, ecc.)
    aff = `  •  🔗 Suggerimento: ${current.aff}`;
  }

  meta.textContent = tags + aff;

  btn.disabled = false;
}

btn.addEventListener("click", spinAndPick);

// PWA install
let deferredPrompt = null;
const installBtn = $("installBtn");

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.hidden = false;
});

installBtn.addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBtn.hidden = true;
});

// Service worker
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(()=>{});
  });
}
